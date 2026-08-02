// page — the shell the token-linked pages share.
//
// The family view (fam) predates this and keeps its own richer stylesheet;
// these are the pages that grew out of it — manage your plan, the monthly
// care report, a sibling's share of the bill. Same paper, same ink, same
// terracotta, so a family moving between them never feels handed off.
//
// All three are served through ettacalls.com proxies rather than directly:
// Supabase rewrites text/html to text/plain on *.supabase.co, which shows a
// browser a wall of source.

export const SITE = "https://www.ettacalls.com";

export function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const SHARED_CSS = `
:root{
  --paper:#F8F1E5; --paper-deep:#F0E5D0; --ink:#2E2014; --ink-soft:#6E5B45;
  --terra:#BC5127; --terra-deep:#8E3A18; --sage:#77875F; --sage-deep:#5C6B47;
  --gold:#D9A441; --gold-deep:#96701D;
  --card:#FFFDF7; --line:rgba(46,32,20,.14); --line-firm:rgba(46,32,20,.26);
  --serif:"Fraunces",Georgia,serif; --sans:"Karla",system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0}
body{background:var(--paper);color:var(--ink);font:16px/1.6 var(--sans);
  -webkit-font-smoothing:antialiased;max-width:600px;margin:0 auto;padding:26px 18px 56px}
h1,h2,h3{font-family:var(--serif);font-weight:500;line-height:1.15}
a{color:var(--terra-deep)}
.mast{display:flex;align-items:baseline;justify-content:space-between;
  padding-bottom:12px;border-bottom:1.5px solid var(--ink);margin-bottom:20px}
.logo{font-family:var(--serif);font-size:23px;font-weight:600;letter-spacing:-.01em;
  color:var(--ink);text-decoration:none}
.logo span{color:var(--terra)}
.mast .kick{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--ink-soft)}
h1{font-size:28px;letter-spacing:-.015em}
.lede{color:var(--ink-soft);font-size:15px;margin:8px 0 0;max-width:34em}
.panel{background:var(--card);border:1px solid var(--line);border-radius:4px;
  padding:18px;margin-top:16px;
  box-shadow:0 1px 0 rgba(46,32,20,.05),0 8px 22px -18px rgba(46,32,20,.5)}
.eyebrow{display:flex;align-items:center;gap:9px;font-size:10.5px;letter-spacing:.16em;
  text-transform:uppercase;color:var(--ink-soft);margin-bottom:14px}
.eyebrow::after{content:"";flex:1;height:1px;background:var(--line)}
.row{display:flex;align-items:center;gap:12px;padding:10px 2px;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:none}
.row .lbl{flex:1;font-size:14.5px}
.row .val{font-family:var(--serif);font-size:16px;font-weight:500;white-space:nowrap}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;
  font:600 15px/1 var(--sans);border-radius:3px;padding:12px 16px;text-decoration:none;
  border:1px solid var(--ink);background:var(--ink);color:var(--paper)}
.btn.ghost{background:var(--card);color:var(--ink);border-color:var(--line-firm)}
.btn.quiet{background:transparent;color:var(--ink-soft);border-color:transparent;
  padding:8px 2px;font-weight:500;text-decoration:underline}
.btn:disabled{opacity:.45;cursor:not-allowed}
.flash{display:flex;gap:11px;border:1px solid var(--sage);background:#EDF1E6;
  border-radius:3px;padding:13px 15px;font-size:14.5px;margin-bottom:18px}
.flash.warn{border-color:var(--terra);background:#F6E3D8}
.foot{margin-top:26px;padding-top:18px;border-top:1px solid var(--line);
  color:var(--ink-soft);font-size:12.5px;line-height:1.65}
.foot b{color:var(--ink)}
label.f{display:flex;flex-direction:column;gap:6px;font-size:13.5px;color:var(--ink-soft);
  margin-top:12px}
input[type=text],input[type=tel],input[type=date],input[type=number],select,textarea{
  width:100%;font:16px/1.4 var(--sans);color:var(--ink);background:var(--paper);
  border:1.5px solid var(--line);border-radius:8px;padding:11px 13px;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--terra);background:var(--card)}
textarea{resize:vertical;min-height:84px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}
@media(max-width:520px){.pair{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

export function page(
  status: number,
  body: string,
  title: string,
  extraCss = "",
): Response {
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
<style>${SHARED_CSS}${extraCss}</style></head><body>${body}</body></html>`,
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

export function masthead(kicker: string): string {
  return `<div class="mast"><a class="logo" href="${SITE}">etta<span>.</span></a>
<span class="kick">${esc(kicker)}</span></div>`;
}

export function notFound(kicker = "Etta"): Response {
  return page(
    404,
    `${masthead(kicker)}<h1>This link isn't active.</h1>
<p class="lede">It may have been rotated for privacy. Check the most recent text
from Etta for the current link, or reply to Etta's number and we'll help.</p>`,
    "Etta — link not active",
  );
}

/** A capability token as minted by `encode(gen_random_bytes(12),'hex')`. */
export function validToken(token: string): boolean {
  return /^[a-f0-9]{24}$/.test(token);
}
