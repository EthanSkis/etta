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

/**
 * Lay out a sequence of coloured runs on one baseline, with em-based tracking,
 * returning path data per run plus the tight bounding box across all of them.
 *
 * A run is {text, accent}: accent runs take the terracotta, everything else
 * takes the lockup's word colour. That is what lets "etta." and
 * "ettacalls.com" share one code path — in both, the accent run is the dot.
 */
function layoutRuns(runs, startX, baseline) {
  let x = startX;
  const b = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  const laid = runs.map((run) => {
    const paths = [];
    for (const ch of run.text) {
      const glyph = font.charToGlyph(ch);
      const path = glyph.getPath(x, baseline, FONT_SIZE);
      paths.push(path.toPathData(3));
      const gb = path.getBoundingBox();
      b.x1 = Math.min(b.x1, gb.x1); b.y1 = Math.min(b.y1, gb.y1);
      b.x2 = Math.max(b.x2, gb.x2); b.y2 = Math.max(b.y2, gb.y2);
      x += (glyph.advanceWidth / font.unitsPerEm) * FONT_SIZE + FONT_SIZE * TRACKING;
    }
    return { paths, accent: !!run.accent };
  });
  return { runs: laid, bounds: b };
}

const PAD = 60;
const BASELINE = FONT_SIZE;

/** A lockup: the laid-out art plus the geometry every exporter needs. */
function lockup(label, runs) {
  const { runs: laid, bounds: b } = layoutRuns(runs, PAD, BASELINE);
  return {
    label,
    runs: laid,
    minX: b.x1, minY: b.y1,
    W: b.x2 - b.x1,
    H: b.y2 - b.y1,
  };
}

const WORDMARK = lockup('etta', [{ text: 'etta' }, { text: '.', accent: true }]);
// The domain reuses the brand's terracotta full stop as the dot of .com.
const DOMAIN = lockup('ettacalls.com', [
  { text: 'ettacalls' }, { text: '.', accent: true }, { text: 'com' },
]);

function paint(lk, wordColour) {
  return lk.runs
    .map((r) => `<g fill="${r.accent ? TERRA : wordColour}">${
      r.paths.map((d) => `<path d="${d}"/>`).join('')}</g>`)
    .join('');
}

function svg(lk, wordColour) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${lk.minX} ${lk.minY} ${lk.W} ${lk.H}" width="${Math.round(lk.W)}" height="${Math.round(lk.H)}" role="img" aria-label="${lk.label}">
  <title>${lk.label}</title>
  ${paint(lk, wordColour)}
</svg>`;
}

// Pill lockup: the wordmark on a fully-rounded plate, transparent outside it.
// A rectangle would fight the mark, which is a circle, and the round terminals
// of Fraunces; the radius is half the height so the ends are true semicircles
// rather than a rounded rectangle.
//
// Proportions are the ones that read as a badge rather than a button: the plate
// is 2.1x the height of the letterforms, and the side padding is 0.55x the
// plate height so the curve of the end clears the letters instead of pinching
// them. "etta." has no descenders, so the letterforms are centred on their own
// bounding box — the visual mass sits between baseline and ascender.
const PILL_PAD_Y = 0.55;   // x letterform height, per side
const PILL_PAD_X = 0.55;   // x plate height, per side

function svgPill(lk, plateColour, wordColour) {
  const padY = lk.H * PILL_PAD_Y;
  const plateH = lk.H + padY * 2;
  const padX = plateH * PILL_PAD_X;
  const plateW = lk.W + padX * 2;
  const x0 = lk.minX - padX;
  const y0 = lk.minY - padY;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${plateW} ${plateH}" width="${Math.round(plateW)}" height="${Math.round(plateH)}" role="img" aria-label="${lk.label}">
  <title>${lk.label}</title>
  <rect x="${x0}" y="${y0}" width="${plateW}" height="${plateH}" rx="${plateH / 2}" ry="${plateH / 2}" fill="${plateColour}"/>
  ${paint(lk, wordColour)}
</svg>`;
}

const variants = [
  ['etta-wordmark-ink.svg', () => svg(WORDMARK, INK)],       // for light footage
  ['etta-wordmark-paper.svg', () => svg(WORDMARK, PAPER)],   // for dark footage
  ['etta-wordmark-white.svg', () => svg(WORDMARK, '#FFFFFF')],
  // Plate lockups — drop straight onto footage of any brightness.
  ['etta-wordmark-pill-white.svg', () => svgPill(WORDMARK, '#FFFFFF', INK)],
  ['etta-wordmark-pill-paper.svg', () => svgPill(WORDMARK, PAPER, INK)],
  // Domain lockup, for end cards and lower thirds.
  ['ettacalls-com-ink.svg', () => svg(DOMAIN, INK)],
  ['ettacalls-com-paper.svg', () => svg(DOMAIN, PAPER)],
  ['ettacalls-com-white.svg', () => svg(DOMAIN, '#FFFFFF')],
];
for (const [name, build] of variants) {
  fs.writeFileSync(path.join(OUT, name), build());
  console.log('wrote', name);
}

// Transparent PNGs at 4000px wide — enough for a 4K overlay with headroom.
(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const TARGET_W = 4000;
  for (const [name, build] of variants) {
    const png = name.replace('.svg', '.png');
    const markup = build();
    // Read the art's own size back out so pill and bare lockups both land at
    // TARGET_W rather than the pill overshooting by its padding.
    const vw = Number(markup.match(/width="(\d+)"/)[1]);
    const vh = Number(markup.match(/height="(\d+)"/)[1]);
    const page = await browser.newPage({
      viewport: { width: vw, height: vh },
      deviceScaleFactor: TARGET_W / vw,
    });
    await page.setContent(
      `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>${markup}`,
      { waitUntil: 'load' },
    );
    await page.screenshot({ path: path.join(OUT, png), omitBackground: true });
    await page.close();
    console.log('wrote', png, `${TARGET_W}px wide`);
  }
  await browser.close();
})();
