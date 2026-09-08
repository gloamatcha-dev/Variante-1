"use client";
import { useState } from "react";
import Link from "next/link";
import { BRAND } from "./content";
import { GLOA_LAUNCH_FULL_LABEL } from "../lib/launchCountdown";
import {
  LAUNCH_DISCOUNT_LABEL,
  LAUNCH_DISCOUNT_PERCENT,
  LAUNCH_DISCOUNT_UNTIL_LABEL,
} from "../lib/launchDiscount";

/**
 * /launch - THE LAUNCH LIST.
 *
 * One page with one job: let somebody ask to be told when GLOA opens.
 * No products, no prices, no shop grid, no second call to action. The
 * homepage teases and links here; this page finishes the thought.
 *
 * -- IT IS NOT A NEWSLETTER SIGNUP, AND IT DOES NOT LOOK LIKE ONE --
 * The consent box is not pre-ticked, the wording names the single
 * purpose out loud, and the page promises nothing it will not send. The
 * privacy notice says GLOA runs no newsletter; this page is what keeps
 * that true rather than quietly making it false.
 *
 * -- THE OUTCOME STATES ---------------------------------------
 * Confirming and withdrawing happen in the API routes, which redirect
 * back here with ?state=. Rendering the outcome here rather than in the
 * route means the brand's type and colour are the ones already in
 * globals.css, and the token drops out of the address bar on the way.
 */

type FormStatus = "idle" | "sending" | "submitted" | "error";

/**
 * Set by /api/launch/confirm and /api/launch/withdraw.
 *
 * TWO CONFIRMED STATES, BECAUSE THERE ARE TWO TRUTHS.
 *
 * `confirmed-code` is the only one that says a mail with the code is on
 * its way, and the confirm route emits it only after the provider took
 * that mail and the row recorded it. `confirmed` is the neutral one: a
 * version 1 contact, whose consent never covered a code, and every send
 * that failed or ended unclear. Both are true statements about the
 * confirmation, which is what the visitor actually came here to do.
 *
 * Telling somebody to search their spam folder for a mail that was never
 * sent wastes their time and teaches them we do not know what we did.
 */
type OutcomeState = "confirmed" | "confirmed-code" | "withdrawn" | "expired" | "invalid" | "error";

const OUTCOMES: Record<
  OutcomeState,
  { eyebrow: string; primary: string; secondary: string; body: string; hint?: string }
> = {
  confirmed: {
    eyebrow: "BESTÄTIGT",
    primary: "YOU'RE ON",
    secondary: "THE LIST.",
    body: "Wir sagen dir Bescheid, sobald GLOA live geht.",
  },
  "confirmed-code": {
    eyebrow: "BESTÄTIGT",
    primary: "YOU'RE ON",
    secondary: "THE LIST.",
    // The percentage comes from lib/launchDiscount.ts for the same reason
    // the hero figure does: this page may not name a number the checkout
    // does not honour.
    body: `Deine Eintragung ist bestätigt. Deinen ${LAUNCH_DISCOUNT_PERCENT}-%-Code haben wir dir per E-Mail geschickt.`,
    hint: "Du findest die Mail nicht? Schau bitte auch in deinem Spam- oder Werbung-Ordner nach.",
  },
  withdrawn: {
    eyebrow: "AUSGETRAGEN",
    primary: "ALLES",
    secondary: "ERLEDIGT.",
    body: "Du bekommst von uns keine Launch-Benachrichtigung. Wenn du es dir anders überlegst, kannst du dich jederzeit neu eintragen.",
  },
  expired: {
    eyebrow: "LINK ABGELAUFEN",
    primary: "DER LINK",
    secondary: "IST ALT.",
    body: "Bestätigungslinks gelten 14 Tage. Trag dich einfach noch einmal ein, dann schicken wir dir einen neuen.",
  },
  invalid: {
    eyebrow: "LINK UNGÜLTIG",
    primary: "DAS HAT NICHT",
    secondary: "GEKLAPPT.",
    body: "Dieser Link ist ungültig oder wurde bereits verwendet. Trag dich unten einfach neu ein.",
  },
  error: {
    eyebrow: "TECHNISCHER FEHLER",
    primary: "KURZ",
    secondary: "GEHAKT.",
    body: "Da ist bei uns etwas schiefgelaufen. Bitte versuch es später noch einmal.",
  },
};

function isOutcomeState(value: string | null): value is OutcomeState {
  return value !== null && Object.prototype.hasOwnProperty.call(OUTCOMES, value);
}

/**
 * `?source=` lets a flyer or an event QR code be told apart from the
 * website. The value is passed along and whitelisted AGAIN on the
 * server (lib/launchWaitlist.ts), which is where it actually matters -
 * nothing a caller types reaches the database as free text.
 */
function readParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(name);
}

const AUDIENCE_OPTIONS: { value: string; label: string }[] = [
  { value: "private", label: "Privatperson" },
  { value: "cafe", label: "Café / Gastronomie" },
  { value: "studio", label: "Studio / Community" },
  { value: "business", label: "Unternehmen / Partner" },
  { value: "other", label: "Sonstiges" },
];

export function LaunchPage() {
  // Lazy initializers, not effects - the same way Account() and
  // OrderSuccess() read window.location on first client render.
  const [outcome] = useState<OutcomeState | null>(() => {
    const raw = readParam("state");
    return isOutcomeState(raw) ? raw : null;
  });
  const [source] = useState<string | null>(() => readParam("source"));

  const [status, setStatus] = useState<FormStatus>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (status === "sending") return;
    const form = e.currentTarget;
    const f = new FormData(form);
    setStatus("sending");
    setErrorMsg("");
    try {
      const res = await fetch("/api/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: String(f.get("email") || ""),
          firstName: String(f.get("firstName") || ""),
          audienceType: String(f.get("audienceType") || ""),
          // The checkbox is never pre-ticked, so this is only ever true
          // because somebody ticked it. The server checks it again.
          consent: f.get("consent") === "on",
          source: source || "launch_page",
          website: String(f.get("website") || ""),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setStatus("error");
        setErrorMsg(body?.error || "Die Eintragung hat nicht geklappt. Bitte versuch es später noch einmal.");
        return;
      }
      setStatus("submitted");
      form.reset();
    } catch {
      setStatus("error");
      setErrorMsg("Die Eintragung hat nicht geklappt. Bitte versuch es später noch einmal.");
    }
  };

  const instagramUrl = `https://instagram.com/${BRAND.instagram}`;

  // A confirmed or withdrawn visitor is done. Showing them the form
  // again would be asking for something they have already answered.
  const done = outcome === "confirmed" || outcome === "confirmed-code" || outcome === "withdrawn";
  const shown = outcome ? OUTCOMES[outcome] : null;

  return (
    <main className="launch-page">
      <section className="launch-hero">
        <div className="launch-hero-inner">
          {shown ? (
            <>
              <p className="eyebrow gloa-hero-eyebrow launch-hero-eyebrow">{shown.eyebrow}</p>
              <h1 className="launch-hero-headline">
                <span className="gloa-hero-primary">{shown.primary}</span>
                <i className="gloa-hero-secondary">{shown.secondary}</i>
              </h1>
              <p className="launch-hero-lead">{shown.body}</p>
              {shown.hint && <p className="launch-hero-hint">{shown.hint}</p>}
              {done && (
                <p className="launch-hero-social">
                  Bis dahin findest du uns auf Instagram.{" "}
                  <a href={instagramUrl} target="_blank" rel="noopener noreferrer">
                    {`@${BRAND.instagram.toUpperCase()} ↗`}
                  </a>
                </p>
              )}
            </>
          ) : (
            <>
              <p className="eyebrow gloa-hero-eyebrow launch-hero-eyebrow">GLOA PRELAUNCH</p>
              <h1 className="launch-hero-headline">
                <span className="gloa-hero-primary">BE AMONG</span>
                <i className="gloa-hero-secondary">THE FIRST.</i>
              </h1>
              {/*
                THE DATE, FROM THE ONE CONSTANT THAT HOLDS IT.
                GLOA_LAUNCH_FULL_LABEL is derived from GLOA_LAUNCH_ISO in
                lib/launchCountdown.ts, which is also what the homepage
                countdown and the shop strip read. Typing "01.10.2026"
                here would be a fourth place for the date to be wrong in.
              */}
              <p className="launch-hero-date">{GLOA_LAUNCH_FULL_LABEL}</p>
              {/*
                THE BENEFIT, AS THE SECOND THING ON THE PAGE.

                It used to be one small line under the date and it
                disappeared into the blue. It is now a Cream block that
                interrupts the field - the only light surface above the
                fold - with the number set at display size beside the
                line that qualifies it.

                The number and the percent sign are separate elements so
                the sign can sit at cap height instead of being scaled
                with the digits, and so 320px can shrink the digits
                without breaking the pairing.

                Every string still comes from lib/launchDiscount.ts. The
                page cannot promise a percentage or a deadline the
                checkout does not honour.
              */}
              <div className="launch-offer" role="group" aria-label={LAUNCH_DISCOUNT_LABEL}>
                <p className="launch-offer-figure" aria-hidden="true">
                  <span className="launch-offer-number">{LAUNCH_DISCOUNT_PERCENT}</span>
                  <span className="launch-offer-percent">%</span>
                </p>
                <div className="launch-offer-copy">
                  <p className="launch-offer-line">AUF DEINE ERSTE BESTELLUNG</p>
                  <p className="launch-offer-valid">
                    Einlösbar bis {LAUNCH_DISCOUNT_UNTIL_LABEL}
                  </p>
                </div>
              </div>
              <p className="launch-hero-lead">
                Trag dich ein und sichere dir {LAUNCH_DISCOUNT_PERCENT} % auf deine erste
                Bestellung. Deinen Code erhältst du nach der Bestätigung deiner E-Mail-Adresse.
              </p>
              {/*
                The trust line says what the list is and what it is not.
                It is not decoration: the promise it makes - one mail, no
                newsletter - is the same one the consent text, the privacy
                notice and the purpose column in migration 043 make, and
                all four have to keep saying it.
              */}
              <p className="launch-hero-trust">NUR FÜR DEN LAUNCH. KEIN NEWSLETTER.</p>
            </>
          )}
        </div>
      </section>

      {!done && (
        <section className="launch-form-band" id="launch-form">
          <div className="launch-form-inner">
            {status === "submitted" ? (
              // DELIBERATELY NOT "YOU'RE ON THE LIST" YET. At this point
              // the entry is pending: the address is recorded but the
              // consent is not confirmed, and saying otherwise would
              // promise a message that will not be sent unless the link
              // in the mail is clicked.
              <div className="launch-submitted" role="status" aria-live="polite">
                <p className="eyebrow launch-form-eyebrow">FAST GESCHAFFT</p>
                <h2 className="launch-form-headline">
                  <span className="launch-form-line">Check deine</span>
                  <i className="launch-form-line launch-form-line-accent">Mails.</i>
                </h2>
                <p className="launch-form-body">
                  Wenn diese Adresse eingetragen werden kann, ist gerade eine E-Mail zu dir unterwegs. Bestätige darin
                  kurz deine Eintragung, dann sagen wir dir zum Launch Bescheid.
                </p>
                <p className="launch-form-note">
                  Keine Mail bekommen? Schau kurz im Spam-Ordner nach, oder{" "}
                  <button type="button" className="launch-restart" onClick={() => setStatus("idle")}>
                    trag dich noch einmal ein
                  </button>
                  .
                </p>
              </div>
            ) : (
              <>
                <p className="eyebrow launch-form-eyebrow">LAUNCH LIST</p>
                <h2 className="launch-form-headline">
                  <span className="launch-form-line">Wir sagen dir</span>
                  <i className="launch-form-line launch-form-line-accent">Bescheid.</i>
                </h2>
                <p className="launch-form-body">
                  Hinterlasse uns deine E-Mail-Adresse und wir melden uns, sobald GLOA offiziell startet.
                </p>

                <form className="launch-form" onSubmit={handleSubmit} noValidate={false}>
                  {/* Honeypot. Same pattern as the contact form: hidden
                      from people, filled in by indiscriminate bots. */}
                  <input
                    type="text"
                    name="website"
                    tabIndex={-1}
                    autoComplete="off"
                    aria-hidden="true"
                    style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }}
                  />

                  <div className="launch-field">
                    <label htmlFor="launch-first-name">
                      Vorname <span className="launch-optional">(optional)</span>
                    </label>
                    <input
                      id="launch-first-name"
                      name="firstName"
                      type="text"
                      autoComplete="given-name"
                      maxLength={100}
                      disabled={status === "sending"}
                    />
                  </div>

                  <div className="launch-field">
                    <label htmlFor="launch-email">E-Mail-Adresse</label>
                    <input
                      id="launch-email"
                      name="email"
                      type="email"
                      required
                      autoComplete="email"
                      maxLength={254}
                      disabled={status === "sending"}
                      aria-describedby={status === "error" ? "launch-error" : undefined}
                    />
                  </div>

                  <div className="launch-field">
                    <label htmlFor="launch-audience">
                      Du interessierst dich für GLOA als … <span className="launch-optional">(optional)</span>
                    </label>
                    <select id="launch-audience" name="audienceType" defaultValue="" disabled={status === "sending"}>
                      <option value="">Keine Angabe</option>
                      {AUDIENCE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* NOT pre-ticked, and no `defaultChecked` anywhere near
                      it. The server refuses the request without it. */}
                  <div className="launch-consent">
                    <input id="launch-consent" name="consent" type="checkbox" required disabled={status === "sending"} />
                    {/*
                      WORD FOR WORD LAUNCH_CONSENT_TEXT from
                      lib/launchWaitlist.ts. The server stores that
                      constant on the row as evidence of what this person
                      was shown, so if the two ever drift the stored
                      evidence becomes a record of a sentence nobody read.
                      tests/launch-waitlist.test.mjs compares them.
                    */}
                    <label htmlFor="launch-consent">
                      Ich möchte per E-Mail benachrichtigt werden, sobald GLOA startet, und dafür einmalig
                      meinen Launch-Rabattcode erhalten. Meine E-Mail-Adresse wird ausschließlich für diese
                      beiden E-Mails verwendet.
                    </label>
                  </div>

                  <p className="launch-privacy">
                    Du kannst deine Einwilligung jederzeit widerrufen. Weitere Informationen findest du in unserer{" "}
                    <Link href="/datenschutz">Datenschutzerklärung</Link>.
                  </p>

                  <div aria-live="polite" className="launch-status">
                    {status === "error" && (
                      <p className="launch-error" id="launch-error">
                        {errorMsg}
                      </p>
                    )}
                  </div>

                  <button className="cta launch-cta" type="submit" disabled={status === "sending"}>
                    {status === "sending" ? "WIRD EINGETRAGEN …" : "JOIN THE LAUNCH"}
                  </button>
                </form>
              </>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
