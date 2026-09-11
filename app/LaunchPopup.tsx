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
  suppressesLaunchPopup,
  launchPopupDismissed,
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

export function LaunchPopup({ route }: { route: string }) {
  // Starts closed on the server AND on the first client render, so the
  // markup both sides produce is identical and hydration cannot mismatch.
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    rememberDismissal(Date.now());
    setOpen(false);
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
      setOpen(true);
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
    };
  }, [route]);

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
