import type { ReactNode } from "react";
import type { PortalArea } from "../lib/adminPortalModel";

export const MODULE_ICONS: Record<PortalArea, string> = {
  overview: "▥", products: "▣", sales: "▤", rights: "◇", finance: "≡",
  inventory: "▱", creator: "♧", b2b: "▦", activity: "↗",
};

const guides: Record<Exclude<PortalArea, "inventory">, { title: string; steps: [string, string][] }> = {
  overview: {
    title: "So nutzt du die Übersicht",
    steps: [
      ["Aufgaben priorisieren", "Öffne einen Eintrag unter „Heute zu erledigen“, um den passenden Arbeitsbereich aufzurufen."],
      ["Aktivitäten prüfen", "Die Übersicht zeigt die zuletzt erfassten Vorgänge. Das Aktivitätsprotokoll bietet weitere Filter."],
      ["Systemstatus ablesen", "Der Stripe-Finanzabgleich zeigt den zuletzt bestätigten Stand. Prüfe Hinweise auf fehlende Daten vor Entscheidungen."],
    ],
  },
  products: {
    title: "So pflegst du Produkte",
    steps: [
      ["Varianten gemeinsam verwalten", "Führe 30 g, 50 g und 100 g als Varianten desselben Matcha-Produkts. Eine SKU identifiziert jeweils eine Variante."],
      ["Verknüpfungen prüfen", "Kontrolliere je Variante den zugeordneten Lagerartikel. Der Stripe-Status dokumentiert den Abgleich."],
      ["Entwurf prüfen und veröffentlichen", "Speichern setzt das Produkt auf Entwurf. Prüfe anschließend Daten und Abgleich, bevor du es erneut veröffentlichst."],
    ],
  },
  sales: {
    title: "So bearbeitest du Bestellungen",
    steps: [
      ["Bestellung finden", "Suche nach Bestellnummer oder Kundendaten. Bestell-, Zahlungs- und Versandstatus lassen sich getrennt filtern."],
      ["Versand vorbereiten", "Prüfe in den Bestelldetails Zahlung, Positionen und Lieferadresse. Nutze die Versandaktion erst, wenn die Sendung bereit ist."],
      ["Versand bestätigen", "Prüfe die Angaben in der Bestätigung. Ein automatisch gebuchter Lagerabgang darf nicht zusätzlich manuell erfasst werden."],
    ],
  },
  rights: {
    title: "So bearbeitest du Verbraucherfälle",
    steps: [
      ["Fall zuordnen", "Öffne Widerruf, Reklamation, Kündigung oder Sperre im passenden Bereich und prüfe den gespeicherten Status."],
      ["Prüfung dokumentieren", "Nutze die angezeigten Fristen und vorhandenen Felder für den Vorgang. Halte Begründung und Nachweise am richtigen Fall fest."],
      ["Erstattung getrennt prüfen", "Prüfe den Erstattungsstatus am Fall. Eine dokumentierte Prüfentscheidung ist keine Zahlungsbestätigung."],
    ],
  },
  finance: {
    title: "So arbeitest du mit den Finanzdaten",
    steps: [
      ["Zeitraum wählen", "Stelle den Zeitraum passend zur Frage ein. Prüfe bei Summen die Hinweise zur Vollständigkeit."],
      ["Buchungen und Ausgaben prüfen", "Nutze die jeweiligen Listen und Filter. Ein Stripe-Abgleich und eine Auszahlung sind unterschiedliche Vorgänge."],
      ["Belege bearbeiten", "Lade Rechnungen im Dokumentenbereich hoch und verwende die dort angebotenen Zuordnungen und Prüfaktionen."],
    ],
  },
  creator: {
    title: "So verwaltest du Creator",
    steps: [
      ["Passenden Bereich wählen", "Nutze die vorhandenen Ansichten für Bewerbungen und Creator-Daten. Öffne den Datensatz vor einer Änderung."],
      ["Zuordnung und Status prüfen", "Kontrolliere die gespeicherte Rolle und die angezeigten Zuordnungen. Verwende die vorhandenen Formularhinweise."],
      ["Provisionen nachvollziehen", "Der Auszahlungsbereich zeigt die gespeicherten Beträge und Status. Prüfe den Eintrag, bevor du eine angebotene Aktion ausführst."],
    ],
  },
  b2b: {
    title: "So bearbeitest du B2B-Lieferungen",
    steps: [
      ["Vertrag und Zahlung prüfen", "Öffne die Vereinbarung des Partners und kontrolliere den gespeicherten Zahlungs- und Lieferstatus."],
      ["Fertige B2B-Beutel bereitstellen", "Für Matcha-Lieferungen im B2B-Bereich werden ausschließlich eigene 500-g-Beutel verwendet. Geplanter Bedarf ist kein Lagerbestand."],
      ["Versand abschließen", "Nutze die Versandbestätigung bei der betreffenden Lieferung, sobald sie versendet wurde. Einen automatischen Bestandsabgang nicht erneut buchen."],
    ],
  },
  activity: {
    title: "So prüfst du das Aktivitätsprotokoll",
    steps: [
      ["Vorgang eingrenzen", "Suche nach dem Vorgang oder filtere nach Modul, Aktion und Datum."],
      ["Nachweis lesen", "Vergleiche Zeitpunkt, Nutzer, Aktion und verfügbare Referenzen im Eintrag. Technische Angaben sind am jeweiligen Vorgang hinterlegt."],
      ["Verlauf berücksichtigen", "Das Protokoll zeigt erfasste Vorgänge seit Einführung der Aufzeichnung."],
    ],
  },
};

export function AdminModuleContent({ area, children }: { area: PortalArea; children: ReactNode }) {
  if (area === "inventory") return <>{children}</>;
  const guide = guides[area];

  return (
    <div className="admin-module-layout" data-admin-area={area}>
      <div className="admin-module-body">{children}</div>
      <details className="inventory-card inventory-guide admin-module-guide">
        <summary><span className="inventory-icon" aria-hidden="true">ⓘ</span>{guide.title}</summary>
        <ul>{guide.steps.map(([title, text]) => <li key={title}><strong>{title}</strong>{text}</li>)}</ul>
      </details>
    </div>
  );
}
