// ettacalls.com/a/<token>/<call> — audio for one call, if it was shared.
//
// Thin pass-through to the Supabase `audio` function, which does the real
// checking and answers with a redirect to a short-lived presigned URL. Kept
// on our domain so the <audio> element in the family page has a same-origin
// source and the family never sees infrastructure URLs.

const AUDIO_ENDPOINT =
  "https://kkqgxojxsfqgfpzdyzjv.supabase.co/functions/v1/audio";

export default async function handler(req, res) {
  const t = req.query.token, c = req.query.call;
  const token = Array.isArray(t) ? t[0] : t;
  const call = Array.isArray(c) ? c[0] : c;

  if (!/^[a-f0-9]{24}$/.test(token ?? "") || !/^[0-9a-f-]{36}$/.test(call ?? "")) {
    return res.status(404).send("not found");
  }

  try {
    const upstream = await fetch(`${AUDIO_ENDPOINT}/${token}/${call}`, {
      redirect: "manual",
    });
    const location = upstream.headers.get("location");
    if (upstream.status >= 300 && upstream.status < 400 && location) {
      res.setHeader("Cache-Control", "private, no-store");
      return res.redirect(302, location);
    }
    return res.status(upstream.status).send(await upstream.text());
  } catch (err) {
    console.error("audio proxy failed:", err);
    return res.status(502).send("unavailable");
  }
}
