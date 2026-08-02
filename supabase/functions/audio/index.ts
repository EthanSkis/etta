// audio — streams a call recording to the family, but only when the senior
// said it could be.
//
// GET /functions/v1/audio/<share_token>/<call_id>
//
// Three gates, all required: the token must resolve to a senior, the call must
// belong to that senior, and that call's recording_shared must be true. The
// default is false, so a bug here fails silent rather than exposing audio.
//
// Vapi's stored recording URLs are private (unsigned R2). Vapi will mint a
// short-lived presigned URL on request, so we ask for one and redirect the
// browser to it rather than proxying several megabytes through the function.
//
// Two later additions:
//   - A purged call is gone. After the retention window the sweep drops the
//     audio (see retention-sweep), and this endpoint refuses it even if the
//     provider still happens to hold a copy.
//   - ?download=1 saves the file instead of streaming it, for families with
//     the call-archive add-on. That one is proxied, because a download needs
//     our own Content-Disposition rather than a redirect to storage.

import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function deny(status: number, why: string): Response {
  return new Response(why, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req) => {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const callId = parts.pop() ?? "";
  const token = parts.pop() ?? "";
  if (!/^[a-f0-9]{24}$/.test(token)) return deny(404, "not found");
  if (!/^[0-9a-f-]{36}$/.test(callId)) return deny(404, "not found");

  const { data: senior } = await supabase.from("seniors")
    .select("id, family_id").eq("share_token", token).maybeSingle();
  if (!senior) return deny(404, "not found");

  const { data: call } = await supabase.from("calls")
    .select("id, provider_call_id, recording_shared, recording_purged_at, scheduled_local_date")
    .eq("id", callId).eq("senior_id", senior.id).maybeSingle();
  if (!call) return deny(404, "not found");
  if (!call.recording_shared) return deny(403, "not shared");
  if (call.recording_purged_at) return deny(410, "recording no longer kept");
  if (!call.provider_call_id) return deny(404, "no recording");

  // Downloading a copy is the archive add-on's job; listening is included.
  const wantsDownload = new URL(req.url).searchParams.get("download") === "1";
  if (wantsDownload) {
    const { data: archive } = await supabase.from("subscription_addons")
      .select("id").eq("family_id", senior.family_id)
      .eq("addon_key", "recording_archive").eq("status", "active").maybeSingle();
    if (!archive) return deny(402, "the call archive add-on is needed to download");
  }

  const key = Deno.env.get("VAPI_API_KEY");
  if (!key) return deny(503, "unavailable");

  const res = await fetch(
    `https://api.vapi.ai/call/${call.provider_call_id}/artifacts`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) {
    console.error("vapi artifacts failed:", res.status, await res.text());
    return deny(502, "unavailable");
  }
  const body = await res.json();
  const artifact = body.artifact ?? body;
  const url = artifact.presignedMonoUrl ?? artifact.presignedStereoUrl;
  if (!url) return deny(404, "no recording");

  if (!wantsDownload) {
    return new Response(null, {
      status: 302,
      headers: { Location: url, "Cache-Control": "private, no-store" },
    });
  }

  const audio = await fetch(url);
  if (!audio.ok || !audio.body) return deny(502, "unavailable");
  return new Response(audio.body, {
    status: 200,
    headers: {
      "Content-Type": audio.headers.get("content-type") ?? "audio/wav",
      "Content-Disposition":
        `attachment; filename="etta-call-${call.scheduled_local_date ?? "recording"}.wav"`,
      "Cache-Control": "private, no-store",
    },
  });
});
