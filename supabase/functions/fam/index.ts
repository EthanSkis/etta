// fam — the family's no-login web view ("the link is the login").
//
// Every summary text ends with /functions/v1/fam/<share_token>. The token is
// a per-senior capability: long, random, rotatable (see the share_token
// migration). The page is server-rendered from the database, so the product
// tables stay service-role only; this function is the single, deliberately
// narrow public window: first names, the last 14 days, nothing else.

import { createClient } from "jsr:@supabase/supabase-js@2";

const DAYS = 14;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const MOOD_WORDS: Record<number, string> = {
  1: "a hard day", 2: "a little low", 3: "steady", 4: "good spirits", 5: "bright",
};

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

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Mood → brand color. Red is reserved for "needs attention".
function moodColor(mood: number | null, urgent: boolean): string {
  if (urgent) return "#BC5127";           // terra — attention
  if (mood === null) return "transparent";
  if (mood >= 4) return "#77875F";        // sage — good
  if (mood === 3) return "#D9A441";       // gold — steady
  return "#BC5127";                       // terra — low
}

function html(status: number, body: string, title = "Etta"): Response {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Karla:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--paper:#F8F1E5;--ink:#2E2014;--ink-soft:#6E5B45;--terra:#BC5127;--sage:#77875F;
--gold:#D9A441;--card:#FFFDF7;--line:rgba(46,32,20,.16)}
*{box-sizing:border-box;margin:0}
body{background:var(--paper);color:var(--ink);font:16px/1.55 "Karla",sans-serif;
padding:20px 16px 48px;max-width:560px;margin:0 auto}
h1,h2,h3{font-family:"Fraunces",Georgia,serif;font-weight:500;line-height:1.2}
.logo{font-family:"Fraunces",Georgia,serif;font-size:26px;font-weight:600}
.logo span{color:var(--terra)}
header{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px}
h1{font-size:26px;margin:14px 0 2px}
.sub{color:var(--ink-soft);font-size:14px;margin-bottom:18px}
.banner{background:#F6E3D8;border:1px solid var(--terra);border-radius:12px;
padding:12px 14px;font-size:15px;margin-bottom:18px}
.strip{background:var(--card);border:1px solid var(--line);border-radius:16px;
padding:14px 12px 10px;margin-bottom:18px}
.strip-title{font-size:12px;letter-spacing:.08em;text-transform:uppercase;
color:var(--ink-soft);margin:0 4px 10px}
.dots{display:flex;justify-content:space-between;gap:2px}
.day{display:flex;flex-direction:column;align-items:center;gap:5px;flex:1;min-width:0}
.dot{width:17px;height:17px;border-radius:50%;border:2px solid var(--line)}
.dot.filled{border-color:transparent}
.dot.missed{border-style:dashed;border-color:var(--terra)}
.dow{font-size:10px;color:var(--ink-soft)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;
padding:16px;margin-bottom:12px}
.card.latest{border-width:2px;border-color:rgba(46,32,20,.3)}
.when{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--ink-soft);
margin-bottom:8px}
.when b{color:var(--ink);font-size:15px}
.mood-pill{display:inline-block;width:11px;height:11px;border-radius:50%}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 2px}
.chip{background:var(--paper);border:1px solid var(--line);border-radius:999px;
padding:3px 10px;font-size:13px}
.chip.warn{background:#F6E3D8;border-color:var(--terra);color:#7A3417}
.flags{margin-top:10px;font-size:14px}
.flags li{margin:4px 0 4px 18px}
.flags .urgent{color:#7A3417;font-weight:600}
.summary{font-size:15px;margin-top:6px}
details{margin-bottom:10px}
details summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;
background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px;
font-size:14px}
details summary::-webkit-details-marker{display:none}
details[open] summary{border-radius:12px 12px 0 0}
details .card{border-radius:0 0 12px 12px;border-top:none;margin-top:0}
.spacer{flex:1}
.mins{color:var(--ink-soft);font-size:12px}
footer{margin-top:26px;color:var(--ink-soft);font-size:12.5px;line-height:1.6}
footer b{color:var(--ink)}
</style></head><body>${body}</body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}

function notFound(): Response {
  return html(
    404,
    `<header><div class="logo">etta<span>.</span></div></header>
<h1>This link isn't active.</h1>
<p class="sub">It may have been rotated for privacy. Check the most recent
text from Etta for the current link, or reply to Etta's number and we'll help.</p>`,
    "Etta — link not active",
  );
}

Deno.serve(async (req) => {
  const token = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  if (!/^[a-f0-9]{24}$/.test(token)) return notFound();

  const { data: senior } = await supabase.from("seniors")
    .select("id, first_name, preferred_name, status, timezone")
    .eq("share_token", token).maybeSingle();
  if (!senior) return notFound();

  const name = senior.preferred_name || senior.first_name;

  // Last 14 senior-local days of call activity, newest first.
  const since = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);
  const { data: calls } = await supabase.from("calls")
    .select(
      "id, status, scheduled_local_date, attempt_number, duration_seconds, " +
        "summary:call_summaries(summary, mood_score, ate_today, slept_well, meds_taken, flags)",
    )
    .eq("senior_id", senior.id)
    .in("status", ["completed", "no_answer"])
    .gte("scheduled_local_date", since)
    .order("scheduled_local_date", { ascending: false })
    .order("attempt_number", { ascending: false });

  // Collapse attempts into one record per local day: a completed call wins;
  // a day of only no-answers is "missed"; no rows = no call scheduled.
  interface Day {
    date: string;
    completed: boolean;
    missed: boolean;
    minutes: number;
    mood: number | null;
    urgent: boolean;
    chips: string[];
    flags: Flag[];
    summary: string | null;
  }
  const byDate = new Map<string, Day>();
  for (const c of calls ?? []) {
    const date = c.scheduled_local_date as string;
    const cur = byDate.get(date) ?? {
      date, completed: false, missed: false, minutes: 0,
      mood: null, urgent: false, chips: [], flags: [], summary: null,
    };
    if (c.status === "completed" && !cur.completed) {
      const s = (Array.isArray(c.summary) ? c.summary[0] : c.summary) as
        | { summary: string; mood_score: number | null; ate_today: boolean | null;
            slept_well: boolean | null; meds_taken: boolean | null; flags: Flag[] }
        | null;
      cur.completed = true;
      cur.missed = false;
      cur.minutes = Math.max(1, Math.round((c.duration_seconds ?? 60) / 60));
      if (s) {
        cur.summary = s.summary;
        cur.mood = s.mood_score;
        cur.flags = Array.isArray(s.flags) ? s.flags : [];
        cur.urgent = cur.flags.some(isUrgent);
        if (typeof s.slept_well === "boolean") {
          cur.chips.push(`😴 slept ${s.slept_well ? "well" : "poorly"}`);
        }
        if (typeof s.ate_today === "boolean") {
          cur.chips.push(`🍽️ ${s.ate_today ? "ate" : "not eaten yet"}`);
        }
        if (typeof s.meds_taken === "boolean") {
          cur.chips.push(`💊 ${s.meds_taken ? "taken" : "not taken"}`);
        }
      }
    } else if (c.status === "no_answer" && !cur.completed) {
      cur.missed = true;
    }
    byDate.set(date, cur);
  }

  // The 14-day dot strip, oldest → newest, senior-local dates.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: senior.timezone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const dowFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: senior.timezone, weekday: "narrow",
  });
  let strip = "";
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    const date = fmt.format(d);
    const day = byDate.get(date);
    let dotStyle = "";
    let dotClass = "dot";
    if (day?.completed) {
      dotClass += " filled";
      dotStyle = `background:${moodColor(day.mood, day.urgent)}`;
      if (day.mood === null && !day.urgent) dotStyle = "background:#B9AD9C";
    } else if (day?.missed) {
      dotClass += " missed";
    }
    strip += `<div class="day"><div class="${dotClass}" style="${dotStyle}"></div>` +
      `<div class="dow">${dowFmt.format(d)}</div></div>`;
  }

  const days = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
  const prettyDate = (iso: string) =>
    new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric",
    });

  function dayCard(day: Day, latest: boolean): string {
    if (!day.completed) {
      return `<div class="card${latest ? " latest" : ""}">
<div class="when"><span class="mood-pill" style="border:2px dashed var(--terra)"></span>
<b>${prettyDate(day.date)}</b></div>
<div class="summary">No conversation this day — Etta's calls went unanswered.
The contact chain was notified.</div></div>`;
    }
    const urgentFlags = day.flags.filter(isUrgent);
    const watchFlags = day.flags.filter((f) => !isUrgent(f));
    return `<div class="card${latest ? " latest" : ""}">
<div class="when"><span class="mood-pill" style="background:${moodColor(day.mood, day.urgent)}"></span>
<b>${prettyDate(day.date)}</b>
${day.mood ? `· ${MOOD_WORDS[day.mood]}` : ""}<span class="spacer"></span>
<span class="mins">${day.minutes} min</span></div>
${day.chips.length ? `<div class="chips">${day.chips.map((c) => `<span class="chip">${esc(c)}</span>`).join("")}${day.mood ? `<span class="chip">Mood ${day.mood}/5</span>` : ""}</div>` : ""}
<div class="summary">${esc(day.summary ?? "")}</div>
${urgentFlags.length ? `<ul class="flags">${urgentFlags.map((f) => `<li class="urgent">${esc(flagText(f))}</li>`).join("")}</ul>` : ""}
${watchFlags.length ? `<ul class="flags">${watchFlags.map((f) => `<li>${esc(flagText(f))}</li>`).join("")}</ul>` : ""}
</div>`;
  }

  const latest = days[0];
  const earlier = days.slice(1);
  const statusBanner = senior.status === "active" ? "" :
    `<div class="banner">${
      senior.status === "revoked"
        ? `${esc(name)} asked Etta to stop calling, and Etta honored it immediately. No calls are being placed. Starting again just takes a fresh yes from ${esc(name)}.`
        : `Calls are currently paused.`
    }</div>`;

  const body = `<header><div class="logo">etta<span>.</span></div></header>
<h1>${esc(name)}'s check-ins</h1>
<p class="sub">A daily call, honestly AI, always with ${esc(name)}'s consent — and this is what it hears.</p>
${statusBanner}
<div class="strip"><div class="strip-title">Last ${DAYS} days</div><div class="dots">${strip}</div></div>
${latest ? dayCard(latest, true) : `<div class="card"><div class="summary">No calls yet — the first check-in will appear here.</div></div>`}
${earlier.length ? `<h2 style="font-size:18px;margin:18px 0 10px">Earlier</h2>` : ""}
${earlier.map((day) => `<details><summary><span class="mood-pill" style="${
    day.completed
      ? `background:${moodColor(day.mood, day.urgent)}`
      : "border:2px dashed var(--terra)"
  }"></span>${prettyDate(day.date)}${day.completed && day.mood ? ` — ${MOOD_WORDS[day.mood]}` : day.completed ? "" : " — no answer"}<span class="spacer"></span>▾</summary>${dayCard(day, false)}</details>`).join("")}
<footer><b>Private to your family.</b> Anyone with this exact link can view this page —
that's what makes it work without logins or apps. Keep it in the family; to get a
fresh link (and retire this one), reply to Etta's number.<br><br>
Etta is a check-in companion, not medical care or an emergency service. If something
feels urgent, call ${esc(name)} — or 911 — first.</footer>`;

  return html(200, body, `Etta — ${name}'s check-ins`);
});
