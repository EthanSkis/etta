// place-due-calls — the outbound scheduler.
//
// Invoked by cron every 10 minutes (see docs/launch-runbook.md). For every
// active senior with an active schedule it checks, in the SENIOR'S OWN
// TIMEZONE, whether their chosen call time has arrived today, creates the
// call row (once per schedule per local day), and places the call through
// Vapi. Also places any pending retry rows created by the call-events
// webhook after a no-answer.
//
// It places one other kind of call: the INTRODUCTION call (kind='setup'),
// booked by the family from the post-checkout screen for "now" or a chosen
// time (see the setup-call function). Those go to the setup assistant, and
// they are the only calls placed to a senior who is not yet active — the
// whole point of them is to ask.
//
// Consent is enforced here, not just at signup: only seniors with
// status='active' get check-in calls, and the status is re-checked
// immediately before each placement so an in-call revocation stops the very
// next call. A setup call is allowed only while the senior is still
// pending_consent — once they've answered either way, it is canceled.
//
// Auth: requires the X-Etta-Cron-Secret header to match CRON_SECRET.
// Without VAPI_* secrets it runs in dry-run mode: reports what is due,
// creates nothing, places nothing.

import { createClient } from "jsr:@supabase/supabase-js@2";

const GRACE_MINUTES = 45; // place a due call up to 45 min late (cron gaps, downtime)
const STALE_HOURS = 2;    // scheduled rows older than this are marked failed, not placed

// Billing states that still get calls. past_due is deliberate: a card that
// needs updating shouldn't cut off someone's daily check-in mid-retry.
// "comped" covers accounts that pay nothing by design — the founder pilot,
// friends-and-family, and B2B/partner trials — so they never depend on Stripe.
const PAYING_STATUSES = ["trialing", "active", "past_due", "comped"];

// Introduction calls run against a subscription that may be seconds old, so
// they use the inverse test: place unless billing is definitively dead. A null
// status here means "Checkout finished, the webhook hasn't landed yet" — that
// must not be the reason a family's one-tap introduction never happens.
const DEAD_SUBSCRIPTION = ["canceled", "incomplete_expired", "unpaid"];

const SETUP_ASSISTANT_ID =
  Deno.env.get("VAPI_SETUP_ASSISTANT_ID") ?? "0089b42e-799e-42c5-878a-2478387ae1de";
const ETTA_NUMBER_DISPLAY = "(762) 239-4275";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

interface LocalNow {
  date: string;    // YYYY-MM-DD in the senior's timezone
  minutes: number; // minutes since local midnight
  dow: number;     // 0=Sunday … 6=Saturday
}

function localNow(timeZone: string): LocalNow {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dowMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10),
    dow: dowMap[get("weekday")] ?? 0,
  };
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map((n) => parseInt(n, 10));
  return h * 60 + m;
}

// "09:00:00" → "9 in the morning". Etta says times; she doesn't read them out.
function timeSpeech(t: string): string {
  const [hs, ms] = t.split(":");
  const h24 = parseInt(hs, 10);
  const m = parseInt(ms, 10);
  const part = h24 < 12 ? "in the morning" : h24 < 17 ? "in the afternoon" : "in the evening";
  const h = h24 % 12 || 12;
  return m === 0 ? `${h} ${part}` : `${h}:${String(m).padStart(2, "0")} ${part}`;
}

Deno.serve(async (req) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret || req.headers.get("x-etta-cron-secret") !== cronSecret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const vapiKey = Deno.env.get("VAPI_API_KEY");
  const vapiAssistant = Deno.env.get("VAPI_ASSISTANT_ID");
  const vapiPhoneNumber = Deno.env.get("VAPI_PHONE_NUMBER_ID");
  const dryRun = !vapiKey || !vapiAssistant || !vapiPhoneNumber;

  const report = {
    dryRun,
    schedulesChecked: 0,
    due: [] as string[],
    created: 0,
    placed: 0,
    canceled: 0,
    staleFailed: 0,
    errors: [] as string[],
  };

  // 1. Turn due schedules into call rows (attempt 1, once per local day).
  const { data: schedules, error: schedErr } = await supabase
    .from("call_schedules")
    .select(
      "id, call_time, days_of_week, senior:seniors!inner(id, status, timezone, " +
        "family:families!inner(subscription_status))",
    )
    .eq("active", true)
    .eq("seniors.status", "active")
    .in("seniors.families.subscription_status", PAYING_STATUSES);
  if (schedErr) {
    return new Response(JSON.stringify({ error: schedErr.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  for (const sched of schedules ?? []) {
    report.schedulesChecked++;
    const senior = sched.senior as unknown as {
      id: string; status: string; timezone: string;
    };
    const now = localNow(senior.timezone);
    if (!(sched.days_of_week as number[]).includes(now.dow)) continue;

    const callMinutes = timeToMinutes(sched.call_time as string);
    if (now.minutes < callMinutes || now.minutes > callMinutes + GRACE_MINUTES) {
      continue;
    }
    report.due.push(sched.id as string);
    if (dryRun) continue;

    const { data: existing } = await supabase
      .from("calls")
      .select("id")
      .eq("schedule_id", sched.id)
      .eq("scheduled_local_date", now.date)
      .eq("attempt_number", 1)
      .maybeSingle();
    if (existing) continue;

    const { error: insErr } = await supabase.from("calls").insert({
      senior_id: senior.id,
      schedule_id: sched.id,
      scheduled_for: new Date().toISOString(),
      scheduled_local_date: now.date,
      attempt_number: 1,
    });
    if (insErr) {
      // 23505 = unique violation: another tick beat us to it; fine.
      if (!insErr.message.includes("duplicate")) {
        report.errors.push(`insert ${sched.id}: ${insErr.message}`);
      }
      continue;
    }
    report.created++;
  }

  if (dryRun) {
    return new Response(JSON.stringify(report), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // 2. Place every pending call row that is due (fresh ones from step 1 and
  //    retry rows the webhook created after a no-answer).
  const { data: pending, error: pendErr } = await supabase
    .from("calls")
    .select(
      "id, kind, scheduled_for, attempt_number, schedule_id, senior:seniors!inner(" +
        "id, status, first_name, preferred_name, phone, timezone, notes, share_recordings, " +
        "family:families!inner(primary_contact_name, subscription_status), " +
        "schedules:call_schedules(call_time, active))",
    )
    .eq("status", "scheduled")
    .is("provider_call_id", null)
    .lte("scheduled_for", new Date().toISOString());
  if (pendErr) {
    report.errors.push(`pending query: ${pendErr.message}`);
  }

  for (const call of pending ?? []) {
    const senior = call.senior as unknown as {
      id: string; status: string; first_name: string;
      preferred_name: string | null; phone: string; timezone: string;
      notes: string | null; share_recordings: string;
      family: { primary_contact_name: string; subscription_status: string | null };
      schedules: { call_time: string; active: boolean }[];
    };
    const isSetup = call.kind === "setup";

    // Consent re-check at the last possible moment. The two kinds want
    // opposite things: a check-in call needs a senior who has said yes, and an
    // introduction call is pointless once they've answered either way.
    if (isSetup ? senior.status !== "pending_consent" : senior.status !== "active") {
      await supabase.from("calls")
        .update({
          status: "canceled",
          ended_reason: isSetup ? "setup_no_longer_pending" : "consent_not_active",
        })
        .eq("id", call.id);
      report.canceled++;
      continue;
    }

    // Same for billing: a subscription canceled since the row was created
    // must not result in a call.
    const subStatus = senior.family.subscription_status ?? "";
    const billingBlocks = isSetup
      ? DEAD_SUBSCRIPTION.includes(subStatus)
      : !PAYING_STATUSES.includes(subStatus);
    if (billingBlocks) {
      await supabase.from("calls")
        .update({ status: "canceled", ended_reason: "subscription_inactive" })
        .eq("id", call.id);
      report.canceled++;
      continue;
    }

    const ageHours =
      (Date.now() - new Date(call.scheduled_for as string).getTime()) / 3.6e6;
    if (ageHours > STALE_HOURS) {
      await supabase.from("calls")
        .update({ status: "failed", ended_reason: "stale_never_placed" })
        .eq("id", call.id);
      report.staleFailed++;
      continue;
    }

    const name = senior.preferred_name || senior.first_name;

    // The introduction call: same number, same recording, different job —
    // Etta explains herself and asks for a yes. She speaks first, and her
    // first words are the disclosure and a check that this is the right
    // person, because an outbound call reaches whoever picks up.
    if (isSetup) {
      const sched = (senior.schedules ?? []).find((s) => s.active);
      const speech = sched ? timeSpeech(sched.call_time) : "the time your family chose";
      const res = await fetch("https://api.vapi.ai/call", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${vapiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          assistantId: SETUP_ASSISTANT_ID,
          phoneNumberId: vapiPhoneNumber,
          customer: { number: senior.phone },
          metadata: { call_id: call.id, senior_id: senior.id, kind: "setup" },
          assistantOverrides: {
            firstMessageMode: "assistant-speaks-first",
            firstMessage: `Hello! My name is Etta — I'm an AI assistant, not a ` +
              `person, and ${senior.family.primary_contact_name} asked me to give ` +
              `you a ring. Am I speaking with ${name}?`,
            variableValues: {
              direction: "outbound",
              caller_known: "yes",
              parent_name: name,
              family_contact: senior.family.primary_contact_name,
              call_time_speech: speech,
              etta_number: ETTA_NUMBER_DISPLAY,
            },
          },
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        report.errors.push(`vapi setup ${call.id}: ${res.status} ${body.slice(0, 200)}`);
        continue;
      }
      const vapiCall = await res.json();
      await supabase.from("calls")
        .update({ status: "in_progress", provider_call_id: vapiCall.id })
        .eq("id", call.id);
      report.placed++;
      continue;
    }

    // Yesterday's "ask about X tomorrow", if the family or Etta noted one.
    const { data: lastSummary } = await supabase
      .from("call_summaries")
      .select("tomorrow_topic, summary")
      .eq("senior_id", senior.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const res = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${vapiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        assistantId: vapiAssistant,
        phoneNumberId: vapiPhoneNumber,
        customer: { number: senior.phone },
        metadata: { call_id: call.id, senior_id: senior.id },
        assistantOverrides: {
          // NO transcriber override here, deliberately. Boosting the senior's
          // name with Deepgram's per-call `keyterm` fixed "Eila" being heard as
          // "Hila" — but every call carrying it died before the assistant
          // started: Vapi accepted the POST, Twilio connected and hung up ~13s
          // later, endedReason "call.in-progress.twilio-completed-call",
          // startedAt null, cost 0. Three calls without it connected fine; two
          // with it failed. A name spelled wrong in a summary is a blemish; a
          // call that never happens is the whole product failing. If this is
          // revisited, prove it on a test number first — the API accepts the
          // override and fails later, so a 200 from Vapi means nothing here.
          variableValues: {
            preferred_name: senior.preferred_name || senior.first_name,
            family_contact: senior.family.primary_contact_name,
            senior_notes: senior.notes || "",
            last_call_summary: lastSummary?.summary || "",
            ask_about: lastSummary?.tomorrow_topic || "",
            attempt_number: String(call.attempt_number),
            // Etta only raises the recording question while it's unanswered.
            ask_recording: senior.share_recordings === "unknown" ? "yes" : "no",
          },
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      report.errors.push(`vapi ${call.id}: ${res.status} ${body.slice(0, 200)}`);
      continue; // stays 'scheduled'; retried next tick until stale
    }
    const vapiCall = await res.json();
    await supabase.from("calls")
      .update({ status: "in_progress", provider_call_id: vapiCall.id })
      .eq("id", call.id);
    report.placed++;
  }

  return new Response(JSON.stringify(report), {
    headers: { "Content-Type": "application/json" },
  });
});
