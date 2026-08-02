// catalog — the price list, in one place.
//
// Plans, add-ons and one-time purchases, with the Stripe price each maps to.
// Every price ID is read from a secret so that test and live modes are a
// deploy setting rather than a code change; the two launch plans keep their
// original hard-coded IDs as fallbacks so nothing that works today stops
// working if a secret is missing.
//
// Nothing here needs a price to have been created by hand. When a secret
// isn't set, the price is looked up — and created if absent — under a stable
// lookup key at the moment of the first sale (resolvePlanPrice /
// resolveAddonPrice). Set the secrets when you'd rather own the prices in the
// Stripe dashboard; see docs/launch-runbook.md.

import { ensureRecurringPrice } from "./stripe.ts";

export type PlanKey = "standard" | "daily" | "companion";

export interface PlanDef {
  key: PlanKey;
  label: string;
  frequency: string;
  /** Days of week Etta calls: 0 = Sunday. */
  days: number[];
  monthlyCents: number;
  /** How many people get the after-call notes before seats are charged for. */
  includedRecipients: number;
  /**
   * Hard ceiling on a single call, passed to the voice provider. This is a
   * unit-economics number: voice minutes are the only materially variable
   * cost in the product, so what a plan charges is what a call may spend.
   * The wind-down nudges are derived from it — see callBudget.
   */
  maxCallSeconds: number;
  /** Spoken guidance handed to Etta about how long to stay. */
  lengthGuidance: string;
  priceEnv: string;
  fallbackPriceId: string;
}

export const PLANS: Record<PlanKey, PlanDef> = {
  standard: {
    key: "standard",
    label: "Standard",
    frequency: "Three calls a week",
    days: [1, 3, 5],
    monthlyCents: 1900,
    includedRecipients: 2,
    maxCallSeconds: 420,
    lengthGuidance: "about 3 to 5 minutes",
    priceEnv: "STRIPE_PRICE_STANDARD",
    fallbackPriceId: "price_1TzO26A8l4yd6OUzIGnqRkhB",
  },
  daily: {
    key: "daily",
    label: "Daily",
    frequency: "A call every day",
    days: [0, 1, 2, 3, 4, 5, 6],
    monthlyCents: 3900,
    includedRecipients: 5,
    maxCallSeconds: 420,
    lengthGuidance: "about 3 to 5 minutes",
    priceEnv: "STRIPE_PRICE_DAILY",
    fallbackPriceId: "price_1TzO27A8l4yd6OUzhi1l2T3b",
  },
  companion: {
    key: "companion",
    label: "Companion",
    frequency: "A longer call every day",
    days: [0, 1, 2, 3, 4, 5, 6],
    monthlyCents: 6900,
    includedRecipients: 5,
    // 15 minutes: the longer conversation this tier is sold on, with the
    // wind-down landing at 13 minutes so the goodbye is never the cut-off.
    maxCallSeconds: 900,
    lengthGuidance:
      "about 10 to 15 minutes — there is no hurry today, so let the " +
      "conversation breathe and follow whatever they want to talk about",
    priceEnv: "STRIPE_PRICE_COMPANION",
    fallbackPriceId: "",
  },
};

export function planFor(key: string | null | undefined): PlanDef {
  return PLANS[(key ?? "daily") as PlanKey] ?? PLANS.daily;
}

export type AddonKey =
  | "second_parent"
  | "evening_call"
  | "med_reminders"
  | "care_report"
  | "recording_archive"
  | "care_seat";

export interface AddonDef {
  key: AddonKey;
  label: string;
  /** One line, family-facing, on the manage page. */
  blurb: string;
  monthlyCents: number;
  /** 'senior' add-ons attach to one parent; 'family' ones to the account. */
  scope: "senior" | "family";
  priceEnv: string;
}

export const ADDONS: Record<AddonKey, AddonDef> = {
  second_parent: {
    key: "second_parent",
    label: "A second parent",
    blurb:
      "Etta calls both of them, each on their own phone, at their own time. " +
      "Nothing is billed until your second parent says their own yes.",
    monthlyCents: 1500,
    scope: "senior",
    priceEnv: "STRIPE_PRICE_SECOND_PARENT",
  },
  evening_call: {
    key: "evening_call",
    label: "An evening call",
    blurb:
      "A second, shorter check-in at the end of the day — how the day went, " +
      "not just how it started.",
    monthlyCents: 1900,
    scope: "senior",
    priceEnv: "STRIPE_PRICE_EVENING_CALL",
  },
  med_reminders: {
    key: "med_reminders",
    label: "Medication reminders",
    blurb:
      "A short, friendly call at pill time. A reminder, never advice — Etta " +
      "doesn't discuss doses or medicines.",
    monthlyCents: 900,
    scope: "senior",
    priceEnv: "STRIPE_PRICE_MED_REMINDERS",
  },
  care_report: {
    key: "care_report",
    label: "Monthly care report",
    blurb:
      "A printable month in one page — spirits, sleep, appetite, what came " +
      "up — to take to the doctor's appointment.",
    monthlyCents: 900,
    scope: "family",
    priceEnv: "STRIPE_PRICE_CARE_REPORT",
  },
  recording_archive: {
    key: "recording_archive",
    label: "Call archive",
    blurb:
      "Keep shared recordings for a year instead of 30 days, and download " +
      "them. Only ever the calls your parent agreed to share.",
    monthlyCents: 600,
    scope: "family",
    priceEnv: "STRIPE_PRICE_RECORDING_ARCHIVE",
  },
  care_seat: {
    key: "care_seat",
    label: "Extra people on the notes",
    blurb:
      "Beyond the people your plan includes — more siblings, or a care " +
      "manager who should see every check-in.",
    monthlyCents: 500,
    scope: "family",
    priceEnv: "STRIPE_PRICE_CARE_SEAT",
  },
};

export const ADDON_ORDER: AddonKey[] = [
  "second_parent",
  "evening_call",
  "care_report",
  "med_reminders",
  "recording_archive",
  "care_seat",
];

/** One-time purchases. Not subscription items — a single charge. */
export const ONE_TIME = {
  concierge_setup: {
    key: "concierge_setup",
    label: "Concierge setup",
    blurb:
      "A person from Etta calls you, walks you through it, and stays on the " +
      "line for your parent's setup call if you'd like.",
    cents: 4900,
    priceEnv: "STRIPE_PRICE_CONCIERGE",
  },
  occasion_call: {
    key: "occasion_call",
    label: "An occasion call",
    blurb:
      "A birthday, or a message you'd like passed along — one extra call on " +
      "a day you choose.",
    cents: 500,
    priceEnv: "STRIPE_PRICE_OCCASION_CALL",
  },
} as const;

/** Configured price ID, or "" when this thing isn't for sale yet. */
export function priceId(env: string, fallback = ""): string {
  return (Deno.env.get(env) ?? "").trim() || fallback;
}

export function planPriceId(plan: PlanDef): string {
  return priceId(plan.priceEnv, plan.fallbackPriceId);
}

export function addonPriceId(addon: AddonDef): string {
  return priceId(addon.priceEnv);
}

/**
 * The price to actually charge, creating it in Stripe if this is the first
 * sale. A configured secret always wins; otherwise the price is found (or
 * made) under a stable lookup key, so launching a new plan or add-on doesn't
 * depend on someone pasting IDs between two dashboards first.
 */
export async function resolvePlanPrice(plan: PlanDef): Promise<string> {
  return planPriceId(plan) ||
    await ensureRecurringPrice(
      `etta_plan_${plan.key}`,
      `Etta — ${plan.label}`,
      plan.monthlyCents,
    );
}

export async function resolveAddonPrice(addon: AddonDef): Promise<string> {
  return addonPriceId(addon) ||
    await ensureRecurringPrice(
      `etta_addon_${addon.key}`,
      `Etta — ${addon.label}`,
      addon.monthlyCents,
    );
}

/**
 * A call's time budget: the hard ceiling, and the two moments the server
 * tells Etta to start closing.
 *
 * The ceiling is priced, not conversational — see maxCallSeconds — and a call
 * that simply dies at the ceiling mid-sentence is exactly the experience this
 * product exists to avoid. So every budget reserves two minutes at the end:
 * one to start winding down, one to say goodbye. Derived rather than fixed,
 * because a 15-minute Companion call and a 90-second pill reminder cannot
 * share a 5-minute nudge.
 */
export function callBudget(
  plan: PlanDef,
  kind: string,
): { maxSeconds: number; windDownAt: number; goodbyeAt: number } {
  const maxSeconds = KIND_MAX_SECONDS[kind] ?? plan.maxCallSeconds;
  // Short calls get proportionally shorter warnings; there's no sense telling
  // a 150-second reminder to start closing at 30 seconds.
  const reserve = Math.min(120, Math.max(30, Math.round(maxSeconds * 0.3)));
  return {
    maxSeconds,
    windDownAt: maxSeconds - reserve,
    goodbyeAt: maxSeconds - Math.round(reserve / 2),
  };
}

/**
 * Ceilings that belong to the kind of call rather than the plan. A pill
 * reminder is a reminder; an occasion call is a delivery plus a little
 * warmth. Neither becomes longer because the family pays more.
 */
const KIND_MAX_SECONDS: Record<string, number> = { medication: 150, occasion: 420 };

/** The lookup key a plan's price carries when we created it ourselves. */
export function planLookupKey(plan: PlanDef): string {
  return `etta_plan_${plan.key}`;
}

/**
 * How long we keep our pointer to a call's audio.
 *
 * Default is deliberately short: the summary is the product, the recording is
 * a courtesy, and audio of an old person's private conversation is not
 * something to hold onto by default. The archive add-on extends it to a year.
 */
export const RETENTION_DAYS = { standard: 30, archived: 365 };

export function money(cents: number): string {
  return cents % 100 === 0
    ? `$${cents / 100}`
    : `$${(cents / 100).toFixed(2)}`;
}
