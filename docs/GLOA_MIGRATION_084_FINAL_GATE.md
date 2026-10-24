# GLOA Migration 084 — Final Gate

Stand 23.10.2026; Basis `6db7c37b693991617a392b26c5937114879a8f75`.

**Gesamtstatus: BLOCKED für Push/Deployment bzw. Production-Ausführung. SQL-Gate: READY.** Die NULL-Fehler sind korrigiert und real lokal negativ getestet. Vercel-Git-/Build-/Deploy-Hook-Einstellungen konnten mangels Zugriff auf goal10 nicht verifiziert werden. Kein Push und keine Ausführung von 084 fanden statt.

## 1. Minimale Korrektur

Unverändert: [084](../supabase/migrations/084_restrict_order_number_execute.sql), SHA-256 `178f6b5f88ef4fcbc4ebf624d3facd5a9f61b3f630b14fd504f49ad8d818a04f`.

```sql
begin;
revoke execute on function public.generate_order_number()
  from public, anon, authenticated;
commit;
```

Alle historischen Migrationen 001–083 bleiben bytegleich. Der vorhandene Nachweis über 37 echte PostgreSQL-Checks und die autorisierten Checkout-/Abo-/Jahresplanpfade aus [DATABASE VERIFIED](GLOA_SUPABASE_SECURITY_DATABASE_VERIFIED.md) wird wiederverwendet. Kein vollständiger Replay wurde neu gestartet.

## 2. Behobene Fail-closed-Fehler

Geändert wurden nur die lesenden [Preflight](../supabase/preflight/084_restrict_order_number_execute_preflight.sql)/[Postcheck](../supabase/postcheck/084_restrict_order_number_execute_postcheck.sql)-Dateien:

- Aggregierte Sicherheitsprädikate werden mit `(predicate) IS TRUE` ausgewertet: NULL zählt als false.
- Einzelzeilen melden nur bei `passed IS TRUE` PASS.
- SUMMARY verlangt die erwartete Zeilenzahl und `bool_and(passed IS TRUE) IS TRUE`. Auch leere Ergebnismengen werden abgelehnt.
- Der Postcheck prüft zusätzlich den äußeren Writer-Suchpfad und die unveränderte Helper-Definition samt MD5, Sprache, Rückgabetyp und Volatilität.

Der Preflight akzeptiert die ursprüngliche absichtlich zu korrigierende PUBLIC-Helper-ACL; andernfalls könnte er den vorgesehenen Ausgangszustand nicht freigeben. Unerwartetes Browser-EXECUTE auf dem äußeren Writer wird dort abgelehnt. Nachher muss der Postcheck PUBLIC und alle drei direkten API-Helper-EXECUTE-Rechte ablehnen, während Owner-/äußeres service_role-EXECUTE bestehen bleiben.

[PostgreSQL dokumentiert](https://www.postgresql.org/docs/17/functions-aggregate.html), dass bool_and NULL-Eingaben ignoriert. Deshalb reicht ein äußerer CASE allein nicht aus; die Bewertung jedes Eingabewerts wurde explizit gemacht.

## 3. Echter lokaler Nachweis ohne Migrationsausführung

Runner: [migration-084-gates-local.mjs](../tests/runtime/migration-084-gates-local.mjs).

Neue isolierte PostgreSQL-17.11-Instanz, **127.0.0.1:58517**, Datenbank **gloa_gate_71716d511a050c5c**, Datenverzeichnis **outputs/gate084-71716d511a050c5c/data**, gemäß [gespeichertem Nachweis](../tests/fixtures/migration-084-gates-local-proof.json). Vor jedem SQL-Schreibzugriff wurden Zieladresse, Port, Datenbank, Datenverzeichnis und Benutzer geprüft. Keine Production-/Staging-Verbindung, App-Credentials oder Provider.

Nur ein minimales Metadaten-Fixture wurde angelegt: Original-Helper aus 004, Sequenz, Order-Default und ein **niemals aufgerufener** äußerer RPC-Stub mit passender Signatur/Owner-/ACL-Konfiguration. Die postgres-Ownerrolle war hier wie in Production kein Superuser; die lokale Plattform-Bootstraprolle diente ausschließlich der Instanzerstellung und negativen Owner-Tests. Keine Auth-/Kundenkonten oder Bestellungen wurden erstellt.

**40/40 PostgreSQL-Gate-Assertions bestanden:**

- korrekter ursprünglicher Preflight-Zustand und korrekter restriktiver Postcheck-Zustand;
- NULL oder falscher Suchpfad von Helper und Writer;
- falscher Owner beider Funktionen;
- geänderter Helper-Source-Fingerprint;
- SECURITY INVOKER statt DEFINER;
- fehlender Helper, fehlender Writer und keinerlei Funktionszeilen;
- fehlendes Owner-EXECUTE und fehlendes service_role-Writer-EXECUTE;
- unerwartetes anon-EXECUTE auf dem Writer;
- nachträgliches direktes Helper-EXECUTE für PUBLIC/anon/authenticated/service_role;
- ausschließlich NULL-Prüfwerte und keine Prüfzeilen im tatsächlichen SUMMARY-SQL.

Ein erster Testlauf scheiterte nur an der Testauswertung von Windows-CRLF, obwohl der Positivfall SQL-seitig PASS meldete. Der Parser wurde korrigiert; der vollständige endgültige Lauf bestand. Keine Sicherheitsbedingung wurde abgeschwächt.

Danach wurde die **exakte korrigierte Preflight-Datei** auf Production in einer `BEGIN READ ONLY ... ROLLBACK`-Sitzung ausgeführt: **7 PASS, SUMMARY SAFE TO APPLY**. Das ist ausschließlich ein lesender Zustandsnachweis, keine Ausführungsfreigabe und keine Anwendung von 084. Ein erwartungsgemäß erst nach 084 erfolgreicher Production-Postcheck wurde nicht als bereits erfüllt behauptet.

**migrationExecuted=false; stopped=true; dataRemoved=true.** Es wurde keine Migration, insbesondere nicht 084, ausgeführt. Lokale DDL/ACL-Änderungen waren ausschließlich zurückgerollte Metadaten-Testfixtures. Rohprotokoll: outputs/gate084-71716d511a050c5c/result.json. Die neue Testinstanz wurde kontrolliert gestoppt und ihr exakt verifiziertes Datenverzeichnis entfernt. Der dauerhafte Nachweis enthält SHA-256 beider geprüften Skripte.

## 4. Push-Automationen: aktueller Befund

Der ausdrücklich autorisierte gespeicherte GitHub-Account **gloamatcha-dev** wurde aktiviert; `gh api user` bestätigte den Account. Keine Token-/Scope-Erweiterung, kein Hook-/Secret-/Deployment-Settings-Wechsel.

| Prüfung | Ergebnis |
|---|---|
| GitHub Actions | 0 Workflows |
| Repository-Webhooks mit gloamatcha-dev | leere Liste; Leseberechtigung jetzt vorhanden |
| Repository Build/Install/Vite | kein SQL-Migrationsaufruf gefunden |
| Sites-Vite-Buildplugin | kopiert Hosting-/Drizzle-Metadaten; führt selbst keine SQL-Migration aus |
| Vercel goal10 / variante-1 | **403 forbidden**, Zugriff auf Team-Scope fehlt |
| Vercel Git-Integration, Build-Overrides, Deploy Hooks / weitere Integrationen | nicht verifizierbar |

Ein erster Webhook-Aufruf scheiterte an Windows-Argumentquotierung, nicht an der API-Berechtigung; der korrigierte, gefilterte Aufruf ergab eindeutig `[]`. Der frühere admin:repo_hook-Blocker des anderen Accounts ist damit für diese Repository-Abfrage erledigt.

Die leere Actions-/Webhook-Liste schließt GitHub-Apps oder externe Vercel-/Supabase-Automationen nicht vollständig aus. Es wurde kein Zugriff neu autorisiert und keine Einstellung verändert. Eine vorhandene Vercel-CLI war lokal nicht verfügbar; es wurde keine Software installiert. Benötigt wird eine autorisierte lesende Prüfung der goal10-Projekteinstellungen, inklusive aller Build-/Installbefehle, Git-Verknüpfungen, Deploy Hooks und Supabase-/Migrationsintegrationen.

## 5. Tests und Änderungen

- Kombinierter Security-/Finance-/Checkout-/Annual-/Subscription-Regressionslauf: **307 bestanden, 0 fehlgeschlagen**.
- Offline-Checkout: **19 bestanden, 0 fehlgeschlagen**.
- Neue echte PostgreSQL-Gates: **40 bestanden**. Insgesamt **366 aktuelle Checks**, ohne historische Nachweise erneut zu zählen.
- TypeScript, gezieltes ESLint, Migration-Security-Checker und git diff --check bestanden.
- Vier zunächst fehlgeschlagene Annual-Grenztests erwarteten pauschal 83 SQL-Dateien. Sie nehmen jetzt ausschließlich die bereits separat geprüfte 084 aus ihrer historischen 001–083-Betrachtung heraus. Unbekannte weitere Migrationen bleiben sichtbar und würden weiterhin scheitern. Alle fachlichen Assertions blieben bestehen. Das waren veraltete Inventarannahmen, keine neu gebrochenen Settlement-Funktionen.

In diesem Auftrag geänderte/neu angelegte Release-Dateien:

1. supabase/preflight/084_restrict_order_number_execute_preflight.sql
2. supabase/postcheck/084_restrict_order_number_execute_postcheck.sql
3. tests/runtime/migration-084-gates-local.mjs
4. tests/fixtures/migration-084-gates-local-proof.json
5. tests/finance-reconciliation-review.test.mjs
6. tests/annual-plan-maintenance.test.mjs
7. tests/annual-plan-refund.test.mjs
8. tests/annual-plan-webhook.test.mjs
9. docs/GLOA_MIGRATION_084_FINAL_GATE.md
10. docs/GLOA_FINANCE_RECONCILIATION_REVIEW.md

Bereits vorher vorhandene untracked Audit-/Migrations-/Testdateien bleiben erhalten. Unter outputs liegen ignorierte lokale Logs/Audithilfen; sie sind keine Release-Dateien. Keine Änderungen an App-Geschäftslogik, finanziellen Datensätzen oder 084 selbst. Kein Staging/Commit/Push/Deployment.

## 6. Verbleibende Freigaben

SQL-Gates sind lokal bereit. Gesamtfreigabe bleibt BLOCKED bis zur Vercel-/externen Automationsprüfung. Die spätere Production-Ausführung bleibt separat freigabepflichtig: Backup/Recovery bestätigen, unbekannte direkte Helper-Aufrufer prüfen, korrigierten read-only Preflight auf dem exakt verifizierten Ziel ausführen und erst nach Genehmigung ausschließlich die geprüfte 084 anwenden. Kein db push, Remote-Reset, History-Repair oder Replay 001–083. Die fehlende Anwendungsmigrationshistorie wird nicht durch Auth-/Realtime-/Storage-Tracker ersetzt.

Production wurde in diesem Auftrag ausschließlich mit Metadaten- und Finance-SELECTs gelesen. Keine SQL-Migration ausgeführt. STOP FÜR REVIEW.
