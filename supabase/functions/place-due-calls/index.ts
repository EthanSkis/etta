// place-due-calls — the outbound scheduler.
//
// Invoked by cron every 10 minutes (see docs/launch-runbook.md). For every
// active senior with an active schedule it checks, in the SENIOR'S OWN
// TIMEZONE, whether their chosen call time has arrived today, creates the
// call row (once per schedule per local day), and places the call through
// Vapi. Also places any pending retry rows created by the call-events
// webhook after a no-answer, and any paid occasion call falling due today.
//
// A senior may now have more than one standing call — the plan's check-in,
// an evening check-in, medication reminders — and the schedule's `kind` is
// what tells Etta which one she's making. One consent covers all of them:
// they are all Etta calling, which is what the senior said yes to.
//
// Consent is enforced here, not just at signup: only seniors with
// status='active' are ever called, and the status is re-checked immediately
// before each placement so an in-call revocation stops the very next call.
//
// Auth: requires the X-Etta-Cron-Secret header to match CRON_SECRET.
// Without VAPI_* secrets it runs in dry-run mode: reports what is due,
// creates nothing, places nothing.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { callBudget, planFor } from "../_shared/catalog.ts";

const GRACE_MINUTES = 45; // place a due call up to 45 min late (cron gaps, downtime)
const STALE_HOURS = 2;    // scheduled rows older than this are marked failed, not placed

// Billing states that still get calls. past_due is deliberate: a card that
// needs updating shouldn't cut off someone's daily check-in mid-retry.
// "comped" covers accounts that pay nothing by design — the founder pilot,
// friends-and-family, and B2B/partner trials — so they never depend on Stripe.
const PAYING_STATUSES = ["trialing", "active", "past_due", "comped"];

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Rows come back from PostgREST with joins inlined; the generated types don't
// describe those, so query results are read as plain rows.
// deno-lint-ignore no-explicit-any
type Row = any;

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
      "id, call_time, days_of_week, kind, senior:seniors!inner(id, status, timezone, " +
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

  for (const sched of (schedules ?? []) as Row[]) {
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
      kind: (sched.kind as string) ?? "checkin",
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

  // 1b. Paid occasion calls falling due today — a birthday, or a message the
  //     family asked Etta to pass along. Same consent gate as everything
  //     else: the senior must be active, and the subscription must be live.
  const { data: occasions, error: occErr } = await supabase
    .from("occasion_calls")
    .select(
      "id, call_time, local_date, senior:seniors!inner(id, status, timezone, " +
        "family:families!inner(subscription_status))",
    )
    .eq("status", "scheduled")
    .eq("seniors.status", "active")
    .in("seniors.families.subscription_status", PAYING_STATUSES);
  if (occErr) report.errors.push(`occasions query: ${occErr.message}`);

  for (const occ of (occasions ?? []) as Row[]) {
    const senior = occ.senior as unknown as { id: string; timezone: string };
    const now = localNow(senior.timezone);
    if (now.date !== occ.local_date) continue;
    const occMinutes = timeToMinutes(occ.call_time as string);
    if (now.minutes < occMinutes || now.minutes > occMinutes + GRACE_MINUTES) continue;
    report.due.push(`occasion:${occ.id}`);
    if (dryRun) continue;

    const { error: insErr } = await supabase.from("calls").insert({
      senior_id: senior.id,
      scheduled_for: new Date().toISOString(),
      scheduled_local_date: now.date,
      attempt_number: 1,
      kind: "occasion",
      occasion_id: occ.id,
    });
    if (insErr) {
      if (!insErr.message.includes("duplicate")) {
        report.errors.push(`occasion insert ${occ.id}: ${insErr.message}`);
      }
      continue;
    }
    await supabase.from("occasion_calls").update({ status: "placed" }).eq("id", occ.id);
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
      "id, scheduled_for, attempt_number, kind, occasion_id, " +
        "schedule:call_schedules(label), " +
        "occasion:occasion_calls(occasion, from_name, message), " +
        "senior:seniors!inner(" +
        "id, status, first_name, preferred_name, phone, timezone, notes, share_recordings, " +
        "family:families!inner(primary_contact_name, subscription_status, plan))",
    )
    .eq("status", "scheduled")
    .is("provider_call_id", null)
    .lte("scheduled_for", new Date().toISOString());
  if (pendErr) {
    report.errors.push(`pending query: ${pendErr.message}`);
  }

  for (const call of (pending ?? []) as Row[]) {
    const senior = call.senior as unknown as {
      id: string; status: string; first_name: string;
      preferred_name: string | null; phone: string; timezone: string;
      notes: string | null; share_recordings: string;
      family: {
        primary_contact_name: string;
        subscription_status: string | null;
        plan: string | null;
      };
    };

    // Consent re-check at the last possible moment.
    if (senior.status !== "active") {
      await supabase.from("calls")
        .update({ status: "canceled", ended_reason: "consent_not_active" })
        .eq("id", call.id);
      report.canceled++;
      continue;
    }

    // Same for billing: a subscription canceled since the row was created
    // must not result in a call.
    if (!PAYING_STATUSES.includes(senior.family.subscription_status ?? "")) {
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

    // Yesterday's "ask about X tomorrow", if the family or Etta noted one.
    const { data: lastSummary } = await supabase
      .from("call_summaries")
      .select("tomorrow_topic, summary")
      .eq("senior_id", senior.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const kind = (call.kind as string) ?? "checkin";
    const plan = planFor(senior.family.plan);
    // What this call may spend, and when Etta will be told to start closing.
    // A Companion call is sold on being longer; a pill reminder is sold on
    // being short. One fixed ceiling can't serve both.
    const budget = callBudget(plan, kind);
    const name = senior.preferred_name || senior.first_name;
    const occasion = (Array.isArray(call.occasion) ? call.occasion[0] : call.occasion) as
      | { occasion: string; from_name: string; message: string }
      | null;
    const schedule = (Array.isArray(call.schedule) ? call.schedule[0] : call.schedule) as
      | { label: string | null }
      | null;
    const medLabel = schedule?.label || "your pills";

    // Etta opens differently depending on why she's calling — and on every
    // one of them she says what she is in the first breath.
    const firstMessage = kind === "medication"
      ? `Hi ${name}, it's Etta — your AI check-in companion. Just a quick one: ` +
        `it's time for ${medLabel}. Have you had a chance to take them?`
      : kind === "occasion"
      ? `Hi ${name}, it's Etta — your AI companion. This isn't the usual check-in: ` +
        `${occasion?.from_name ?? "your family"} asked me to call you today with ` +
        `something.`
      : kind === "evening"
      ? `Hi ${name}, it's Etta again — your AI companion, checking in one more ` +
        `time before the day's out. How did it go?`
      : undefined; // the assistant's own first message covers the morning call

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
        metadata: { call_id: call.id, senior_id: senior.id, kind },
        assistantOverrides: {
          ...(firstMessage ? { firstMessage } : {}),
          maxDurationSeconds: budget.maxSeconds,
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
            preferred_name: name,
            family_contact: senior.family.primary_contact_name,
            senior_notes: senior.notes || "",
            last_call_summary: lastSummary?.summary || "",
            ask_about: lastSummary?.tomorrow_topic || "",
            attempt_number: String(call.attempt_number),
            // Etta only raises the recording question while it's unanswered,
            // and never on a call that isn't a proper check-in.
            ask_recording: senior.share_recordings === "unknown" && kind === "checkin"
              ? "yes"
              : "no",
            call_kind: kind,
            call_length_guidance: kind === "checkin" || kind === "evening"
              ? plan.lengthGuidance
              : "",
            med_label: kind === "medication" ? medLabel : "",
            occasion_kind: occasion?.occasion ?? "",
            occasion_from: occasion?.from_name ?? "",
            occasion_message: occasion?.message ?? "",
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
      .update({
        status: "in_progress",
        provider_call_id: vapiCall.id,
        // Vapi hands out the live-control endpoint exactly once, here. It is
        // how call-events tells Etta to start wrapping up at the 5-minute
        // mark; without it the only thing keeping calls short is the hard
        // 7-minute cut, which lands mid-sentence.
        control_url: vapiCall.monitor?.controlUrl ?? null,
        time_budget_seconds: budget.maxSeconds,
      })
      .eq("id", call.id);
    report.placed++;
  }

  return new Response(JSON.stringify(report), {
    headers: { "Content-Type": "application/json" },
  });
});
