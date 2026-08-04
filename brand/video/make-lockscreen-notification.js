// Renders brand/video/etta-lockscreen-notification.png: the arrival of an Etta
// check-in as a single lock-screen banner, with the real mark as the app icon.
//
// This is the video-safe companion to make-text-message-screen.js. Generative
// video cannot render a paragraph — a full thread comes back as garbled text
// with the brand name misspelled — so the on-screen asset for any shot where a
// model draws the screen has to be short enough to survive. One line does.
//
//   npm i playwright && node brand/video/make-lockscreen-notification.js

const fs = require('fs');
const { chromium } = require('playwright');

const OUT = __dirname;
const mark = fs.readFileSync(`${__dirname}/../etta-mark-light-512.png`).toString('base64');

// Deliberately one sentence. It is still a true send: the green signal and the
// mood word are exactly what the family note leads with.
const HEADLINE = 'Margaret sounded bright today.';

const html = `
<style>
  html,body{margin:0;padding:0}
  body{width:900px;height:1600px;
       font-family:-apple-system,"Helvetica Neue",Helvetica,Arial,"Noto Color Emoji",sans-serif;
       -webkit-font-smoothing:antialiased}
  .screen{position:relative;width:900px;height:1600px;overflow:hidden;
          background:
            radial-gradient(120% 80% at 20% 0%, #6B5B47 0%, rgba(107,91,71,0) 60%),
            radial-gradient(140% 90% at 90% 100%, #3A2C1E 0%, rgba(58,44,30,0) 55%),
            linear-gradient(160deg,#4A3A2A 0%,#2A1E14 100%)}
  .glow{position:absolute;inset:0;
        background:radial-gradient(60% 40% at 50% 18%, rgba(248,241,229,.20), rgba(248,241,229,0) 70%)}
  .time{position:absolute;top:210px;left:0;right:0;text-align:center;color:#fff;
        font-size:180px;font-weight:200;letter-spacing:-4px;line-height:1;
        text-shadow:0 2px 24px rgba(0,0,0,.35)}
  .date{position:absolute;top:150px;left:0;right:0;text-align:center;color:rgba(255,255,255,.92);
        font-size:34px;font-weight:500;letter-spacing:.2px}
  .card{position:absolute;left:44px;right:44px;top:560px;
        background:rgba(240,238,236,.78);backdrop-filter:blur(30px);
        border-radius:44px;padding:30px 34px 34px;
        box-shadow:0 12px 40px rgba(0,0,0,.28)}
  .head{display:flex;align-items:center;gap:18px;margin-bottom:14px}
  .icon{width:62px;height:62px;border-radius:15px;object-fit:cover;
        box-shadow:0 1px 3px rgba(0,0,0,.25)}
  .app{flex:1;font-size:27px;font-weight:600;letter-spacing:1.4px;color:#3C3C43;text-transform:uppercase}
  .ago{font-size:26px;color:#6B6B70}
  .line{font-size:40px;line-height:1.28;color:#000;font-weight:500}
  .homebar{position:absolute;bottom:26px;left:50%;transform:translateX(-50%);
           width:280px;height:9px;border-radius:5px;background:#fff;opacity:.75}
</style>
<div class="screen">
  <div class="glow"></div>
  <div class="date">Tuesday, 3 August</div>
  <div class="time">7:04</div>
  <div class="card">
    <div class="head">
      <img class="icon" src="data:image/png;base64,${mark}">
      <div class="app">Etta</div>
      <div class="ago">now</div>
    </div>
    <div class="line">🟢 ${HEADLINE}</div>
  </div>
  <div class="homebar"></div>
</div>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 1600 }, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: `${OUT}/etta-lockscreen-notification.png` });
  await browser.close();
  console.log('written');
})();
