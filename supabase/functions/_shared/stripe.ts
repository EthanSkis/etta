// stripe — the small slice of the Stripe API this product needs, without a
// dependency. Form-encoded POSTs, GETs, DELETEs, and the subscription-item
// operations that adding and removing an add-on comes down to.
//
// The key check exists because a misconfigured key is the likeliest billing
// outage and the failure is otherwise inscrutable: a key copied while still
// masked in Stripe's dashboard contains "…" (U+2026), and fetch rejects it as
// a non-ByteString header long before Stripe ever sees it.

export function stripeKey(): string {
  // Dashboard pastes routinely carry trailing newlines; a header value with
  // one is rejected outright, so normalize before anything else touches it.
  return (Deno.env.get("STRIPE_SECRET_KEY") ?? "").trim();
}

export function stripeKeyProblem(): string | null {
  const key = stripeKey();
  if (!key) return "STRIPE_SECRET_KEY is not set";
  if (/[^\x20-\x7E]/.test(key)) {
    return key.includes("…") || key.includes("...")
      ? "STRIPE_SECRET_KEY looks like the masked key from the Stripe dashboard " +
        "(it contains an ellipsis) — reveal the key and paste it in full"
      : "STRIPE_SECRET_KEY contains a non-ASCII character (bad copy/paste)";
  }
  if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]{20,}$/.test(key)) {
    return "STRIPE_SECRET_KEY is not shaped like a Stripe secret key";
  }
  return null;
}

// deno-lint-ignore no-explicit-any
export async function stripe(
  path: string,
  form?: Record<string, string>,
  method?: "GET" | "POST" | "DELETE",
): Promise<any> {
  const problem = stripeKeyProblem();
  if (problem) {
    console.error("stripe config error:", problem);
    throw new Error(problem);
  }
  const verb = method ?? (form ? "POST" : "GET");
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: verb,
    headers: {
      Authorization: `Bearer ${stripeKey()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const body = await res.json();
  if (!res.ok) {
    console.error("stripe error:", verb, path, res.status, JSON.stringify(body).slice(0, 300));
    throw new Error(body?.error?.message ?? "payment operation failed");
  }
  return body;
}

/**
 * The price ID for a recurring add-on, creating it in Stripe the first time
 * it's needed.
 *
 * Configured secrets win (see catalog.ts). Without one, the price is looked
 * up — and if absent, created — under a stable lookup key, so a new add-on
 * goes live without anyone having to paste price IDs between two dashboards
 * to make the first sale work. The lookup key is what makes this idempotent:
 * a second call finds the price the first one made.
 */
export async function ensureRecurringPrice(
  lookupKey: string,
  productName: string,
  cents: number,
): Promise<string> {
  const found = await stripe(
    `prices?lookup_keys[0]=${encodeURIComponent(lookupKey)}&active=true&limit=1`,
  );
  const existing = found?.data?.[0]?.id;
  if (existing) return existing as string;

  try {
    const price = await stripe("prices", {
      currency: "usd",
      unit_amount: String(cents),
      "recurring[interval]": "month",
      "product_data[name]": productName,
      lookup_key: lookupKey,
    });
    return price.id as string;
  } catch (err) {
    // Two families adding the same add-on at once: whoever lost the race
    // re-reads the price the winner just created.
    const retry = await stripe(
      `prices?lookup_keys[0]=${encodeURIComponent(lookupKey)}&active=true&limit=1`,
    );
    const id = retry?.data?.[0]?.id;
    if (id) return id as string;
    throw err;
  }
}

/**
 * The same, for a one-time charge. Checkout in subscription mode won't accept
 * an inline price for a one-off line (only recurring ones), so a real Price
 * has to exist before concierge setup can ride along on a signup.
 */
export async function ensureOneTimePrice(
  lookupKey: string,
  productName: string,
  cents: number,
): Promise<string> {
  const found = await stripe(
    `prices?lookup_keys[0]=${encodeURIComponent(lookupKey)}&active=true&limit=1`,
  );
  const existing = found?.data?.[0]?.id;
  if (existing) return existing as string;

  try {
    const price = await stripe("prices", {
      currency: "usd",
      unit_amount: String(cents),
      "product_data[name]": productName,
      lookup_key: lookupKey,
    });
    return price.id as string;
  } catch (err) {
    const retry = await stripe(
      `prices?lookup_keys[0]=${encodeURIComponent(lookupKey)}&active=true&limit=1`,
    );
    const id = retry?.data?.[0]?.id;
    if (id) return id as string;
    throw err;
  }
}

/**
 * Add a recurring line to a subscription, or bump its quantity if it's
 * already there. Returns the subscription item.
 *
 * Prorations are on: a family adding an evening call on the 20th pays for
 * ten days of it, not a month. During a trial nothing is charged at all,
 * which is the behaviour we want — an add-on chosen on day two of the trial
 * shouldn't quietly start the money before the senior has said yes.
 */
// deno-lint-ignore no-explicit-any
export async function addSubscriptionItem(
  subscriptionId: string,
  price: string,
  quantity = 1,
): Promise<any> {
  return await stripe("subscription_items", {
    subscription: subscriptionId,
    price,
    quantity: String(quantity),
    proration_behavior: "create_prorations",
  });
}

export async function setItemQuantity(itemId: string, quantity: number): Promise<void> {
  await stripe(`subscription_items/${itemId}`, {
    quantity: String(quantity),
    proration_behavior: "create_prorations",
  });
}

/**
 * Remove a line from a subscription. A 404 means it's already gone, which is
 * the state we wanted — removing an add-on must never fail loudly at a
 * family for a reason that only matters to us.
 */
export async function removeSubscriptionItem(itemId: string): Promise<void> {
  try {
    await stripe(
      `subscription_items/${itemId}`,
      { proration_behavior: "create_prorations" },
      "DELETE",
    );
  } catch (err) {
    console.error("subscription item delete failed (continuing):", itemId, err);
  }
}

/**
 * Put money on a customer's account, to come off their next invoice.
 * A negative amount is a credit in Stripe's sign convention.
 */
export async function creditCustomer(
  customerId: string,
  cents: number,
  description: string,
): Promise<void> {
  await stripe(`customers/${customerId}/balance_transactions`, {
    amount: String(-Math.abs(cents)),
    currency: "usd",
    description,
  });
}
