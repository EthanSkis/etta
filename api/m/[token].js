// ettacalls.com/m/<token> — "Your plan": the page where a family adds,
// removes and pays for things.
//
// Same reason for existing as /f/ and /b/: Supabase refuses to serve
// text/html from *.supabase.co, and a family should never be looking at a
// database URL. Unlike those two this one also forwards POSTs, because the
// page's forms are how add-ons are bought — the upstream answers with a 303
// back to this same path, or with a Stripe Checkout URL to send them to.

const ADDONS_ENDPOINT =
  "https://kkqgxojxsfqgfpzdyzjv.supabase.co/functions/v1/addons";

function badLink(res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(404).send(
    "<!DOCTYPE html><meta charset=utf-8><title>Etta</title>" +
      "<p style=\"font:16px/1.5 system-ui;padding:24px\">That link isn't active. " +
      "Check the most recent text from Etta for the current one.",
  );
}

// Vercel has already parsed the body by the time we see it; forms arrive as a
// plain object, so they're re-encoded rather than passed through.
function encodeBody(req) {
  if (req.method !== "POST") return undefined;
  const body = req.body;
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  return new URLSearchParams(
    Object.entries(body).map(([k, v]) => [k, Array.isArray(v) ? v[0] : String(v)]),
  ).toString();
}

export default async function handler(req, res) {
  const raw = req.query.token;
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!/^[a-f0-9]{24}$/.test(token ?? "")) return badLink(res);

  try {
    const upstream = await fetch(`${ADDONS_ENDPOINT}/${token}`, {
      method: req.method === "POST" ? "POST" : "GET",
      headers: {
        Accept: "text/html",
        ...(req.method === "POST"
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
      },
      body: encodeBody(req),
      // The upstream 303s back here (or out to Stripe); the browser needs to
      // see that redirect itself, so it isn't followed here.
      redirect: "manual",
    });

    const location = upstream.headers.get("location");
    if (upstream.status >= 300 && upstream.status < 400 && location) {
      res.setHeader("Cache-Control", "private, no-store");
      return res.redirect(303, location);
    }

    const body = await upstream.text();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    return res.status(upstream.status).send(body);
  } catch (err) {
    console.error("addons proxy failed:", err);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(502).send(
      "<!DOCTYPE html><meta charset=utf-8><title>Etta</title>" +
        "<p style=\"font:16px/1.5 system-ui;padding:24px\">Your plan page is " +
        "briefly unavailable, and nothing was changed. Please try again in a moment.",
    );
  }
}
