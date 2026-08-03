// Renders brand/video/etta-text-message-screen.png: the family summary text
// exactly as Etta sends it, on an iOS Messages thread with the real mark as
// the contact avatar. This is the on-screen brand asset for video work, so
// the bubble copy mirrors the family-note template built in
// supabase/functions/call-events/index.ts — keep the two in step.
//
//   npm i playwright && node brand/video/make-text-message-screen.js

const fs = require('fs');
const { chromium } = require('playwright');

const OUT = __dirname;
const mark = fs.readFileSync(`${__dirname}/../etta-mark-light-512.png`).toString('base64');

// The exact family-note shape built in supabase/functions/call-events/index.ts:
//   signal + "Etta's check-in with <name>" + mood word + (minutes)
//   chips line · summary · "Keeping an eye on:" · full-picture link · "— Etta"
const body = `🟢 Etta's check-in with Margaret — bright (6 min)
😴 slept well · 🥣 ate · 💊 taken · Mood 4/5

She was up before the sun and sounded like herself — oatmeal with the blueberries from next door, then out to water the tomatoes. The knee grumbled on the stairs, nothing new. She asked me to tell you she keeps your photos on the fridge.

Keeping an eye on:
• Left knee stiffer on stairs — mentioned twice this week

Full picture: ettacalls.com/f/mgw4k2
— Etta
Reply STOP to end texts.`;

const html = `
<style>
  @page { margin:0 }
  html,body{margin:0;padding:0;background:#000}
  body{width:900px;height:1600px;font-family:-apple-system,"Helvetica Neue",Helvetica,Arial,"Noto Color Emoji",sans-serif;
       -webkit-font-smoothing:antialiased}
  .screen{width:900px;height:1600px;background:#fff;display:flex;flex-direction:column}
  .status{display:flex;justify-content:space-between;align-items:center;
          padding:26px 58px 6px;font-size:30px;font-weight:600;color:#000;letter-spacing:.3px}
  .status .right{display:flex;gap:10px;align-items:center;font-size:26px}
  .nav{display:flex;flex-direction:column;align-items:center;gap:10px;
       padding:14px 0 22px;border-bottom:1px solid rgba(0,0,0,.14);
       background:rgba(249,249,249,.94);position:relative}
  .back{position:absolute;left:34px;top:52px;color:#007AFF;font-size:44px;font-weight:300}
  .avatar{width:104px;height:104px;border-radius:50%;object-fit:cover;
          box-shadow:0 1px 3px rgba(0,0,0,.18)}
  .who{font-size:27px;color:#000;font-weight:500;letter-spacing:.1px}
  .who span{color:#8A8A8E;font-size:22px;margin-left:6px}
  .thread{flex:1;padding:34px 30px 0;display:flex;flex-direction:column;gap:20px;overflow:hidden}
  .stamp{text-align:center;font-size:22px;color:#8A8A8E;margin:6px 0 14px}
  .stamp b{color:#3C3C43;font-weight:600}
  .row{display:flex}
  .row.in{justify-content:flex-start}
  .row.out{justify-content:flex-end}
  .bubble{max-width:80%;padding:22px 28px;border-radius:34px;font-size:29px;line-height:1.42;
          white-space:pre-wrap;word-wrap:break-word}
  .in .bubble{background:#E9E9EB;color:#000;border-bottom-left-radius:10px}
  .out .bubble{background:#248BF5;color:#fff;border-bottom-right-radius:10px}
  .delivered{text-align:right;font-size:20px;color:#8A8A8E;margin:-10px 8px 0}
  .composer{display:flex;align-items:center;gap:18px;padding:22px 30px 18px;
            border-top:1px solid rgba(0,0,0,.12);background:rgba(249,249,249,.94)}
  .plus{width:56px;height:56px;border-radius:50%;background:#E9E9EB;color:#8A8A8E;
        font-size:38px;font-weight:300;display:flex;align-items:center;justify-content:center}
  .field{flex:1;height:58px;border:1px solid rgba(0,0,0,.16);border-radius:29px;
         display:flex;align-items:center;padding:0 24px;color:#B0B0B4;font-size:27px}
  .homebar{height:44px;display:flex;align-items:center;justify-content:center;background:rgba(249,249,249,.94)}
  .homebar i{display:block;width:280px;height:8px;border-radius:4px;background:#000;opacity:.85}
</style>
<div class="screen">
  <div class="status"><div>7:04</div><div class="right">▮▮▮ ⌁ ▊</div></div>
  <div class="nav">
    <div class="back">‹</div>
    <img class="avatar" src="data:image/png;base64,${mark}">
    <div class="who">Etta <span>›</span></div>
  </div>
  <div class="thread">
    <div class="stamp"><b>Today</b> 7:04 AM</div>
    <div class="row in"><div class="bubble">${body.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div></div>
  </div>
  <div class="composer">
    <div class="plus">+</div>
    <div class="field">iMessage</div>
  </div>
  <div class="homebar"><i></i></div>
</div>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 1600 }, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: `${OUT}/etta-text-message-screen.png` });
  await browser.close();
  console.log('written');
})();
