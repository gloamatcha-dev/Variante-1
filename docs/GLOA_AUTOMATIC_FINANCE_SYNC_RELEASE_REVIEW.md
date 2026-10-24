# GLOA FINANCE — AUTOMATIC RECONCILIATION PATCH READY

> Gemeinsames abschließendes Gate: [FINAL RELEASE GATE](GLOA_AUTOMATIC_FINANCE_FINAL_RELEASE_GATE.md). 001–083 → 084 → 085 wurden inzwischen gemeinsam lokal getestet. Die dortige Reihenfolge und aktuellen Betriebsblocker sind für den kontrollierten Release maßgeblich.


Stand: 24.10.2026. Ausgangsbasis `6db7c37b693991617a392b26c5937114879a8f75` unverändert. **Source lokal implementiert und geprüft; nicht live aktiviert. STOP FOR FINAL REVIEW.**

Dieser Bericht setzt die bisherigen Finance-Berichte fort. Deren frühere Aussagen „DB-Writer/periodischer Job noch nicht implementiert“ sind durch den hier dokumentierten Stand ersetzt. Frühere Beobachtungen und Freigabegrenzen bleiben erhalten.

## Implementierter Ablauf

Die bestehenden Echtzeit-Webhook-Handler bleiben bestehen. Ein unabhängiger, authentifizierter Server-Cron liest Stripe ausschließlich mit `STRIPE_RECONCILIATION_READ_KEY`. Er prüft die konfigurierte GLOA-Accountbindung `acct_1U6B3ODI76FH9qsq` anhand derselben bekannten LIVE-Zahlung, liest paginiert PaymentIntents, Charges, Refunds, Balance Transactions und Payouts und löst Invoice Payments anhand gespeicherter Invoice-IDs auf. `GET /v1/account`, Connect-Rechte, Betragssuche und der zahlungsfähige Stripe-Key werden dafür nicht verwendet.

Discovery-Seiten und Cursor werden dauerhaft gespeichert. Vor einer Buchung werden PaymentIntent, Charge, eigene Balance Transaction und vollständige Refundliste erneut gelesen. Späte Captures/Refunds werden auch über die Balance-Transaction-Referenz gefunden, wenn die ursprüngliche Zahlung außerhalb des Scanfensters liegt. Nicht finale, unbekannte oder nicht eindeutig einem GLOA-Parent zugeordnete Objekte werden als Abweichung gespeichert, niemals geraten oder ignoriert. Fehlgeschlagene Payouts und ihre Gegenbewegung erzeugen keine Einnahme.

`finance_sync_stage_v1` speichert die belegte Quelle dauerhaft. **`finance_sync_record_v1` führt Geldbuchung, Providerbeleg, geschützten Refundstatus und Source-/Ledger-Verknüpfung in einer PostgreSQL-Transaktion aus.** Die vorbereitende Queue ist absichtlich eine separate, wiederaufnehmbare Transaktion. Account-/Quellschlüssel, eindeutige Fee-Balance-Transaction, bestehende Income-Constraints, Parent-/Job-Zeilensperren, Advisory Locks und Lease-Fencing verhindern doppelte Effekte. Bei verlorenem Commit-Response folgt ausschließlich eine autoritative Source-Leseprüfung; kein sofortiger zweiter Schreibversuch. Ein späterer Job kann denselben Schlüssel idempotent verarbeiten.

Lease: zwei Minuten, bei bestätigten Checkpoints verlängert. Eine abgelaufene Lease erhält bei Wiederaufnahme ein neues Token; alte Worker können nicht weiter schreiben. Ein Job umfasst maximal sieben Tage, Folgefenster überlappen um zwei Tage. Pro Aufruf werden maximal 16 Fenster innerhalb eines 45-Sekunden-Budgets bearbeitet; danach wird ein dauerhafter Fortsetzungspunkt gespeichert. Wiederholung erfolgt beim nächsten authentifizierten Aufruf. Kein unbegrenzter Loop, keine clientseitige Steuerung und kein Stripe-Schreibaufruf.

## Datenbankänderung 085

`085_automatic_finance_reconciliation.sql` wurde mit `supabase migration new` vorbereitet und in das numerische Repository-Schema eingeordnet. 084 bleibt reserviert und byteidentisch. 086 wurde nicht angelegt. SQL-SHA256:

`8fc5da7be846857434ffc7b5843e7c6a04120e9b89cdf38346fdd62cc7b134ff`

085 enthält sieben RLS-geschützte interne Tabellen: Konfiguration, Perioden, Jobs, Quellen, Freigaben, Warnungen und Abweichungen. Browserrollen erhalten keine Tabellen-/RPC-Rechte. `service_role` erhält die benötigten Lese-/RPC-Rechte, **keine direkten Tabellen-Schreibrechte und keine historischen Freigaberechte**. 19 neue Funktionen verwenden SECURITY DEFINER mit leerem search_path; fünf interne Helfer sind auch für service_role nicht direkt ausführbar. Konfiguration und Freigaben bleiben bei Installation leer: keine automatische Aktivierung oder historische Buchung.

Die beiden bestätigten `py_`-Probleme sind gezielt behoben: die bestehende Provider-Fee-ID-Constraint und der ID-Guard von `record_provider_fee_result_v1` akzeptieren `ch_` **und** `py_`. Sonstige Businesslogik/ACL dieses bestehenden RPC bleibt erhalten. Der Reader akzeptiert Balance-Transaction-Typ `payment` nur mit `reporting_category=charge`; Betrag, Währung, Fee, Net und Source müssen zusammenpassen.

Neue interne Buchungshilfen bewahren die bestehenden Order-/Annual-Tax-Snapshots und Refund-/Creator-Commission-Verträge; sie erlauben nur die ausdrücklich freigegebene spätere Buchungsperiode, während das Originaldatum separat erhalten bleibt. Unbekannte Refundsteuer bleibt NULL. Die bestehenden ursprünglichen Zahlungs-/Refund-Tax-RPCs werden nicht ersetzt. Automatisch belegte Usage-Ausgaben sind gegen nachträgliches Überschreiben/Löschen geschützt; unbekannte VAT wird nicht als null Prozent interpretiert. Bestehende manuelle Fee-Buchungen führen bei möglicher Überschneidung zur Prüfung, nicht zu einer zweiten Gebühr.

## Historie und Perioden

Keine historische Production-Buchung wurde angelegt. Der ausführbare Pfad verlangt für Vorgänge vor `repair_from` eine separat erteilte Owner-Freigabe der **exakten** kanonischen Source-Payload. `payload_md5` muss aus der tatsächlich gestagten PostgreSQL-JSONB-Payload gelesen werden; kein handgebauter JavaScript-Hash. Freigaben sind kein Browser-/service_role-Schreibrecht.

Unbekannte Perioden bleiben gesperrt. Geschlossene Perioden werden nicht wieder geöffnet. Eine genehmigte Korrektur braucht ein ausdrücklich freigegebenes offenes Buchungsdatum; ursprüngliches Stripe-Datum, Source-ID und spätere Buchung bleiben nachvollziehbar. Optionales automatisches Öffnen des aktuellen Monats ist standardmäßig aus und überschreibt niemals einen vorhandenen geschlossenen Monat.

Die vollständige belegbezogene Review-Datei ist [historical-2026-09-10.json](finance-reconciliation/historical-2026-09-10.json). Sie enthält 8 bestehende Ledger-Verknüpfungen und **18 fehlende Kandidaten: 4 Zahlungen, 4 Refunds, 8 Zahlungsgebühren, 2 Usage Fees** mit PaymentIntent-/Refund-/Balance-Transaction-IDs, Currency, Originaldatum und Centbetrag. Sie ist kein SQL-Import, erzeugt keine Freigaben und enthält keine Kundendaten oder Credentials. Vor einer späteren Ausführung müssen Quellen und Ledgerstand erneut gelesen und gegen diese exakten IDs geprüft werden.

| Stripe-Bewegungen nach Originaldatum | September 2026 | Oktober 2026, bisheriger Prüfstand |
|---|---:|---:|
| Zahlungen | 545,92 EUR | 295,35 EUR |
| erfolgreiche Refunds | 293,85 EUR | 547,42 EUR |
| Zahlungsgebühren | 17,72 EUR | 10,22 EUR |
| zusätzliche Usage Fees | 0,15 EUR | 0,15 EUR |

Alle acht Zahlungen, einschließlich dreier Jahrespläne (232,68 EUR und zweimal 252,07 EUR) sowie fünfmal 20,89 EUR, wurden vollständig erstattet. Der September-29-Jahresplan mit Refund am Oktober 2 erklärt die fehlenden 252,07 EUR Oktober-Refunds. Summe Zahlungen/Refunds jeweils 841,27 EUR; Processing Fees 27,94 EUR plus Usage Fees 0,30 EUR. Der fehlgeschlagene Payout über 17,87 EUR zählt nicht als empfangen. Processing Fees wurden laut den verifizierten Balance Transactions nicht rückerstattet; es wird kein zusätzlicher Refund oder Payout ausgelöst.

Ursache der historischen Lücken: 072 importiert ausdrücklich keine Historie; ein verarbeiteter Webhook-Marker beweist keine vorhandene Ledgerbuchung. Der bisherige Fee-Capture-Cutoff und die beiden `py_`-Guards verhinderten außerdem die Gebührenerfassung. Ein bestimmter historischer Deploymentstand als alleiniger Auslöser ist nicht nachgewiesen. Die neue unabhängige Prüfung verlässt sich nicht auf Webhook-Marker.

## Scheduler und Monitoring

Vorgesehene Frequenz: **täglich 05:40 UTC** (`40 5 * * *`), im Berliner Sommer 07:40, im Winter 06:40. Bestehender Notifications-/Annual-Cron um 05:20 UTC bleibt unverändert. Vercel unterstützt täglich auf allen Plänen; Hobby erlaubt nur tägliche Ausführung mit ungenauer Startzeit innerhalb der Stunde. Vercel wiederholt fehlgeschlagene Cronaufrufe nicht selbst. Der Anwendungsjob wiederholt offene Vorgänge beim nächsten Tageslauf. Echtzeit-Webhooks bleiben der schnelle Primärpfad. Bei großem Backlog oder wiederholter Zeitüberschreitung sind mehrere Tagesläufe nötig; keine unbelegte Echtzeit-Reparaturgarantie.

`CRON_SECRET` wird serverseitig zeitkonstant geprüft, bevor Enable-Flag, Key oder DB verwendet werden. `FINANCE_RECONCILIATION_ENABLED=true` und explizite aktive DB-Konfiguration sind beide erforderlich. Nitro/Vinext erzeugt für die Route eine eigene Vercel-Funktion mit `maxDuration=60`; das alleinige Next-ähnliche Route-Export wäre für diesen Stack kein ausreichender Nachweis gewesen.

Finance und Overview zeigen letzten erfolgreichen Abgleich, Zustand, geprüfte Abdeckung, fehlende Zahlungen/Refunds/Fees, offene Abweichungen, Wiederholungsversuche, dauerhafte Fehler und offene Warnungen. Die read-only Detailansicht zeigt belegbezogene offene Aufgaben. Unbekannte, über 36 Stunden alte, unvollständige oder erst bis zu einem alten Nachholfenster geprüfte Daten dürfen nicht „vollständig“ heißen. Unbekannte Kosten bleiben unbekannt; Deckungsbeitrag/Ergebnis bleiben bei unbestätigter Stripe-Abdeckung gesperrt.

Eine getrennte Anzeige zeigt verifizierte Stripe-Cashbeträge nach Originaldatum sowie genehmigte spätere Periodenkorrekturen. Diese Beträge werden **nicht nochmals ins Ledgerergebnis addiert**. So bleibt eine Oktober-Erstattung sichtbar, auch wenn ihre genehmigte Nachbuchung später erfolgt. Netto/Steuer, Direct Costs und allgemeine Ausgaben behalten ihre eigenen Vollständigkeitsprüfungen.

Dauerhafte Warnungen werden pro Account/Tag dedupliziert und über einen geleasten Resend-Sender bestätigt; ein fehlgeschlagener Versand bleibt wiederholbar. Benötigt werden `FINANCE_ALERT_EMAIL`, `FINANCE_ALERT_FROM` und der vorhandene serverseitige `RESEND_API_KEY`. Der Versand wurde ausschließlich gemockt. Für einen vollständigen Datenbank-/Scheduler-Ausfall kann keine DB-basierte Benachrichtigung garantiert werden: externes Cron-/HTTP-Fehlermonitoring ist vor Livegang einzurichten bzw. zu bestätigen; die Adminanzeige fällt währenddessen auf unbekannt/veraltet zurück.

Offizielle Grundlagen: [Vercel Cron Limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Cron-Verhalten und Wiederholungen](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [Funktionsdauer](https://vercel.com/docs/functions/configuring-functions/duration), [Stripe Balance Transactions](https://docs.stripe.com/api/balance_transactions/object). Tatsächlicher Teamplan und Production-Build-Einstellungen konnten über den Vercel-Connector für goal10/variante-1 wegen **403** nicht gelesen werden. Kein Änderungs- oder Deploymentversuch.

## Prüfungen und Nachweise

- PostgreSQL 17.11: **46 echte Full-Schema-Financeprüfungen bestanden**. Ursprüngliche Migrationen 001–083 byteidentisch eingespielt, zusätzlich nur 085. 084 niemals ausgeführt. Historischer lokaler Auth-/075-ACL-Bootstrap unverändert aus dem geprüften Verfahren; simulierte übermäßige ACLs nach 075 vollständig entfernt.
- Read-only 085-Preflight: 8/8 PASS. Read-only Installations-Postcheck: 7/7 PASS. Beide innerhalb READ ONLY getestet; fehlende/NULL-Bedingungen werden explizit abgelehnt.
- Echte DB-Tests: fehlender Payment-/Refund-Webhook, bestehende Ledger-Adoption, Doppellieferung, konkurrierende neue Quelle, verlorene/abgebrochene Transaktion, Crashretry, Lease-Fencing, Closed Period/Freigabe, exakte spätere Korrektur, Invoice-/Annual-Pfade, Commission-Reversal, Refund-Delivery-Sperre, `py_`/`ch_`, Usage-Fee-Idempotenz und Unveränderlichkeit, keine Browserrechte, keine service_role-Freigabe, keine Payoutbuchung.
- **474 Source-/Mocktests bestanden**, 0 Fehler/übersprungen: Finance, Worker, Monitoring/Alerts, Migration-Security, Webhook/Checkout-Settlement, Invoice, Annual und Product Manager. Separat **19 Offline-Checkouttests bestanden**. Keine echten Provideraktionen oder Kundenorders.
- TypeScript `--noEmit`: PASS. Targeted ESLint (Source, Runtime-/DB-Helfer und betroffene Regressionstests): PASS. `git diff --check`: PASS.
- Vercel-Ziel-Production-Build: PASS. Erzeugte Nitro-Route und 60-Sekunden-Funktionskonfiguration geprüft; **gebaute** Route antwortet unauthentifiziert 401 und bei authentifiziertem deaktiviertem Job 200/disabled. 91 statische Dateien geprüft: keine privilegierten lokalen Keywerte im Browserbundle.
- Exakte SQL-/ACL-/Regressionsnachweise: [finance-sync-database-proof.json](../tests/fixtures/finance-sync-database-proof.json), [Reviewvertrag](../security/migrations/085_automatic_finance_reconciliation.sql.review.json), [Katalogmetadaten](../security/migrations/085_automatic_finance_reconciliation.sql.metadata.json). Migration-Security-Checker akzeptiert keine ungeprüfte Dateiänderung.
- Der neue disposable Cluster wurde gestoppt und ausschließlich dessen Data-Verzeichnis gelöscht. Lokale Logs unter `outputs/finance-sync-local-4fd1f8c27408d707/` bleiben als ignorierte Nachweise erhalten. Kein gemeinsamer Cluster zurückgesetzt.

Die ersten umfassenden Regressionen enthielten sechs alte Bestandsannahmen „nur ein Cron/83 Dateien“. Diese Tests wurden auf exakt die zwei geprüften neuen Migrationsnamen und die konkrete zusätzliche Finance-Cronroute angepasst, ohne weitere neue Migrationen/Routen pauschal zu erlauben. Die endgültige Gruppe besteht vollständig. Keine Businesslogik-Regression wurde durch Entfernen einer Prüfung verdeckt.

## Exakte Source-Dateien dieses Finance-Patches

Bereits vorhandene Finance-Arbeit wurde weiterverwendet; die folgende Liste ist der zusammengehörige lokale Reviewumfang, kein Staging- oder Commitauftrag. Historische Sicherheitsberichte/084 sowie fremde Bilder, examples, .claude und outputs gehören nicht zu diesem Releaseumfang.

```text
app/AdminFinanceSyncStatus.tsx
app/AdminPortalShared.tsx
app/api/admin/finance/route.ts
app/api/cron/finance-reconciliation/route.ts
lib/adminPortalFinance.ts
lib/adminPortalFinanceRead.ts
lib/automaticFinanceSync.ts
lib/financeEvidenceSynchronization.ts
lib/financeReconciliation.ts
lib/financeReconciliationEvidence.ts
lib/financeReconciliationWorker.ts
lib/financeSourceCoverage.ts
lib/financeSyncMonitoring.ts
lib/financeSyncServer.ts
lib/providerFeeCapture.ts
lib/stripeReconciliationClient.ts
lib/stripeReconciliationRead.ts
scripts/finance-reconciliation-plan.mjs
scripts/migration-security-check.mjs
supabase/migrations/085_automatic_finance_reconciliation.sql
supabase/preflight/085_automatic_finance_reconciliation_preflight.sql
supabase/postcheck/085_automatic_finance_reconciliation_postcheck.sql
security/migrations/085_automatic_finance_reconciliation.sql.review.json
security/migrations/085_automatic_finance_reconciliation.sql.metadata.json
tests/automatic-finance-sync.test.mjs
tests/finance-evidence-synchronization.test.mjs
tests/finance-reconciliation-patch.test.mjs
tests/finance-reconciliation-review.test.mjs
tests/fixtures/finance-reconciliation-local-proof.json
tests/fixtures/finance-sync-database-proof.json
tests/helpers/financeSyncDatabase.mjs
tests/runtime/finance-reconciliation-local.mjs
tests/runtime/finance-sync-database-local.mjs
tests/migration-security.test.mjs
tests/annual-plan-checkout.test.mjs
tests/annual-plan-maintenance.test.mjs
tests/annual-plan-refund.test.mjs
tests/annual-plan-webhook.test.mjs
tests/block2-admin-portal.test.mjs
tests/direct-cost-coverage.test.mjs
tests/provider-fee-evidence.test.mjs
vercel.json
vite.config.ts
docs/GLOA_AUTOMATIC_FINANCE_SYNC_RELEASE_REVIEW.md
docs/finance-reconciliation/historical-2026-09-10.json
docs/GLOA_FINANCE_RECONCILIATION_PATCH_PROPOSAL.md
docs/GLOA_STRIPE_READ_PERMISSION_CORRECTION.md
```

## Verbleibende Production-Gates und sicheres Vorgehen

1. Source-/SQL-/Buchungsperiodenreview separat freigeben. Keinerlei Freigabe wurde durch diese Vorbereitung vorweggenommen. Aktuellen DB-Stand, Sicherung/PITR und Wiederherstellungsverantwortung bestätigen. 085 unabhängig von der gesonderten 084-Freigabe behandeln.
2. Production-Preflight ausschließlich lesend ausführen; bekannte Originalfunktions-Fingerprints, Owner postgres, SECURITY DEFINER/search_path und Append-only/RLS bestätigen. Ergänzend alle abhängigen vorhandenen RPCs/Constraints mit den lokal geprüften Migrationsverträgen vergleichen. Bei Abweichung stoppen. Unter dem freigegebenen postgres-Ausführungsaccount arbeiten.
3. Weil keine standardmäßige Production-Migrationshistorie nachgewiesen ist: **kein `supabase db push`, kein Repair/Reset, kein historischer Replay und keine automatische Ausführung von 084**. Erst nach expliziter DB-Änderungsfreigabe exakt die geprüfte 085-Transaktion direkt über den kontrollierten SQL-Ausführungsweg anwenden. Exakten SHA, Ausführer, Uhrzeit, Pre-/Postcheck und Ergebnis als neues Deploymentprotokoll speichern; keine historischen Migrationszeilen erfinden.
4. Read-only Postcheck unmittelbar nach leerer Installation ausführen, bevor Konfiguration angelegt wird. Alte Ledger-/Order-/Annual-Zeilen unverändert bestätigen. Bei Fehler nicht aktivieren. Kein Remote-Schritt wurde hier ausgeführt.
5. Vercel goal10/variante-1, Plan, Git-/Buildautomation und erzeugte Cronroute tatsächlich prüfen (403-Zugang fehlt). Erst danach separat Source-Release/Deployment freigeben; zunächst Enable-Flag aus. CRON_SECRET, READ-Key und Alertempfänger/-absender serverseitig provisionieren, nie in Browservariablen. Externes Failure-Monitoring und sichere nichtkommerzielle Cron-/Alert-Smokes vereinbaren.
6. Aktuellen Owner anhand UUID `75f838b9-f393-4e52-b8b0-70c118df8ed1`, exakter Email `valmira.hajzeri@gloamatcha.com` und aktivem Ownerstatus lesend prüfen. Für dieses Konto und den bestätigten Account eine separat genehmigte Konfiguration anlegen: Scanbeginn September 1 (Berlin), **repair_from auf Aktivierungszeitpunkt**, bekannte PI/23268, aktuelle Buchungsperiode ausdrücklich offen. Automatisches Öffnen zukünftiger aktueller Monate nur nach ausdrücklicher Periodenpolicy aktivieren. Vorhandene geschlossene Monate bleiben geschlossen.
7. Mit noch gesperrtem historischem Backfill Discovery/Review laufen lassen; bekannte 8/18-Zuordnung und Cashsummen bestätigen. Warnungszustellung prüfen. Erst anschließend aktiven Automatikbetrieb für eindeutig belegte neue offene Vorgänge freigeben. Unbekannte Quellen, B2B-/extern nicht eindeutig korrelierbare Zahlungen, manuelle Gebührendoppelungen und Steuersachverhalte bleiben sichtbare Aufgaben.
8. **Separat** genau die 18 historisch belegten Korrekturen nach erneutem READ-Abgleich und fachlicher Periodenentscheidung genehmigen. Pro Quelle echte gestagte Payload/MD5/Owner/Grund/Buchungsdatum dokumentieren. Ein geschlossener September/Oktober wird nicht rückwirkend geändert. Worker übernimmt genehmigte Aufgaben idempotent beim nächsten Lauf. Cash- und Ledgerdaten anschließend getrennt nachweisen.
9. Betrieb: nächste Tagesausführung, Lease-Recovery, neue fehlende Webhook-Effekte, Alarmzustellung und 36-Stunden-Stale-Warnung beobachten. Bestehende Kundenrechte und Delivery-Sperren bleiben verbindlich; keine tatsächliche Kundenorder, Zahlung oder Refund als Smoke erzeugen.

Rollback/Incident: zuerst Enable-Flag deaktivieren und DB-Konfiguration unter kontrollierter Sperre deaktivieren; laufende Transaktionen/Lease beachten. Queues, Quellen und Finanzereignisse erhalten. Keine zurückwirkende Löschung, kein automatisches Zurücksetzen von Refund-/Planstatus, kein Restore über zwischenzeitliche Kundendaten. Bereits verbuchte Fehler nur über separat genehmigte Forward-Korrekturen beheben. Nach echten `py_`-Belegen nicht blind zur alten `ch_`-Constraint zurückkehren. Unbenutzte additive Tabellen dürfen für Analyse bestehen bleiben; kein automatisches Down-Migrationsskript.

**Production ist noch nicht automatisch synchronisiert.** Erforderlich bleiben DB-/Source-/Aktivierungsfreigabe, tatsächliche Vercel-Konfigurationsprüfung, Server-/Alarmkonfiguration sowie die gesonderte historische Freigabe. Kein Production-/Staging-Schreibzugriff, Stripe-Schreibaufruf, Versand, Commit, Push oder Deployment erfolgte.
