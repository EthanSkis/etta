// ettacalls.com/r/<token> — the monthly care report, the page a family
// prints and takes to the appointment.
//
// Read-only, and the ?m=YYYY-MM query picks the month, so the query string is
// forwarded along with the token.

const REPORT_ENDPOINT =
  "https://kkqgxojxsfqgfpzdyzjv.supabase.co/functions/v1/report";

function badLink(res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(404).send(
    "<!DOCTYPE html><meta charset=utf-8><title>Etta</title>" +
      "<p style=\"font:16px/1.5 system-ui;padding:24px\">That link isn't active. " +
      "Check the most recent text from Etta for the current one.",
  );
}

export default async function handler(req, res) {
  const raw = req.query.token;
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!/^[a-f0-9]{24}$/.test(token ?? "")) return badLink(res);

  try {
    const month = Array.isArray(req.query.m) ? req.query.m[0] : req.query.m;
    const qs = /^\d{4}-\d{2}$/.test(month ?? "") ? `?m=${month}` : "";
    const upstream = await fetch(`${REPORT_ENDPOINT}/${token}${qs}`, {
      headers: { Accept: "text/html" },
    });
    const body = await upstream.text();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    return res.status(upstream.status).send(body);
  } catch (err) {
    console.error("report proxy failed:", err);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(502).send(
      "<!DOCTYPE html><meta charset=utf-8><title>Etta</title>" +
        "<p style=\"font:16px/1.5 system-ui;padding:24px\">The care report is " +
        "briefly unavailable. Please try again in a moment.",
    );
  }
}
