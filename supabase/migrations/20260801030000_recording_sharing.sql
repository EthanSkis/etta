-- Recording sharing is the senior's call, asked in their own words during a
-- check-in — not something the family buys on their behalf.
--
-- seniors.share_recordings is the standing answer (Etta only asks while it's
-- 'unknown', so nobody gets nagged daily). calls.recording_shared is the
-- per-call snapshot the family view actually reads, so a later change of mind
-- is applied to the calls it should apply to rather than retroactively
-- rewriting what was agreed at the time.

alter table public.seniors
  add column share_recordings text not null default 'unknown'
  check (share_recordings in ('unknown', 'yes', 'no'));

comment on column public.seniors.share_recordings is
  'Senior''s standing answer on letting family hear call audio. Etta asks in-call only while this is unknown.';

alter table public.calls
  add column recording_shared boolean not null default false;

comment on column public.calls.recording_shared is
  'Whether the family may play this call''s audio. Default false: silence is the safe answer.';
