import {
  legalLinks,
  legalLinksText,
  emailShell,
  emailHeader,
  emailEyebrow,
  emailHeadline,
  emailFooter,
  emailPreheader,
  escapeHtml,
  GLOA_NEAR_BLACK,
  GLOA_PLUM,
} from "./brand.ts";

/**
 * "Deine Reklamation ist eingegangen" - the defect-claim confirmation.
 *
 * ══════════════════════════════════════════════════════════════
 * THIS IS NOT A WIDERRUF, AND THE WORDING IS WHERE THAT GOES WRONG
 * ══════════════════════════════════════════════════════════════
 *
 * The sentence "Sie tragen die unmittelbaren Kosten der Rücksendung der
 * Waren." belongs to withdrawal and is simply wrong here: on a justified
 * defect BGB 439 Abs. 2 puts the necessary transport costs on the
 * SELLER. This template therefore says the opposite, deliberately, and a
 * test greps it to make sure the withdrawal sentence never appears.
 *
 * NO WERTERSATZ IS MENTIONED, because none applies. A customer who
 * opened the tin and found it spoiled did exactly what they had to do to
 * discover the defect.
 *
 * NO REMEDY IS PROMISED YET. Whether we replace, repair or repay is a
 * decision after we have seen the case, so this confirms receipt and
 * says what happens next - nothing more.
 */

export type ComplaintReasonLabel =
  | "arrived_damaged"
  | "seal_already_broken_on_arrival"
  | "wrong_size"
  | "wrong_item"
  | "missing_goods"
  | "quality_defect"
  | "other";

/** The German the customer actually chose, so the mail quotes them back. */
export const COMPLAINT_REASON_LABELS: Readonly<Record<ComplaintReasonLabel, string>> =
  Object.freeze({
    arrived_damaged: "Paket oder Produkt beschädigt angekommen",
    seal_already_broken_on_arrival: "Siegel war bei Ankunft bereits beschädigt",
    wrong_size: "falsche Größe geliefert",
    wrong_item: "falscher Artikel geliefert",
    missing_goods: "Ware fehlt",
    quality_defect: "Qualitätsmangel",
    other: "Sonstiges",
  });

export type ComplaintReceivedInput = {
  customerName: string;
  orderReference: string;
  reason: ComplaintReasonLabel;
  customerNote: string | null;
  /** When the claim reached us. ISO. */
  submittedAt: string;
  origin?: string;
};

export type BuiltComplaintReceivedEmail = {
  subject: string;
  html: string;
  text: string;
};

function fmtDateTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  return {
    date: d.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" }),
    time: d.toLocaleTimeString("de-DE", {
      timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit",
    }),
  };
}

export function buildComplaintReceivedEmail(
  input: ComplaintReceivedInput
): BuiltComplaintReceivedEmail {
  const subject = "Deine Reklamation ist eingegangen";
  const name = escapeHtml(input.customerName);
  const ref = escapeHtml(input.orderReference);
  const reason = escapeHtml(COMPLAINT_REASON_LABELS[input.reason] ?? "Sonstiges");
  const { date, time } = fmtDateTime(input.submittedAt);
  const origin = input.origin;
  const note = input.customerNote ? escapeHtml(input.customerNote) : null;

  const html = emailShell(subject, `
${emailPreheader(`Reklamation zu ${input.orderReference} eingegangen.`)}
${origin ? emailHeader(origin) : ""}
${emailEyebrow("Reklamation")}
${emailHeadline("Reklamation<br/>eingegangen.")}
<tr><td style="padding:0 0 20px 0;font-size:15px;line-height:1.7;color:${GLOA_NEAR_BLACK};">
Hallo ${name},<br/><br/>
danke, dass du uns Bescheid gegeben hast. Wir haben deine Reklamation aufgenommen.
</td></tr>
<tr><td style="padding:0 0 20px 0;font-size:15px;line-height:1.8;color:${GLOA_NEAR_BLACK};">
Bestellung: <strong>${ref}</strong><br/>
Grund: ${reason}<br/>
Eingegangen am ${date} um ${time} Uhr
</td></tr>
${note ? `<tr><td style="padding:0 0 20px 0;font-size:15px;line-height:1.7;color:${GLOA_NEAR_BLACK};">Deine Beschreibung:<br/>${note}</td></tr>` : ""}
<tr><td style="padding:0 0 20px 0;font-size:15px;line-height:1.7;color:${GLOA_NEAR_BLACK};">
Wir prüfen den Fall und melden uns mit einem Vorschlag zur Nacherfüllung. Wenn wir die Ware dafür zurückbenötigen, übernehmen wir die Kosten der Rücksendung.
</td></tr>
<tr><td style="padding:0 0 28px 0;font-size:14px;line-height:1.7;color:${GLOA_PLUM};">
Eine Reklamation ist etwas anderes als ein Widerruf. Dein Widerrufsrecht bleibt davon unberührt.
</td></tr>
${emailFooter(legalLinks(origin))}
`);

  const text = [
    `Hallo ${input.customerName},`,
    "",
    "danke, dass du uns Bescheid gegeben hast. Wir haben deine Reklamation aufgenommen.",
    "",
    `Bestellung: ${input.orderReference}`,
    `Grund: ${COMPLAINT_REASON_LABELS[input.reason] ?? "Sonstiges"}`,
    `Eingegangen am ${date} um ${time} Uhr`,
    ...(input.customerNote ? ["", `Deine Beschreibung: ${input.customerNote}`] : []),
    "",
    "Wir prüfen den Fall und melden uns mit einem Vorschlag zur Nacherfüllung.",
    "Wenn wir die Ware dafür zurückbenötigen, übernehmen wir die Kosten der Rücksendung.",
    "",
    "Eine Reklamation ist etwas anderes als ein Widerruf. Dein Widerrufsrecht bleibt",
    "davon unberührt.",
    "",
    legalLinksText(origin),
  ].join("\n");

  return { subject, html, text };
}
