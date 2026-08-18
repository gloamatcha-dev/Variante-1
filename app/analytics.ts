export type EventName = "shop_click" | "product_view" | "add_to_cart" | "checkout_start" | "b2b_page_view" | "calculator_start" | "calculator_complete" | "sample_request_start" | "sample_request_submit" | "wholesale_request_start" | "wholesale_request_submit" | "newsletter_signup" | "shop_scroll_product" | "shop_to_matcha";

export function track(event: EventName, data: Record<string, string | number> = {}) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("gloa:analytics", { detail: { event, ...data } }));
}
