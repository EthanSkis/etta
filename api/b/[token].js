// ettacalls.com/b/<token> — "Manage billing" from the family page.
//
// Forwards to the Supabase `billing` function, which mints a Stripe Customer
// Portal session for that family and 302s to it. Kept on our own domain for
// the same two reasons as /f/: Supabase won't serve text/html from its shared
// domain (its error pages would render as raw source), and a family should
// never see a database URL.

const BILLING_ENDPOINT =
  "https://kkqgxojxsfqgfpzdyzjv.supabase.co/functions/v1/billing";

export default async function handler(req, res) {
  const raw = req.query.token;
  const token = Array.isArray(raw) ? raw[0] : raw;

  if (!/^[a-f0-9]{24}$/.test(token ?? "")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(404).send(
      "<!DOCTYPE html><meta charset=utf-8><title>Etta</title>" +
        "<p style=\"font:16px/1.5 system-ui;padding:24px\">That link isn't active.",
    );
  }

  try {
    // Don't follow the redirect here — hand the portal URL to the browser so
    // Stripe sees a real navigation.
    const upstream = await fetch(`${BILLING_ENDPOINT}/${token}`, {
      redirect: "manual",
    });
    const location = upstream.headers.get("location");
    if (upstream.status >= 300 && upstream.status < 400 && location) {
      res.setHeader("Cache-Control", "private, no-store");
      return res.redirect(302, location);
    }
    const body = await upstream.text();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(upstream.status).send(body);
  } catch (err) {
    console.error("billing proxy failed:", err);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(502).send(
      "<!DOCTYPE html><meta charset=utf-8><title>Etta</title>" +
        "<p style=\"font:16px/1.5 system-ui;padding:24px\">Billing is briefly " +
        "unavailable. Please try again in a moment.",
    );
  }
}
