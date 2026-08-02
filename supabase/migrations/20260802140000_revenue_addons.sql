-- ---------------------------------------------------------------------------
-- Revenue add-ons: the things a family can add to a plan, and the two ways
-- money can arrive that aren't the base subscription (one-time purchases and
-- siblings splitting the bill).
--
-- Two rules are encoded here rather than left to application code:
--
--   1. Nothing that causes a call to a NEW person can be billed before that
--      person's own recorded yes. The second-parent add-on is therefore born
--      'pending_consent' and only becomes a Stripe line item when the senior
--      consents on their own setup call — the same gate the first parent went
--      through (see subscription_addons.status).
--   2. Nothing here is ever sold inside a call. Every add-on is bought by the
--      family on the family page; the senior is never pitched anything. The
--      only thing a senior is ever asked about is consent.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Plans: Companion joins Standard and Daily.
--
-- Companion is daily calls with room to actually talk (10–15 minutes) for
-- seniors who are genuinely isolated. It costs more because it costs us more:
-- voice minutes are the only materially variable cost in the product.
-- ---------------------------------------------------------------------------

alter table public.families drop constraint if exists families_plan_check;
alter table public.families add constraint families_plan_check
  check (plan in ('standard', 'daily', 'companion'));

-- One-time concierge setup: a human walks the family and the senior through
-- the consent call. Bought at signup or later; recorded here so the manage
-- page never sells it twice.
alter table public.families
  add column if not exists concierge_purchased_at timestamptz;

comment on column public.families.concierge_purchased_at is
  'When white-glove setup was paid for. Null = never bought.';

-- ---------------------------------------------------------------------------
-- Subscription add-ons
-- ---------------------------------------------------------------------------

create type public.addon_status as enum (
  'pending_consent', -- bought, but waiting on a senior's own yes before billing
  'active',          -- live on the Stripe subscription
  'canceled'         -- removed; row kept as history
);

create table public.subscription_addons (
  id                uuid primary key default gen_random_uuid(),
  family_id         uuid not null references public.families (id) on delete cascade,
  -- Set for add-ons that attach to one senior (an evening call, medication
  -- reminders, a second parent); null for family-wide ones (care report,
  -- recording archive, extra recipients).
  senior_id         uuid references public.seniors (id) on delete cascade,
  addon_key         text not null check (addon_key in (
    'second_parent', 'evening_call', 'med_reminders',
    'care_report', 'recording_archive', 'care_seat'
  )),
  quantity          smallint not null default 1 check (quantity between 1 and 20),
  status            public.addon_status not null default 'active',
  stripe_item_id    text unique,   -- subscription item on the family's subscription
  stripe_price_id   text,
  unit_amount_cents integer,
  detail            jsonb not null default '{}',  -- e.g. {"call_time":"18:00","label":"evening pills"}
  activated_at      timestamptz,
  canceled_at       timestamptz,
  created_at        timestamptz not null default now()
);

-- One live row per family / senior / add-on. The coalesce keeps family-wide
-- add-ons (senior_id null) unique too — in Postgres, nulls don't collide on
-- their own, so "one care report per family" would otherwise not hold.
create unique index subscription_addons_live_idx
  on public.subscription_addons (
    family_id, addon_key,
    coalesce(senior_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status <> 'canceled';

create index subscription_addons_family_idx on public.subscription_addons (family_id);
create index subscription_addons_senior_idx on public.subscription_addons (senior_id)
  where senior_id is not null;

comment on table public.subscription_addons is
  'Add-ons on a family''s subscription. status=pending_consent means bought but deliberately not yet billed — a second parent has not given their own yes.';

-- ---------------------------------------------------------------------------
-- Schedules gain a kind
--
-- A senior can now have more than one standing call: the plan's check-in, an
-- optional evening check-in, and short medication reminders. They differ in
-- what Etta opens with and how long she stays — not in who consented, which
-- is still one yes covering calls from Etta.
-- ---------------------------------------------------------------------------

alter table public.call_schedules
  add column kind    text not null default 'checkin'
    check (kind in ('checkin', 'evening', 'medication')),
  add column label   text,     -- spoken back on medication calls: "your evening pills"
  add column addon_id uuid references public.subscription_addons (id) on delete set null;

comment on column public.call_schedules.kind is
  'checkin = the plan''s call; evening = the second daily check-in add-on; medication = a short reminder call.';
comment on column public.call_schedules.addon_id is
  'The add-on that pays for this schedule. Null for the plan''s own check-in.';

-- ---------------------------------------------------------------------------
-- Occasion calls: a one-time $5 call — a birthday, or a message the family
-- wants passed along in Etta's own voice ("Sarah asked me to tell you…").
--
-- Not a subscription, not a schedule: one dated, paid-for call that either
-- happens or is refundable. Consent still governs it — an occasion call is
-- only ever placed to a senior who is 'active'.
-- ---------------------------------------------------------------------------

create table public.occasion_calls (
  id                   uuid primary key default gen_random_uuid(),
  family_id            uuid not null references public.families (id) on delete cascade,
  senior_id            uuid not null references public.seniors (id) on delete cascade,
  occasion             text not null check (occasion in (
    'birthday', 'anniversary', 'holiday', 'message', 'thinking_of_you'
  )),
  from_name            text not null,          -- "Sarah", "the grandkids"
  message              text not null,          -- what Etta passes along, in her own voice
  local_date           date not null,          -- senior-local day to call
  call_time            time not null,
  status               text not null default 'pending_payment' check (status in (
    'pending_payment', 'scheduled', 'placed', 'completed', 'no_answer', 'canceled'
  )),
  amount_cents         integer not null default 500,
  stripe_session_id    text unique,
  stripe_payment_intent text,
  paid_at              timestamptz,
  created_at           timestamptz not null default now()
);

create index occasion_calls_due_idx on public.occasion_calls (local_date)
  where status = 'scheduled';
create index occasion_calls_family_idx on public.occasion_calls (family_id, created_at desc);

comment on table public.occasion_calls is
  'One-off paid calls (birthday wishes, a message from the family). Placed only for seniors with live consent, like every other call.';

-- Calls carry which kind they are, which occasion bought them, and the time
-- budget they were placed with.
--
-- The budget is stored rather than recomputed because the wind-down nudges
-- (see call-events) are measured against it on every speech event, and
-- because a plan change mid-call must not move the goalposts of a call
-- already in progress. 20260802120000 gave every call a 7-minute ceiling with
-- nudges at 5 and 6; those numbers are now derived per call, so a Companion
-- call gets its 15 minutes and a pill reminder gets its 90 seconds.
alter table public.calls
  add column kind        text not null default 'checkin'
    check (kind in ('checkin', 'evening', 'medication', 'occasion')),
  add column occasion_id uuid references public.occasion_calls (id) on delete set null,
  add column recording_purged_at timestamptz,
  add column time_budget_seconds integer;

comment on column public.calls.time_budget_seconds is
  'The hard ceiling this call was placed with, in seconds. Null for calls placed before budgets were per-call; call-events falls back to the check-in default.';

-- One call per occasion per attempt; retries after a no-answer get their own
-- attempt number, exactly as scheduled calls do.
create unique index calls_occasion_attempt_idx
  on public.calls (occasion_id, attempt_number)
  where occasion_id is not null;

comment on column public.calls.recording_purged_at is
  'When our reference to the audio was dropped by the retention sweep. Summaries are kept; audio is not, unless the family holds the archive add-on.';

-- ---------------------------------------------------------------------------
-- Cost sharing between siblings
--
-- Three siblings each paying a third churns far less than one paying the
-- whole bill and quietly resenting it. Mechanically: each contributor holds
-- their OWN small subscription, and every payment they make is credited to
-- the account holder's Stripe customer balance, so it comes straight off the
-- next bill. If a sibling stops, nothing breaks — the account holder simply
-- pays full price again, and the calls never notice.
--
-- Contributors are invited by the account holder sending them the link
-- themselves. We deliberately do NOT text an invite to a number that has
-- never consented to hear from us.
-- ---------------------------------------------------------------------------

create table public.cost_shares (
  id                     uuid primary key default gen_random_uuid(),
  family_id              uuid not null references public.families (id) on delete cascade,
  name                   text not null,
  relationship           text,
  share_cents            integer not null check (share_cents between 300 and 10000),
  invite_token           text not null unique
    default encode(extensions.gen_random_bytes(12), 'hex'),
  status                 text not null default 'invited'
    check (status in ('invited', 'active', 'canceled')),
  stripe_customer_id     text,
  stripe_subscription_id text unique,
  contributed_cents      integer not null default 0,
  last_paid_at           timestamptz,
  canceled_at            timestamptz,
  created_at             timestamptz not null default now()
);

create index cost_shares_family_idx on public.cost_shares (family_id, created_at);

comment on table public.cost_shares is
  'Siblings contributing to one family''s bill. Each holds their own subscription; their payments become account credit on the account holder''s next invoice.';

-- ---------------------------------------------------------------------------
-- Same access model as everything else: RLS on, no policies, service role only.
-- ---------------------------------------------------------------------------

alter table public.subscription_addons enable row level security;
alter table public.occasion_calls      enable row level security;
alter table public.cost_shares         enable row level security;
