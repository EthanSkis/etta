# Etta launch runbook — from this repo to the first real call

The call pipeline is built and deployed. What remains are the accounts, keys,
and one recorded consent call per senior. Work through this top to bottom.

## Live state (as of 2026-07-31)

Already provisioned — steps 1, 3 and 4 below are ✅ done:

| Thing | Value |
|---|---|
| Vapi assistant "Etta" | `d7f28f40-69a4-4c85-ad22-512f39a14dc8` (claude-haiku-4-5, Clara voice, webhook + secret set) |
| Vapi assistant "Etta (setup)" | `0089b42e-799e-42c5-878a-2478387ae1de` (claude-haiku-4-5) — answers inbound consent calls |
| ⚠️ Patching assistants | Vapi PATCH **replaces** a nested object wholesale: sending `{"model":{"model":"…"}}` silently drops the system prompt and temperature. Always send the complete `model` object (provider, model, temperature, messages). |
| Twilio number | `+1 762 239 4275` ("Etta outbound", imported into Vapi) |
| Vapi phone number id | `bf43dc1e-9d25-400c-87ef-607a51641419` |
| Cron | `etta-place-due-calls`, every 10 min (pg_cron job 1) |
| Summary delivery | **SMS from Etta's own number** (+1 762 239 4275) — deliberately no email and no app, on either side of the product. Test text delivered. |
| Stripe (LIVE) | Products + prices created: Standard `price_1TzO26A8l4yd6OUzIGnqRkhB` ($19), Daily `price_1TzO27A8l4yd6OUzhi1l2T3b` ($39). Webhook endpoint `we_1TzO7NA8l4yd6OUz2KTnJvVJ`. Customer portal configured. **`STRIPE_SECRET_KEY` must be the FULL revealed key.** Copying it from the dashboard while still masked yields something like `sk_live_51ABC…wXyZ`; the `…` is U+2026, which `fetch` rejects as an invalid header before Stripe is ever contacted — checkout then 502s with no Stripe-side trace. `signup` now detects this and returns a clear 503 instead. |

### ⚠️ Two Stripe things to fix before taking real money

1. **The account's public name is "funshirts.us."** That name appears on the
   Stripe Checkout page and on customers' card statements — a family setting
   up eldercare calls would see it and reasonably assume fraud. Change it in
   Stripe → Settings → Business → *Public business information* (name and
   statement descriptor) to Etta / ETTACALLS before launch.
2. **These are live keys**, so any checkout completed on the site creates a
   real customer with a real card. Use Stripe's test keys (and the test
   price IDs) if you want to rehearse the flow without real cards.

**The one remaining setup step is setting the edge-function secrets (step 2)**
— the values live outside this repo. Until then the scheduler answers the cron
with 401, which is safe and by design.

### 🚨 SMS does not deliver yet — A2P 10DLC (blocker)

Every summary and escalation text so far has come back from Twilio as
`undelivered`, **error 30034: message from an unregistered A2P 10DLC sender**.
US carriers block application-to-person SMS on long-code numbers until the
sender is registered — verifying a number for the trial does *not* help, and
nothing about it is visible in Etta's own logs, because Twilio accepts the
message and the carrier rejects it asynchronously.

Voice calls are unaffected: those work today on verified numbers.

To fix, in the Twilio Console:

1. Upgrade off the trial (A2P registration requires a paid account).
2. Messaging → Regulatory Compliance → **A2P 10DLC**: register a **Brand**,
   then a **Campaign** (use case: customer care / account notifications).
3. Attach `+1 762 239 4275` to a **Messaging Service** linked to that campaign.
   This does not disturb Vapi — a Messaging Service governs SMS only, and the
   number's voice webhook stays pointed at Vapi.

**Get an EIN and register a Standard brand — not Sole Proprietor.** A sole
proprietor can get an EIN free from irs.gov in about fifteen minutes; no LLC
needed. The two paths cost near enough the same ($4.50 brand + $15 campaign
vetting + $2/mo either way), but Sole Proprietor caps you permanently at
**one campaign, one phone number, 3,000 segments/day and 1 segment/sec**, and
cannot be upgraded in place. At ~4 segments per family per day that ceiling is
roughly 700 daily-plan families — fine for launch — but the 1 seg/sec
throughput starts delaying summaries well before that, because the every-10-min
cron ends calls in bursts. Migrating later means a second brand, a second $15
vetting fee, re-pointing the number, and a delivery gap while live families
depend on the escalation texts. Do it right the first time.

**Campaign registration answers** (the fields as Twilio asks them):

- *Description* — "Etta is a scheduled wellbeing check-in service. Customers
  sign up on ettacalls.com for an AI companion that phones their aging parent
  on a schedule the parent has personally agreed to. This campaign sends
  transactional account notifications to the paying account holder only: a
  short summary after each scheduled check-in call, an alert when the parent
  could not be reached, and account status notices such as when the parent
  opts in or out and when the subscription changes as a result. Messages are
  sent only to the mobile number the account holder entered for themselves.
  No marketing, promotional, or third-party content is ever sent."
- *Samples* — paste the five real templates from `call-events/index.ts` with a
  fictional first name: the post-call summary, the no-answer escalation, the
  consent-confirmation, the revocation notice, and the decline notice.
- *Message contents* — tick **"will include embedded links"** (every message
  carries `FAM_LINK_BASE/<share_token>`). Leave phone numbers, direct lending
  and age-gated unticked; no body contains a phone number today.
- *Opt-in* — describe the signup checkbox verbatim, name
  `https://www.ettacalls.com/signup`, and link a hosted screenshot of the form.
  State that there is no text-to-join keyword and no other opt-in method.
- *Privacy / Terms URLs* — `https://www.ettacalls.com/privacy` and
  `https://www.ettacalls.com/terms`. Reviewers fetch both; 404s are an
  automatic rejection and a resubmit costs another $15.
- *Opt-in keywords / Opt-in message* — leave blank. There is no text-to-join.
  STOP and HELP still work via the Messaging Service's default opt-out handling.

The opt-in half of this is now built: `signup.html` has an unticked consent
checkbox whose wording matches what the campaign declares, the signup edge
function refuses a signup without it and records the verbatim text in
`families.sms_consent_*`, and the recurring templates carry the opt-out
reminder. **The one thing still missing is the hosted opt-in screenshot** —
take one of the live signup form and put it somewhere publicly fetchable
before submitting the campaign.

Two things to get right when shipping that:

- **Run the migration before deploying the signup function.** The function now
  writes `sms_consent_at` / `sms_consent_text` / `sms_consent_source`, so
  deploying it against a database without those columns fails every signup.
- **Pilot families predating the checkbox have `sms_consent_at` null.** The
  code does not yet gate `sendText` on that column, so they keep receiving
  texts on implied consent. Before the campaign goes live, either collect a
  real opt-in from them or accept that the audit trail starts at the first
  checkbox signup — don't let a null row be mistaken for a recorded yes.

Until this clears, treat the family-notification half of the product as
non-functional, and note that `call_summaries.delivered_at` currently means
"Twilio accepted it", not "the family received it" — the code logs each
message SID so failures can be traced in the Twilio console.

**Twilio trial caveats:** the account is on trial, so (a) Etta can only call
or text numbers you've verified (Console → Phone Numbers → Verified Caller
IDs — add your own cell for the self-pilot), and (b) Twilio plays a short
trial notice before each call and prefixes trial texts. Upgrading the
account removes both.

## How the pieces fit

```
cron (every 10 min)
  └─▶ edge fn: place-due-calls
        reads call_schedules (senior-local time), checks consent,
        creates a `calls` row, POSTs to Vapi ─▶ Vapi + Twilio dial the senior
                                                  │  Etta talks (agent/etta-system-prompt.md)
                                                  ▼
      edge fn: call-events  ◀── Vapi speech-update (each time Etta stops talking)
                                  at the call's wind-down → "start closing" ─▶ back
                                  a minute later → "say goodbye now"  into the call
                                                                (monitor.controlUrl)
                            ◀── Vapi end-of-call report (transcript + analysis)
        stores outcome + call_summaries
        texts the family note (Twilio SMS, from Etta's own number)
        no answer → retry in 30 min (×3) → escalation text to contact chain
        "stop calling me" → consent revoked, schedules off, family told

cron (daily)
  ├─▶ edge fn: care-reports     on the senior-local 1st, texts the monthly
  │                             report link to families holding the add-on
  └─▶ edge fn: retention-sweep  deletes call audio past its window (30 days,
                                or a year with the call-archive add-on)

the family's own pages (capability tokens, no login):
  /f/<token>      check-ins          /m/<token>      your plan + add-ons
  /r/<token>      monthly report     /b/<token>      Stripe portal
  /split/<token>  a sibling's share of the bill
```

### The call's time budget

A check-in is priced as a short call, so it has a hard ceiling:
`maxDurationSeconds: 420` on the assistant. Seven minutes is the backstop, not
the plan — Vapi cutting the line mid-sentence is the worst possible ending, so
the server keeps a clock the model doesn't have and injects two system notes
through `monitor.controlUrl`: wind down at 5:00, say goodbye at 6:00. Etta
ends the call herself with the end-call tool; the cap should almost never fire.

**The ceiling is now per call, not per assistant.** 420 is the default and
what an everyday check-in gets; `callBudget` in `_shared/catalog.ts` derives
the rest from the plan and the kind of call — 900 seconds on Companion, which
is the tier that sells a longer conversation, and 150 on a medication
reminder, which is over in a minute. `place-due-calls` sends it as a per-call
override and records it in `calls.time_budget_seconds`; the two nudges are
then measured against that number rather than a fixed 5:00, so they always
land with a couple of minutes to spare whatever the call's own ceiling is.

Four things this depends on, if you're changing it:

- **`speech-update` must stay in the assistant's `serverMessages`.** It is the
  only clock tick. Drop it and calls silently run to the 7-minute guillotine.
- **`calls.control_url` is written once, at placement.** Vapi returns
  `monitor.controlUrl` in the POST /call response and nowhere else.
- **Run `20260802120000_call_time_budget.sql` before deploying either
  function** — `place-due-calls` writes `control_url` and `call-events` writes
  `wrapup_stage`, and against an old schema every placement fails. The same
  goes for `20260802140000_revenue_addons.sql`, which adds
  `calls.time_budget_seconds`.
- **A call keeps the budget it was placed with.** Switching plans mid-call
  can't move the goalposts on a conversation already in progress, which is why
  the number is stored on the row rather than recomputed on every tick.

Patch the live assistant to match (both fields are top-level, so the
replaces-nested-objects trap above doesn't apply):

```
curl -X PATCH https://api.vapi.ai/assistant/$VAPI_ASSISTANT_ID \
  -H "Authorization: Bearer $VAPI_API_KEY" -H 'Content-Type: application/json' \
  -d '{"maxDurationSeconds":420,
       "serverMessages":["end-of-call-report","status-update","speech-update"]}'
```

`agent/etta-system-prompt.md` changed too — it now tells Etta what the system
notes are and how to act on them. Patch that separately, sending the **whole**
`model` object (provider, model, temperature, messages, tools) per the warning
above; a note she hasn't been told about reads like the senior said it.

The same change fixes `calls.started_at`, which was never being set at connect
time: `place-due-calls` flips the row to `in_progress` as soon as Vapi accepts
the POST, so the status-update handler's `status === 'scheduled'` check never
passed and the column stayed null until the end-of-call report backfilled it.
The wrap-up clock measures from it, so it now fills on the first in-progress
event instead.

Supabase project: `kkqgxojxsfqgfpzdyzjv` (same one that holds the waitlist).
All product tables are RLS-locked to the service role — nothing is reachable
from the browser key.

## 1. Accounts to create

| Account | For | Note |
|---|---|---|
| [Vapi](https://vapi.ai) | Voice agent (LLM + voice + telephony glue) | Free tier is fine for testing |
| [Twilio](https://twilio.com) | The outbound phone number, for both calls and summary texts | Buy one local-feeling US number, then import it into Vapi (Vapi dashboard → Phone Numbers → Import Twilio). The same number sends the SMS summaries, so the family sees one consistent Etta number. |

## 2. Set the secrets

```bash
supabase secrets set --project-ref kkqgxojxsfqgfpzdyzjv \
  CRON_SECRET="$(openssl rand -hex 24)" \
  VAPI_API_KEY="..." \
  VAPI_ASSISTANT_ID="..." \
  VAPI_PHONE_NUMBER_ID="..." \
  VAPI_WEBHOOK_SECRET="$(openssl rand -hex 24)" \
  TWILIO_ACCOUNT_SID="AC..." \
  TWILIO_AUTH_TOKEN="..." \
  TWILIO_FROM_NUMBER="+17622394275" \
  STRIPE_SECRET_KEY="sk_live_..." \   # click "Reveal" in Stripe first — a masked
                                     # key contains "…" and silently breaks checkout
  STRIPE_WEBHOOK_SECRET="whsec_..."   # from the webhook endpoint, see below
```

Optional price overrides. Every plan and add-on reads its Stripe price from a
secret, and falls back to creating one under a stable lookup key the first
time it's sold (see `_shared/catalog.ts` and `ensureRecurringPrice`). Set
these when you'd rather control the prices in the dashboard:

```bash
supabase secrets set --project-ref kkqgxojxsfqgfpzdyzjv \
  STRIPE_PRICE_STANDARD="price_..."          STRIPE_PRICE_DAILY="price_..." \
  STRIPE_PRICE_COMPANION="price_..."         STRIPE_PRICE_SECOND_PARENT="price_..." \
  STRIPE_PRICE_EVENING_CALL="price_..."      STRIPE_PRICE_MED_REMINDERS="price_..." \
  STRIPE_PRICE_CARE_REPORT="price_..."       STRIPE_PRICE_RECORDING_ARCHIVE="price_..." \
  STRIPE_PRICE_CARE_SEAT="price_..."         STRIPE_PRICE_CONCIERGE="price_..." \
  STRIPE_PRICE_OCCASION_CALL="price_..."
```

**Companion ($69) will not sell until its price exists** — the plan is hidden
on the manage page without one, and signup rejects it. Either set
`STRIPE_PRICE_COMPANION`, or create it once with the lookup key the code uses:

```bash
stripe prices create --currency usd --unit-amount 6900 \
  --recurring interval=month --product-data name="Etta — Companion" \
  --lookup-key etta_plan_companion
```

Until the `VAPI_*` secrets exist, `place-due-calls` runs in **dry-run**: it
reports what's due but creates and places nothing — safe to schedule the cron
before the accounts are ready. Without the `TWILIO_*` secrets, summaries are
stored with `delivered_at` null and no text goes out.

## 3. Create the Etta assistant in Vapi

1. Open `agent/vapi-assistant.json`; paste the full text of
   `agent/etta-system-prompt.md` into the model system message; set
   `server.secret` to the same value you used for `VAPI_WEBHOOK_SECRET`;
   pick a voice (warm, mature, unhurried — listen to several with the first
   message before choosing) and set `voiceId`.
2. `curl https://api.vapi.ai/assistant -H "Authorization: Bearer $VAPI_API_KEY" -H 'Content-Type: application/json' -d @agent/vapi-assistant.json`
3. Save the returned assistant `id` as `VAPI_ASSISTANT_ID`, and the imported
   phone number's `id` as `VAPI_PHONE_NUMBER_ID` (step 2).

## 4. Schedule the cron

In the Supabase dashboard (SQL editor), enable `pg_cron` + `pg_net`
(Database → Extensions), then:

```sql
select cron.schedule(
  'etta-place-due-calls',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://kkqgxojxsfqgfpzdyzjv.supabase.co/functions/v1/place-due-calls',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-etta-cron-secret', 'PASTE_CRON_SECRET_HERE'
    )
  );
  $$
);
```

Then the two daily housekeeping jobs — the monthly report and the retention
sweep. Both take the same `x-etta-cron-secret` header:

```sql
select cron.schedule(
  'etta-care-reports', '20 * * * *',   -- hourly: acts only on the senior-local 1st, 8–11am
  $$ select net.http_post(
       url := 'https://kkqgxojxsfqgfpzdyzjv.supabase.co/functions/v1/care-reports',
       headers := jsonb_build_object('Content-Type','application/json',
                                     'x-etta-cron-secret','PASTE_CRON_SECRET_HERE')); $$
);
select cron.schedule(
  'etta-retention-sweep', '40 4 * * *',  -- once a day, quiet hours
  $$ select net.http_post(
       url := 'https://kkqgxojxsfqgfpzdyzjv.supabase.co/functions/v1/retention-sweep',
       headers := jsonb_build_object('Content-Type','application/json',
                                     'x-etta-cron-secret','PASTE_CRON_SECRET_HERE')); $$
);
```

`care-reports` runs hourly rather than daily because "the first of the month,
in the morning" is a different moment in Honolulu than in New York; it checks
each senior's own clock and does nothing the rest of the time. It sweeps at
most 400 calls per run, so a backlog clears over a few days rather than in one
long request.

(The secret lives inside the cron job definition in your own database —
acceptable for now; move it to Vault when convenient.)

## 5. Onboarding is self-serve now

The live flow (no founder in the loop):

1. Family fills **ettacalls.com/signup.html** → `signup` edge function creates
   family + senior (`pending_consent`) + daily schedule. No call can happen yet.
2. The senior — usually with family beside them — **calls Etta's number from
   their own phone**. The number's inbound webhook (`assistant-request` in
   `call-events`) recognizes the caller and routes them to the **setup
   assistant** (`agent/etta-setup-prompt.md`), which explains everything and
   asks for their personal yes on the recorded line.
3. A clear yes → consent_events row (with the recording URL as evidence),
   senior flips `active`, family gets the 🟢 text with their family-page link,
   and the next morning's cron places the first daily call. A no → nothing
   starts, family is told kindly. Unclear → nothing starts, family is told.
4. Callers with unknown numbers get a polite generic Etta; active seniors who
   call the number back get the daily-companion Etta with their context (and
   anything they say — including "stop calling me" — is honored as usual).

Why inbound: a senior-initiated call needs no prior consent to place, which
neatly resolves the TCPA chicken-and-egg of "calling to ask permission to
call." Confirm this reading in the attorney review (section 7).

### Billing, and the promise it encodes

The card is collected at signup (Stripe Checkout) but the subscription starts
as a **14-day trial**, so the ordering is: pay-method on file → senior's own
yes → calls → first charge. The code keeps that promise on every branch:

- Senior **declines** on the setup call → subscription canceled immediately,
  family texted, never charged (`call-events`).
- Senior **never consents** → `customer.subscription.trial_will_end` fires and
  the subscription is canceled before the first invoice (`stripe-webhook`).
- Senior **revokes** later ("stop calling me") → calls stop *and* the
  subscription is canceled in the same breath (`call-events`).
- Subscription canceled/unpaid from Stripe's side → schedules deactivate and
  pending calls cancel (`stripe-webhook`); `place-due-calls` re-checks billing
  immediately before every placement, the same way it re-checks consent.
- `past_due` deliberately keeps calling: a card that needs updating shouldn't
  cut off someone's daily check-in. The family gets a text instead.

Plans map to frequency: `standard` ($19) = Mon/Wed/Fri, `daily` ($39) and
`companion` ($69) = every day, with Companion also raising the per-call
ceiling to 15 minutes (wind-down at 13). Families manage card and cancellation through the
Stripe portal, reached from the "Manage billing" link on their family page —
no login, same capability-token model as the page itself.

### Add-ons, and the two rules they had to keep

Everything beyond the plan is bought by the family at `/m/<share_token>`
("Your plan"), which is `supabase/functions/addons`. Nothing is ever sold
inside a call — that is the brand, and it is also why these calls sit outside
telemarketing law and PECR. The system prompt says so explicitly, including
what Etta answers if a senior asks what it costs.

| Add-on | Price | What it actually does |
|---|---|---|
| Second parent | $15/mo | A whole second senior on the account: own phone, own schedule, own consent call |
| Evening call | $19/mo | A second `call_schedules` row, `kind='evening'`, with its own time |
| Medication reminders | $9/mo | `kind='medication'`, daily, ~90 seconds, its own opening line and a 150-second ceiling |
| Monthly care report | $9/mo | Unlocks `/r/<token>` and the monthly text from `care-reports` |
| Call archive | $6/mo | Retention 30 days → 365, and a download link on shared recordings |
| Extra recipients | $5/mo each | Quantity follows the recipient list; the plan's included seats come first |
| Occasion call | $5 once | One dated, paid call with a message Etta passes along in her own voice |
| Concierge setup | $49 once | A human walks the family through it; bought at signup or later |

The two rules the code enforces, both of which have teeth:

1. **A call to a new person is never billed before that person's own yes.**
   Adding a second parent writes a `subscription_addons` row with
   `status='pending_consent'` and *no* Stripe line item. The line item is
   created in `call-events` when they consent on their own inbound setup call.
   If Stripe fails at that moment, the calls still start — the add-on simply
   stays unbilled, which errs against us rather than against them.
2. **One parent's "stop calling me" doesn't cancel the other parent's calls.**
   `stopBillingForSenior` removes that senior's add-on if they arrived as one,
   and only cancels the whole subscription if they're the senior the account
   was opened for.

Other money paths worth knowing:

- **Prorations are on** for every add and remove, so a mid-month change costs
  the days it covers and nothing more. During the trial, adding an add-on
  costs nothing at all.
- **Concierge at signup** is a one-time line on the same Checkout session. With
  the trial running, Stripe bills it with the first real invoice — so it is
  charged only after the senior has said yes, and never if they decline. That
  means we may do the concierge call before we're paid for it. That's the
  right side to be wrong on; revisit it if it's ever abused.
- **Occasion calls** are `mode=payment` Checkout sessions; the webhook flips
  the row to `scheduled` on payment. If Etta can't reach the senior after the
  retries, `call-events` refunds it without being asked and tells the family.
- **Cost sharing** (`/split/<invite_token>`): each contributor holds their own
  small subscription on their own card. Every paid contributor invoice is
  credited to the account holder's Stripe customer balance, so it comes off
  their next bill. Contributors are invited by the account holder sending the
  link themselves — we do not text an invite to a number that has never
  consented to hear from Etta. `syncCostShare` keeps a contributor's
  subscription from ever being mistaken for the family's own.
- **Recording retention** is 30 days by default, 365 with the archive add-on.
  The sweep asks the provider to delete its copy too, then clears our
  reference; `audio` refuses purged calls regardless, so a provider failure
  can't leave audio reachable through Etta.

### Manual onboarding (fallback, or non-self-serve pilots)

```sql
-- 5a. The family (the buyer side)
insert into families (name, primary_contact_name, primary_contact_email, primary_contact_phone)
values ('Test family', 'Ethan', 'ethangardner298@gmail.com', '+1XXXXXXXXXX')
returning id;  -- use as FAMILY_ID below

-- 5b. The senior (status stays pending_consent until the consent call)
insert into seniors (family_id, first_name, preferred_name, phone, timezone, notes)
values ('FAMILY_ID', 'Margaret', 'Margaret', '+1XXXXXXXXXX', 'America/New_York',
        'Loves her garden; daughter Sarah visits Sundays.')
returning id;  -- SENIOR_ID

-- 5c. Escalation chain / summary recipients (primary contact is included
-- automatically). Summaries and escalations go by TEXT, so phone is the
-- field that matters; email is kept for account/receipt mail only.
insert into family_members (family_id, name, relationship, phone, email, escalation_order)
values ('FAMILY_ID', 'Ethan', 'son', '+1XXXXXXXXXX', 'ethangardner298@gmail.com', 1);

-- 5d. The schedule — senior-local wall-clock time
insert into call_schedules (senior_id, call_time, days_of_week)
values ('SENIOR_ID', '09:00', '{0,1,2,3,4,5,6}');
```

### The consent call (do not skip, do not shortcut)

Call the senior yourself (recorded — say so first), with the family member
ideally on the line, and cover, in words like these:

> "Hi Margaret — this is Ethan from Etta. Sarah asked us to set up a daily
> check-in call for you, but it only happens if *you* want it. Quick heads-up:
> I'm recording this call so we have a record of your decision.
>
> Here's what it is: Etta is a computer — an AI assistant, not a person. She'd
> ring your phone, this number, at 9 each morning for a short chat — how you
> slept, how you're feeling — and afterward Sarah gets a little note about how
> you're doing. Those calls are recorded too, so the note can be written.
> You can stop them any time, just by telling Etta 'stop calling me' — that's
> it, they stop.
>
> So: is this your own phone number, and do you agree to get these daily
> automated calls from Etta on it?"

A clear yes → record it:

```sql
insert into consent_events (senior_id, event, method, recording_url, notes)
values ('SENIOR_ID', 'granted', 'setup_call',
        'https://…recording…', 'Verbal consent, daughter Sarah present.');

update seniors set status = 'active' where id = 'SENIOR_ID';
```

The next cron tick after 9:00 senior-time places the first call.

## 6. Verify the loop end to end

- `select * from calls order by created_at desc` — a row appears at the
  scheduled time, moves `scheduled → in_progress → completed`.
- `select * from call_summaries order by created_at desc` — summary, mood,
  chips, flags.
- The family text arrives (or `delivered_at` stays null if the Twilio secrets
  aren't set).
- Don't answer once: the retry row appears (+30 min), then again, then the
  escalation text after the third miss.
- Say "please stop calling me" on a call: senior goes `revoked`, schedules
  deactivate, pending calls cancel, family gets the revocation text. This
  path is the brand — test it as seriously as the happy path.

## 7. Before any *real* family: the legal gate

- **One TCPA attorney consultation** on the consent-capture mechanics above
  (buyer ≠ called party; recorded verbal consent from the subscriber). This
  was flagged in the business plan as a launch blocker — it still is.
- Recording notices: the consent script discloses recording (covers all-party
  consent states like California); keep it in every setup call verbatim.
- Track the FCC's proposed AI-disclosure rule — Etta's first message already
  does what the proposal asks, but confirm when it finalizes.
- **A2P 10DLC registration** (Twilio Console → Messaging → Regulatory
  Compliance) before real families: US carriers filter unregistered
  long-code SMS once you're off trial. Register the brand + a "customer
  care / account notifications" campaign; summary texts to people who
  signed up fit squarely. Family members text STOP → Twilio blocks them
  automatically (carrier-mandated); record it and stop expecting
  deliveries to that number.
- Keep `consent_events` append-only forever; it is the legal record.

## Not built yet (deliberately)

Next candidates, roughly in order of value:
1. **Family dashboard** (auth + read-only views of summaries/trends) — needs
   RLS policies per family before anything is exposed to browsers.
2. **SMS to the senior** ("Etta tried to call") between retries — Twilio SMS.
3. **Weekly trend report** — sleep/mood/appetite over time from `call_summaries`.
4. **Stripe billing** — pilot families can be free/manual; add before scale.
5. **Waitlist → onboarding funnel** — first pilots can come straight from
   `waitlist_signups`.
