# Etta launch runbook — from this repo to the first real call

The call pipeline is built and deployed. What remains are the accounts, keys,
and one recorded consent call per senior. Work through this top to bottom.

## Live state (as of 2026-07-31)

Already provisioned — steps 1, 3 and 4 below are ✅ done:

| Thing | Value |
|---|---|
| Vapi assistant "Etta" | `d7f28f40-69a4-4c85-ad22-512f39a14dc8` (claude-haiku-4-5, Clara voice, webhook + secret set) |
| Vapi assistant "Etta (setup)" | `0089b42e-799e-42c5-878a-2478387ae1de` (claude-haiku-4-5) — answers inbound consent calls *and* runs the outbound introduction call. Source of truth: `agent/vapi-setup-assistant.json` |
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
signup form ─▶ edge fn: signup ─▶ Stripe Checkout ─▶ back to /signup?started=1&t=…
                                                        │
                          "call her now" / "at 4pm" ────┘
                                   ▼
                       edge fn: setup-call
                         books a calls row (kind='setup'), places it at once
                         or leaves it for the cron ─▶ Etta introduces herself
                                                       (agent/etta-setup-prompt.md)
                         a yes ─▶ senior 'active', schedules live
                         a no  ─▶ senior 'revoked', subscription canceled

cron (every 10 min)
  └─▶ edge fn: place-due-calls
        reads call_schedules (senior-local time), checks consent,
        creates a `calls` row, POSTs to Vapi ─▶ Vapi + Twilio dial the senior
        also places due kind='setup' rows (introduction + its retries)
                                                  │  Etta talks (agent/etta-system-prompt.md)
                                                  ▼
      edge fn: call-events  ◀── Vapi end-of-call report (transcript + analysis)
        stores outcome + call_summaries
        texts the family note (Twilio SMS, from Etta's own number)
        no answer → retry in 30 min (×3) → escalation text to contact chain
        setup call → consent applied (either direction), or retried ×3 at 45 min
        "stop calling me" → consent revoked, schedules off, family told
```

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

The **setup assistant** works the same way from `agent/vapi-setup-assistant.json`
(system message from `agent/etta-setup-prompt.md`). It already exists live as
`0089b42e-…`, so PATCH rather than POST — and send the whole `model` object,
per the warning above. Its id can be overridden with the
`VAPI_SETUP_ASSISTANT_ID` secret; the default is baked into `call-events`,
`place-due-calls` and `setup-call`.

### Shipping the introduction-call change

Order matters, and one of these steps is a foot-gun:

1. **Run `supabase/migrations/20260801170000_setup_call_by_etta.sql` first.**
   It adds `calls.kind` and `seniors.setup_token`. The updated `signup`
   function selects `setup_token` on insert, so deploying it against a
   database without that column fails every signup — same shape of mistake as
   the `sms_consent` migration.
2. PATCH the setup assistant with the v2 prompt and the new structured schema
   (`wrong_person`, `call_back_hours`). `call-events` reads those fields; an
   assistant still on the v1 schema simply never sets them, which degrades to
   "no clear yes" — safe, but the introduction call can't tell a wrong number
   from a refusal until it's patched.
3. `supabase functions deploy setup-call call-events place-due-calls signup fam`.
4. Deploy the site (`save.html`, `etta.vcf`, the new setup screen).
5. Register CNAM on the Twilio number (see "The caller ID problem" below).

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

(The secret lives inside the cron job definition in your own database —
acceptable for now; move it to Vault when convenient.)

## 5. Onboarding is self-serve now

The live flow (no founder in the loop):

1. Family fills **ettacalls.com/signup** → `signup` edge function creates
   family + senior (`pending_consent`) + daily schedule, and hands back a
   Stripe Checkout URL carrying the senior's `setup_token`. No check-in call
   can happen yet.
2. Back from Checkout, the family lands on the setup screen and chooses how
   the introduction happens:
   - **"Have Etta call them now"** → `setup-call` creates a `calls` row with
     `kind='setup'` and places it through Vapi immediately (seconds, not the
     next cron tick).
   - **"Pick a time"** → same row, `scheduled_for` a wall-clock time in the
     *senior's* timezone (08:00–20:00, ≤14 days out); `place-due-calls`
     places it when it comes due.
   - **Neither** → the original route is still right there: the senior calls
     Etta's number themselves, with family beside them or not.
3. Etta runs the **setup conversation** (`agent/etta-setup-prompt.md`,
   assistant `Etta (setup)`). Outbound she speaks first, and her opening line
   is the AI disclosure plus "am I speaking with Margaret?" — she says nothing
   about the family or the signup until she knows who picked up.
4. A clear yes → `consent_events` row (with the recording URL as evidence),
   senior flips `active`, any outstanding setup call is canceled, the family
   gets the 🟢 text with their family-page link, and the next morning's cron
   places the first daily call. A no → senior flips `revoked` (so nothing
   ever calls that number again), subscription canceled, family told kindly.
   Unclear, or "ring me after lunch" → nothing starts, and Etta books one
   more attempt if a time was named.
5. No answer on the introduction call → retried twice more, 45 minutes apart,
   then Etta stops and texts the family the two routes that still work. Calls
   are capped at `MAX_SETUP_CALLS` (8) per senior across all requests, so a
   leaked setup token cannot be turned into a ringing phone.
6. Callers with unknown numbers get a polite generic Etta; active seniors who
   call the number back get the daily-companion Etta with their context (and
   anything they say — including "stop calling me" — is honored as usual).

**What changed and why it matters legally.** Until now every call Etta placed
was to someone who had already consented, because the consent call itself was
inbound. That was tidy, but it made the family's physical presence a
prerequisite for finishing signup, and families were paying and then waiting
days for a Sunday visit. Etta now places exactly one call before consent
exists — the call whose entire purpose is to ask — at the request of the
family member who supplied the number, with no marketing content, AI
disclosure in the first sentence, and a hard stop after three attempts. This
is the standard reading of a non-telemarketing informational call, but it *is*
a change to the posture the attorney review was going to bless. Raise it
explicitly (section 7).

### The caller ID problem

An unknown number ringing an 80-year-old is a call that doesn't get answered —
and, worse, teaches them to distrust the number Etta will use every day. Two
fixes ship with this flow, and one is still outstanding:

- **The contact card.** `ettacalls.com/save` is a senior-facing page (bigger
  type, one action, nothing being sold) with a `/etta.vcf` contact card
  carrying Etta's name, number, photo and an honest note. Saved once, every
  future call arrives as "Etta".
- **The heads-up text.** The setup screen gives the family a one-tap link that
  opens *their own* Messages app with the text pre-written, addressed to their
  parent, containing the number and the save link. Deliberately from the
  family's phone: the first thing the senior hears about Etta comes from
  someone they trust, and it sidesteps A2P entirely — Etta's own campaign is
  declared as messaging the account holder only, and texting seniors from it
  would contradict that declaration. If we ever want Etta to text seniors
  directly, the campaign must be re-declared first.
- **Still to do: CNAM.** Register the display name on `+1 762 239 4275` with
  Twilio (Phone Numbers → the number → Caller Name (CNAM)) so phones that
  never saved the card still show "Etta" rather than a bare number. US CNAM
  is carrier-dependent and takes a few days to propagate.

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

Plans map to frequency: `standard` ($19) = Mon/Wed/Fri, `daily` ($39) = every
day. Families manage card, plan, and cancellation through the Stripe portal,
reached from the "Manage billing" link on their family page — no login, same
capability-token model as the page itself.

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

- Sign up with two numbers you control, then tap **"Have Etta call them now"**:
  a `calls` row with `kind='setup'` appears and the second phone rings within
  seconds. Say yes → `consent_events` gets a `granted` row with the recording
  URL, the senior goes `active`. Do it again on a fresh signup and say no →
  senior goes `revoked` and the Stripe subscription cancels without a charge.
- Don't answer the introduction call: two retries appear 45 minutes apart,
  then the family text arrives and nothing further is scheduled.
- Check the family page: the setup call must **not** appear as a check-in day.
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
  was flagged in the business plan as a launch blocker — it still is. Put
  **the outbound introduction call** at the top of that conversation: it is
  one non-marketing call, placed at the request of the family member who gave
  us the number, disclosing the AI in its first sentence and asking for
  consent as its only purpose, capped at three attempts and never repeated
  after a no. That is the shape the rule contemplates, but it is us calling
  someone who has not yet said yes, and it deserves a lawyer's sentence in
  writing rather than ours. If the answer is no, the inbound route still
  exists and the product still works — turn the setup screen's two buttons
  off and nothing else has to change.
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
