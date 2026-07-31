// call-events — Vapi server webhook.
//
// Receives status updates and end-of-call reports, and turns them into the
// product: call outcomes, the family-facing summary, no-answer retries and
// escalation, and — most importantly — immediate honoring of an in-call
// revocation ("stop calling me" ends the service before the next call is
// ever scheduled).
//
// Auth: Vapi sends the assistant's server secret in the X-Vapi-Secret
// header; must match VAPI_WEBHOOK_SECRET. Summary email goes out through
// Resend when RESEND_API_KEY is set; otherwise summaries are stored with
// delivered_at null and can be sent later.

import { createClient } from "jsr:@supabase/supabase-js@2";

const MAX_ATTEMPTS = 3;        // 1 scheduled call + 2 retries
const RETRY_DELAY_MINUTES = 30;

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function sendEmail(to: string[], subject: string, text: string): Promise<boolean> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key || to.length === 0) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: Deno.env.get("SUMMARY_FROM_EMAIL") ?? "Etta <hello@ettacalls.com>",
      to,
      subject,
      text,
    }),
  });
  if (!res.ok) console.error("resend failed:", res.status, await res.text());
  return res.ok;
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

async function familyEmails(
  seniorId: string,
  opts: { escalationOnly?: boolean } = {},
): Promise<string[]> {
  const { data: senior } = await supabase.from("seniors")
    .select("family_id, family:families!inner(primary_contact_email)")
    .eq("id", seniorId).maybeSingle();
  if (!senior) return [];

  let q = supabase.from("family_members")
    .select("email, receives_summaries, escalation_order")
    .eq("family_id", senior.family_id)
    .not("email", "is", null);
  q = opts.escalationOnly
    ? q.not("escalation_order", "is", null)
    : q.eq("receives_summaries", true);
  const { data: members } = await q;

  const emails = (members ?? []).map((m) => m.email as string);
  const primary = (senior.family as unknown as { primary_contact_email: string })
    .primary_contact_email;
  if (primary && !emails.includes(primary)) emails.unshift(primary);
  return emails;
}

function classifyStatus(endedReason: string, durationSeconds: number): string {
  const r = endedReason.toLowerCase();
  if (
    r.includes("did-not-answer") || r.includes("no-answer") ||
    r.includes("busy") || r.includes("voicemail")
  ) return "no_answer";
  if (r.includes("error") || r.includes("failed")) return "failed";
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
    .select("first_name, preferred_name").eq("id", call.senior_id).maybeSingle();
  const name = senior?.preferred_name || senior?.first_name || "your parent";
  const sent = await sendEmail(
    await familyEmails(call.senior_id),
    `Etta update: ${name} asked to pause the calls`,
    `Hi,\n\nOn today's call, ${name} asked Etta to stop calling — and Etta honored ` +
      `that right away, as promised. No more calls will be placed.\n\n` +
      `This might be a passing mood or a real preference; a gentle conversation is ` +
      `usually the best next step. If ${name} would like the calls again, it only ` +
      `takes a fresh yes from them — just reply to this email.\n\n— Etta`,
  );
  if (sent && esc) {
    await supabase.from("escalations")
      .update({ status: "notified", notified_at: new Date().toISOString() })
      .eq("id", esc.id);
  }
}

// deno-lint-ignore no-explicit-any
async function handleNoAnswer(call: any) {
  if (call.attempt_number < MAX_ATTEMPTS) {
    const retryAt = new Date(Date.now() + RETRY_DELAY_MINUTES * 60_000);
    const { error } = await supabase.from("calls").insert({
      senior_id: call.senior_id,
      schedule_id: call.schedule_id,
      scheduled_for: retryAt.toISOString(),
      scheduled_local_date: call.scheduled_local_date,
      attempt_number: call.attempt_number + 1,
    });
    if (error && !error.message.includes("duplicate")) {
      console.error("retry insert failed:", error.message);
    }
    return;
  }

  // Retries exhausted: open an escalation and tell the contact chain.
  const { data: esc } = await supabase.from("escalations").insert({
    senior_id: call.senior_id,
    call_id: call.id,
    reason: "no_answer",
    detail: `No answer after ${MAX_ATTEMPTS} attempts.`,
  }).select("id").single();

  const { data: senior } = await supabase.from("seniors")
    .select("first_name, preferred_name").eq("id", call.senior_id).maybeSingle();
  const name = senior?.preferred_name || senior?.first_name || "your parent";
  const sent = await sendEmail(
    await familyEmails(call.senior_id, { escalationOnly: true }),
    `Etta couldn't reach ${name} today`,
    `Hi,\n\nEtta tried ${name} ${MAX_ATTEMPTS} times today and the call wasn't ` +
      `answered. That's often nothing — errands, a nap, the phone left in another ` +
      `room — but you know ${name} best, and this is the moment Etta hands over ` +
      `to you.\n\nA quick call from you is the right next step. If you learn ` +
      `anything Etta should know (a hospital stay, travel, a new number), just ` +
      `reply to this email.\n\n— Etta`,
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
    .select("first_name, preferred_name").eq("id", call.senior_id).maybeSingle();
  const name = senior?.preferred_name || senior?.first_name || "your parent";

  const minutes = Math.max(1, Math.round(durationSeconds / 60));
  const summaryText: string = analysis.summary ||
    `Etta and ${name} talked for about ${minutes} minute${minutes === 1 ? "" : "s"}. ` +
      `A written summary wasn't produced for this call; the transcript is saved.`;

  const flags: Flag[] = Array.isArray(structured.flags) ? structured.flags : [];
  const moodScore: number | null =
    typeof structured.mood_score === "number" &&
      structured.mood_score >= 1 && structured.mood_score <= 5
      ? Math.round(structured.mood_score)
      : null;

  const { data: summaryRow, error: sumErr } = await supabase
    .from("call_summaries")
    .upsert({
      call_id: call.id,
      senior_id: call.senior_id,
      summary: summaryText,
      mood_score: moodScore,
      ate_today: typeof structured.ate_today === "boolean" ? structured.ate_today : null,
      slept_well: typeof structured.slept_well === "boolean" ? structured.slept_well : null,
      meds_taken: typeof structured.meds_taken === "boolean" ? structured.meds_taken : null,
      flags,
      revocation_requested: structured.revocation_requested === true,
      tomorrow_topic: structured.tomorrow_topic || null,
      raw_analysis: structured,
    }, { onConflict: "call_id" })
    .select("id")
    .single();
  if (sumErr) console.error("summary upsert failed:", sumErr.message);

  if (structured.revocation_requested === true) {
    await handleRevocation(call, structured);
    return; // revocation email replaces the summary email today
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

  // The family note: warm, short, chips like the site promises.
  const chips: string[] = [];
  if (moodScore) chips.push(`Mood · ${moodScore}/5 (${MOOD_WORDS[moodScore]})`);
  if (typeof structured.ate_today === "boolean") {
    chips.push(`Ate · ${structured.ate_today ? "Yes" : "Not yet"}`);
  }
  if (typeof structured.slept_well === "boolean") {
    chips.push(`Slept · ${structured.slept_well ? "Well" : "Poorly"}`);
  }
  if (typeof structured.meds_taken === "boolean") {
    chips.push(`Meds · ${structured.meds_taken ? "Taken" : "Not taken"}`);
  }

  let body = `${summaryText}\n\n`;
  if (chips.length) body += chips.join("   ") + "\n\n";
  if (urgent.length) {
    body += `Worth your attention:\n` +
      urgent.map((f) => `  • ${flagText(f)}`).join("\n") + "\n\n";
  }
  const watch = flags.filter((f) => !urgent.includes(f));
  if (watch.length) {
    body += `Keeping an eye on:\n` +
      watch.map((f) => `  • ${flagText(f)}`).join("\n") + "\n\n";
  }
  body += `Call lasted about ${minutes} minute${minutes === 1 ? "" : "s"}.\n\n` +
    `Want Etta to bring something up tomorrow? Just reply to this email.\n\n— Etta`;

  const moodWord = moodScore ? MOOD_WORDS[moodScore] : "checked in";
  const sent = await sendEmail(
    await familyEmails(call.senior_id),
    urgent.length > 0
      ? `Etta's check-in with ${name} — something worth your attention`
      : `Etta's check-in with ${name} — ${moodWord}`,
    `Hi,\n\n${body}`,
  );
  if (sent && summaryRow) {
    await supabase.from("call_summaries")
      .update({ delivered_at: new Date().toISOString() })
      .eq("id", summaryRow.id);
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

  if (message.type === "status-update") {
    if (message.status === "in-progress") {
      const call = await findCall(message);
      if (call && call.status === "scheduled") {
        await supabase.from("calls")
          .update({ status: "in_progress", started_at: new Date().toISOString() })
          .eq("id", call.id);
      }
    }
    return json({ ok: true });
  }

  if (message.type !== "end-of-call-report") {
    return json({ ok: true, ignored: message.type });
  }

  const call = await findCall(message);
  if (!call) return json({ error: "call not found" }, 404);

  const durationSeconds = Math.round(
    message.durationSeconds ??
      (message.endedAt && message.startedAt
        ? (new Date(message.endedAt).getTime() - new Date(message.startedAt).getTime()) / 1000
        : 0),
  );
  const endedReason: string = message.endedReason ?? "";
  const status = classifyStatus(endedReason, durationSeconds);

  await supabase.from("calls").update({
    status,
    started_at: message.startedAt ?? call.started_at,
    ended_at: message.endedAt ?? new Date().toISOString(),
    duration_seconds: durationSeconds || null,
    ended_reason: endedReason || null,
    transcript: message.artifact?.transcript ?? message.transcript ?? null,
    recording_url: message.artifact?.recordingUrl ?? message.recordingUrl ?? null,
  }).eq("id", call.id);

  if (status === "no_answer") await handleNoAnswer(call);
  if (status === "completed") await handleCompleted(call, message);

  return json({ ok: true, status });
});
