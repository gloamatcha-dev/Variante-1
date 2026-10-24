# GLOA FINANCE — RECONCILIATION PATCH READY

> Aktueller Abschlussstand: [Automatische Finance-Synchronisierung — Release Review](GLOA_AUTOMATIC_FINANCE_SYNC_RELEASE_REVIEW.md). Atomarer DB-Writer, Migration 085, Cron und Monitoring sind inzwischen lokal implementiert und geprüft. Historische Production-Buchungen und Aktivierung bleiben gesondert freigabepflichtig. Die folgenden Abschnitte dokumentieren den früheren Arbeitsstand.


> Ma?gebliche Fortsetzung 24.10.2026: Account-API-Abh?ngigkeit entfernt; best?tigte Accountbindung und beide Invoice Payments erfolgreich verifiziert. Die fr?heren Account-/Invoice-READ-Blocker sind aufgehoben. Siehe [READ Permission Correction](GLOA_STRIPE_READ_PERMISSION_CORRECTION.md) f?r Pipeline, Dry-run und verbleibende DB-/Periodengates.

Stand: 24.10.2026 (Fortsetzung vom 23.10.). Lokaler Source-Patch und Korrekturentwurf zur Prüfung; **kein freigegebener Production-Import**. Ausgangsbasis: `6db7c37b693991617a392b26c5937114879a8f75`. Kein Commit, Push, Deployment, Remote-Schreibzugriff oder Stripe-Schreibaufruf in dieser Fortsetzung. Eng begrenzte Production-SELECTs haben nur technische Parent-/Attempt-/Ledgerreferenzen nachgeprüft; keine PII gelesen. Migration 084 bleibt unverändert und wurde nicht ausgeführt.

## Beweisstand und Kontrollsummen

Die neuen Stripe-LIVE-Ergebnisse wurden vom Auftraggeber als verifiziert übergeben. Diese Fortsetzung hat keine eigenen LIVE-Objekte abgerufen. Die älteren Berichte dokumentieren den damaligen fehlenden Providerzugriff; deren Aussage „Provider pending“ wird hinsichtlich der **übergebenen Summen und erfolgreichen Refunds** durch die neuen Angaben ersetzt. Minimierte Einzelbelege und ihre konkreten Source IDs stehen inzwischen im verlinkten Abschlussbericht.

| Zeitraum | Zahlungen | erfolgreiche Erstattungen | übergebener monatlicher Gebührenwert |
|---|---:|---:|---:|
| September 2026 | 545,92 EUR | 293,85 EUR | 17,87 EUR |
| Oktober 2026 | 295,35 EUR | 547,42 EUR | 10,37 EUR |
| Gesamt | 841,27 EUR | 841,27 EUR | 28,24 EUR |

Übergebene Aufteilung insgesamt: **27,94 EUR Zahlungsgebühren + 0,30 EUR zusätzliche Usage Fee = 28,24 EUR**. Die beiden monatlichen Gebührenwerte ergeben also nicht allein 27,94 EUR Zahlungsgebühren. Der Monat der Usage Fee und die entsprechende monatliche Aufteilung sind ohne Einzelbeleg ungeklärt. Keine erfundene Gebührenverteilung. Die fehlgeschlagene Auszahlung 17,87 EUR ist ein separater Vorgang und kein Einnahmen- oder Gebührenbeleg allein aufgrund desselben Betrags.

Alle acht Zahlungen wurden laut neuem Providerbefund vollständig erstattet. Das bestätigt keine Erstattung der ursprünglichen Zahlungsgebühren. Stripe beschreibt ursprüngliche Processing Fees als nicht zurückerstattet; konkrete Fee Credits/Refund-Balance-Bewegungen müssen trotzdem einzeln geprüft werden: [Refunds](https://docs.stripe.com/refunds). Gross, Fee, Net, Source und Transaktionstyp sind getrennte Felder des [Balance-Transaction-Objekts](https://docs.stripe.com/api/balance_transactions/object).

## Exakte technische Ursachen

1. `supabase/migrations/072_admin_core_connections.sql`, Abschnitt 11: **NO BACKFILL AT ALL**. Historische bezahlte/refundierte Parent-Snapshots erzeugen nachträglich keine Ledger-Zeilen. `financial_events` ist ein eigenes, append-only Cash-Event-Ledger; `orders`/`annual_plans` sind kein Ersatz dafür.
2. `app/api/stripe/webhook/route.ts`: `hasStripeWebhookEventBeenProcessed` beendet Wiederholungen schon vor dem Handler. Eine bereits verarbeitete historische Checkout-Session wird deshalb durch erneute Zustellung nicht zum Ledger-Reparaturauftrag. Der Processed-Marker beweist nicht die heutige Vollständigkeit des Ledgers. Bei Refund-/Invoice-Events fehlt im gespeicherten Webhook-Journal zudem eine direkte Payment-/Refund-Korrelation; ein Session-Join allein beweist keinen verlorenen Refund-Webhook.
3. Die aktuellen Handler verlangen mit `requireBusinessEffect` erfolgreiche Ledger-Effekte; `annualPlanWebhook.ts` verlangt das auch für Jahresvorauszahlungen. Welcher historische Deploymentstand die fehlenden Effekte verursachte, ist **nicht belegt**. Keine unbelegte Behauptung eines aktuell verschluckten Webhookfehlers.
4. `079_provider_fee_evidence.sql`: Discovery ist ausdrücklich durch `capture_from` begrenzt. Sie importiert keine historischen Einnahmen. Eine Gebührenreparatur darf weder dieses Datum pauschal zurücksetzen noch aus Refundbeträgen Gebühren schätzen.
5. `summarizeLedger` prüfte Gebühren nur für vorhandene Inflow-Zeilen. Ein leeres historisches Ledger erfüllte die Prüfung damit ohne Nachweis. Finance und Overview konnten September als vollständigen Null-Deckungsbeitrag behandeln. Die Addition der vorhandenen Oktoberzeilen war korrekt, die zugrunde liegende Datenmenge unvollständig.

## Zuordnung der acht Zahlungen

Die folgenden IDs und Zeitpunkte stammen aus der bereits dokumentierten GLOA-Leseprüfung. **Zeitpunkte sind App-Snapshots in UTC, keine neu verifizierten Stripe-Transaktionszeitpunkte.** Sie dürfen nicht als Providerbeleg in den Import übernommen werden. „Fehlt“ bezeichnet den früher gelesenen Ledgerstand.

| Vorgang | Lokaler Parent | vorhandene PI-/Invoice-Referenz | App bezahlt UTC | App Refund-Update UTC | Ledger |
|---|---|---|---|---|---|
| Abo 20,89 September | Order `c5ec378a-125f-40d9-9d73-de93f8427b5f` | PI im ursprünglichen Snapshot NULL; Invoice `in_1UKMF6DI76FH9qsqwEA3HmJt` | 27.09. 17:54:56.126245 | 28.09. 12:47:04.996760 | Zahlung/Refund fehlen |
| Einmal 20,89 September | Order `9aabf26a-d71f-41e7-b748-17d6de8293d7` | `pi_3UKknBDI76FH9qsq0QsDCXQp` | 28.09. 20:06:12.156 | 28.09. 20:08:54.319892 | Zahlung/Refund fehlen |
| Jahresplan 252,07 erster | Plan `f385b873-b788-4b20-a4b7-9d44b6dc66d4` | `pi_3UKkxBDI76FH9qsq1aAv37s6` | 28.09. 20:16:19.553 | 28.09. 20:54:43.788889 | Zahlung/Refund fehlen |
| Jahresplan 252,07 zweiter | Plan `5e88aafc-f9e0-423a-9591-b1fa1f56f66d` | `pi_3UL8iPDI76FH9qsq1VNC23aE` | 29.09. 21:37:38.147 | 02.10. 16:18:17.939414 | Zahlung/Refund fehlen |
| Jahresplan 232,68 | Plan `b6974dee-068b-46d0-b3c8-de73abee305e` | `pi_3UNcyODI76FH9qsq15ToRfXY` | 06.10. 18:20:41.656 | 08.10. 14:22:36.559379 | Zahlung/Refund vorhanden |
| Einmal 20,89 Oktober A | Order `5f550a71-d10a-4ca9-a092-c16b9e59eb74` | `pi_3UNbufDI76FH9qsq1KtUYIhi` | 06.10. 17:12:29.472 | 06.10. 17:40:59.842784 | Zahlung/Refund vorhanden |
| Einmal 20,89 Oktober B | Order `136764ab-4aef-4c91-addc-72033635db13` | `pi_3UNcOwDI76FH9qsq0U5SGavD` | 06.10. 17:43:58.465 | 06.10. 17:47:58.057191 | Zahlung/Refund vorhanden |
| Abo 20,89 Oktober | Order `45bef040-adff-4c27-9ee8-45bc8f3d5f95` | Invoice `in_1UNcrXDI76FH9qsqaI3vLL18`; Refund-Ledger referenziert `pi_3UNcrYDI76FH9qsq1HjBHlNI` | 06.10. 18:14:24.482702 | 08.10. 15:13:35.165863 | Zahlung/Refund vorhanden |

Die PI-Verknüpfung einer Abo-Rechnung muss über Invoice Payments bestätigt werden. Die spätere Refund-Referenz allein ersetzt diese Prüfung nicht. Die vollständigen Checkout-Attempt-Zuordnungen der früheren Prüfung sind weiterhin vorhanden; keine Snapshots werden überschrieben. Jahresplan-Lieferorders über je 19,39 EUR sind **keine weiteren Zahlungseingänge**.

Read-only erneut bestätigte Source-Bridge-Ausgangslage (alle Attempts `paid`):

| Parent/Vorgang | Checkout Attempt | bestehendes Income-Event | bestehendes Refund-Event |
|---|---|---|---|
| September Abo | `07afb510-1f75-471a-b6b6-6fcf1d5fb145` | fehlt | fehlt |
| September Einmal | `0725baa0-bd2f-47d7-bbf0-e69cedfcbfbc` | fehlt | fehlt |
| Jahresplan erster 252,07 | `b50360f0-337c-48bf-b6d1-511f68395a1b` | fehlt | fehlt |
| Jahresplan zweiter 252,07 | `3730d247-3844-4400-8a57-b265acd9045b` | fehlt | fehlt |
| Jahresplan 232,68 | `ff14e8e7-ac43-488d-b084-3955e39e577f` | `adde17e0-b0c0-4adb-adf1-24b76b79f0bb` | `609982af-96d1-4c7c-bf70-e05b70663f76` |
| Oktober Einmal A | `c372f99c-f076-461e-87ec-9e211e05447c` | `c24cb5db-bd71-4521-9eef-54215dccdce5` | `02b27e67-2ca2-4032-9f7c-7288e7b297b5` |
| Oktober Einmal B | `acd1b5cc-a7ba-4079-9cf3-cae460b2543c` | `b2b36a8c-50dd-49ed-8b42-3d83ced011b3` | `bc0549db-5cb5-48d4-8895-24cd8b7e94fa` |
| Oktober Abo | `873e66e7-a27b-4415-8d09-62674fb27b10` | `eb35cedb-3b1c-4ab8-9f32-817a1f2455e9` | `68905f0d-109c-432e-a08c-41e8de28b79e` |

Diese vorhandenen acht Ledgerzeilen dürfen nicht erneut eingefügt werden. Für Refunds enthalten sie PaymentIntent-Referenzen, keine tatsächlichen `re_`-IDs. Die jetzige SELECT-Nachprüfung bestätigt die Lücke; sie liefert keine fehlenden Stripe-Refund-/BT-Objekte.

Erwarteter fehlender Bruttoumfang bei identischen Providerdaten und offenen Perioden: vier September-Incomes 545,92 EUR, September-Refunds zusammen 293,85 EUR und der separate Oktober-Refund 252,07 EUR. Das sind Kandidaten, kein freigegebener INSERT-Manifest. Ein vollständiger Refund kann aus mehreren Refund-IDs bestehen: daher keine garantierte Anzahl einzelner Refundzeilen.

## Lokaler Source-Patch

- `lib/financeSourceCoverage.ts`: vergleicht bezahlte/refundierte lokale Cash-Quellen mit dem gesamten zugehörigen Ledger. Getrennte Monate; kumulative Refunds über alle Perioden vergleichen. Datumslücken, Betragskonflikte und doppelte Incomes verhindern Vollständigkeit. Ein Refund-Update ist nur ein Hinweis auf eine Lücke, kein Buchungsdatum für Teilrefunds.
- `lib/adminPortalFinanceRead.ts`: Finance und Overview lesen dieselbe Basis und zusätzlich paginierte, minimale Cash-Snapshots. Annual-Delivery-Orders werden anhand ihrer echten Checkout-Attempt-Planrelation ausgeschlossen. Keine neuen Buchungen, Kundenrechte-/Delivery- oder Stripe-Schreiboperationen. Ein Lesefehler ergibt `unavailable`, keine Vollständigkeitsbestätigung.
- `lib/adminPortalFinance.ts`: fehlender oder negativer Quellenabgleich sperrt Deckungsbeitrag/Ergebnis. Ein erkannter Gap sperrt auch die Nullgebühren-Bestätigung. Hinweise nennen fehlende Zahlungen/Refunds und kennzeichnen die angezeigten Bruttosummen als erfasste Teilbeträge. **Oktober bleibt vor Import bei den gespeicherten 295,35 EUR Refunds**, sichtbar unvollständig; erst nach belegter Korrektur stehen dort 547,42 EUR. Keine hart codierten Monats- oder Produktbeträge.
- `lib/providerFeeCapture.ts`: zusätzlich PI amount_received = Charge amount = BT amount und BT net = amount − fee validieren. Fehlende/inkonsistente Werte werden über den bestehenden Retrypfad behandelt. Der bestehende DB-Writer hat bereits eindeutige Income-/PI-/Charge-/BT-Schlüssel. Gebühren werden trotz Vollrefund nicht gelöscht.
- `lib/financeReconciliation.ts`: reiner, deterministischer **Dry-run-Planer ohne DB-/Provideradapter**. Er verlangt Konto-ID, LIVE, EUR, positive Integer-Cents, Source-/Charge-/BT-IDs, Originalzeitpunkt, aufgelöste lokale Zahlungszuordnung und explizite Periodenfreigabe. Unzugeordnete Legacy-Events, widersprüchliche bestehende Einträge, Duplikate oder Over-Refunds sperren die gesamte Ausgabe. Wiedervorlage nach Teilfortschritt liefert nur noch nicht zugeordnete Source Keys. Gebühren werden an BTs gebunden; Usage Fees bleiben separat, Auszahlungen werden grundsätzlich aus dem wirtschaftlichen Ledgerplan ausgeschlossen.

Der Planer prüft normalisierte Belege, authentifiziert jedoch keine Exportdatei. Er erzeugt weder Steuerbuchungen noch einen ohne Prüfung ausführbaren SQL-Import. Eine gefälschte Eingabedatei wird nicht durch eine passende Summe zu einem Providerbeleg.

`scripts/finance-reconciliation-plan.mjs` ist ein ausschließlich lokaler Dateiein-/ausgabe-Runner. Aufruf nach belegter Normalisierung: `node scripts/finance-reconciliation-plan.mjs <evidence.json> <new-plan.json>`. Kein Env-Laden, Netzwerk oder SQL. Existierende Ausgabedateien werden nicht überschrieben. Ausgabe enthält immer `DRY_RUN_ONLY` und `readyForDatabaseExecution:false`; Exit 2 bedeutet blockierte Belege, Exit 1 ungültige Eingabe/Ausgabe. Die TypeScript-Typen im Planer definieren die Eingabe inklusive lokaler Subject-Relationen, bestehender expliziter Source Bridges, ungemappter Legacy-Events und Periodenentscheidung. Ein leeres Legacy-Array ist erst nach tatsächlicher Prüfung zulässig.

## Forward-only Datenbankkorrektur — separate Freigabe erforderlich

### Voraussetzungen / fehlende Belege

Für alle acht Zahlungen: verifizierte `acct_`-ID und LIVE-Kontext; PaymentIntent, Charge, gegebenenfalls Invoice Payment und Invoice; amount_received/Chargebetrag/Currency; tatsächlicher erfolgreicher Zahlungszeitpunkt; jeder einzelne Refund mit ID, Charge-/PI-Relation, amount/currency/status und erfolgreichem Ereigniszeitpunkt; jede Charge-/Refund-BT mit Source, amount/fee/net, currency, created, reporting_category/type. Bei asynchron erfolgreichen Refunds reicht `refund.created` als Erfolgsdatum nicht automatisch aus; erfolgreichen Übergang mit Event oder dokumentierter Buchungsrichtlinie belegen.

Zusätzlich erforderlich: Usage-Fee-BT/Beleg/Monat; Payout-ID mit failed, ursprüngliche und Failure-Balance-Bewegung und gegebenenfalls Bankauszug; vorhandene Ledger-IDs; Provider-Event-IDs zur Webhookprüfung; Steuer-/Refund-Tax-Snapshots und autorisierte Periodenentscheidung. Keine Kundennamen, Kartendaten oder API-Schlüssel erforderlich.

**Aktuell fehlen diese Einzelbelege. Deshalb kein fertiger Production-INSERT und kein automatisch anwendbarer Betragsimport.** Die vom Auftraggeber bestätigten Summen werden als Kontrollsummen dokumentiert, nicht in den Anwendungscode eingebaut.

### Minimaler Writer-Vertrag für eine spätere, eigene Migration

Keine Änderung an 001–084. Keine neue nummerierte Migration in dieser Vorbereitung. Nach Prüfung des vollständigen Manifests eine eigene forward-only Migration für folgende isolierte Funktionen/Beweisreferenzen vorbereiten:

1. Append-only Source-Bridge mit eindeutigem `(provider_account_id, live_mode, source_kind, source_id)`; zusätzlich eindeutiger Gebühren-BT unabhängig von Usage-/Payment-Fee-Klassifizierung. Source-Bridge speichert Beleghash, genaue Zeit, Betrag/Währung, lokalen Parent, originalen und gegebenenfalls Korrekturzeitraum, Freigabe/Actor und Ledger-ID. `financial_event_id` darf für explizit überprüfte historische Sammelrefunds mehrfach vorkommen; keine implizite Zuordnung nach gleichem Betrag.
2. RLS und keine Browsergrants; Schreibzugriff nur über eng begrenzten serverseitigen SECURITY-DEFINER-Writer mit leerem search_path, validiertem Owner-/Operator-Kontext und separater Importfreigabe. Kein beliebiger Browser-RPC und kein GRANT ALL. Tabellen-/Funktionsgrants erst nach Prüfung des echten Callers festlegen.
3. Pro Quellgruppe eine Transaktion: Advisory Lock auf Konto/PaymentIntent, Parent `FOR SHARE`, relevanter bestehender Ledger-/Bridgezustand sperren, Quelle/Tax/Periode überprüfen. Bereits identischer Source Key → `already_recorded`; abweichender Betrag/Datum/Parent → Fehler. Kein `ON CONFLICT DO NOTHING` ohne Vergleich.
4. Bestehende passende Events ausschließlich verknüpfen. Für alle vier Oktober-Incomes und vorhandenen Refunds ist eine explizite Bridge nötig, bevor fehlende Events eingefügt werden. Legacy-Refunds sind kumulativ: bekannte Teilrefunds je Source ID atomar der bereits vorhandenen Summe zuordnen, nicht denselben kumulativen Betrag nochmals einfügen. Bei nicht eindeutigem Mapping oder falscher historischer Monatszuordnung stoppen und separaten Korrekturbeleg beschließen.
5. Neue fehlende Incomes/Refunds mit Originaldatum `Europe/Berlin`, unverändertem historischen Tax-Snapshot, Provider-Referenz und eindeutiger Operation ID einfügen. `created_at` bleibt das heutige Erfassungsdatum. Kein Jahresplan-Lieferincome, keine Änderung von Orders/Plänen/Attempts und keine tatsächliche Refundausführung.
6. **Bestehende Refund-RPCs nicht als historischen Backfill verwenden:** die aktuelle Refund-Tax-Funktion schreibt Ereignisdatum aus `now()` und arbeitet kumulativ. Das würde historische Perioden und Teilrefundidentitäten verfälschen. Der spätere Writer braucht explizites belegtes Effective Date und getrenntes Recording Date unter denselben Steuer-/Withdrawalschutzregeln; keine 081-Guard-Umgehung.
7. Geschlossene oder unbekannte Perioden: Import stoppen. Keine Rückdatierung durch bloßes Öffnen/Ändern eines Coverage-Status. Falls fachlich freigegeben, ausschließlich ein zusätzlicher Korrekturbeleg im offenen Zeitraum mit Originaldatum/Originalperiode, Freigabe und Referenz. Nicht in diesem Patch implementiert; kein Löschen/Ändern geschlossener Events. Bestehende General-Cost-Coverage ist **kein** allgemeiner Periodenfreigabenachweis.
8. Historical-Fee-Evidence gezielt für jede freigegebene Income-ID über den bestehenden Initializer anlegen, nach Read-only-Preflight. Der Initializer arbeitet ohne globale Änderung von `capture_from`; anschließend exakten BT-Befund über den vorhandenen Ergebniswriter aufzeichnen. Beide Vorgänge nur nach eigenständiger Produktionsfreigabe. Positive Fees genau einmal; dokumentierte Zero Fees nur bei explizit geprüftem BT fee=0; fehlender BT bleibt retryable/unbekannt. Wiederholte positive Ergebnisse dürfen keine weiteren Fee-Events erzeugen.
9. Usage Fee 0,30 EUR als belegter allgemeiner Provideraufwand mit eigener Source-BT-Idempotenz behandeln, nicht als Gebühr einer erfundenen Kundenzahlung. VAT unbekannt lassen, wenn kein Steuerbeleg existiert. Ob ein neues Evidence-Link-Feld für business_expenses nötig ist, vor der eigenen Migration entscheiden; kein ungesicherter aktueller Manual-Cost-Import.
10. Payouts einschließlich failed/payout_failure ausschließlich im Bank-/Stripe-Balance-Abgleich behandeln. Kein `order_payment`, `refund`, `payment_fee` oder positiver Cash-Receipt für die fehlgeschlagene 17,87-EUR-Auszahlung. Kein bloßes Addieren von Payouts zum Umsatz. Anfangssaldo + Summe aller vollständigen Balance-Bewegungen = Endsaldo separat gegen Payout-/Bankbelege prüfen.

Transaktionsablauf des vorgeschlagenen Writers (Vertrag, **kein ausführbarer SQL-Patch**):

```text
BEGIN
  lock(account, payment_intent)
  verify trusted source hash, LIVE/account, parent mapping, tax, period
  inspect ALL existing income/refund/fee rows and source bridge for this parent
  assert no unreviewed legacy rows and no source/amount/date conflict
  if identical bridge already committed: return already_recorded
  else link approved existing event OR append exactly the missing source event
  insert immutable unique source bridge in the SAME transaction
  assert cumulative refunds <= verified original payment
COMMIT
```

Ein Prozessabbruch zwischen Ledgerinsert und Bridgeinsert darf daher nichts halb verbuchen. Nach verlorener Antwort wird zunächst der Source Key gelesen; ein erneuter Writeraufruf muss dieselbe Zuordnung zurückgeben. Reale atomare DB-Concurrency-Tests dieses künftigen Writers sind vor Freigabe nötig; die jetzigen Planertests ersetzen sie nicht.

### Dauerhafte Synchronisierung

Die bestehenden Kunden-/Checkout-Handler nicht erneut ausführen, um Finanzdaten zu reparieren: sie besitzen E-Mail-, Bestell-, Provisions- und Delivery-Nebeneffekte. Stattdessen nach Freigabe des isolierten Writers einen serverseitigen Reconciliation-Worker vorsehen: read-only Stripe-Quelle → persistierte geprüfte Evidence → rein finanzielle idempotente Effekte. Verarbeitete Webhook-IDs bleiben verarbeitet. Finanz-Effektzustand separat retrybar führen; erkannte Ledger-Lücken unabhängig von der Webhook-Deduplication abarbeiten. Autorisierte periodische Coverageprüfung muss auch ältere Quellen erfassen; kein pauschaler historischer Fee-Sweep ohne Belegprüfung.

Der lokale Quellenabgleich ist eine zusätzliche Vollständigkeitswarnung, kein vollständiger Providerabgleich. Die paginierten separaten SELECTs können bei gleichzeitigen Transaktionen vorübergehend inkonsistente Beobachtungen liefern; bei größerem Datenvolumen ist ein einzelner autorisierter read-only Snapshot-RPC mit passenden Indizes vorzusehen. Aktuell werden ausschließlich minimale Felder intern gelesen, keine neuen Parent-/Provider-IDs an die Oberfläche gegeben. App-Snapshot-Datum und korrigiertes Providerdatum können abweichen: dann bleibt der Hinweis absichtlich bestehen, bis eine geprüfte Provenance-Bridge im späteren RPC berücksichtigt wird. Nicht blind den Originalsnapshot umdatieren.

## Jahresplan-/Kundenrechtsschutz

Migration 039 hält Lifecycle und Zahlungszustand getrennt; `status=active` bei `payment_status=refunded` wird durch die Delivery-Claims/Erfüllung geschützt. 070 erhält die Claim-Schutzregeln. Planstatus, Schedules, bereits historische Deliveryorders, Widerrufs-/Tax-Scope und Refund-Reversal-Verträge bleiben unverändert. Kein automatisches Deaktivieren, Freigeben oder Erfüllen. Reconciliation-Worker darf keinen Delivery-/Customer-Rights-Handler aufrufen.

## Tests und Freigabegates

Neue Tests: `tests/finance-reconciliation-patch.test.mjs`. Ausschließlich synthetische IDs und gemockte Provider-/DB-Transporte. Acht synthetische Zahlungen testen die übergebenen Payment-/Refund-Kontrollsummen und getrennte Monate, keine behaupteten LIVE-Einzelbelege. Gebührenfixtures sind eigene synthetische Beträge und weisen der realen Usage Fee keinen erfundenen Monat zu.

Abgedeckt: Wiederholung, Teilfortschritt, Legacy-Bridge-Blocker, Konflikte, fehlende BTs, falsches Konto/Modus/Währung, offene/geschlossene/unbekannte Perioden, Over-Refund, Fee-Idempotenz, Usage-/Failed-Payout-Abgrenzung, Berlin-Datum, September-Leerledger, Oktober-Cross-Month-Refund, kumulative Teilrefunds, Quelle nicht erreichbar, Annual-Delivery-Ausschluss, inkonsistente BT-Net-/Amount-Werte. Die vorhandenen positiven Kosten-/Dashboardfixtures enthalten nun einen expliziten erfolgreichen Quellencheck; ein fehlender Quellencheck ist kein Vollständigkeitsnachweis mehr.

Finale Ergebnisse werden nach Abschluss der Gates unten ergänzt. Kein erneuter Security-Datenbankreplay nötig: SQL 084 und historische Migrationsdateien werden nicht geändert. Keine realen Kundendaten, Providerwrites oder historischen Finanzkorrekturen in diesen Tests.

## Nächste sichere Aktion / verbleibende Blocker

1. Vollständige minimierte Provider-Einzelbelege für alle acht Zahlungen, tatsächliche Refunds/BTs, Usage Fee und failed Payout bereitstellen; keine Schlüssel oder PII.
2. Account-ID, Einzelbeträge und jeweilige Originaldaten/Monate mit dieser Matrix sowie vorhandenem Ledger verknüpfen; existierende Events zuerst eindeutig bridgen. Usage-Monat und Processing-vs-Usage-Monatsaufteilung klären.
3. Steuerbelege und Periodenstatus fachlich freigeben. Erst danach tatsächlichen append-only Importmanifest erstellen. Ohne diese Nachweise bleibt er gesperrt.
4. Writer/Bridge als eigenen minimalen DB-Patch mit realen lokalen Atomicity-/Concurrency-/RLS-Tests separat zur Freigabe vorlegen; kein automatisches db push und keine Mitnahme von 084.
5. Gesonderte ausdrückliche Production-Freigabe einholen; nach Ausführung read-only Summen/Bridge/Fees/Balance prüfen, Dashboard aktualisieren. Einnahmen/Refunds jeweils 841,27 EUR sind nur die übergebenen Kontrollziele, nicht Ersatz für Einzelabgleich. Kosten/VAT/Bankreconciliation bleiben unbekannt, solange Belege fehlen.

## Abschluss nach LIVE-READ-Freigabe — maßgeblicher letzter Stand

Die Provider-Einzelbelege sind jetzt gelesen und im [LIVE-Abschlussbericht](GLOA_STRIPE_LIVE_RECONCILIATION_VERIFIED.md) vollständig mit PI-/py-/pyr-/BT-IDs, Beträgen und Zeitpunkten aufgeführt. Die vorherige pauschale Refund-/BT-Beleglücke besteht für diese acht Payments nicht mehr. Usage Fee: 15 Cent September, 15 Cent Oktober. Tatsächliche Account-ID und Invoice-Payment-Verknüpfungen bleiben wegen 403 ungeklärt; dafür werden READ auf `/v1/account` und `/v1/invoice_payments` oder verifizierte minimierte Exporte benötigt. Die vorhandenen Rechte wurden nicht verändert.

**Zusätzlicher bestätigter Fehler:** Alle acht Charge-IDs beginnen mit `py_`, alle Charge-BTs haben `type=payment` und `reporting_category=charge`. Runtime akzeptierte nur `charge`; der aktuelle, read-only nachgeprüfte Production-Constraint akzeptiert nur `ch_`. Source korrigiert den BT-Fall bei weiterhin exakter Korrelation. Planner akzeptiert `py_` und `pyr_`; keine bloße Freigabe beliebiger IDs. Der fehlgeschlagene Payout hat einen negativen Rohbetrag und wird ebenfalls nicht als Finanzincome geplant.

Minimaler separater SQL-Vorschlag **nur zur späteren Freigabe**, weder ausgeführt noch als neue nummerierte Migration angelegt. Vorher tatsächliche Constraintdefinition und alle vorhandenen Zeilen read-only prüfen, keine andere Constraintabweichung still überschreiben. Transactional DROP/ADD ändert ausschließlich das erlaubte Charge-ID-Präfix, keine Grants/RLS oder anderen Felder:

```sql
begin;
alter table public.provider_fee_evidence drop constraint provider_fee_ids;
alter table public.provider_fee_evidence add constraint provider_fee_ids check (
  (payment_intent_id is null or payment_intent_id ~ '^pi_[A-Za-z0-9_]{1,240}$')
  and (invoice_id is null or invoice_id ~ '^in_[A-Za-z0-9_]{1,240}$')
  and (charge_id is null or charge_id ~ '^(ch|py)_[A-Za-z0-9_]{1,240}$')
  and (balance_transaction_id is null or balance_transaction_id ~ '^txn_[A-Za-z0-9_]{1,240}$')
);
commit;
```

`lib/stripeReconciliationRead.ts`: wiederverwendbarer GET-Port, Identitätsprüfung an konfigurierter bekannter LIVE-Zahlung, vollständige Pagination aller fünf Ressourcen und Whitelist ohne PII. Unvollständige Ressourcen/Accountprüfung werden explizit ausgewiesen. Die getrennten API-Listen sind keine atomare Provider-Snapshottransaktion; vor späterem Import betroffene Originalobjekte/Status erneut lesen und Export mit Datum/Hash ablegen. Ebenfalls immer zuerst Scope-/Modusprüfung, kein Test-/LIVE-Mischen.

`lib/financeReconciliationWorker.ts`: separater finanztechnischer Worker, für periodische/Webhook-Effektaufträge nutzbar. Autoritativer Source-Key-Read vor jedem Effekt; DB-Adapter muss Ledger und Bridge atomar mit Unique Key schreiben. Verlorene Antwort → erst read-only bestätigen, kein sofortiger zweiter Schreibversuch. Nicht bestätigter Effekt → retry_required, Sourcekonflikt → blocked, nie voreilig Erfolg. Auch behauptete bestehende Einträge werden erneut autoritativ gelesen. Vorhandene Checkout-/E-Mail-/Deliverypfade werden nicht wiederholt. **Kein Production-Adapter, keine Cronaktivierung und keine Production-Nachbuchung in diesem Patch.** Persistierter Syncstatus, geschützte Cronanbindung und der vollständige historische Tax-/Perioden-Writer benötigen nach den offenen Belegen eine eigene Freigabe und Integration; deren Funktion wird nicht durch einen Mock behauptet.

### Abschließende Testevidenz

- 108 Finance-/Dashboard-/Provider-/Planer-/Worker-/Paginationchecks bestanden.
- 274 Checkout-/Webhook-/Subscription-/Annual-/Tax-/Customer-Rights-/Product-Owner-/Publication-Regressionschecks bestanden.
- 19 Offline-Checkouttests bestanden; Stripe-/E-Mail-Abhängigkeiten gemockt.
- 14 echte PostgreSQL-Checks bestanden: ursprünglicher 079-Constraint lehnt py ab; minimale Erweiterung akzeptiert ch/py; fremde Präfixe bleiben abgelehnt; keine Browser-Leserechte; Wiederholung erzeugt einen Effekt; Ledger-/Bridge-Zwischenfehler rollt zurück; Retry danach; Konfliktabwehr; zwei konkurrierende Sessions erzeugen einen Effekt. Zus?tzlich f?nf Checks am tats?chlichen 079-Fee-RPC auf minimalen synthetischen Referenztabellen: Originalguard lehnt py ab, gepatchter Guard zeichnet Geb?hr auf, Retry bleibt eindeutig, Konflikt wird abgelehnt, eingeschr?nkte EXECUTE-Grants bleiben erhalten. **Das ist ein synthetisches atomisches Vertragsmodell, kein vollständiger 081-/082-Production-Writer.**
- Insgesamt 415 Checks, keine verbleibenden Testfehler. Laufzeitnachweis: `tests/fixtures/finance-reconciliation-local-proof.json`; Runner: `tests/runtime/finance-reconciliation-local.mjs`. PostgreSQL ausschließlich neuer Cluster auf 127.0.0.1, zufälligem Port, neuer DB und Datenverzeichnis unter outputs; vor jedem Write Zielprüfung. Cluster gestoppt und Daten entfernt. Die beim ersten Sandboxversuch angelegten Daten wurden ebenfalls nur nach exakter Pfadprüfung ohne postmaster.pid entfernt. Logs/Nachweise bleiben erhalten.
- TypeScript und gezieltes ESLint bestanden. Abschließender Build-/Diffstatus wird nach dem letzten Gate festgehalten. Initiale Sandbox-/PowerShell-Umleitungsprobleme waren Umgebungsfehler; der direkte genehmigte Buildlauf bestand. Keine realen Providerwrites oder Bestellungen.
- Migrationschecker: alle 83 historischen Dateien byte-identisch; ausschließlich die schon vorhandene geprüfte 084 vorhanden. 084 SHA256 weiterhin `178f6b5f88ef4fcbc4ebf624d3facd5a9f61b3f630b14fd504f49ad8d818a04f`. Kein 085, keine SQL-Anwendung.

### Exakt in dieser Finance-Fortsetzung bearbeitete Dateien

```text
lib/adminPortalFinance.ts
lib/adminPortalFinanceRead.ts
lib/providerFeeCapture.ts
lib/financeReconciliation.ts
lib/financeReconciliationWorker.ts
lib/financeSourceCoverage.ts
lib/stripeReconciliationRead.ts
scripts/finance-reconciliation-plan.mjs
tests/block2-admin-portal.test.mjs
tests/direct-cost-coverage.test.mjs
tests/provider-fee-evidence.test.mjs
tests/finance-reconciliation-review.test.mjs
tests/finance-reconciliation-patch.test.mjs
tests/runtime/finance-reconciliation-local.mjs
tests/fixtures/finance-reconciliation-local-proof.json
docs/GLOA_FINANCE_RECONCILIATION_PATCH_PROPOSAL.md
docs/GLOA_STRIPE_LIVE_RECONCILIATION_VERIFIED.md
docs/GLOA_FINANCE_RECONCILIATION_REVIEW.md
docs/GLOA_STRIPE_LIVE_DISCREPANCY_FINAL_REPORT.md
```

Die drei bereits vorgefundenen Annual-Teständerungen aus der 084-Prüfung wurden erhalten. Vorhandene Security-Berichte/084-Dateien und unrelated Dateien wurden nicht mit diesem Patch verändert oder gestagt. outputs enthält ausschließlich ignorierte lokale Hilfen, minimierte Evidence und Logs; kein Schlüsselwert darin gespeichert. .env.local bleibt ignoriert und ungetrackt. Ein Scan der 91 erzeugten öffentlichen Buildartefakte hat den READ-Key nicht gefunden.

**Reviewentscheidung:** Source-/Diagnosepatch und lokales Idempotenzmodell bereit zur Prüfung. Live-Nachverbuchung/automatischer Betrieb weiter gesperrt: Account-/Invoice-READ, historische Source Bridges und Perioden-/Tax-Freigabe, echte Writer-/Cron-/Syncstatusintegration sowie Freigabe des py_-Constraints stehen aus. Keine Buchungsfreigabe aus diesem Bericht ableiten.

### Erg?nzung: zweiter py_-Guard im tats?chlichen Fee-RPC

Auch `record_provider_fee_result_v1` pr?ft `p_charge_id` explizit auf ch_. Eine reine Constraint?nderung reicht deshalb nicht. Die sp?tere freizugebende DB-Korrektur muss zus?tzlich genau diesen Guard auf ch/py erweitern. Unten steht der aus unver?nderter 079 abgeleitete vollst?ndige Funktionsersatz: ausschlie?lich CREATE OR REPLACE und das Pr?fixpattern ?ndern sich. Bestehende Ownership, Grants und alle ?brigen Konflikt-/Betrags-/Lock-/Idempotenzpr?fungen m?ssen erhalten bleiben und vor/nach Anwendung read-only verglichen werden. Kein neuer PUBLIC-EXECUTE-Grant. Vor Anwendung die Production-Definition exakt gegen 079 vergleichen; bei Drift stoppen. Diese SQL steht nur im Reviewdokument, kein Remote-Aufruf und keine neue Migration.

```sql
create or replace function public.record_provider_fee_result_v1(p_evidence_id uuid,p_status text,p_payment_intent_id text default null,p_charge_id text default null,p_balance_transaction_id text default null,p_fee_cents integer default null,p_currency text default null,p_provider_transaction_at timestamptz default null,p_error_code text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.provider_fee_evidence; e public.financial_events; f public.financial_events; v_event uuid;
begin
 select * into r from public.provider_fee_evidence where id=p_evidence_id for update;
 if not found then raise exception 'fee_evidence_missing'; end if;
 select * into e from public.financial_events where id=r.income_event_id;
 if r.capture_status in ('checked','not_applicable') then
  if p_status=r.capture_status and (p_status='not_applicable' or (r.payment_intent_id=p_payment_intent_id and r.charge_id=p_charge_id and r.balance_transaction_id=p_balance_transaction_id and r.fee_cents=p_fee_cents and r.currency=p_currency and r.provider_transaction_at=p_provider_transaction_at)) then return pg_catalog.jsonb_build_object('result','already_recorded','fee_event_id',r.fee_event_id); end if;
  raise exception 'fee_evidence_conflict';
 end if;
 if p_status='unavailable_retryable' then
  if p_error_code is null or p_error_code not in ('provider_unavailable','correlation_missing','correlation_conflict','currency_mismatch','unsupported_provider_payment','evidence_write_failed') then raise exception 'fee_error_invalid'; end if;
  update public.provider_fee_evidence set capture_status=p_status,last_attempt_at=pg_catalog.now(),next_attempt_at=pg_catalog.now()+interval '1 hour',attempts=attempts+1,error_code=p_error_code where id=r.id;
  return pg_catalog.jsonb_build_object('result','retryable');
 end if;
 if p_status='not_applicable' then
  -- Trusted server must have re-read the EXACT stored paid invoice and
  -- verified paid_out_of_band. A missing PaymentIntent alone proves nothing.
  if r.invoice_id is null or r.payment_intent_id is not null or p_error_code is distinct from 'invoice_paid_out_of_band' then raise exception 'fee_not_applicable_unproven'; end if;
  update public.provider_fee_evidence set capture_status='not_applicable',provider='none',checked_at=pg_catalog.now(),last_attempt_at=pg_catalog.now(),attempts=attempts+1,error_code=p_error_code where id=r.id;
  return pg_catalog.jsonb_build_object('result','recorded');
 end if;
 if p_status is distinct from 'checked' or p_fee_cents is null or p_fee_cents<0 or p_currency is distinct from r.currency or p_provider_transaction_at is null
  or p_payment_intent_id is null or p_charge_id is null or p_balance_transaction_id is null
  or p_payment_intent_id !~ '^pi_[A-Za-z0-9_]{1,240}$' or p_charge_id !~ '^(ch|py)_[A-Za-z0-9_]{1,240}$' or p_balance_transaction_id !~ '^txn_[A-Za-z0-9_]{1,240}$'
  or (r.payment_intent_id is not null and r.payment_intent_id<>p_payment_intent_id) then raise exception 'fee_provider_result_invalid'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('fee:stripe:'||p_balance_transaction_id,0));
 if exists(select 1 from public.provider_fee_evidence where id<>r.id and (balance_transaction_id=p_balance_transaction_id or charge_id=p_charge_id or payment_intent_id=p_payment_intent_id)) then raise exception 'fee_provider_identity_conflict'; end if;
 if p_fee_cents>0 then
  -- Adopt an exactly matching legacy fee, never add a second cost for it.
  if (select count(*) from public.financial_events where kind='payment_fee' and external_reference=p_balance_transaction_id)>1 then raise exception 'fee_legacy_ambiguous'; end if;
  select * into f from public.financial_events where kind='payment_fee' and external_reference=p_balance_transaction_id;
  if found then
   if f.order_id is distinct from e.order_id or f.annual_plan_id is distinct from e.annual_plan_id or f.b2b_agreement_id is distinct from e.b2b_agreement_id or f.gross_cents<>p_fee_cents or f.currency<>r.currency or f.channel<>e.channel or f.direction<>'outflow' then raise exception 'fee_legacy_conflict'; end if;
   v_event:=f.id;
  else
   insert into public.financial_events(occurred_on,occurred_on_basis,kind,direction,gross_cents,currency,channel,order_id,annual_plan_id,b2b_agreement_id,external_reference,operation_id)
   values(public.financial_event_berlin_date(p_provider_transaction_at),'event_date','payment_fee','outflow',p_fee_cents,r.currency,e.channel,e.order_id,e.annual_plan_id,e.b2b_agreement_id,p_balance_transaction_id,r.id) returning id into v_event;
  end if;
 elsif exists(select 1 from public.financial_events where kind='payment_fee' and external_reference=p_balance_transaction_id) then raise exception 'fee_zero_legacy_conflict'; end if;
 update public.provider_fee_evidence set capture_status='checked',payment_intent_id=p_payment_intent_id,charge_id=p_charge_id,balance_transaction_id=p_balance_transaction_id,fee_cents=p_fee_cents,provider_transaction_at=p_provider_transaction_at,checked_at=pg_catalog.now(),last_attempt_at=pg_catalog.now(),attempts=attempts+1,error_code=null,fee_event_id=v_event where id=r.id;
 return pg_catalog.jsonb_build_object('result','recorded','fee_event_id',v_event);
end$$;
```

Letzter PostgreSQL-Lauf: 14 PASS, stopped=true, dataRemoved=true; Evidence siehe aktualisierte Fixture. Fr?here Zusatzl?ufe scheiterten am lokalen Testgenerator-Delimiter, nicht an einem Application-Regressionstest; korrigiert und erfolgreich wiederholt. Keine verbleibende disposable Instanz aus diesen L?ufen. Der Original-RPC-Guard wurde auch Production-read-only best?tigt: Owner postgres, SECURITY DEFINER, prosrc-MD5 395edde9c5e29d6926ce19ac9d32d873. Normalisierter Textvergleich zeigt ausschlie?lich abschlie?enden Zeilenumbruch als Unterschied zur Repositoryvorlage; keine fachliche Funktionsabweichung. Production-Preflight muss dennoch die tats?chliche Definition und Grants erneut gegenpr?fen.
