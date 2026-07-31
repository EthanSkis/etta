-- Etta core product schema: families, seniors, consent, schedules, calls,
-- summaries, escalations.
--
-- Access model (MVP): all tables are RLS-enabled with NO policies, so only
-- the service role (edge functions, founder tooling) can touch them. When
-- family accounts get logins, add auth-scoped policies per family_id —
-- never expose these tables through the publishable key before that.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.senior_status as enum (
  'pending_consent',  -- family signed up; senior has not yet said yes
  'active',           -- senior personally opted in; calls may be placed
  'paused',           -- temporarily stopped (vacation, hospital stay, family request)
  'revoked'           -- senior said stop; no calls ever until a new consent event
);

create type public.consent_event_type as enum (
  'granted', 'revoked', 'paused', 'resumed'
);

create type public.call_status as enum (
  'scheduled',    -- row created, not yet handed to the voice provider
  'in_progress',  -- placed with the provider
  'completed',    -- conversation happened
  'no_answer',    -- rang out / voicemail
  'failed',       -- provider or network error
  'canceled'      -- consent revoked or schedule deactivated before placement
);

create type public.escalation_reason as enum (
  'no_answer',    -- retries exhausted, senior unreachable
  'health_flag',  -- conversation surfaced something urgent
  'revocation',   -- senior revoked consent in-call; family must be told
  'other'
);

-- ---------------------------------------------------------------------------
-- Families (the buyer side: the adult child's account)
-- ---------------------------------------------------------------------------

create table public.families (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,                    -- "The Gardner family"
  primary_contact_name  text not null,                    -- the adult child
  primary_contact_email text not null check (primary_contact_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  primary_contact_phone text,                             -- E.164
  auth_user_id          uuid,                             -- links to auth.users when logins ship
  status                text not null default 'pilot',
  created_at            timestamptz not null default now()
);

comment on table public.families is 'The paying account: the adult child who sets Etta up.';

-- Everyone who receives summaries and/or sits in the escalation chain.
create table public.family_members (
  id                 uuid primary key default gen_random_uuid(),
  family_id          uuid not null references public.families (id) on delete cascade,
  name               text not null,
  relationship       text,                                -- "daughter", "grandson"
  email              text check (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone              text,                                -- E.164
  receives_summaries boolean not null default true,
  escalation_order   smallint,                            -- 1 = called first; null = not in the chain
  created_at         timestamptz not null default now()
);

create index family_members_family_idx on public.family_members (family_id);

-- ---------------------------------------------------------------------------
-- Seniors (the called party — the person whose consent governs everything)
-- ---------------------------------------------------------------------------

create table public.seniors (
  id             uuid primary key default gen_random_uuid(),
  family_id      uuid not null references public.families (id) on delete cascade,
  first_name     text not null,
  last_name      text,
  preferred_name text,                                    -- what Etta calls them
  phone          text not null,                           -- E.164; must be the senior's own line (TCPA: subscriber/customary user consents)
  timezone       text not null default 'America/New_York',-- IANA name; all scheduling is senior-local
  notes          text,                                    -- context for Etta: interests, family names, "loves her garden"
  status         public.senior_status not null default 'pending_consent',
  created_at     timestamptz not null default now()
);

create index seniors_family_idx on public.seniors (family_id);
create index seniors_status_idx on public.seniors (status);

comment on column public.seniors.phone is
  'Senior''s own phone. TCPA consent must come from the subscriber or customary user of this line — the senior, not the family.';

-- Append-only consent log: the legal record. seniors.status is the working
-- state; this table is the evidence. Never update or delete rows here.
create table public.consent_events (
  id            uuid primary key default gen_random_uuid(),
  senior_id     uuid not null references public.seniors (id) on delete cascade,
  event         public.consent_event_type not null,
  method        text not null,       -- 'setup_call' | 'in_call' | 'family_request' | 'email' | 'written'
  recording_url text,                -- the recorded setup call where consent was given
  notes         text,
  occurred_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index consent_events_senior_idx on public.consent_events (senior_id, occurred_at desc);

comment on table public.consent_events is
  'Append-only legal record of consent grants/revocations. The setup-call recording URL is the proof of the senior''s own opt-in.';

-- ---------------------------------------------------------------------------
-- Schedules
-- ---------------------------------------------------------------------------

create table public.call_schedules (
  id           uuid primary key default gen_random_uuid(),
  senior_id    uuid not null references public.seniors (id) on delete cascade,
  call_time    time not null,                             -- senior-local wall-clock time
  days_of_week smallint[] not null default '{0,1,2,3,4,5,6}', -- 0=Sunday … 6=Saturday
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  constraint days_of_week_valid check (days_of_week <@ '{0,1,2,3,4,5,6}'::smallint[])
);

create index call_schedules_senior_idx on public.call_schedules (senior_id) where active;

-- ---------------------------------------------------------------------------
-- Calls
-- ---------------------------------------------------------------------------

create table public.calls (
  id                   uuid primary key default gen_random_uuid(),
  senior_id            uuid not null references public.seniors (id) on delete cascade,
  schedule_id          uuid references public.call_schedules (id) on delete set null,
  scheduled_for        timestamptz not null,
  scheduled_local_date date not null,                     -- senior-local calendar date, for once-per-day dedupe
  attempt_number       smallint not null default 1,       -- 1 = the scheduled call; 2..3 = no-answer retries
  provider             text not null default 'vapi',
  provider_call_id     text unique,
  status               public.call_status not null default 'scheduled',
  started_at           timestamptz,
  ended_at             timestamptz,
  duration_seconds     integer,
  ended_reason         text,                              -- provider's endedReason, verbatim
  transcript           text,
  recording_url        text,
  created_at           timestamptz not null default now()
);

-- One row per schedule per senior-local day per attempt.
create unique index calls_schedule_day_attempt_idx
  on public.calls (schedule_id, scheduled_local_date, attempt_number)
  where schedule_id is not null;

create index calls_senior_created_idx on public.calls (senior_id, created_at desc);
create index calls_pending_idx on public.calls (status, scheduled_for) where status = 'scheduled';

-- ---------------------------------------------------------------------------
-- Summaries (what the family receives)
-- ---------------------------------------------------------------------------

create table public.call_summaries (
  id                   uuid primary key default gen_random_uuid(),
  call_id              uuid not null unique references public.calls (id) on delete cascade,
  senior_id            uuid not null references public.seniors (id) on delete cascade,
  summary              text not null,                     -- family-facing, warm, 2–4 sentences
  mood_score           smallint check (mood_score between 1 and 5),
  ate_today            boolean,
  slept_well           boolean,
  meds_taken           boolean,                           -- null = not discussed / not configured
  flags                jsonb not null default '[]',       -- [{type, severity, detail}]
  revocation_requested boolean not null default false,
  tomorrow_topic       text,                              -- "ask about the doctor's appointment"
  raw_analysis         jsonb,                             -- provider's full structured output, verbatim
  delivered_at         timestamptz,                       -- when the family email/text went out
  created_at           timestamptz not null default now()
);

create index call_summaries_senior_idx on public.call_summaries (senior_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Escalations (unanswered calls, health flags, revocations)
-- ---------------------------------------------------------------------------

create table public.escalations (
  id          uuid primary key default gen_random_uuid(),
  senior_id   uuid not null references public.seniors (id) on delete cascade,
  call_id     uuid references public.calls (id) on delete set null,
  reason      public.escalation_reason not null,
  detail      text,
  status      text not null default 'open',               -- 'open' | 'notified' | 'resolved'
  notified_at timestamptz,
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);

create index escalations_open_idx on public.escalations (senior_id) where status <> 'resolved';

-- ---------------------------------------------------------------------------
-- Lock everything down: RLS on, no policies → service role only.
-- ---------------------------------------------------------------------------

alter table public.families       enable row level security;
alter table public.family_members enable row level security;
alter table public.seniors        enable row level security;
alter table public.consent_events enable row level security;
alter table public.call_schedules enable row level security;
alter table public.calls          enable row level security;
alter table public.call_summaries enable row level security;
alter table public.escalations    enable row level security;
