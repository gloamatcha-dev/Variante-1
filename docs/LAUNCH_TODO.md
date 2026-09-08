# GLOA Launch — offene Schritte

Stand: 07.09.2026 · Launch geplant 01.10.2026, 12:00 Europe/Berlin (= 10:00 UTC)

Diese Datei ist die verbindliche Reihenfolge bis zum Launch. Sie enthält
nur, was noch offen ist — Erledigtes steht am Ende, damit der Kopf der
Liste kurz bleibt.

**Drei Sperren sind aktiv und bleiben es, bis der jeweilige Schritt
ausdrücklich freigegeben wird:**

| Sperre | Zustand | Wodurch |
|---|---|---|
| Shop-Freigabe | gesperrt | `SHOP_STATUS = "prelaunch"` in `app/content.ts` |
| Launch-Versand | gesperrt | 044 nicht angewendet · `launch_release.released` wäre `false` · `LAUNCH_ADMIN_SECRET` nicht gesetzt |
| Rabatt-Einlösung | gesperrt | nirgends im Checkout verdrahtet · Zeitfenster beginnt erst 01.10. 12:00 |

---

## P1 — Normale Produkte und finale Preise vorbereiten

**Status: Klärung abgeschlossen, wartet auf eure Preisliste.**

### Was der Audit ergeben hat

Die Annahme „die normalen Einzelprodukte fehlen in Stripe" trifft für
diese Architektur **nicht** zu. Der B2C-Einmalkauf braucht in Stripe
keine Produkt- oder Preisobjekte:

- `app/api/checkout/session/route.ts` baut die Positionen mit
  `price_data` — Betrag, Währung und Name werden pro Session übergeben.
- Der maßgebliche Preis kommt aus Supabase
  (`product_variants.price_gross_cents`), gelesen von
  `buildAuthoritativeQuote()` in `lib/checkoutQuote.ts`.
- Es gibt in der gesamten Einmalkauf-Strecke kein `stripe_price_id`.

Was im Stripe-Katalog steht, gehört dorthin und ist vollständig:

| Stripe-Objekt | Art | Zweck |
|---|---|---|
| `GLOA Matcha · 30 g` | **recurring**, 4-wöchig | Abo |
| `Versand · Deutschland` | **recurring**, 4-wöchig | Abo-Versand |

Beide werden von `getOrCreateRecurringPrice()`
(`lib/stripeRecurringPrice.ts`) **automatisch** erzeugt, nicht von Hand
gepflegt.

> **Deshalb: keine Einzelprodukte in Stripe anlegen.** Sie würden vom
> Checkout ignoriert (er nutzt `price_data`) und wären eine zweite
> Preisquelle, die von Supabase abweichen kann. Der strenge
> Betragsabgleich in `lib/stripeFulfillment.ts` würde eine daraus
> entstehende Differenz mit einer nicht erfüllten Bestellung quittieren.

### Der Server-Katalog ist vollständig und aktiv

| SKU | Label | Größe | Preis aktuell | Produkt | aktiv |
|---|---|---|---|---|---|
| `GLOA-MATCHA-30G` | 30 g | 30 g | 19,99 € | `matcha` | ja |
| `GLOA-MATCHA-50G` | 50 g | 50 g | 29,99 € | `matcha` | ja |
| `GLOA-MATCHA-100G` | 100 g | 100 g | 54,99 € | `matcha` | ja |
| `GLOA-CASE-01` | Metal Case | — | 9,99 € | `metal-case` | ja |

Produkte: `matcha` (GLOA Matcha), `metal-case` (GLOA Metal Case) — beide
aktiv.

**Es fehlt keine Produktgröße und kein Stripe-Objekt.** Offen ist allein
die Preisfestlegung.

### Was noch zu tun ist

- [ ] **Ihr liefert die finalen Bruttopreise** für die vier SKUs oben.
      Keine Preise werden erfunden oder eigenmächtig geändert.
- [ ] Preise in Supabase `product_variants.price_gross_cents` setzen
      (Bruttocent, ganzzahlig). Das ist die einzige Stelle.
- [ ] Prüfen, ob eine Größe entfallen oder hinzukommen soll — dann
      Variante an-/abschalten statt löschen (`is_active`), damit
      bestehende Bestellungen ihre Historie behalten.
- [ ] Nach der Preisänderung: Gratisversand-Schwelle in
      `lib/shipping.ts` gegen die neuen Preise prüfen.
- [ ] Abo-Preis prüfen: `GLOA Matcha · 30 g` recurring steht bei 19,99 €
      und wird aus dem Katalogpreis abgeleitet. Ändert sich der
      Einzelpreis, ändert sich die Ableitung — Auswirkung auf bestehende
      Abos vorher klären.

### Was hier ausdrücklich **nicht** passiert

- Keine neuen Stripe-Produkte, um fehlende Einzelprodukte zu „ersetzen".
- Keine Abo-Produkte als Ersatz für Einzelprodukte.
- Keine Änderung an Abos, Jahresplan, B2B oder Zahlungslogik.

---

## P2 — Einwilligungs-Historie und atomare Wiederanmeldung

**Status: Befund liegt vor, Umsetzung offen. Blockiert P3 nicht, sollte
aber vor dem ersten Rabatt-Versand erledigt sein.**

Zwei Schwächen im aktuellen Wiederanmelde-Pfad
(`app/api/launch/route.ts` + `decideResubmission()`):

1. **Die bestätigte Einwilligung wird beim Versionswechsel
   überschrieben.** Trägt sich ein unter v1 **bestätigter** Kontakt neu
   ein, schreibt der Upsert `consent_version`, `consent_text` und
   `consent_given_at` auf v2 und setzt `confirmed_at` auf `null`. Der
   Nachweis, dass diese Person v1 bestätigt hatte, ist damit weg.
   Bestätigt sie v2 nicht, wird sie nach 14 Tagen gelöscht — obwohl sie
   unter v1 gültig eingewilligt hatte und die Launch-Mail bekommen
   hätte.

2. **Der Entscheidungspfad ist nicht atomar.** Lesen und Schreiben sind
   zwei Anweisungen. Das enge Fenster: Klickt jemand den
   Bestätigungslink genau während einer parallelen Neuanmeldung, kann
   der Upsert die soeben gesetzte Bestätigung überschreiben.

- [ ] Getrennte Spalten für die **gültige** und die **noch nicht
      bestätigte** Einwilligung (`consent_*` bleibt die bestätigte,
      `pending_consent_*` die neue). Beim Bestätigen wird die neue zur
      gültigen.
- [ ] Signup als eine `SECURITY DEFINER`-Funktion, die Entscheidung und
      Schreiben in einer Anweisung erledigt — beseitigt das Race-Fenster.
- [ ] Additive Migration (046), 043 bleibt unangetastet.

---

## P3 — Sicherer Einlöseweg für GLOALAUNCH10

**Status: Arithmetik fertig und getestet, Checkout-Integration offen.**

Entschieden: Rabatt serverseitig in der Quote, **nicht** als
Stripe-Promotion-Code. Grund: `lib/stripeFulfillment.ts` verweigert die
Erfüllung, wenn Stripes `amount_total` um einen Cent vom eingefrorenen
Erwartungswert abweicht — ein an der Kasse eingelöster Code würde jede
rabattierte Bestellung in „bezahlt, aber keine Bestellung" verwandeln.

Fertig: `lib/launchDiscount.ts` — Code, Zeitfenster (inklusive der
Zeitumstellung am 25.10.), Prozentsatz, exakte Cent-Verteilung über die
Positionen. 12 Tests.

- [ ] E-Mail-Feld im Warenkorb (nötig, weil die Session die Adresse sonst
      erst nach der Preisfestlegung kennt).
- [ ] Code-Feld im Warenkorb.
- [ ] Erstbestellungsprüfung serverseitig gegen `orders` (pro
      E-Mail-Adresse).
- [ ] Rabatt in `buildAuthoritativeQuote()` einrechnen, Steuer aus dem
      **rabattierten** Brutto ableiten.
- [ ] `customer_email` an die Stripe-Session übergeben, damit die im
      Checkout eingegebene Adresse nicht von der geprüften abweichen
      kann.
- [ ] Gratisversand-Schwelle weiterhin am Warenwert **vor** Rabatt (so
      gebaut und dokumentiert; kaufmännisch bestätigen).
- [ ] Rabatt gilt nur für den B2C-Einmalcheckout. Abos, Jahresplan und
      B2B bleiben unberührt.

---

## P4 — Migrationen anwenden

Alle drei sind geschrieben, geprüft und **nicht angewendet**. 043 ist
live und wird nicht angefasst.

- [ ] `044_launch_send.sql` — Claim, Freigabe-Flag, Versandfunktionen
- [ ] `045_launch_welcome_email.sql` — Willkommensmail-Wasserzeichen
- [ ] `046` (aus P2), sobald geschrieben

Jede Datei **als Ganzes** im SQL Editor ausführen, nicht abschnittsweise.

---

## P5 — Launch-Tag

- [ ] `LAUNCH_ADMIN_SECRET` in Vercel setzen (≥ 32 Zeichen)
- [ ] Bestand und Zahlungspfad prüfen
- [ ] `SHOP_STATUS = "live"`, committen, deployen, verifizieren
- [ ] `POST /api/admin/launch/status` — Zähler und `blockers` prüfen
- [ ] `POST /api/admin/launch/release` mit Bestätigungsphrase
- [ ] `POST /api/admin/launch/send`, wiederholen bis `confirmedUnsent = 0`
- [ ] `needsReview` und `unmarked` gegen das Resend-Log abgleichen
- [ ] Nach Abschluss: Liste gemäß Löschkonzept löschen oder anonymisieren

---

## Offene Punkte ohne Termin

- [ ] Widerruf und Nicht-Reaktivierung sind **nicht live verifiziert**
      (Testkontakt hat den Widerrufslink nie geklickt).
- [ ] Elf transaktionale E-Mail-Templates tragen weiterhin kein Logo.
      `lib/email/brand.ts` steht bereit; bewusst nicht angefasst, weil
      rechtlich relevante Mails ohne Anlass umzubauen ein
      Regressionsrisiko ist.
- [x] ~~Neun vorbestehende Testfehler in der Suite (Baseline)~~ — erledigt.
      QA-EMAIL-04 hat die letzten sechs behoben (veralteter Import-Guard
      nach `lib/email/brand.ts` plus ein CRLF-Fehler, der das Inventar
      leer laufen ließ). Die Gesamtsuite ist seither vollständig grün:
      3.085 Tests, Exit 0, Stand 09.09.2026.
- [ ] Testkontakt steht auf `pending` mit gültigem Bestätigungstoken von
      19:32. Er kann durch Klick des Links regulär auf `confirmed`
      zurückkehren; Token und Retention laufen um den 21.09. ab.

### PRODUCT-01 — zurückgestellte Produktthemen

**PRODUCT-01 ist für diesen Launch abgeschlossen** (Befund 09.09.2026,
kleine Korrekturen in PRODUCT-01B). Drei Themen sind bewusst vertagt und
blockieren den Launch nicht:

- [ ] **Finale Produktfotos.** Die aktuell verwendeten Bilder sind
      vorläufig freigegeben und bleiben unverändert. Wenn die
      endgültigen Fotos da sind, werden sie **gesammelt** ersetzt - nicht
      einzeln. Bis dahin nichts austauschen, optimieren, zuschneiden,
      umbenennen oder löschen, auch keine untracked Assets.
      Mitzuerledigen, wenn es so weit ist: Das Retail-Foto
      `gloa-hero-packaging.jpg` zeigt eine Dose mit der abgelösten
      Tagline „MATCHA FOR REAL LIFE" und einer Serifen-Wortmarke; die
      Website und `gloa-logo-slogan-link.png` führen inzwischen
      „MATCHA IS FOR EVERYONE." mit der Grotesk-Marke.

- [ ] **GLOA Metal Case, nach der Verpackungsbestellung.** Wird vorerst
      **nicht verkauft**. Bleibt über `SHOP_HIDDEN_SLUGS` aus `/shop`
      ausgeblendet; Daten, Katalogzeile und Dateien bleiben erhalten.
      Offen für später, alles zusammen zu erledigen:
      - eigenes Foto der **leeren** Dose (aktuell teilt sie sich das Bild
        mit dem Matcha, das eine etikettierte Matcha-Packung zeigt - der
        Hinweis „Matcha nicht enthalten" fängt das nur im Text ab)
      - Alt-Text, der die Datei beschreibt statt nur den Produktnamen
      - Grammatik: „**die** GLOA Metal Case" steht an vier Stellen
        konsistent, Duden führt „das Case". **Jetzt nicht geändert**,
        weil eine der vier Stellen die `short_description` der bereits
        angewendeten Migration 020 ist, also Live-Datenbestand: eine
        reine Code-Änderung würde Hinweistext und Produktbeschreibung
        auseinanderlaufen lassen. Zusammen mit dem DB-Update erledigen.
      - `PRODUCT_FALLBACK_IMAGE` hat keinen Eintrag für `metal-case`:
        verlöre die Katalogzeile ihren Bildpfad, bliebe die Produktseite
        kommentarlos bildlos
      - Material, Maße, Fassungsvermögen sind unbestätigt

- [ ] **Bio-Zertifikat, nach Erhalt.** `ORGANIC_CERTIFICATION` bleibt
      `PENDING OWNER DOCUMENT`, alle Felder `null`. Die in SITE-01B
      entfernten Bio-Aussagen bleiben entfernt; der bedingte Guard in
      `tests/legal-content.test.mjs` hebt sich von selbst auf, sobald
      `controlBodyCode` oder `certificateReference` gefüllt sind.
      Benötigt: Kontrollstellen-Code, Name der Kontrollstelle,
      Zertifikatsnummer, Gültigkeit - jeweils vom echten Dokument der
      Cara 2 GmbH, nicht vom Lieferantenzertifikat. Danach separat
      freigeben, welche Formulierung zurückkehrt.

Ebenfalls notiert, ohne Termin und ohne Launch-Bezug: „GLOA®" steht nur
auf dem B2B-Beutel und nirgends sonst - falls die Marke nicht eingetragen
ist, gehört das in die rechtliche Endabnahme.

### ROUTING-01 — Soft-404: unbekannte Pfade antworten mit HTTP 200

**Aufgenommen 09.09.2026 im Zuge von SITE-01. Bewusst NICHT dort behoben:**
ein Copy- und Navigations-Pass ist nicht der Ort, um Routing-Verhalten zu
ändern.

**Befund.** `/definitely-not-a-page` und jeder andere unbekannte Pfad
rendern die 404-Seite korrekt, antworten aber mit **Status 200**. Gemessen
über den Render-Harness gegen den echten Build.

**Warum es zählt.** Suchmaschinen indexieren eine 200-Antwort. Jede
Falschschreibung einer URL kann so als eigene Seite in den Index geraten,
und Monitoring, das auf Statuscodes schaut, sieht keinen Fehler.

**Wo es sitzt.** `app/[...slug]/page.tsx` reicht jeden Pfad an
`GloaSite` weiter; der Route-Switch in `app/GloaSite.tsx` fällt am Ende
auf `<main className="not-found">` zurück. Der Status wird nirgends
gesetzt — deshalb 200.

**Zu klären, bevor jemand anfängt:**

- Welche Pfade sind wirklich unbekannt und welche nur katalogabhängig?
  `/shop/<slug>` und `/rezepte/<slug>` rendern ebenfalls die 404-Ansicht,
  wenn der Slug fehlt. Ein leerer Katalog darf keine echten Produktseiten
  auf 404 setzen.
- Getrennt behandeln: Route existiert nicht (404) gegen Inhalt derzeit
  nicht verfügbar (200 mit Hinweis).
- `robots`/`noindex` als Zwischenschritt, falls der Statuscode in dieser
  Architektur nicht sauber setzbar ist.

**Nicht Teil der Aufgabe:** Route-Struktur, Navigation oder Copy ändern.
Ein Regressionstest gehört dazu — `tests/public-routes.test.mjs` prüft
unbekannte Pfade bereits, aktuell nur auf „stürzt nicht ab".

---

## Erledigt

- Marke vereinheitlicht, Farbvarianten aus der freigegebenen SVG
  abgeleitet, `Organization.logo` korrigiert
- E-Mail-Branding-Grundlage (`lib/email/brand.ts`)
- Launch-Zeitpunkt zentral auf 12:00 korrigiert (war Mitternacht)
- Waitlist mit Double-Opt-In, Widerruf, persistentem Rate-Limit
- Rate-Limiter fällt geschlossen aus
- Retention-Löschjob für unbestätigte Einträge (14 Tage)
- Launch-Versandarchitektur mit atomarem Claim (044)
- Admin-Endpoints hinter eigenem Secret
- Einwilligung v2 mit Rabatt-Erwähnung, v1 historisch erhalten
- Wiederanmelde-Bug: Entscheidung vor dem Schreiben
- Rabatt-Arithmetik inklusive Zeitumstellung
