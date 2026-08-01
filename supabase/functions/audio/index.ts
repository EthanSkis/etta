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
    .select("id").eq("share_token", token).maybeSingle();
  if (!senior) return deny(404, "not found");

  const { data: call } = await supabase.from("calls")
    .select("id, provider_call_id, recording_shared")
    .eq("id", callId).eq("senior_id", senior.id).maybeSingle();
  if (!call) return deny(404, "not found");
  if (!call.recording_shared) return deny(403, "not shared");
  if (!call.provider_call_id) return deny(404, "no recording");

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

  return new Response(null, {
    status: 302,
    headers: { Location: url, "Cache-Control": "private, no-store" },
  });
});
