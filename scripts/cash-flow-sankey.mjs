#!/usr/bin/env node
// Renders docs/cash-flow-sankey.svg — one Daily subscriber-month as a flow
// diagram: $39 of revenue splitting into cost buckets, then into the individual
// vendors, with the margin branch surviving to the right edge.
//
// Figures come from scripts/unit-economics.mjs; re-run both if vendor rates move.
//
// Two hues only, and deliberately so. This is a POLARITY encoding — money kept
// vs money spent — which the palette's diverging pair (blue <-> red) covers. The
// obvious third colour, green for margin, is not available: green vs red measures
// CVD deltaE 4.1 (deutan), the classic red/green collision, and fails the
// separation gate outright. Blue for what stays, red for what leaves, clears every
// check in both modes (worst pair deltaE 23.8 light / 25.7 dark).

import { writeFileSync } from "fs";

const REVENUE = 39.0;

// [label, sublabel, value, parent]. Parent null = top level.
const NODES = [
  ["Revenue", "Daily plan", REVENUE, null],

  ["Voice stack", null, 14.71, "Revenue"],
  ["Family texts", null, 5.26, "Revenue"],
  ["Payments", null, 1.43, "Revenue"],
  ["Gross margin", null, 17.60, "Revenue"],

  ["Vapi", "platform fee", 7.05, "Voice stack"],
  ["TTS", "Etta's voice", 2.82, "Voice stack"],
  ["Twilio", "the calls", 1.97, "Voice stack"],
  ["LLM", "Haiku, cached", 1.74, "Voice stack"],
  ["STT", "Deepgram", 1.13, "Voice stack"],
  ["SMS summaries", "\u00d72 recipients", 5.26, "Family texts"],
  ["Stripe", "2.9% + 30\u00a2", 1.43, "Payments"],
  ["Trial repayment", "amortised, 12-mo tenure", 1.91, "Gross margin"],
  ["Retained", "free cash", 15.69, "Gross margin"],
];

// ---------------------------------------------------------------------------
const W = 1240, H = 940;
const M = { top: 150, right: 250, bottom: 96, left: 132 };
const plotW = W - M.left - M.right, plotH = H - M.top - M.bottom;
const COL_X = [0, 0.42, 0.84].map((f) => M.left + f * plotW);
const NODE_W = 19;
// Vertical gap between sibling nodes. It has to be big enough that two adjacent
// LEAF label blocks (name + value + sublabel, ~34px) don't collide, because the
// small vendors sit next to each other and their bars are only a few px tall.
const GAP = 30;
// The tallest column is the 9 leaves, so 8 gaps come out of the drawing height
// before anything is scaled — otherwise the diagram runs off the bottom.
const LEAF_GAPS = 8;
const scale = (v) => (v / REVENUE) * (plotH - LEAF_GAPS * GAP);

const byName = new Map();
for (const [label, sub, value, parent] of NODES) {
  byName.set(label, { label, sub, value, parent, children: [] });
}
for (const n of byName.values()) if (n.parent) byName.get(n.parent).children.push(n);

const root = byName.get("Revenue");
const depth = (n) => (n.parent ? depth(byName.get(n.parent)) + 1 : 0);

// Lay out each column top-down. A parent's children are stacked in the order
// declared, and the parent is centred on the span its children occupy — that is
// what keeps the ribbons from crossing.
function layout(node, top) {
  node.h = scale(node.value);
  if (!node.children.length) { node.y = top; return top + node.h + GAP; }
  let cursor = top;
  for (const c of node.children) cursor = layout(c, cursor);
  const first = node.children[0], last = node.children[node.children.length - 1];
  node.y = (first.y + last.y + last.h) / 2 - node.h / 2;
  return cursor;
}
layout(root, M.top);

// The cost branch is red, the kept branch blue. Inherit down the tree so a leaf
// never disagrees with the bucket it came from.
const tint = (n) => (n.label === "Revenue" || n.label === "Gross margin" ||
  n.parent === "Gross margin") ? "keep" : "spend";

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = (v) => "$" + v.toFixed(2);
const pctOf = (v) => ((v / REVENUE) * 100).toFixed(1) + "%";

// Ribbon: a horizontal band from the parent's right edge to the child's left,
// its thickness the child's value, eased with a cubic so it reads as flow.
function ribbon(x0, y0, x1, y1, h) {
  const mx = (x0 + x1) / 2;
  return `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1} ` +
         `L${x1},${y1 + h} C${mx},${y1 + h} ${mx},${y0 + h} ${x0},${y0 + h} Z`;
}

let links = "", nodes = "", labels = "";
for (const n of byName.values()) {
  const d = depth(n);
  const x = COL_X[d];
  const k = tint(n);

  // Ribbons out of this node, stacked against its own left-to-right face.
  let off = 0;
  for (const c of n.children) {
    links += `<path d="${ribbon(x + NODE_W, n.y + off, COL_X[d + 1], c.y, c.h)}" ` +
             `fill="var(--${tint(c)})" opacity=".34"/>\n`;
    off += c.h;
  }

  nodes += `<rect x="${x.toFixed(1)}" y="${n.y.toFixed(1)}" width="${NODE_W}" ` +
           `height="${Math.max(n.h, 2).toFixed(1)}" rx="2.5" fill="var(--${k})"/>\n`;

  // Leaves label to the right; everything else labels inside, to the right of
  // its own bar, the way the reference diagram does.
  const isRoot = !n.parent;
  const lx = isRoot ? x - 12 : x + NODE_W + 12;
  const anchor = isRoot ? "end" : "start";
  const cy = n.y + Math.max(n.h, 2) / 2;
  const two = n.sub ? -7 : 4;
  labels += `<text class="nl" x="${lx}" y="${(cy + two).toFixed(1)}" text-anchor="${anchor}">${esc(n.label)}</text>\n`;
  labels += `<text class="nv" x="${lx}" y="${(cy + (n.sub ? 9 : 19)).toFixed(1)}" text-anchor="${anchor}">${money(n.value)} <tspan class="np">(${pctOf(n.value)})</tspan></text>\n`;
  if (n.sub) labels += `<text class="ns" x="${lx}" y="${(cy + 23).toFixed(1)}" text-anchor="${anchor}">${esc(n.sub)}</text>\n`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">
<style>
  :root{--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;
        --keep:#2a78d6;--spend:#d03b3b}
  @media (prefers-color-scheme:dark){:root{--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;
        --grid:#2c2c2a;--keep:#3987e5;--spend:#d03b3b}}
  .t{fill:var(--ink);font-size:27px;font-weight:650;letter-spacing:-.3px}
  .st{fill:var(--ink2);font-size:15px}
  .stm{fill:var(--muted);font-size:13.5px}
  .nl{fill:var(--ink);font-size:13.5px;font-weight:650}
  .nv{fill:var(--ink2);font-size:12.5px}
  .np{fill:var(--muted)}
  .ns{fill:var(--muted);font-size:11px}
  .key{fill:var(--ink2);font-size:13px}
  .note{fill:var(--muted);font-size:12.5px}
</style>
<rect width="${W}" height="${H}" fill="var(--surface)"/>
<text class="t" x="${M.left}" y="52">Where one subscriber's $39 goes each month</text>
<text class="st" x="${M.left}" y="80">Daily plan · 4.5-minute calls · 2 SMS recipients · 80% answer rate</text>
<text class="stm" x="${M.left}" y="102">Modelled from vendor list prices, Aug 2026 — scripts/unit-economics.mjs</text>

<rect x="${M.left}" y="116" width="11" height="11" rx="2" fill="var(--keep)"/>
<text class="key" x="${M.left + 18}" y="126">money kept</text>
<rect x="${M.left + 112}" y="116" width="11" height="11" rx="2" fill="var(--spend)"/>
<text class="key" x="${M.left + 130}" y="126">money that leaves</text>

${links}${nodes}${labels}
<text class="note" x="${M.left}" y="${H - 40}">Trial burn ($22.91 per paying customer, at 14 free days and 40% conversion) is spread over an assumed 12 months of tenure. Shorter tenure means a bigger slice.</text>
<text class="note" x="${M.left}" y="${H - 20}">Gross margin is 45.1% of revenue; retained free cash after the trial is repaid is 40.2%.</text>
</svg>`;

writeFileSync("/home/user/etta/docs/cash-flow-sankey.svg", svg);
const leaves = [...byName.values()].filter((n) => !n.children.length);
console.log("wrote docs/cash-flow-sankey.svg —",
  "leaf total $" + leaves.reduce((s, n) => s + n.value, 0).toFixed(2), "vs revenue $" + REVENUE.toFixed(2));
