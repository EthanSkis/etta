-- Billing. One subscription per family, held on the family row.
--
-- Ethics of the flow, encoded here: the card is collected at signup but the
-- subscription starts as a trial, and calls only happen once the senior has
-- personally consented. If they decline (or never consent), the subscription
-- is canceled before any charge — see the stripe-webhook and call-events
-- functions. plan drives call frequency: standard = 3 days/week, daily = 7.

alter table public.families
  add column stripe_customer_id     text unique,
  add column stripe_subscription_id text unique,
  add column plan                   text check (plan in ('standard', 'daily')),
  -- Stripe's subscription status verbatim: trialing | active | past_due |
  -- canceled | incomplete | incomplete_expired | unpaid | paused.
  add column subscription_status    text,
  add column trial_ends_at          timestamptz,
  add column current_period_end     timestamptz;

create index families_stripe_customer_idx on public.families (stripe_customer_id);

comment on column public.families.subscription_status is
  'Stripe subscription status, synced by the stripe-webhook function. Calls are placed only for trialing/active.';

-- Billing events, append-only: an audit trail of what Stripe told us, so a
-- billing dispute can always be reconstructed.
create table public.billing_events (
  id                 uuid primary key default gen_random_uuid(),
  family_id          uuid references public.families (id) on delete set null,
  stripe_event_id    text unique,
  type               text not null,
  detail             jsonb,
  created_at         timestamptz not null default now()
);

create index billing_events_family_idx on public.billing_events (family_id, created_at desc);

alter table public.billing_events enable row level security;
