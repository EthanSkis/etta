# Unit economics: does Etta's pricing work?

Short answer: **the prices are fine; the trial is what loses money.** Both plans
carry healthy gross margin at the call lengths Etta actually produces. The
danger is concentrated in three places that have nothing to do with the $19 and
$39 headline numbers — the 14-day free trial, the SMS fan-out on the Daily plan,
and call length drifting toward the 10-minute cap.

Everything below is a *model*. Nothing in the codebase recorded what a call cost
until now, so these are the first numbers, not the last word. Re-run them with
`node scripts/unit-economics.mjs`, and replace them with measured ones from the
`unit_economics` view as real calls accumulate.

---

## The cost of one minute

| Component | Rate | Note |
|---|---|---|
| Vapi platform | $0.050/min | orchestration only |
| Twilio outbound voice (US) | $0.014/min | |
| Deepgram nova-3 STT | $0.008/min | streaming |
| TTS (Vapi "Clara") | $0.020/min | premium voices run to $0.036 |
| **Subtotal** | **$0.092/min** | |
| claude-haiku-4-5 | ~$0.008/min cached, ~$0.024 uncached | see below |
| Post-call analysis | ~$0.02/call | `summaryPlan` + `structuredDataPlan` |

**On the LLM cost.** The whole conversation is re-sent every turn, so input
tokens grow with the *square* of call length, not linearly. The system prompt is
~2,800 tokens and rides along on all of them. A 4-minute call is roughly 24
turns and ~89k input tokens uncached — $0.09 of Haiku. Prompt caching cuts the
system-prompt share by ~90% and brings it to about $0.03. This is the one line
item that punishes long calls disproportionately, and it is worth confirming
that Vapi is actually caching the Anthropic prefix.

## Where the plans land

Base case: 4.5-minute calls (mid-range of the 3–6 minutes the system prompt
targets), 2 SMS recipients, 80% answer rate, prompt caching on.

| | Standard $19 | Daily $39 |
|---|---|---|
| Scheduled calls/mo | 13 | 30 |
| Voice | $5.53 | $12.91 |
| LLM | $0.74 | $1.74 |
| SMS | $2.26 | $5.26 |
| Stripe | $0.85 | $1.43 |
| **COGS** | **$9.38** | **$21.34** |
| **Gross margin** | **$9.62 (51%)** | **$17.66 (45%)** |

At the call length Etta is *actually* producing today — 2.65 min average across
completed calls — margins are 70% and 67%. So the fear is not confirmed at
steady state. The problems are elsewhere.

---

## Problem 1: the trial is the real hole

`TRIAL_DAYS = 14`, and `trialing` is in `PAYING_STATUSES`, so a trial places
real calls at full cost for two weeks before a cent is charged. Only the
families who convert ever pay anything back, so **each paying customer carries
the cost of `1/conversion` trials.**

At 40% trial→paid conversion:

| | Standard | Daily |
|---|---|---|
| One trial burns | $3.93 | $9.16 |
| Carried per paying customer | $9.82 | $22.91 |
| Months of margin to repay | 1.0 | 1.3 |

That is *before* any customer-acquisition cost. Add even $20 of CAC and the
Daily plan needs ~2.5 months of retention to break even; Standard needs ~3.
For a product whose churn profile is unknown and whose users are, bluntly,
elderly and mortal, assuming three months of median tenure is an assumption
worth testing before spending on acquisition.

This is also the one number that moves most with a decision you fully control.
Halving the trial to 7 days halves the burn: Daily's carried cost drops from
$22.91 to $11.45 and payback from 1.3 months to 0.6. Gating trial calls to
Standard frequency regardless of plan does something similar.

### What one cancelled trial costs

"Cancelled trial" is four different failures with a ~20× spread between them.
`node scripts/unit-economics.mjs --trial --plan=daily`:

| How the trial died | Setup call | Check-ins | SMS | **Total** |
|---|---|---|---|---|
| Abandoned before consent | $0.00 | $0.00 | $0.03 | **$0.03** |
| Senior declined consent | $0.40 | $0.00 | $0.09 | **$0.48** |
| Consented, churned at day 7 | $0.40 | $4.52 | $0.11 | **$5.03** |
| Ran the full 14 days, no convert | $0.40 | $9.04 | $0.11 | **$9.55** |

(Daily plan, 4.5-min calls, 2 recipients. Standard is $0.03 / $0.48 / $2.44 /
$4.38 — the setup call and SMS are identical; only the check-in count differs.)

Stripe takes nothing: a trial that never converts is never charged, so there is
no processing fee to recover. Twilio's number rental and A2P campaign fees are
fixed monthly overhead and don't belong to any particular trial.

The inbound consent call is $0.40 on its own (4 minutes at the inbound rate,
$0.0085/min rather than the $0.014 outbound). One trial check-in is $0.65.

**The shape of that table is the actionable part.** A family that never gets
their parent to call Etta costs three cents. One that consents and then churns
on day 14 costs $9.55. So the thing to optimise is not how many trials fail but
*when* — a signup that is never going to work is 20× cheaper to lose in week one
than in week two. Concretely, that argues for pushing the consent call to happen
immediately at signup rather than whenever the family gets round to it: it moves
failures from the expensive column to the cheap one, and it is the same change
that improves conversion.

At 40% conversion each paying customer funds 1.5 failed trials — $14.32 carried
if they all fail the expensive way, $0.73 if they all fail at consent.

**What does _not_ help: moving the trial clock to the consent call.** Seniors
are created `pending_consent`, and `place-due-calls` only calls seniors with
`status = 'active'`, so no outbound calls happen between checkout and consent —
those days cost nothing. Starting the clock at consent would *increase* trial
COGS by converting dead days into calling days. It is a reasonable fairness and
conversion argument (families currently lose trial days to scheduling the
consent call), but it is not a cost saving, and should not be sold as one.

## Problem 2: emoji double the SMS bill

The summary text opens with a status emoji and uses emoji chips (😴 🍽️ 💊).
A single non-GSM-7 character forces the entire message into UCS-2, which fits
**67 characters per segment instead of 153**. A realistic summary:

| | Characters | Encoding | Segments | Cost/msg |
|---|---|---|---|---|
| Current (with emoji) | 466 | UCS-2 | 8 | $0.0872 |
| Same text, GSM-7 only | 462 | GSM-7 | 4 | $0.0436 |

On the Daily plan advertising "summaries to up to five family members", that is
**$13.08/month of SMS on a $39 product** — a third of revenue — versus $6.54
for the same information without emoji.

I have not removed them. The emoji are deliberate product design ("the first
character is the UI: a colored signal readable from the lock screen"), and that
is a real benefit worth real money. But it should be a priced decision rather
than an invisible one, and there are middle options: drop the chip emoji and
keep the leading signal (no help — one emoji anywhere forces UCS-2), or move
the detail behind the `/f/<token>` link and send a much shorter text. Shortening
the body is the lever that actually works while keeping the signal character.

The `Reply STOP to end texts.` footer on every message is worth ~1 segment of
that total. A2P rules require periodic, not per-message, opt-out language — a
compliance question, not one I should answer unilaterally.

## Problem 3: call length is the sensitivity that bites

The system prompt targets 3–6 minutes; `maxDurationSeconds` allows 600. Holding
everything else at the base case, margin goes negative at:

| | 2 recipients | 5 recipients |
|---|---|---|
| Standard $19 | never (within the 10-min cap) | 8.9 min |
| Daily $39 | 9.8 min | **7.5 min** |

A Daily subscriber with five family members on the summary list and chatty
6-minute calls yields $4.93/month — 13% margin, which will not survive a single
support email. The same subscriber at the 10-minute cap loses money outright.

The instruction "if they want to talk about the garden for four minutes, let
them" is good product design and directly at odds with the pricing. That's a
real tension, not a bug — but it means the Daily plan's economics depend on
seniors *not* taking Etta up on the offer.

### What one 10-minute call costs

The worst legal call — a senior who talks until `maxDurationSeconds` cuts them
off. `node scripts/unit-economics.mjs --call=10`:

| Component | Cost | Basis |
|---|---|---|
| Vapi platform | $0.5000 | 10 min × $0.05 |
| Twilio voice | $0.1400 | 10 min × $0.014 |
| Deepgram nova-3 | $0.0800 | 10 min × $0.008 |
| TTS (Clara) | $0.2000 | 10 min × $0.020 |
| Haiku 4.5 conversation | $0.1428 | 60 turns, 128k in / 3k out, cached |
| Post-call analysis | $0.0200 | summary + structured data |
| SMS summary | $0.1744 | 8 segments × 2 recipients |
| **Total** | **$1.2572** | |

At 1 recipient it's $1.17; at 5, $1.52. Uncached prompts add $0.16.

**Vapi's platform fee alone is 40% of it** — more than every AI component
combined. That's worth knowing before optimising models or voices: the
orchestration layer, not the intelligence, is the biggest line item.

**The LLM term is the one that doesn't scale linearly.** Because the whole
transcript is re-sent every turn, going from 4 to 10 minutes (2.5×) takes Haiku
from $0.03 to $0.14 — nearly 5×. Everything else is flat per minute. Long calls
are punished specifically by conversation replay, which also means prompt
caching is worth more the longer calls get; confirm Vapi is actually caching the
Anthropic prefix.

A month of these: Standard nets $1.76 (9%), Daily **loses $0.67**. So the
10-minute cap is set above the point where the Daily plan stops working.

### Call-length budget at a 60% margin target

Inverting the model — the longest a call may run and still return 60% gross
margin, at an 80% answer rate. "cap" means there's headroom past the 10-minute
`maxDurationSeconds` ceiling; "—" means 60% is unreachable at *any* call length
because the SMS fan-out and Stripe fee have already eaten the budget.
Reproduce with `node scripts/unit-economics.mjs --target=0.6`.

| SMS recipients | 1 | 2 | 3 | 5 |
|---|---|---|---|---|
| **Standard $19** — emoji (today) | 4.0 min | 3.2 min | 2.3 min | 0.5 min |
| **Daily $39** — emoji (today) | 3.5 min | 2.7 min | 1.8 min | — |
| **Standard $19** — plain GSM-7 | 4.4 min | 4.0 min | 3.6 min | 2.7 min |
| **Daily $39** — plain GSM-7 | 3.9 min | 3.5 min | 3.1 min | 2.2 min |

Two things fall out of this. First, **60% is incompatible with the advertised
3–6 minute call** on almost every configuration — only a single-recipient
Standard subscriber has room for a 4-minute call, and nothing has room for six.
Today's 2.65-minute average clears 60% at 1–2 recipients and misses it at 3+.

Second, **the emoji decision costs more than the call-length decision** past two
recipients. Moving to GSM-7 buys back 1.3 minutes at three recipients and turns
the 5-recipient Daily case from impossible into 2.2 minutes. If 60% is the
target, shortening the SMS body is a cheaper lever than shortening the call.

Note this is *gross* margin — trial burn and CAC land on top, so 60% gross is
not 60% net on a customer's first months.

## Problem 4 (fixed): past_due had no bound

`PAYING_STATUSES` included `past_due` with no time limit, so a subscription that
never resolved would receive calls forever. On Daily that is ~$0.45/day of pure
burn. Now capped at `PAST_DUE_GRACE_DAYS` (21 days, env-overridable), measured
from `current_period_end`. Stripe's dunning usually terminates inside that
window on its own, so this is a backstop rather than a change in behaviour.

---

## What is now measured

The model above existed only in this file. These changes make it observable:

- `calls.provider_cost_usd` / `calls.cost_breakdown` — Vapi's end-of-call report
  already carried `cost` and a per-vendor `costBreakdown` and we were discarding
  both. Captured on outbound and inbound calls alike (consent calls are pure
  cost and belong in the picture).
- `call_summaries.sms_segments` / `sms_recipients` / `sms_cost_usd` — from
  Twilio's `num_segments`, priced at $0.0109/segment. Recorded even on a partial
  fan-out, since those copies still cost us.
- `unit_economics` view — measured per-family margin per month, ordered
  worst-first. `calls_missing_cost` flags any gap between what we placed and
  what we priced; if it is non-zero, the margins are understated.

Useful first queries:

```sql
-- Who is unprofitable right now?
select * from unit_economics where margin_usd < 0;

-- What does a minute actually cost, versus the $0.092 modelled above?
select round(sum(provider_cost_usd) / (sum(duration_seconds) / 60.0), 4) as usd_per_min
from calls where provider_cost_usd is not null and duration_seconds > 0;

-- Trial burn to date: cost incurred against families who have never paid.
select round(sum(c.provider_cost_usd), 2)
from calls c join seniors s on s.id = c.senior_id join families f on f.id = s.family_id
where f.subscription_status in ('trialing', 'canceled', 'incomplete_expired');
```

## Recommendation

**Don't change the prices.** $19 and $39 sit correctly in the market band the
business description identifies, and they already clear COGS with room. The
problem is not the price, it is the payback period — how long a customer must
stay before repaying what it cost to acquire them.

Three changes, none of which touch the headline price, take Daily from 45% to
54% margin and payback from 1.3 months to 0.5:

| # | Change | Effect |
|---|---|---|
| 1 | Trial 14 days → 7 | Daily carried cost $22.91 → $11.45 |
| 2 | Summary SMS 8 segments → ~3 | −$3.50/mo at 2 recipients, −$8.70 at 5 |
| 3 | `maxDurationSeconds` 600 → 420 | removes the only loss-making call length |

Combined, at 4.5-minute calls and 2 recipients: Standard 58% / 0.4-month
payback, Daily 54% / 0.5-month. Even the bad case (5 recipients, 6-minute
calls) becomes 34% and 1.1 months instead of 13% and 7.6.

Notes on each:

1. **Trial.** Largest single lever and entirely within your control. The risk
   is conversion — a shorter trial may convert worse, and that trade is only
   worth making if you measure it. Gating trial calls to Standard frequency is
   a gentler variant that keeps 14 days of calendar reassurance.
2. **SMS.** Keep the leading signal emoji — it is the product — and cut the
   body instead. A single emoji anywhere forces UCS-2 either way, so at 67
   characters per segment the win comes from length, not from removing glyphs.
   Move the chips and flag detail behind the `/f/<token>` link, which already
   exists and renders better than SMS does.

   Note that going GSM-7 takes more than dropping emoji: **every** Etta message
   is UCS-2 today, including the ones with no emoji at all, because the em-dash
   in the `— Etta` signature and the curly apostrophes in "didn't" / "that's"
   are outside the GSM-7 alphabet. If you want the cheaper encoding you have to
   sign off with `- Etta` and use straight quotes throughout. That is a real
   typographic downgrade for roughly half the SMS bill — worth pricing, not
   worth doing by accident.
3. **Call cap.** The median call is 2.65 minutes, so a 7-minute cap touches
   almost nobody — it truncates only the tail that loses money. Watch the p90,
   not the mean.

Two further options worth considering, in rough order of leverage:

- **Cap included SMS recipients at 2–3 on Daily**, or price extras. "Summaries
  to up to five family members" is the single feature that makes the plan
  unprofitable; it is a pricing-shape problem, not a cost problem.
- **Offer annual prepay** (e.g. $390/year). It does not change unit cost at all,
  but it collects 12 months up front and so removes the payback risk entirely —
  which is the actual exposure here.

And the thing to do before any of it: **get a real conversion, churn, and CAC
number.** Every figure above is dominated by an assumed 40% conversion, and the
whole question of profitability turns on whether median tenure exceeds payback.
The `unit_economics` view now gives you the cost side; the retention side still
has to come from the market.

Sources for the vendor rates: [Vapi pricing](https://telnyx.com/resources/vapi-pricing),
[Twilio pricing](https://www.twilio.com/en-us/pricing),
[Twilio 2026 rate summary](https://automationatlas.io/answers/twilio-pricing-explained-2026/),
[Vapi cost breakdown](https://zeeg.me/en/blog/post/vapi-ai-pricing).
Anthropic list price for claude-haiku-4-5 is $1/MTok input, $5/MTok output.
