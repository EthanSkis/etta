// signup — the public endpoint behind ettacalls.com/signup.html.
//
// Creates the family + senior + schedule with the senior in pending_consent,
// then hands back a Stripe Checkout URL. No call can be placed by this form:
// calls need (a) the senior's own recorded yes on their inbound setup call
// and (b) a live subscription. The card is collected up front but the
// subscription starts as a 14-day trial, and it is canceled without a charge
// if the senior declines or never consents.
//
// Public + unauthenticated by design; defenses are a honeypot field, strict
// validation, tight length caps, and a duplicate-number check.

import { createClient } from "jsr:@supabase/supabase-js@2";

const ETTA_NUMBER_DISPLAY = "(762) 239-4275";
const ETTA_NUMBER_E164 = "+17622394275";
const SITE = "https://www.ettacalls.com";
const TRIAL_DAYS = 14;

const PLANS: Record<string, { price: string; days: number[] }> = {
  // Standard: three calls a week (Mon/Wed/Fri). Daily: every day.
  standard: { price: "price_1TzO26A8l4yd6OUzIGnqRkhB", days: [1, 3, 5] },
  daily: { price: "price_1TzO27A8l4yd6OUzhi1l2T3b", days: [0, 1, 2, 3, 4, 5, 6] },
};

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

// A misconfigured key is the likeliest billing outage, and the failure is
// otherwise inscrutable: a key copied from Stripe's dashboard while still
// masked contains a "…" (U+2026), and fetch rejects it as a non-ByteString
// header long before Stripe ever sees it. Check the shape and say so plainly.
function stripeKey(): string {
  // Dashboard pastes routinely carry trailing newlines; a header value with
  // one is rejected outright, so normalize before anything else touches it.
  return (Deno.env.get("STRIPE_SECRET_KEY") ?? "").trim();
}

function stripeKeyProblem(): string | null {
  const key = stripeKey();
  if (!key) return "STRIPE_SECRET_KEY is not set";
  if (/[^\x20-\x7E]/.test(key)) {
    return key.includes("…") || key.includes("...")
      ? "STRIPE_SECRET_KEY looks like the masked key from the Stripe dashboard " +
        "(it contains an ellipsis) — reveal the key and paste it in full"
      : "STRIPE_SECRET_KEY contains a non-ASCII character (bad copy/paste)";
  }
  if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]{20,}$/.test(key)) {
    return "STRIPE_SECRET_KEY is not shaped like a Stripe secret key";
  }
  return null;
}

async function stripe(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const problem = stripeKeyProblem();
  if (problem) {
    console.error("stripe config error:", problem);
    throw new Error(problem);
  }
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeKey()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error("stripe error:", path, res.status, JSON.stringify(body).slice(0, 300));
    throw new Error(body?.error?.message ?? "payment setup failed");
  }
  return body;
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
  if (body.website) return json({ ok: true, checkout_url: SITE });

  const yourName = cleanName(body.your_name);
  const parentName = cleanName(body.parent_name);
  const yourPhone = normalizePhone(String(body.your_phone ?? ""));
  const parentPhone = normalizePhone(String(body.parent_phone ?? ""));
  const timezone = String(body.timezone ?? "");
  const callTime = String(body.call_time ?? "");
  const planKey = String(body.plan ?? "daily");
  const notes = String(body.notes ?? "").trim().slice(0, 1000) || null;
  const plan = PLANS[planKey];

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
  if (!plan) return json({ error: "Please pick a plan." }, 400);

  // One Etta per phone line — but an abandoned checkout shouldn't lock the
  // number forever, so an unsubscribed pending signup is replaced.
  const { data: existing } = await supabase.from("seniors")
    .select("id, status, family_id, family:families!inner(subscription_status)")
    .eq("phone", parentPhone)
    .in("status", ["pending_consent", "active"]).limit(1).maybeSingle();
  if (existing) {
    const status =
      (existing.family as unknown as { subscription_status: string | null }).subscription_status;
    const abandoned = existing.status === "pending_consent" &&
      (status === null || ["canceled", "incomplete", "incomplete_expired"].includes(status));
    if (!abandoned) {
      return json({
        error: "That number is already set up with Etta. If that's unexpected, " +
          "text Etta's number and we'll sort it out.",
      }, 409);
    }
    await supabase.from("families").delete().eq("id", existing.family_id);
  }

  const { data: family, error: famErr } = await supabase.from("families")
    .insert({
      name: `${yourName}'s family`,
      primary_contact_name: yourName,
      primary_contact_phone: yourPhone,
      status: "self_serve",
      plan: planKey,
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
    days_of_week: plan.days,
  });

  try {
    const customer = await stripe("customers", {
      name: yourName,
      phone: yourPhone,
      "metadata[family_id]": family.id,
      "metadata[senior_name]": parentName,
    });
    await supabase.from("families")
      .update({ stripe_customer_id: customer.id as string }).eq("id", family.id);

    const session = await stripe("checkout/sessions", {
      mode: "subscription",
      customer: customer.id as string,
      "line_items[0][price]": plan.price,
      "line_items[0][quantity]": "1",
      "subscription_data[trial_period_days]": String(TRIAL_DAYS),
      "subscription_data[metadata][family_id]": family.id,
      "metadata[family_id]": family.id,
      allow_promotion_codes: "true",
      success_url: `${SITE}/signup.html?started=1&who=${encodeURIComponent(parentName)}`,
      cancel_url: `${SITE}/signup.html?canceled=1`,
    });

    return json({
      ok: true,
      checkout_url: session.url as string,
      etta_number: ETTA_NUMBER_DISPLAY,
    });
  } catch (err) {
    // Payment setup failed: don't leave a half-made family behind.
    await supabase.from("families").delete().eq("id", family.id);
    return json({
      error: "We couldn't start checkout — please try again, or text " +
        `${ETTA_NUMBER_E164} and we'll help.`,
    }, 502);
  }
});
