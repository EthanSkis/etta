// fam — the family's no-login web view ("the link is the login").
//
// Reached at ettacalls.com/f/<share_token>, which proxies here: Supabase
// rewrites text/html to text/plain on *.supabase.co, so this page is only
// ever served to families through our own domain.
//
// The token is a per-senior capability: long, random, rotatable. The page is
// server-rendered from the database, so the product tables stay service-role
// only; this function is the single, deliberately narrow public window:
// first names, the last 14 days, nothing else.

import { createClient } from "jsr:@supabase/supabase-js@2";

const DAYS = 14;
const SITE = "https://www.ettacalls.com";

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

// The summary model sometimes emphasises a title or a phrase with markdown.
// Escape first, then render the emphasis, so *The Hunger Games* reads as a
// title rather than as stray punctuation.
function prose(s: string): string {
  return esc(s)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/g, "$1<em>$2</em>");
}

// Mood → brand colour. Terracotta is reserved for low days and attention, so
// it keeps meaning something when it appears.
function moodColor(mood: number | null, urgent: boolean): string {
  if (urgent) return "#BC5127";
  if (mood === null) return "#B9AD9C";
  if (mood >= 4) return "#77875F";
  if (mood === 3) return "#D9A441";
  return "#BC5127";
}

// One stroke weight, one corner style, drawn to sit on the text baseline.
const ICONS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
<symbol id="i-moon" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></symbol>
<symbol id="i-meal" viewBox="0 0 24 24"><path d="M4 4v6a3 3 0 0 0 3 3v7M7 4v5M10 4v5M20 4c-1.7 1.2-2.5 3-2.5 5.5S18.3 13 20 13v7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-pill" viewBox="0 0 24 24"><rect x="2.8" y="8.6" width="18.4" height="7.6" rx="3.8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 8.8v6.6" stroke="currentColor" stroke-width="1.6"/></symbol>
<symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 4.5 21 19H3l9-14.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 10v4M12 16.6v.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></symbol>
<symbol id="i-watch" viewBox="0 0 24 24"><path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.6"/></symbol>
<symbol id="i-play" viewBox="0 0 24 24"><path d="M7 4.5 20 12 7 19.5V4.5Z" fill="currentColor"/></symbol>
<symbol id="i-pause" viewBox="0 0 24 24"><path d="M7 4.5h3.6v15H7zM13.4 4.5H17v15h-3.6z" fill="currentColor"/></symbol>
<symbol id="i-lock" viewBox="0 0 24 24"><rect x="4.5" y="10.5" width="15" height="9.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="1.6"/></symbol>
<symbol id="i-phone-off" viewBox="0 0 24 24"><path d="M4.5 5.2c-.6 6.6 7.7 14.9 14.3 14.3l1.4-3-4-1.8-1.9 1.9a15 15 0 0 1-6.9-6.9l1.9-1.9L7.5 3.8 4.5 5.2Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M3 3l18 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></symbol>
</svg>`;

function html(status: number, body: string, title = "Etta"): Response {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#F8F1E5">
<title>${esc(title)}</title>
<link rel="icon" href="${SITE}/favicon.ico" sizes="any">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Karla:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --paper:#F8F1E5; --paper-deep:#F0E5D0; --ink:#2E2014; --ink-soft:#6E5B45;
  --terra:#BC5127; --terra-deep:#8E3A18; --sage:#77875F; --gold:#D9A441;
  --card:#FFFDF7; --line:rgba(46,32,20,.14); --line-firm:rgba(46,32,20,.26);
  --serif:"Fraunces",Georgia,serif; --sans:"Karla",system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0}
body{
  background:var(--paper); color:var(--ink);
  font:16px/1.6 var(--sans); -webkit-font-smoothing:antialiased;
  max-width:600px; margin:0 auto; padding:26px 18px 56px; position:relative;
}
/* Faint paper grain — depth without decoration competing with the data. */
body::before{
  content:""; position:fixed; inset:0; pointer-events:none; z-index:0; opacity:.5;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.045'/%3E%3C/svg%3E");
}
body>*{position:relative;z-index:1}
h1,h2,h3{font-family:var(--serif);font-weight:500;line-height:1.15}

/* ---------- masthead ---------- */
.mast{display:flex;align-items:baseline;justify-content:space-between;
  padding-bottom:12px;border-bottom:1.5px solid var(--ink);margin-bottom:20px}
.logo{font-family:var(--serif);font-size:23px;font-weight:600;letter-spacing:-.01em;
  color:var(--ink);text-decoration:none}
.logo span{color:var(--terra)}
.mast .kick{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-soft)}
h1{font-size:31px;letter-spacing:-.015em;margin-bottom:5px}
.sub{color:var(--ink-soft);font-size:14.5px;max-width:34em}

.banner{display:flex;gap:11px;background:#F6E3D8;border:1px solid var(--terra);
  border-radius:3px;padding:13px 15px;font-size:14.5px;margin-top:18px}
.banner svg{width:19px;height:19px;flex:none;color:var(--terra-deep);margin-top:1px}

/* ---------- panels ---------- */
.panel{background:var(--card);border:1px solid var(--line);border-radius:4px;
  padding:18px;margin-top:16px;box-shadow:0 1px 0 rgba(46,32,20,.05),0 8px 22px -18px rgba(46,32,20,.5);
  animation:rise .5s cubic-bezier(.2,.7,.3,1) both}
.panel.accent{border-left:3px solid var(--ink)}
@keyframes rise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}
.eyebrow{display:flex;align-items:center;gap:9px;font-size:10.5px;letter-spacing:.16em;
  text-transform:uppercase;color:var(--ink-soft);margin-bottom:14px}
.eyebrow::after{content:"";flex:1;height:1px;background:var(--line)}
.panel-date{font-family:var(--serif);font-size:19px;font-weight:500}
.panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:2px}
.mins{font-size:12px;color:var(--ink-soft);white-space:nowrap;font-variant-numeric:tabular-nums}

/* ---------- mood meter ---------- */
.meter{margin:14px 0 4px}
.meter svg{display:block;width:100%;height:auto}
.meter-ends{display:flex;justify-content:space-between;font-size:11px;
  color:var(--ink-soft);margin-top:2px}
.meter-word{font-family:var(--serif);font-size:17px;font-weight:500;margin-bottom:9px}
.meter-word b{font-weight:600}

/* ---------- data tiles ---------- */
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:16px}
.tile{border:1px solid var(--line);border-radius:3px;padding:11px 10px;background:var(--paper);
  display:flex;flex-direction:column;gap:5px;min-width:0}
.tile svg{width:19px;height:19px;color:var(--ink-soft)}
.tile .v{font-family:var(--serif);font-size:15.5px;font-weight:500;line-height:1.15}
.tile .k{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft)}
.tile.neg{background:#F9EDE6;border-color:rgba(188,81,39,.4)}
.tile.neg svg,.tile.neg .v{color:var(--terra-deep)}

/* ---------- prose ---------- */
.prose{font-size:15.5px;line-height:1.65;margin-top:16px}
.prose::first-line{letter-spacing:.005em}

/* ---------- flags ---------- */
.note{display:flex;gap:11px;border:1px solid var(--line);border-left-width:3px;
  border-radius:3px;padding:12px 13px;margin-top:10px;font-size:14.5px;line-height:1.55}
.note svg{width:18px;height:18px;flex:none;margin-top:2px}
.note .lab{display:block;font-size:10px;letter-spacing:.14em;text-transform:uppercase;
  margin-bottom:3px;font-weight:700}
.note.urgent{background:#F9EDE6;border-color:rgba(188,81,39,.45);border-left-color:var(--terra)}
.note.urgent svg,.note.urgent .lab{color:var(--terra-deep)}
.note.watch{background:var(--paper);border-left-color:var(--gold)}
.note.watch svg,.note.watch .lab{color:#96701D}
.note-group{margin-top:18px}
.note-group .eyebrow{margin-bottom:8px}
.note-group .note:first-of-type{margin-top:0}

/* ---------- audio ---------- */
.audio{display:flex;align-items:center;gap:12px;margin-top:16px;padding:11px 13px;
  border:1px solid var(--line);border-radius:3px;background:var(--paper)}
.audio.quiet{color:var(--ink-soft);font-size:13.5px;line-height:1.45}
.audio.quiet svg{width:18px;height:18px;flex:none;opacity:.7}
.play{width:38px;height:38px;flex:none;border-radius:50%;border:none;cursor:pointer;
  background:var(--ink);color:var(--card);display:grid;place-items:center;padding:0}
.play svg{width:15px;height:15px}
.play .ic-pause{display:none}
.audio.playing .play .ic-play{display:none}
.audio.playing .play .ic-pause{display:block}
.track{flex:1;min-width:0}
.track-bar{height:4px;border-radius:2px;background:rgba(46,32,20,.16);overflow:hidden;cursor:pointer}
.track-fill{height:100%;width:0;background:var(--terra);border-radius:2px}
.track-meta{display:flex;justify-content:space-between;font-size:11.5px;color:var(--ink-soft);
  margin-top:5px;font-variant-numeric:tabular-nums}
.track-meta b{font-weight:600;letter-spacing:.1em;text-transform:uppercase;font-size:10px}

/* ---------- 14-day chart ---------- */
.chart svg{display:block;width:100%;height:auto;overflow:visible}
.legend{display:flex;gap:15px;flex-wrap:wrap;font-size:11.5px;color:var(--ink-soft);margin-top:11px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:-1px}

/* ---------- earlier ---------- */
h2.section{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-soft);
  font-family:var(--sans);font-weight:700;margin:30px 0 4px}
details{border-bottom:1px solid var(--line)}
details summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:10px;
  padding:13px 2px;font-size:15px}
details summary::-webkit-details-marker{display:none}
details summary .chev{margin-left:auto;color:var(--ink-soft);font-size:12px;transition:transform .2s}
details[open] summary .chev{transform:rotate(180deg)}
details .panel{margin:0 0 14px;box-shadow:none;animation:none}
.pip{width:10px;height:10px;border-radius:50%;flex:none}
.pip.miss{background:none;border:1.5px dashed var(--terra)}
.when-word{color:var(--ink-soft);font-size:13.5px}

/* ---------- footer ---------- */
.manage{display:inline-flex;align-items:center;gap:7px;margin-top:24px;
  font-size:14px;color:var(--ink);text-decoration:none;
  border:1px solid var(--line-firm);border-radius:3px;padding:10px 16px;background:var(--card)}
.manage:hover{background:var(--paper-deep)}
.foot{margin-top:26px;padding-top:18px;border-top:1px solid var(--line);
  color:var(--ink-soft);font-size:12.5px;line-height:1.65}
.foot b{color:var(--ink)}
.center{text-align:center}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>${ICONS}${body}<script>
(function () {
  "use strict";
  var mmss = function (n) {
    if (!isFinite(n)) return "--:--";
    var m = Math.floor(n / 60), s = Math.floor(n % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  };
  document.querySelectorAll("[data-audio]").forEach(function (box) {
    var audio = box.querySelector("audio");
    var btn = box.querySelector(".play");
    var bar = box.querySelector(".track-bar");
    var fill = box.querySelector(".track-fill");
    var time = box.querySelector(".t");

    btn.addEventListener("click", function () {
      if (audio.paused) {
        // One at a time: two of Mum's calls playing over each other is nobody's idea of clarity.
        document.querySelectorAll("[data-audio] audio").forEach(function (other) {
          if (other !== audio) { other.pause(); }
        });
        audio.play();
      } else {
        audio.pause();
      }
    });
    audio.addEventListener("play", function () { box.classList.add("playing"); });
    audio.addEventListener("pause", function () { box.classList.remove("playing"); });
    audio.addEventListener("ended", function () {
      box.classList.remove("playing");
      fill.style.width = "0%";
    });
    audio.addEventListener("loadedmetadata", function () {
      time.textContent = mmss(audio.duration);
    });
    audio.addEventListener("timeupdate", function () {
      if (!audio.duration) return;
      fill.style.width = (audio.currentTime / audio.duration * 100) + "%";
      time.textContent = mmss(audio.duration - audio.currentTime);
    });
    audio.addEventListener("error", function () {
      box.classList.add("quiet");
      box.innerHTML = "<div>That recording isn\'t available right now.</div>";
    });
    bar.addEventListener("click", function (e) {
      if (!audio.duration) return;
      var r = bar.getBoundingClientRect();
      audio.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * audio.duration;
    });
  });
})();
</script></body></html>`,
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
    `<div class="mast"><a class="logo" href="${SITE}">etta<span>.</span></a></div>
<h1>This link isn't active.</h1>
<p class="sub">It may have been rotated for privacy. Check the most recent
text from Etta for the current link, or reply to Etta's number and we'll help.</p>`,
    "Etta — link not active",
  );
}

// The mood meter: a measured scale rather than a progress bar, so a 2 reads as
// a position on a range and not as "20% complete".
function moodMeter(mood: number, urgent: boolean): string {
  const colour = moodColor(mood, urgent);
  const x = 10 + (mood - 1) * 70;
  let ticks = "";
  for (let i = 0; i < 5; i++) {
    const tx = 10 + i * 70;
    ticks += `<line x1="${tx}" y1="26" x2="${tx}" y2="32" stroke="rgba(46,32,20,.28)" stroke-width="1"/>`;
  }
  return `<div class="meter">
<svg viewBox="0 0 300 42" role="img" aria-label="Mood ${mood} out of 5 — ${MOOD_WORDS[mood]}">
  <line x1="10" y1="20" x2="290" y2="20" stroke="rgba(46,32,20,.16)" stroke-width="5" stroke-linecap="round"/>
  <line x1="10" y1="20" x2="${x}" y2="20" stroke="${colour}" stroke-width="5" stroke-linecap="round"/>
  ${ticks}
  <circle cx="${x}" cy="20" r="11" fill="${colour}"/>
  <circle cx="${x}" cy="20" r="11" fill="none" stroke="#FFFDF7" stroke-width="2.5"/>
  <text x="${x}" y="24.5" text-anchor="middle" font-family="Karla,sans-serif"
        font-size="11.5" font-weight="700" fill="#FFFDF7">${mood}</text>
</svg>
<div class="meter-ends"><span>a hard day</span><span>bright</span></div>
</div>`;
}

// Fourteen days of mood as an actual chart: height is the rating, so a slide
// downward is visible at a glance — which is the whole reason for daily calls.
interface ChartPoint {
  x: number; mood: number | null; missed: boolean; completed: boolean; letter: string;
}
function moodChart(points: ChartPoint[]): string {
  const y = (m: number) => 74 - (m - 1) * 14;
  let grid = "";
  for (const m of [1, 3, 5]) {
    grid += `<line x1="6" y1="${y(m)}" x2="314" y2="${y(m)}" stroke="rgba(46,32,20,.09)" stroke-width="1"/>`;
  }
  let path = "";
  let prev: ChartPoint | null = null;
  for (const p of points) {
    if (p.mood !== null) {
      if (prev && prev.mood !== null) {
        path += `<line x1="${prev.x}" y1="${y(prev.mood)}" x2="${p.x}" y2="${y(p.mood)}"
          stroke="rgba(46,32,20,.3)" stroke-width="1.5" stroke-linecap="round"/>`;
      }
      prev = p;
    } else if (p.completed || p.missed) {
      prev = null;
    }
  }
  let marks = "";
  for (const p of points) {
    if (p.mood !== null) {
      marks += `<circle cx="${p.x}" cy="${y(p.mood)}" r="5" fill="${moodColor(p.mood, false)}"
        stroke="#FFFDF7" stroke-width="1.5"/>`;
    } else if (p.missed) {
      marks += `<circle cx="${p.x}" cy="86" r="4.5" fill="none" stroke="#BC5127"
        stroke-width="1.5" stroke-dasharray="2.6 2.2"/>`;
    } else if (p.completed) {
      marks += `<circle cx="${p.x}" cy="86" r="4" fill="#B9AD9C"/>`;
    }
  }
  let letters = "";
  for (const p of points) {
    letters += `<text x="${p.x}" y="103" text-anchor="middle" font-family="Karla,sans-serif"
      font-size="9.5" fill="rgba(110,91,69,.85)">${p.letter}</text>`;
  }
  return `<div class="chart">
<svg viewBox="0 0 320 108" role="img" aria-label="Mood over the last ${DAYS} days">
  ${grid}${path}${marks}${letters}
</svg></div>
<div class="legend">
  <span><i style="background:#77875F"></i>good</span>
  <span><i style="background:#D9A441"></i>steady</span>
  <span><i style="background:#BC5127"></i>low</span>
  <span><i style="border:1.5px dashed #BC5127"></i>no answer</span>
</div>`;
}

Deno.serve(async (req) => {
  const token = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  if (!/^[a-f0-9]{24}$/.test(token)) return notFound();

  const { data: senior } = await supabase.from("seniors")
    .select("id, first_name, preferred_name, status, timezone")
    .eq("share_token", token).maybeSingle();
  if (!senior) return notFound();

  const name = senior.preferred_name || senior.first_name;

  const since = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);
  const { data: calls } = await supabase.from("calls")
    .select(
      "id, status, scheduled_local_date, attempt_number, duration_seconds, recording_shared, " +
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
    id: string | null;
    recordingShared: boolean;
    date: string;
    completed: boolean;
    missed: boolean;
    minutes: number;
    mood: number | null;
    urgent: boolean;
    slept: boolean | null;
    ate: boolean | null;
    meds: boolean | null;
    flags: Flag[];
    summary: string | null;
  }
  const byDate = new Map<string, Day>();
  for (const c of calls ?? []) {
    const date = c.scheduled_local_date as string;
    const cur = byDate.get(date) ?? {
      id: null, recordingShared: false,
      date, completed: false, missed: false, minutes: 0, mood: null, urgent: false,
      slept: null, ate: null, meds: null, flags: [], summary: null,
    };
    if (c.status === "completed" && !cur.completed) {
      const s = (Array.isArray(c.summary) ? c.summary[0] : c.summary) as
        | { summary: string; mood_score: number | null; ate_today: boolean | null;
            slept_well: boolean | null; meds_taken: boolean | null; flags: Flag[] }
        | null;
      cur.completed = true;
      cur.missed = false;
      cur.id = c.id as string;
      cur.recordingShared = c.recording_shared === true;
      cur.minutes = Math.max(1, Math.round((c.duration_seconds ?? 60) / 60));
      if (s) {
        cur.summary = s.summary;
        cur.mood = s.mood_score;
        cur.flags = Array.isArray(s.flags) ? s.flags : [];
        cur.urgent = cur.flags.some(isUrgent);
        cur.slept = typeof s.slept_well === "boolean" ? s.slept_well : null;
        cur.ate = typeof s.ate_today === "boolean" ? s.ate_today : null;
        cur.meds = typeof s.meds_taken === "boolean" ? s.meds_taken : null;
      }
    } else if (c.status === "no_answer" && !cur.completed) {
      cur.missed = true;
    }
    byDate.set(date, cur);
  }

  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: senior.timezone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const dowFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: senior.timezone, weekday: "narrow",
  });
  const points: ChartPoint[] = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    const day = byDate.get(fmt.format(d));
    points.push({
      x: 14 + (DAYS - 1 - i) * (292 / (DAYS - 1)),
      mood: day?.completed ? day.mood : null,
      missed: !!day?.missed,
      completed: !!day?.completed,
      letter: dowFmt.format(d),
    });
  }

  const days = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
  const prettyDate = (iso: string) =>
    new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric",
    });

  function tiles(day: Day): string {
    const t: string[] = [];
    if (day.slept !== null) {
      t.push(`<div class="tile${day.slept ? "" : " neg"}"><svg><use href="#i-moon"/></svg>
        <span class="v">${day.slept ? "Slept well" : "Slept poorly"}</span>
        <span class="k">Sleep</span></div>`);
    }
    if (day.ate !== null) {
      t.push(`<div class="tile${day.ate ? "" : " neg"}"><svg><use href="#i-meal"/></svg>
        <span class="v">${day.ate ? "Has eaten" : "Not yet"}</span>
        <span class="k">Meals</span></div>`);
    }
    if (day.meds !== null) {
      t.push(`<div class="tile${day.meds ? "" : " neg"}"><svg><use href="#i-pill"/></svg>
        <span class="v">${day.meds ? "Taken" : "Not taken"}</span>
        <span class="k">Medication</span></div>`);
    }
    return t.length ? `<div class="tiles">${t.join("")}</div>` : "";
  }

  // Audio appears in both states on purpose: a family that never sees the
  // player wonders whether it exists, while one that sees it greyed out with
  // a plain sentence understands the arrangement immediately.
  function player(day: Day): string {
    if (!day.recordingShared || !day.id) {
      return `<div class="audio quiet"><svg><use href="#i-lock"/></svg>
<div>${esc(name)} chose not to share the call audio — you'll always get the note.</div></div>`;
    }
    return `<div class="audio" data-audio>
<button class="play" type="button" aria-label="Play the recording">
<svg class="ic-play"><use href="#i-play"/></svg><svg class="ic-pause"><use href="#i-pause"/></svg></button>
<div class="track">
  <div class="track-bar"><div class="track-fill"></div></div>
  <div class="track-meta"><b>Listen to the call</b><span class="t">--:--</span></div>
</div>
<audio preload="none" src="${SITE}/a/${token}/${day.id}"></audio></div>`;
  }

  function notes(day: Day): string {
    const group = (list: Flag[], urgent: boolean) => {
      if (!list.length) return "";
      const heading = urgent ? "Needs your attention" : "Keeping an eye on";
      const items = list.map((f) =>
        `<div class="note ${urgent ? "urgent" : "watch"}">
<svg><use href="#${urgent ? "i-alert" : "i-watch"}"/></svg>
<div>${f.type ? `<span class="lab">${esc(f.type)}</span>` : ""}${prose(flagText(f))}</div></div>`
      ).join("");
      return `<div class="note-group"><div class="eyebrow">${heading}</div>${items}</div>`;
    };
    return group(day.flags.filter(isUrgent), true) +
      group(day.flags.filter((f) => !isUrgent(f)), false);
  }

  function dayPanel(day: Day, latest: boolean): string {
    if (!day.completed) {
      return `<div class="panel${latest ? " accent" : ""}">
${latest ? `<div class="eyebrow">Most recent</div>` : ""}
<div class="panel-head"><span class="panel-date">${prettyDate(day.date)}</span></div>
<div class="note urgent" style="margin-top:12px"><svg><use href="#i-phone-off"/></svg>
<div><span class="lab">No answer</span>Etta tried and couldn't reach ${esc(name)} that day.
The contact chain was notified.</div></div></div>`;
    }
    return `<div class="panel${latest ? " accent" : ""}">
${latest ? `<div class="eyebrow">Most recent check-in</div>` : ""}
<div class="panel-head"><span class="panel-date">${prettyDate(day.date)}</span>
<span class="mins">${day.minutes} min call</span></div>
${
      day.mood
        ? `<div class="meter-word">Overall, <b>${MOOD_WORDS[day.mood]}</b></div>${moodMeter(day.mood, day.urgent)}`
        : ""
    }
${tiles(day)}
<p class="prose">${prose(day.summary ?? "")}</p>
${player(day)}
${notes(day)}</div>`;
  }

  const latest = days[0];
  const earlier = days.slice(1);
  const statusBanner = senior.status === "active" ? "" :
    `<div class="banner"><svg><use href="#i-alert"/></svg><div>${
      senior.status === "revoked"
        ? `${esc(name)} asked Etta to stop calling, and Etta honored it immediately. No calls are being placed — starting again just takes a fresh yes from ${esc(name)}.`
        : `Calls are paused right now.`
    }</div></div>`;

  const body = `<div class="mast"><a class="logo" href="${SITE}">etta<span>.</span></a>
<span class="kick">Family view</span></div>
<h1>${esc(name)}'s check-ins</h1>
<p class="sub">A daily call, honestly AI, always with ${esc(name)}'s consent — and this is what it hears.</p>
${statusBanner}
<div class="panel"><div class="eyebrow">Last ${DAYS} days</div>${moodChart(points)}</div>
${
    latest
      ? dayPanel(latest, true)
      : `<div class="panel accent"><div class="eyebrow">Most recent</div>
<p class="prose">No calls yet — the first check-in will appear here.</p></div>`
  }
${earlier.length ? `<h2 class="section">Earlier days</h2>` : ""}
${
    earlier.map((day) => `<details><summary>
<span class="pip ${day.completed ? "" : "miss"}" style="${
      day.completed ? `background:${moodColor(day.mood, day.urgent)}` : ""
    }"></span>
<span>${prettyDate(day.date)}</span>
<span class="when-word">${
      day.completed ? (day.mood ? MOOD_WORDS[day.mood] : "") : "no answer"
    }</span><span class="chev">▾</span></summary>${dayPanel(day, false)}</details>`).join("")
  }
<div class="center"><a class="manage" href="${SITE}/b/${token}">Manage billing &amp; plan</a></div>
<div class="foot"><b>Private to your family.</b> Anyone with this exact link can view this
page — that's what makes it work without logins or apps. Keep it in the family; to get a
fresh link (and retire this one), reply to Etta's number.<br><br>
Etta is a check-in companion, not medical care or an emergency service. If something
feels urgent, call ${esc(name)} — or 911 — first.</div>`;

  return html(200, body, `Etta — ${name}'s check-ins`);
});
