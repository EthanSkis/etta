// share — a sibling's share of the bill.
//
// Reached at ettacalls.com/split/<invite_token>, a link the account holder
// sends to their brother or sister themselves. We never text an invite to a
// number that hasn't asked to hear from Etta.
//
// Mechanically the simplest thing that is also honest: the contributor holds
// their own small subscription on their own card, and every payment they make
// is credited to the account holder's Stripe customer balance, so it comes
// straight off the next bill (see stripe-webhook → invoice.paid). If a
// contributor stops, nothing breaks — the account holder simply pays full
// price again, and nobody's calls are interrupted by a family's money
// arrangement.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { money } from "../_shared/catalog.ts";
import { stripe } from "../_shared/stripe.ts";
import { esc, masthead, notFound, page, SITE, validToken } from "../_shared/page.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const EXTRA_CSS = `
.big{font-family:var(--serif);font-size:38px;font-weight:600;color:var(--terra-deep);
  letter-spacing:-.02em;line-height:1;margin:6px 0 2px}
.ol{margin:16px 0 0;padding-left:20px;color:var(--ink-soft)}
.ol li{margin:7px 0}
.ol b{color:var(--ink)}
`;

// deno-lint-ignore no-explicit-any
type Row = any;

async function load(token: string): Promise<{ share: Row; family: Row; senior: Row } | null> {
  const { data: share } = await supabase.from("cost_shares")
    .select("*").eq("invite_token", token).maybeSingle();
  if (!share || share.status === "canceled") return null;

  const { data: family } = await supabase.from("families")
    .select("id, primary_contact_name, stripe_customer_id, plan")
    .eq("id", share.family_id).maybeSingle();
  if (!family) return null;

  const { data: senior } = await supabase.from("seniors")
    .select("first_name, preferred_name")
    .eq("family_id", family.id)
    .order("created_at", { ascending: true })
    .limit(1).maybeSingle();

  return { share, family, senior };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.pathname.split("/").filter(Boolean).pop() ?? "";
  if (!validToken(token)) return notFound("Sharing the cost");

  const ctx = await load(token);
  if (!ctx) return notFound("Sharing the cost");

  const { share, family } = ctx;
  const seniorName = ctx.senior?.preferred_name || ctx.senior?.first_name || "their parent";
  const organiser = family.primary_contact_name || "your family";

  if (req.method === "POST") {
    const form = await req.formData().catch(() => null);
    const action = String(form?.get("action") ?? "");

    if (action === "stop" && share.stripe_subscription_id) {
      try {
        await stripe(`subscriptions/${share.stripe_subscription_id}`, undefined, "DELETE");
      } catch (err) {
        console.error("share cancel failed:", err);
      }
      await supabase.from("cost_shares")
        .update({ status: "canceled", canceled_at: new Date().toISOString() })
        .eq("id", share.id);
      return new Response(null, {
        status: 303,
        headers: { Location: `${SITE}/split/${token}?stopped=1` },
      });
    }

    if (action === "start" && share.status !== "active") {
      try {
        // Their own customer record: this is their card and their receipt,
        // not a line on somebody else's account.
        const customer = share.stripe_customer_id
          ? { id: share.stripe_customer_id }
          : await stripe("customers", {
            name: share.name,
            "metadata[cost_share_id]": share.id,
            "metadata[family_id]": family.id,
          });
        if (!share.stripe_customer_id) {
          await supabase.from("cost_shares")
            .update({ stripe_customer_id: customer.id as string }).eq("id", share.id);
        }

        const session = await stripe("checkout/sessions", {
          mode: "subscription",
          customer: customer.id as string,
          "line_items[0][price_data][currency]": "usd",
          "line_items[0][price_data][unit_amount]": String(share.share_cents),
          "line_items[0][price_data][recurring][interval]": "month",
          "line_items[0][price_data][product_data][name]":
            `Etta — a share of ${seniorName}'s check-in calls`,
          "line_items[0][quantity]": "1",
          "subscription_data[metadata][cost_share_id]": share.id,
          "subscription_data[metadata][family_id]": family.id,
          "metadata[cost_share_id]": share.id,
          success_url: `${SITE}/split/${token}?done=1`,
          cancel_url: `${SITE}/split/${token}`,
        });
        return new Response(null, {
          status: 303,
          headers: { Location: session.url as string, "Cache-Control": "no-store" },
        });
      } catch (err) {
        console.error("share checkout failed:", err);
        return new Response(null, {
          status: 303,
          headers: { Location: `${SITE}/split/${token}?err=1` },
        });
      }
    }

    return new Response(null, { status: 303, headers: { Location: `${SITE}/split/${token}` } });
  }

  const params = url.searchParams;
  const active = share.status === "active";
  const stopped = params.get("stopped") === "1";

  if (stopped) {
    return page(
      200,
      `${masthead("Sharing the cost")}<h1>That's stopped.</h1>
<p class="lede">You won't be charged again. ${esc(organiser)} keeps paying for
${esc(seniorName)}'s calls, and nothing about the calls themselves changes.</p>`,
      "Etta — share stopped",
      EXTRA_CSS,
    );
  }

  const body = active
    ? `${masthead("Sharing the cost")}
<h1>You're chipping in ${money(share.share_cents)} a month.</h1>
<p class="lede">Thank you — it comes off ${esc(organiser)}'s bill automatically, so
nobody has to settle up. ${
      share.contributed_cents > 0
        ? `You've contributed ${money(share.contributed_cents)} so far.`
        : ""
    }</p>
<div class="panel"><div class="eyebrow">What you're paying for</div>
<p>Etta calls ${esc(seniorName)} and has a real conversation — how they slept,
whether they've eaten, how their spirits are — then sends the family a short note.
${esc(seniorName)} agreed to the calls themselves, on a recorded call, and can end
them any time by saying so.</p>
<form method="post" data-confirm="Stop contributing?" style="margin-top:16px">
<input type="hidden" name="action" value="stop">
<button class="btn quiet" type="submit">Stop contributing</button></form></div>
<div class="foot">Questions? Reply to Etta's number, or write to
<a href="mailto:hello@ettacalls.com">hello@ettacalls.com</a>.</div>`
    : `${masthead("Sharing the cost")}
<h1>${esc(organiser)} asked if you'd take a share.</h1>
<p class="lede">Etta calls ${esc(seniorName)} and checks in — every call, a short
note to the family about how they're really doing. ${esc(organiser)} set it up and
is paying for it. This is your part, if you want it.</p>
<div class="panel"><div class="eyebrow">Your share</div>
<div class="big">${money(share.share_cents)}<span style="font-size:16px;color:var(--ink-soft)"> / month</span></div>
<p class="lede">Charged to your own card, on your own receipt. It's credited straight
to ${esc(organiser)}'s bill, so their next invoice is lower by exactly this much.</p>
<ol class="ol">
<li><b>Nothing changes for ${esc(seniorName)}.</b> Same calls, same time, same Etta.</li>
<li><b>You can stop any time</b> from this same link. ${esc(organiser)} just goes
back to paying the full amount.</li>
<li><b>You don't get an account.</b> If you'd like the after-call notes too, ask
${esc(organiser)} to add your number — that's their call to make, not ours.</li>
</ol>
<form method="post" style="margin-top:18px">
<input type="hidden" name="action" value="start">
<button class="btn" type="submit">Take a ${money(share.share_cents)} share</button></form>
${
      params.get("err")
        ? `<p class="lede" style="color:var(--terra-deep)">That didn't go through, and
nothing was charged. Please try again in a moment.</p>`
        : ""
    }</div>
<div class="foot"><b>Etta is honest about being an AI</b> — she says so on every
single call, and ${esc(seniorName)} said yes to that, in their own voice, before any
call was made. Read the <a href="${SITE}/pledge">pledge</a>.</div>`;

  return page(
    200,
    body +
      `<script>document.querySelectorAll("form[data-confirm]").forEach(function(f){
f.addEventListener("submit",function(e){if(!window.confirm(f.dataset.confirm))e.preventDefault();});});<\/script>`,
    `Etta — ${active ? "your share" : "share the cost"}`,
    EXTRA_CSS,
  );
});
