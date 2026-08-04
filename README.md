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
| `supabase/functions/call-events/` | Vapi webhook: call outcomes, family summary texts (SMS from Etta's own number — no app, no inbox), no-answer retries + escalation, inbound consent calls, immediate in-call revocation, and the call's time budget (wind-down notes injected mid-call, timed to whatever ceiling that call was placed with) |
| `supabase/functions/signup/` | Public signup: creates family/senior/schedule (pending consent) and returns a Stripe Checkout URL |
| `supabase/functions/fam/` | The family's no-login web view — magic link, 14-day mood strip, per-call cards |
| `supabase/functions/addons/` | "Your plan" (`/m/<token>`): add or drop a second parent, evening calls, medication reminders, care report, call archive, note recipients, occasion calls, concierge — and split the bill with siblings |
| `supabase/functions/report/` | The printable monthly care report (`/r/<token>`), the page you take to the appointment |
| `supabase/functions/share/` | A sibling's share of the bill (`/split/<invite token>`) — their own card, credited to the account holder |
| `supabase/functions/care-reports/`, `supabase/functions/retention-sweep/` | Daily cron: send the monthly report on the 1st; delete call audio after 30 days (a year with the archive add-on) |
| `supabase/functions/_shared/` | The price list (`catalog.ts`), Stripe calls, SMS, form validation, the shared page shell |
| `supabase/functions/stripe-webhook/`, `supabase/functions/billing/` | Subscription sync (and the no-consent-no-charge rules), plus the customer-portal redirect |
| `agent/etta-system-prompt.md` | Etta's conversation design — disclosure, tone, question bank, safety, scam protection, revocation |
| `agent/vapi-assistant.json` | The Vapi assistant definition, incl. structured post-call analysis schema and the 7-minute hard cap on call length |
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
- [x] Self-serve signup + senior-initiated recorded consent call
- [x] Family web view (magic link, no login) with 14-day mood trend
- [x] Stripe subscriptions: $19 (3×/week), $39 (daily) and $69 (Companion),
      14-day trial, no charge until the senior consents, auto-cancel on decline
      or revocation
- [x] Add-ons, bought by the family on their own page and never mentioned in a
      call: second parent ($15), evening call ($19), medication reminders ($9),
      monthly care report ($9), call archive ($6), extra note recipients ($5
      each), occasion calls ($5) and concierge setup ($49)
- [x] Siblings splitting the bill — each on their own card, credited to the
      account holder's next invoice
- [x] Recording retention: audio deleted after 30 days unless the archive
      add-on is held
- [ ] `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` Supabase secrets so checkout works
- [ ] Rename the Stripe account's public/statement name off "funshirts.us"
- [x] Twilio: off trial, A2P 10DLC brand + campaign approved; call → summary →
      text verified end to end (Sole Proprietor brand — a summary is 8 segments
      against a 1 seg/sec cap, see the runbook before scaling)
- [ ] TCPA attorney sign-off on the consent flow (launch blocker)
- [ ] Create the Stripe prices for the new plan and add-ons, or let the code
      create them on first sale (see the runbook)
- [ ] Weekly trend reports, signup rate limiting, reply-to-rotate links

## Principles that are load-bearing

Etta always says she's an AI. The senior's own recorded consent gates every
call, and "stop calling me," said to Etta on any call, ends the service
immediately — the code enforces both. No sales content ever appears inside a
call: everything a family can buy is bought on the family page, and a senior
is asked exactly one thing, ever, which is whether they consent.

Two corollaries the add-ons had to respect. A call to a **new** person is
never billed before that person's own recorded yes — a second parent's add-on
is created unbilled and only becomes a charge when they say yes themselves.
And with two parents on one account, one parent's "stop calling me" ends
**their** calls and their part of the bill, not the other parent's.
