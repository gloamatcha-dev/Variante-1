"use client";
import { useSyncExternalStore, useCallback } from "react";

export type CartItem = {
  productId: string;
  variantId: string;
  grams: number;
  purchaseType: "once" | "flex" | "annual";
  unitPrice: number;
  quantity: number;
};

const STORAGE_KEY = "gloa_cart";
let listeners: (() => void)[] = [];
let snapshot: CartItem[] = [];
let initialized = false;

function load(): CartItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function persist(items: CartItem[]) {
  snapshot = items;
  if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  for (const l of listeners) l();
}

function init() {
  if (initialized || typeof window === "undefined") return;
  snapshot = load();
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
      c.variantId === item.variantId &&
      c.purchaseType === item.purchaseType
    );
    if (idx >= 0) {
      const next = [...cur];
      next[idx] = { ...next[idx], quantity: next[idx].quantity + (item.quantity || 1) };
      persist(next);
    } else {
      persist([...cur, { ...item, quantity: item.quantity || 1 }]);
    }
  }, []);

  const removeItem = useCallback((productId: string, variantId: string, purchaseType: string) => {
    persist(getSnapshot().filter(c =>
      !(c.productId === productId && c.variantId === variantId && c.purchaseType === purchaseType)
    ));
  }, []);

  const updateQuantity = useCallback((productId: string, variantId: string, purchaseType: string, qty: number) => {
    if (qty <= 0) {
      persist(getSnapshot().filter(c =>
        !(c.productId === productId && c.variantId === variantId && c.purchaseType === purchaseType)
      ));
      return;
    }
    persist(getSnapshot().map(c =>
      c.productId === productId && c.variantId === variantId && c.purchaseType === purchaseType
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
    totalPrice: items.reduce((s, i) => s + i.unitPrice * i.quantity, 0),
  };
}
