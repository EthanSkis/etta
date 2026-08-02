#!/usr/bin/env node
// Renders docs/five-year-outlook.svg — a five-year range for Etta, with the
// central estimate emphasised and bear/bull as the band around it.
//
// Parameters are deliberately more conservative than the earlier channel study.
// The base rate matters: elderly-check-in-market-landscape.txt found five to
// eight direct competitors, none of which disclosed a user number, and the
// largest funding signal in the whole category was a $3.5M seed. That is what
// an unremarkable outcome looks like here, so a model that lands a solo founder
// in five figures needs to justify itself rather than be assumed.
//
// The moonshot line is drawn separately and dashed because it is not a better
// execution of the same plan — it is a different plan, decided by a signature.

import { writeFileSync } from "fs";

const MONTHS = 60;
const WK = 4.33;
const PRICE = 39, RETAINED = 15.75;

// Organic paid-signups/month ramps on an S-curve to `peak`; the funnel has a
// consent step in it, so cold traffic converts worse than a normal SaaS trial.
const organic = (m, peak) => (m < 3 ? 0 : peak / (1 + Math.exp(-(m - 26) / 7)));

function run(p) {
  const c = 1 - Math.pow(1 - p.churn, 1 / 12);
  let base = 0;
  const hist = [];
  for (let m = 1; m <= MONTHS; m++) {
    base *= 1 - c;
    const direct = WK * (m < 6 ? 3 + m : m < 24 ? 9 : 5);   // founder selling, capped
    const org = organic(m, p.organicPeak);
    const referral = base * p.refRate;
    const paid = p.paidFrom && m >= p.paidFrom
      ? (base * RETAINED * p.reinvest) / p.cac : 0;
    const partners = p.partnerFrom && m >= p.partnerFrom
      ? Math.floor((m - p.partnerFrom) / 8 + 1) * p.partnerRate : 0;
    const payer = p.payerFrom && m >= p.payerFrom ? p.payerRate : 0;
    base += direct + org + referral + paid + partners + payer;
    hist.push(base);
  }
  return hist;
}

const SCEN = [
  { key: "bear", label: "Bear", why: "organic never really converts · 62% churn · paid never unlocks",
    p: { churn: 0.62, organicPeak: 4, refRate: 0.010, cac: 200 } },
  { key: "base", label: "Central estimate", why: "organic works modestly · 50% churn · paid unlocks year 2 · one partner",
    p: { churn: 0.50, organicPeak: 18, refRate: 0.025, cac: 150,
         paidFrom: 24, reinvest: 0.25, partnerFrom: 36, partnerRate: 8 } },
  { key: "bull", label: "Bull", why: "organic finds a vein · 40% churn · paid clears the threshold · 3 partners",
    p: { churn: 0.40, organicPeak: 45, refRate: 0.040, cac: 120,
         paidFrom: 18, reinvest: 0.45, partnerFrom: 30, partnerRate: 12 } },
  { key: "moon", label: "Payer contract lands", why: "a different plan, not better execution of this one", dashed: true,
    p: { churn: 0.50, organicPeak: 18, refRate: 0.025, cac: 150,
         paidFrom: 24, reinvest: 0.25, payerFrom: 42, payerRate: 700 } },
];
for (const s of SCEN) s.h = run(s.p);
const at = (s, m) => s.h[m - 1];

// ---------------------------------------------------------------------------
const W = 1300, H = 940;
const M = { top: 154, right: 300, bottom: 300, left: 100 };
const plotW = W - M.left - M.right, plotH = H - M.top - M.bottom;
const LO = 10, HI = 30000;
const x = (m) => M.left + ((m - 1) / (MONTHS - 1)) * plotW;
const y = (v) => M.top + plotH -
  ((Math.log10(Math.max(v, LO)) - Math.log10(LO)) / (Math.log10(HI) - Math.log10(LO))) * plotH;
const n0 = (v) => Math.round(v).toLocaleString("en-US");
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");

const bear = SCEN[0], cen = SCEN[1], bull = SCEN[2], moon = SCEN[3];

let grid = "";
for (const v of [10, 100, 1000, 10000, 30000]) {
  grid += `<line x1="${M.left}" x2="${M.left + plotW}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/>
<text class="ax" x="${M.left - 12}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${n0(v)}</text>\n`;
}
for (let m = 12; m <= MONTHS; m += 12) {
  grid += `<text class="ax" x="${x(m).toFixed(1)}" y="${M.top + plotH + 24}" text-anchor="middle">year ${m / 12}</text>\n`;
}

// The band is bear-to-bull; the central estimate is the line that matters.
// Emphasis form: one series in the accent hue, the range around it recessive.
const up = bull.h.map((v, i) => `${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`).join(" L");
const dn = bear.h.map((v, i) => `${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`).reverse().join(" L");
const band = `<path d="M${up} L${dn} Z" fill="var(--accent)" opacity=".13"/>`;

const line = (h, cls, dash = "") =>
  `<path d="M${h.map((v, i) => `${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`).join(" L")}" fill="none" stroke="${cls}" stroke-width="${dash ? 2 : 3}" ${dash} stroke-linejoin="round"/>`;

const TARGET = 926;
const marker = `<line x1="${M.left}" x2="${M.left + plotW}" y1="${y(TARGET)}" y2="${y(TARGET)}" stroke="var(--ink2)" stroke-width="1.4" stroke-dasharray="5 4"/>
<text class="tgt" x="${M.left + 8}" y="${(y(TARGET) - 9).toFixed(1)}">926 subscribers = $175k/yr retained</text>`;

const LABEL_PITCH = 44;
const lslots = SCEN.map((s, i) => ({ i, y: Math.max(y(at(s, MONTHS)), M.top + 6) }))
  .sort((a, b) => a.y - b.y);
for (let k = 1; k < lslots.length; k++) {
  if (lslots[k].y - lslots[k - 1].y < LABEL_PITCH) lslots[k].y = lslots[k - 1].y + LABEL_PITCH;
}
const LY = Object.fromEntries(lslots.map((s) => [s.i, s.y]));

const endLbl = (s, color, idx) => {
  const v = at(s, MONTHS), dy = LY[idx] - y(v);
  return `<rect x="${M.left + plotW + 14}" y="${(y(v) - 5 + dy).toFixed(1)}" width="10" height="10" rx="2" fill="${color}"/>
<text class="ll" x="${M.left + plotW + 30}" y="${(y(v) - 1 + dy).toFixed(1)}">${esc(s.label)}</text>
<text class="lm" x="${M.left + plotW + 30}" y="${(y(v) + 13 + dy).toFixed(1)}">${n0(v)} at year 5</text>`;
};

// Table: what each world means in money, at year 5.
const T = { x: M.left, y: M.top + plotH + 78 };
let table = `<text class="th" x="${T.x + 22}" y="${T.y}">scenario</text>
<text class="th" x="${T.x + 560}" y="${T.y}" text-anchor="end">subs at yr 5</text>
<text class="th" x="${T.x + 720}" y="${T.y}" text-anchor="end">gross revenue</text>
<text class="th" x="${T.x + 890}" y="${T.y}" text-anchor="end">retained/yr</text>
<line x1="${T.x}" x2="${T.x + 890}" y1="${T.y + 10}" y2="${T.y + 10}" stroke="var(--grid)"/>\n`;
SCEN.forEach((s, i) => {
  const ry = T.y + 34 + i * 34, v = at(s, MONTHS);
  const col = s.key === "base" ? "var(--accent)" : s.key === "moon" ? "var(--ink2)" : "var(--muted)";
  table += `<rect x="${T.x}" y="${ry - 9}" width="11" height="11" rx="2" fill="${col}"/>
<text class="td" style="${s.key === "base" ? "font-weight:650" : ""}" x="${T.x + 22}" y="${ry}">${esc(s.label)}</text>
<text class="tdm" x="${T.x + 22}" y="${ry + 15}">${esc(s.why)}</text>
<text class="td" x="${T.x + 560}" y="${ry}" text-anchor="end">${n0(v)}</text>
<text class="td" x="${T.x + 720}" y="${ry}" text-anchor="end">$${n0(v * PRICE * 12 / 1000)}k</text>
<text class="td" x="${T.x + 890}" y="${ry}" text-anchor="end">$${n0(v * RETAINED * 12 / 1000)}k</text>\n`;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">
<style>
  :root{--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--accent:#2a78d6}
  @media (prefers-color-scheme:dark){:root{--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--accent:#3987e5}}
  .t{fill:var(--ink);font-size:27px;font-weight:650;letter-spacing:-.3px}
  .st{fill:var(--ink2);font-size:15px}
  .stm{fill:var(--muted);font-size:13px}
  .ax{fill:var(--muted);font-size:12.5px}
  .tgt{fill:var(--ink2);font-size:12.5px;font-weight:600}
  .ll{fill:var(--ink);font-size:13px;font-weight:650}
  .lm{fill:var(--muted);font-size:11.5px}
  .th{fill:var(--muted);font-size:11.5px;letter-spacing:.4px;text-transform:uppercase}
  .td{fill:var(--ink);font-size:13.5px}
  .tdm{fill:var(--muted);font-size:11.5px}
  .note{fill:var(--muted);font-size:12.5px}
</style>
<rect width="${W}" height="${H}" fill="var(--surface)"/>
<text class="t" x="${M.left}" y="52">Five years: a reasonable range</text>
<text class="st" x="${M.left}" y="80">Subscribers held, month by month. Log scale — the range spans two orders of magnitude. The band is bear to bull; the solid line is the central estimate.</text>
<text class="stm" x="${M.left}" y="104">Tuned conservatively against the category's base rate — no competitor in the market research has disclosed a user number, and the biggest raise was a $3.5M seed.</text>
${grid}${band}${marker}
${line(bear.h, "var(--muted)")}
${line(bull.h, "var(--muted)")}
${line(moon.h, "var(--ink2)", 'stroke-dasharray="7 5"')}
${line(cen.h, "var(--accent)")}
${endLbl(bear, "var(--muted)", 0)}${endLbl(cen, "var(--accent)", 1)}${endLbl(bull, "var(--muted)", 2)}${endLbl(moon, "var(--ink2)", 3)}
${table}
<text class="note" x="${M.left}" y="${H - 34}">Every line assumes you keep going for five years. The dashed payer line is not better execution of this plan — it is a different plan, and it turns on a signature rather than on effort.</text>
<text class="note" x="${M.left}" y="${H - 14}">Conversion, churn and CAC are still unmeasured, so treat the band as the honest width of what is unknown rather than as a confidence interval.</text>
</svg>`;

writeFileSync("/home/user/etta/docs/five-year-outlook.svg", svg);
for (const s of SCEN) {
  console.log(`  ${s.label.padEnd(22)} yr3 ${n0(at(s, 36)).padStart(6)}   yr5 ${n0(at(s, MONTHS)).padStart(6)}   retained/yr $${n0(at(s, MONTHS) * RETAINED * 12)}`);
}
