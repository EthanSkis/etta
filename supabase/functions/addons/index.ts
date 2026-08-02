// addons — "Your Etta plan": the one page where a family changes what they
// pay for.
//
// Reached at ettacalls.com/m/<share_token>, the same capability-token model as
// the family view: the link is the login, and it only ever resolves to one
// family's account.
//
// Everything that costs money is bought here, by the family, on a screen —
// never inside a call. Etta's calls have no sales content in them, which is
// both the brand and the reason the calls sit outside telemarketing law. The
// senior is asked exactly one thing, ever: whether they consent.
//
// The other rule this file enforces: a call to a NEW person is never billed
// before that person's own recorded yes. Adding a second parent creates their
// signup and their pending consent — the Stripe line item is only added when
// they say yes on their own setup call (see call-events).

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  ADDON_ORDER,
  ADDONS,
  type AddonDef,
  type AddonKey,
  money,
  ONE_TIME,
  type PlanDef,
  planFor,
  planLookupKey,
  planPriceId,
  PLANS,
  priceId,
  resolveAddonPrice,
  resolvePlanPrice,
} from "../_shared/catalog.ts";
import {
  addSubscriptionItem,
  removeSubscriptionItem,
  setItemQuantity,
  stripe,
} from "../_shared/stripe.ts";
import { esc, masthead, notFound, page, SITE, validToken } from "../_shared/page.ts";
import {
  ALLOWED_TIMEZONES,
  cleanName,
  localDate,
  normalizePhone,
  speakTime,
  TIMEZONES,
  validCallTime,
} from "../_shared/validate.ts";
import { sendText } from "../_shared/sms.ts";

const ETTA_NUMBER_DISPLAY = "(762) 239-4275";
const OCCASION_MAX_DAYS = 180;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Billing states a family can buy things in. A canceled subscription can't
// take new line items, and saying so plainly beats a Stripe error.
const LIVE_STATUSES = ["trialing", "active", "past_due"];

// deno-lint-ignore no-explicit-any
type Row = any;

interface Ctx {
  token: string;
  family: Row;
  plan: PlanDef;
  seniors: Row[];
  addons: Row[];
  members: Row[];
  shares: Row[];
  occasions: Row[];
}

async function load(token: string): Promise<Ctx | null> {
  const { data: senior } = await supabase.from("seniors")
    .select("family_id").eq("share_token", token).maybeSingle();
  if (!senior) return null;

  const { data: family } = await supabase.from("families")
    .select("*").eq("id", senior.family_id).maybeSingle();
  if (!family) return null;

  const { data: seniors } = await supabase.from("seniors")
    .select("id, first_name, preferred_name, phone, timezone, status, share_token, created_at, " +
      "schedules:call_schedules(id, call_time, days_of_week, kind, label, active, addon_id)")
    .eq("family_id", family.id)
    .order("created_at", { ascending: true });

  const { data: addons } = await supabase.from("subscription_addons")
    .select("*").eq("family_id", family.id).neq("status", "canceled");

  const { data: members } = await supabase.from("family_members")
    .select("*").eq("family_id", family.id).order("created_at", { ascending: true });

  const { data: shares } = await supabase.from("cost_shares")
    .select("*").eq("family_id", family.id).neq("status", "canceled")
    .order("created_at", { ascending: true });

  const { data: occasions } = await supabase.from("occasion_calls")
    .select("*").eq("family_id", family.id)
    .in("status", ["pending_payment", "scheduled", "placed"])
    .order("local_date", { ascending: true });

  return {
    token,
    family,
    plan: planFor(family.plan),
    seniors: seniors ?? [],
    addons: addons ?? [],
    members: members ?? [],
    shares: shares ?? [],
    occasions: occasions ?? [],
  };
}

function liveAddon(ctx: Ctx, key: AddonKey, seniorId?: string): Row | undefined {
  return ctx.addons.find((a) =>
    a.addon_key === key && (seniorId ? a.senior_id === seniorId : !a.senior_id)
  );
}

function seniorName(s: Row): string {
  return s.preferred_name || s.first_name;
}

/** Can this family take on new billable lines right now? */
function billable(ctx: Ctx): boolean {
  return !!ctx.family.stripe_subscription_id &&
    LIVE_STATUSES.includes(ctx.family.subscription_status ?? "");
}

/** Comped accounts (founder pilot, partner trials) get add-ons without Stripe. */
function comped(ctx: Ctx): boolean {
  return ctx.family.subscription_status === "comped";
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

function recipientCount(ctx: Ctx): number {
  // The account holder always gets the notes; members are everyone else.
  return 1 + ctx.members.filter((m) => m.receives_summaries && m.phone).length;
}

function chargeableSeats(ctx: Ctx): number {
  return Math.max(0, recipientCount(ctx) - ctx.plan.includedRecipients);
}

function monthlyCents(ctx: Ctx): number {
  let total = ctx.plan.monthlyCents;
  for (const a of ctx.addons) {
    if (a.status !== "active") continue; // pending consent is not yet billed
    const def = ADDONS[a.addon_key as AddonKey];
    if (def) total += def.monthlyCents * (a.quantity ?? 1);
  }
  return total;
}

function sharedCents(ctx: Ctx): number {
  return ctx.shares.filter((s) => s.status === "active")
    .reduce((sum, s) => sum + (s.share_cents ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Stripe plumbing for one add-on
// ---------------------------------------------------------------------------

/**
 * Put an add-on on the subscription and record it. Comped families get the
 * row without the line item, which is exactly what "comped" means.
 */
async function activateAddon(
  ctx: Ctx,
  def: AddonDef,
  opts: { seniorId?: string | null; quantity?: number; detail?: Record<string, unknown> } = {},
): Promise<Row> {
  const quantity = opts.quantity ?? 1;
  let itemId: string | null = null;
  let price: string | null = null;

  if (!comped(ctx)) {
    price = await resolveAddonPrice(def);
    const item = await addSubscriptionItem(
      ctx.family.stripe_subscription_id as string,
      price,
      quantity,
    );
    itemId = item.id as string;
  }

  const { data, error } = await supabase.from("subscription_addons").insert({
    family_id: ctx.family.id,
    senior_id: opts.seniorId ?? null,
    addon_key: def.key,
    quantity,
    status: "active",
    stripe_item_id: itemId,
    stripe_price_id: price,
    unit_amount_cents: def.monthlyCents,
    detail: opts.detail ?? {},
    activated_at: new Date().toISOString(),
  }).select("*").single();
  if (error) throw new Error(error.message);

  await supabase.from("billing_events").insert({
    family_id: ctx.family.id,
    type: "etta.addon_added",
    detail: { addon: def.key, senior_id: opts.seniorId ?? null, quantity },
  });
  return data;
}

/** Take an add-on off the subscription, and switch off whatever it powered. */
async function deactivateAddon(ctx: Ctx, addon: Row): Promise<void> {
  if (addon.stripe_item_id) await removeSubscriptionItem(addon.stripe_item_id);

  await supabase.from("subscription_addons")
    .update({ status: "canceled", canceled_at: new Date().toISOString() })
    .eq("id", addon.id);

  // Schedules this add-on paid for stop, and any call already queued from one
  // of them is canceled rather than placed after the family stopped paying.
  const { data: scheds } = await supabase.from("call_schedules")
    .select("id").eq("addon_id", addon.id);
  for (const s of scheds ?? []) {
    await supabase.from("call_schedules").update({ active: false }).eq("id", s.id);
    await supabase.from("calls")
      .update({ status: "canceled", ended_reason: "addon_removed" })
      .eq("schedule_id", s.id).eq("status", "scheduled");
  }

  await supabase.from("billing_events").insert({
    family_id: ctx.family.id,
    type: "etta.addon_removed",
    detail: { addon: addon.addon_key, senior_id: addon.senior_id },
  });
}

/**
 * Keep the paid-seat count equal to the number of people actually on the
 * notes. Called after anything that changes recipients or the plan.
 */
async function syncSeats(ctx: Ctx): Promise<void> {
  const def = ADDONS.care_seat;
  const want = chargeableSeats(ctx);
  const current = liveAddon(ctx, "care_seat");

  if (want === 0) {
    if (current) await deactivateAddon(ctx, current);
    return;
  }
  if (!current) {
    await activateAddon(ctx, def, { quantity: want });
    return;
  }
  if ((current.quantity ?? 1) !== want) {
    if (current.stripe_item_id) await setItemQuantity(current.stripe_item_id, want);
    await supabase.from("subscription_addons")
      .update({ quantity: want }).eq("id", current.id);
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const EXTRA_CSS = `
.addon{display:flex;gap:14px;align-items:flex-start;padding:15px 0;border-bottom:1px solid var(--line)}
.addon:last-child{border-bottom:none}
.addon-body{flex:1;min-width:0}
.addon-body b{font-family:var(--serif);font-size:17px;font-weight:500;display:block}
.addon-body p{color:var(--ink-soft);font-size:13.5px;margin-top:3px;line-height:1.5}
.addon-side{flex:none;text-align:right;display:flex;flex-direction:column;gap:8px;align-items:flex-end}
.price{font-family:var(--serif);font-size:16px;font-weight:600;white-space:nowrap}
.price small{font-weight:400;font-size:12px;color:var(--ink-soft)}
.on-tag{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--sage-deep);
  border:1px solid rgba(119,135,95,.5);border-radius:999px;padding:3px 9px;background:#EDF1E6}
.on-tag.wait{color:var(--gold-deep);border-color:rgba(217,164,65,.6);background:#FBF3E2}
.mini{font-size:12.5px;color:var(--ink-soft);margin-top:6px}
.btn.sm{font-size:13.5px;padding:9px 13px}
.total{display:flex;align-items:baseline;justify-content:space-between;gap:12px;
  padding-top:14px;margin-top:6px;border-top:1.5px solid var(--ink)}
.total .val{font-family:var(--serif);font-size:26px;font-weight:600}
.plan-opt{display:flex;gap:11px;align-items:flex-start;border:1.5px solid var(--line);
  border-radius:10px;padding:13px 14px;margin-top:9px;background:var(--paper)}
.plan-opt.on{border-color:var(--terra);background:var(--card)}
.plan-opt b{font-size:16px}
.plan-opt em{font-style:normal;display:block;font-size:13px;color:var(--ink-soft);margin-top:2px}
details.form{margin-top:12px;border:1px dashed var(--line-firm);border-radius:10px;padding:0 13px}
details.form>summary{cursor:pointer;list-style:none;padding:12px 0;font-size:14.5px;font-weight:600}
details.form>summary::-webkit-details-marker{display:none}
details.form[open]{padding-bottom:14px;background:var(--paper)}
.linkbox{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;
  background:var(--paper);border:1px solid var(--line);border-radius:6px;padding:9px 11px;margin-top:7px}
`;

function timeOptions(selected: string): string {
  const out: string[] = [];
  for (let h = 6; h <= 20; h++) {
    for (const m of ["00", "30"]) {
      const v = `${String(h).padStart(2, "0")}:${m}`;
      out.push(
        `<option value="${v}"${v === selected.slice(0, 5) ? " selected" : ""}>${
          speakTime(`${v}:00`)
        }</option>`,
      );
    }
  }
  return out.join("");
}

function flashFor(params: URLSearchParams): string {
  const ok = params.get("ok");
  const err = params.get("err");
  const MESSAGES: Record<string, string> = {
    addon_added: "Added. It's on your subscription from today — prorated, so you only pay for the rest of this month.",
    addon_removed: "Removed. You won't be billed for it again, and the credit lands on your next invoice.",
    parent_added: `Added. Now have them call Etta on ${ETTA_NUMBER_DISPLAY} from their own phone — nothing is billed, and no call is placed, until they say yes themselves.`,
    parent_removed: "Stopped. Etta won't call them again, and that part of the bill ends today.",
    member_added: "Added to the notes.",
    member_removed: "Removed from the notes.",
    plan_changed: "Plan changed. The difference is prorated on your next invoice.",
    share_added: "Invite ready — send them the link below. Nothing changes on your bill until they set it up.",
    share_removed: "Removed. Their share won't be collected again.",
    occasion_canceled: "Canceled, and refunded to the card you paid with.",
    occasion_paid: "All set — Etta will make that call on the day.",
    concierge: "Thank you — someone from Etta will call you within one business day.",
  };
  const PROBLEMS: Record<string, string> = {
    billing: "Your subscription isn't active, so nothing can be added to it right now. Update your card under \"Manage billing\" and try again.",
    unavailable: "That one isn't available on your account yet. Reply to Etta's number and we'll sort it out.",
    input: "Something in that form didn't look right — please check it and try again.",
    duplicate: "That phone number is already set up with Etta.",
    consent: "That parent hasn't given their own yes yet, so Etta can't schedule anything for them.",
    failed: "That didn't go through. Nothing was charged — please try again, or reply to Etta's number.",
  };
  if (ok && MESSAGES[ok]) return `<div class="flash">${esc(MESSAGES[ok])}</div>`;
  if (err) return `<div class="flash warn">${esc(PROBLEMS[err] ?? PROBLEMS.failed)}</div>`;
  return "";
}

function addonRow(
  ctx: Ctx,
  def: AddonDef,
  opts: { senior?: Row; live?: Row; extraForm?: string },
): string {
  const live = opts.live;
  const seniorId = opts.senior?.id;
  const available = !comped(ctx) ? billable(ctx) : true;

  let side: string;
  if (live && live.status === "pending_consent") {
    side = `<span class="on-tag wait">Waiting on their yes</span>`;
  } else if (live) {
    side = `<span class="on-tag">On</span>`;
  } else {
    side = `<span class="price">${money(def.monthlyCents)}<small> /mo</small></span>`;
  }

  let action = "";
  if (live) {
    action = `<form method="post" data-confirm="Remove ${esc(def.label)}?">
<input type="hidden" name="action" value="addon_remove">
<input type="hidden" name="addon_id" value="${esc(live.id)}">
<button class="btn ghost sm" type="submit">Remove</button></form>`;
  } else if (!available) {
    action = `<span class="mini">Needs an active subscription</span>`;
  } else if (opts.extraForm) {
    action = "";
  } else {
    action = `<form method="post" data-confirm="Add ${esc(def.label)} for ${
      money(def.monthlyCents)
    } a month?">
<input type="hidden" name="action" value="addon_add">
<input type="hidden" name="addon_key" value="${def.key}">
${seniorId ? `<input type="hidden" name="senior_id" value="${esc(seniorId)}">` : ""}
<button class="btn sm" type="submit">Add</button></form>`;
  }

  return `<div class="addon"><div class="addon-body"><b>${esc(def.label)}</b>
<p>${esc(def.blurb)}</p>${live?.detail?.call_time ? `<p class="mini">At ${
    esc(speakTime(String(live.detail.call_time)))
  }${live.detail.label ? ` — “${esc(String(live.detail.label))}”` : ""}</p>` : ""}
${!live && available && opts.extraForm ? opts.extraForm : ""}</div>
<div class="addon-side">${side}${action}</div></div>`;
}

function seniorSection(ctx: Ctx, senior: Row): string {
  const name = seniorName(senior);
  const isSecond = ctx.seniors[0]?.id !== senior.id;
  const secondAddon = liveAddon(ctx, "second_parent", senior.id);
  const checkin = (senior.schedules ?? []).find((s: Row) => s.kind === "checkin" && s.active);
  const evening = liveAddon(ctx, "evening_call", senior.id);
  const meds = liveAddon(ctx, "med_reminders", senior.id);
  const pending = senior.status === "pending_consent";

  const eveningForm = `<details class="form"><summary>Choose a time and add — ${
    money(ADDONS.evening_call.monthlyCents)
  }/mo</summary>
<form method="post">
<input type="hidden" name="action" value="addon_add">
<input type="hidden" name="addon_key" value="evening_call">
<input type="hidden" name="senior_id" value="${esc(senior.id)}">
<label class="f">Evening call time (${esc(name)}'s time)
<select name="call_time">${timeOptions("18:00")}</select></label>
<button class="btn sm" type="submit" style="margin-top:12px">Add the evening call</button>
</form></details>`;

  const medsForm = `<details class="form"><summary>Choose a time and add — ${
    money(ADDONS.med_reminders.monthlyCents)
  }/mo</summary>
<form method="post">
<input type="hidden" name="action" value="addon_add">
<input type="hidden" name="addon_key" value="med_reminders">
<input type="hidden" name="senior_id" value="${esc(senior.id)}">
<div class="pair">
<label class="f">Reminder time<select name="call_time">${timeOptions("08:00")}</select></label>
<label class="f">What to call them (optional)
<input type="text" name="label" maxlength="60" placeholder="your morning pills"></label>
</div>
<p class="mini">Etta will say it's time, ask if they've got them, and let them go.
She never discusses doses, names of medicines, or what anything is for.</p>
<button class="btn sm" type="submit" style="margin-top:12px">Add reminders</button>
</form></details>`;

  const status = pending
    ? `<p class="mini">Waiting on ${esc(name)}'s own yes — have them call Etta on
<b>${ETTA_NUMBER_DISPLAY}</b> from their phone. Nothing is billed until they do.</p>`
    : senior.status === "revoked"
    ? `<p class="mini">${esc(name)} asked Etta to stop calling, and Etta honored it.
Starting again takes a fresh yes from them.</p>`
    : senior.status === "paused"
    ? `<p class="mini">Calls are paused.</p>`
    : checkin
    ? `<p class="mini">Check-in at ${esc(speakTime(checkin.call_time))}, ${
      ctx.plan.frequency.toLowerCase()
    }.</p>`
    : "";

  const removeSecond = secondAddon
    ? `<form method="post" data-confirm="Stop Etta's calls to ${esc(name)}?" style="margin-top:14px">
<input type="hidden" name="action" value="addon_remove">
<input type="hidden" name="addon_id" value="${esc(secondAddon.id)}">
<button class="btn quiet" type="submit">Stop Etta's calls to ${esc(name)}</button></form>`
    : "";

  return `<div class="panel"><div class="eyebrow">${
    isSecond ? "Second parent" : "Your parent"
  }</div>
<h2 style="font-size:21px">${esc(name)}</h2>${status}
${
    senior.status === "active"
      ? addonRow(ctx, ADDONS.evening_call, { senior, live: evening, extraForm: eveningForm }) +
        addonRow(ctx, ADDONS.med_reminders, { senior, live: meds, extraForm: medsForm }) +
        occasionSection(ctx, senior)
      : ""
  }
${removeSecond}</div>`;
}

function occasionSection(ctx: Ctx, senior: Row): string {
  const mine = ctx.occasions.filter((o) => o.senior_id === senior.id);
  const upcoming = mine.map((o) =>
    `<div class="row"><span class="lbl">${esc(o.occasion.replace(/_/g, " "))} — ${
      esc(o.local_date)
    } at ${esc(speakTime(o.call_time))}${
      o.status === "pending_payment" ? " (not paid)" : ""
    }</span>
<form method="post" data-confirm="Cancel this call and refund it?">
<input type="hidden" name="action" value="occasion_cancel">
<input type="hidden" name="occasion_id" value="${esc(o.id)}">
<button class="btn quiet" type="submit">Cancel</button></form></div>`
  ).join("");

  const today = localDate(senior.timezone ?? "America/New_York");
  return `<div class="addon"><div class="addon-body"><b>${
    esc(ONE_TIME.occasion_call.label)
  }</b><p>${esc(ONE_TIME.occasion_call.blurb)}</p>
${upcoming}
<details class="form"><summary>Arrange one — ${money(ONE_TIME.occasion_call.cents)}, one time</summary>
<form method="post">
<input type="hidden" name="action" value="occasion_new">
<input type="hidden" name="senior_id" value="${esc(senior.id)}">
<div class="pair">
<label class="f">What's the occasion
<select name="occasion">
<option value="birthday">A birthday</option>
<option value="anniversary">An anniversary</option>
<option value="holiday">A holiday</option>
<option value="message">A message from the family</option>
<option value="thinking_of_you">Just thinking of them</option>
</select></label>
<label class="f">The day<input type="date" name="local_date" min="${today}" required></label>
</div>
<div class="pair">
<label class="f">Time<select name="call_time">${timeOptions("11:00")}</select></label>
<label class="f">From<input type="text" name="from_name" maxlength="60"
  value="${esc(ctx.family.primary_contact_name ?? "")}"></label>
</div>
<label class="f">What should Etta pass along?
<textarea name="message" maxlength="600" required
  placeholder="Happy birthday, Mom. The kids made you a card and we'll ring after school."></textarea></label>
<p class="mini">Etta reads it in her own voice and says who it's from — she never
pretends to be you. It's an extra call, on top of the usual check-in.</p>
<button class="btn sm" type="submit" style="margin-top:12px">Continue to payment</button>
</form></details></div>
<div class="addon-side"><span class="price">${
    money(ONE_TIME.occasion_call.cents)
  }<small> each</small></span></div></div>`;
}

function planSection(ctx: Ctx): string {
  const opts = (Object.keys(PLANS) as (keyof typeof PLANS)[]).map((key) => {
    const p = PLANS[key];
    const current = ctx.family.plan === key;
    return `<div class="plan-opt${current ? " on" : ""}">
<div style="flex:1"><b>${esc(p.label)}</b>
<em>${esc(p.frequency)} · ${esc(p.lengthGuidance.split("—")[0].trim())} · notes to ${
      p.includedRecipients
    } people</em></div>
<div style="text-align:right"><div class="price">${money(p.monthlyCents)}<small>/mo</small></div>
${
      current
        ? `<span class="mini">Current</span>`
        : billable(ctx) || comped(ctx)
        ? `<form method="post" data-confirm="Switch to ${esc(p.label)} at ${
          money(p.monthlyCents)
        } a month?">
<input type="hidden" name="action" value="plan_change">
<input type="hidden" name="plan" value="${key}">
<button class="btn ghost sm" type="submit" style="margin-top:6px">Switch</button></form>`
        : `<span class="mini">Unavailable</span>`
    }</div></div>`;
  }).join("");

  return `<div class="panel"><div class="eyebrow">Your plan</div>${opts}
<p class="mini">Switching takes effect immediately; Stripe prorates the difference,
so you're never billed twice for the same days.</p></div>`;
}

function membersSection(ctx: Ctx): string {
  const rows = ctx.members.map((m) =>
    `<div class="row"><span class="lbl">${esc(m.name)}${
      m.relationship ? ` <span style="color:var(--ink-soft)">— ${esc(m.relationship)}</span>` : ""
    }${m.escalation_order ? ` · in the escalation chain` : ""}</span>
<form method="post" data-confirm="Remove ${esc(m.name)} from the notes?">
<input type="hidden" name="action" value="member_remove">
<input type="hidden" name="member_id" value="${esc(m.id)}">
<button class="btn quiet" type="submit">Remove</button></form></div>`
  ).join("");

  const seats = chargeableSeats(ctx);
  const count = recipientCount(ctx);
  return `<div class="panel"><div class="eyebrow">Who gets the notes</div>
<div class="row"><span class="lbl">${esc(ctx.family.primary_contact_name ?? "You")}
<span style="color:var(--ink-soft)">— account holder</span></span>
<span class="val" style="font-size:13px;color:var(--ink-soft)">always</span></div>
${rows}
<p class="mini">${count} of ${ctx.plan.includedRecipients} included on your plan used.${
    seats > 0
      ? ` ${seats} extra ${seats === 1 ? "person" : "people"} at ${
        money(ADDONS.care_seat.monthlyCents)
      } each — ${money(seats * ADDONS.care_seat.monthlyCents)}/mo.`
      : ""
  }</p>
<details class="form"><summary>Add someone${
    count >= ctx.plan.includedRecipients
      ? ` — ${money(ADDONS.care_seat.monthlyCents)}/mo`
      : " — included"
  }</summary>
<form method="post">
<input type="hidden" name="action" value="member_add">
<div class="pair">
<label class="f">Their name<input type="text" name="name" maxlength="80" required></label>
<label class="f">Relationship<input type="text" name="relationship" maxlength="40"
  placeholder="daughter"></label>
</div>
<label class="f">Their mobile number<input type="tel" name="phone" maxlength="20"
  placeholder="(555) 201-8890" required></label>
<label class="f" style="flex-direction:row;gap:9px;align-items:flex-start">
<input type="checkbox" name="escalation" value="1" style="width:auto;margin-top:3px">
<span>Also text them if Etta can't reach ${
    esc(seniorName(ctx.seniors[0] ?? { first_name: "your parent" }))
  } at all</span></label>
<p class="mini">Only add people who are expecting to hear from Etta — they'll get a
text after every check-in, and they can reply STOP at any time.</p>
<button class="btn sm" type="submit" style="margin-top:12px">Add them${
    count >= ctx.plan.includedRecipients ? ` (${money(ADDONS.care_seat.monthlyCents)}/mo)` : ""
  }</button>
</form></details></div>`;
}

function sharesSection(ctx: Ctx): string {
  const rows = ctx.shares.map((s) =>
    `<div class="row"><span class="lbl">${esc(s.name)} — ${money(s.share_cents)}/mo
<span style="color:var(--ink-soft)">${
      s.status === "active" ? "contributing" : "invited, not started"
    }</span>${
      s.status === "invited"
        ? `<div class="linkbox">${SITE}/split/${esc(s.invite_token)}</div>`
        : ""
    }</span>
<form method="post" data-confirm="Remove ${esc(s.name)}'s share?">
<input type="hidden" name="action" value="share_remove">
<input type="hidden" name="share_id" value="${esc(s.id)}">
<button class="btn quiet" type="submit">Remove</button></form></div>`
  ).join("");

  const shared = sharedCents(ctx);
  return `<div class="panel"><div class="eyebrow">Share the cost</div>
<p class="lede">Etta is usually paid for by one sibling, which is how one sibling
ends up quietly resenting the others. Invite them to take a share: they pay their
own card each month, and every payment comes straight off your bill.</p>
${rows}
${
    shared > 0
      ? `<p class="mini">${money(shared)} a month is being contributed — that's credited
to your account and comes off your next invoice.</p>`
      : ""
  }
<details class="form"><summary>Invite someone to share it</summary>
<form method="post">
<input type="hidden" name="action" value="share_add">
<div class="pair">
<label class="f">Their name<input type="text" name="name" maxlength="80" required></label>
<label class="f">Relationship<input type="text" name="relationship" maxlength="40"
  placeholder="brother"></label>
</div>
<label class="f">Their monthly share
<select name="share_cents">
<option value="500">$5</option><option value="1000">$10</option>
<option value="1300" selected>$13</option><option value="1500">$15</option>
<option value="2000">$20</option><option value="2500">$25</option>
<option value="3000">$30</option>
</select></label>
<p class="mini">We give you a link to send them yourself — Etta doesn't text people
who haven't asked to hear from her.</p>
<button class="btn sm" type="submit" style="margin-top:12px">Create the invite</button>
</form></details></div>`;
}

function addParentSection(ctx: Ctx): string {
  if (!billable(ctx) && !comped(ctx)) return "";
  const def = ADDONS.second_parent;
  return `<div class="panel"><div class="eyebrow">Add someone</div>
<div class="addon"><div class="addon-body"><b>${esc(def.label)}</b><p>${esc(def.blurb)}</p>
<details class="form"><summary>Set them up — ${money(def.monthlyCents)}/mo once they say yes</summary>
<form method="post">
<input type="hidden" name="action" value="add_parent">
<div class="pair">
<label class="f">Their first name<input type="text" name="parent_name" maxlength="80" required></label>
<label class="f">Their phone<input type="tel" name="parent_phone" maxlength="20"
  placeholder="(555) 201-8890" required></label>
</div>
<div class="pair">
<label class="f">Where they live<select name="timezone">${
    TIMEZONES.map(([label, tz]) =>
      `<option value="${tz}"${
        tz === (ctx.seniors[0]?.timezone ?? "America/New_York") ? " selected" : ""
      }>${label}</option>`
    ).join("")
  }</select></label>
<label class="f">Call time<select name="call_time">${timeOptions("09:30")}</select></label>
</div>
<label class="f">Anything Etta should know? (optional)
<textarea name="notes" maxlength="1000" placeholder="Hard of hearing on the left. Loves the ball game."></textarea></label>
<p class="mini">It must be their own phone — and they'll need to call Etta themselves
to say yes, exactly like the first time. You're not charged before that.</p>
<button class="btn sm" type="submit" style="margin-top:12px">Set them up</button>
</form></details></div>
<div class="addon-side"><span class="price">${money(def.monthlyCents)}<small> /mo</small></span></div>
</div></div>`;
}

function render(ctx: Ctx, params: URLSearchParams): Response {
  const total = monthlyCents(ctx);
  const shared = sharedCents(ctx);
  const yours = Math.max(0, total - shared);
  const familyAddons = ADDON_ORDER
    .filter((k) => ADDONS[k].scope === "family" && k !== "care_seat")
    .map((k) => addonRow(ctx, ADDONS[k], { live: liveAddon(ctx, k) }))
    .join("");

  const concierge = ctx.family.concierge_purchased_at
    ? ""
    : `<div class="addon"><div class="addon-body"><b>${esc(ONE_TIME.concierge_setup.label)}</b>
<p>${esc(ONE_TIME.concierge_setup.blurb)}</p></div>
<div class="addon-side"><span class="price">${
      money(ONE_TIME.concierge_setup.cents)
    }<small> once</small></span>
<form method="post" data-confirm="Book concierge setup for ${
      money(ONE_TIME.concierge_setup.cents)
    }?">
<input type="hidden" name="action" value="concierge">
<button class="btn ghost sm" type="submit">Book it</button></form></div></div>`;

  const body = `${masthead("Your plan")}
<h1>What you're paying for.</h1>
<p class="lede">Change any of it here — nothing is ever sold to your parent, and
nothing that means a call to someone new is billed before they've said yes themselves.</p>
${flashFor(params)}
${planSection(ctx)}
${ctx.seniors.map((s) => seniorSection(ctx, s)).join("")}
${addParentSection(ctx)}
<div class="panel"><div class="eyebrow">For the family</div>${familyAddons}${concierge}</div>
${membersSection(ctx)}
${sharesSection(ctx)}
<div class="panel"><div class="eyebrow">The bill</div>
<div class="row"><span class="lbl">${esc(ctx.plan.label)} plan</span>
<span class="val">${money(ctx.plan.monthlyCents)}</span></div>
${
    ctx.addons.filter((a) => a.status === "active").map((a) => {
      const def = ADDONS[a.addon_key as AddonKey];
      if (!def) return "";
      const who = a.senior_id
        ? ctx.seniors.find((s) => s.id === a.senior_id)
        : null;
      return `<div class="row"><span class="lbl">${esc(def.label)}${
        who ? ` — ${esc(seniorName(who))}` : ""
      }${(a.quantity ?? 1) > 1 ? ` × ${a.quantity}` : ""}</span>
<span class="val">${money(def.monthlyCents * (a.quantity ?? 1))}</span></div>`;
    }).join("")
  }
${
    shared > 0
      ? `<div class="row"><span class="lbl">Shared by family</span>
<span class="val" style="color:var(--sage-deep)">− ${money(shared)}</span></div>`
      : ""
  }
<div class="total"><span>Your share, monthly</span><span class="val">${money(yours)}</span></div>
<p class="mini">${
    ctx.family.subscription_status === "trialing"
      ? "You're in the free trial — nothing is charged until it ends, and not even then unless your parent has said yes."
      : "Add-ons are prorated, so a change today only costs the days that are left."
  }</p>
<div style="display:flex;gap:9px;margin-top:16px;flex-wrap:wrap">
<a class="btn ghost" href="${SITE}/b/${esc(ctx.token)}">Manage billing</a>
<a class="btn ghost" href="${SITE}/f/${esc(ctx.token)}">Back to check-ins</a></div></div>
<div class="foot"><b>Private to your family.</b> Anyone with this exact link can change
your plan — that's what makes it work without logins. To get a fresh link, reply to
Etta's number.<br><br>
Etta is a check-in companion, not medical care or an emergency service.</div>
<script>
document.querySelectorAll("form[data-confirm]").forEach(function (f) {
  f.addEventListener("submit", function (e) {
    if (!window.confirm(f.dataset.confirm)) e.preventDefault();
  });
});
<\/script>`;

  return page(200, body, "Etta — your plan", EXTRA_CSS);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function back(token: string, query: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `${SITE}/m/${token}?${query}`, "Cache-Control": "no-store" },
  });
}

async function handleAction(ctx: Ctx, form: FormData): Promise<Response> {
  const action = String(form.get("action") ?? "");
  const t = ctx.token;

  // Everything except cancelling needs a subscription that can hold a line.
  const needsBilling = [
    "addon_add", "add_parent", "member_add", "plan_change", "occasion_new", "concierge",
  ];
  if (needsBilling.includes(action) && !billable(ctx) && !comped(ctx)) {
    return back(t, "err=billing");
  }

  switch (action) {
    case "addon_add": {
      const key = String(form.get("addon_key") ?? "") as AddonKey;
      const def = ADDONS[key];
      // second_parent is bought through add_parent (it needs a person, and a
      // yes from them); care_seat follows the recipient list, not a button.
      if (!def || key === "second_parent" || key === "care_seat") return back(t, "err=input");

      const seniorId = def.scope === "senior" ? String(form.get("senior_id") ?? "") : null;
      const senior = seniorId ? ctx.seniors.find((s) => s.id === seniorId) : null;
      if (def.scope === "senior" && !senior) return back(t, "err=input");
      if (senior && senior.status !== "active") return back(t, "err=consent");
      if (liveAddon(ctx, key, seniorId ?? undefined)) return back(t, "ok=addon_added");

      const detail: Record<string, unknown> = {};
      let callTime: string | null = null;
      if (key === "evening_call" || key === "med_reminders") {
        callTime = validCallTime(form.get("call_time"));
        if (!callTime) return back(t, "err=input");
        detail.call_time = callTime;
        const label = cleanName(form.get("label"), 60);
        if (label) detail.label = label;
      }

      let addon: Row;
      try {
        addon = await activateAddon(ctx, def, { seniorId, detail });
      } catch (err) {
        console.error("addon add failed:", key, err);
        return back(t, "err=failed");
      }

      if (callTime && senior) {
        await supabase.from("call_schedules").insert({
          senior_id: senior.id,
          call_time: `${callTime}:00`,
          // Evening check-ins follow the plan's days; medication reminders are
          // daily, because pills are.
          days_of_week: key === "med_reminders" ? [0, 1, 2, 3, 4, 5, 6] : ctx.plan.days,
          kind: key === "evening_call" ? "evening" : "medication",
          label: (detail.label as string) ?? null,
          addon_id: addon.id,
        });
      }
      return back(t, "ok=addon_added");
    }

    case "addon_remove": {
      const addon = ctx.addons.find((a) => a.id === String(form.get("addon_id") ?? ""));
      if (!addon) return back(t, "err=input");
      const isParent = addon.addon_key === "second_parent";
      try {
        await deactivateAddon(ctx, addon);
      } catch (err) {
        console.error("addon remove failed:", err);
        return back(t, "err=failed");
      }
      if (isParent && addon.senior_id) {
        // Stop calling them, but never touch their consent history.
        await supabase.from("seniors").update({ status: "paused" }).eq("id", addon.senior_id);
        await supabase.from("call_schedules")
          .update({ active: false }).eq("senior_id", addon.senior_id);
        await supabase.from("calls")
          .update({ status: "canceled", ended_reason: "parent_removed" })
          .eq("senior_id", addon.senior_id).eq("status", "scheduled");
      }
      return back(t, isParent ? "ok=parent_removed" : "ok=addon_removed");
    }

    case "add_parent": {
      const name = cleanName(form.get("parent_name"));
      const phone = normalizePhone(form.get("parent_phone"));
      const timezone = String(form.get("timezone") ?? "");
      const callTime = validCallTime(form.get("call_time"));
      const notes = String(form.get("notes") ?? "").trim().slice(0, 1000) || null;
      if (!name || !phone || !callTime || !ALLOWED_TIMEZONES.has(timezone)) {
        return back(t, "err=input");
      }
      if (phone === ctx.family.primary_contact_phone) return back(t, "err=input");

      const { data: clash } = await supabase.from("seniors")
        .select("id").eq("phone", phone)
        .in("status", ["pending_consent", "active"]).limit(1).maybeSingle();
      if (clash) return back(t, "err=duplicate");

      const { data: senior, error } = await supabase.from("seniors").insert({
        family_id: ctx.family.id,
        first_name: name,
        preferred_name: name,
        phone,
        timezone,
        notes,
        status: "pending_consent",
      }).select("id").single();
      if (error || !senior) {
        console.error("second parent insert failed:", error?.message);
        return back(t, "err=failed");
      }

      await supabase.from("call_schedules").insert({
        senior_id: senior.id,
        call_time: `${callTime}:00`,
        days_of_week: ctx.plan.days,
        kind: "checkin",
      });

      // Born pending: the Stripe line item is created when they consent, not
      // now. See call-events → activatePendingAddons.
      await supabase.from("subscription_addons").insert({
        family_id: ctx.family.id,
        senior_id: senior.id,
        addon_key: "second_parent",
        status: "pending_consent",
        unit_amount_cents: ADDONS.second_parent.monthlyCents,
      });

      if (ctx.family.primary_contact_phone) {
        await sendText([ctx.family.primary_contact_phone],
          `Etta here — ${name} is set up, and nothing is billed yet. The last step ` +
            `is theirs: from ${name}'s own phone, call me on ${ETTA_NUMBER_DISPLAY} ` +
            `and I'll explain what I am and ask them myself. If they say no, nothing ` +
            `happens and you're not charged. — Etta`);
      }
      return back(t, "ok=parent_added");
    }

    case "member_add": {
      const name = cleanName(form.get("name"));
      const phone = normalizePhone(form.get("phone"));
      const relationship = cleanName(form.get("relationship"), 40);
      if (!name || !phone) return back(t, "err=input");

      const escalation = form.get("escalation") === "1"
        ? ctx.members.reduce((n, m) => Math.max(n, m.escalation_order ?? 0), 0) + 1
        : null;

      const { error } = await supabase.from("family_members").insert({
        family_id: ctx.family.id,
        name,
        relationship,
        phone,
        receives_summaries: true,
        escalation_order: escalation,
      });
      if (error) {
        console.error("member insert failed:", error.message);
        return back(t, "err=failed");
      }
      const fresh = await load(t);
      if (fresh) await syncSeats(fresh);
      return back(t, "ok=member_added");
    }

    case "member_remove": {
      const id = String(form.get("member_id") ?? "");
      if (!ctx.members.some((m) => m.id === id)) return back(t, "err=input");
      await supabase.from("family_members").delete().eq("id", id).eq("family_id", ctx.family.id);
      const fresh = await load(t);
      if (fresh) await syncSeats(fresh);
      return back(t, "ok=member_removed");
    }

    case "plan_change": {
      const key = String(form.get("plan") ?? "");
      const plan = PLANS[key as keyof typeof PLANS];
      if (!plan || key === ctx.family.plan) return back(t, "err=input");

      try {
        if (!comped(ctx)) {
          const price = await resolvePlanPrice(plan);
          const sub = await stripe(`subscriptions/${ctx.family.stripe_subscription_id}`);
          // The plan's line is the one carrying a plan price — by ID when the
          // price came from a secret, by lookup key when we created it.
          const planPrices = new Set(
            Object.values(PLANS).map((p) => planPriceId(p)).filter(Boolean),
          );
          const planKeys = new Set(Object.values(PLANS).map((p) => planLookupKey(p)));
          // deno-lint-ignore no-explicit-any
          const item = (sub.items?.data ?? []).find((i: any) =>
            planPrices.has(i.price?.id) || planKeys.has(i.price?.lookup_key)
          );
          if (!item) return back(t, "err=failed");
          await stripe(`subscription_items/${item.id}`, {
            price,
            quantity: "1",
            proration_behavior: "create_prorations",
          });
        }
      } catch (err) {
        console.error("plan change failed:", err);
        return back(t, "err=failed");
      }

      await supabase.from("families").update({ plan: key }).eq("id", ctx.family.id);
      // Frequency lives on the schedules, so the new plan has to reach them.
      for (const s of ctx.seniors) {
        for (const sched of (s.schedules ?? []) as Row[]) {
          if (!sched.active) continue;
          if (sched.kind === "checkin" || sched.kind === "evening") {
            await supabase.from("call_schedules")
              .update({ days_of_week: plan.days }).eq("id", sched.id);
          }
        }
      }
      const fresh = await load(t);
      if (fresh) await syncSeats(fresh); // included recipients differ by plan
      return back(t, "ok=plan_changed");
    }

    case "share_add": {
      const name = cleanName(form.get("name"));
      const relationship = cleanName(form.get("relationship"), 40);
      const cents = parseInt(String(form.get("share_cents") ?? ""), 10);
      if (!name || !Number.isFinite(cents) || cents < 300 || cents > 10000) {
        return back(t, "err=input");
      }
      const { error } = await supabase.from("cost_shares").insert({
        family_id: ctx.family.id,
        name,
        relationship,
        share_cents: cents,
      });
      if (error) {
        console.error("cost share insert failed:", error.message);
        return back(t, "err=failed");
      }
      return back(t, "ok=share_added");
    }

    case "share_remove": {
      const share = ctx.shares.find((s) => s.id === String(form.get("share_id") ?? ""));
      if (!share) return back(t, "err=input");
      if (share.stripe_subscription_id) {
        try {
          await stripe(`subscriptions/${share.stripe_subscription_id}`, undefined, "DELETE");
        } catch (err) {
          console.error("share subscription cancel failed:", err);
        }
      }
      await supabase.from("cost_shares")
        .update({ status: "canceled", canceled_at: new Date().toISOString() })
        .eq("id", share.id);
      return back(t, "ok=share_removed");
    }

    case "occasion_new": {
      const senior = ctx.seniors.find((s) => s.id === String(form.get("senior_id") ?? ""));
      if (!senior) return back(t, "err=input");
      if (senior.status !== "active") return back(t, "err=consent");

      const occasion = String(form.get("occasion") ?? "");
      const fromName = cleanName(form.get("from_name"), 60);
      const message = String(form.get("message") ?? "").trim().slice(0, 600);
      const date = String(form.get("local_date") ?? "");
      const callTime = validCallTime(form.get("call_time"));
      const today = localDate(senior.timezone);
      const limit = localDate(
        senior.timezone,
        new Date(Date.now() + OCCASION_MAX_DAYS * 864e5),
      );
      if (
        !["birthday", "anniversary", "holiday", "message", "thinking_of_you"].includes(occasion) ||
        !fromName || message.length < 2 || !callTime ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || date > limit
      ) return back(t, "err=input");

      const { data: occ, error } = await supabase.from("occasion_calls").insert({
        family_id: ctx.family.id,
        senior_id: senior.id,
        occasion,
        from_name: fromName,
        message,
        local_date: date,
        call_time: `${callTime}:00`,
        amount_cents: ONE_TIME.occasion_call.cents,
      }).select("id").single();
      if (error || !occ) {
        console.error("occasion insert failed:", error?.message);
        return back(t, "err=failed");
      }

      try {
        const session = await stripe("checkout/sessions", {
          mode: "payment",
          ...(ctx.family.stripe_customer_id
            ? { customer: ctx.family.stripe_customer_id as string }
            : {}),
          ...oneTimeLineItem(
            ONE_TIME.occasion_call.priceEnv,
            `Etta — an occasion call for ${seniorName(senior)}`,
            ONE_TIME.occasion_call.cents,
          ),
          "metadata[occasion_id]": occ.id,
          "metadata[family_id]": ctx.family.id,
          success_url: `${SITE}/m/${t}?ok=occasion_paid`,
          cancel_url: `${SITE}/m/${t}`,
        });
        await supabase.from("occasion_calls")
          .update({ stripe_session_id: session.id as string }).eq("id", occ.id);
        return new Response(null, {
          status: 303,
          headers: { Location: session.url as string, "Cache-Control": "no-store" },
        });
      } catch (err) {
        console.error("occasion checkout failed:", err);
        await supabase.from("occasion_calls").delete().eq("id", occ.id);
        return back(t, "err=failed");
      }
    }

    case "occasion_cancel": {
      const occ = ctx.occasions.find((o) => o.id === String(form.get("occasion_id") ?? ""));
      if (!occ) return back(t, "err=input");
      if (occ.stripe_payment_intent) {
        try {
          await stripe("refunds", { payment_intent: occ.stripe_payment_intent });
        } catch (err) {
          console.error("occasion refund failed:", err);
        }
      }
      await supabase.from("occasion_calls").update({ status: "canceled" }).eq("id", occ.id);
      await supabase.from("calls")
        .update({ status: "canceled", ended_reason: "occasion_canceled" })
        .eq("occasion_id", occ.id).eq("status", "scheduled");
      return back(t, "ok=occasion_canceled");
    }

    case "concierge": {
      if (ctx.family.concierge_purchased_at) return back(t, "ok=concierge");
      try {
        const session = await stripe("checkout/sessions", {
          mode: "payment",
          ...(ctx.family.stripe_customer_id
            ? { customer: ctx.family.stripe_customer_id as string }
            : {}),
          ...oneTimeLineItem(
            ONE_TIME.concierge_setup.priceEnv,
            "Etta — concierge setup",
            ONE_TIME.concierge_setup.cents,
          ),
          "metadata[family_id]": ctx.family.id,
          "metadata[purpose]": "concierge_setup",
          success_url: `${SITE}/m/${t}?ok=concierge`,
          cancel_url: `${SITE}/m/${t}`,
        });
        return new Response(null, {
          status: 303,
          headers: { Location: session.url as string, "Cache-Control": "no-store" },
        });
      } catch (err) {
        console.error("concierge checkout failed:", err);
        return back(t, "err=failed");
      }
    }
  }
  return back(t, "err=input");
}

/**
 * A one-time Checkout line. A configured price wins; otherwise the amount is
 * described inline, so a one-off purchase never depends on someone having
 * created a price in the dashboard first.
 */
function oneTimeLineItem(
  env: string,
  name: string,
  cents: number,
): Record<string, string> {
  const configured = priceId(env);
  if (configured) {
    return { "line_items[0][price]": configured, "line_items[0][quantity]": "1" };
  }
  return {
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(cents),
    "line_items[0][price_data][product_data][name]": name,
    "line_items[0][quantity]": "1",
  };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.pathname.split("/").filter(Boolean).pop() ?? "";
  if (!validToken(token)) return notFound("Your plan");

  const ctx = await load(token);
  if (!ctx) return notFound("Your plan");

  if (req.method === "POST") {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return back(token, "err=input");
    }
    try {
      return await handleAction(ctx, form);
    } catch (err) {
      console.error("addons action failed:", err);
      return back(token, "err=failed");
    }
  }

  return render(ctx, url.searchParams);
});
