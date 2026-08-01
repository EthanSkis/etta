// billing — "Manage billing" from the family page.
//
// Same capability model as the family view: /functions/v1/billing/<share_token>
// redirects to a Stripe Customer Portal session for that senior's family, where
// they can change card, switch plan, or cancel. No login, nothing to install.
// The token only ever resolves to that one family's portal.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SITE = "https://www.ettacalls.com";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function message(status: number, title: string, detail: string): Response {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow"><title>Etta</title>
<style>body{background:#F8F1E5;color:#2E2014;font:16px/1.6 system-ui,sans-serif;
max-width:34em;margin:0 auto;padding:48px 20px}h1{font-size:22px}</style></head>
<body><h1>${title}</h1><p>${detail}</p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

Deno.serve(async (req) => {
  const token = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  if (!/^[a-f0-9]{24}$/.test(token)) {
    return message(404, "This link isn't active.",
      "Check the most recent text from Etta for the current link.");
  }

  const { data: senior } = await supabase.from("seniors")
    .select("family_id, family:families!inner(stripe_customer_id)")
    .eq("share_token", token).maybeSingle();
  if (!senior) {
    return message(404, "This link isn't active.",
      "Check the most recent text from Etta for the current link.");
  }

  const customerId =
    (senior.family as unknown as { stripe_customer_id: string | null }).stripe_customer_id;
  if (!customerId) {
    return message(200, "No billing on file yet.",
      "This family doesn't have a subscription set up. Reply to Etta's number and we'll help.");
  }

  const res = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${(Deno.env.get("STRIPE_SECRET_KEY") ?? "").trim()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      customer: customerId,
      return_url: `${SITE}/`,
    }),
  });
  const session = await res.json();
  if (!res.ok || !session.url) {
    console.error("portal session failed:", res.status, JSON.stringify(session).slice(0, 300));
    return message(502, "Billing is temporarily unavailable.",
      "Please try again in a moment, or text Etta's number and we'll sort it out.");
  }

  return Response.redirect(session.url as string, 303);
});
