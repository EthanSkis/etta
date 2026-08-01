-- The introduction call: Etta rings the senior herself.
--
-- Until now the only way to get a senior's consent was for the senior to dial
-- Etta — which meant the family had to be with their parent (or on the phone
-- with them) to finish signing up. That co-presence requirement was the
-- biggest drop-off in the flow: the family pays, then waits days for a Sunday
-- visit. Now the family can ask Etta to call their parent instead, right away
-- or at a chosen time, and the consent conversation happens exactly as before
-- — recorded, AI-disclosed, and refusable — just in the other direction.
--
-- The inbound path is untouched and still supported: a senior can call Etta's
-- number any time, and families who want to be there for it still can.

-- Setup calls share the calls table (same provider, same webhook, same
-- recording), so every call needs to say which kind it is. The family view
-- and the check-in history read 'check_in' only: an introduction call is not
-- a day of the record.
alter table public.calls
  add column kind text not null default 'check_in'
  check (kind in ('check_in', 'setup'));

comment on column public.calls.kind is
  'check_in = a scheduled daily call; setup = the outbound introduction/consent call placed once, before the senior is active.';

-- At most one setup call outstanding per senior at a time. Requesting another
-- while one is pending must replace it, never stack — the failure mode being
-- prevented is an older person's phone ringing twice over.
create unique index calls_one_open_setup_idx
  on public.calls (senior_id)
  where kind = 'setup' and status in ('scheduled', 'in_progress');

-- Capability token for the post-checkout screen, which has no login: it is
-- what lets the family say "call her now" or "call her at four". Separate
-- from share_token so the read-only family view and the ability to make a
-- phone happen are not the same credential.
alter table public.seniors
  add column setup_token text not null unique
  default encode(extensions.gen_random_bytes(12), 'hex');

comment on column public.seniors.setup_token is
  'Capability token used by the post-checkout screen to request Etta''s introduction call. Only usable while the senior is pending_consent; the setup-call function caps total attempts so it cannot be used to ring the number repeatedly.';
