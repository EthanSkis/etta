// fam — the family's no-login web view ("the link is the login").
//
// Reached at ettacalls.com/f/<share_token>, which proxies here: Supabase
// rewrites text/html to text/plain on *.supabase.co, so this page is only
// ever served to families through our own domain.
//
// The page answers, in this order: is my parent okay, is anything changing,
// and what can I do about it. The verdict comes first and the evidence
// follows — a family opening this after a worrying text shouldn't have to
// interpret a chart to find out whether to be worried.
//
// The token is a per-senior capability: long, random, rotatable. Everything
// is server-rendered from the database, so the product tables stay
// service-role only and this function is the single, narrow public window.

import { createClient } from "jsr:@supabase/supabase-js@2";

const DAYS = 14;             // two weeks: this week and the one to compare it with
const WEEK = 7;
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

// The call's length is already known from the end-of-call report, so show it
// immediately rather than making the browser fetch audio metadata to find out.
function clock(total: number): string {
  if (!total || total < 0) return "--:--";
  const m = Math.floor(total / 60), sec = Math.floor(total % 60);
  return `${m}:${sec < 10 ? "0" : ""}${sec}`;
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
<symbol id="i-phone" viewBox="0 0 24 24"><path d="M4.5 5.2c-.6 6.6 7.7 14.9 14.3 14.3l1.4-3-4-1.8-1.9 1.9a15 15 0 0 1-6.9-6.9l1.9-1.9L7.5 3.8 4.5 5.2Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></symbol>
<symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 7.4V12l3.2 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></symbol>
<symbol id="i-spark" viewBox="0 0 24 24"><path d="M4 15.5 9 10l4 3.6L20 7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.4 7H20v4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>
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
  --terra:#BC5127; --terra-deep:#8E3A18; --sage:#77875F; --sage-deep:#5C6B47;
  --gold:#D9A441; --gold-deep:#96701D;
  --card:#FFFDF7; --line:rgba(46,32,20,.14); --line-firm:rgba(46,32,20,.26);
  --serif:"Fraunces",Georgia,serif; --sans:"Karla",system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0}
body{
  background:var(--paper); color:var(--ink);
  font:16px/1.6 var(--sans); -webkit-font-smoothing:antialiased;
  max-width:600px; margin:0 auto; padding:26px 18px 56px; position:relative;
}
body::before{
  content:""; position:fixed; inset:0; pointer-events:none; z-index:0; opacity:.5;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.045'/%3E%3C/svg%3E");
}
body>*{position:relative;z-index:1}
h1,h2,h3{font-family:var(--serif);font-weight:500;line-height:1.15}

.mast{display:flex;align-items:baseline;justify-content:space-between;
  padding-bottom:12px;border-bottom:1.5px solid var(--ink);margin-bottom:20px}
.logo{font-family:var(--serif);font-size:23px;font-weight:600;letter-spacing:-.01em;
  color:var(--ink);text-decoration:none}
.logo span{color:var(--terra)}
.mast .kick{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-soft)}

/* ---------- the verdict ---------- */
.verdict{display:flex;gap:13px;align-items:flex-start;margin-bottom:4px}
.dot-lg{width:13px;height:13px;border-radius:50%;flex:none;margin-top:12px}
h1{font-size:29px;letter-spacing:-.015em;line-height:1.12}
.because{color:var(--ink-soft);font-size:15px;margin:6px 0 0 26px;max-width:33em}
.whom{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-soft);
  margin:0 0 14px 26px}

/* ---------- actions ---------- */
.actions{display:flex;gap:9px;margin:18px 0 0}
.act{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:8px;
  text-decoration:none;border-radius:3px;padding:13px 12px;font-size:15px;font-weight:600;
  border:1px solid var(--line-firm);background:var(--card);color:var(--ink)}
.act svg{width:17px;height:17px}
.act.primary{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.act:hover{filter:brightness(.97)}
.nextline{display:flex;align-items:center;gap:7px;color:var(--ink-soft);font-size:13.5px;
  margin-top:11px}
.nextline svg{width:15px;height:15px;flex:none}

.banner{display:flex;gap:11px;background:#F6E3D8;border:1px solid var(--terra);
  border-radius:3px;padding:13px 15px;font-size:14.5px;margin-top:18px}
.banner svg{width:19px;height:19px;flex:none;color:var(--terra-deep);margin-top:1px}

.panel{background:var(--card);border:1px solid var(--line);border-radius:4px;
  padding:18px;margin-top:16px;box-shadow:0 1px 0 rgba(46,32,20,.05),0 8px 22px -18px rgba(46,32,20,.5)}
.panel.accent{border-left:3px solid var(--ink)}
.eyebrow{display:flex;align-items:center;gap:9px;font-size:10.5px;letter-spacing:.16em;
  text-transform:uppercase;color:var(--ink-soft);margin-bottom:14px}
.eyebrow::after{content:"";flex:1;height:1px;background:var(--line)}
.panel-date{font-family:var(--serif);font-size:19px;font-weight:500}
.panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:2px}
.mins{font-size:12px;color:var(--ink-soft);white-space:nowrap;font-variant-numeric:tabular-nums}

.meter{margin:14px 0 4px}
.meter svg{display:block;width:100%;height:auto}
.meter-ends{display:flex;justify-content:space-between;font-size:11px;
  color:var(--ink-soft);margin-top:2px}
.meter-word{font-family:var(--serif);font-size:17px;font-weight:500;margin-bottom:9px}
.meter-word b{font-weight:600}

/* ---------- tiles, now with the week behind them ---------- */
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:16px}
.tile{border:1px solid var(--line);border-radius:3px;padding:11px 10px;background:var(--paper);
  display:flex;flex-direction:column;gap:4px;min-width:0}
.tile svg{width:19px;height:19px;color:var(--ink-soft)}
.tile .v{font-family:var(--serif);font-size:15.5px;font-weight:500;line-height:1.15}
.tile .k{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft)}
.tile .wk{font-size:11.5px;color:var(--ink-soft);border-top:1px solid var(--line);
  padding-top:5px;margin-top:2px}
.tile.neg{background:#F9EDE6;border-color:rgba(188,81,39,.4)}
.tile.neg svg,.tile.neg .v{color:var(--terra-deep)}

.prose{font-size:15.5px;line-height:1.65;margin-top:16px}
.ask{display:flex;gap:9px;align-items:flex-start;margin-top:14px;font-size:14px;
  color:var(--ink-soft);background:var(--paper);border:1px dashed var(--line-firm);
  border-radius:3px;padding:11px 13px}
.ask svg{width:16px;height:16px;flex:none;margin-top:2px;color:var(--gold-deep)}
.ask b{color:var(--ink);font-weight:600}

.note{display:flex;gap:11px;border:1px solid var(--line);border-left-width:3px;
  border-radius:3px;padding:12px 13px;margin-top:10px;font-size:14.5px;line-height:1.55}
.note svg{width:18px;height:18px;flex:none;margin-top:2px}
.note .lab{display:block;font-size:10px;letter-spacing:.14em;text-transform:uppercase;
  margin-bottom:3px;font-weight:700}
.note.urgent{background:#F9EDE6;border-color:rgba(188,81,39,.45);border-left-color:var(--terra)}
.note.urgent svg,.note.urgent .lab{color:var(--terra-deep)}
.note.watch{background:var(--paper);border-left-color:var(--gold)}
.note.watch svg,.note.watch .lab{color:var(--gold-deep)}
.note-group{margin-top:18px}
.note-group .eyebrow{margin-bottom:8px}
.note-group .note:first-of-type{margin-top:0}

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

/* ---------- chart + weekly trend ---------- */
.chart svg{display:block;width:100%;height:auto;overflow:visible}
.legend{display:flex;gap:15px;flex-wrap:wrap;font-size:11.5px;color:var(--ink-soft);margin-top:11px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:-1px}
.sparse{color:var(--ink-soft);font-size:14px;line-height:1.55;text-align:center;padding:6px 8px 2px}
.sparse b{display:block;font-family:var(--serif);font-size:17px;color:var(--ink);
  font-weight:500;margin-bottom:4px}
.streak{display:flex;align-items:baseline;gap:8px;margin-top:14px;padding-top:13px;
  border-top:1px solid var(--line);font-size:13.5px;color:var(--ink-soft)}
.streak b{font-family:var(--serif);font-size:19px;color:var(--ink);font-weight:600}

.rows{display:flex;flex-direction:column;gap:2px}
.row{display:flex;align-items:center;gap:12px;padding:10px 2px;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:none}
.row .lbl{flex:1;font-size:14.5px}
.row .val{font-family:var(--serif);font-size:16px;font-weight:500;white-space:nowrap}
.delta{font-size:12px;font-weight:600;white-space:nowrap;padding:2px 7px;border-radius:999px;
  background:var(--paper);color:var(--ink-soft);border:1px solid var(--line)}
.delta.up{color:var(--sage-deep);border-color:rgba(119,135,95,.5)}
.delta.down{color:var(--terra-deep);border-color:rgba(188,81,39,.45)}
.trend-note{display:flex;gap:9px;align-items:flex-start;margin-top:14px;font-size:14.5px;
  line-height:1.55}
.trend-note svg{width:18px;height:18px;flex:none;margin-top:2px;color:var(--ink-soft)}

h2.section{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-soft);
  font-family:var(--sans);font-weight:700;margin:30px 0 4px}
details{border-bottom:1px solid var(--line)}
details summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:10px;
  padding:13px 2px;font-size:15px}
details summary::-webkit-details-marker{display:none}
details summary .chev{margin-left:auto;color:var(--ink-soft);font-size:12px;transition:transform .2s}
details[open] summary .chev{transform:rotate(180deg)}
details .panel{margin:0 0 14px;box-shadow:none}
.pip{width:10px;height:10px;border-radius:50%;flex:none}
.pip.miss{background:none;border:1.5px dashed var(--terra)}
.when-word{color:var(--ink-soft);font-size:13.5px}

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
      time.textContent = time.dataset.full || mmss(audio.duration);
    });
    audio.addEventListener("loadedmetadata", function () {
      if (isFinite(audio.duration) && !time.dataset.full) {
        time.textContent = mmss(audio.duration);
      }
    });
    audio.addEventListener("timeupdate", function () {
      if (!audio.duration) return;
      fill.style.width = (audio.currentTime / audio.duration * 100) + "%";
      time.textContent = mmss(audio.duration - audio.currentTime);
    });
    audio.addEventListener("error", function () {
      box.classList.add("quiet");
      box.textContent = "That recording isn't available right now.";
    });
    bar.addEventListener("click", function (e) {
      if (!audio.duration) return;
      var r = bar.getBoundingClientRect();
      audio.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * audio.duration;
    });
  });
})();
<\/script></body></html>`,
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
<p class="because">It may have been rotated for privacy. Check the most recent
text from Etta for the current link, or reply to Etta's number and we'll help.</p>`,
    "Etta — link not active",
  );
}

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

// "9:00 AM" from "09:00:00"
function speakTime(t: string): string {
  const [hs, ms] = t.split(":");
  const h24 = parseInt(hs, 10);
  const h = h24 % 12 || 12;
  return `${h}:${ms} ${h24 < 12 ? "AM" : "PM"}`;
}

interface Stats {
  answered: number;
  attempted: number;
  moodAvg: number | null;
  slept: [number, number];
  ate: [number, number];
  meds: [number, number];
  concerns: number;
}

Deno.serve(async (req) => {
  const token = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  if (!/^[a-f0-9]{24}$/.test(token)) return notFound();

  const { data: senior } = await supabase.from("seniors")
    .select("id, first_name, preferred_name, status, timezone, phone, " +
      "schedules:call_schedules(call_time, days_of_week, active)")
    .eq("share_token", token).maybeSingle();
  if (!senior) return notFound();

  const name = senior.preferred_name || senior.first_name;
  const tz = senior.timezone as string;

  const since = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);
  const { data: calls } = await supabase.from("calls")
    .select(
      "id, status, scheduled_local_date, attempt_number, duration_seconds, recording_shared, " +
        "summary:call_summaries(summary, mood_score, ate_today, slept_well, meds_taken, " +
        "flags, tomorrow_topic)",
    )
    .eq("senior_id", senior.id)
    // Check-ins only. The introduction call is how the service started, not a
    // day of it — showing it as a missed or completed check-in would put a
    // call that happened before consent into the record of calls after it.
    .eq("kind", "check_in")
    // Retries in flight are included so today can say "still trying" rather
    // than "couldn't reach" — those are very different things to read about
    // your parent, and only one of them is true after a single missed ring.
    .in("status", ["completed", "no_answer", "scheduled", "in_progress"])
    .gte("scheduled_local_date", since)
    .order("scheduled_local_date", { ascending: false })
    .order("attempt_number", { ascending: false });

  interface Day {
    id: string | null;
    recordingShared: boolean;
    date: string;
    completed: boolean;
    missed: boolean;
    pending: boolean;
    minutes: number;
    seconds: number;
    mood: number | null;
    urgent: boolean;
    slept: boolean | null;
    ate: boolean | null;
    meds: boolean | null;
    flags: Flag[];
    summary: string | null;
    tomorrow: string | null;
  }
  const byDate = new Map<string, Day>();
  for (const c of calls ?? []) {
    const date = c.scheduled_local_date as string;
    const cur = byDate.get(date) ?? {
      id: null, recordingShared: false,
      date, completed: false, missed: false, pending: false,
      minutes: 0, seconds: 0, mood: null,
      urgent: false, slept: null, ate: null, meds: null, flags: [], summary: null,
      tomorrow: null,
    };
    if (c.status === "completed" && !cur.completed) {
      const s = (Array.isArray(c.summary) ? c.summary[0] : c.summary) as
        | { summary: string; mood_score: number | null; ate_today: boolean | null;
            slept_well: boolean | null; meds_taken: boolean | null; flags: Flag[];
            tomorrow_topic: string | null }
        | null;
      cur.completed = true;
      cur.missed = false;
      cur.id = c.id as string;
      cur.recordingShared = c.recording_shared === true;
      cur.minutes = Math.max(1, Math.round((c.duration_seconds ?? 60) / 60));
      cur.seconds = (c.duration_seconds as number) ?? 0;
      if (s) {
        cur.summary = s.summary;
        cur.mood = s.mood_score;
        cur.flags = Array.isArray(s.flags) ? s.flags : [];
        cur.urgent = cur.flags.some(isUrgent);
        cur.slept = typeof s.slept_well === "boolean" ? s.slept_well : null;
        cur.ate = typeof s.ate_today === "boolean" ? s.ate_today : null;
        cur.meds = typeof s.meds_taken === "boolean" ? s.meds_taken : null;
        cur.tomorrow = s.tomorrow_topic;
      }
    } else if (c.status === "no_answer" && !cur.completed) {
      cur.missed = true;
    } else if (c.status === "scheduled" || c.status === "in_progress") {
      cur.pending = true;
    }
    byDate.set(date, cur);
  }

  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const dowFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "narrow" });
  const dayNameFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" });

  // Oldest → newest across the window, so both weeks can be sliced out of it.
  const dates: string[] = [];
  const points: ChartPoint[] = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    const date = fmt.format(d);
    dates.push(date);
    const day = byDate.get(date);
    points.push({
      x: 14 + (DAYS - 1 - i) * (292 / (DAYS - 1)),
      mood: day?.completed ? day.mood : null,
      missed: !!day?.missed,
      completed: !!day?.completed,
      letter: dowFmt.format(d),
    });
  }

  function statsFor(slice: string[]): Stats {
    const s: Stats = {
      answered: 0, attempted: 0, moodAvg: null,
      slept: [0, 0], ate: [0, 0], meds: [0, 0], concerns: 0,
    };
    let moodSum = 0, moodN = 0;
    for (const date of slice) {
      const d = byDate.get(date);
      if (!d) continue;
      if (d.completed || d.missed) s.attempted++;
      if (!d.completed) continue;
      s.answered++;
      if (d.mood !== null) { moodSum += d.mood; moodN++; }
      if (d.slept !== null) { s.slept[1]++; if (d.slept) s.slept[0]++; }
      if (d.ate !== null) { s.ate[1]++; if (d.ate) s.ate[0]++; }
      if (d.meds !== null) { s.meds[1]++; if (d.meds) s.meds[0]++; }
      s.concerns += d.flags.filter(isUrgent).length;
    }
    if (moodN) s.moodAvg = moodSum / moodN;
    return s;
  }
  const thisWeek = statsFor(dates.slice(WEEK));
  const lastWeek = statsFor(dates.slice(0, WEEK));

  // A day whose only row is a queued retry has nothing to show yet — it counts
  // for the verdict ("still trying") but not as an entry in the history.
  const days = [...byDate.values()]
    .filter((d) => d.completed || d.missed)
    .sort((a, b) => b.date.localeCompare(a.date));
  const today = fmt.format(new Date());
  const todayEntry = byDate.get(today);
  const latest = days[0];
  const earlier = days.slice(1);
  const prettyDate = (iso: string) =>
    new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric",
    });

  // ---------- 1. the verdict ----------
  let headline = `${name} hasn't had a call yet.`;
  let because = "The first check-in will appear here as soon as it happens.";
  let verdictColour = "#B9AD9C";
  // One unanswered ring is not "couldn't reach them" — Etta retries, and saying
  // the alarming thing first would have families calling round over a missed
  // ring while the callback is still queued.
  const stillTrying = !!todayEntry?.pending && !!todayEntry?.missed &&
    !todayEntry?.completed;
  if (stillTrying) {
    headline = `Etta is still trying to reach ${name}.`;
    because = "Today's first call went unanswered, so Etta will call back shortly. " +
      "You'll get a text if she still can't get through.";
    verdictColour = "#D9A441";
  } else if (latest) {
    if (!latest.completed) {
      headline = `Etta couldn't reach ${name}.`;
      // Don't claim the contact chain "was notified" — whether the text
      // actually went out is Twilio's business, not this page's, and telling
      // someone they were alerted when no text arrived is worse than saying
      // nothing. State what Etta did; the next step is the same either way.
      because = "Etta tried and couldn't get through today. That's often " +
        "nothing — errands, a nap, the phone in another room — but you know " +
        `${name} best, and a quick call from you is the right next step.`;
      verdictColour = "#BC5127";
    } else if (latest.urgent) {
      headline = "Worth a look today.";
      because = `${name} said something Etta thought you'd want to know about — it's below.`;
      verdictColour = "#BC5127";
    } else if (latest.mood !== null && latest.mood <= 2) {
      headline = `A harder day for ${name}.`;
      because = "Nothing alarming, but spirits were low. Sometimes a call from you is the thing.";
      verdictColour = "#BC5127";
    } else if (latest.mood !== null && latest.mood >= 4) {
      headline = `${name}'s doing well.`;
      because = "Good spirits on the last call, and nothing that needs your attention.";
      verdictColour = "#77875F";
    } else if (latest.mood !== null) {
      headline = `${name}'s steady.`;
      because = "An ordinary day — nothing that needs your attention.";
      verdictColour = "#D9A441";
    } else {
      // Etta got through but the call was too short or too sparse to read
      // spirits from. Say that, rather than calling it steady on no evidence.
      headline = `Etta spoke with ${name}.`;
      because = "The call was too brief to say much about how they're doing. " +
        "Nothing came up that needs your attention.";
      verdictColour = "#B9AD9C";
    }
  }

  // ---------- 2. next call ----------
  const sched = (senior.schedules as
    { call_time: string; days_of_week: number[]; active: boolean }[] ?? [])
    .find((s) => s.active);
  let nextLine = "";
  if (sched && senior.status === "active") {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const nowDow = dowMap[get("weekday")] ?? 0;
    const nowMin = parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10);
    const [ch, cm] = sched.call_time.split(":").map((n) => parseInt(n, 10));
    const callMin = ch * 60 + cm;
    let when = "";
    for (let offset = 0; offset <= 7; offset++) {
      const dow = (nowDow + offset) % 7;
      if (!sched.days_of_week.includes(dow)) continue;
      if (offset === 0 && nowMin >= callMin) continue;
      when = offset === 0
        ? "later today"
        : offset === 1
        ? "tomorrow"
        : dayNameFmt.format(new Date(Date.now() + offset * 864e5));
      break;
    }
    if (stillTrying) {
      // Saying "next call tomorrow" under "still trying to reach them" reads as
      // a contradiction; the callback in flight is the next call.
      nextLine = `<div class="nextline"><svg><use href="#i-clock"/></svg>
Calling back shortly</div>`;
    } else if (when) {
      nextLine = `<div class="nextline"><svg><use href="#i-clock"/></svg>
Next call ${when} at ${speakTime(sched.call_time)}</div>`;
    }
  }

  // ---------- 3. answered streak ----------
  const window14 = statsFor(dates);
  const streak = window14.attempted > 0
    ? `<div class="streak"><b>${window14.answered} of ${window14.attempted}</b>
<span>calls answered in the last two weeks</span></div>`
    : "";

  // ---------- 4. tiles, with the week behind them ----------
  function ratio(pair: [number, number]): string {
    return pair[1] ? `${pair[0]} of ${pair[1]} days` : "";
  }
  function tiles(day: Day, showWeek: boolean): string {
    const t: string[] = [];
    const cell = (
      on: boolean | null, icon: string, yes: string, no: string, key: string,
      wk: [number, number],
    ) => {
      if (on === null) return;
      t.push(`<div class="tile${on ? "" : " neg"}"><svg><use href="#${icon}"/></svg>
<span class="v">${on ? yes : no}</span><span class="k">${key}</span>
${showWeek && wk[1] > 1 ? `<span class="wk">${ratio(wk)} this week</span>` : ""}</div>`);
    };
    cell(day.slept, "i-moon", "Slept well", "Slept poorly", "Sleep", thisWeek.slept);
    cell(day.ate, "i-meal", "Has eaten", "Not yet", "Meals", thisWeek.ate);
    cell(day.meds, "i-pill", "Taken", "Not taken", "Medication", thisWeek.meds);
    return t.length ? `<div class="tiles">${t.join("")}</div>` : "";
  }

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
  <div class="track-meta"><b>Listen to the call</b><span class="t" data-full="${clock(day.seconds)}">${clock(day.seconds)}</span></div>
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

  function dayPanel(day: Day, isLatest: boolean): string {
    if (!day.completed) {
      return `<div class="panel${isLatest ? " accent" : ""}">
${isLatest ? `<div class="eyebrow">Most recent</div>` : ""}
<div class="panel-head"><span class="panel-date">${prettyDate(day.date)}</span></div>
<div class="note ${day.pending ? "watch" : "urgent"}" style="margin-top:12px">
<svg><use href="#i-phone-off"/></svg>
<div><span class="lab">No answer</span>${
        day.pending
          ? `Etta called and got no answer. She'll try again shortly.`
          : `Etta tried ${esc(name)} several times that day and couldn't ` +
            `get through.`
      }</div></div></div>`;
    }
    // 6. what Etta will follow up on next time
    const ask = isLatest && day.tomorrow
      ? `<div class="ask"><svg><use href="#i-spark"/></svg>
<div>Next time, Etta will ask about <b>${esc(day.tomorrow)}</b>.</div></div>`
      : "";
    return `<div class="panel${isLatest ? " accent" : ""}">
${isLatest ? `<div class="eyebrow">Most recent check-in</div>` : ""}
<div class="panel-head"><span class="panel-date">${prettyDate(day.date)}</span>
<span class="mins">${day.minutes} min call</span></div>
${
      day.mood
        ? `<div class="meter-word">Overall, <b>${MOOD_WORDS[day.mood]}</b></div>${moodMeter(day.mood, day.urgent)}`
        : ""
    }
${tiles(day, isLatest)}
<p class="prose">${prose(day.summary ?? "")}</p>
${ask}
${player(day)}
${notes(day)}</div>`;
  }

  // ---------- 5. chart, or an honest sparse state ----------
  const withData = points.filter((p) => p.completed || p.missed).length;
  const chartPanel = withData >= 3
    ? `<div class="panel"><div class="eyebrow">Last ${DAYS} days</div>${moodChart(points)}${streak}</div>`
    : `<div class="panel"><div class="eyebrow">Last ${DAYS} days</div>
<div class="sparse"><b>Building the picture</b>
Patterns in sleep, appetite and spirits appear here once there are a few more
calls — that's the part a visit can't show you.</div>${streak}</div>`;

  // ---------- 7. weekly trend ----------
  function delta(now: number | null, before: number | null, higherIsBetter = true): string {
    if (now === null || before === null) return "";
    const diff = now - before;
    if (Math.abs(diff) < 0.05) return `<span class="delta">level</span>`;
    const better = higherIsBetter ? diff > 0 : diff < 0;
    const arrow = diff > 0 ? "▲" : "▼";
    return `<span class="delta ${better ? "up" : "down"}">${arrow} ${Math.abs(diff).toFixed(1)}</span>`;
  }
  // For counts, a scaled arrow ("▼ 2.1") means nothing to a reader. Say what
  // last week actually was and colour it by direction.
  function wasChip(now: [number, number], before: [number, number]): string {
    if (!now[1] || !before[1]) return "";
    const a = now[0] / now[1], b = before[0] / before[1];
    const cls = Math.abs(a - b) < 0.01 ? "" : a > b ? " up" : " down";
    return `<span class="delta${cls}">was ${before[0]} of ${before[1]}</span>`;
  }
  let trendPanel = "";
  if (thisWeek.answered >= 2) {
    const rows: string[] = [];
    if (thisWeek.moodAvg !== null) {
      rows.push(`<div class="row"><span class="lbl">Spirits, on average</span>
<span class="val">${thisWeek.moodAvg.toFixed(1)}<span style="font-size:12px;color:var(--ink-soft)"> / 5</span></span>
${delta(thisWeek.moodAvg, lastWeek.moodAvg)}</div>`);
    }
    if (thisWeek.slept[1]) {
      rows.push(`<div class="row"><span class="lbl">Slept well</span>
<span class="val">${ratio(thisWeek.slept)}</span>${wasChip(thisWeek.slept, lastWeek.slept)}</div>`);
    }
    if (thisWeek.ate[1]) {
      rows.push(`<div class="row"><span class="lbl">Had eaten</span>
<span class="val">${ratio(thisWeek.ate)}</span>${wasChip(thisWeek.ate, lastWeek.ate)}</div>`);
    }
    if (thisWeek.meds[1]) {
      rows.push(`<div class="row"><span class="lbl">Medication taken</span>
<span class="val">${ratio(thisWeek.meds)}</span>${wasChip(thisWeek.meds, lastWeek.meds)}</div>`);
    }
    rows.push(`<div class="row"><span class="lbl">Calls answered</span>
<span class="val">${thisWeek.answered} of ${thisWeek.attempted}</span></div>`);

    // One plain sentence, because a table of numbers isn't a conclusion.
    let sentence: string;
    if (lastWeek.answered < 2) {
      sentence = `This is ${esc(name)}'s first full week with Etta — next week these
numbers get a comparison, and that's when changes start to show.`;
    } else if (thisWeek.moodAvg !== null && lastWeek.moodAvg !== null &&
               thisWeek.moodAvg - lastWeek.moodAvg <= -0.7) {
      sentence = `${esc(name)}'s spirits are lower than last week. One quiet week is
usually nothing — but it's the kind of drift that's hard to notice from visits.`;
    } else if (thisWeek.moodAvg !== null && lastWeek.moodAvg !== null &&
               thisWeek.moodAvg - lastWeek.moodAvg >= 0.7) {
      sentence = `${esc(name)}'s spirits are up on last week.`;
    } else if (thisWeek.concerns > 0) {
      sentence = `${thisWeek.concerns} thing${thisWeek.concerns === 1 ? "" : "s"} came up this
week that Etta flagged for you — they're in the days below.`;
    } else {
      sentence = `A steady week for ${esc(name)}, much like the one before it.`;
    }
    trendPanel = `<div class="panel"><div class="eyebrow">This week vs last</div>
<div class="rows">${rows.join("")}</div>
<div class="trend-note"><svg><use href="#i-spark"/></svg><div>${sentence}</div></div></div>`;
  }

  const statusBanner = senior.status === "active" ? "" :
    `<div class="banner"><svg><use href="#i-alert"/></svg><div>${
      senior.status === "revoked"
        ? `${esc(name)} asked Etta to stop calling, and Etta honored it immediately. No calls are being placed — starting again just takes a fresh yes from ${esc(name)}.`
        : `Calls are paused right now.`
    }</div></div>`;

  const tel = String(senior.phone ?? "").replace(/[^\d+]/g, "");
  const body = `<div class="mast"><a class="logo" href="${SITE}">etta<span>.</span></a>
<span class="kick">Family view</span></div>
<div class="whom">${esc(name)}'s check-ins</div>
<div class="verdict"><span class="dot-lg" style="background:${verdictColour}"></span>
<h1>${esc(headline)}</h1></div>
<p class="because">${esc(because)}</p>
<div class="actions">
${tel ? `<a class="act primary" href="tel:${esc(tel)}"><svg><use href="#i-phone"/></svg>Call ${esc(name)}</a>` : ""}
<a class="act" href="${SITE}/b/${token}">Billing &amp; plan</a>
</div>
${nextLine}
${statusBanner}
${chartPanel}
${trendPanel}
${latest ? dayPanel(latest, true) : ""}
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
<div class="foot"><b>Private to your family.</b> Anyone with this exact link can view this
page — that's what makes it work without logins or apps. Keep it in the family; to get a
fresh link (and retire this one), reply to Etta's number.<br><br>
Etta is a check-in companion, not medical care or an emergency service. If something
feels urgent, call ${esc(name)} — or 911 — first.</div>`;

  return html(200, body, `Etta — ${name}'s check-ins`);
});
