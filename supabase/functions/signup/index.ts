// signup — the public endpoint behind ettacalls.com/signup.
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
import { ONE_TIME, PLANS, priceId, resolvePlanPrice } from "../_shared/catalog.ts";
import { ensureOneTimePrice, stripe } from "../_shared/stripe.ts";
import { ALLOWED_TIMEZONES, cleanName, normalizePhone, validCallTime } from "../_shared/validate.ts";

const ETTA_NUMBER_DISPLAY = "(762) 239-4275";
const ETTA_NUMBER_E164 = "+17622394275";
const SITE = "https://www.ettacalls.com";
const TRIAL_DAYS = 14;

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
  const plan = PLANS[planKey as keyof typeof PLANS];
  // Optional at signup: a person from Etta walks the family through setup.
  const wantsConcierge = body.concierge === true;
  // A2P 10DLC / TCPA: the summaries are delivered by text, so the account
  // holder's consent to be texted is captured at signup and kept verbatim.
  const smsConsent = body.sms_consent === true;
  const smsConsentText = String(body.sms_consent_text ?? "").trim().slice(0, 1000) || null;

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
  if (!validCallTime(callTime)) {
    return json({ error: "Please pick a call time." }, 400);
  }
  if (!plan) return json({ error: "Please pick a plan." }, 400);
  if (!smsConsent) {
    return json({
      error: "Etta sends the check-in notes by text, so we need your ok to text you.",
    }, 400);
  }

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
      sms_consent_at: new Date().toISOString(),
      sms_consent_text: smsConsentText,
      sms_consent_source: "web_signup",
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

    // Concierge setup is a one-time line on the same checkout. With a trial
    // running it lands on the first real invoice — which means it is only
    // ever charged after the senior has said yes, like everything else.
    const conciergeLine: Record<string, string> = wantsConcierge
      ? {
        "line_items[1][price]": priceId(ONE_TIME.concierge_setup.priceEnv) ||
          await ensureOneTimePrice(
            "etta_concierge_setup",
            "Etta — concierge setup",
            ONE_TIME.concierge_setup.cents,
          ),
        "line_items[1][quantity]": "1",
      }
      : {};

    const session = await stripe("checkout/sessions", {
      mode: "subscription",
      customer: customer.id as string,
      "line_items[0][price]": await resolvePlanPrice(plan),
      "line_items[0][quantity]": "1",
      ...conciergeLine,
      "subscription_data[trial_period_days]": String(TRIAL_DAYS),
      "subscription_data[metadata][family_id]": family.id,
      "metadata[family_id]": family.id,
      ...(wantsConcierge ? { "metadata[purpose]": "concierge_setup" } : {}),
      allow_promotion_codes: "true",
      success_url: `${SITE}/signup?started=1&who=${encodeURIComponent(parentName)}`,
      cancel_url: `${SITE}/signup?canceled=1`,
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
