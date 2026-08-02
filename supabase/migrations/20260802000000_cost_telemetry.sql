-- Cost telemetry.
--
-- Etta bills a flat monthly price but pays per connected minute and per SMS
-- segment, so margin varies per family and nothing in the schema recorded it:
-- `calls` stored duration but never what the call cost, and the Twilio sends
-- were fire-and-forget. Unit economics were therefore modelled, never measured
-- (see scripts/unit-economics.mjs for the model this is meant to replace).
--
-- Vapi's end-of-call report already carries `cost` and `costBreakdown` — the
-- authoritative number, including provider-side LLM/STT/TTS. We were throwing
-- it away. Twilio returns `num_segments` on every send; a summary text with
-- emoji is UCS-2 and runs ~8 segments where the same text in GSM-7 runs 4, so
-- segments (not messages) are the unit that matters.

alter table public.calls
  -- Vapi's own total for the call, in USD. Null for calls that never connected
  -- and for anything placed before this migration.
  add column provider_cost_usd numeric(10, 4),
  -- costBreakdown verbatim: {transport, stt, llm, tts, vapi, analysisCostBreakdown...}.
  -- Kept raw so a pricing change at any one vendor stays attributable after the fact.
  add column cost_breakdown    jsonb;

comment on column public.calls.provider_cost_usd is
  'Vapi end-of-call report `cost`, USD. Telephony + STT + LLM + TTS + platform fee.';

-- Fan-out is per recipient, and the Daily plan advertises up to five of them,
-- so one call can bill five times the segment count of another.
alter table public.call_summaries
  add column sms_segments   integer,   -- segments in ONE copy of the message
  add column sms_recipients integer,   -- how many phones it went to
  add column sms_cost_usd   numeric(10, 4);

comment on column public.call_summaries.sms_segments is
  'Twilio num_segments for one copy. Multiply by sms_recipients for the billed total.';

create index calls_cost_idx on public.calls (senior_id, created_at desc)
  where provider_cost_usd is not null;

-- ---------------------------------------------------------------------------
-- What a family actually costs us this billing month, against what they pay.
-- ---------------------------------------------------------------------------
create or replace view public.unit_economics as
with plan_price as (
  select 'standard'::text as plan, 19.00::numeric as price
  union all select 'daily', 39.00
),
call_costs as (
  select
    s.family_id,
    date_trunc('month', c.created_at) as month,
    count(*) filter (where c.status = 'completed')          as completed_calls,
    count(*) filter (where c.status = 'no_answer')          as no_answer_calls,
    coalesce(sum(c.duration_seconds) filter (where c.status = 'completed'), 0) / 60.0
                                                            as talk_minutes,
    -- Unanswered attempts still connect far enough to bill (voicemail, or a
    -- pickup with silence), so they belong in COGS, not in a footnote.
    coalesce(sum(c.duration_seconds) filter (where c.status <> 'completed'), 0) / 60.0
                                                            as dead_minutes,
    coalesce(sum(c.provider_cost_usd), 0)                   as voice_cost_usd,
    count(*) filter (where c.provider_cost_usd is null
                       and c.status in ('completed', 'no_answer'))
                                                            as calls_missing_cost
  from public.calls c
  join public.seniors s on s.id = c.senior_id
  group by 1, 2
),
sms_costs as (
  select
    s.family_id,
    date_trunc('month', cs.created_at) as month,
    coalesce(sum(cs.sms_cost_usd), 0) as sms_cost_usd,
    coalesce(sum(cs.sms_segments * cs.sms_recipients), 0) as sms_segments
  from public.call_summaries cs
  join public.seniors s on s.id = cs.senior_id
  group by 1, 2
)
select
  f.id                                        as family_id,
  f.name                                      as family_name,
  f.plan,
  f.subscription_status,
  cc.month,
  cc.completed_calls,
  cc.no_answer_calls,
  round(cc.talk_minutes::numeric, 1)          as talk_minutes,
  round(cc.dead_minutes::numeric, 1)          as dead_minutes,
  cc.voice_cost_usd,
  coalesce(sc.sms_cost_usd, 0)                as sms_cost_usd,
  coalesce(sc.sms_segments, 0)                as sms_segments,
  -- Stripe takes 2.9% + 30c, and only when we actually charge. A trialing or
  -- comped family pays nothing, so revenue is zero and COGS is pure burn —
  -- which is exactly the case the flat model was hiding.
  case when f.subscription_status in ('active', 'past_due')
       then coalesce(pp.price, 0) else 0 end  as revenue_usd,
  case when f.subscription_status in ('active', 'past_due')
       then round(coalesce(pp.price, 0) * 0.029 + 0.30, 2) else 0 end
                                              as stripe_fee_usd,
  round(
    cc.voice_cost_usd
    + coalesce(sc.sms_cost_usd, 0)
    + case when f.subscription_status in ('active', 'past_due')
           then coalesce(pp.price, 0) * 0.029 + 0.30 else 0 end
  , 2)                                        as cogs_usd,
  round(
    case when f.subscription_status in ('active', 'past_due')
         then coalesce(pp.price, 0) else 0 end
    - cc.voice_cost_usd
    - coalesce(sc.sms_cost_usd, 0)
    - case when f.subscription_status in ('active', 'past_due')
           then coalesce(pp.price, 0) * 0.029 + 0.30 else 0 end
  , 2)                                        as margin_usd,
  -- Non-zero means the numbers above understate cost; chase the webhook.
  cc.calls_missing_cost
from call_costs cc
join public.families f on f.id = cc.family_id
left join sms_costs sc on sc.family_id = cc.family_id and sc.month = cc.month
left join plan_price pp on pp.plan = f.plan
order by cc.month desc, margin_usd asc;

comment on view public.unit_economics is
  'Measured per-family margin per month. margin_usd < 0 means that family costs '
  'more than they pay. Trialing and comped families show revenue 0 by design.';
