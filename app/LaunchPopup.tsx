"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";

/**
 * THE LAUNCH-LIST POPUP.
 *
 * One blue panel over the page, pointing at /launch. It is a POINTER,
 * not a form: no email field, no submission, no second signup path. The
 * list itself lives on /launch and stays the only place that collects an
 * address, so there is exactly one waitlist flow to reason about.
 *
 * ── IT DOES NOT TOUCH THE PAGE UNDER IT ───────────────────────
 * Rendered as the last child of the site shell, next to <CartDrawer/>.
 * Nothing above it moves, no wrapper is introduced and no layout is
 * recalculated: when it is closed this component returns null and the
 * DOM is byte-for-byte what it was.
 *
 * ── WHEN IT OPENS ─────────────────────────────────────────────
 * Never on the first paint - a panel that lands before the page has been
 * read is an interruption, not an offer. It arms two triggers and the
 * FIRST one wins:
 *
 *     8 seconds after arrival,  OR  30% of the page scrolled.
 *
 * Whichever fires first cancels the other, so it can only ever open once
 * per page.
 *
 * ── WHERE IT DOES NOT OPEN ────────────────────────────────────
 * /launch itself (the visitor is already there), and every route that is
 * a task rather than a browse: account, auth and order. Those are flows
 * where a marketing panel is in the way. The admin area is its own route
 * tree and never mounts this shell at all.
 *
 * ── DISMISSAL ─────────────────────────────────────────────────
 * One localStorage key holding one timestamp, read once on mount:
 *
 *     gloa_launch_popup_dismissed_at
 *
 * Closed means closed for 7 days. No cookie, no server call, no id, no
 * profile - the value is a number of milliseconds and nothing about the
 * visitor. A browser with storage blocked throws on access; the reads
 * and writes are wrapped so that a failure means "show it" rather than
 * "crash the shell".
 *
 * ── THE MODAL CONTRACT ────────────────────────────────────────
 * Copied from <CartDrawer/> rather than invented, so the site has one
 * modal behaviour: role="dialog", aria-modal, focus moved in on open and
 * handed back on close, Escape closes, the backdrop closes, and the body
 * stops scrolling while it is open.
 */

import {
  LAUNCH_POPUP_STORAGE_KEY as STORAGE_KEY,
  LAUNCH_POPUP_DELAY_MS as DELAY_MS,
  LAUNCH_POPUP_SCROLL_RATIO as SCROLL_RATIO,
  LAUNCH_POPUP_SETTLE_MS as SETTLE_MS,
  suppressesLaunchPopup,
  launchPopupDismissed,
  overlayBlocksLaunchPopup,
} from "../lib/launchPopupRules";

/** Storage can throw (Safari private mode, blocked cookies). A failure
 *  reads as "not dismissed" - the visitor sees the panel, which is the
 *  harmless direction to fail in. */
function dismissedRecently(now: number): boolean {
  try {
    return launchPopupDismissed(window.localStorage.getItem(STORAGE_KEY), now);
  } catch {
    return false;
  }
}

function rememberDismissal(now: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(now));
  } catch {
    /* storage unavailable - it will offer itself again next visit */
  }
}

export function LaunchPopup({ route, menuOpen = false, cartOpen = false }: {
  route: string;
  /** The shell's existing overlay state. See overlayBlocksLaunchPopup. */
  menuOpen?: boolean;
  cartOpen?: boolean;
}) {
  // OWED AND VISIBLE ARE TWO DIFFERENT THINGS.
  //
  // `due` is "the trigger fired and this panel is owed"; `open` is "it is
  // on the screen". They used to be one flag, which is why a timer that
  // came due behind an open menu put the panel straight over it. Keeping
  // them apart is what lets the panel be HELD rather than lost.
  const [due, setDue] = useState(false);
  // Starts closed on the server AND on the first client render, so the
  // markup both sides produce is identical and hydration cannot mismatch.
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Its one appearance per page, and whether it ever had to wait.
  const shownRef = useRef(false);
  const heldRef = useRef(false);

  const blocked = overlayBlocksLaunchPopup({ menuOpen, cartOpen });

  const close = useCallback(() => {
    rememberDismissal(Date.now());
    setOpen(false);
    setDue(false);
  }, []);

  // ── ARMING ──────────────────────────────────────────────────
  useEffect(() => {
    if (suppressesLaunchPopup(route)) return;
    if (dismissedRecently(Date.now())) return;

    let done = false;
    const fire = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      window.removeEventListener("scroll", onScroll);
      // Owed, not shown. Whether it may be shown is decided below.
      setDue(true);
    };
    const onScroll = () => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      if (scrollable <= 0) return;
      if (window.scrollY / scrollable >= SCROLL_RATIO) fire();
    };
    const timer = window.setTimeout(fire, DELAY_MS);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      done = true;
      window.clearTimeout(timer);
      window.removeEventListener("scroll", onScroll);
      // A NEW PAGE IS A NEW DECISION. Without this a panel still owed
      // from the previous route would land the instant the next one
      // mounted - including on a route that suppresses it entirely.
      // The new route arms its own trigger a line above.
      setDue(false);
    };
  }, [route]);

  // ── ONE SCREEN, ONE OVERLAY ─────────────────────────────────
  //
  // The only place `open` is ever set to true. While the mobile menu or
  // the cart drawer owns the screen this holds - `due` stays true, so
  // nothing is lost - and it offers the panel once the screen is free.
  //
  // shownRef keeps the once-per-page contract: after a dismissal `due`
  // is false anyway, and this must not re-open behind it either way.
  useEffect(() => {
    if (!due || open || shownRef.current) return;
    if (suppressesLaunchPopup(route)) return;
    if (blocked) { heldRef.current = true; return; }
    // Only a panel that actually waited gets the settle pause; one that
    // was never blocked keeps the timing it always had.
    const wait = heldRef.current ? SETTLE_MS : 0;
    const t = window.setTimeout(() => { shownRef.current = true; setOpen(true); }, wait);
    return () => window.clearTimeout(t);
  }, [due, open, blocked, route]);

  // ── THE MODAL CONTRACT, THE WAY THE CART DRAWER DOES IT ──────
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => closeRef.current?.focus());
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      prev?.focus?.();
    };
  }, [open, close]);

  if (!open) return null;

  return <div className="lp-backdrop" onClick={close} onKeyDown={e => e.key === "Escape" && close()} role="button" tabIndex={-1} aria-hidden="true">
    {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
    <div className="lp-panel" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}
         role="dialog" aria-modal="true" aria-labelledby="lp-title" aria-describedby="lp-body">
      <button ref={closeRef} type="button" className="lp-close" onClick={close} aria-label="Popup schließen">×</button>
      <p className="eyebrow lp-eyebrow">PRELAUNCH</p>
      <h2 className="lp-headline" id="lp-title">
        <span className="lp-line lp-line-1">Zum Launch</span>
        {/* THE ONE ACCENT. Raspberry on GLOA blue measures 1.04:1 - the
            two tokens sit at almost the same luminance, so the word would
            be invisible. It keeps its raspberry on a cream ground
            instead, which is 6.05:1 and the same marker the homepage
            lifestyle band already uses. No colour was added to do it. */}
        <i className="lp-line lp-line-2">benachrichtigt</i>
        <span className="lp-line lp-line-3">werden.</span>
      </h2>
      <p className="lp-body" id="lp-body">Trag dich ein und wir schicken dir eine kurze Nachricht, sobald GLOA online geht.</p>
      <Link className="cta lp-cta" href="/launch" onClick={close}>ZUR LAUNCH LIST</Link>
    </div>
  </div>;
}
