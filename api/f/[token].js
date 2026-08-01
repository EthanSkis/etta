// ettacalls.com/f/<token> — the family's check-in page.
//
// The page itself is rendered by the Supabase `fam` edge function, but
// Supabase refuses to serve text/html from *.supabase.co (it rewrites the
// content type to text/plain with nosniff, so browsers show raw source).
// This proxy re-serves the same bytes from our own domain with the right
// header — which also gets the family a link that looks like Etta rather
// than a database URL.
//
// No secrets involved: the share token in the path is the only credential,
// exactly as before.

const FAM_ENDPOINT =
  "https://kkqgxojxsfqgfpzdyzjv.supabase.co/functions/v1/fam";

export default async function handler(req, res) {
  const raw = req.query.token;
  const token = Array.isArray(raw) ? raw[0] : raw;

  // Fail here rather than forwarding junk upstream.
  if (!/^[a-f0-9]{24}$/.test(token ?? "")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(404).send(
      "<!DOCTYPE html><meta charset=utf-8><title>Etta</title>" +
        "<p style=\"font:16px/1.5 system-ui;padding:24px\">That link isn't active. " +
        "Check the most recent text from Etta for the current one.",
    );
  }

  try {
    const upstream = await fetch(`${FAM_ENDPOINT}/${token}`, {
      headers: { Accept: "text/html" },
    });
    const body = await upstream.text();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    return res.status(upstream.status).send(body);
  } catch (err) {
    console.error("fam proxy failed:", err);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(502).send(
      "<!DOCTYPE html><meta charset=utf-8><title>Etta</title>" +
        "<p style=\"font:16px/1.5 system-ui;padding:24px\">Etta's summaries are " +
        "briefly unavailable. Please try again in a moment.",
    );
  }
}
