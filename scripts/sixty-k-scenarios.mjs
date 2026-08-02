#!/usr/bin/env node
// Renders docs/sixty-k-scenarios.svg — does any plausible world reach 60,000
// subscribers, and what decides it?
//
// The answer turns out to be one number: the share of retained cash ploughed
// back into paid acquisition. Paid compounds only when it buys subscribers
// faster than churn removes them —
//
//     reinvest x retained / CAC  >  monthly churn
//
// which is a hard threshold, not a gradient. Below it the consumer business
// plateaus at some ceiling no amount of time exceeds; above it, it compounds.
// That is why single-variable improvements mostly failed to reach 60k while
// the reinvestment rate alone flipped the outcome.
//
// Acquisition in every channel is scaled by remaining market share, so the
// model cannot sell to more households than exist. (An earlier version without
// this peaked at 1.6M against a 1M market.)

import { writeFileSync } from "fs";

const SAM = 1_000_000;      // serviceable households: US 65+ living alone with
                            // an adult child plausibly willing to pay
const TARGET = 60_000;
const MONTHS = 120;
const RETAINED = 15.75;
const WK = 4.33;

function run(p) {
  const c = 1 - Math.pow(1 - p.churn, 1 / 12);
  let base = 0;
  const hist = [];
  for (let m = 1; m <= MONTHS; m++) {
    base *= 1 - c;
    const pen = Math.min(base / SAM, 0.999);
    const cac = p.cac0 * (1 + pen / Math.max(1 - pen, 0.05));
    const remaining = 1 - pen;

    const direct = WK * (m < 9 ? 5 + (15 * m) / 9 : m < 30 ? 20 : 10);
    const organic = m < 3 ? 0 : WK * (38 / (1 + Math.exp(-(m - 24) / 6)));
    const referral = base * p.refRate;
    const paid = m < 14 ? 0 : (base * RETAINED * p.reinvest) / cac;
    const payer = !p.payerRate ? 0 : m < 30 ? 0
      : m < 42 ? p.payerRate * 0.25 : p.payerRate;

    base += (direct + organic + referral + paid + payer) * remaining;
    hist.push(base);
  }
  const hit = hist.findIndex((v) => v >= TARGET);
  return { hist, peak: Math.max(...hist), hit: hit < 0 ? null : hit + 1 };
}

const SCEN = [
  { label: "Bear", detail: "65% churn · CAC $250 · 50% reinvested",
    light: "#2a78d6", dark: "#3987e5",
    p: { churn: 0.65, cac0: 250, reinvest: 0.5, refRate: 0.022 } },
  { label: "Base case", detail: "50% churn · CAC $126 · 25% reinvested",
    light: "#eb6834", dark: "#d95926",
    p: { churn: 0.5, cac0: 126, reinvest: 0.25, refRate: 0.022 } },
  { label: "Same, but reinvest 50%", detail: "the only change from Base",
    light: "#1baf7a", dark: "#199e70",
    p: { churn: 0.5, cac0: 126, reinvest: 0.5, refRate: 0.022 } },
  { label: "Payer-led", detail: "Base + a plan delivering 2,000/mo",
    light: "#eda100", dark: "#c98500",
    p: { churn: 0.5, cac0: 126, reinvest: 0.25, refRate: 0.022, payerRate: 2000 } },
  { label: "Solid execution + payer", detail: "40% churn · 50% reinv · 3.5% referral · plan",
    light: "#e87ba4", dark: "#d55181",
    p: { churn: 0.4, cac0: 126, reinvest: 0.5, refRate: 0.035, payerRate: 500 } },
];
for (const s of SCEN) s.r = run(s.p);

// ---------------------------------------------------------------------------
const W = 1360, H = 960;
const M = { top: 150, right: 356, bottom: 316, left: 96 };
const plotW = W - M.left - M.right, plotH = H - M.top - M.bottom;
const LO = 100, HI = 1_000_000;                       // log-y bounds
const ly = (v) => M.top + plotH -
  ((Math.log10(Math.max(v, LO)) - Math.log10(LO)) / (Math.log10(HI) - Math.log10(LO))) * plotH;
const lx = (m) => M.left + ((m - 1) / (MONTHS - 1)) * plotW;

const n0 = (v) => Math.round(v).toLocaleString("en-US");
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");

let grid = "";
for (const v of [100, 1000, 10000, 100000, 1000000]) {
  grid += `<line x1="${M.left}" x2="${M.left + plotW}" y1="${ly(v).toFixed(1)}" y2="${ly(v).toFixed(1)}" stroke="var(--grid)"/>
<text class="ax" x="${M.left - 12}" y="${(ly(v) + 4).toFixed(1)}" text-anchor="end">${n0(v)}</text>\n`;
}
for (let m = 12; m <= MONTHS; m += 12) {
  grid += `<text class="ax" x="${lx(m).toFixed(1)}" y="${M.top + plotH + 24}" text-anchor="middle">yr ${m / 12}</text>\n`;
}

const ty = ly(TARGET);
const target = `<rect x="${M.left}" y="${(ty - 0.5).toFixed(1)}" width="${plotW}" height="1.5" fill="var(--ink)"/>
<text class="tgt" x="${M.left + 8}" y="${(ty - 10).toFixed(1)}">60,000 subscribers — 6% of the assumed 1.0M serviceable households</text>`;

// Right-edge label slots, de-collided: two scenarios can finish at nearly the
// same value on a log axis, and their two-line labels then sit on top of each
// other. Resolve by sorting on the true end position and enforcing a minimum
// pitch, so each label still points at the right line but never overlaps.
const LABEL_PITCH = 46;
const slots = SCEN
  .map((s, i) => ({ i, y: ly(s.r.hist[MONTHS - 1]) }))
  .sort((a, b) => a.y - b.y);
for (let k = 1; k < slots.length; k++) {
  if (slots[k].y - slots[k - 1].y < LABEL_PITCH) slots[k].y = slots[k - 1].y + LABEL_PITCH;
}
const labelY = Object.fromEntries(slots.map((s) => [s.i, s.y]));

let lines = "", labels = "";
SCEN.forEach((s, i) => {
  const d = s.r.hist.map((v, j) => `${lx(j + 1).toFixed(1)},${ly(v).toFixed(1)}`).join(" L");
  lines += `<path d="M${d}" fill="none" stroke="var(--s${i})" stroke-width="2.4" stroke-linejoin="round"/>\n`;
  if (s.r.hit) {
    lines += `<circle cx="${lx(s.r.hit).toFixed(1)}" cy="${ty.toFixed(1)}" r="5.5" fill="var(--surface)" stroke="var(--s${i})" stroke-width="2.5"/>\n`;
  }
  // Direct labels are mandatory at this series count, and the light palette has
  // slots under 3:1 on the surface, so every line is named at its end.
  const trueY = ly(s.r.hist[MONTHS - 1]);
  const endY = labelY[i];
  // If the label was nudged, tether it back to where the line actually ends.
  if (Math.abs(endY - trueY) > 3) {
    labels += `<path d="M${M.left + plotW} ${trueY.toFixed(1)} L${M.left + plotW + 9} ${endY.toFixed(1)}" fill="none" stroke="var(--s${i})" stroke-width="1.2" opacity=".65"/>\n`;
  }
  labels += `<rect x="${M.left + plotW + 14}" y="${(endY - 5).toFixed(1)}" width="10" height="10" rx="2" fill="var(--s${i})"/>
<text class="ll" x="${M.left + plotW + 30}" y="${(endY - 1).toFixed(1)}">${esc(s.label)}</text>
<text class="lm" x="${M.left + plotW + 30}" y="${(endY + 13).toFixed(1)}">${s.r.hit ? `60k at ${(s.r.hit / 12).toFixed(1)} yr` : `never — peaks ${n0(s.r.peak)}`}</text>\n`;
});

// The threshold table: the single number that decides the outcome.
const T = { x: M.left, y: M.top + plotH + 76 };
const CACS = [100, 126, 200, 250];
let table = `<text class="th" x="${T.x}" y="${T.y}">share of retained cash you must reinvest in paid for the consumer engine to compound at all</text>
<text class="thm" x="${T.x}" y="${T.y + 20}">reinvest × $15.75 ÷ CAC  must exceed  monthly churn. Below the line you plateau; above it you compound.</text>\n`;
table += `<text class="tk" x="${T.x}" y="${T.y + 52}">annual churn</text>`;
CACS.forEach((c, i) => {
  table += `<text class="tk" x="${T.x + 210 + i * 150}" y="${T.y + 52}" text-anchor="end">CAC $${c}</text>`;
});
[0.35, 0.4, 0.5, 0.65].forEach((a, r) => {
  const c = 1 - Math.pow(1 - a, 1 / 12);
  const ry = T.y + 80 + r * 27;
  table += `<text class="td" x="${T.x}" y="${ry}">${(a * 100).toFixed(0)}%  (${(c * 100).toFixed(1)}%/mo)</text>`;
  CACS.forEach((k, i) => {
    const need = (k * c) / RETAINED;
    const cls = need > 1 ? "tdx" : need > 0.6 ? "tdw" : "td";
    const txt = need > 1 ? `${(need * 100).toFixed(0)}% — impossible` : `${(need * 100).toFixed(0)}%`;
    table += `<text class="${cls}" x="${T.x + 210 + i * 150}" y="${ry}" text-anchor="end">${txt}</text>`;
  });
  table += "\n";
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">
<style>
  :root{--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--bad:#d03b3b;
    ${SCEN.map((s, i) => `--s${i}:${s.light}`).join(";")}}
  @media (prefers-color-scheme:dark){:root{--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--bad:#e66767;
    ${SCEN.map((s, i) => `--s${i}:${s.dark}`).join(";")}}}
  .t{fill:var(--ink);font-size:27px;font-weight:650;letter-spacing:-.3px}
  .st{fill:var(--ink2);font-size:15px}
  .stm{fill:var(--muted);font-size:13px}
  .ax{fill:var(--muted);font-size:12.5px}
  .tgt{fill:var(--ink);font-size:12.5px;font-weight:650}
  .ll{fill:var(--ink);font-size:13px;font-weight:650}
  .lm{fill:var(--muted);font-size:11.5px}
  .th{fill:var(--ink);font-size:14px;font-weight:650}
  .thm{fill:var(--muted);font-size:12.5px}
  .tk{fill:var(--muted);font-size:11.5px;letter-spacing:.4px;text-transform:uppercase}
  .td{fill:var(--ink);font-size:13px}
  .tdw{fill:var(--ink2);font-size:13px}
  .tdx{fill:var(--bad);font-size:13px;font-weight:650}
</style>
<rect width="${W}" height="${H}" fill="var(--surface)"/>
<text class="t" x="${M.left}" y="52">Is there a real world with 60,000 subscribers?</text>
<text class="st" x="${M.left}" y="80">Ten years, log scale. Acquisition in every channel slows as the market fills, so no run can outsell the households that exist.</text>
<text class="stm" x="${M.left}" y="104">Yes — but only in worlds where paid acquisition clears a hard reinvestment threshold, or a payer contract does the work instead.</text>
${grid}${target}${lines}${labels}${table}
</svg>`;

writeFileSync("/home/user/etta/docs/sixty-k-scenarios.svg", svg);
for (const s of SCEN) {
  console.log(`  ${s.label.padEnd(26)} peak ${n0(s.r.peak).padStart(8)}  ${s.r.hit ? "60k at " + (s.r.hit / 12).toFixed(1) + " yr" : "never"}`);
}
