// stripe-webhook — keeps subscription state in sync, and enforces the
// promise that nobody pays for calls their parent never agreed to.
//
// Handled events:
//   checkout.session.completed      → link customer + subscription to family
//   customer.subscription.*         → sync status/plan/dates; canceled stops calls
//   customer.subscription.trial_will_end → if the senior still hasn't consented,
//                                     cancel before the first charge
//   invoice.payment_failed          → recorded; calls continue through past_due
//
// Signature is verified manually (HMAC-SHA256 over "timestamp.body") so the
// function stays dependency-free.

import { createClient } from "jsr:@supabase/supabase-js@2";

const TOLERANCE_SECONDS = 300;
const PRICE_PLANS: Record<string, string> = {
  price_1TzO26A8l4yd6OUzIGnqRkhB: "standard",
  price_1TzO27A8l4yd6OUzhi1l2T3b: "daily",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function verifySignature(
  payload: string,
  header: string,
  secret: string,
): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=", 2) as [string, string]),
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  // Constant-time compare.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

async function stripe(path: string, body?: Record<string, string>): Promise<unknown> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${(Deno.env.get("STRIPE_SECRET_KEY") ?? "").trim()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body ? new URLSearchParams(body) : undefined,
  });
  if (!res.ok) console.error("stripe api error:", path, res.status, await res.text());
  return res.json();
}

async function sendText(to: string[], body: string) {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER") ?? "+17622394275";
  if (!sid || !token) return;
  for (const number of to) {
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${sid}:${token}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: from, To: number, Body: body }),
    });
  }
}

// deno-lint-ignore no-explicit-any
async function familyForSubscription(sub: any) {
  const metaId = sub?.metadata?.family_id;
  if (metaId) {
    const { data } = await supabase.from("families").select("*").eq("id", metaId).maybeSingle();
    if (data) return data;
  }
  if (sub?.customer) {
    const { data } = await supabase.from("families").select("*")
      .eq("stripe_customer_id", sub.customer).maybeSingle();
    if (data) return data;
  }
  return null;
}

// deno-lint-ignore no-explicit-any
async function syncSubscription(sub: any) {
  const family = await familyForSubscription(sub);
  if (!family) {
    console.error("no family for subscription", sub?.id);
    return;
  }
  const priceId = sub?.items?.data?.[0]?.price?.id ?? "";
  const patch: Record<string, unknown> = {
    stripe_subscription_id: sub.id,
    stripe_customer_id: sub.customer ?? family.stripe_customer_id,
    subscription_status: sub.status,
    trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    current_period_end: sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null,
  };
  if (PRICE_PLANS[priceId]) patch.plan = PRICE_PLANS[priceId];
  await supabase.from("families").update(patch).eq("id", family.id);

  // Subscription over: stop the calls, but never touch consent history.
  if (["canceled", "unpaid", "incomplete_expired"].includes(sub.status)) {
    const { data: seniors } = await supabase.from("seniors")
      .select("id").eq("family_id", family.id);
    for (const s of seniors ?? []) {
      await supabase.from("call_schedules").update({ active: false }).eq("senior_id", s.id);
      await supabase.from("calls")
        .update({ status: "canceled", ended_reason: "subscription_ended" })
        .eq("senior_id", s.id).eq("status", "scheduled");
    }
  }
  return family;
}

Deno.serve(async (req) => {
  const secret = (Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "").trim();
  const sig = req.headers.get("stripe-signature");
  const payload = await req.text();
  if (!secret || !sig || !(await verifySignature(payload, sig, secret))) {
    return json({ error: "invalid signature" }, 400);
  }

  // deno-lint-ignore no-explicit-any
  let event: any;
  try {
    event = JSON.parse(payload);
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const object = event.data?.object ?? {};
  let familyId: string | null = object?.metadata?.family_id ?? null;

  switch (event.type) {
    case "checkout.session.completed": {
      if (object.subscription && familyId) {
        await supabase.from("families").update({
          stripe_customer_id: object.customer,
          stripe_subscription_id: object.subscription,
        }).eq("id", familyId);
        const sub = await stripe(`subscriptions/${object.subscription}`);
        await syncSubscription(sub);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed": {
      const family = await syncSubscription(object);
      familyId = family?.id ?? familyId;
      break;
    }
    case "customer.subscription.trial_will_end": {
      // The promise: no charge unless the senior actually said yes.
      const family = await familyForSubscription(object);
      familyId = family?.id ?? familyId;
      if (family) {
        const { data: active } = await supabase.from("seniors")
          .select("id").eq("family_id", family.id).eq("status", "active").limit(1);
        if (!active || active.length === 0) {
          await fetch(`https://api.stripe.com/v1/subscriptions/${object.id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${(Deno.env.get("STRIPE_SECRET_KEY") ?? "").trim()}` },
          });
          if (family.primary_contact_phone) {
            await sendText([family.primary_contact_phone],
              `Etta here — your trial is ending and we never got a yes from your ` +
              `parent, so I've canceled the subscription. You haven't been charged ` +
              `a cent. Whenever they're ready, sign up again at ettacalls.com. — Etta`);
          }
        }
      }
      break;
    }
    case "invoice.payment_failed": {
      if (object.customer) {
        const { data: family } = await supabase.from("families").select("id, primary_contact_phone")
          .eq("stripe_customer_id", object.customer).maybeSingle();
        familyId = family?.id ?? familyId;
        if (family?.primary_contact_phone) {
          await sendText([family.primary_contact_phone],
            `Etta here — your card didn't go through, so I wanted to let you know ` +
            `before anything lapses. The calls continue for now; you can update ` +
            `your card from the "Manage billing" link on your family page. — Etta`);
        }
      }
      break;
    }
  }

  await supabase.from("billing_events").insert({
    family_id: familyId,
    stripe_event_id: event.id,
    type: event.type,
    detail: { id: object.id, status: object.status ?? null },
  });

  return json({ received: true });
});
