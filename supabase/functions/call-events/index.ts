// call-events — Vapi server webhook.
//
// Receives status updates and end-of-call reports, and turns them into the
// product: call outcomes, the family-facing summary, no-answer retries and
// escalation, and — most importantly — immediate honoring of an in-call
// revocation ("stop calling me" ends the service before the next call is
// ever scheduled).
//
// It also keeps the clock during a live call. The model has no sense of
// elapsed time, so speech events are used as ticks and the wind-down
// instructions are injected back into the call — see handleWrapUp, which
// times them against the budget that call was placed with.
//
// Family notifications are TEXT MESSAGES, deliberately: the senior needs no
// app, and neither does the family — summaries arrive by SMS from Etta's own
// number. Requires TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN secrets; without
// them, summaries are stored with delivered_at null and can be sent later.
//
// Auth: Vapi sends the assistant's server secret in the X-Vapi-Secret
// header; must match VAPI_WEBHOOK_SECRET.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { ADDONS, resolveAddonPrice } from "../_shared/catalog.ts";
import { addSubscriptionItem, removeSubscriptionItem, stripe } from "../_shared/stripe.ts";
import { sendText } from "../_shared/sms.ts";

const MAX_ATTEMPTS = 3;        // 1 scheduled call + 2 retries
// A pill reminder that goes unanswered gets one more try and then lets it be:
// the day's check-in call is the escalation path, not this.
const MED_MAX_ATTEMPTS = 2;
const RETRY_DELAY_MINUTES = 30;

// The call's time budget, spoken to Etta while she is still on the line.
//
// Vapi hangs up hard at maxDurationSeconds, which is what keeps a check-in
// priced like a check-in. These two messages exist so that ceiling is never
// what actually ends a call: Etta has no sense of elapsed time, so the server
// keeps the clock for her and hands her the instruction to close while there
// is still room to do it warmly.
//
// The moments are per call rather than fixed, because the ceiling is. A
// Companion call is sold on being longer and a pill reminder on being short,
// so a single 5-minute nudge would either cut the first one off or arrive
// after the second one has already ended. place-due-calls records the budget
// it placed the call with (see callBudget); this reads it back.
const DEFAULT_BUDGET_SECONDS = 420; // calls placed before budgets were recorded

const NOT_FROM_THEM =
  "[System note. This is not from the person you are speaking with — do " +
  "not read it aloud, do not mention it, and never talk about time limits.] ";

/** What "you have been talking a while" means for this kind of call. */
function elapsedPhrase(kind: string, minutes: number): string {
  if (kind === "medication") {
    return "This is a short reminder call, and it has run its length.";
  }
  if (kind === "occasion") {
    return "You have passed the message along and had a warm moment with " +
      "them, which is the whole errand of this call.";
  }
  return `You have been talking for about ${minutes} minutes, which is a full check-in.`;
}

function windDownMessage(kind: string, minutes: number): string {
  return NOT_FROM_THEM + elapsedPhrase(kind, minutes) +
    " Start closing now: finish the thread you are on, ask anything you still " +
    "genuinely need to ask, then give your warm closing — recall something " +
    "from the call, say when you'll call next — and end the call with your " +
    "end-call tool. Open no new topics. If they are in the middle of a story, " +
    "let them finish it; never cut them off.";
}

const GOODBYE_MESSAGE = NOT_FROM_THEM +
  "This call has to end within the next minute. Say your goodbye on your " +
  "very next turn: one warm closing line, no new questions, then use your " +
  "end-call tool. If they are mid-sentence, let them finish it, then close. " +
  "Closing now matters — if you don't, the line will simply drop, and being " +
  "cut off mid-sentence is the worst way to leave them.";

// The family page is served from our own domain, not the Supabase function
// URL: Supabase rewrites text/html to text/plain on *.supabase.co, so the
// raw endpoint shows a browser a wall of source. /f/<token> proxies it.
const FAM_LINK_BASE = Deno.env.get("FAM_LINK_BASE") ?? "https://www.ettacalls.com/f";

// Inbound routing: pending seniors (and unknown callers) get the setup
// assistant; active seniors get the daily-companion assistant with context.
const SETUP_ASSISTANT_ID =
  Deno.env.get("VAPI_SETUP_ASSISTANT_ID") ?? "0089b42e-799e-42c5-878a-2478387ae1de";
const MAIN_ASSISTANT_ID =
  Deno.env.get("VAPI_ASSISTANT_ID") ?? "d7f28f40-69a4-4c85-ad22-512f39a14dc8";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const MOOD_WORDS: Record<number, string> = {
  1: "a hard day", 2: "a little low", 3: "steady", 4: "good spirits", 5: "bright",
};

interface Flag {
  type?: string;
  severity?: string;
  detail?: string;
  description?: string; // analysis models sometimes use this despite the schema
}

function flagText(f: Flag): string {
  return f.detail ?? f.description ?? f.type ?? "unspecified concern";
}

// The analysis model doesn't always honor the schema's types: it will answer
// ate_today with "Yes, a burrito and yogurt" or mood_score with "1". Those are
// real answers, so coerce rather than discard — dropping them empties the whole
// chip row and blanks the mood colour for a call that went fine.
// deno-lint-ignore no-explicit-any
function toBool(v: any): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  if (!t) return null;
  if (/^(y|yes|true|taken|did)\b/.test(t)) return true;
  if (/^(n|no|false|not|none|never|didn'?t|hasn'?t|doesn'?t)\b/.test(t)) return false;
  return null;
}

// deno-lint-ignore no-explicit-any
function toMood(v: any): number | null {
  const n = typeof v === "number" ? v : parseInt(String(v ?? "").trim(), 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(5, Math.max(1, Math.round(n)));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// deno-lint-ignore no-explicit-any
async function findCall(message: any) {
  const metaCallId = message?.call?.metadata?.call_id;
  if (metaCallId) {
    const { data } = await supabase.from("calls")
      .select("*").eq("id", metaCallId).maybeSingle();
    if (data) return data;
  }
  const providerId = message?.call?.id;
  if (providerId) {
    const { data } = await supabase.from("calls")
      .select("*").eq("provider_call_id", providerId).maybeSingle();
    if (data) return data;
  }
  return null;
}

// Speaks to Etta while she is still on the call, through Vapi's per-call
// live-control endpoint (stored at placement — Vapi returns it once and never
// again). Called every time she stops speaking, which is both the safe seam to
// hand her a new instruction and a natural clock tick.
//
// The conditional UPDATE is what makes it safe to call this ~20 times a call:
// only the tick that actually crosses a threshold finds a row to update, so
// each nudge goes out exactly once no matter how many events arrive.
// deno-lint-ignore no-explicit-any
async function handleWrapUp(message: any) {
  const providerId = message?.call?.id;
  if (!providerId) return;

  const { data: call } = await supabase.from("calls")
    .select("id, kind, started_at, wrapup_stage, control_url, time_budget_seconds")
    .eq("provider_call_id", providerId)
    .eq("status", "in_progress")
    .maybeSingle();
  // No started_at means the line hasn't connected yet: no clock to keep.
  if (!call?.started_at) return;

  const elapsed = (Date.now() - new Date(call.started_at as string).getTime()) / 1000;
  const budget = (call.time_budget_seconds as number | null) ?? DEFAULT_BUDGET_SECONDS;
  const kind = (call.kind as string) ?? "checkin";
  const reserve = Math.min(120, Math.max(30, Math.round(budget * 0.3)));
  const windDownAt = budget - reserve;

  // Latest stage first — a call that somehow skipped a tick gets the message
  // that matches where it actually is, not the one it missed.
  const stages = [
    { stage: 2, at: budget - Math.round(reserve / 2), content: GOODBYE_MESSAGE },
    {
      stage: 1,
      at: windDownAt,
      content: windDownMessage(kind, Math.round(windDownAt / 60)),
    },
  ];

  for (const { stage, at, content } of stages) {
    if (elapsed < at || (call.wrapup_stage as number) >= stage) continue;

    const { data } = await supabase.from("calls")
      .update({ wrapup_stage: stage })
      .eq("id", call.id)
      .lt("wrapup_stage", stage)
      .select("control_url")
      .maybeSingle();
    if (!data) continue; // another tick got there first

    const controlUrl = data.control_url ?? message?.call?.monitor?.controlUrl;
    if (!controlUrl) {
      console.error("wrap-up: no control url for call", providerId);
      return;
    }

    const res = await fetch(controlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "add-message",
        message: { role: "system", content },
        // Deliberately not triggering a reply. This lands just after Etta
        // finished speaking, so the senior is likely about to — forcing a turn
        // here would talk over them. The instruction sits in her context and
        // shapes the answer she gives seconds later.
        triggerResponseEnabled: false,
      }),
    });
    if (!res.ok) {
      console.error("wrap-up nudge failed:", stage, res.status, await res.text());
    }
    return;
  }
}

async function familyPhones(
  seniorId: string,
  opts: { escalationOnly?: boolean } = {},
): Promise<string[]> {
  const { data: senior } = await supabase.from("seniors")
    .select("family_id, family:families!inner(primary_contact_phone)")
    .eq("id", seniorId).maybeSingle();
  if (!senior) return [];

  let q = supabase.from("family_members")
    .select("phone, receives_summaries, escalation_order")
    .eq("family_id", senior.family_id)
    .not("phone", "is", null);
  q = opts.escalationOnly
    ? q.not("escalation_order", "is", null)
    : q.eq("receives_summaries", true);
  const { data: members } = await q;

  const phones = (members ?? []).map((m) => m.phone as string);
  const primary = (senior.family as unknown as { primary_contact_phone: string | null })
    .primary_contact_phone;
  if (primary && !phones.includes(primary)) phones.unshift(primary);
  return phones;
}

// Cancel a family's subscription immediately. Called when the senior declines
// consent or revokes it: the product's promise is that you never keep paying
// for calls your parent doesn't want. Idempotent — Stripe 404s are fine.
async function cancelSubscription(familyId: string, reason: string) {
  const key = (Deno.env.get("STRIPE_SECRET_KEY") ?? "").trim();
  if (!key) return;
  const { data: family } = await supabase.from("families")
    .select("stripe_subscription_id, subscription_status")
    .eq("id", familyId).maybeSingle();
  const subId = family?.stripe_subscription_id;
  if (!subId || ["canceled", "incomplete_expired"].includes(family?.subscription_status ?? "")) {
    return;
  }
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    console.error("subscription cancel failed:", subId, res.status, await res.text());
    return;
  }
  await supabase.from("families")
    .update({ subscription_status: "canceled" }).eq("id", familyId);
  await supabase.from("billing_events").insert({
    family_id: familyId,
    type: "etta.subscription_canceled",
    detail: { reason, subscription: subId },
  });
}

/**
 * A second parent said yes — so now, and not a moment before, they become a
 * line on the family's bill.
 *
 * The add-on was created 'pending_consent' when the family added them (see
 * the addons function). This is the other half of the promise the first
 * parent already got: no charge for calls nobody has agreed to receive.
 *
 * A billing failure here must never stop the calls. The senior consented;
 * that stands. The add-on simply stays pending and unbilled, which errs
 * against us rather than against them.
 */
async function activateParentAddon(seniorId: string, familyId: string) {
  const { data: addon } = await supabase.from("subscription_addons")
    .select("id").eq("senior_id", seniorId)
    .eq("addon_key", "second_parent").eq("status", "pending_consent").maybeSingle();
  if (!addon) return;

  const { data: family } = await supabase.from("families")
    .select("stripe_subscription_id, subscription_status").eq("id", familyId).maybeSingle();

  const patch: Record<string, unknown> = {
    status: "active",
    activated_at: new Date().toISOString(),
  };

  if (family?.subscription_status !== "comped" && family?.stripe_subscription_id) {
    try {
      const def = ADDONS.second_parent;
      const price = await resolveAddonPrice(def);
      const item = await addSubscriptionItem(family.stripe_subscription_id, price, 1);
      patch.stripe_item_id = item.id;
      patch.stripe_price_id = price;
      patch.unit_amount_cents = def.monthlyCents;
    } catch (err) {
      console.error("second parent billing failed (calls continue):", seniorId, err);
      return;
    }
  }

  await supabase.from("subscription_addons").update(patch).eq("id", addon.id);
  await supabase.from("billing_events").insert({
    family_id: familyId,
    type: "etta.addon_activated",
    detail: { addon: "second_parent", senior_id: seniorId },
  });
}

/**
 * Stop billing for ONE senior when they decline or revoke.
 *
 * With more than one parent on an account, "they said stop" must not cancel
 * the whole subscription — the other parent's calls have nothing to do with
 * it. So: a senior who arrived as an add-on takes only their own add-on with
 * them; the senior the account was opened for takes the subscription.
 *
 * Returns which of the two happened, because the family's text has to say
 * the true thing about their bill.
 */
async function stopBillingForSenior(
  seniorId: string,
  familyId: string,
  reason: string,
): Promise<"addon" | "subscription"> {
  const { data: addon } = await supabase.from("subscription_addons")
    .select("id, stripe_item_id").eq("senior_id", seniorId)
    .eq("addon_key", "second_parent").neq("status", "canceled").maybeSingle();

  if (!addon) {
    await cancelSubscription(familyId, reason);
    return "subscription";
  }

  if (addon.stripe_item_id) await removeSubscriptionItem(addon.stripe_item_id as string);
  await supabase.from("subscription_addons")
    .update({ status: "canceled", canceled_at: new Date().toISOString() })
    .eq("id", addon.id);
  await supabase.from("billing_events").insert({
    family_id: familyId,
    type: "etta.addon_removed",
    detail: { addon: "second_parent", senior_id: seniorId, reason },
  });
  return "addon";
}

// "09:00:00" → "9 in the morning", "12:30:00" → "12:30 in the afternoon"
function timeSpeech(t: string): string {
  const [hs, ms] = t.split(":");
  const h24 = parseInt(hs, 10);
  const m = parseInt(ms, 10);
  const part = h24 < 12 ? "in the morning" : h24 < 17 ? "in the afternoon" : "in the evening";
  const h = h24 % 12 || 12;
  return m === 0 ? `${h} ${part}` : `${h}:${String(m).padStart(2, "0")} ${part}`;
}

function localDate(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

// Did the person on the other end actually say anything? A transcript is not
// evidence of a conversation: a call answered into silence still transcribes
// Etta's own greeting, and "the transcript is non-empty" quietly counted that
// as a check-in. Only the customer's turns count.
function hasHumanTurn(transcript: string | null): boolean {
  if (!transcript) return false;
  return transcript.split("\n").some((line) => {
    const m = line.match(/^\s*(user|customer)\s*:\s*(.*)$/i);
    return !!m && m[2].trim().length > 0;
  });
}

// A call only counts as a check-in if a conversation demonstrably happened.
// Providers report failures in inventive ways — a call that never connected
// came back as "call.in-progress.twilio-completed-call" with no duration and
// no transcript; one answered into silence came back as "silence-timed-out"
// with 43 seconds and Etta's greeting. The dangerous direction of error is to
// treat either as a successful check-in, because then the family is told
// their parent is fine when nobody spoke to them, and no retry is attempted.
// So require evidence, rather than enumerating every way it can go wrong.
function classifyStatus(
  endedReason: string,
  durationSeconds: number,
  spoke: boolean,
  reachedSenior: boolean | null,
): string {
  const r = endedReason.toLowerCase();
  if (
    r.includes("did-not-answer") || r.includes("no-answer") ||
    r.includes("busy") || r.includes("voicemail")
  ) return "no_answer";
  if (r.includes("error") || r.includes("failed")) return "failed";
  // The analysis model's own verdict on whether it was really them. It sees
  // the whole conversation, so when it says no, believe it.
  if (reachedSenior === false) return "no_answer";
  if (!spoke) return "no_answer";
  // Answered but hung up almost immediately — treat as unreached.
  if (durationSeconds > 0 && durationSeconds < 10) return "no_answer";
  return "completed";
}

// deno-lint-ignore no-explicit-any
async function handleRevocation(call: any, structured: any) {
  await supabase.from("consent_events").insert({
    senior_id: call.senior_id,
    event: "revoked",
    method: "in_call",
    notes: structured?.revocation_detail ??
      "Senior asked Etta to stop calling during a check-in call.",
  });
  await supabase.from("seniors")
    .update({ status: "revoked" }).eq("id", call.senior_id);
  await supabase.from("call_schedules")
    .update({ active: false }).eq("senior_id", call.senior_id);
  await supabase.from("calls")
    .update({ status: "canceled", ended_reason: "consent_revoked" })
    .eq("senior_id", call.senior_id).eq("status", "scheduled");

  const { data: esc } = await supabase.from("escalations").insert({
    senior_id: call.senior_id,
    call_id: call.id,
    reason: "revocation",
    detail: "Senior revoked consent during today's call. All future calls are stopped.",
  }).select("id").single();

  const { data: senior } = await supabase.from("seniors")
    .select("first_name, preferred_name, family_id")
    .eq("id", call.senior_id).maybeSingle();
  const name = senior?.preferred_name || senior?.first_name || "your parent";
  const stopped = senior?.family_id
    ? await stopBillingForSenior(call.senior_id, senior.family_id, "senior_revoked_consent")
    : "subscription";
  const sent = await sendText(
    await familyPhones(call.senior_id),
    `Etta update: on today's call, ${name} asked Etta to stop calling — and Etta ` +
      `honored that right away, as promised. No more calls will be placed to ${name}, ` +
      (stopped === "subscription"
        ? `and your subscription is canceled so you won't be billed again. `
        : `and their part of the bill ends today — the rest of your account carries on. `) +
      `It might be a passing mood or a real preference; a gentle conversation is ` +
      `usually the best next step. If ${name} wants the calls again, it just takes ` +
      `a fresh yes from them. — Etta`,
  );
  if (sent && esc) {
    await supabase.from("escalations")
      .update({ status: "notified", notified_at: new Date().toISOString() })
      .eq("id", esc.id);
  }
}

// deno-lint-ignore no-explicit-any
async function handleNoAnswer(call: any) {
  const kind = call.kind ?? "checkin";
  const maxAttempts = kind === "medication" ? MED_MAX_ATTEMPTS : MAX_ATTEMPTS;

  if (call.attempt_number < maxAttempts) {
    const retryAt = new Date(Date.now() + RETRY_DELAY_MINUTES * 60_000);
    const { error } = await supabase.from("calls").insert({
      senior_id: call.senior_id,
      schedule_id: call.schedule_id,
      scheduled_for: retryAt.toISOString(),
      scheduled_local_date: call.scheduled_local_date,
      attempt_number: call.attempt_number + 1,
      // A retry is the same call, so it keeps its kind and its errand.
      kind,
      occasion_id: call.occasion_id ?? null,
    });
    if (error && !error.message.includes("duplicate")) {
      console.error("retry insert failed:", error.message);
    }
    return;
  }

  // A missed pill reminder isn't news on its own — the check-in call is what
  // tells the family whether anything is actually wrong.
  if (kind === "medication") return;

  // A message the family paid to have delivered, undelivered: tell them
  // plainly, and don't dress it up as an alarm about their parent.
  if (kind === "occasion" && call.occasion_id) {
    const { data: occ } = await supabase.from("occasion_calls")
      .select("stripe_payment_intent").eq("id", call.occasion_id).maybeSingle();
    // Undelivered means unpaid for: refund it without being asked.
    let refunded = false;
    if (occ?.stripe_payment_intent) {
      try {
        await stripe("refunds", { payment_intent: occ.stripe_payment_intent });
        refunded = true;
      } catch (err) {
        console.error("occasion refund failed:", err);
      }
    }
    await supabase.from("occasion_calls")
      .update({ status: "no_answer" }).eq("id", call.occasion_id);
    const { data: s } = await supabase.from("seniors")
      .select("first_name, preferred_name").eq("id", call.senior_id).maybeSingle();
    const who = s?.preferred_name || s?.first_name || "your parent";
    await sendText(
      await familyPhones(call.senior_id),
      `Etta here — I tried ${who} a few times today and couldn't get through, so ` +
        `your message wasn't delivered.${
          refunded ? " I've refunded it." : ""
        } Reply to this number if you'd like me to try again another day. — Etta`,
    );
    return;
  }

  // Retries exhausted: open an escalation and text the contact chain.
  const { data: esc } = await supabase.from("escalations").insert({
    senior_id: call.senior_id,
    call_id: call.id,
    reason: "no_answer",
    detail: `No answer after ${MAX_ATTEMPTS} attempts.`,
  }).select("id").single();

  const { data: senior } = await supabase.from("seniors")
    .select("first_name, preferred_name, share_token")
    .eq("id", call.senior_id).maybeSingle();
  const name = senior?.preferred_name || senior?.first_name || "your parent";
  const link = senior?.share_token
    ? `\nHistory: ${FAM_LINK_BASE}/${senior.share_token}`
    : "";
  const sent = await sendText(
    await familyPhones(call.senior_id, { escalationOnly: true }),
    `🔴 Etta couldn't reach ${name} today — no answer after ${MAX_ATTEMPTS} tries ` +
      `over ${MAX_ATTEMPTS - 1} hours. That's often nothing (errands, a nap, the ` +
      `phone in another room), but you know ${name} best — a quick call from you ` +
      `is the right next step.${link}\n— Etta`,
  );
  if (sent && esc) {
    await supabase.from("escalations")
      .update({ status: "notified", notified_at: new Date().toISOString() })
      .eq("id", esc.id);
  }
}

// deno-lint-ignore no-explicit-any
async function handleCompleted(call: any, message: any) {
  const analysis = message?.analysis ?? {};
  const structured = analysis.structuredData ?? {};
  const durationSeconds = Math.round(
    message?.durationSeconds ??
      (message?.endedAt && message?.startedAt
        ? (new Date(message.endedAt).getTime() - new Date(message.startedAt).getTime()) / 1000
        : 0),
  );

  const { data: senior } = await supabase.from("seniors")
    .select("first_name, preferred_name, share_token")
    .eq("id", call.senior_id).maybeSingle();
  const name = senior?.preferred_name || senior?.first_name || "your parent";

  const minutes = Math.max(1, Math.round(durationSeconds / 60));
  const summaryText: string = analysis.summary ||
    `Etta and ${name} talked for about ${minutes} minute${minutes === 1 ? "" : "s"}. ` +
      `A written summary wasn't produced for this call; the transcript is saved.`;

  const flags: Flag[] = Array.isArray(structured.flags) ? structured.flags : [];
  const moodScore = toMood(structured.mood_score);
  const ateToday = toBool(structured.ate_today);
  const sleptWell = toBool(structured.slept_well);
  const medsTaken = toBool(structured.meds_taken);

  const { data: summaryRow, error: sumErr } = await supabase
    .from("call_summaries")
    .upsert({
      call_id: call.id,
      senior_id: call.senior_id,
      summary: summaryText,
      mood_score: moodScore,
      ate_today: ateToday,
      slept_well: sleptWell,
      meds_taken: medsTaken,
      flags,
      revocation_requested: structured.revocation_requested === true,
      tomorrow_topic: structured.tomorrow_topic || null,
      raw_analysis: structured,
    }, { onConflict: "call_id" })
    .select("id")
    .single();
  if (sumErr) console.error("summary upsert failed:", sumErr.message);

  // What the senior said about letting family hear the audio. The standing
  // answer drives future calls; this call gets a snapshot of what applied to
  // it. A decline also retires audio already shared — if someone decides they
  // don't want to be listened to, that covers the ones already recorded.
  const share = String(structured.recording_share ?? "not_discussed");
  const standing = (await supabase.from("seniors")
    .select("share_recordings").eq("id", call.senior_id).maybeSingle()).data?.share_recordings
    ?? "unknown";
  let sharedNow = standing === "yes";
  if (share === "granted" || share === "declined") {
    const answer = share === "granted" ? "yes" : "no";
    if (answer !== standing) {
      await supabase.from("seniors")
        .update({ share_recordings: answer }).eq("id", call.senior_id);
      await supabase.from("consent_events").insert({
        senior_id: call.senior_id,
        event: answer === "yes" ? "granted" : "revoked",
        method: "in_call_recording_share",
        notes: answer === "yes"
          ? "Senior agreed on a check-in call that family may listen to the call audio."
          : "Senior asked that family not listen to the call audio.",
      });
    }
    sharedNow = answer === "yes";
    if (answer === "no") {
      await supabase.from("calls")
        .update({ recording_shared: false }).eq("senior_id", call.senior_id);
    }
  }
  await supabase.from("calls")
    .update({ recording_shared: sharedNow }).eq("id", call.id);

  if (structured.revocation_requested === true) {
    await handleRevocation(call, structured);
    return; // revocation text replaces the summary text today
  }

  const urgent = flags.filter((f) =>
    ["high", "urgent"].includes((f.severity ?? "").toLowerCase())
  );
  if (urgent.length > 0) {
    await supabase.from("escalations").insert({
      senior_id: call.senior_id,
      call_id: call.id,
      reason: "health_flag",
      detail: urgent.map((f) => `${f.type ?? "concern"}: ${flagText(f)}`).join("; "),
    });
  }

  // Short calls get short notes. A minute-long pill reminder or a birthday
  // message doesn't warrant the full check-in card — sending one would train
  // the family to stop reading the ones that matter. Anything urgent still
  // travels, whichever kind of call surfaced it.
  const kind = call.kind ?? "checkin";
  const alarm = urgent.length
    ? `\n\n⚠️ Needs your attention:\n${urgent.map((f) => `• ${flagText(f)}`).join("\n")}`
    : "";

  if (kind === "medication" || kind === "occasion") {
    if (kind === "occasion" && call.occasion_id) {
      await supabase.from("occasion_calls")
        .update({ status: "completed" }).eq("id", call.occasion_id);
    }
    const note = kind === "medication"
      ? `💊 Etta's reminder call with ${name} — ${
        medsTaken === true
          ? "they said they'd taken them."
          : medsTaken === false
          ? "they hadn't taken them yet."
          : "they didn't say either way."
      }${alarm}\n— Etta`
      : `💌 Etta passed your message to ${name} today.\n\n${summaryText}${alarm}\n— Etta`;
    // A2P 10DLC: a reminder call's note is the most recurring message this
    // product sends, so it carries the standing opt-out like the rest.
    const withOptOut = `${note}\nReply STOP to end texts.`;

    const shortSent = await sendText(await familyPhones(call.senior_id), withOptOut);
    if (shortSent && summaryRow) {
      await supabase.from("call_summaries")
        .update({ delivered_at: new Date().toISOString() })
        .eq("id", summaryRow.id);
    }
    return;
  }

  // The family note as a single text. The first character is the UI: a
  // colored signal readable from the lock screen without opening anything.
  // 🔴 is reserved for "needs attention" so it stays meaningful.
  const signal = urgent.length > 0
    ? "🔴"
    : moodScore === null
    ? "⚪"
    : moodScore >= 4
    ? "🟢"
    : moodScore === 3
    ? "🟡"
    : "🟠";

  const chips: string[] = [];
  if (sleptWell !== null) chips.push(`😴 slept ${sleptWell ? "well" : "poorly"}`);
  if (ateToday !== null) chips.push(`🍽️ ${ateToday ? "ate" : "not eaten yet"}`);
  if (medsTaken !== null) chips.push(`💊 ${medsTaken ? "taken" : "not taken"}`);
  if (moodScore) chips.push(`Mood ${moodScore}/5`);

  const link = senior?.share_token
    ? `${FAM_LINK_BASE}/${senior.share_token}`
    : "";

  let body = `${signal} Etta's check-in with ${name}`;
  if (moodScore) body += ` — ${MOOD_WORDS[moodScore]}`;
  body += ` (${minutes} min)`;
  if (chips.length) body += `\n${chips.join(" · ")}`;
  body += `\n\n${summaryText}`;
  if (urgent.length) {
    body += `\n\n⚠️ Needs your attention:\n` +
      urgent.map((f) => `• ${flagText(f)}`).join("\n");
  }
  const watch = flags.filter((f) => !urgent.includes(f));
  if (watch.length) {
    body += `\n\nKeeping an eye on:\n` +
      watch.map((f) => `• ${flagText(f)}`).join("\n");
  }
  if (link) body += `\n\nFull picture: ${link}`;
  body += `\n— Etta`;
  // A2P 10DLC: recurring messages carry a standing opt-out reminder.
  body += `\nReply STOP to end texts.`;

  const sent = await sendText(await familyPhones(call.senior_id), body);
  if (sent && summaryRow) {
    await supabase.from("call_summaries")
      .update({ delivered_at: new Date().toISOString() })
      .eq("id", summaryRow.id);
  }
}

// Someone dialed Etta's number: decide which Etta answers, with what context.
// deno-lint-ignore no-explicit-any
async function handleAssistantRequest(message: any): Promise<Response> {
  const caller = message?.call?.customer?.number ?? "";
  const { data: senior } = await supabase.from("seniors")
    .select(
      "id, first_name, preferred_name, status, notes, share_recordings, " +
        "family:families!inner(primary_contact_name), " +
        "schedules:call_schedules(call_time, active)",
    )
    .eq("phone", caller)
    .in("status", ["pending_consent", "active"])
    .limit(1)
    .maybeSingle();

  if (!senior) {
    return json({
      assistantId: SETUP_ASSISTANT_ID,
      assistantOverrides: {
        variableValues: {
          caller_known: "no", parent_name: "", family_contact: "", call_time_speech: "",
        },
      },
    });
  }

  const name = senior.preferred_name || senior.first_name;
  const familyContact =
    (senior.family as unknown as { primary_contact_name: string }).primary_contact_name;
  const sched = (senior.schedules as { call_time: string; active: boolean }[] ?? [])
    .find((s) => s.active);
  const speech = sched ? timeSpeech(sched.call_time) : "the time your family chose";

  if (senior.status === "active") {
    return json({
      assistantId: MAIN_ASSISTANT_ID,
      assistantOverrides: {
        // No transcriber override — see the note in place-due-calls. Per-call
        // Deepgram keyterm boosting killed the call before the assistant
        // started, and inbound would fail the same way.
        variableValues: {
          preferred_name: name,
          family_contact: familyContact,
          senior_notes: senior.notes ?? "",
          last_call_summary: "",
          ask_about: "",
          attempt_number: "1",
          ask_recording: senior.share_recordings === "unknown" ? "yes" : "no",
          // A senior ringing Etta back is having an ordinary check-in, not a
          // reminder or a delivery.
          call_kind: "checkin",
          call_length_guidance: "as long as they'd like",
          med_label: "",
          occasion_kind: "",
          occasion_from: "",
          occasion_message: "",
        },
      },
    });
  }

  return json({
    assistantId: SETUP_ASSISTANT_ID,
    assistantOverrides: {
      variableValues: {
        caller_known: "yes",
        parent_name: name,
        family_contact: familyContact,
        call_time_speech: speech,
      },
    },
  });
}

// End of an inbound call (no pre-existing calls row). For a pending senior
// this is THE consent moment; for an active senior it's a welcome callback.
// deno-lint-ignore no-explicit-any
async function handleInbound(message: any) {
  const caller = message?.call?.customer?.number ?? "";
  const { data: senior } = await supabase.from("seniors")
    .select(
      "id, family_id, first_name, preferred_name, status, share_token, timezone, " +
        "schedules:call_schedules(call_time, active)",
    )
    .eq("phone", caller)
    .in("status", ["pending_consent", "active"])
    .limit(1)
    .maybeSingle();
  if (!senior) return; // unknown caller: nothing to store, by design

  const durationSeconds = Math.round(
    message.durationSeconds ??
      (message.endedAt && message.startedAt
        ? (new Date(message.endedAt).getTime() - new Date(message.startedAt).getTime()) / 1000
        : 0),
  );
  const recordingUrl = message.artifact?.recordingUrl ?? message.recordingUrl ?? null;

  const { data: callRow } = await supabase.from("calls").insert({
    senior_id: senior.id,
    scheduled_for: message.startedAt ?? new Date().toISOString(),
    scheduled_local_date: localDate(senior.timezone),
    status: "completed",
    provider_call_id: message.call?.id ?? null,
    started_at: message.startedAt ?? null,
    ended_at: message.endedAt ?? new Date().toISOString(),
    duration_seconds: durationSeconds || null,
    ended_reason: `inbound:${message.endedReason ?? "ended"}`,
    transcript: message.artifact?.transcript ?? message.transcript ?? null,
    recording_url: recordingUrl,
  }).select("id").single();

  const name = senior.preferred_name || senior.first_name;

  if (senior.status === "active") {
    // A callback from an active senior: run the normal post-call processing
    // so anything they said (including "stop calling me") is honored.
    if (callRow) {
      await handleCompleted(
        { id: callRow.id, senior_id: senior.id, kind: "checkin" },
        message,
      );
    }
    return;
  }

  // Pending consent: the setup assistant's analysis decides what happened.
  const structured = message?.analysis?.structuredData ?? {};
  if (structured.consent_given === true) {
    await supabase.from("consent_events").insert({
      senior_id: senior.id,
      event: "granted",
      method: "senior_inbound_setup_call",
      recording_url: recordingUrl,
      notes: structured.consent_quote ??
        message?.analysis?.summary ?? "Senior agreed on recorded inbound setup call.",
    });
    await supabase.from("seniors").update({ status: "active" }).eq("id", senior.id);
    // If this was a second parent added later, their yes is what starts the
    // billing for them — see activateParentAddon.
    await activateParentAddon(senior.id, senior.family_id);
    const sched = (senior.schedules as { call_time: string; active: boolean }[] ?? [])
      .find((s) => s.active);
    const speech = sched ? timeSpeech(sched.call_time) : "the time you chose";
    const link = `${FAM_LINK_BASE}/${senior.share_token}`;
    await sendText(
      await familyPhones(senior.id),
      // First recurring message of the program: carries the full disclosure.
      `🟢 ${name} just said yes to Etta! Check-ins start tomorrow around ` +
        `${speech}. You'll get a note here after each call — and the full ` +
        `picture any time: ${link}\n— Etta\n` +
        `Msg frequency varies. Msg & data rates may apply. ` +
        `Reply STOP to opt out, HELP for help.`,
    );
  } else if (structured.consent_declined === true) {
    const stopped = await stopBillingForSenior(
      senior.id,
      senior.family_id,
      "senior_declined_consent",
    );
    await supabase.from("call_schedules")
      .update({ active: false }).eq("senior_id", senior.id);
    await sendText(
      await familyPhones(senior.id),
      `Etta update: ${name} decided not to start the check-in calls — and that's ` +
        `completely okay; nothing will happen and you haven't been charged for it. ` +
        (stopped === "subscription"
          ? `Your subscription is canceled. `
          : `Nothing else about your account changes. `) +
        `If they change their mind, just call Etta together again from their phone. — Etta`,
    );
  } else {
    await sendText(
      await familyPhones(senior.id),
      `Etta update: someone called from ${name}'s phone, but it didn't end in ` +
        `a clear yes from ${name}, so nothing starts yet. When you're ready, ` +
        `call Etta together again from their phone. — Etta`,
    );
  }
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("VAPI_WEBHOOK_SECRET");
  if (!secret || req.headers.get("x-vapi-secret") !== secret) {
    return json({ error: "unauthorized" }, 401);
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const message = payload?.message;
  if (!message?.type) return json({ ok: true, ignored: "no message type" });

  if (message.type === "assistant-request") {
    return await handleAssistantRequest(message);
  }

  if (message.type === "status-update") {
    if (message.status === "in-progress") {
      const call = await findCall(message);
      // Gate on started_at, not on status: place-due-calls already flips the
      // row to in_progress the moment Vapi accepts the POST, so a status check
      // here never passed and started_at stayed null until the call was over.
      // It is the only record of when the line actually connected, and the
      // wrap-up clock is measured from it.
      if (call && !call.started_at) {
        await supabase.from("calls")
          .update({ status: "in_progress", started_at: new Date().toISOString() })
          .eq("id", call.id);
      }
    }
    return json({ ok: true });
  }

  if (message.type === "speech-update") {
    // Only when Etta stops talking. That is the seam where a new instruction
    // can land without interrupting anyone, and it keeps this to roughly one
    // tick per turn instead of one per speech transition.
    if (message.status === "stopped" && message.role === "assistant") {
      await handleWrapUp(message);
    }
    return json({ ok: true });
  }

  if (message.type !== "end-of-call-report") {
    return json({ ok: true, ignored: message.type });
  }

  const call = await findCall(message);
  if (!call) {
    // Inbound calls have no pre-created row: setup/consent calls and
    // callbacks from active seniors land here.
    if ((message.call?.type ?? "").toLowerCase().includes("inbound")) {
      await handleInbound(message);
      return json({ ok: true, inbound: true });
    }
    return json({ error: "call not found" }, 404);
  }

  const durationSeconds = Math.round(
    message.durationSeconds ??
      (message.endedAt && message.startedAt
        ? (new Date(message.endedAt).getTime() - new Date(message.startedAt).getTime()) / 1000
        : 0),
  );
  const endedReason: string = message.endedReason ?? "";
  const transcript = message.artifact?.transcript ?? message.transcript ?? null;
  const reached = message.analysis?.structuredData?.reached_senior;
  const status = classifyStatus(
    endedReason,
    durationSeconds,
    hasHumanTurn(transcript),
    typeof reached === "boolean" ? reached : null,
  );

  await supabase.from("calls").update({
    status,
    started_at: message.startedAt ?? call.started_at,
    ended_at: message.endedAt ?? new Date().toISOString(),
    duration_seconds: durationSeconds || null,
    ended_reason: endedReason || null,
    transcript,
    recording_url: message.artifact?.recordingUrl ?? message.recordingUrl ?? null,
  }).eq("id", call.id);

  // A failed call is a call that didn't happen, and the remedy is the same as
  // for no answer: try again shortly, and tell the family if we run out of
  // tries. Leaving it inert meant a provider error silently skipped a day.
  if (status === "no_answer" || status === "failed") await handleNoAnswer(call);
  if (status === "completed") await handleCompleted(call, message);

  return json({ ok: true, status });
});
