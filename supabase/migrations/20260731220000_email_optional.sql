-- Self-serve signup is phone-first: summaries, escalations, and the consent
-- step all run on phone numbers, so email is no longer required to join.
-- The format check still applies whenever an email IS provided.

alter table public.families alter column primary_contact_email drop not null;
