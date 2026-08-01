-- ---------------------------------------------------------------------------
-- A2P 10DLC / TCPA: the account holder's own consent to be texted.
--
-- The senior's consent to be *called* already lives in consent_events, proven
-- by the recorded setup call. This is the other half: the family member who
-- signs up consenting to receive the check-in notes at their own mobile.
-- Carriers and TCR require us to be able to show, per number, what the person
-- agreed to and when — so we store the exact wording they were shown.
-- ---------------------------------------------------------------------------

alter table public.families
  add column if not exists sms_consent_at     timestamptz,
  add column if not exists sms_consent_text   text,
  add column if not exists sms_consent_source text;

comment on column public.families.sms_consent_at is
  'When the account holder ticked the SMS consent box at signup. Null means no recorded consent — either a pilot family predating the checkbox, or a signup that never reached this path.';
comment on column public.families.sms_consent_text is
  'Verbatim consent wording shown beside the checkbox, kept as the record of what was agreed.';
comment on column public.families.sms_consent_source is
  'Where consent was captured, e.g. ''web_signup''.';
