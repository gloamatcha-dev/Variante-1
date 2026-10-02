import { getSupabaseAdmin } from "./supabaseAdmin";

export type ResolvedAffiliate = {
  result: string;
  affiliate_link_id?: string;
  affiliate_code_id?: string;
  creator_id?: string;
  customer_discount_code?: string;
  discount_code?: string;
  commission_rule_id?: string | null;
  rule_percent_basis_points?: number | null;
  rule_fixed_cents?: number | null;
  rule_base?: string | null;
};

export type AttributionResult = {
  result: string;
  creator_id?: string;
  commission_id?: string;
  commission_cents?: number;
  base_cents?: number;
  rule_base?: string;
  reason?: string;
};

export type CommissionReversalResult = {
  result: string;
  commission_id?: string;
  reversal_id?: string;
  reversed_cents?: number;
  reversed_total_cents?: number;
  earned_cents?: number;
  fully_reversed?: boolean;
};

export type CommissionBalance = {
  eligible_cents: number;
  pending_cents: number;
  held_cents: number;
  paid_cents: number;
  reversed_cents: number;
};

/**
 * Resolves an affiliate link by slug. Returns the active link, its
 * creator and the frozen commission rule, or a reason it cannot
 * attribute.
 */
export async function resolveAffiliateLink(slug: string): Promise<ResolvedAffiliate | null> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("resolveAffiliateLink: admin client not configured");
    return null;
  }

  const { data, error } = await admin.rpc("resolve_affiliate_link", {
    p_slug: slug,
  });

  if (error) {
    console.error(`resolve_affiliate_link failed for slug "${slug}":`, error.message);
    return null;
  }

  return (data ?? null) as ResolvedAffiliate | null;
}

/**
 * Resolves an affiliate code (case-insensitive). Returns the active
 * code, its creator and the frozen commission rule.
 */
export async function resolveAffiliateCode(code: string): Promise<ResolvedAffiliate | null> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("resolveAffiliateCode: admin client not configured");
    return null;
  }

  const { data, error } = await admin.rpc("resolve_affiliate_code", {
    p_code: code,
  });

  if (error) {
    console.error(`resolve_affiliate_code failed for code "${code}":`, error.message);
    return null;
  }

  return (data ?? null) as ResolvedAffiliate | null;
}

/**
 * Records an affiliate link click, aggregated by day. No
 * person-identifying data is written.
 */
export async function recordAffiliateClick(affiliateLinkId: string): Promise<boolean> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("recordAffiliateClick: admin client not configured");
    return false;
  }

  const { data, error } = await admin.rpc("record_affiliate_click", {
    p_affiliate_link_id: affiliateLinkId,
  });

  if (error) {
    console.error(`record_affiliate_click failed for link ${affiliateLinkId}:`, error.message);
    return false;
  }

  return data === true;
}

/**
 * Attributes a paid order to a creator via an affiliate link or code.
 *
 * The caller presents a source ('affiliate_link' | 'affiliate_code')
 * and a reference (slug or code) — NEVER a creator id, commission
 * amount or rule. The server resolves everything.
 */
export async function attributeOrderToCreator(input: {
  orderId: string;
  source: "affiliate_link" | "affiliate_code";
  reference: string;
  operationId?: string;
}): Promise<AttributionResult | null> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("attributeOrderToCreator: admin client not configured");
    return null;
  }

  const { data, error } = await admin.rpc("attribute_order_to_creator", {
    p_order_id: input.orderId,
    p_source: input.source,
    p_reference: input.reference,
    p_operation_id: input.operationId ?? null,
  });

  if (error) {
    console.error(`attribute_order_to_creator failed for order ${input.orderId}:`, error.message);
    return null;
  }

  return (data ?? null) as AttributionResult | null;
}

/**
 * Reverses commission proportionally when an order is refunded.
 *
 * Takes the order's ABSOLUTE refunded total; the database computes the
 * proportional reversal and writes only the delta. Idempotent by
 * arithmetic.
 */
export async function reverseCreatorCommissionForRefund(input: {
  orderId: string;
  refundedTotalCents: number;
  operationId?: string;
}): Promise<CommissionReversalResult | null> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("reverseCreatorCommissionForRefund: admin client not configured");
    return null;
  }

  const { data, error } = await admin.rpc("reverse_creator_commission_for_refund", {
    p_order_id: input.orderId,
    p_refunded_total_cents: input.refundedTotalCents,
    p_operation_id: input.operationId ?? null,
  });

  if (error) {
    console.error(`reverse_creator_commission_for_refund failed for order ${input.orderId}:`, error.message);
    return null;
  }

  return (data ?? null) as CommissionReversalResult | null;
}

/**
 * Returns what a creator is actually owed: earned minus reversals,
 * broken down by payout state.
 */
export async function getCreatorCommissionBalance(creatorId: string): Promise<CommissionBalance | null> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("getCreatorCommissionBalance: admin client not configured");
    return null;
  }

  const { data, error } = await admin.rpc("creator_commission_balance", {
    p_creator_id: creatorId,
  });

  if (error) {
    console.error(`creator_commission_balance failed for creator ${creatorId}:`, error.message);
    return null;
  }

  return (data ?? null) as CommissionBalance | null;
}
