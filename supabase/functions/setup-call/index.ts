// setup-call — "Etta, ring my mum and ask her yourself."
//
// The endpoint behind the screen a family lands on after checkout. Before
// this existed, the only route to consent was the senior dialing Etta, so
// the family had to be sitting with their parent to finish signing up —
// people paid and then waited for the next visit. Now they tap once and Etta
// makes the introduction call herself, now or at a time they pick.
//
// What does NOT change: the conversation. Etta says she is an AI in her first
// breath, says the call is recorded, asks the senior directly, accepts no the
// first time, and nothing is scheduled or charged without their own yes. The
// direction of the call is the only difference — see agent/etta-setup-prompt.md.
//
// Auth is the senior's setup_token (capability, no login), handed to the page
// in the Stripe success URL. It only works while the senior is
// pending_consent, and MAX_SETUP_CALLS caps how many times that number can be
// made to ring, so a leaked token can't be turned into harassment.

import { createClient } from "jsr:@supabase/supabase-js@2";

const ETTA_NUMBER_DISPLAY = "(762) 239-4275";
const ETTA_NUMBER_E164 = "+17622394275";
const SITE = "https://www.ettacalls.com";
const SAVE_URL = `${SITE}/save`;

// Total introduction calls (requests + no-answer retries) allowed per senior.
const MAX_SETUP_CALLS = 8;
// A scheduled introduction call must land in daylight, senior-local, and
// within a fortnight — nobody's phone rings at 11pm because of a timezone slip.
const EARLIEST_HOUR = 8;
const LATEST_HOUR = 20;
const MAX_DAYS_AHEAD = 14;

const SETUP_ASSISTANT_ID =
  Deno.env.get("VAPI_SETUP_ASSISTANT_ID") ?? "0089b42e-799e-42c5-878a-2478387ae1de";

// Subscription states that must not result in a phone ringing. null is
// allowed on purpose: the family has just come back from Checkout and the
// Stripe webhook may not have landed yet.
const DEAD_SUBSCRIPTION = ["canceled", "incomplete_expired", "unpaid"];

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// "09:00:00" → "9 in the morning" (Etta says times, she doesn't read them out).
function timeSpeech(t: string): string {
  const [hs, ms] = t.split(":");
  const h24 = parseInt(hs, 10);
  const m = parseInt(ms, 10);
  const part = h24 < 12 ? "in the morning" : h24 < 17 ? "in the afternoon" : "in the evening";
  const h = h24 % 12 || 12;
  return m === 0 ? `${h} ${part}` : `${h}:${String(m).padStart(2, "0")} ${part}`;
}

// "15:30" → "3:30pm"
function clock(t: string): string {
  const [hs, ms] = t.split(":");
  const h24 = parseInt(hs, 10);
  const h = h24 % 12 || 12;
  return `${h}:${ms}${h24 < 12 ? "am" : "pm"}`;
}

// How far the zone is from UTC at a given instant, in ms.
function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) -
    at.getTime();
}

// A wall-clock time in the senior's own timezone → the UTC instant it names.
// Two passes: the first offset is looked up at the wrong instant whenever the
// request straddles a DST change, and the second corrects it.
function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, mo, d] = date.split("-").map((n) => parseInt(n, 10));
  const [h, mi] = time.split(":").map((n) => parseInt(n, 10));
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  let ts = naive - tzOffsetMs(new Date(naive), timeZone);
  ts = naive - tzOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

function localParts(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", weekday: "long",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    weekday: get("weekday"),
  };
}

// "today at 3:30pm" / "Thursday at 9:00am" — what the family reads back.
function whenSpeech(at: Date, timeZone: string): string {
  const now = localParts(new Date(), timeZone);
  const then = localParts(at, timeZone);
  const tomorrow = localParts(new Date(Date.now() + 864e5), timeZone);
  const day = then.date === now.date
    ? "today"
    : then.date === tomorrow.date
    ? "tomorrow"
    : then.weekday;
  return `${day} at ${clock(then.time)}`;
}

interface SeniorRow {
  id: string;
  first_name: string;
  preferred_name: string | null;
  phone: string;
  timezone: string;
  status: string;
  family_id: string;
  family: { primary_contact_name: string; subscription_status: string | null };
  schedules: { call_time: string; active: boolean }[];
}

async function loadSenior(token: string): Promise<SeniorRow | null> {
  const { data } = await supabase.from("seniors")
    .select(
      "id, first_name, preferred_name, phone, timezone, status, family_id, " +
        "family:families!inner(primary_contact_name, subscription_status), " +
        "schedules:call_schedules(call_time, active)",
    )
    .eq("setup_token", token)
    .maybeSingle();
  return (data as unknown as SeniorRow) ?? null;
}

// The pending/most recent introduction call, and how many have been made.
async function setupCalls(seniorId: string) {
  const { data } = await supabase.from("calls")
    .select("id, status, scheduled_for, attempt_number, ended_reason")
    .eq("senior_id", seniorId).eq("kind", "setup")
    .order("scheduled_for", { ascending: false });
  const rows = data ?? [];
  return {
    all: rows,
    open: rows.find((r) => ["scheduled", "in_progress"].includes(r.status as string)) ?? null,
    latest: rows[0] ?? null,
  };
}

// Hand the call to Vapi right now. Returns the provider call id, or null on a
// provider error (the row stays 'scheduled' and the cron picks it up).
async function placeNow(
  senior: SeniorRow,
  callId: string,
  callTimeSpeech: string,
): Promise<string | null> {
  const key = Deno.env.get("VAPI_API_KEY");
  const phoneNumberId = Deno.env.get("VAPI_PHONE_NUMBER_ID");
  if (!key || !phoneNumberId) return null; // dry-run: the scheduler will try later

  const name = senior.preferred_name || senior.first_name;
  const res = await fetch("https://api.vapi.ai/call", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      assistantId: SETUP_ASSISTANT_ID,
      phoneNumberId,
      customer: { number: senior.phone },
      metadata: { call_id: callId, senior_id: senior.id, kind: "setup" },
      assistantOverrides: {
        // Outbound, so Etta speaks first — and her first breath is the
        // disclosure plus a check that this is even the right person.
        firstMessageMode: "assistant-speaks-first",
        firstMessage: `Hello! My name is Etta — I'm an AI assistant, not a person, ` +
          `and ${senior.family.primary_contact_name} asked me to give you a ring. ` +
          `Am I speaking with ${name}?`,
        variableValues: {
          direction: "outbound",
          caller_known: "yes",
          parent_name: name,
          family_contact: senior.family.primary_contact_name,
          call_time_speech: callTimeSpeech,
          etta_number: ETTA_NUMBER_DISPLAY,
        },
      },
    }),
  });
  if (!res.ok) {
    console.error("vapi setup call failed:", res.status, (await res.text()).slice(0, 300));
    return null;
  }
  const body = await res.json();
  return (body?.id as string) ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const token = String(body.token ?? "").trim();
  const action = String(body.action ?? "status");
  if (!/^[a-f0-9]{16,64}$/.test(token)) return json({ error: "not found" }, 404);

  const senior = await loadSenior(token);
  if (!senior) return json({ error: "not found" }, 404);

  const name = senior.preferred_name || senior.first_name;
  const sched = (senior.schedules ?? []).find((s) => s.active);
  const callTimeSpeech = sched ? timeSpeech(sched.call_time) : "the time your family chose";
  // The day and time pickers have to be drawn in the SENIOR'S timezone, not
  // the browser's: the family member booking this is often in another one,
  // and "today at 9am" must mean their parent's morning.
  const nowLocal = localParts(new Date(), senior.timezone);
  const base = {
    name,
    etta_number: ETTA_NUMBER_DISPLAY,
    etta_number_e164: ETTA_NUMBER_E164,
    save_url: SAVE_URL,
    timezone: senior.timezone,
    local_today: nowLocal.date,
    local_now: nowLocal.time,
    earliest_hour: EARLIEST_HOUR,
    latest_hour: LATEST_HOUR,
    parent_phone: senior.phone,
    check_in_time: sched ? clock(sched.call_time.slice(0, 5)) : null,
    // The heads-up the family sends from their OWN phone, so the first thing
    // their parent sees about Etta arrives from a number they already trust —
    // and so Etta's number is saved before it ever rings.
    heads_up_text:
      `Hi — I signed us up for something called Etta: a friendly check-in call, ` +
      `and it's honest that it's an AI. She'll ring you from ${ETTA_NUMBER_DISPLAY} ` +
      `to introduce herself and ask if you'd even like it — it only happens if you ` +
      `say yes. Save her number first so you know it's her: ${SAVE_URL}`,
  };

  // Already decided: nothing here applies any more.
  if (senior.status !== "pending_consent") {
    return json({
      ...base,
      ok: true,
      state: senior.status === "active" ? "done" : "closed",
      senior_status: senior.status,
    });
  }

  const { all, open, latest } = await setupCalls(senior.id);

  if (action === "status") {
    return json({
      ...base,
      ok: true,
      state: open ? (open.status === "in_progress" ? "calling" : "scheduled") : (latest ? "attempted" : "none"),
      when_iso: open?.scheduled_for ?? null,
      when_speech: open ? whenSpeech(new Date(open.scheduled_for as string), senior.timezone) : null,
      calls_left: Math.max(0, MAX_SETUP_CALLS - all.length),
    });
  }

  if (action === "cancel") {
    // Only a call that hasn't been placed can be called off. Marking a live
    // one canceled would be a lie told to the family while the phone rings.
    if (open && open.status === "scheduled") {
      await supabase.from("calls")
        .update({ status: "canceled", ended_reason: "setup_call_canceled_by_family" })
        .eq("id", open.id);
    }
    return json({ ...base, ok: true, state: "none", calls_left: Math.max(0, MAX_SETUP_CALLS - all.length) });
  }

  if (action !== "now" && action !== "schedule") {
    return json({ error: "unknown action" }, 400);
  }

  if (DEAD_SUBSCRIPTION.includes(senior.family.subscription_status ?? "")) {
    return json({
      error: "This signup's subscription isn't active, so Etta won't call. " +
        "Start again at ettacalls.com/signup and nothing will be charged twice.",
    }, 409);
  }
  if (open && open.status === "in_progress") {
    return json({
      error: `Etta is on the phone with ${name} right now — you'll get a text ` +
        `the moment there's an answer.`,
    }, 409);
  }
  if (all.length >= MAX_SETUP_CALLS) {
    return json({
      error: `Etta has already tried ${name}'s phone as many times as we allow. ` +
        `Whenever they're ready, they can call her directly at ${ETTA_NUMBER_DISPLAY}.`,
    }, 429);
  }

  let when = new Date();
  if (action === "now") {
    // "Now" is the family's now, and they are often in another timezone. A
    // signup finished at 11pm in New York must not ring a phone in Phoenix.
    const hourThere = parseInt(nowLocal.time.slice(0, 2), 10);
    if (hourThere < EARLIEST_HOUR || hourThere >= LATEST_HOUR) {
      return json({
        error: `It's ${clock(nowLocal.time)} where ${name} is — too late for an ` +
          `unexpected call. Pick a time between ${EARLIEST_HOUR}am and ` +
          `${LATEST_HOUR - 12}pm their time instead.`,
      }, 409);
    }
  }
  if (action === "schedule") {
    const date = String(body.local_date ?? "");
    const time = String(body.local_time ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      return json({ error: "Please pick a day and a time." }, 400);
    }
    const hour = parseInt(time.slice(0, 2), 10);
    if (hour < EARLIEST_HOUR || hour >= LATEST_HOUR) {
      return json({
        error: `Etta only makes introduction calls between ${EARLIEST_HOUR}am and ` +
          `${LATEST_HOUR - 12}pm, ${name}'s time.`,
      }, 400);
    }
    when = zonedToUtc(date, time, senior.timezone);
    if (isNaN(when.getTime())) return json({ error: "Please pick a day and a time." }, 400);
    if (when.getTime() < Date.now() - 60_000) {
      return json({ error: "That time has already passed — please pick another." }, 400);
    }
    if (when.getTime() > Date.now() + MAX_DAYS_AHEAD * 864e5) {
      return json({ error: `Please pick a time in the next ${MAX_DAYS_AHEAD} days.` }, 400);
    }
  }

  // One outstanding introduction call per senior: replace, never stack.
  if (open) {
    await supabase.from("calls")
      .update({ status: "canceled", ended_reason: "setup_call_rescheduled" })
      .eq("id", open.id);
  }

  const local = localParts(when, senior.timezone);
  const { data: callRow, error: insErr } = await supabase.from("calls").insert({
    senior_id: senior.id,
    kind: "setup",
    scheduled_for: when.toISOString(),
    scheduled_local_date: local.date,
    attempt_number: 1,
  }).select("id").single();
  if (insErr || !callRow) {
    console.error("setup call insert failed:", insErr?.message);
    return json({ error: "Something went wrong on our side — please try again." }, 500);
  }

  if (action === "now") {
    const providerId = await placeNow(senior, callRow.id, callTimeSpeech);
    if (providerId) {
      await supabase.from("calls")
        .update({ status: "in_progress", provider_call_id: providerId })
        .eq("id", callRow.id);
    }
    // No provider id means Vapi refused or the keys aren't set: the row stays
    // 'scheduled' and place-due-calls retries it on the next tick, so the
    // family is told "within a few minutes" rather than a lie either way.
    return json({
      ...base,
      ok: true,
      state: providerId ? "calling" : "scheduled",
      when_iso: when.toISOString(),
      when_speech: providerId ? "now" : "in a few minutes",
      calls_left: Math.max(0, MAX_SETUP_CALLS - all.length - 1),
    });
  }

  return json({
    ...base,
    ok: true,
    state: "scheduled",
    when_iso: when.toISOString(),
    when_speech: whenSpeech(when, senior.timezone),
    calls_left: Math.max(0, MAX_SETUP_CALLS - all.length - 1),
  });
});
