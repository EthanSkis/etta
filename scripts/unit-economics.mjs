#!/usr/bin/env node
// Etta unit economics — what one subscriber costs us per month, and what's left.
//
//   node scripts/unit-economics.mjs            # both plans, base assumptions
//   node scripts/unit-economics.mjs --minutes=6 --recipients=5
//
// The vendor rates below are list prices as of 2026-08 and are the only numbers
// here that go stale. Everything else is derived from the code that actually
// places calls and sends texts: MAX_ATTEMPTS in call-events, the plan day
// counts in signup, and the message body built in handleCompleted().
//
// This is the model. For what it actually costs, query the unit_economics view
// (supabase/migrations/20260802000000_cost_telemetry.sql) — it reads the
// provider's own per-call cost off the end-of-call report.

// ---------------------------------------------------------------------------
// Vendor rates (USD). Sources in docs/unit-economics.md.
// ---------------------------------------------------------------------------
const RATE = {
  vapiPlatformPerMin: 0.05,   // Vapi orchestration
  twilioVoicePerMin: 0.014,   // Twilio outbound, US
  sttPerMin: 0.008,           // Deepgram nova-3, streaming
  ttsPerMin: 0.020,           // Vapi "Clara"; premium voices run to 0.036
  smsPerSegment: 0.0109,      // 0.0079 Twilio + 0.003 A2P 10DLC carrier surcharge
  stripePct: 0.029,
  stripeFixed: 0.30,
};

// claude-haiku-4-5, $1/MTok in, $5/MTok out. Conversation history is re-sent
// every turn, so input tokens grow quadratically with call length.
const LLM = {
  inPerMTok: 1.0,
  outPerMTok: 5.0,
  systemPromptTokens: 3000,   // agent/etta-system-prompt.md + injected variables
  turnsPerMinute: 6,
  tokensPerTurn: 120,         // both sides of one exchange
  outputTokensPerTurn: 50,
  cacheHitFactor: 0.1,        // prompt-cache read price vs full input price
  analysisPerCall: 0.02,      // summaryPlan + structuredDataPlan over the transcript
};

function llmCostPerCall(minutes, { cached }) {
  const turns = Math.round(LLM.turnsPerMinute * minutes);
  // Σ(systemPrompt + growing transcript) over every turn.
  const prefix = LLM.systemPromptTokens * turns * (cached ? LLM.cacheHitFactor : 1);
  const transcript = (LLM.tokensPerTurn / 2) * turns * (turns + 1) / 2;
  const inTok = prefix + transcript;
  const outTok = turns * LLM.outputTokensPerTurn;
  return (inTok / 1e6) * LLM.inPerMTok
    + (outTok / 1e6) * LLM.outPerMTok
    + LLM.analysisPerCall;
}

const perConnectedMinute =
  RATE.vapiPlatformPerMin + RATE.twilioVoicePerMin + RATE.sttPerMin + RATE.ttsPerMin;

// ---------------------------------------------------------------------------
// Plans, as configured in supabase/functions/signup/index.ts
// ---------------------------------------------------------------------------
const PLANS = {
  standard: { price: 19, daysPerWeek: 3 },
  daily: { price: 39, daysPerWeek: 7 },
};

// From supabase/functions/call-events/index.ts: MAX_ATTEMPTS = 3, and a
// no-answer still connects far enough to bill (voicemail, or a pickup with
// silence — observed 13-43s on real calls).
const RETRY = { maxAttempts: 3, deadAirMinutes: 0.6 };

function monthlyCost(plan, opts) {
  const { minutes, recipients, answerRate, smsSegments, cached } = opts;
  const scheduledDays = PLANS[plan].daysPerWeek * (365 / 12 / 7);

  // Attempt 1 connects at `answerRate`; each retry independently retries the rest.
  let unreached = 1 - answerRate;
  let deadAttempts = unreached;                    // attempt 1 failures
  for (let i = 2; i <= RETRY.maxAttempts; i++) {
    unreached *= 1 - answerRate;
    if (i < RETRY.maxAttempts) deadAttempts += unreached;
  }
  deadAttempts += unreached;                       // the final failed attempt
  const reachedDays = scheduledDays * (1 - unreached);

  const talkMinutes = reachedDays * minutes;
  const deadMinutes = scheduledDays * deadAttempts * RETRY.deadAirMinutes;

  const voice = (talkMinutes + deadMinutes) * perConnectedMinute;
  const llm = reachedDays * llmCostPerCall(minutes, { cached });
  const sms = reachedDays * smsSegments * RATE.smsPerSegment * recipients;
  const stripe = PLANS[plan].price * RATE.stripePct + RATE.stripeFixed;

  const cogs = voice + llm + sms + stripe;
  return {
    scheduledDays, reachedDays, talkMinutes, deadMinutes,
    voice, llm, sms, stripe, cogs,
    revenue: PLANS[plan].price,
    margin: PLANS[plan].price - cogs,
  };
}

// The 14-day trial (TRIAL_DAYS in signup/index.ts) places real calls before any
// charge — "trialing" is in PAYING_STATUSES, so the scheduler treats it as live.
// Every trial costs us money; only `conversion` of them ever bill. So each
// paying customer carries the cost of 1/conversion trials.
function trialDrag(plan, opts, conversion) {
  const m = monthlyCost(plan, opts);
  const perTrial = (m.cogs - m.stripe) * (14 / (365 / 12)); // no Stripe fee: nothing is charged
  const perPayingCustomer = perTrial / conversion;
  // Months of steady-state margin needed to repay it. CAC is not modelled here
  // and lands on top of this.
  const paybackMonths = m.margin > 0 ? perPayingCustomer / m.margin : Infinity;
  return { perTrial, perPayingCustomer, paybackMonths };
}

// ---------------------------------------------------------------------------
const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")),
);
const base = {
  minutes: Number(argv.minutes ?? 4.5),      // system prompt targets 3-6 min
  recipients: Number(argv.recipients ?? 2),
  answerRate: Number(argv.answerRate ?? 0.8),
  smsSegments: Number(argv.smsSegments ?? 8), // emoji forces UCS-2; see docs
  cached: argv.cached !== "false",
};

const usd = (n) => `$${n.toFixed(2)}`;
const pct = (n, d) => `${((n / d) * 100).toFixed(0)}%`;

console.log(`\nAssumptions: ${base.minutes} min/call, ${base.recipients} SMS recipient(s), ` +
  `${(base.answerRate * 100).toFixed(0)}% answer rate, ${base.smsSegments} SMS segments, ` +
  `prompt caching ${base.cached ? "on" : "off"}`);
console.log(`Connected minute costs ${usd(perConnectedMinute)} before LLM.\n`);

for (const plan of ["standard", "daily"]) {
  const m = monthlyCost(plan, base);
  console.log(`${plan.toUpperCase()}  ${usd(m.revenue)}/mo  —  ${m.scheduledDays.toFixed(0)} scheduled calls`);
  console.log(`  talk ${m.talkMinutes.toFixed(0)} min + ${m.deadMinutes.toFixed(0)} min unanswered`);
  console.log(`  voice ${usd(m.voice)}   llm ${usd(m.llm)}   sms ${usd(m.sms)}   stripe ${usd(m.stripe)}`);
  console.log(`  COGS ${usd(m.cogs)}  ->  margin ${usd(m.margin)} (${pct(m.margin, m.revenue)})`);
  const t = trialDrag(plan, base, 0.4);
  console.log(`  one 14-day trial burns ${usd(t.perTrial)}; at 40% conversion each paying ` +
    `customer carries ${usd(t.perPayingCustomer)}`);
  console.log(`  payback: ${t.paybackMonths.toFixed(1)} months of margin before this ` +
    `customer is net positive (before CAC)\n`);
}

// Where each plan stops making money, holding everything else fixed.
for (const plan of ["standard", "daily"]) {
  let breakEven = null;
  for (let mins = 1; mins <= 10; mins += 0.1) {
    if (monthlyCost(plan, { ...base, minutes: mins }).margin < 0) { breakEven = mins; break; }
  }
  console.log(`${plan}: goes margin-negative at ` +
    (breakEven ? `${breakEven.toFixed(1)} min/call` : "no call length up to the 10-min cap"));
}
console.log();
