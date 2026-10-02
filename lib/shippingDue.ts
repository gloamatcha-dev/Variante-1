import { getSupabaseAdmin } from "./supabaseAdmin";

export type ShippingDueState =
  | "shipped"
  | "cancelled"
  | "no_dispatch_target_configured"
  | "overdue"
  | "due_today"
  | "upcoming"
  | "order_missing";

export type ShippingDueResult = {
  state: ShippingDueState;
  due_date?: string;
  shipped_at?: string;
  source?: "order_ship_by_date" | "dispatch_sla";
  reason?: string;
};

/**
 * Returns the shipping due state of one order.
 *
 * Six states: shipped, cancelled, no_dispatch_target_configured,
 * overdue, due_today, upcoming. Until an owner configures
 * dispatch_sla_business_days in operations_config, every unshipped
 * order reports 'no_dispatch_target_configured'.
 */
export async function getOrderShippingDue(orderId: string): Promise<ShippingDueResult | null> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("getOrderShippingDue: admin client not configured");
    return null;
  }

  const { data, error } = await admin.rpc("order_shipping_due", {
    p_order_id: orderId,
  });

  if (error) {
    console.error(`order_shipping_due failed for order ${orderId}:`, error.message);
    return null;
  }

  return (data ?? null) as ShippingDueResult | null;
}
