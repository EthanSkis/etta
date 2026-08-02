#!/usr/bin/env node
// Renders docs/cash-flow.svg — the waterfall of where one Daily subscriber's $39
// goes each month. Figures come from scripts/unit-economics.mjs; if the vendor
// rates there change, re-run both.
//
// Colours are the validated data-viz defaults: a single blue for every outflow
// (bar height already encodes magnitude, so a 7-step ramp would be redundant —
// and failed the adjacent-step-gap check), neutral for revenue, status-green for
// margin. Blue vs green passes CVD and contrast in both light and dark.
import { writeFileSync } from "fs";

const W = 1120, H = 720;
const M = { top: 148, right: 44, bottom: 214, left: 96 };
const plotW = W - M.left - M.right, plotH = H - M.top - M.bottom;
const YMAX = 40;
const y = (v) => M.top + plotH - (v / YMAX) * plotH;

const steps = [
  { label: "Revenue",   sub: "Daily plan",       v: 39.00, kind: "total" },
  { label: "Vapi",      sub: "platform fee",     v: -7.05 },
  { label: "SMS",       sub: "summaries ×2",     v: -5.26 },
  { label: "TTS",       sub: "Etta's voice",     v: -2.82 },
  { label: "Twilio",    sub: "the calls",        v: -1.97 },
  { label: "LLM",       sub: "Haiku, cached",    v: -1.74 },
  { label: "Stripe",    sub: "2.9% + 30¢",       v: -1.43 },
  { label: "STT",       sub: "Deepgram",         v: -1.13 },
  { label: "Margin",    sub: "what you keep",    v: 17.60, kind: "total" },
];

const band = plotW / steps.length, bw = Math.min(74, band - 32);
let run = 0, bars = [], connectors = [];
steps.forEach((s, i) => {
  const cx = M.left + band * i + band / 2, x = cx - bw / 2;
  let top, bot;
  if (s.kind === "total") { top = s.v; bot = 0; run = s.v; }
  else { top = run; bot = run + s.v; run = bot; }
  bars.push({ ...s, i, x, cx, yTop: y(Math.max(top, bot)), yBot: y(Math.min(top, bot)), after: run });
  if (i < steps.length - 1 && s.kind !== undefined || i < steps.length - 1)
    connectors.push({ x1: cx + bw / 2, x2: M.left + band * (i + 1) + band / 2 - bw / 2, y: y(run) });
});

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const money = (v) => (v < 0 ? "−" : "") + "$" + Math.abs(v).toFixed(2);

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">
<style>
  :root{--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;
        --cost:#2a78d6;--total:#52514e;--good:#0ca30c;--bad:#d03b3b;--chip:#f0efec}
  @media (prefers-color-scheme:dark){:root{--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;
        --grid:#2c2c2a;--axis:#383835;--cost:#3987e5;--total:#c3c2b7;--good:#0ca30c;--bad:#d03b3b;--chip:#26262410}}
  .t{fill:var(--ink);font-size:27px;font-weight:650;letter-spacing:-.3px}
  .st{fill:var(--ink2);font-size:15px}
  .ax{fill:var(--muted);font-size:12.5px}
  .cat{fill:var(--ink);font-size:14px;font-weight:600}
  .sub{fill:var(--muted);font-size:11.5px}
  .val{fill:var(--ink);font-size:14.5px;font-weight:650}
  .pctl{fill:var(--muted);font-size:11px}
  .note{fill:var(--ink2);font-size:13.5px}
  .noteb{fill:var(--ink);font-size:13.5px;font-weight:650}
</style>
<rect width="${W}" height="${H}" fill="var(--surface)"/>
<text class="t" x="${M.left}" y="52">Where one subscriber's $39 goes each month</text>
<text class="st" x="${M.left}" y="80">Daily plan · 4.5-minute calls · 2 SMS recipients · 80% answer rate · % figures are share of revenue</text>
<text class="st" x="${M.left}" y="102" fill="var(--muted)">Modelled from vendor list prices, Aug 2026 — scripts/unit-economics.mjs</text>\n`;

// gridlines
for (let v = 0; v <= YMAX; v += 10) {
  svg += `<line x1="${M.left}" x2="${W - M.right}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/>
<text class="ax" x="${M.left - 12}" y="${y(v) + 4}" text-anchor="end">$${v}</text>\n`;
}
// connectors
for (const c of connectors)
  svg += `<line x1="${c.x1}" x2="${c.x2}" y1="${c.y}" y2="${c.y}" stroke="var(--axis)" stroke-width="1.5" stroke-dasharray="3 3"/>\n`;

// bars + labels
for (const b of bars) {
  const h = Math.max(b.yBot - b.yTop, 3);
  const fill = b.kind === "total" ? (b.label === "Margin" ? "var(--good)" : "var(--total)") : "var(--cost)";
  svg += `<rect x="${b.x.toFixed(1)}" y="${b.yTop.toFixed(1)}" width="${bw}" height="${h.toFixed(1)}" rx="4" fill="${fill}"/>\n`;
  svg += `<text class="val" x="${b.cx}" y="${(b.yTop - 20).toFixed(1)}" text-anchor="middle">${money(b.v)}</text>\n`;
  svg += `<text class="pctl" x="${b.cx}" y="${(b.yTop - 7).toFixed(1)}" text-anchor="middle">${(Math.abs(b.v) / 39 * 100).toFixed(1)}%</text>\n`;
  const ly = M.top + plotH + 26;
  svg += `<text class="cat" x="${b.cx}" y="${ly}" text-anchor="middle">${esc(b.label)}</text>
<text class="sub" x="${b.cx}" y="${ly + 17}" text-anchor="middle">${esc(b.sub)}</text>\n`;
}
svg += `<line x1="${M.left}" x2="${W - M.right}" y1="${y(0)}" y2="${y(0)}" stroke="var(--axis)" stroke-width="1.5"/>\n`;

// footer: the first-month reality, kept OUT of the waterfall on purpose
const fy = H - 116;
svg += `<line x1="${M.left}" x2="${W - M.right}" y1="${fy - 34}" y2="${fy - 34}" stroke="var(--grid)" stroke-width="1"/>
<circle cx="${M.left + 6}" cy="${fy - 4}" r="5" fill="var(--good)"/>
<text class="note" x="${M.left + 20}" y="${fy}"><tspan class="noteb">$17.60 kept</tspan> — 45% gross margin, every steady-state month.</text>
<circle cx="${M.left + 6}" cy="${fy + 26}" r="5" fill="var(--bad)"/>
<text class="note" x="${M.left + 20}" y="${fy + 30}"><tspan class="noteb">−$5.31 in month one.</tspan> Each paying customer also carries $22.91 of trial burn (14 free days at 40% conversion), so</text>
<text class="note" x="${M.left + 20}" y="${fy + 50}">it takes ~1.3 months of margin to break even — before any acquisition cost.</text>
<text class="sub" x="${M.left + 20}" y="${fy + 74}">Trial burn is amortised across a customer's lifetime, not a monthly outflow — which is why it sits outside the waterfall.</text>
</svg>`;

writeFileSync("/home/user/etta/docs/cash-flow.svg", svg);
console.log("wrote docs/cash-flow.svg", svg.length, "bytes");
