// Builds the Etta wordmark as overlay-ready assets: a true-vector SVG with the
// letterforms converted to paths, and transparent PNGs at 4000px wide.
//
// The wordmark is "etta" plus a terracotta full stop, set in Fraunces SemiBold
// at -0.02em tracking — the same treatment as `.logo` in styles.css. Converting
// to paths means the SVG needs no font installed to render correctly anywhere.
//
//   npm i opentype.js playwright
//   node brand/video/make-wordmark.js path/to/Fraunces-SemiBold.ttf
//
// Fraunces is OFL-licensed; the TTF is fetched rather than vendored:
//   https://fonts.gstatic.com/s/fraunces/v38/...ttf  (see Google Fonts CSS API)

const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');

const OUT = __dirname;
const FONT = process.argv[2];
if (!FONT || !fs.existsSync(FONT)) {
  console.error('Usage: node make-wordmark.js <Fraunces-SemiBold.ttf>');
  process.exit(1);
}

// styles.css: --ink, --terra, --paper
const INK = '#2E2014';
const TERRA = '#BC5127';
const PAPER = '#F8F1E5';

const FONT_SIZE = 1000;          // path units; the SVG is scaled by viewBox
const TRACKING = -0.02;          // letter-spacing: -.02em

const font = opentype.parse(fs.readFileSync(FONT));

/** Lay out a string with em-based tracking, returning per-glyph paths. */
function layout(text, startX, y) {
  const out = [];
  let x = startX;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const glyph = font.charToGlyph(ch);
    out.push({ ch, d: glyph.getPath(x, y, FONT_SIZE).toPathData(3) });
    x += (glyph.advanceWidth / font.unitsPerEm) * FONT_SIZE + FONT_SIZE * TRACKING;
  }
  return { glyphs: out, endX: x };
}

const PAD = 60;
const baseline = FONT_SIZE;
const word = layout('etta', PAD, baseline);
const dot = layout('.', word.endX, baseline);

// Tight bounds across every glyph, so the exported art has no dead margin.
function bounds(text, startX) {
  let x = startX;
  let b = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  for (const ch of text) {
    const glyph = font.charToGlyph(ch);
    const gb = glyph.getPath(x, baseline, FONT_SIZE).getBoundingBox();
    b.x1 = Math.min(b.x1, gb.x1); b.y1 = Math.min(b.y1, gb.y1);
    b.x2 = Math.max(b.x2, gb.x2); b.y2 = Math.max(b.y2, gb.y2);
    x += (glyph.advanceWidth / font.unitsPerEm) * FONT_SIZE + FONT_SIZE * TRACKING;
  }
  return b;
}
let minX, minY, maxX, maxY;
const wb = bounds('etta', PAD);
const db = bounds('.', word.endX);
minX = Math.min(wb.x1, db.x1); minY = Math.min(wb.y1, db.y1);
maxX = Math.max(wb.x2, db.x2); maxY = Math.max(wb.y2, db.y2);

const W = maxX - minX;
const H = maxY - minY;

function svg(wordColour) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${W} ${H}" width="${Math.round(W)}" height="${Math.round(H)}" role="img" aria-label="etta">
  <title>etta</title>
  <g fill="${wordColour}">${word.glyphs.map((g) => `<path d="${g.d}"/>`).join('')}</g>
  <g fill="${TERRA}">${dot.glyphs.map((g) => `<path d="${g.d}"/>`).join('')}</g>
</svg>`;
}

const variants = [
  ['etta-wordmark-ink.svg', INK],       // for light footage
  ['etta-wordmark-paper.svg', PAPER],   // for dark footage
  ['etta-wordmark-white.svg', '#FFFFFF'],
];
for (const [name, colour] of variants) {
  fs.writeFileSync(path.join(OUT, name), svg(colour));
  console.log('wrote', name);
}

// Transparent PNGs at 4000px wide — enough for a 4K overlay with headroom.
(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const TARGET_W = 4000;
  const scale = TARGET_W / W;
  for (const [name, colour] of variants) {
    const png = name.replace('.svg', '.png');
    const page = await browser.newPage({
      viewport: { width: Math.round(W), height: Math.round(H) },
      deviceScaleFactor: scale,
    });
    await page.setContent(
      `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>${svg(colour)}`,
      { waitUntil: 'load' },
    );
    await page.screenshot({ path: path.join(OUT, png), omitBackground: true });
    await page.close();
    console.log('wrote', png, `${TARGET_W}px wide`);
  }
  await browser.close();
})();
