// care-reports — the monthly report goes out.
//
// Cron, once a day, early. It only acts on the first of the month in the
// senior's own timezone, so a family in Honolulu gets theirs on their first,
// not on New York's. One text per senior per month, with a link to the
// printable report (see the `report` function).
//
// Idempotence comes from billing_events: a send is recorded there with the
// senior and the month, and a second run that day finds it and stops.
//
// Auth: X-Etta-Cron-Secret, same as the other cron endpoints.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendText } from "../_shared/sms.ts";

const REPORT_LINK_BASE = Deno.env.get("REPORT_LINK_BASE") ?? "https://www.ettacalls.com/r";
const SENT_TYPE = "etta.care_report_sent";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// deno-lint-ignore no-explicit-any
type Row = any;

function localParts(timeZone: string): { date: string; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    day: parseInt(get("day"), 10),
    hour: parseInt(get("hour"), 10),
  };
}

/** The month that just ended, as YYYY-MM, given today's YYYY-MM-DD. */
function lastMonth(date: string): { ym: string; label: string } {
  const y = parseInt(date.slice(0, 4), 10);
  const m = parseInt(date.slice(5, 7), 10);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const ym = `${py}-${String(pm).padStart(2, "0")}`;
  const label = new Date(`${ym}-01T12:00:00Z`)
    .toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  return { ym, label };
}

async function familyPhones(familyId: string): Promise<string[]> {
  const { data: family } = await supabase.from("families")
    .select("primary_contact_phone").eq("id", familyId).maybeSingle();
  const { data: members } = await supabase.from("family_members")
    .select("phone").eq("family_id", familyId)
    .eq("receives_summaries", true).not("phone", "is", null);

  const phones = (members ?? []).map((m: Row) => m.phone as string);
  const primary = family?.primary_contact_phone as string | null;
  if (primary && !phones.includes(primary)) phones.unshift(primary);
  return phones;
}

Deno.serve(async (req) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret || req.headers.get("x-etta-cron-secret") !== cronSecret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: addons } = await supabase.from("subscription_addons")
    .select("family_id").eq("addon_key", "care_report").eq("status", "active");
  const familyIds = [...new Set((addons ?? []).map((a: Row) => a.family_id as string))];

  const report = { families: familyIds.length, sent: 0, skipped: 0, notDue: 0 };
  if (familyIds.length === 0) {
    return new Response(JSON.stringify(report), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: seniors } = await supabase.from("seniors")
    .select("id, family_id, first_name, preferred_name, timezone, share_token, status")
    .in("family_id", familyIds)
    .eq("status", "active");

  for (const senior of (seniors ?? []) as Row[]) {
    const local = localParts(senior.timezone as string);
    // The first of the month, at a civilised hour — nobody wants a report at
    // 00:10, and the cron runs often enough that any morning hour will do.
    if (local.day !== 1 || local.hour < 8 || local.hour > 11) {
      report.notDue++;
      continue;
    }
    const { ym, label } = lastMonth(local.date);

    const { data: already } = await supabase.from("billing_events")
      .select("id").eq("type", SENT_TYPE)
      .contains("detail", { senior_id: senior.id, month: ym })
      .limit(1).maybeSingle();
    if (already) {
      report.skipped++;
      continue;
    }

    // Nothing to report on is worse than no text at all.
    const { count } = await supabase.from("calls")
      .select("id", { count: "exact", head: true })
      .eq("senior_id", senior.id).eq("status", "completed")
      .gte("scheduled_local_date", `${ym}-01`)
      .lt("scheduled_local_date", local.date);
    if (!count) {
      report.skipped++;
      continue;
    }

    const name = senior.preferred_name || senior.first_name;
    const sent = await sendText(
      await familyPhones(senior.family_id as string),
      `${name}'s ${label} report is ready — the month in one page: how many calls ` +
        `were answered, sleep, appetite, spirits, and anything that came up more ` +
        `than once. Printable, if there's a doctor's appointment coming.\n` +
        `${REPORT_LINK_BASE}/${senior.share_token}?m=${ym}\n— Etta\n` +
        `Reply STOP to end texts.`,
    );

    await supabase.from("billing_events").insert({
      family_id: senior.family_id,
      type: SENT_TYPE,
      detail: { senior_id: senior.id, month: ym, delivered: sent },
    });
    report.sent++;
  }

  return new Response(JSON.stringify(report), {
    headers: { "Content-Type": "application/json" },
  });
});
