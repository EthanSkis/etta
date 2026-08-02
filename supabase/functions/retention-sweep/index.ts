// retention-sweep — forgetting the audio on purpose.
//
// Cron, once a day. The written note is the product; the recording is a
// courtesy, and hours of an old person's private conversation is not
// something to keep by default. So audio is deleted after 30 days — at the
// provider as well as here, not merely hidden — unless the family holds the
// call-archive add-on, which extends it to a year.
//
// What is never deleted: the summary, the flags, the consent log. A family's
// record of how their parent has been doing survives; the recording of them
// saying it does not.
//
// Auth: the X-Etta-Cron-Secret header must match CRON_SECRET, same as
// place-due-calls.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { RETENTION_DAYS } from "../_shared/catalog.ts";

const BATCH = 400;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// deno-lint-ignore no-explicit-any
type Row = any;

/**
 * Ask the voice provider to drop its copy. Best effort by design: if this
 * fails we still forget our pointer, and the family-facing audio endpoint
 * refuses purged calls regardless — so a provider outage can't leave audio
 * reachable through Etta.
 */
async function deleteAtProvider(providerCallId: string): Promise<boolean> {
  const key = Deno.env.get("VAPI_API_KEY");
  if (!key) return false;
  const res = await fetch(`https://api.vapi.ai/call/${providerCallId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok && res.status !== 404) {
    console.error("vapi delete failed:", providerCallId, res.status, await res.text());
    return false;
  }
  return true;
}

Deno.serve(async (req) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret || req.headers.get("x-etta-cron-secret") !== cronSecret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Families paying to keep their audio longer.
  const { data: archives } = await supabase.from("subscription_addons")
    .select("family_id").eq("addon_key", "recording_archive").eq("status", "active");
  const archived = new Set((archives ?? []).map((a: Row) => a.family_id as string));

  const shortCutoff = new Date(Date.now() - RETENTION_DAYS.standard * 864e5).toISOString();
  const { data: calls, error } = await supabase.from("calls")
    .select("id, provider_call_id, created_at, senior:seniors!inner(family_id)")
    .is("recording_purged_at", null)
    .not("provider_call_id", "is", null)
    .lt("created_at", shortCutoff)
    .order("created_at", { ascending: true })
    .limit(BATCH);
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const report = { considered: (calls ?? []).length, purged: 0, kept: 0, providerFailures: 0 };

  for (const call of (calls ?? []) as Row[]) {
    const familyId = call.senior?.family_id as string;
    const days = archived.has(familyId) ? RETENTION_DAYS.archived : RETENTION_DAYS.standard;
    const ageDays = (Date.now() - new Date(call.created_at as string).getTime()) / 864e5;
    if (ageDays < days) {
      report.kept++;
      continue;
    }
    const gone = await deleteAtProvider(call.provider_call_id as string);
    if (!gone) report.providerFailures++;
    await supabase.from("calls").update({
      recording_url: null,
      recording_shared: false,
      recording_purged_at: new Date().toISOString(),
    }).eq("id", call.id);
    report.purged++;
  }

  return new Response(JSON.stringify(report), {
    headers: { "Content-Type": "application/json" },
  });
});
