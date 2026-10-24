# GLOA ? Stripe READ Permission Correction

> Aktueller Abschlussstand: [Automatische Finance-Synchronisierung — Release Review](GLOA_AUTOMATIC_FINANCE_SYNC_RELEASE_REVIEW.md). Atomarer DB-Writer, Migration 085, Cron und Monitoring sind inzwischen lokal implementiert und geprüft. Historische Production-Buchungen und Aktivierung bleiben gesondert freigabepflichtig. Die folgenden Abschnitte dokumentieren den früheren Arbeitsstand.


Stand: 24.10.2026. Fortsetzung des bestehenden Finance-Patches, kein Neustart und keine Production-Schreiboperation.

## Ergebnis

**Alle ben?tigten Provider-READs erfolgreich. Kein Account-/Connect-Berechtigungsblocker mehr.**

- Best?tigter Account: acct_1U6B3ODI76FH9qsq. Diese Account-ID und die Zuordnung der bekannten Zahlung sind vom Owner verifizierte Serverkonfiguration; sie werden nicht als aus einem Account-API-Response abgeleitet ausgegeben.
- Derselbe unver?nderte Restricted LIVE-Key liest die bekannte Zahlung pi_3UNcyODI76FH9qsq15ToRfXY: LIVE, succeeded, EUR, amount_received=23268. Damit wird die konfigurierte GLOA-Objektbindung vor jeder vollst?ndigen Datenerhebung best?tigt.
- GET /v1/account ist vollst?ndig aus dem Reader entfernt. Keine Connect-Header, keine Connect-Rechte oder neuen Schl?ssel. Die Account-ID darf nicht aus einem Browserrequest in diese Konfiguration ?bernommen werden.
- .env.local weiterhin Git-ignoriert und ungetrackt. Ausschlie?lich STRIPE_RECONCILIATION_READ_KEY verwendet; weder Wert noch andere Schl?ssel ausgegeben/ver?ndert.
- Vollst?ndige paginierte Ressourcen: 9 PaymentIntents (8 succeeded, 1 canceled), 8 Charges, 8 Refunds, 20 Balance Transactions und 1 failed Payout. Oktober ist ein laufender Zeitraum, kein Monatsabschluss.
- Billing > Invoices > Lesen funktioniert f?r GET /v1/invoice_payments. Beide gepr?ften Relationen enthalten LIVE=true, EUR, paid, 2089 Cent und einen expliziten paid_at-Zeitpunkt. Keine neue Berechtigungsanforderung.

## Jetzt bewiesene Abo-Verkn?pfungen

| GLOA Invoice | Invoice Payment | Urspr?ngliches PaymentIntent | paid_at UTC |
|---|---|---|---|
| in_1UKMF6DI76FH9qsqwEA3HmJt | inpay_1UKMHoDI76FH9qsqb9V3lMDE | pi_3UKMF6DI76FH9qsq0TRqDmCy | 2026-09-27T17:54:49.000Z |
| in_1UNcrXDI76FH9qsqaI3vLL18 | inpay_1UNcsbDI76FH9qsqkS2uUqZG | pi_3UNcrYDI76FH9qsq1HjBHlNI | 2026-10-06T18:14:17.000Z |

Die ehemalige September-Zuordnungsl?cke ist damit geschlossen. Kein Abgleich allein ?ber gleiche Betr?ge, ?hnliche IDs oder nahe Zeitpunkte. Die Source-Bridge l?sst den urspr?nglichen NULL-PI-Snapshot in GLOA unver?ndert.

## Fortgesetzte Automatisierung

1. Read-Port: bekannte LIVE-Identit?t pr?fen, dann vollst?ndige Ressourcenlisten und exakte Invoice-Payment-Relationen lesen. Account-Metadaten sind keine Voraussetzung.
2. Neuer GET-only-Adapter erlaubt nur festgelegte Ressourcen unter https://api.stripe.com, nur lesende Parameter und Authorization. /account, Connect-Kontext, Redirects und Schreibpfade sind ausgeschlossen. Fehler geben Ressource/HTTP-Status, keine Rohantwort oder Credentials aus.
3. Normalizer verbindet lokale Parent-/Attempt-Referenzen mit PI, Charge, Refund und BT. Status, LIVE, W?hrung, Betr?ge, Captured-Betrag, Net/Fee, kumulative Refunds und Berlin-Daten werden gepr?ft. Fehlende oder mehrdeutige Quellen sperren die Ausgabe. Legacy-Events werden nur ?ber den exakten Parent und seine verifizierte Providerkette mit eindeutiger Eventart und passenden gespeicherten Werten verkn?pft.
4. Gemeinsame Pipeline erzeugt zun?chst den gesperrten oder review_required Dry-run. Mit explizitem atomarem Storage-Port kann der vorhandene Worker lokale autorisierte Effekte idempotent abarbeiten; jeder Erfolg wird autoritativ best?tigt. Kein automatisches Replay von Checkout-, E-Mail-, Delivery- oder Customer-Rights-Handlern.
5. Unbekannte/geschlossene Perioden stoppen vor dem Storage-Port. Ohne Storage-Adapter gibt es grunds?tzlich keine Schreiboperation. Der sp?tere echte DB-Adapter muss Tax-/Periodenpr?fung und Ledger-/Bridge-Commit atomar garantieren; kein Production-Adapter oder neuer Cron aktiviert.

## Tats?chlich durchgelaufener READ-only Dry-run

Ein aktueller enger Supabase-SELECT lieferte ausschlie?lich die acht technischen Zahlungssnapshots, acht bestehenden Ledgerzeilen und die Anzahl vorhandener Ausgaben im Zeitraum (0). Das ist kein Nachweis von null tats?chlichen Kosten. Minimierte Evidence liegt ausschlie?lich in ignorierten outputs-Dateien; dort keine Schl?ssel oder Kunden-/Kartendaten.

- 8 lokale Zahlungsquellen eindeutig normalisiert, ohne Provider-Zuordnungsfehler.
- Alle 8 vorhandenen Ledgerzeilen verkn?pft und dadurch von erneuter Planung ausgeschlossen.
- 8 Payment-Fee-BT-Nachweise vollst?ndig zugeordnet.
- Fehlende Effekte: **4 Zahlungen + 4 Refunds + 8 Zahlungsgeb?hren + 2 Usage-/Account-Fee-Buchungen**.
- Diese 18 Kandidaten besitzen jetzt konkrete Source-IDs und Originaldaten. Der echte Dry-run h?lt sie wegen fehlender expliziter Periodenfreigabe weiterhin gesperrt; keine Periode wurde stillschweigend ge?ffnet.
- Vorhandene GLOA-Buchungen bleiben unver?ndert. Oktober zeigt deshalb bis zur separat genehmigten Nachbuchung weiterhin nur die gespeicherten 295,35 EUR Refunds statt 547,42 EUR.

Unver?nderte Kontrollsummen:

| Monat | Zahlungen | Refunds | Payment Fees | Usage-/Account Fees |
|---|---:|---:|---:|---:|
| September | 545,92 EUR | 293,85 EUR | 17,72 EUR | 0,15 EUR |
| Oktober | 295,35 EUR | 547,42 EUR | 10,22 EUR | 0,15 EUR |
| Gesamt | 841,27 EUR | 841,27 EUR | 27,94 EUR | 0,30 EUR |

Die beiden Usage-BTs sind eigene Account-Belastungen, keine erfundenen Geb?hren einer Kundenzahlung. Rechnung/VAT bleiben separat zu pr?fen. Failed Payout bleibt ausgeschlossen; seine beiden Balance-Bewegungen ergeben zusammen 0. Bankabgleich erfordert weiterhin Bank-/Saldo-Belege.

## Dateien dieser Fortsetzung

- lib/stripeReconciliationRead.ts ? Account-Abh?ngigkeit entfernen, gepr?fte Accountbindung; paginierte Invoice-Payment-Relationen.
- lib/stripeReconciliationClient.ts ? neuer Restricted-Key-GET-Adapter.
- lib/financeReconciliationEvidence.ts ? neue automatische exakte Provider-/GLOA-/Legacy-Bridge.
- lib/financeEvidenceSynchronization.ts ? neue gemeinsame Normalizer-/Planer-/Worker-Pipeline, optionaler lokaler Storage-Port.
- tests/finance-reconciliation-patch.test.mjs ? bestehende Account-/Paginationtests auf das korrigierte Modell umstellen.
- tests/finance-evidence-synchronization.test.mjs ? neue Sicherheits-, Invoice-, Normalizer- und Pipelinepr?fungen.
- docs/GLOA_STRIPE_READ_PERMISSION_CORRECTION.md ? dieser Abschlussstand.
- docs/GLOA_STRIPE_LIVE_RECONCILIATION_VERIFIED.md und docs/GLOA_FINANCE_RECONCILIATION_PATCH_PROPOSAL.md ? Verweis auf den neuen ma?geblichen Berechtigungs-/Zuordnungsstand.

Keine ?nderung an Migrationen, SQL-Vorschl?gen f?r 084 oder historischen Gesch?ftsdaten. Vorhandene Finance-/Security-Arbeit und unrelated Dateien erhalten. Lokale ignorierte Lesehilfen und Dry-run-Evidence nicht zum Release stagen.

## Tests und verbleibende Freigabegates

115 Finance-/Provider-/Dashboard-/Worker-/Pipelinechecks bestanden, 0 fehlgeschlagen. Neue Tests belegen: kein /account oder Connect; falsches LIVE-Objekt wird abgelehnt; vollst?ndige Invoice-Pagination und strikte Relationspr?fung; fehlende/mehrdeutige Invoice-Links, widerspr?chliche Snapshots und Legacy-Daten blockieren; geschlossene/unbekannte Perioden erreichen den Storage-Port nicht; Dry-run schreibt nichts; wiederholte lokale Worker-Verarbeitung erzeugt keine doppelten Effekte; Read-Adapter kann keine Schreibpfade oder sensitiven Fehlerantworten ausgeben.

Die bestehenden 14 echten PostgreSQL-Nachweise bleiben f?r die unver?nderten DB-Korrekturvorschl?ge g?ltig. Kein kompletter Replay und keine neue Datenbankpr?fung n?tig, weil in dieser Fortsetzung ausschlie?lich Source-READ, Zuordnung und Pipeline erg?nzt wurden. Ihre Grenze bleibt bestehen: kein vollst?ndiger historischer Tax-/Perioden-Writer auf dem kompletten Schema.

Noch n?tig zum sicheren automatischen Livebetrieb: Perioden-/Tax-Freigabe, freigegebene Anpassung des py_-Constraints und des zus?tzlichen Fee-RPC-Guards, vollst?ndiger atomarer historischer Writer/Source-Bridge und gesch?tzte Cron-/Syncstatusintegration. Die bisherigen fehlenden Account-/Invoice-Berechtigungen sind **keine verbleibenden Blocker**. N?chste sichere Aktion ist die Pr?fung des nun vollst?ndig ID-basierten Korrekturmanifests und des DB-/Periodenvertrags; noch keine Ausf?hrung genehmigt.

Keine Production-Schreibzugriffe, kein Stripe-Write, keine Migration, kein Commit, Push oder Deployment. STOP FOR REVIEW.

Abschlie?ende Gates: TypeScript, gezieltes ESLint und git diff --check bestanden. Kein File gestagt; Migrationen unver?ndert, 084-SHA256 weiterhin 178f6b5f88ef4fcbc4ebf624d3facd5a9f61b3f630b14fd504f49ad8d818a04f. Der vorherige erfolgreiche Production-Build und die PostgreSQL-Evidence werden wiederverwendet; keine ?nderung an angebundenen App-Routen, UI oder DB-SQL in dieser Fortsetzung.
