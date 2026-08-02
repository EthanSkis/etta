-- Call time budget.
--
-- A check-in is priced as a short call. At Vapi + Twilio + model rates a
-- 10-minute call costs several times what a 5-minute one does, and the plans
-- ($19 for 3×/week, $39 for daily) are sized for the short version — a handful
-- of long calls a day is the difference between a margin and no margin.
--
-- So the call now has a budget: Etta is nudged to wind down at 5 minutes, told
-- to say goodbye at 6, and the provider hangs up at 7 (maxDurationSeconds 420
-- in agent/vapi-assistant.json). The nudges matter as much as the cap: a line
-- simply dies at 7:00 mid-sentence is exactly the experience this product
-- exists to avoid, so the cap is the backstop and the goodbye is the plan.
--
-- control_url is Vapi's per-call live-control endpoint (monitor.controlUrl from
-- the POST /call response). It is the only way to speak to an assistant that is
-- already on a call, and it is returned once, at placement, so it is stored
-- rather than rediscovered.
--
-- wrapup_stage is how far through the budget the call has been told it is:
--   0 = nothing sent, 1 = the 5-minute wind-down, 2 = the 6-minute final call.
-- It is advanced with a conditional UPDATE so that the many speech events
-- arriving during one call can't send the same nudge twice.

alter table public.calls
  add column if not exists control_url   text,
  add column if not exists wrapup_stage  smallint not null default 0;

comment on column public.calls.control_url is
  'Vapi monitor.controlUrl — live in-call message injection, valid only while the call is up.';
comment on column public.calls.wrapup_stage is
  '0 = no wind-down sent, 1 = 5-minute nudge sent, 2 = final 6-minute nudge sent.';
