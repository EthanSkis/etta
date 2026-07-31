# Etta launch runbook — from this repo to the first real call

The call pipeline is built and deployed. What remains are the accounts, keys,
and one recorded consent call per senior. Work through this top to bottom.

## Live state (as of 2026-07-31)

Already provisioned — steps 1, 3 and 4 below are ✅ done:

| Thing | Value |
|---|---|
| Vapi assistant "Etta" | `d7f28f40-69a4-4c85-ad22-512f39a14dc8` (claude-sonnet-5, Clara voice, webhook + secret set) |
| Twilio number | `+1 762 239 4275` ("Etta outbound", imported into Vapi) |
| Vapi phone number id | `bf43dc1e-9d25-400c-87ef-607a51641419` |
| Cron | `etta-place-due-calls`, every 10 min (pg_cron job 1) |
| Resend | Key works; test summary email delivered. Interim from-address `Etta <etta@detailvalley.com>` (already-verified domain). `ettacalls.com` needs a Resend plan upgrade (free plan = 1 domain) — do this before any real family, so notes come from the Etta domain. |

**The one remaining setup step is setting the edge-function secrets (step 2)**
— the values live outside this repo. Until then the scheduler answers the cron
with 401, which is safe and by design.

**Twilio trial caveats:** the account is on trial, so (a) Etta can only call
numbers you've verified (Console → Phone Numbers → Verified Caller IDs — add
your own cell for the self-pilot), and (b) Twilio plays a short trial notice
before each call. Upgrading the account removes both.

## How the pieces fit

```
cron (every 10 min)
  └─▶ edge fn: place-due-calls
        reads call_schedules (senior-local time), checks consent,
        creates a `calls` row, POSTs to Vapi ─▶ Vapi + Twilio dial the senior
                                                  │  Etta talks (agent/etta-system-prompt.md)
                                                  ▼
      edge fn: call-events  ◀── Vapi end-of-call report (transcript + analysis)
        stores outcome + call_summaries
        emails the family note (Resend)
        no answer → retry in 30 min (×3) → escalation email to contact chain
        "stop calling me" → consent revoked, schedules off, family told
```

Supabase project: `kkqgxojxsfqgfpzdyzjv` (same one that holds the waitlist).
All product tables are RLS-locked to the service role — nothing is reachable
from the browser key.

## 1. Accounts to create

| Account | For | Note |
|---|---|---|
| [Vapi](https://vapi.ai) | Voice agent (LLM + voice + telephony glue) | Free tier is fine for testing |
| [Twilio](https://twilio.com) | The outbound phone number | Buy one local-feeling US number, then import it into Vapi (Vapi dashboard → Phone Numbers → Import Twilio) |
| [Resend](https://resend.com) | Family summary emails | Verify the `ettacalls.com` domain so mail comes from `etta@ettacalls.com` |

## 2. Set the secrets

```bash
supabase secrets set --project-ref kkqgxojxsfqgfpzdyzjv \
  CRON_SECRET="$(openssl rand -hex 24)" \
  VAPI_API_KEY="..." \
  VAPI_ASSISTANT_ID="..." \
  VAPI_PHONE_NUMBER_ID="..." \
  VAPI_WEBHOOK_SECRET="$(openssl rand -hex 24)" \
  RESEND_API_KEY="..." \
  SUMMARY_FROM_EMAIL="Etta <etta@ettacalls.com>"
```

Until the `VAPI_*` secrets exist, `place-due-calls` runs in **dry-run**: it
reports what's due but creates and places nothing — safe to schedule the cron
before the accounts are ready.

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

(The secret lives inside the cron job definition in your own database —
acceptable for now; move it to Vault when convenient.)

## 5. Onboard a pilot senior (yourself first!)

**First pilot should be you or a friendly relative** — run a week of calls on
someone who signed up to find bugs before any real family relies on it.

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

-- 5c. Escalation chain / summary recipients (primary contact is included automatically)
insert into family_members (family_id, name, relationship, email, escalation_order)
values ('FAMILY_ID', 'Ethan', 'son', 'ethangardner298@gmail.com', 1);

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
- The family email arrives (or `delivered_at` stays null if Resend isn't set).
- Don't answer once: the retry row appears (+30 min), then again, then the
  escalation email after the third miss.
- Say "please stop calling me" on a call: senior goes `revoked`, schedules
  deactivate, pending calls cancel, family gets the revocation email. This
  path is the brand — test it as seriously as the happy path.

## 7. Before any *real* family: the legal gate

- **One TCPA attorney consultation** on the consent-capture mechanics above
  (buyer ≠ called party; recorded verbal consent from the subscriber). This
  was flagged in the business plan as a launch blocker — it still is.
- Recording notices: the consent script discloses recording (covers all-party
  consent states like California); keep it in every setup call verbatim.
- Track the FCC's proposed AI-disclosure rule — Etta's first message already
  does what the proposal asks, but confirm when it finalizes.
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
