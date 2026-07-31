# Etta — ettacalls.com

A warm, honest AI companion that calls your aging parent every day, has a real
conversation, and tells you how they're doing — with their knowledge and
consent, always. Full concept: [`business-description.md`](business-description.md).

## What's in this repo

| Path | What it is |
|---|---|
| `index.html`, `signup.html`, `how-it-works.html`, `pledge.html`, `pricing.html`, `faq.html`, `styles.css`, `app.js` | The site, with live self-serve signup (no waitlist): family fills the form, then the senior calls Etta from their own phone to give their recorded yes |
| `favicon.ico`, `assets/`, `site.webmanifest` | Site icons — the lowercase `e` wordmark with its terracotta period, in the paper/ink/terracotta palette |
| `brand/etta-instagram-profile.png` | Instagram profile picture (1024×1024, `etta.` wordmark, centred for the circular crop) |
| `supabase/migrations/` | Product database schema: families, seniors, append-only consent log, schedules, calls, summaries, escalations |
| `supabase/functions/place-due-calls/` | Scheduler (cron, every 10 min): timezone-aware "whose check-in time is it?", consent check, places calls via Vapi |
| `supabase/functions/call-events/` | Vapi webhook: call outcomes, family summary texts (SMS from Etta's own number — no app, no inbox), no-answer retries + escalation, immediate in-call revocation |
| `agent/etta-system-prompt.md` | Etta's conversation design — disclosure, tone, question bank, safety, scam protection, revocation |
| `agent/vapi-assistant.json` | The Vapi assistant definition, incl. structured post-call analysis schema |
| `docs/launch-runbook.md` | Step-by-step from here to the first real call (accounts, secrets, cron, consent script, legal gate) |
| `*.pdf` / `*.txt` | Market landscape and AI-disclosure-law research |

## Status

- [x] Marketing site + waitlist (live)
- [x] Product schema (applied to Supabase, RLS-locked to service role)
- [x] Call pipeline edge functions (deployed; dry-run until Vapi keys are set)
- [x] Conversation design v1
- [x] Vapi assistant + Twilio number (imported into Vapi) + cron schedule
- [x] First live pilot call completed end to end (2026-07-31)
- [x] Summary delivery by SMS from Etta's own number (no email, no app — either side)
- [ ] `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` Supabase secrets so summary texts send automatically
- [ ] Twilio: upgrade off trial + A2P 10DLC registration before real families
- [ ] TCPA attorney sign-off on the consent flow (launch blocker)
- [ ] Family dashboard, trend reports, billing

## Principles that are load-bearing

Etta always says she's an AI. The senior's own recorded consent gates every
call, and "stop calling me," said to Etta on any call, ends the service
immediately — the code enforces both. No sales content ever appears inside a
call.
