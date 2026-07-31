# Etta — ettacalls.com

A warm, honest AI companion that calls your aging parent every day, has a real
conversation, and tells you how they're doing — with their knowledge and
consent, always. Full concept: [`business-description.md`](business-description.md).

## What's in this repo

| Path | What it is |
|---|---|
| `index.html`, `how-it-works.html`, `pledge.html`, `pricing.html`, `faq.html`, `styles.css`, `app.js` | The marketing site, with a live Supabase-backed waitlist modal |
| `supabase/migrations/` | Product database schema: families, seniors, append-only consent log, schedules, calls, summaries, escalations |
| `supabase/functions/place-due-calls/` | Scheduler (cron, every 10 min): timezone-aware "whose check-in time is it?", consent check, places calls via Vapi |
| `supabase/functions/call-events/` | Vapi webhook: call outcomes, family summary emails, no-answer retries + escalation, immediate in-call revocation |
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
- [ ] Supabase edge-function secrets → first test call ([runbook](docs/launch-runbook.md))
- [ ] Resend account for family summary emails
- [ ] Twilio: verify pilot phone number (trial), upgrade before real use
- [ ] TCPA attorney sign-off on the consent flow (launch blocker)
- [ ] Family dashboard, trend reports, billing

## Principles that are load-bearing

Etta always says she's an AI. The senior's own recorded consent gates every
call, and "stop calling me," said to Etta on any call, ends the service
immediately — the code enforces both. No sales content ever appears inside a
call.
