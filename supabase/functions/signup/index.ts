// signup — the public endpoint behind ettacalls.com/signup.html.
//
// Creates the family + senior + daily schedule in ONE step, with the senior
// in pending_consent: no call is ever placed from this form alone. The
// consent step is the senior's own inbound call to Etta's number (routed by
// call-events' assistant-request handler), which is what flips them active.
//
// Public + unauthenticated by design; defenses are a honeypot field, strict
// validation, tight length caps, and a duplicate-number check. Nothing here
// can trigger an outbound call.

import { createClient } from "jsr:@supabase/supabase-js@2";

const ETTA_NUMBER_DISPLAY = "(762) 239-4275";
const ETTA_NUMBER_E164 = "+17622394275";

const ALLOWED_TIMEZONES = new Set([
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix",
  "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu",
]);

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

// "(208) 315-1420" / "208.315.1420" / "+1 208 315 1420" → "+12083151420"
function normalizePhone(raw: string): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function cleanName(raw: unknown): string | null {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!s || s.length > 80) return null;
  return s;
}

async function notifyFamily(phone: string, body: string) {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER") ?? ETTA_NUMBER_E164;
  if (!sid || !token) return;
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${sid}:${token}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: from, To: phone, Body: body }),
    },
  );
  // Best-effort: on a Twilio trial this fails for unverified numbers, and
  // the signup success screen carries the same instructions anyway.
  if (!res.ok) console.error("signup text failed:", res.status, await res.text());
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

  // Honeypot: bots fill the hidden field — pretend it worked.
  if (body.website) return json({ ok: true, etta_number: ETTA_NUMBER_DISPLAY });

  const yourName = cleanName(body.your_name);
  const parentName = cleanName(body.parent_name);
  const yourPhone = normalizePhone(String(body.your_phone ?? ""));
  const parentPhone = normalizePhone(String(body.parent_phone ?? ""));
  const timezone = String(body.timezone ?? "");
  const callTime = String(body.call_time ?? "");
  const notes = String(body.notes ?? "").trim().slice(0, 1000) || null;

  if (!yourName || !parentName) return json({ error: "Please give both names." }, 400);
  if (!yourPhone) return json({ error: "Your mobile number doesn't look right." }, 400);
  if (!parentPhone) return json({ error: "Your parent's number doesn't look right." }, 400);
  if (yourPhone === parentPhone) {
    return json({
      error: "Those are the same number — Etta needs your parent's own phone, " +
        "since the calls (and their yes) happen there.",
    }, 400);
  }
  if (!ALLOWED_TIMEZONES.has(timezone)) return json({ error: "Please pick a time zone." }, 400);
  if (!/^(0[6-9]|1[0-9]|20):(00|30)$/.test(callTime)) {
    return json({ error: "Please pick a call time." }, 400);
  }

  // One Etta per phone line.
  const { data: existing } = await supabase.from("seniors")
    .select("id, status").eq("phone", parentPhone)
    .in("status", ["pending_consent", "active"]).limit(1);
  if (existing && existing.length > 0) {
    return json({
      error: "That number is already set up with Etta. If that's unexpected, " +
        "text Etta's number and we'll sort it out.",
    }, 409);
  }

  const { data: family, error: famErr } = await supabase.from("families")
    .insert({
      name: `${yourName}'s family`,
      primary_contact_name: yourName,
      primary_contact_phone: yourPhone,
      status: "self_serve",
    }).select("id").single();
  if (famErr || !family) {
    console.error("family insert failed:", famErr?.message);
    return json({ error: "Something went wrong on our side — please try again." }, 500);
  }

  const { data: senior, error: senErr } = await supabase.from("seniors")
    .insert({
      family_id: family.id,
      first_name: parentName,
      preferred_name: parentName,
      phone: parentPhone,
      timezone,
      notes,
      status: "pending_consent",
    }).select("id").single();
  if (senErr || !senior) {
    console.error("senior insert failed:", senErr?.message);
    await supabase.from("families").delete().eq("id", family.id);
    return json({ error: "Something went wrong on our side — please try again." }, 500);
  }

  await supabase.from("call_schedules").insert({
    senior_id: senior.id,
    call_time: `${callTime}:00`,
    days_of_week: [0, 1, 2, 3, 4, 5, 6],
  });

  await notifyFamily(
    yourPhone,
    `Etta here — you're all set up for ${parentName}. One step left, and it's ` +
      `${parentName}'s: together, from ${parentName}'s phone, call me at ` +
      `${ETTA_NUMBER_DISPLAY}. I'll introduce myself and ask for their yes — ` +
      `nothing starts without it. — Etta`,
  );

  return json({ ok: true, etta_number: ETTA_NUMBER_DISPLAY });
});
