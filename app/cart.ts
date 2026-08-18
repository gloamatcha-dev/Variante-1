"use client";
import { useSyncExternalStore, useCallback } from "react";

export type CartItem = {
  productId: string;
  variantId: string;
  label: string;
  grams: number;
  purchaseType: "once";
  unitPriceCents: number; // DISPLAY CACHE ONLY - NOT authoritative for checkout
  quantity: number;
};

const STORAGE_KEY = "gloa_cart";
let listeners: (() => void)[] = [];
let snapshot: CartItem[] = [];
let initialized = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function load(): CartItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const items: unknown[] = JSON.parse(raw);
    return items.filter((item: any) =>
      item &&
      typeof item.variantId === "string" &&
      UUID_RE.test(item.variantId) &&
      typeof item.unitPriceCents === "number" &&
      Number.isInteger(item.unitPriceCents) &&
      item.purchaseType === "once"
    ) as CartItem[];
  } catch { return []; }
}

function persist(items: CartItem[]) {
  snapshot = items;
  if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  for (const l of listeners) l();
}

function init() {
  if (initialized || typeof window === "undefined") return;
  const cleaned = load();
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const original = JSON.parse(raw);
      if (original.length !== cleaned.length) persist(cleaned);
      else snapshot = cleaned;
    } catch { snapshot = cleaned; }
  } else {
    snapshot = cleaned;
  }
  initialized = true;
}

function subscribe(cb: () => void) {
  init();
  listeners = [...listeners, cb];
  return () => { listeners = listeners.filter(l => l !== cb); };
}

function getSnapshot() { init(); return snapshot; }
function getServerSnapshot(): CartItem[] { return []; }

export function useCart() {
  const items = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const addItem = useCallback((item: Omit<CartItem, "quantity"> & { quantity?: number }) => {
    const cur = getSnapshot();
    const idx = cur.findIndex(c =>
      c.productId === item.productId &&
      c.variantId === item.variantId
    );
    if (idx >= 0) {
      const next = [...cur];
      next[idx] = { ...next[idx], quantity: next[idx].quantity + (item.quantity || 1) };
      persist(next);
    } else {
      persist([...cur, { ...item, quantity: item.quantity || 1 }]);
    }
  }, []);

  const removeItem = useCallback((productId: string, variantId: string) => {
    persist(getSnapshot().filter(c =>
      !(c.productId === productId && c.variantId === variantId)
    ));
  }, []);

  const updateQuantity = useCallback((productId: string, variantId: string, qty: number) => {
    if (qty <= 0) {
      persist(getSnapshot().filter(c =>
        !(c.productId === productId && c.variantId === variantId)
      ));
      return;
    }
    persist(getSnapshot().map(c =>
      c.productId === productId && c.variantId === variantId
        ? { ...c, quantity: qty } : c
    ));
  }, []);

  const clearCart = useCallback(() => persist([]), []);

  return {
    items,
    addItem,
    removeItem,
    updateQuantity,
    clearCart,
    totalCount: items.reduce((s, i) => s + i.quantity, 0),
    totalCents: items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0),
  };
}
