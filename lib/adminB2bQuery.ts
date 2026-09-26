/**
 * THE ADMIN B2B LIST'S RULES, WITHOUT THE ADMIN.
 *
 * A leaf in the same shape as lib/adminAnnualPlansQuery.ts and for the
 * same reasons: no relative value import, no Supabase, no React, no
 * clock, no environment. Every function takes what it needs, so the
 * suite checks the ACTUAL rules rather than grepping a route.
 *
 * ── READ ONLY, AND THERE IS NOTHING HERE TO WRITE WITH ────────
 *
 * Every B2B write already has exactly one home and keeps it:
 *
 *   creation      lib/b2bCheckout.ts       -> 061's pending writer
 *   activation    the payment webhook      -> 062's two settlers
 *   instalments   the daily job            -> 063's five writers
 *   resolution    the daily job            -> 063's resolve_b2b_delivery
 *   holds         the failure branch       -> 063's hold/release pair
 *   changes       the customer's own route -> 064's request writers
 *   the boundary  the payment webhook      -> 064's apply/settle writers
 *
 * None is reachable from here and none gains a second entry point. In
 * particular the admin may NOT change a quantity, move a cancellation
 * date, release a hold or terminate an agreement: every one of those is
 * a commercial decision, and no such operator capability is approved.
 * The screen this leaf serves has no write verb to offer one with.
 *
 * ── WHY IT IS A SEPARATE LEAF ─────────────────────────────────
 *
 * A B2B agreement is neither a subscription nor a prepaid plan. It has a
 * plan type, a pack count, a business behind it, and either a Stripe
 * subscription or an instalment schedule. Sharing a module with either
 * would mean one set of columns pretending to fit three contracts.
 */

/* ── Vocabulary, restated from the migrations ───────────────── */

/** 006's status CHECK, as it applies to a self-service agreement. */
export const B2B_AGREEMENT_STATUSES = [
  "pending", "active", "cancelled", "completed",
] as const;
export type B2bAgreementStatus = (typeof B2B_AGREEMENT_STATUSES)[number];

/**
 * 'paused' is in 006's CHECK and is UNREACHABLE for self-service:
 * migration 059's b2b_supply_agreements_self_service_status_check
 * forbids it outright. Payment trouble pauses DELIVERIES (060), not the
 * contract. Listed so the vocabulary is complete.
 */
export const B2B_LEGACY_ONLY_STATUS = "paused";

/** 060's payment status vocabulary. */
export const B2B_PAYMENT_STATUSES = [
  "scheduled", "invoiced", "paid", "payment_failed", "action_required", "voided",
] as const;

/** 060's delivery status vocabulary. */
export const B2B_DELIVERY_STATUSES = [
  "scheduled", "held", "dispatched", "delivered", "cancelled",
] as const;

/* ── The groups an operator actually works in ───────────────── */

export const B2B_GROUPS = ["all", "monthly", "annual", "attention", "ending"] as const;
export type B2bGroup = (typeof B2B_GROUPS)[number];

export type B2bGroupFilter = {
  planTypeIn?: readonly string[];
  statusIn?: readonly string[];
  /** Only rows carrying a cancellation promise. */
  cancellingOnly?: boolean;
  /** Only rows whose payments or deliveries need somebody. */
  attentionOnly?: boolean;
};

/**
 * What each group means, as data rather than as a query.
 *
 * "attention" is the one an operator opens first: a failed instalment or
 * a held delivery is a customer not receiving Matcha, and those are the
 * two states nothing in the system resolves on its own.
 */
export function b2bGroupFilter(group: B2bGroup): B2bGroupFilter {
  switch (group) {
    case "monthly": return { planTypeIn: ["monthly"] };
    case "annual": return { planTypeIn: ["annual"] };
    case "ending": return { cancellingOnly: true, statusIn: ["active"] };
    case "attention": return { attentionOnly: true };
    default: return {};
  }
}

/* ── Paging and sorting ─────────────────────────────────────── */

export const B2B_PAGE_SIZE = 25;
export const B2B_MAX_PAGE = 200;
/** Never more than this many child rows per page of agreements. */
export const B2B_CHILDREN_CAP = 500;

export const B2B_SORT_COLUMN: Record<string, { column: string; ascending: boolean }> = {
  newest: { column: "created_at", ascending: false },
  oldest: { column: "created_at", ascending: true },
  ending: { column: "cancellation_effective_at", ascending: true },
};

export type B2bAdminQuery = {
  group: B2bGroup;
  page: number;
  sort: keyof typeof B2B_SORT_COLUMN;
  search: string;
};

/**
 * Only characters PostgREST's `or=` grammar cannot read as syntax.
 *
 * The same posture the annual list takes: the search term is
 * interpolated into a filter string, so every separator and quoting
 * character is removed HERE rather than escaped at the call site.
 */
export function normaliseB2bSearch(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[(),."'\\*:%]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/** Every filter allowlisted; anything unrecognised falls back. */
export function resolveB2bAdminQuery(body: unknown): B2bAdminQuery {
  const b = (body ?? {}) as Record<string, unknown>;
  const group = B2B_GROUPS.includes(b.group as B2bGroup) ? (b.group as B2bGroup) : "all";
  const sort = typeof b.sort === "string" && b.sort in B2B_SORT_COLUMN
    ? (b.sort as keyof typeof B2B_SORT_COLUMN)
    : "newest";
  const rawPage = typeof b.page === "number" && Number.isSafeInteger(b.page) ? b.page : 1;
  return {
    group,
    sort,
    page: Math.min(Math.max(rawPage, 1), B2B_MAX_PAGE),
    search: normaliseB2bSearch(b.search),
  };
}

export function b2bPageRange(query: B2bAdminQuery): { from: number; to: number } {
  const from = (query.page - 1) * B2B_PAGE_SIZE;
  return { from, to: from + B2B_PAGE_SIZE - 1 };
}

/* ── The columns the screen is allowed to see ───────────────── */

/**
 * ── WHAT IS DELIBERATELY NOT IN THIS LIST ─────────────────────
 *
 * shipping_address_snapshot, billing_address_snapshot and
 * customer_snapshot. An operator looking at contract state does not
 * need a business's address to do it, and the annual list sets the same
 * precedent - "No shipping address, no billing address".
 *
 * stripe_subscription_id IS included, as a PRESENCE flag only: the route
 * turns it into a boolean before it leaves the server (see
 * b2bAgreementSummary), because an operator needs to know a
 * subscription exists without the id being copied into a screenshot.
 */
export const B2B_LIST_COLUMNS =
  "id, plan_type, status, currency, quantity_packs, pack_grams, "
  + "base_monthly_product_net_cents, contract_product_net_cents, instalment_count, "
  + "pending_quantity_packs, pending_quantity_requested_at, "
  + "started_at, commitment_end_at, next_delivery_at, ended_at, "
  + "cancellation_requested_at, cancellation_effective_at, cancellation_reason, "
  + "termination_reason, stripe_subscription_id, business_snapshot, created_at";

export const B2B_PAYMENT_COLUMNS =
  "id, supply_agreement_id, instalment_number, due_at, status, net_cents, "
  + "tax_cents, gross_cents, invoiced_at, paid_at, failed_at, action_required_at, voided_at";

export const B2B_DELIVERY_COLUMNS =
  "id, supply_agreement_id, delivery_number, scheduled_for, quantity_packs, status, "
  + "hold_reason, resolved_at, shipping_class, tracking_number, "
  + "dispatched_at, delivered_at, cancelled_at";

/* ── Shaping what the screen receives ───────────────────────── */

export type B2bAgreementRow = {
  id: string;
  plan_type: string | null;
  status: string;
  currency: string;
  quantity_packs: number | null;
  pack_grams: number | null;
  base_monthly_product_net_cents: number | null;
  contract_product_net_cents: number | null;
  instalment_count: number | null;
  pending_quantity_packs: number | null;
  pending_quantity_requested_at: string | null;
  started_at: string | null;
  commitment_end_at: string | null;
  next_delivery_at: string | null;
  ended_at: string | null;
  cancellation_requested_at: string | null;
  cancellation_effective_at: string | null;
  cancellation_reason: string | null;
  termination_reason: string | null;
  stripe_subscription_id: string | null;
  business_snapshot: Record<string, unknown> | null;
  created_at: string;
};

export type B2bPaymentRow = {
  id: string; supply_agreement_id: string; instalment_number: number;
  due_at: string; status: string;
  net_cents: number; tax_cents: number | null; gross_cents: number | null;
  invoiced_at: string | null; paid_at: string | null;
  failed_at: string | null; action_required_at: string | null; voided_at: string | null;
};

export type B2bDeliveryRow = {
  id: string; supply_agreement_id: string; delivery_number: number;
  scheduled_for: string; quantity_packs: number; status: string;
  hold_reason: string | null; resolved_at: string | null; shipping_class: string | null;
  tracking_number: string | null;
  dispatched_at: string | null; delivered_at: string | null; cancelled_at: string | null;
};

export type B2bAgreementSummary = {
  id: string;
  planType: string | null;
  status: string;
  company: string | null;
  quantityPacks: number | null;
  packGrams: number | null;
  pendingQuantityPacks: number | null;
  /** Monthly: the recurring product net. Annual: the contract total. */
  amountNetCents: number | null;
  currency: string;
  instalmentCount: number | null;
  startedAt: string | null;
  commitmentEndAt: string | null;
  nextDeliveryAt: string | null;
  endedAt: string | null;
  cancellationRequestedAt: string | null;
  cancellationEffectiveAt: string | null;
  cancellationReason: string | null;
  terminationReason: string | null;
  /** PRESENCE ONLY. The id itself never leaves the server. */
  hasStripeSubscription: boolean;
  createdAt: string;
  /** Derived from the child rows, so the list needs no second query. */
  nextDueAt: string | null;
  nextDueStatus: string | null;
  paidInstalments: number;
  failedPayments: number;
  actionRequiredPayments: number;
  heldDeliveries: number;
  unresolvedDeliveries: number;
  needsAttention: boolean;
};

/** The company name, from the snapshot the contract was signed with. */
export function b2bCompanyOf(snapshot: Record<string, unknown> | null): string | null {
  if (!snapshot) return null;
  for (const key of ["companyName", "company_name", "company"]) {
    const v = snapshot[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * One agreement, with everything the list needs already counted.
 *
 * The counts are derived from the child rows the route already fetched,
 * so a page of 25 agreements costs three queries rather than 51.
 */
export function b2bAgreementSummary(
  row: B2bAgreementRow,
  payments: readonly B2bPaymentRow[],
  deliveries: readonly B2bDeliveryRow[]
): B2bAgreementSummary {
  const mine = payments.filter(p => p.supply_agreement_id === row.id);
  const myDeliveries = deliveries.filter(d => d.supply_agreement_id === row.id);

  const open = mine
    .filter(p => p.status === "scheduled" || p.status === "invoiced")
    .sort((a, b) => a.due_at.localeCompare(b.due_at))[0] ?? null;

  const failedPayments = mine.filter(p => p.status === "payment_failed").length;
  const actionRequiredPayments = mine.filter(p => p.status === "action_required").length;
  const heldDeliveries = myDeliveries.filter(d => d.status === "held").length;
  const unresolvedDeliveries = myDeliveries
    .filter(d => d.status === "scheduled" && d.resolved_at === null).length;

  return {
    id: row.id,
    planType: row.plan_type,
    status: row.status,
    company: b2bCompanyOf(row.business_snapshot),
    quantityPacks: row.quantity_packs,
    packGrams: row.pack_grams,
    pendingQuantityPacks: row.pending_quantity_packs,
    amountNetCents: row.plan_type === "annual"
      ? row.contract_product_net_cents
      : row.base_monthly_product_net_cents,
    currency: row.currency,
    instalmentCount: row.instalment_count,
    startedAt: row.started_at,
    commitmentEndAt: row.commitment_end_at,
    nextDeliveryAt: row.next_delivery_at,
    endedAt: row.ended_at,
    cancellationRequestedAt: row.cancellation_requested_at,
    cancellationEffectiveAt: row.cancellation_effective_at,
    cancellationReason: row.cancellation_reason,
    terminationReason: row.termination_reason,
    hasStripeSubscription: !!row.stripe_subscription_id,
    createdAt: row.created_at,
    nextDueAt: open?.due_at ?? null,
    nextDueStatus: open?.status ?? null,
    paidInstalments: mine.filter(p => p.status === "paid").length,
    failedPayments,
    actionRequiredPayments,
    heldDeliveries,
    unresolvedDeliveries,
    // A FAILED PAYMENT OR A HELD DELIVERY is a customer not receiving
    // Matcha, and neither resolves on its own. An unresolved slot does -
    // the daily job routes it - so it is reported but does not raise a
    // flag.
    needsAttention: failedPayments > 0 || actionRequiredPayments > 0 || heldDeliveries > 0,
  };
}

/** Does this summary belong in the group the operator asked for? */
export function b2bSummaryInGroup(summary: B2bAgreementSummary, group: B2bGroup): boolean {
  const filter = b2bGroupFilter(group);
  if (filter.planTypeIn && !filter.planTypeIn.includes(summary.planType ?? "")) return false;
  if (filter.statusIn && !filter.statusIn.includes(summary.status)) return false;
  if (filter.cancellingOnly && !summary.cancellationEffectiveAt) return false;
  if (filter.attentionOnly && !summary.needsAttention) return false;
  return true;
}
