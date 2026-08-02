#!/usr/bin/env node
// Renders docs/growth-channels.svg — six acquisition channels stacked over five
// years, against the $175k/yr-retained line.
//
// THIS IS A SHAPE STUDY, NOT A FORECAST. The levels depend on assumptions
// nobody has measured (conversion, churn, CAC, whether a payer ever signs). The
// point is that the channels have structurally different SHAPES — linear-and-
// capped, S-curved, base-proportional, cash-proportional, and step — and that
// two of the six produce nothing at all on their own.
//
// Churn is applied per channel at the same rate, so a band shows subscribers
// that channel is currently HOLDING, not how many it ever signed.

import { writeFileSync } from "fs";

const MONTHS = 60;
const CHURN_M = 1 - Math.pow(1 - 0.5, 1 / 12);   // 50%/yr -> 5.6%/mo
const WK = 4.33;
const RETAINED = 15.75;                           // $/subscriber/month
const CAC = 126;
const TARGET_SUBS = 926;                          // $175k/yr retained

const CHANNELS = [
  { key: "direct", label: "Direct / founder outreach", shape: "linear, capped by your hours",
    light: "#2a78d6", dark: "#3987e5",
    adds: (m) => WK * (m < 9 ? 5 + (15 * m) / 9 : m < 30 ? 20 : Math.max(8, 20 - (m - 30) * 0.4)) },

  { key: "organic", label: "Organic social & caregiver communities", shape: "slow, compounds, saturates",
    light: "#eb6834", dark: "#d95926",
    adds: (m) => (m < 3 ? 0 : WK * (38 / (1 + Math.exp(-(m - 24) / 6)))) },

  { key: "referral", label: "Referral / word-of-mouth", shape: "proportional to installed base",
    light: "#1baf7a", dark: "#199e70",
    adds: (m, base) => base * 0.022 },

  { key: "paid", label: "Paid acquisition", shape: "proportional to cash; needs CAC proof",
    light: "#eda100", dark: "#c98500",
    adds: (m, base) => (m < 14 ? 0 : (base * RETAINED * 0.25) / CAC) },

  { key: "partners", label: "Senior living & home-care agencies", shape: "step per signed partner",
    light: "#e87ba4", dark: "#d55181",
    adds: (m) => (m < 15 ? 0 : Math.floor((m - 15) / 5 + 1) * 12) },

  { key: "payer", label: "Medicare Advantage / payer contracts", shape: "long cycle, then step-change",
    light: "#008300", dark: "#008300",
    adds: (m) => (m < 30 ? 0 : m < 42 ? 40 : 180) },
];

function simulate(only = null) {
  const rows = [];
  const cum = Object.fromEntries(CHANNELS.map((c) => [c.key, 0]));
  let base = 0;
  for (let m = 1; m <= MONTHS; m++) {
    for (const c of CHANNELS) cum[c.key] *= 1 - CHURN_M;
    const prevBase = base * (1 - CHURN_M);
    for (const c of CHANNELS) {
      if (only && c.key !== only) continue;
      cum[c.key] += c.adds(m, prevBase);
    }
    base = Object.values(cum).reduce((s, v) => s + v, 0);
    rows.push({ m, base, ...cum });
  }
  return rows;
}

const rows = simulate();
const solo = Object.fromEntries(CHANNELS.map((c) => [c.key, simulate(c.key)[MONTHS - 1].base]));
const end = rows[MONTHS - 1];
const crossed = rows.findIndex((r) => r.base >= TARGET_SUBS) + 1;

// ---------------------------------------------------------------------------
const W = 1340, H = 990;
const M = { top: 152, right: 330, bottom: 372, left: 92 };
const plotW = W - M.left - M.right, plotH = H - M.top - M.bottom;
const YMAX = Math.ceil(end.base / 4000) * 4000;
const x = (m) => M.left + ((m - 1) / (MONTHS - 1)) * plotW;
const y = (v) => M.top + plotH - (v / YMAX) * plotH;

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const n0 = (v) => Math.round(v).toLocaleString("en-US");

// Stacked bands, bottom-up in declaration order.
let bands = "", edgeLabels = "";
const below = new Array(MONTHS).fill(0);
for (const c of CHANNELS) {
  const top = rows.map((r, i) => below[i] + r[c.key]);
  const up = rows.map((r, i) => `${x(r.m).toFixed(1)},${y(top[i]).toFixed(1)}`).join(" L");
  const down = rows.map((r, i) => `${x(r.m).toFixed(1)},${y(below[i]).toFixed(1)}`).reverse().join(" L");
  bands += `<path d="M${up} L${down} Z" fill="var(--${c.key})" opacity=".92"/>\n`;

  // Every band is direct-labelled: the light-mode palette has three slots below
  // 3:1 on the surface, and visible labels are the documented relief for that.
  const mid = (below[MONTHS - 1] + top[MONTHS - 1]) / 2;
  edgeLabels += `<rect x="${(M.left + plotW + 14).toFixed(1)}" y="${(y(mid) - 5).toFixed(1)}" width="10" height="10" rx="2" fill="var(--${c.key})"/>
<text class="el" x="${(M.left + plotW + 30).toFixed(1)}" y="${(y(mid) + 4).toFixed(1)}">${n0(end[c.key])}</text>\n`;
  for (let i = 0; i < MONTHS; i++) below[i] = top[i];
}

let grid = "";
for (let v = 0; v <= YMAX; v += YMAX / 4) {
  grid += `<line x1="${M.left}" x2="${M.left + plotW}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/>
<text class="ax" x="${M.left - 12}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${n0(v)}</text>\n`;
}
for (let m = 12; m <= MONTHS; m += 12) {
  grid += `<text class="ax" x="${x(m).toFixed(1)}" y="${M.top + plotH + 22}" text-anchor="middle">year ${m / 12}</text>\n`;
}

// The $175k/yr line, and where the combined curve crosses it.
const ty = y(TARGET_SUBS);
const marker = `<line x1="${M.left}" x2="${M.left + plotW}" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}" stroke="var(--ink2)" stroke-width="1.5" stroke-dasharray="5 4"/>
<text class="tgt" x="${M.left + 8}" y="${(ty - 9).toFixed(1)}">$175k/yr retained — ${TARGET_SUBS} subscribers · combined channels cross it at month ${crossed}</text>
<circle cx="${x(crossed).toFixed(1)}" cy="${ty.toFixed(1)}" r="5" fill="var(--surface)" stroke="var(--ink)" stroke-width="2"/>`;

// The comparison table is what answers "each method vs combined".
const T = { x: M.left, y: M.top + plotH + 74, rowH: 30 };
let table = `<text class="th" x="${T.x + 26}" y="${T.y}">channel</text>
<text class="th" x="${T.x + 452}" y="${T.y}">shape over time</text>
<text class="th" x="${T.x + 830}" y="${T.y}" text-anchor="end">alone, 5 yr</text>
<text class="th" x="${T.x + 960}" y="${T.y}" text-anchor="end">combined, 5 yr</text>
<line x1="${T.x}" x2="${T.x + 960}" y1="${T.y + 10}" y2="${T.y + 10}" stroke="var(--grid)"/>\n`;
CHANNELS.forEach((c, i) => {
  const ry = T.y + 32 + i * T.rowH;
  const aloneTxt = solo[c.key] < 1 ? "nothing" : n0(solo[c.key]);
  table += `<rect x="${T.x}" y="${ry - 9}" width="11" height="11" rx="2" fill="var(--${c.key})"/>
<text class="td" x="${T.x + 26}" y="${ry}">${esc(c.label)}</text>
<text class="tdm" x="${T.x + 452}" y="${ry}">${esc(c.shape)}</text>
<text class="${solo[c.key] < 1 ? "tdz" : "td"}" x="${T.x + 830}" y="${ry}" text-anchor="end">${aloneTxt}</text>
<text class="td" x="${T.x + 960}" y="${ry}" text-anchor="end">${n0(end[c.key])}</text>\n`;
});
const ly = T.y + 32 + CHANNELS.length * T.rowH;
table += `<line x1="${T.x}" x2="${T.x + 960}" y1="${ly - 20}" y2="${ly - 20}" stroke="var(--grid)"/>
<text class="td" style="font-weight:650" x="${T.x + 26}" y="${ly}">Combined</text>
<text class="tdm" x="${T.x + 452}" y="${ly}">the two zero-alone channels are 55% of it</text>
<text class="tdm" x="${T.x + 830}" y="${ly}" text-anchor="end">—</text>
<text class="td" style="font-weight:650" x="${T.x + 960}" y="${ly}" text-anchor="end">${n0(end.base)}</text>\n`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">
<style>
  :root{--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;
    ${CHANNELS.map((c) => `--${c.key}:${c.light}`).join(";")}}
  @media (prefers-color-scheme:dark){:root{--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;
    ${CHANNELS.map((c) => `--${c.key}:${c.dark}`).join(";")}}}
  .t{fill:var(--ink);font-size:27px;font-weight:650;letter-spacing:-.3px}
  .st{fill:var(--ink2);font-size:15px}
  .stm{fill:var(--muted);font-size:13px}
  .ax{fill:var(--muted);font-size:12.5px}
  .el{fill:var(--ink);font-size:12.5px;font-weight:650}
  .tgt{fill:var(--ink2);font-size:12.5px;font-weight:600}
  .th{fill:var(--muted);font-size:11.5px;letter-spacing:.4px;text-transform:uppercase}
  .td{fill:var(--ink);font-size:13px}
  .tdm{fill:var(--ink2);font-size:12.5px}
  .tdz{fill:var(--muted);font-size:13px;font-style:italic}
  .note{fill:var(--muted);font-size:12.5px}
</style>
<rect width="${W}" height="${H}" fill="var(--surface)"/>
<text class="t" x="${M.left}" y="52">How each way of getting customers actually behaves</text>
<text class="st" x="${M.left}" y="80">Subscribers held over five years, by channel · 50% annual churn applied to every band</text>
<text class="stm" x="${M.left}" y="104">A shape study, not a forecast — the levels rest on conversion, churn and CAC that nobody has measured yet. The shapes are the point.</text>
${grid}${bands}${marker}${edgeLabels}${table}
<text class="note" x="${M.left}" y="${H - 26}">Referral and paid acquisition are multipliers, not sources: both are proportional to a base that already exists, so alone they never start. Together they hold 55% of the subscribers at year five.</text>
</svg>`;

writeFileSync("/home/user/etta/docs/growth-channels.svg", svg);
console.log("wrote docs/growth-channels.svg —", n0(end.base), "subs at 5yr;",
  "$175k/yr line crossed at month", crossed);
