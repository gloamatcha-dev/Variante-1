# GLOA SUPABASE SECURITY — DATABASE VERIFIED

Spätere Source-Releaseprüfung: **Release vor Commit/Push gestoppt**, weil die Preflight-/Postcheck-Aggregate NULL nicht sicher abweisen und das GitHub-Webhook-Inventar nicht lesbar ist. Siehe [Source Release Review](GLOA_MIGRATION_084_SOURCE_RELEASE_REVIEW.md). Der unten dokumentierte positive lokale Datenbanknachweis bleibt bestehen; er deckte diese negativen Prüfskriptfälle nicht ab.

Abschluss am 23.10.2026. Unveränderter Anwendungsstand: `6db7c37b693991617a392b26c5937114879a8f75`.

**001–083 unverändert erfolgreich eingespielt. Sicherheitskorrektur und konkrete Migration 084 lokal mit PostgreSQL 17.11 verifiziert. Keine Remote-Ausführung. Freigabe der Production-Migration steht aus.**

Dieser Bericht ersetzt die offenen lokalen Blocker in [Local Validation](GLOA_SUPABASE_SECURITY_LOCAL_VALIDATION.md) und [Bootstrap Validation](GLOA_SUPABASE_SECURITY_BOOTSTRAP_VALIDATION.md). Der [ursprüngliche Vorschlag](GLOA_SUPABASE_SECURITY_PATCH_PROPOSAL.md) bleibt die fachliche Herleitung; seine Formulierung „SQL nicht ausgeführt“ beschreibt den damaligen Stand. Die Korrektur wurde inzwischen ausschließlich lokal ausgeführt.

## 1. Fortsetzung und Prozessprüfung

Vorhandene Nachweise wurden wiederverwendet. Der gespeicherte Lauf `security-local-ec9677811aedc3d5` hatte bereits 83 Migrationen und 33 echte PostgreSQL-Prüfungen erfolgreich abgeschlossen. Seine Daten waren entfernt. Keine dieser erfolgreichen Prüfungen wurde als verloren behandelt.

Eine schreibgeschützte Windows-Prozessabfrage zeigte sieben PostgreSQL-Prozesse ohne zugängliche CommandLine. Sie waren keiner unserer Instanzen eindeutig zuzuordnen und wurden nicht angefasst. In unseren `outputs/security-local-*`-Verzeichnissen lag keine zurückgebliebene postmaster.pid. Die eindeutig identifizierten Instanzen dieses Vorgangs meldeten jeweils erfolgreichen Shutdown und entfernte Daten. Ältere Testverzeichnisse anderer Aufgaben wurden nicht gelöscht.

Nach Erstellen von 084 war ein zusätzlicher Lauf erforderlich, um die tatsächliche Datei sowie ihren Preflight/Postcheck zu prüfen. Der endgültige Lauf:

- PostgreSQL **17.11**, neu initialisierter Cluster;
- Adresse **127.0.0.1**, Port **62304**;
- Datenbank **gloa_security_b44b1781d9cec456**;
- Datenverzeichnis **outputs/security-local-b44b1781d9cec456/data**;
- vor jedem SQL-Schreibaufruf separate Prüfung von Adresse, Port, Datenbank, Datenverzeichnis, Benutzer und Serverversion;
- keine App-Env-Datei, Production-Zugangsdaten, Remote-URL oder Provider-Verbindung;
- nach Abschluss **clusterStopped=true**, **clusterDataRemoved=true**.

Rohprotokolle bleiben unter `outputs/security-local-b44b1781d9cec456/`. Das Datenverzeichnis einschließlich aller Testkonten und Bestellungen ist entfernt. Dauerhafter maschinenlesbarer Nachweis: [order-number-security-local-proof.json](../tests/fixtures/order-number-security-local-proof.json).

## 2. Historische Voraussetzung von 075

Die vollständige Originalmigration [075](../supabase/migrations/075_b2b_supply_agreement_acl_hardening.sql) verlangt vor ihrer Ausführung:

1. public.b2b_supply_agreements existiert als normale Tabelle mit RLS.
2. Mindestens eine der Rollen anon, authenticated, service_role besitzt TRUNCATE.
3. Keine dieser Rollen besitzt direkte INSERT/UPDATE/DELETE- oder spaltenbezogene INSERT/UPDATE-Rechte.

Ohne historische Default-Grants liegt ein frischer PostgreSQL-Cluster bereits beim zweiten Punkt im gehärteten Zustand. Daher die frühere Meldung „already hardened; DO NOT REAPPLY“. Das ist eine historische Starting-State-Annahme, keine fehlende Checkout-Berechtigung.

Die Nachbedingungen von 075: keine API-INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER-Rechte einschließlich relevanter Spaltenrechte; anon-SELECT verweigert; authenticated- und service_role-SELECT bleiben erhalten. Tabelle, ursprüngliche Own-Business-Policy, RLS und vertrauenswürdige RPCs bleiben bestehen. PostgreSQL-17-MAINTAIN gehört nicht zu den sechs von 075 entfernten Rechten; es wurde für diesen Fixture nicht vergeben.

### Belege und Abgrenzung

- [006](../supabase/migrations/006_b2b_supply.sql) erstellt die Tabelle, aktiviert RLS, definiert die Own-Business-SELECT-Policy und vergibt authenticated SELECT.
- [048](../supabase/migrations/048_service_role_read_grants.sql) ergänzt service_role SELECT ausdrücklich, ohne Schreib- oder TRUNCATE-Rechte zu vergeben.
- Die überschüssigen Rechte stammen aus damaligen Supabase-Erstellungsdefaults, nicht aus einer fachlichen Tabellenfreigabe in 006/048. [Offizielle Supabase-Dokumentation](https://supabase.com/docs/guides/api/securing-your-api) beschreibt diese rollenbezogenen Defaults und ihre nicht durch RLS begrenzten Restrechte.
- Die bestehende lokale historische Rollout-Datei `outputs/split-075-076-final-rollout.mjs`, Zeilen 10–16, modelliert bei 006 exakt TRUNCATE/REFERENCES/TRIGGER für anon/authenticated/service_role; ihr vorhandenes 075-Preflight-Protokoll meldet 0 FAIL / 7 PASS.
- Die Funktions-EXECUTE-Revocations in 059/060 sind keine Entfernung dieser Tabellenrechte. Keine vor 075 angewandte explizite Tabellenanweisung im geprüften Migrationsbestand beseitigt diesen T/F/G-Restzustand.
- Das ist ein belegtes historisches Replay-Modell für 075, keine neue Messung eines damaligen Production-Zustands. Broad-Default- und weitere Reparaturbefehle aus dem alten Harness wurden **nicht** übernommen.

### Exakter, ausschließlich lokaler ACL-Fixture

Unmittelbar vor 075, nach unverändertem Replay bis 074:

```sql
grant truncate, references, trigger
on table public.b2b_supply_agreements
to anon, authenticated, service_role;
```

Kein GRANT ALL, keine Default-Änderung, kein CRUD-Grant, keine weitere Tabelle. Diese Rechte waren lediglich der vorübergehende Gegenstand des historischen Hardening-Tests und wurden von **unverändertem 075 vollständig wieder entfernt**.

| Rolle | SELECT vor/nach 075 | T/F/G vor 075 | T/F/G nach 075 | Direkte I/U/D vor/nach |
|---|---|---|---|---|
| anon | nein/nein | ja | nein | nein/nein |
| authenticated | ja/ja | ja | nein | nein/nein |
| service_role | ja/ja | ja | nein | nein/nein |

Vollständiger vorhandener 075-Preflight: **0 FAIL / 7 PASS**. Vollständiger Postcheck: **0 FAIL / 5 PASS**. Keine Fixture-Berechtigung blieb bestehen. Anschließend liefen 076–083 unverändert erfolgreich durch.

## 3. Autorisierter 051-Fixture

Der Lauf reproduzierte zunächst die Originalfehlermeldung bei leerer auth.users und überprüfte den vollständigen Rollback. Dann wurde ausschließlich folgender synthetischer Benutzer eingefügt:

```sql
insert into auth.users(id,email)
values ('5f945ab0-91c3-4c93-b167-28a78e7eb25b','gloa.matcha@gmail.com');
```

Nur ID und autorisierte historische E-Mail wurden gesetzt. Keine Passwörter, Token, Login-Implementierung oder echten Kundendaten. Der vorhandene Signup-Trigger legte das normale Profil an. 051 selbst erzeugte den Admin-Owner; sämtliche Assertions blieben aktiv. Genau ein lokaler Auth-Benutzer/Owner wurde bestätigt. Es wurden keine zusätzlichen privilegierten Benutzer angelegt. Die Production-Identität Valmira wurde nicht geändert oder als Fixture verwendet.

## 4. Konkrete Migration 084

[084_restrict_order_number_execute.sql](../supabase/migrations/084_restrict_order_number_execute.sql):

```sql
begin;
revoke execute on function public.generate_order_number()
  from public, anon, authenticated;
commit;
```

Die Dateierstellung erfolgte mit installiertem Supabase CLI **2.115.0**, `supabase migration new restrict_order_number_execute`. Die CLI-Zeitstempeldatei wurde anschließend entsprechend den bestehenden dreistelligen Repository-Namen in 084 umbenannt. Vorher gab es keine 084. Kein CLI-Apply, db push, repair oder Remote-Migrationsbefehl wurde ausgeführt. Die beiläufig geänderte CLI-Updatecache-Datei wurde bytegenau auf HEAD zurückgesetzt.

Separate rein lesende Prüfdateien:

- [084-Preflight](../supabase/preflight/084_restrict_order_number_execute_preflight.sql): 7 PASS, **SAFE TO APPLY**;
- [084-Postcheck](../supabase/postcheck/084_restrict_order_number_execute_postcheck.sql): 4 PASS, **APPLIED CLEANLY**.

Der Preflight prüft genaue Signaturen ohne zusätzliche Overloads, postgres-Definer/Owner-Kontext, gepinnten Suchpfad, SQL/text/volatile-Eigenschaften, den normalisierten ursprünglichen Helper-Body-Hash, den bestehenden Order-Default, Sequenz-Owner und den weiterhin service-only erreichbaren äußeren Order-Writer. Der Postcheck prüft die effektive Sperre einschließlich PUBLIC und die erhaltene Owner-/RPC-Autorität. Keine Prüfung ruft Helper oder Sequenz auf. Die zusätzliche Production-Vergleichsprüfung von Bodies, Defaults und Sequenzzustand bleibt Teil des Freigabeverfahrens.

## 5. Reale Berechtigungen und Bestellungen

| Ausführungsrecht auf generate_order_number() | Vorher | Nachher |
|---|---|---|
| PUBLIC | ja | nein |
| anon | ja | nein |
| authenticated | ja | nein |
| service_role direkt | ja, geerbt | nein |
| postgres-Funktionsowner | ja | ja |

PUBLIC wurde über die ACL-Pseudo-Rolle mit grantee=0 geprüft; PUBLIC ist keine SET-ROLE-fähige Benutzerrolle. Vorherige direkte API-Rollenaufrufe reproduzierten die Schwachstelle ausschließlich lokal. Nachher scheiterten sie tatsächlich mit „permission denied for function generate_order_number“.

Der legitime Pfad funktioniert weiterhin: service_role → postgres-eigener SECURITY-DEFINER-Checkout-Writer → orders INSERT → unveränderter order_number DEFAULT → postgres-eigener Helper → Sequenz. service_role benötigt dafür weder direktes Helper-EXECUTE noch einen neuen Sequenz-Grant.

**37 reale PostgreSQL-Assertions bestanden**, darunter:

- 59 öffentliche Tabellen rekonstruiert, alle mit RLS; tatsächlicher postgres-Definer-Kontext geprüft.
- Je eine synthetische Einmal-, Abo- und Jahresplan-Lieferbestellung vor und nach der Korrektur: **sechs gültig nummerierte Bestellungen**, bei Wiederholung keine Duplikate.
- Abo: echte `activate_subscription_from_invoice`-Ausführung unter service_role, wiederholte Rechnung liefert denselben Attempt, Order-Writer liefert dieselbe Bestellung.
- Jahresplan: echte `fulfill_annual_plan_delivery`-Ausführung unter service_role; nach der Korrektur zweite Lieferung desselben zulässigen Plans. Wiederholung liefert already_fulfilled und dieselbe Bestellung.
- Vorherige Bestellzeilen bleiben bytegleich; eingefrorene Summen stimmen.
- Sequenzzustand bleibt durch die ACL-Korrektur unverändert; Sequenzdefinition bleibt unverändert. Normale spätere Testbestellungen verbrauchen erwartungsgemäß neue lokale Nummern.
- Gesamtsnapshot der Tabellen-/Spalten-ACLs, RLS-Policies, Funktionen und Default-ACLs bleibt bis auf die eine beabsichtigte Helper-ACL gleich.
- Authentifizierter Eigentümer liest seine sechs Bestellungen; anderer UID-Kontext sieht keine davon; anon-Kundendatenzugriff wird abgewiesen.
- Wiederholte Ausführung der konkreten Korrektur ist sicher und verändert weder Rechte erneut noch Sequenzzustand.

Testcode: [orderNumberSecurityDatabase.mjs](../tests/helpers/orderNumberSecurityDatabase.mjs), abgesichert durch [supabase-security-local.mjs](../tests/runtime/supabase-security-local.mjs). Es wurden synthetische als bezahlt markierte Datensätze und Provider-IDs verwendet. Kein Stripe-, E-Mail- oder sonstiger Provider wurde aufgerufen.

## 6. Regressionen, Setupfehler und Prüfumfang

**383 unabhängige Tests bestanden, 0 fehlgeschlagen, 0 übersprungen**, ohne doppelte Zählung wiederverwendeter Ergebnisse:

- 295 im gespeicherten kombinierten Lauf: Checkout-/Order-, Abo-/Jahresplan-, Admin- und damalige 35 Permission-/Checker-Prüfungen;
- vier zusätzliche Prüffälle für den eng begrenzten 084-Checker-Pfad; finales Permission-Paket: **39/39**;
- Product Manager: **65/65**;
- Offline-Checkout: **19/19**.

Zusammen mit den **37 echten PostgreSQL-Assertions: 420 bestandene Prüfungen**. Hinzu kommen die expliziten 075/084-Katalogchecks oben, die nicht nochmals in diese Zahl eingerechnet wurden.

TypeScript bestanden. Gezieltes ESLint für die neuen Skripte/Tests bestanden. Migrations-Security-Checker bestanden: **83 unveränderte historische Dateien, eine geprüfte neue Migration**. Der neue Checker-Pfad akzeptiert ausschließlich den exakten getesteten REVOKE in einer Transaktion; zusätzliche SQL-Anweisungen, falsche effektive Rechte oder fehlende Settlement-/Idempotenznachweise werden abgewiesen. Hashgebundene Review-/Metadaten liegen unter `security/migrations/084_restrict_order_number_execute.sql.*.json`. Das ist kein allgemeiner Freipass für Funktionen oder dynamisches SQL.

Frühere fehlgeschlagene Durchläufe waren **Harness-/Fixturefehler**, keine nachgewiesenen Anwendungsregressionen: fehlende NOT-NULL-Nettofelder eines synthetischen Aboartikels; ungeeignetes row_to_json auf einer Sequenz; Versuch eines zweiten aktiven Jahresplans für denselben Benutzer. Diese wurden in den Testdaten/-abfragen korrigiert, ohne Produktlogik, Constraints oder historische Migrationen zu ändern. Ein fehlerhaft gequoteter lokaler Bearbeitungsbefehl änderte keine Datei. Der endgültige Lauf mit der tatsächlichen 084-Datei war vollständig erfolgreich. Jede dieser temporären Instanzen wurde gestoppt und ihr Datenverzeichnis entfernt.

Git-Diff-/Whitespace-Checks bestanden; Index leer. HEAD, Anwendungscode, genehmigtes Shop-Layout, Dependencies und Migrationen 001–083 unverändert. Der vorhandene erfolgreiche Production-Build gilt für denselben Anwendungscode; für SQL/Test/Dokumentationsänderungen war kein erneuter Build erforderlich.

Grenzen: Das ist echtes PostgreSQL mit minimaler lokaler Auth-Schnittstelle und rollenbasierter RPC-Ausführung, kein vollständiger Supabase-Auth-/PostgREST-/Stripe-Live-End-to-End-Test. Der historische 075-Fixture bildet den belegten benötigten Zustand nach, nicht sämtliche ehemaligen Production-Default-Grants. Keine Aussage dieses Berichts autorisiert die Wiederherstellung dieser Rechte auf einem Remote-System.

## 7. Verbleibende Production-Freigabeschritte

Keine lokale Testblockade bleibt offen. **Production-Ausführung ist weiterhin nicht freigegeben und wurde nicht durchgeführt.**

1. Diesen Bericht, die exakte 084-Datei, Preflight/Postcheck und Hashnachweise abschließend prüfen/freigeben.
2. Production-Schema-/Migrationshistorie separat abgleichen. Der Audit fand keine schema_migrations-Tabelle; deshalb kein blindes db push, Replay alter Migrationen oder automatisches history repair.
3. Externe Integrationen auf direkte Helper-Aufrufe prüfen. Der Repository-Code benötigt sie nicht; unbekannte externe Aufrufe lassen sich durch lokale Tests nicht ausschließen.
4. Autorisierten read-only Production-Preflight ausführen und Owner, Signaturen, Bodies/Hash, ACLs, Defaults, Sequenzdefinition und äußere RPC-Berechtigungen mit dem geprüften Stand vergleichen. Vorzustand geschützt sichern. Bei Drift stoppen.
5. Erst nach ausdrücklicher Freigabe 084 auf dem exakt verifizierten Ziel als autorisierter DB-Owner transaktional ausführen. Keine historischen Fixtures, weiteren Grants, Default-/RLS-Änderungen oder andere Funktionen übernehmen.
6. Lesenden Postcheck sowie Vorher/Nachher-Vergleich durchführen. Keine Testbestellung, keinen Helper-/nextval-Aufruf und keine echte Zahlung erzeugen. Bestehende legitime Settlement-Fehlertelemetrie beobachten.
7. Bei Regression den konkreten fehlenden Aufrufer untersuchen. Kein automatisches Wiederherstellen von PUBLIC-EXECUTE, kein Sequenzreset und keine Umnummerierung historischer Bestellungen. Rollback nur anhand des gesicherten Zustands nach eigener Freigabe.

Unverändert separat offen: übrige Security-Advisor-Warnungen, historische Provisioning-/Migrationshistorie und zukünftige Grant-Governance aus dem ursprünglichen Audit. Sie wurden bewusst nicht in 084 gebündelt.

**Kein Commit, Push, Deployment, Production-/Staging-Schreibzugriff, echter Stripe-Aufruf oder E-Mail-Versand. STOP FÜR ABSCHLIESSENDE REVIEW.**
