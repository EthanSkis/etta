// stripe-webhook — keeps subscription state in sync, and enforces the
// promise that nobody pays for calls their parent never agreed to.
//
// Handled events:
//   checkout.session.completed      → link customer + subscription to family;
//                                     also occasion calls, concierge setup,
//                                     and a sibling starting their share
//   customer.subscription.*         → sync status/plan/dates; canceled stops calls
//   customer.subscription.trial_will_end → if the senior still hasn't consented,
//                                     cancel before the first charge
//   invoice.paid                    → a contributor's payment becomes credit on
//                                     the account holder's next bill
//   invoice.payment_failed          → recorded; calls continue through past_due
//
// Signature is verified manually (HMAC-SHA256 over "timestamp.body") so the
// function stays dependency-free.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { money, PLANS, planLookupKey, planPriceId } from "../_shared/catalog.ts";
import { creditCustomer, stripe } from "../_shared/stripe.ts";
import { sendText } from "../_shared/sms.ts";

const TOLERANCE_SECONDS = 300;

/**
 * Which plan a Stripe price belongs to. Matched by ID when the price came
 * from a secret, and by lookup key when the code created it on first sale —
 * otherwise a plan bootstrapped that way would never sync back.
 */
// deno-lint-ignore no-explicit-any
function planForPrice(price: any): string | null {
  const id = price?.id ?? "";
  const lookup = price?.lookup_key ?? "";
  for (const plan of Object.values(PLANS)) {
    if (id && planPriceId(plan) === id) return plan.key;
    if (lookup && planLookupKey(plan) === lookup) return plan.key;
  }
  return null;
}

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

/**
 * A sibling's contribution subscription, kept entirely separate from the
 * family's own. It carries cost_share_id in its metadata; without this guard
 * it would look like just another subscription for the same family and
 * overwrite the real one.
 */
// deno-lint-ignore no-explicit-any
async function syncCostShare(sub: any): Promise<boolean> {
  const shareId = sub?.metadata?.cost_share_id;
  if (!shareId) return false;

  const dead = ["canceled", "unpaid", "incomplete_expired"].includes(sub.status);
  await supabase.from("cost_shares").update({
    stripe_subscription_id: sub.id,
    status: dead ? "canceled" : "active",
    ...(dead ? { canceled_at: new Date().toISOString() } : {}),
  }).eq("id", shareId);
  return true;
}

// deno-lint-ignore no-explicit-any
async function syncSubscription(sub: any) {
  if (await syncCostShare(sub)) return null;
  const family = await familyForSubscription(sub);
  if (!family) {
    console.error("no family for subscription", sub?.id);
    return;
  }
  // The plan is whichever line item carries a plan price — with add-ons on
  // the subscription, it is no longer safe to assume that's items.data[0].
  // deno-lint-ignore no-explicit-any
  const planKey = (sub?.items?.data ?? [])
    .map((i: any) => planForPrice(i?.price))
    .find((k: string | null) => !!k) ?? null;
  const patch: Record<string, unknown> = {
    stripe_subscription_id: sub.id,
    stripe_customer_id: sub.customer ?? family.stripe_customer_id,
    subscription_status: sub.status,
    trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    current_period_end: sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null,
  };
  if (planKey) patch.plan = planKey;
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

/** White-glove setup is paid for: record it, and tell them what happens next. */
async function markConciergeBooked(familyId: string) {
  await supabase.from("families")
    .update({ concierge_purchased_at: new Date().toISOString() })
    .eq("id", familyId);
  const { data: fam } = await supabase.from("families")
    .select("primary_contact_phone").eq("id", familyId).maybeSingle();
  if (fam?.primary_contact_phone) {
    await sendText([fam.primary_contact_phone],
      `Etta here — concierge setup is booked. A person from Etta will call you ` +
      `within one business day to walk you through it, and can stay on the line ` +
      `for your parent's setup call if you'd like. — Etta`);
  }
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
      // A sibling just started their share of someone's bill.
      const shareId = object?.metadata?.cost_share_id;
      if (shareId) {
        await supabase.from("cost_shares").update({
          status: "active",
          stripe_customer_id: object.customer,
          stripe_subscription_id: object.subscription,
        }).eq("id", shareId);
        break;
      }

      // A paid one-off: an occasion call, or concierge setup.
      const occasionId = object?.metadata?.occasion_id;
      if (occasionId && object.payment_status === "paid") {
        await supabase.from("occasion_calls").update({
          status: "scheduled",
          paid_at: new Date().toISOString(),
          stripe_payment_intent: object.payment_intent ?? null,
        }).eq("id", occasionId);
        break;
      }
      // Concierge bought on its own, from the manage page.
      if (object?.metadata?.purpose === "concierge_setup" && familyId && !object.subscription) {
        await markConciergeBooked(familyId);
        break;
      }

      if (object.subscription && familyId) {
        await supabase.from("families").update({
          stripe_customer_id: object.customer,
          stripe_subscription_id: object.subscription,
        }).eq("id", familyId);
        const sub = await stripe(`subscriptions/${object.subscription}`);
        await syncSubscription(sub);
        // Concierge chosen at signup rides along on the same checkout, as a
        // one-time line billed with the first real invoice.
        if (object?.metadata?.purpose === "concierge_setup") {
          await markConciergeBooked(familyId);
        }
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
          await stripe(`subscriptions/${object.id}`, undefined, "DELETE");
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
    case "invoice.paid":
    case "invoice.payment_succeeded": {
      // Only contributor invoices do anything here: their money becomes a
      // credit on the account holder's Stripe balance, so it comes straight
      // off the next bill rather than being settled between siblings.
      const subId = object.subscription ??
        object.parent?.subscription_details?.subscription ?? null;
      const paid = Number(object.amount_paid ?? 0);
      if (!subId || paid <= 0) break;

      const { data: share } = await supabase.from("cost_shares")
        .select("*").eq("stripe_subscription_id", subId).maybeSingle();
      if (!share) break;

      familyId = share.family_id;
      const { data: family } = await supabase.from("families")
        .select("id, stripe_customer_id, primary_contact_phone")
        .eq("id", share.family_id).maybeSingle();

      if (family?.stripe_customer_id) {
        try {
          await creditCustomer(
            family.stripe_customer_id,
            paid,
            `${share.name}'s share of Etta`,
          );
        } catch (err) {
          console.error("cost share credit failed:", share.id, err);
          break;
        }
      }

      const first = share.status !== "active" || share.contributed_cents === 0;
      await supabase.from("cost_shares").update({
        status: "active",
        contributed_cents: (share.contributed_cents ?? 0) + paid,
        last_paid_at: new Date().toISOString(),
      }).eq("id", share.id);

      if (first && family?.primary_contact_phone) {
        await sendText([family.primary_contact_phone],
          `Etta here — ${share.name} just picked up ${money(paid)} a month of ` +
          `Etta's calls. It's credited to your account, so your next bill is ` +
          `lower by exactly that much. — Etta`);
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
