# The Business: "Etta" (ettacalls.com)

**One-liner:** A warm, honest AI companion that calls your aging parent every day, has a real conversation, and tells you how they're doing — with their knowledge and consent, always.

## The problem

Millions of adult children live too far from their aging parents to check on them daily, and carry a constant low-grade worry: *Did mom eat today? Did she fall? Is she lonely? Is she declining and I can't see it?* The existing options each fail them: calling every day themselves is unsustainable; volunteer telephone-reassurance programs are free but waitlisted and shallow; human call services cost $30–220/month; monitoring hardware ($25–70/month plus devices) tells you movement happened but nothing about mood, meals, or state of mind; and caregiver apps organize the family but never actually touch the senior. The result is a gap between "my parent is technically alive" and "I actually know how my parent is doing."

## The solution

Etta makes a scheduled phone call — ordinary phone, no app, no device, nothing for the senior to learn — at a time the senior chooses. The call opens with an honest introduction ("Hi Margaret, it's Etta — I'm an AI assistant, calling to check in like your daughter Sarah set up"), then has a natural, unhurried conversation: how they slept, whether they've eaten, whether they took their medications, what they're up to today, and whatever the senior wants to talk about. The voice is warm and natural; the identity is never disguised.

After each call, the family receives a short summary by text or email: overall mood, anything notable ("mentioned her knee is worse," "sounded brighter than yesterday"), and any flags. If a call goes unanswered, Etta retries, texts the senior, and then escalates to the family's chosen contact chain. Over weeks, per-call summaries become trend reports — sleep, mood, appetite, engagement over time — which is what families actually need to spot slow decline that no single phone call reveals.

## Who pays and who consents (the structural insight)

The **buyer** is the adult child (typically 45–65, living at distance, sandwich generation). The **user** is the senior. These are different people, and the law — and basic ethics — requires the senior's own consent, not just the family's. So onboarding is a deliberate two-step: the family signs up, pays, and configures; then the senior personally opts in on a recorded setup call (family often sitting beside them) before any outbound AI call ever happens. The senior can revoke at any time, on any call, just by saying so — and it takes effect immediately.

This isn't compliance overhead; it's the brand. Every competitor faces the same trust headwind (the 404 Media exposé, hostile caregiver-community sentiment toward "AI talking to my parents"). Etta's position is to be the *most* transparent, most senior-respecting product in the category — the one a skeptical journalist writes the positive story about. Transparency is simultaneously the legal safe harbor (TCPA consent, FCC's proposed AI-disclosure rule, Maine/Colorado/Utah/California statutes, EU AI Act) and the marketing differentiator.

## Revenue model

**Phase 1 — Consumer subscription (launch):** family-paid monthly plans in the market's established band. Roughly: Standard at ~$19/month (3 calls/week), Daily at ~$39/month (daily calls, trend reports, multiple family recipients). Calls default to ~3–5 minutes, which keeps per-call AI and telephony costs sustainable at these prices. No hardware, no contract, cancel anytime.

**Phase 2 — Care circle (differentiation):** the family side deepens into light coordination — multiple family members on the summary list, shared notes, "ask about X tomorrow" prompts, and longitudinal wellbeing reports. No competitor bridges proactive senior contact with family coordination; this is the product moat while the base feature commoditizes.

**Phase 3 — B2B2C (the real business):** sell per-member-per-month contracts to Medicare Advantage plans, employers (eldercare benefits), and senior-living operators — the channel that made Papa big and that none of the five AI-call startups has touched. The senior receives Etta free; the plan pays because loneliness and undetected decline drive claims costs. Consumer-phase retention and satisfaction data is the evidence for this pitch, so we collect it from day one.

## Competitive positioning

Direct competitors (inTouch, Joy Calls, Verocall, CareCall, ElderVoice, Senior Protection AI) validate the category but are all early, thinly funded, US/Canada consumer-only, and undifferentiated. Etta differs on three axes: (1) **trust architecture** — senior consent and disclosure as the headline, not the fine print; (2) **the coordination bridge** — from "summary email" toward organizing the family around what the calls learn; (3) **channel ambition** — built from the start for the insurance/employer payer. A secondary geographic option is the UK, where the only alternatives are free services with 8–10 week waitlists and where the regulatory position for non-marketing calls is actually friendlier.

What we deliberately do *not* do: no undisclosed AI, no sales content ever inside calls (keeps us outside telemarketing law in the US and PECR in the UK), and no medical or dementia-detection claims until we have real evidence — the conversational-decline data may become genuinely valuable, but it's a research track, not a marketing line.

## Operations and technology

Lean stack, mostly assembled: telephony via Twilio, conversation via a managed voice-agent platform (ElevenLabs Agents / Vapi / Retell class), an LLM for conversation and summary generation, and a thin web app for family onboarding, consent capture, scheduling, and summaries. One founder can ship the MVP; the hard work is conversation design (question bank, escalation logic, disclosure and revocation handling) and the consent flow, not infrastructure. Recording disclosure, data minimization, and health-adjacent data handling are built in from the first line of code, with SOC 2 / HIPAA readiness on the roadmap because the B2B2C channel will demand it.

## Key risks, stated plainly

The feature is easy to copy and consumer prices are being competed toward $10–30 — hence the coordination moat and payer channel. Voice-AI unit costs (~$0.05–0.15/minute today) make daily long calls margin-negative at consumer prices — hence short calls, tiered frequency, and falling model costs over time. The category is one scandal away from a trust collapse — hence the transparency-first posture, which is both the shield and the story. And one legal question needs professional resolution before launch: the exact consent-capture mechanics when buyer and called party differ (one TCPA attorney consultation, plus tracking the FCC's pending AI-disclosure rule).

## The vision

Near term: the trusted daily voice in the gap between visits — peace of mind for the family, genuine companionship for the senior. Long term: the conversational layer of eldercare — the earliest, cheapest, most humane sensor for how an aging person is really doing, paid for by the institutions that save money when decline is caught early, and welcomed into the home because it never pretended to be anything other than what it is.
