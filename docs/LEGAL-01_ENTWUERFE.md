# LEGAL-01 — Prüffähige Entwürfe und offene Tatsachen

**Stand:** 08.09.2026 · **Repo-Stand:** `8735912` (= `origin/main`, = live)

**Status: ENTWURF.** Nichts hiervon ist veröffentlicht. Keine Aussage in diesem
Dokument ist als rechtssicher geprüft; die juristische Endfreigabe ist ein
separater Schritt.

---

## 0. Wie dieses Dokument zu lesen ist

Jede Tatsachenbehauptung trägt eine Herkunft:

| Marke | Bedeutung |
|---|---|
| **[BELEGT]** | In diesem Repo oder an der Live-Infrastruktur selbst nachgeprüft. Quelle steht dabei. |
| **[ANBIETERANGABE]** | Aussage des Anbieters über sich selbst. Nicht unabhängig verifiziert. |
| **[OFFEN]** | Nicht feststellbar ohne Zugang oder Entscheidung, die ich nicht habe. |

Was **[OFFEN]** ist, steht auch im Entwurfstext als offen — mit einer Klammer,
die vor der Veröffentlichung aufgelöst werden muss. Ich habe nichts gefüllt,
damit ein Text glatter aussieht.

---

## 1. Geprüfte Tatsachenlage zur Drittlandfrage

### 1.1 Selbst nachgeprüft

**Vercel — Funktionen laufen in den USA. [BELEGT]**

Antwort-Header von `POST https://gloamatcha.com/api/launch`:

```
X-Vercel-Id: fra1::iad1::lk4b2-1788879244323-9113f5e3e09a
Server: Vercel
```

`fra1` ist der Eintrittspunkt (Frankfurt), `iad1` die Region, in der die
Funktion ausgeführt wurde: Washington D.C., USA. `vercel.json` enthält keinen
`regions`-Schlüssel; die Ausführung folgt der Projekt-Voreinstellung.

Das ist genau die Funktion, die bei einer Launch-Eintragung E-Mail-Adresse,
Vorname und Einwilligung entgegennimmt. Diese Daten werden mithin in den USA
verarbeitet.

**Supabase liegt hinter Cloudflare. [BELEGT]**

`yphubqploumfeabytotc.supabase.co` löst auf `104.18.38.10` und
`172.64.149.246` auf (Cloudflare-Adressbereiche), Antwort-Header
`Server: cloudflare`. Cloudflare ist damit ein weiterer Verarbeiter in der
Kette und wird in der aktuellen Datenschutzerklärung nicht genannt.

**Der Rabattcode ist in keinem Checkout verdrahtet. [BELEGT]**

`decideLaunchDiscount` und `applyDiscountToLines` in `lib/launchDiscount.ts`
werden von keiner Checkout- oder Stripe-Route aufgerufen. Der Code ist
tatsächlich nicht einlösbar.

### 1.2 Anbieterangaben

**Supabase** — Vertragspartei des DPA ist **Supabase Pte. Ltd**; das DPA
unterliegt irischem Recht und irischer Gerichtsbarkeit. Wo eine
Verarbeitungsregion gewählt wird, werden die Daten in dieser Region gespeichert
und primär verarbeitet. **[ANBIETERANGABE]**
Quelle: <https://supabase.com/legal/customer-resources/data-processing-addendum>

**Resend** — speichert Kundendaten in den **Vereinigten Staaten**:
Nachrichteninhalte, Zustellprotokolle, Webhook-Payloads, Kontodaten. Die
Regionswahl beim Hinzufügen einer Absenderdomain steuert nur Routing und
Versand, **nicht** den Speicherort; eine EU-Speicheroption gibt es nach eigener
Angabe nicht. Übermittlungen sind nach Anbieterangabe durch
Standardvertragsklauseln im DPA sowie durch Teilnahme am EU-U.S. Data Privacy
Framework gedeckt. **[ANBIETERANGABE]**
Quellen: <https://resend.com/security/gdpr>, <https://resend.com/legal/dpa>,
<https://resend.com/legal/subprocessors>

**Stripe** — Vertragspartei für Nutzer außerhalb Amerikas ist **Stripe Payments
Europe, Limited (SPEL)**, eine irische Gesellschaft. Für EWR-Nutzer tritt SPEL
je nach Produkt als Verantwortlicher oder gemeinsam Verantwortlicher auf, nicht
nur als Auftragsverarbeiter. **[ANBIETERANGABE]**
Quellen: <https://stripe.com/legal/dpa>, <https://stripe.com/legal/privacy-center>

**Vercel** — Vertragspartei, DPA-Fassung und Unterauftragsverarbeiterliste
**[OFFEN]**.

### 1.3 Ausdrücklich NICHT feststellbar

**Die DPF-Zertifizierungen sind nicht unabhängig verifiziert. [OFFEN]**

`dataprivacyframework.gov` ist eine JavaScript-Anwendung und liefert an einen
maschinellen Abruf nur den Seitentitel. Ich konnte für keinen der vier Anbieter
den Eintragsstatus (Active / Inactive / Withdrawn), den Geltungsbereich
(EU-U.S. / UK Extension / Swiss-U.S.) oder das Rezertifizierungsdatum aus der
amtlichen Liste auslesen. Es existiert eine URL `/participant/Vercel` — das ist
ein Hinweis, kein Nachweis, und ich behandle ihn nicht als solchen.

**Deshalb steht in keinem Entwurfstext unten eine DPF-Behauptung.**

**Die Supabase-Projektregion. [BELEGT — nachgetragen 08.09.2026]**

Zunächst als offen geführt, weil die REST-Domain hinter Cloudflare liegt.
Über den **direkten** Datenbank-Host geht es doch: `db.<ref>.supabase.co`
löst auf `2a05:d014:415:500:14:679a:7e3e:4d70` auf, und laut der amtlichen
AWS-Bereichsliste (`ip-ranges.amazonaws.com/ip-ranges.json`, Stand
08.09.2026) gehört `2a05:d014::/35` zu **eu-central-1, Frankfurt am Main**.

**Die Datenbank liegt in der EU.** Damit ist die pauschale Annahme, alle Daten
gingen in die USA, widerlegt — und die Drittlandfrage betrifft die
Serverfunktionen (`iad1`) und den E-Mail-Versand, nicht den Datenbestand.

Eine Bestätigung im Dashboard (Project Settings → General → Region) bleibt
sinnvoll, weil DNS eine Momentaufnahme ist; der Befund selbst ist aber belegt
und nicht geraten.

**Die Vercel-Funktionsregion als Einstellung. [OFFEN]**

Der Header belegt `iad1` für den beobachteten Aufruf. Ob das die konfigurierte
Projektregion ist, und ob auf eine EU-Region umgestellt werden soll, ist eine
Einstellung im Vercel-Projekt und zugleich eine Entscheidung.

---

## 2. ENTWURF A — Drittlandübermittlung

Einzufügen als neuer Abschnitt nach „9. Empfänger deiner Daten". Bewusst
neutral: Er bleibt zutreffend, gleich wie die offenen Punkte aus 1.3 ausgehen —
mit Ausnahme der markierten Klammer.

> **10. Verarbeitung außerhalb der Europäischen Union**
>
> Einige der unter Ziffer 9 genannten Dienstleister verarbeiten
> personenbezogene Daten außerhalb der Europäischen Union, insbesondere in den
> Vereinigten Staaten. Das gilt nicht für jede Verarbeitung in gleichem Maße:
> Für den Versand unserer E-Mails werden die dafür erforderlichen Daten in den
> Vereinigten Staaten gespeichert und verarbeitet. Die Auslieferung dieser
> Website und die Ausführung der zugehörigen Serverfunktionen erfolgen über
> eine Infrastruktur mit Standorten innerhalb und außerhalb der EU.
>
> *[ZU BESTÄTIGEN: ein Satz zur Datenbankregion, sobald die Supabase-Region
> feststeht — entweder „Deine Konto- und Bestelldaten speichern wir in einer
> Region innerhalb der Europäischen Union." oder die zutreffende andere
> Aussage. Nicht veröffentlichen, bevor das abgelesen ist.]*
>
> Soweit personenbezogene Daten in ein Land außerhalb der EU übermittelt
> werden, für das kein Angemessenheitsbeschluss der Europäischen Kommission
> vorliegt, erfolgt die Übermittlung auf Grundlage geeigneter Garantien nach
> Art. 46 DSGVO.
>
> *[ZU BESTÄTIGEN durch die Rechtsberatung: konkrete Benennung der Garantie je
> Dienstleister — Standardvertragsklauseln aus dem jeweiligen
> Auftragsverarbeitungsvertrag und/oder ein Angemessenheitsbeschluss. Erst
> aufnehmen, wenn die Verträge vorliegen und der Status geprüft ist.]*
>
> Eine Kopie der vereinbarten Garantien stellen wir dir auf Anfrage unter
> hello@gloamatcha.com zur Verfügung.

**Warum kein DPF-Satz drinsteht:** weil ich den Zertifizierungsstatus nicht aus
der amtlichen Liste lesen konnte. Ein Verweis auf einen Angemessenheitsbeschluss,
dessen Voraussetzung — die aktive Zertifizierung des konkreten Empfängers — man
nicht geprüft hat, ist eine unbelegte Behauptung gegenüber betroffenen Personen.

**Zusätzlich zu entscheiden:** Cloudflare steht nachweislich vor Supabase, wird
in Ziffer 9 aber nicht genannt. Entweder in die Empfängerliste aufnehmen oder
über die dort bereits verwendete Kategorienbildung erfassen.

---

## 3. ENTWURF B — Aufbewahrung und Löschung der Launch List

### 3.1 Fünf Bestände, fünf Zwecke

| Bestand | Zweck | Ist-Zustand | Vorschlag |
|---|---|---|---|
| `pending` | Abschluss des Double-Opt-In | **14 Tage, automatisch, implementiert** (`lib/launchWaitlistRetention.ts`) | unverändert |
| `confirmed` | Zweck noch offen, Launch-Mail steht aus | keine Löschung | bis Versand behalten, danach nach 3.2 |
| `notified` | Zweck erfüllt | keine Löschung | Kontrollstichtag nach 3.2 |
| `withdrawn` | Nachweis des Widerrufs **und** Sperre gegen Wiedereintragung | keine Löschung, bewusst | **[OFFEN — rechtliche Entscheidung]** |
| `launch_consent_history` | Nachweis nach Art. 7 Abs. 1 DSGVO | keine Löschung, Cascade an der Zeile | **[OFFEN — rechtliche Entscheidung]** |

Die letzten beiden Zeilen habe ich bewusst nicht entschieden. Eine
Aufbewahrungsdauer für Einwilligungs- und Widerrufsnachweise hängt an
Verjährungsfristen und an der Beweislast des Verantwortlichen — Rechtsfrage,
keine Voreinstellung.

### 3.2 Kontrollstichtag statt Löschfrist

Der operative Bestand wird **nicht** durch einen Timer gelöscht.

- **Kontrollstichtag: 02.11.2026** — erster Werktag nach Ablauf des
  Aktionszeitraums (31.10.2026, 23:59 Uhr).
- **Verantwortlich:** *[ZU BESETZEN — namentlich, nicht „GLOA"]*
- **Vorbedingungen**, die am Stichtag **alle** erfüllt sein müssen:
  1. Der einmalige Launch-Versand ist abgeschlossen und abgeglichen — keine
     Zeile in `needs_review`, kein offener Claim.
  2. Der Aktionszeitraum des Rabattcodes ist abgelaufen.
  3. Keine offenen Zustellfälle oder Rückfragen mehr anhängig.
- **Handlung:** Löschung oder Anonymisierung des operativen Bestands
  (`confirmed`, `notified`). Nachweisdaten nach 3.1 bleiben unberührt und
  folgen ihrer eigenen, gesondert festzulegenden Frist.
- **Dokumentation:** Ergebnis und Datum werden festgehalten, auch wenn nicht
  gelöscht wurde — dann mit Begründung, welche Vorbedingung fehlte.

Kein automatischer Löschjob. Keine Löschung ohne gesonderte Freigabe.

### 3.3 Ersatzwortlaut für die Datenschutzerklärung

Ersetzt in Ziffer 6 den Satz „Mit dem Versand der Launch-Benachrichtigung ist
der Zweck der Verarbeitung erfüllt; die Liste wird anschließend gelöscht oder
anonymisiert."

> Wir löschen oder anonymisieren die Launch-Liste, sobald sie für ihren Zweck
> nicht mehr erforderlich ist. Das ist der Fall, wenn der einmalige
> Launch-Versand abgeschlossen und abgeglichen ist, der Aktionszeitraum des
> Rabattcodes abgelaufen ist und keine offenen Zustellfälle mehr bestehen. Wir
> prüfen das zu einem festgelegten Termin nach Ablauf des Aktionszeitraums.
> Hast du deine Eintragung nicht bestätigt, löschen wir sie bereits nach 14
> Tagen. Nachweise darüber, dass eine Einwilligung erteilt oder widerrufen
> wurde, bewahren wir davon getrennt so lange auf, wie wir sie zum Nachweis der
> Rechtmäßigkeit der Verarbeitung benötigen.

Das ist ein Kriterium im Sinne von Art. 13 Abs. 2 lit. a DSGVO, keine
willkürliche Frist — und es beschreibt, was der Code tatsächlich tut.

---

## 4. ENTWURF C — Bedingungen GLOALAUNCH10

### 4.1 Abgleich gegen den Code

| Bedingung | Codelage |
|---|---|
| 10 % | `LAUNCH_DISCOUNT_PERCENT = 10` **[BELEGT]** |
| 01.10. 12:00 – 31.10. 23:59 Europe/Berlin | `LAUNCH_DISCOUNT_FROM_ISO` / `_UNTIL_ISO`, Sommerzeitwechsel korrekt (`+02:00` → `+01:00`) **[BELEGT]** |
| Versandkosten nicht rabattiert | Rabatt wird nur über Warenpositionen verteilt (`splitDiscountAcrossLines`) **[BELEGT]** |
| Kein Verlust der Versandkostenfreiheit | `FREE_SHIPPING_MEASURED_BEFORE_DISCOUNT = true` — Schwelle misst den Warenwert **vor** Abzug **[BELEGT]** |
| Kein Mindestbestellwert | keine Schwelle im Code **[BELEGT]** |
| Erstbestellung pro Person | **nicht implementiert** — der Checkout kennt die E-Mail-Adresse bei Session-Erstellung nicht |
| Ausschluss Abo / Jahresplan / B2B | derzeit gegenstandslos: nicht buchbar, Rabatt nirgends verdrahtet |

Bemerkenswert und verbraucherfreundlich: Der Rabatt kann die
Versandkostenfreiheit nicht kippen. Das ist eine bewusste Entscheidung im Code
und gehört in die Bedingungen, weil sie zugunsten des Kunden wirkt.

### 4.2 Entwurfstext

> **Aktionsbedingungen GLOALAUNCH10**
>
> 1. Der Code gewährt 10 % Rabatt auf den Warenwert der ersten regulären
>    Einzelbestellung von Privatkundinnen und Privatkunden im GLOA Online-Shop.
> 2. Der Code ist vom 01.10.2026, 12:00 Uhr bis einschließlich 31.10.2026,
>    23:59 Uhr (Europe/Berlin) einlösbar.
> 3. Ein Mindestbestellwert besteht nicht.
> 4. Versandkosten werden nicht rabattiert. Die Schwelle für versandkostenfreie
>    Lieferung richtet sich nach dem Warenwert vor Abzug des Rabatts; der Code
>    kann eine bereits erreichte Versandkostenfreiheit daher nicht entfallen
>    lassen.
> 5. Der Code ist nicht mit anderen Rabattaktionen oder Rabattcodes
>    kombinierbar.
> 6. Ausgenommen sind Abonnements, vorausbezahlte Jahrespläne und Bestellungen
>    von Geschäftskunden.
> 7. Bei Widerruf oder Rückgabe erstatten wir den tatsächlich gezahlten,
>    rabattierten Betrag. Deine gesetzlichen Widerrufs- und
>    Gewährleistungsrechte bleiben unberührt.

### 4.3 Was daran noch nicht gilt

**Der Code ist derzeit nicht einlösbar.** Die Einlöselogik ist in keiner
Checkout-Route verdrahtet. Bis zum 01.10.2026 muss sie stehen — die
Willkommensmails, die bereits versendet wurden, nennen dieses Datum als Beginn.
Das ist eine laufende Frist, keine Option.

**Die Erstbestellungsregel ist eine Zusage ohne Durchsetzung.** Ein für alle
identischer Code garantiert von sich aus keine einmalige Verwendung pro Person.
Ziffer 1 formuliert das deshalb als Bedingung; die serverseitige Durchsetzung
muss vor der Freischaltung gebaut und geprüft werden. Solange sie fehlt, darf
Ziffer 1 nicht als technisch gesicherte Beschränkung dargestellt werden.

**Noch nicht entschieden:** ob einzelne Produkte ausgenommen werden
(Geschenkartikel, Metal Case, Sample), und wie bei einer Teilrückgabe gerechnet
wird — anteilige Rabattkürzung oder Erstattung des gezahlten Anteils der
zurückgegebenen Position.

**Wo die Bedingungen erscheinen müssen:** `/launch`, Willkommensmail und später
der Checkout müssen übereinstimmen. Derzeit nennen Landingpage und
Willkommensmail nur Prozentsatz und Zeitraum; veröffentlichte Bedingungen gibt
es nirgends.

---

## 5. ENTWURF D — VSBG

**Kein Text. Bewusst.**

Der aktuelle Zustand — keine Schlichtungserklärung auf der Website — ist
korrekt, *sofern* die Schwelle des § 36 Abs. 1 VSBG nicht überschritten ist.
`tests/legal-content.test.mjs` hält diesen Zustand ausdrücklich als offene Frage
fest und verhindert, dass versehentlich eine Erklärung erscheint.

**Zu bestätigen durch die zuständige Person / Buchhaltung:**

1. Zahl der am **31.12.2025** beschäftigten Personen — benötigt wird nur die
   Antwort „über 10" oder „10 oder weniger". Die Zahl selbst gehört nicht auf
   die Website.
2. Ob unabhängig davon eine **gesetzliche oder vertragliche**
   Teilnahmeverpflichtung an einem Streitbeilegungsverfahren besteht — die
   greift unabhängig von der Beschäftigtenzahl.
3. **§ 37 VSBG** ist gesondert zu betrachten: Die Hinweispflicht bei einer
   *konkret nicht beigelegten* Verbraucherstreitigkeit trifft den Unternehmer
   unabhängig von § 36 und ist keine Angabe auf der Website, sondern eine
   Information im Einzelfall. Ob dafür ein Textbaustein im Support-Prozess
   hinterlegt wird, ist zu entscheiden.

Bis zur Klärung: keine freiwillige Teilnahmebereitschaft erklären und keine
Pflicht behaupten.

---

## 6. Gesammelte offene Punkte

### Tatsachen, die ich nicht feststellen kann

| # | Frage | Wer |
|---|---|---|
| ~~T1~~ | ~~Supabase-Projektregion~~ — **beantwortet:** eu-central-1 (Frankfurt), belegt über AWS-Bereichsliste. Dashboard-Bestätigung optional. | erledigt |
| T2 | Vercel-Projektregion für Funktionen — Ist-Einstellung, und ob eine EU-Region gewählt werden soll | Betreiber |
| T3 | DPF-Status der vier Anbieter aus der amtlichen Liste | Rechtsberatung |
| T4 | Vorliegende AV-Verträge und deren SCC-Module je Anbieter | Betreiber / Rechtsberatung |
| T5 | Beschäftigtenzahl am 31.12.2025 — nur Schwellenaussage | Buchhaltung |

### Entscheidungen

| # | Frage |
|---|---|
| E1 | Aufbewahrungsdauer für Einwilligungs- und Widerrufsnachweise |
| E2 | Verantwortliche Person für den Kontrollstichtag 02.11.2026 |
| E3 | Cloudflare in die Empfängerliste aufnehmen oder Kategorien verwenden |
| E4 | Produktausnahmen beim Rabatt (Geschenkartikel, Metal Case, Sample) |
| E5 | Rabattbehandlung bei Teilrückgabe |
| E6 | Abmeldelink in Willkommens- und Launch-Mail. Derzeit trägt nur die Bestätigungsmail einen — der Widerrufs-Token überlebt die Bestätigung (`confirm_launch_signup` leert nur `confirmation_token_hash`), die Angabe in der Datenschutzerklärung ist also zutreffend. Art. 7 Abs. 3 DSGVO ist dennoch besser erfüllt, wenn jede Mail einen trägt. |

### Terminlich gebunden

| Datum | Was |
|---|---|
| **01.10.2026, 12:00** | Einlöselogik muss stehen — bereits versendete Mails nennen dieses Datum |
| **02.11.2026** | Kontrollstichtag Launch-Liste |

---

## 6a. GO-LIVE-BLOCKER: Abo und Jahresplan in den AGB

*Nachgetragen 08.09.2026 (DESIGN-LEGAL-04).*

Die AGB decken ausschließlich den **einmaligen B2C-Warenkauf**. Das ist heute
zutreffend — `SHOP_STATUS = "prelaunch"`, das Kundenkonto sagt „Buchbar sind
Abos noch nicht", und `B2C_ANNUAL_PLAN_ENABLED` ist nicht gesetzt. Sobald eines
der beiden Produkte freigeschaltet wird, **darf der Shop ohne diese Ergänzungen
nicht live gehen**:

| # | Erforderlich vor Freigabe |
|---|---|
| B1 | **Laufendes B2C-Abo:** Vertragsbedingungen mit dem tatsächlichen **28-Tage-Zyklus** (`CADENCE_DAYS = 28`, `lib/subscriptionCancellationRules.ts`) — **nirgends „monatlich" nennen**, 28 Tage sind keine Kalendermonate |
| B2 | **Kündigungsbedingungen:** Frist **14 Tage** vor der nächsten Abrechnung (`CANCELLATION_CUTOFF_DAYS = 14`), inklusive der Regel, dass eine verspätete Kündigung erst nach dem folgenden Zyklus wirkt |
| B3 | **Kündigungsschaltfläche nach § 312k BGB** — existiert derzeit **nicht** |
| B4 | **Vorausbezahlter Jahresplan:** einmalige Zahlung, **13 Lieferungen im 28-Tage-Abstand (364 Tage)**, **keine automatische Verlängerung** — nicht als laufendes Stripe-Abonnement beschreiben |
| B5 | **Eigene Widerrufsbelehrung** für Dauerschuldverhältnisse und für den vorausbezahlten Jahresplan; die bestehende ist für Warenkauf geschrieben |
| B6 | **Vorvertragliche Informationen** nach Art. 246a EGBGB für beide Modelle |
| B7 | **Konsistenz** zwischen Produktseite, Checkout, Bestätigungsmail, Kundenkonto und AGB — heute sagt nur das Kundenkonto etwas dazu |

Diese Bedingungen werden **vor** dem Aktivieren der jeweiligen Produkte
gesondert finalisiert. Bestehende Abo-, Jahresplan- und Zahlungsregeln wurden
dabei nicht angefasst.

### Versand: Befund und offene Punkte (DESIGN-LEGAL-06)

**V1 — Alle vier Zonen sind bereits aktiv. [BELEGT]**
Die Annahme, der B2C-Checkout sei „zunächst Deutschland", ist **überholt**.
`ALLOWED_SHIPPING_COUNTRIES` in `lib/shipping.ts` ist die Vereinigung aller
vier Zonen und umfasst **40 Länder**; `app/api/checkout/quote/route.ts` und
`app/api/checkout/session/route.ts` validieren dagegen, und der Warenkorb
bietet über `SHIPPING_COUNTRY_OPTIONS` alle zur Auswahl an. Die Ein-Land-
Beschränkung in der Stripe-Session (`allowed_countries: [frozenShippingCountry]`)
gilt **pro Bestellversuch**, damit niemand nach dem Preisen die Zone wechselt —
sie ist keine globale Begrenzung auf Deutschland.

Die Werte im Seitentext stimmen **exakt** mit `SHIPPING_PRICING` überein:
Deutschland 590/4900, EU 1290/7900, CH-UK-NO 1790/keine Schwelle,
Übriges Europa 1990/keine Schwelle. Es war also nichts zurückzuhalten.

**V2 — Nicht belieferte europäische Länder. [ENTSCHEIDUNG DOKUMENTIERT]**
Bewusst ausgeschlossen und im Code begründet: **Russland** und **Belarus**
(Sanktionen), **Ukraine** (Machbarkeit operativ nicht bestätigt), **Moldau**
(Geschäftsentscheidung). Die Versandseite listet deshalb je Zone die
tatsächlichen Länder auf, damit „Übriges Europa" nicht mehr verspricht, als
der Checkout annimmt. Ein Test schlägt fehl, sobald eines dieser Länder
aufgenommen wird, ohne die Seite erneut zu prüfen.

**V3 — Einfuhrabgaben: Verantwortlichkeit. [OFFEN, Betreiber]**
Die Seite sagt zutreffend, dass bei Lieferungen außerhalb der EU Zölle,
Steuern oder Einfuhrabgaben anfallen **können** und von Behörden bzw.
Versanddienstleister erhoben werden. Nicht festgelegt ist, ob mit
**DDP** (verzollt, GLOA trägt die Abgaben) oder **DAP** (unverzollt, die
Kundschaft trägt sie) versendet wird. Für CH, UK, NO und das übrige Europa —
13 aktive Länder — ist das eine kaufmännische und zolltechnische Entscheidung,
die vor nennenswertem Auslandsvolumen getroffen und dann auf der Seite
benannt werden sollte. Keine Beträge erfunden.

**V4 — Jahresplan liefert nur nach Deutschland. GO-LIVE-PUNKT.**
`ANNUAL_SHIPPING_ZONE = "germany"` (`lib/annualPlanCheckoutRules.ts`): Der
vorausbezahlte Jahresplan ist auf **ein** Land beschränkt, während
Einzelbestellungen 40 erreichen. Laufende Abos haben **gar keine** eigene
Versandregel. Die Versandseite beschreibt deshalb ausdrücklich nur
Einzelbestellungen und erwähnt beide Modelle nicht. Vor ihrer Aktivierung
müssen die jeweiligen Versandkosten, Lieferintervalle und Liefergebiete
festgelegt und auf der Seite ergänzt werden — siehe B1–B7.

### Widerrufsbelehrung: zwei offene Punkte (DESIGN-LEGAL-05)

**W1 — Rücksendeadresse. [OFFEN, Betreiber]**
Die Widerrufsbelehrung und das Musterformular nennen Hardenbergstr. 4 als
Adresse, an die der Widerruf zu erklären ist. Das ist die **Geschäftsanschrift**
aus dem Impressum. Ob dorthin auch die **Waren** zurückgehen sollen, ist eine
operative Frage, die ich nicht beantworten kann und nicht erfunden habe.
Falls Retouren an eine andere Adresse gehen, muss diese in § 3 („Folgen des
Widerrufs") ergänzt werden — die Erklärungsadresse und die Rücksendeadresse
dürfen auseinanderfallen, müssen dann aber beide genannt sein.

**W2 — Fristbeginn bei Teilsendungen. [ENTWURF, nicht veröffentlicht]**
Das gesetzliche Muster kennt eine Variante für Waren, die in **mehreren
Teilsendungen oder Stücken** geliefert werden: Die Frist beginnt dann mit der
letzten Teilsendung bzw. dem letzten Stück. Der Text enthält sie **nicht**,
weil Teilsendungen technisch nicht abgebildet sind — `fulfillment_status` ist
ein Status je Bestellung, „partial" im Code betrifft ausschließlich
Erstattungen. Sobald Teillieferungen möglich werden, ist dieser Satz zu
ergänzen:

> Haben wir dir eine Ware in mehreren Teilsendungen oder Stücken geliefert,
> beginnt die Frist mit dem Erhalt der letzten Teilsendung bzw. des letzten
> Stücks.

**W3 — Widerrufsbelehrung für Abo und Jahresplan. GO-LIVE-BLOCKER.**
Die vorhandene Belehrung ist für den **Warenkauf** geschrieben. Sie deckt die
Variante für **regelmäßige Lieferungen über einen festgelegten Zeitraum**
nicht ab, bei der die Frist mit dem Erhalt der **ersten** Ware beginnt. Solange
Abos und Jahresplan nicht buchbar sind, ist das korrekt; vor ihrer Aktivierung
muss die Belehrung um die passende Variante ergänzt werden — siehe B5 oben.
Die 28-Tage-Zyklen, die 13 festgelegten Lieferungen und die fehlende
automatische Verlängerung dürfen dabei **nicht** durch Textänderungen
umgedeutet werden.

### Offene Entscheidung: Verweis auf die Aktionsbedingungen

Geprüft, wie beauftragt: Die AGB **sollten** in § 3 auf die jeweils gültigen
Aktionsbedingungen verweisen, sobald es welche gibt. Derzeit **nicht ergänzt**,
weil die Bedingungen zu GLOALAUNCH10 noch nicht veröffentlicht sind — ein
Verweis würde ins Leere zeigen. Sobald Entwurf C (Abschnitt 4) freigegeben und
veröffentlicht ist, gehört ein Satz in § 3.

---

## 7. Was in diesem Durchgang NICHT verändert wurde

Keine Zeile in `app/GloaSite.tsx`. Keine Datenschutzerklärung, keine AGB, keine
Widerrufsbelehrung. Kein Checkout, keine Preise, keine Datenbank, keine
Zahlungen, kein Launch-Versand. Migration 044 bleibt unangewendet.

Die AGB decken derzeit nur den Warenkauf — das ist **zutreffend**, solange
`SHOP_STATUS = "prelaunch"` gilt, das Kundenkonto „Buchbar sind Abos noch
nicht" sagt und `B2C_ANNUAL_PLAN_ENABLED` nicht gesetzt ist. Sobald eines davon
freigeschaltet wird, fehlen: 28-Tage-Zyklus, 14-Tage-Kündigungsfrist,
§ 312k-Kündigungsschaltfläche und eine eigene Widerrufsbelehrung für
Dauerschuldverhältnisse und für den vorausbezahlten Jahresplan.

Nirgends wird ein 28-Tage-Zyklus „monatlich" genannt; kundenseitig steht
durchgängig „alle 4 Wochen". Der B2B-FAQ spricht von „monatlich" — das ist ein
anderes, individuell vereinbartes Modell und vermischt sich nicht mit dem
B2C-Zyklus.
