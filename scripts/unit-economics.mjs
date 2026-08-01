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
  twilioInboundPerMin: 0.0085, // Twilio inbound to a US local number — the
                               // consent call is inbound (the senior dials Etta)
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

function llmDetail(minutes, { cached }) {
  const turns = Math.round(LLM.turnsPerMinute * minutes);
  // Σ(systemPrompt + growing transcript) over every turn. The transcript term
  // is triangular — turn N re-sends everything from turns 1..N-1 — so total
  // input tokens grow with the SQUARE of call length, not linearly.
  const prefix = LLM.systemPromptTokens * turns * (cached ? LLM.cacheHitFactor : 1);
  const transcript = (LLM.tokensPerTurn / 2) * turns * (turns + 1) / 2;
  const inTok = prefix + transcript;
  const outTok = turns * LLM.outputTokensPerTurn;
  const conversation = (inTok / 1e6) * LLM.inPerMTok + (outTok / 1e6) * LLM.outPerMTok;
  return {
    turns, inTok, outTok, conversation,
    analysis: LLM.analysisPerCall,
    total: conversation + LLM.analysisPerCall,
  };
}

const llmCostPerCall = (minutes, opts) => llmDetail(minutes, opts).total;

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
function trialDrag(plan, opts, conversion, trialDays = 14) {
  const m = monthlyCost(plan, opts);
  // No Stripe fee: nothing is charged. `trialDays` is the BILLED trial length;
  // note the clock currently starts at checkout, not at the senior's consent
  // call, so any days spent waiting for consent are burned at full cost too.
  const perTrial = (m.cogs - m.stripe) * (trialDays / (365 / 12));
  const perPayingCustomer = perTrial / conversion;
  // Months of steady-state margin needed to repay it. CAC is not modelled here
  // and lands on top of this.
  const paybackMonths = m.margin > 0 ? perPayingCustomer / m.margin : Infinity;
  return { perTrial, perPayingCustomer, paybackMonths };
}

// ---------------------------------------------------------------------------
// `--flag` (no value) reads as true; `--key=value` as the value.
const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, "").split("=");
    return [k, rest.length ? rest.join("=") : true];
  }),
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

// ---------------------------------------------------------------------------
// --trial : what a trial that never converts actually costs.
//
// "Cancelled trial" is not one thing. A family that never gets their parent to
// call Etta costs almost nothing; one that consents and then churns on day 14
// costs a full half-month of service. The gap between those is ~20x, which
// matters more than the average, because the two are fixed by different things.
// ---------------------------------------------------------------------------
if (argv.trial !== undefined) {
  const plan = argv.plan ?? "daily";
  const mins = Number(argv.minutes ?? 4.5);
  const recipients = Number(argv.recipients ?? 2);
  const segs = Number(argv.smsSegments ?? 8);
  const cached = argv.cached !== "false";
  const setupMins = Number(argv.setupMinutes ?? 4);
  const cash = (n) => `$${n.toFixed(2)}`;

  // The inbound consent call: senior dials Etta, the setup assistant runs, and
  // the recording is the legal consent artifact. Happens once, before any
  // outbound call, and is unrecoverable if they decline.
  const setupCall =
    setupMins * (RATE.vapiPlatformPerMin + RATE.twilioInboundPerMin + RATE.sttPerMin + RATE.ttsPerMin)
    + llmDetail(setupMins, { cached }).total;

  // Measured with a GSM-7/UCS-2 segment counter against the real message
  // bodies in call-events and stripe-webhook. All are UCS-2: the emoji in the
  // welcome text, and the em-dash in the "— Etta" signature everywhere else.
  const SMS = {
    welcome: 5 * RATE.smsPerSegment * recipients,
    declined: 4 * RATE.smsPerSegment * recipients,
    neverConsented: 3 * RATE.smsPerSegment,   // trial_will_end, primary contact only
    summary: segs * RATE.smsPerSegment * recipients,
  };

  const perCheckIn = mins * perConnectedMinute + llmCostPerCall(mins, { cached }) + SMS.summary;
  const callsPerDay = PLANS[plan].daysPerWeek / 7;

  const scenarios = [
    ["Abandoned before consent", 0, 0, SMS.neverConsented,
      "senior never called Etta; nothing was ever placed"],
    ["Senior declined consent", 1, 0, SMS.declined,
      "consent call happened, no check-ins ever"],
    ["Consented, churned day 7", 1, 7 * callsPerDay, SMS.welcome,
      "half the trial used"],
    ["Ran full 14 days, no convert", 1, 14 * callsPerDay, SMS.welcome,
      "the expensive failure"],
  ];

  console.log(`\nWhat a trial that never converts costs — ${plan} plan, ` +
    `${mins}-min calls, ${recipients} SMS recipient(s)\n`);
  console.log(`  ${"scenario".padEnd(30)}${"setup".padStart(8)}${"check-ins".padStart(11)}` +
    `${"SMS".padStart(8)}${"TOTAL".padStart(9)}`);
  const totals = [];
  for (const [label, setups, checkIns, sms, note] of scenarios) {
    const s = setups * setupCall;
    const c = checkIns * perCheckIn;
    const total = s + c + sms;
    totals.push(total);
    console.log(`  ${label.padEnd(30)}${cash(s).padStart(8)}${cash(c).padStart(11)}` +
      `${cash(sms).padStart(8)}${cash(total).padStart(9)}   ${note}`);
  }

  console.log(`\n  Stripe takes nothing — a trial that never converts is never charged,` +
    `\n  so there is no processing fee to recover.`);
  console.log(`\n  One consent call alone: ${cash(setupCall)} (${setupMins} min inbound). ` +
    `One trial check-in: ${cash(perCheckIn)}.`);

  // What it costs to ACQUIRE one paying customer, given a mix of failures.
  const conversion = Number(argv.conversion ?? 0.4);
  const worst = totals[totals.length - 1];
  console.log(`\n  At ${(conversion * 100).toFixed(0)}% conversion, every paying customer ` +
    `funds ${((1 - conversion) / conversion).toFixed(1)} failed trials.`);
  console.log(`  If they all fail the expensive way: ${cash(worst * (1 - conversion) / conversion)} ` +
    `carried per paying customer.`);
  console.log(`  If they fail early (declined consent): ` +
    `${cash(totals[1] * (1 - conversion) / conversion)}.`);
  console.log(`\n  That spread is the point — where a trial dies matters more than ` +
    `how many die.\n  Failing fast is ~20x cheaper than failing at day 14.\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --call=10 : everything one call of a given length costs, itemised.
// ---------------------------------------------------------------------------
if (argv.call !== undefined) {
  const mins = Number(argv.call);
  const recipients = Number(argv.recipients ?? 2);
  const segs = Number(argv.smsSegments ?? 8);
  const cached = argv.cached !== "false";
  const cash = (n) => `$${n.toFixed(4)}`;

  const rows = [
    ["Vapi platform", RATE.vapiPlatformPerMin * mins, `${mins} min x $${RATE.vapiPlatformPerMin}`],
    ["Twilio voice (US outbound)", RATE.twilioVoicePerMin * mins, `${mins} min x $${RATE.twilioVoicePerMin}`],
    ["Deepgram nova-3 (STT)", RATE.sttPerMin * mins, `${mins} min x $${RATE.sttPerMin}`],
    ["TTS (Vapi 'Clara')", RATE.ttsPerMin * mins, `${mins} min x $${RATE.ttsPerMin}`],
  ];

  const llm = llmDetail(mins, { cached });
  rows.push([
    `claude-haiku-4-5 (conversation)`, llm.conversation,
    `${llm.turns} turns, ${Math.round(llm.inTok / 1000)}k in / ${llm.outTok} out` +
      `${cached ? ", cached" : ", UNCACHED"}`,
  ]);
  rows.push(["  post-call analysis", llm.analysis, "summary + structured data"]);
  rows.push([
    "SMS summary", segs * recipients * RATE.smsPerSegment,
    `${segs} seg x ${recipients} recipient(s) x $${RATE.smsPerSegment}`,
  ]);

  const total = rows.reduce((s, [, v]) => s + v, 0);

  console.log(`\nOne ${mins}-minute call, answered, itemised` +
    `${mins >= 10 ? "  (10 min = the maxDurationSeconds cap)" : ""}\n`);
  for (const [label, value, note] of rows) {
    console.log(`  ${label.padEnd(32)}${cash(value).padStart(9)}   ${note}`);
  }
  console.log(`  ${"".padEnd(32)}${"—".padStart(9)}`);
  console.log(`  ${"TOTAL".padEnd(32)}${cash(total).padStart(9)}\n`);

  // What that one call consumes of the month it belongs to. This assumes every
  // scheduled call connects, so it is the optimistic bound — the monthly model
  // above applies the answer rate, trading some talk minutes for retry
  // minutes, and lands slightly worse.
  for (const plan of ["standard", "daily"]) {
    const price = PLANS[plan].price;
    const calls = PLANS[plan].daysPerWeek * (365 / 12 / 7);
    console.log(`  ${plan.padEnd(9)} $${price}/mo: one such call is ${pct(total, price)} ` +
      `of the month's revenue. ${calls.toFixed(0)} of them = ${usd(total * calls)} + ` +
      `${usd(price * RATE.stripePct + RATE.stripeFixed)} Stripe vs ${usd(price)} ` +
      `-> ${usd(price - total * calls - price * RATE.stripePct - RATE.stripeFixed)} margin`);
  }
  console.log(`\n  (assumes every scheduled call connects; with the ` +
    `${(Number(argv.answerRate ?? 0.8) * 100).toFixed(0)}% answer rate\n` +
    `   the monthly model uses, retries make it slightly worse)`);
  console.log(`\n  Uncached LLM would add ` +
    `${cash(llmDetail(mins, { cached: false }).conversation - llm.conversation)} to this call.\n`);
  process.exit(0);
}

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
  const t = trialDrag(plan, base, Number(argv.conversion ?? 0.4), Number(argv.trialDays ?? 14));
  console.log(`  one ${argv.trialDays ?? 14}-day trial burns ${usd(t.perTrial)}; at ` +
    `${((Number(argv.conversion ?? 0.4)) * 100).toFixed(0)}% conversion each paying ` +
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

// ---------------------------------------------------------------------------
// The inverse question: how long may a call run and still hit a margin target?
//
// Margin here is gross — revenue minus provider cost, SMS, and the Stripe fee.
// It does NOT carry trial burn or CAC, both of which land on top (see
// docs/unit-economics.md). Answer rate is held at the base assumption because
// unanswered attempts cost money too and shorten the budget.
// ---------------------------------------------------------------------------
function maxMinutesFor(plan, target, opts) {
  // Margin falls monotonically with call length, so bisect. The 10-minute
  // ceiling is maxDurationSeconds in agent/vapi-assistant.json — past that the
  // provider hangs up, so a longer answer would be meaningless.
  const CAP = 10;
  const marginPct = (m) => {
    const r = monthlyCost(plan, { ...opts, minutes: m });
    return r.margin / r.revenue;
  };
  if (marginPct(0.5) < target) return null;     // unreachable at any usable length
  if (marginPct(CAP) >= target) return CAP;     // headroom past the hard cap
  let lo = 0.5, hi = CAP;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (marginPct(mid) >= target) lo = mid; else hi = mid;
  }
  return lo;
}

const target = Number(argv.target ?? 0.6);
console.log(`Longest call that still returns ${(target * 100).toFixed(0)}% gross margin`);
console.log(`(${(base.answerRate * 100).toFixed(0)}% answer rate; "cap" = at or past the ` +
  `10-min maxDurationSeconds ceiling)\n`);

const smsCases = [[8, "emoji / UCS-2 (today)"], [4, "plain GSM-7"]];
const recipientCases = [1, 2, 3, 5];

for (const [segs, label] of smsCases) {
  console.log(`  SMS ${label}`);
  console.log(`    recipients ` + recipientCases.map((r) => String(r).padStart(7)).join(""));
  for (const plan of ["standard", "daily"]) {
    const cells = recipientCases.map((recipients) => {
      const m = maxMinutesFor(plan, target, { ...base, recipients, smsSegments: segs });
      const text = m === null ? "—" : m >= 10 ? "cap" : `${m.toFixed(1)}m`;
      return text.padStart(7);
    });
    console.log(`    ${plan.padEnd(10)}` + cells.join(""));
  }
  console.log();
}
console.log(`  "—" = ${(target * 100).toFixed(0)}% is unreachable at any call length; the ` +
  `fixed costs\n      (SMS fan-out + Stripe fee) already eat the budget.\n`);
