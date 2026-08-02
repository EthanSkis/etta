// report — the monthly care report.
//
// Reached at ettacalls.com/r/<share_token> (optionally ?m=YYYY-MM), and sent
// as a link on the first of each month to families who have the add-on.
//
// This is the page a daughter prints and takes to her mother's appointment:
// one month of check-ins reduced to what a doctor's twenty minutes can
// actually use — how often she answered, how she slept and ate, where her
// spirits sat, and what came up more than once.
//
// Two rules govern the writing here. It reports, it does not diagnose: every
// number is a count of what was said on a phone call, and the page says so.
// And it never invents: a month with four calls in it says "four calls" and
// declines to draw a trend from them.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { esc, masthead, notFound, page, SITE, validToken } from "../_shared/page.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const MOOD_WORDS: Record<number, string> = {
  1: "a hard day", 2: "a little low", 3: "steady", 4: "good spirits", 5: "bright",
};

// deno-lint-ignore no-explicit-any
type Row = any;

interface Flag {
  type?: string;
  severity?: string;
  detail?: string;
  description?: string;
}

function flagText(f: Flag): string {
  return f.detail ?? f.description ?? f.type ?? "unspecified concern";
}

function isUrgent(f: Flag): boolean {
  return ["high", "urgent"].includes((f.severity ?? "").toLowerCase());
}

const EXTRA_CSS = `
body{max-width:680px}
.rule{border:none;border-top:1.5px solid var(--ink);margin:22px 0 0}
.head-grid{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap}
.month{font-family:var(--serif);font-size:15px;color:var(--ink-soft)}
.figures{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:16px}
.fig{border:1px solid var(--line);border-radius:4px;padding:12px 11px;background:var(--card)}
.fig .n{font-family:var(--serif);font-size:24px;font-weight:600;line-height:1.05}
.fig .k{font-size:10px;letter-spacing:.11em;text-transform:uppercase;color:var(--ink-soft);
  margin-top:5px;display:block}
.fig .was{font-size:11.5px;color:var(--ink-soft);margin-top:4px;display:block}
@media(max-width:560px){.figures{grid-template-columns:repeat(2,1fr)}}
.bars svg{display:block;width:100%;height:auto;overflow:visible}
.item{display:flex;gap:11px;padding:11px 0;border-bottom:1px solid var(--line);font-size:14.5px}
.item:last-child{border-bottom:none}
.item .when{flex:none;width:82px;color:var(--ink-soft);font-size:12.5px;padding-top:2px}
.item .sev{font-size:10px;letter-spacing:.1em;text-transform:uppercase;font-weight:700;
  display:block;margin-bottom:2px}
.item.hi .sev{color:var(--terra-deep)}
.item.lo .sev{color:var(--gold-deep)}
.quote{font-family:var(--serif);font-size:16px;line-height:1.5;padding:9px 0 9px 14px;
  border-left:2px solid var(--gold);margin-top:10px;color:var(--ink)}
.printbar{display:flex;gap:9px;margin-top:20px;flex-wrap:wrap}
@media print{
  @page{margin:16mm}
  body{max-width:none;padding:0;background:#fff}
  .printbar,.foot a,.noprint{display:none!important}
  .panel{box-shadow:none;border-color:#bbb;break-inside:avoid;page-break-inside:avoid}
  .fig{border-color:#bbb}
  a{color:inherit;text-decoration:none}
}
`;

/** YYYY-MM → { start, end } as senior-local ISO dates, end exclusive. */
function monthBounds(ym: string): { start: string; end: string; label: string } {
  const [y, m] = ym.split("-").map((n) => parseInt(n, 10));
  const start = `${ym}-01`;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const end = `${nextY}-${String(nextM).padStart(2, "0")}-01`;
  const label = new Date(`${start}T12:00:00Z`)
    .toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return { start, end, label };
}

function previousMonth(ym: string): string {
  const [y, m] = ym.split("-").map((n) => parseInt(n, 10));
  return m === 1
    ? `${y - 1}-12`
    : `${y}-${String(m - 1).padStart(2, "0")}`;
}

interface Stats {
  answered: number;
  attempted: number;
  minutes: number;
  moodAvg: number | null;
  slept: [number, number];
  ate: [number, number];
  meds: [number, number];
  flags: { flag: Flag; date: string }[];
  highlights: { text: string; date: string }[];
  byDay: Map<string, number>;
}

function summarize(calls: Row[]): Stats {
  const s: Stats = {
    answered: 0, attempted: 0, minutes: 0, moodAvg: null,
    slept: [0, 0], ate: [0, 0], meds: [0, 0], flags: [], highlights: [],
    byDay: new Map(),
  };
  let moodSum = 0, moodN = 0;
  for (const c of calls) {
    const date = c.scheduled_local_date as string;
    // "Calls answered" has to mean check-ins. A minute-long pill reminder
    // counted alongside them would flatter the number the family is most
    // likely to read out loud in a doctor's office.
    const kind = (c.kind as string) ?? "checkin";
    const isCheckin = kind === "checkin" || kind === "evening";
    if (isCheckin && (c.status === "completed" || c.status === "no_answer")) s.attempted++;
    if (c.status !== "completed") continue;
    if (isCheckin) {
      s.answered++;
      s.minutes += Math.round((c.duration_seconds ?? 0) / 60);
    }
    const sum = (Array.isArray(c.summary) ? c.summary[0] : c.summary) as Row;
    if (!sum) continue;
    // Medication is counted wherever it came up, including on the reminder
    // calls that exist precisely to ask it.
    if (typeof sum.meds_taken === "boolean") { s.meds[1]++; if (sum.meds_taken) s.meds[0]++; }
    for (const f of (Array.isArray(sum.flags) ? sum.flags : []) as Flag[]) {
      s.flags.push({ flag: f, date });
    }
    const hl = sum.raw_analysis?.highlights;
    if (Array.isArray(hl)) {
      for (const h of hl.slice(0, 2)) {
        if (typeof h === "string" && h.trim()) s.highlights.push({ text: h.trim(), date });
      }
    }
    if (!isCheckin) continue;
    if (typeof sum.mood_score === "number") {
      moodSum += sum.mood_score;
      moodN++;
      // Two calls in a day (an evening add-on) average into one mark.
      const prev = s.byDay.get(date);
      s.byDay.set(date, prev === undefined ? sum.mood_score : (prev + sum.mood_score) / 2);
    }
    if (typeof sum.slept_well === "boolean") { s.slept[1]++; if (sum.slept_well) s.slept[0]++; }
    if (typeof sum.ate_today === "boolean") { s.ate[1]++; if (sum.ate_today) s.ate[0]++; }
  }
  if (moodN) s.moodAvg = moodSum / moodN;
  return s;
}

function ratio(pair: [number, number]): string {
  return pair[1] ? `${pair[0]}/${pair[1]}` : "—";
}

function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "UTC",
  });
}

/** A dot per day of the month, at the height of that day's spirits. */
function monthChart(ym: string, byDay: Map<string, number>): string {
  const { start, end } = monthBounds(ym);
  const days = Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 864e5,
  );
  const w = 660, left = 8, right = 8;
  const step = (w - left - right) / Math.max(1, days - 1);
  const y = (m: number) => 78 - (m - 1) * 15;

  let grid = "";
  for (const m of [1, 3, 5]) {
    grid += `<line x1="0" y1="${y(m)}" x2="${w}" y2="${y(m)}"
      stroke="rgba(46,32,20,.1)" stroke-width="1"/>`;
    grid += `<text x="${w}" y="${y(m) + 3.5}" text-anchor="end" font-family="Karla,sans-serif"
      font-size="9" fill="rgba(110,91,69,.75)">${MOOD_WORDS[m]}</text>`;
  }

  let marks = "", path = "";
  let prev: { x: number; m: number } | null = null;
  for (let i = 0; i < days; i++) {
    const iso = new Date(Date.parse(`${start}T00:00:00Z`) + i * 864e5)
      .toISOString().slice(0, 10);
    const mood = byDay.get(iso);
    const x = left + i * step;
    if (mood === undefined) { prev = null; continue; }
    const colour = mood >= 3.5 ? "#77875F" : mood >= 2.5 ? "#D9A441" : "#BC5127";
    if (prev) {
      path += `<line x1="${prev.x}" y1="${y(prev.m)}" x2="${x}" y2="${y(mood)}"
        stroke="rgba(46,32,20,.28)" stroke-width="1.2"/>`;
    }
    marks += `<circle cx="${x}" cy="${y(mood)}" r="3.6" fill="${colour}"/>`;
    prev = { x, m: mood };
  }

  let labels = "";
  for (let d = 1; d <= days; d += 7) {
    labels += `<text x="${left + (d - 1) * step}" y="98" text-anchor="middle"
      font-family="Karla,sans-serif" font-size="9" fill="rgba(110,91,69,.85)">${d}</text>`;
  }
  return `<div class="bars"><svg viewBox="0 0 ${w} 104" role="img"
aria-label="Spirits on each day of the month">${grid}${path}${marks}${labels}</svg></div>`;
}

function teaser(token: string, name: string): Response {
  return page(
    200,
    `${masthead("Care report")}
<h1>The monthly care report.</h1>
<p class="lede">One page, once a month: how often ${esc(name)} answered, how they
slept and ate, where their spirits sat, and the things that came up more than once
— printable, and written to be read by someone with twenty minutes and a waiting
room full of people.</p>
<div class="panel"><div class="eyebrow">What's on it</div>
<div class="row"><span class="lbl">Calls answered, and time spent talking</span></div>
<div class="row"><span class="lbl">Spirits across the month, day by day</span></div>
<div class="row"><span class="lbl">Sleep, appetite and medication, counted</span></div>
<div class="row"><span class="lbl">Everything Etta flagged, with the dates</span></div>
<div class="row"><span class="lbl">Compared against the month before</span></div>
<p class="lede" style="margin-top:14px">It's built from the calls you're already
paying for — nothing extra happens to ${esc(name)}, and nothing about the calls changes.</p>
<a class="btn" style="margin-top:16px" href="${SITE}/m/${esc(token)}">Turn it on — $9/month</a>
</div>
<div class="foot">Etta is a check-in companion, not medical care. The report describes
what was said on the phone; it is not a clinical assessment and no part of it is a
diagnosis.</div>`,
    "Etta — monthly care report",
    EXTRA_CSS,
  );
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.pathname.split("/").filter(Boolean).pop() ?? "";
  if (!validToken(token)) return notFound("Care report");

  const { data: seniorRow } = await supabase.from("seniors")
    .select("id, family_id, first_name, preferred_name, timezone, " +
      "family:families!inner(primary_contact_name, subscription_status)")
    .eq("share_token", token).maybeSingle();
  if (!seniorRow) return notFound("Care report");
  const senior = seniorRow as Row;

  const name = senior.preferred_name || senior.first_name;
  const family = senior.family as unknown as {
    primary_contact_name: string;
    subscription_status: string | null;
  };

  // The add-on gate. Comped accounts (pilots, partners) get everything.
  const { data: addon } = await supabase.from("subscription_addons")
    .select("id").eq("family_id", senior.family_id)
    .eq("addon_key", "care_report").eq("status", "active").maybeSingle();
  if (!addon && family.subscription_status !== "comped") return teaser(token, name);

  // Default to last month once we're a few days into the new one — that's the
  // report people actually want on the 1st.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: senior.timezone as string, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const requested = url.searchParams.get("m") ?? "";
  const ym = /^\d{4}-(0[1-9]|1[0-2])$/.test(requested)
    ? requested
    : previousMonth(today.slice(0, 7));

  const { start, end, label } = monthBounds(ym);
  const prevYm = previousMonth(ym);
  const prev = monthBounds(prevYm);

  const { data: calls } = await supabase.from("calls")
    .select("status, scheduled_local_date, duration_seconds, kind, " +
      "summary:call_summaries(summary, mood_score, ate_today, slept_well, meds_taken, " +
      "flags, raw_analysis)")
    .eq("senior_id", senior.id)
    .in("status", ["completed", "no_answer"])
    .gte("scheduled_local_date", prev.start)
    .lt("scheduled_local_date", end)
    .order("scheduled_local_date", { ascending: true });

  const inMonth = (calls ?? []).filter((c: Row) =>
    c.scheduled_local_date >= start && c.scheduled_local_date < end
  );
  const inPrev = (calls ?? []).filter((c: Row) =>
    c.scheduled_local_date >= prev.start && c.scheduled_local_date < prev.end
  );
  const now = summarize(inMonth);
  const before = summarize(inPrev);

  const wasChip = (a: string) => `<span class="was">was ${a}</span>`;
  const moodDelta = now.moodAvg !== null && before.moodAvg !== null
    ? now.moodAvg - before.moodAvg
    : null;

  // One paragraph, in plain English, that says what the numbers add up to.
  let verdict: string;
  if (now.answered === 0) {
    verdict = `Etta didn't complete any calls with ${name} in ${label}.` +
      (now.attempted > 0
        ? ` ${now.attempted} were attempted and went unanswered.`
        : " No calls were scheduled.");
  } else if (now.answered < 4) {
    verdict = `${name} spoke with Etta ${now.answered} time${
      now.answered === 1 ? "" : "s"
    } in ${label} — too few calls to read a month from, so the notes below are ` +
      `individual observations rather than a pattern.`;
  } else if (moodDelta !== null && moodDelta <= -0.5) {
    verdict = `${name}'s spirits were lower in ${label} than the month before ` +
      `(${now.moodAvg!.toFixed(1)} against ${before.moodAvg!.toFixed(1)} out of 5). ` +
      `That is the kind of drift that is hard to see from visits, and worth ` +
      `mentioning at the next appointment alongside anything flagged below.`;
  } else if (moodDelta !== null && moodDelta >= 0.5) {
    verdict = `${name}'s spirits were better in ${label} than the month before ` +
      `(${now.moodAvg!.toFixed(1)} against ${before.moodAvg!.toFixed(1)} out of 5), ` +
      `and they answered ${now.answered} of ${now.attempted} calls.`;
  } else if (now.flags.filter((f) => isUrgent(f.flag)).length > 0) {
    verdict = `A steady month for ${name} overall, with ${
      now.flags.filter((f) => isUrgent(f.flag)).length
    } thing${
      now.flags.filter((f) => isUrgent(f.flag)).length === 1 ? "" : "s"
    } Etta thought worth flagging — they're listed below with the dates they came up.`;
  } else {
    verdict = `A steady month for ${name}: ${now.answered} of ${now.attempted} calls ` +
      `answered, spirits averaging ${now.moodAvg?.toFixed(1) ?? "—"} out of 5, and ` +
      `nothing that needed anyone's urgent attention.`;
  }

  const urgentFlags = now.flags.filter((f) => isUrgent(f.flag));
  const watchFlags = now.flags.filter((f) => !isUrgent(f.flag));
  const flagList = (list: { flag: Flag; date: string }[], cls: string) =>
    list.map((f) =>
      `<div class="item ${cls}"><span class="when">${shortDate(f.date)}</span>
<div><span class="sev">${esc(f.flag.type ?? "note")}</span>${esc(flagText(f.flag))}</div></div>`
    ).join("");

  const body = `${masthead("Care report")}
<div class="head-grid"><div><h1>${esc(name)}</h1>
<div class="month">Check-in report — ${esc(label)}</div></div>
<div class="month">Prepared for ${esc(family.primary_contact_name ?? "the family")}</div></div>
<hr class="rule">
<p class="lede" style="margin-top:16px;font-size:16px;color:var(--ink)">${esc(verdict)}</p>

<div class="figures">
<div class="fig"><span class="n">${now.answered}<span style="font-size:14px;color:var(--ink-soft)">/${now.attempted}</span></span>
<span class="k">Calls answered</span>${
    before.attempted ? wasChip(`${before.answered}/${before.attempted}`) : ""
  }</div>
<div class="fig"><span class="n">${now.moodAvg !== null ? now.moodAvg.toFixed(1) : "—"}</span>
<span class="k">Spirits, of 5</span>${
    before.moodAvg !== null ? wasChip(before.moodAvg.toFixed(1)) : ""
  }</div>
<div class="fig"><span class="n">${ratio(now.slept)}</span>
<span class="k">Slept well</span>${before.slept[1] ? wasChip(ratio(before.slept)) : ""}</div>
<div class="fig"><span class="n">${ratio(now.ate)}</span>
<span class="k">Had eaten</span>${before.ate[1] ? wasChip(ratio(before.ate)) : ""}</div>
</div>

${
    now.byDay.size >= 3
      ? `<div class="panel"><div class="eyebrow">Spirits, day by day</div>${
        monthChart(ym, now.byDay)
      }</div>`
      : ""
  }

${
    now.meds[1] > 0
      ? `<div class="panel"><div class="eyebrow">Medication</div>
<div class="row"><span class="lbl">Said they'd taken them</span>
<span class="val">${now.meds[0]} of the ${now.meds[1]} calls it came up on</span></div>
<p class="lede" style="margin-top:10px">Etta asks casually, once, and takes the answer
at face value. This is what ${esc(name)} said — not a record of what was taken.</p></div>`
      : ""
  }

${
    urgentFlags.length
      ? `<div class="panel"><div class="eyebrow">Worth raising</div>${
        flagList(urgentFlags, "hi")
      }</div>`
      : ""
  }
${
    watchFlags.length
      ? `<div class="panel"><div class="eyebrow">Mentioned in passing</div>${
        flagList(watchFlags, "lo")
      }</div>`
      : ""
  }
${
    now.highlights.length
      ? `<div class="panel"><div class="eyebrow">From the calls themselves</div>${
        now.highlights.slice(0, 6).map((h) =>
          `<div class="quote">${esc(h.text)}<div style="font-size:12px;color:var(--ink-soft);
font-family:var(--sans);margin-top:4px">${shortDate(h.date)}</div></div>`
        ).join("")
      }</div>`
      : ""
  }

<div class="panel"><div class="eyebrow">How this was made</div>
<p>Etta called ${esc(name)} on their own phone, told them at the start of every call
that she is an AI, and had an ordinary conversation. ${
    now.answered > 0
      ? `Those ${now.answered} check-ins came to about ${now.minutes} minutes in ${
        esc(label)
      }.`
      : ""
  } The numbers on this page are counts of what ${esc(name)} said — nothing is
inferred from a device, and nothing here is a clinical measurement.</p></div>

<div class="printbar">
<button class="btn" type="button" onclick="window.print()">Print or save as PDF</button>
<a class="btn ghost" href="?m=${esc(prevYm)}">${esc(monthBounds(prevYm).label)}</a>
<a class="btn ghost" href="${SITE}/f/${esc(token)}">Back to check-ins</a></div>

<div class="foot"><b>Not medical advice, and not a diagnosis.</b> Etta is a check-in
companion. This report describes phone conversations and is intended to help a family
and a clinician ask better questions — not to answer them. In an emergency, call 911.
<br><br>Private to your family: anyone with this link can read it.</div>`;

  return page(200, body, `Etta — ${name}, ${label}`, EXTRA_CSS);
});
