# Gemeinsamer GLOA-Release

Ausgangsbasis in Production laut letztem Nachweis: `c4e0f827bca81764f0a4faa206765abee080a4fc`.
Vor der Ausführung GitHub main, das aktive Vercel-Deployment, die Migrationsregistrierung und die effektiven Production-Flags erneut abgleichen. Die folgenden Schritte benötigen eine gesonderte Production-Freigabe.

## Migrationen und Deployment

Die folgenden Dateien liegen unter `supabase/migrations`. Sie beschreiben den Umfang relativ zur Ausgangsbasis. Nur die in Production noch fehlenden Versionen in dieser Reihenfolge mit der vorgesehenen DB-Owner-Rolle ausführen. Bei einer abweichenden bereits registrierten Version oder beim ersten Fehler anhalten.

1. `20261123160000_gloa_offer_drafts_and_invoice_issuers.sql`
2. `20261123170000_gloa_b2b_offer_versions.sql`
3. `20261123170100_gloa_creator_monthly_preview.sql`
4. `20261123180000_matcha_lot_traceability.sql`
5. `20261123190000_creator_monthly_payout_workflow.sql`
6. `20261124120000_subscription_pause_write_fences.sql`
7. `20261124121000_subscription_pause_windows.sql`
8. `20261124130000_b2b_offer_publication_and_handoff.sql`
9. `20261124140000_b2b_offer_contract_terms.sql`
10. `20261124150000_gloa_invoice_register.sql`
11. `20261124160000_gloa_invoice_sale_subjects.sql`
12. `20261124170000_gloa_xrechnung_register.sql`
13. `20261124180000_b2b_offer_checkout_link.sql`

1. Als DB-Owner den Ausgangszustand von Registry, Objekt- und Rollenrechten sowie die Abhängigkeiten prüfen. Bestätigen, dass der bisherige Vercel-Stand reaktiviert werden kann.
2. Die Migrationen anwenden. Danach Registry, Eigentümer, effektive Grants, RLS, Trigger und private Storage-Bucket-Konfiguration prüfen. Die vier reservierten Schlüssel in `operations_config` müssen einzeln vorhanden sein und `int_value = 0` melden.
3. Erst dann den exakten Integrationscommit deployen. Commit und Ready-Status prüfen. Bestehende Checkout- und Webhook-Pfade ohne Buchung prüfen. Rechnungs- und Angebotsmail-Flags geschlossen halten. `B2B_SELF_SERVICE_ENABLED` im bisherigen Zustand belassen.
4. Je nach Abnahme die unten beschriebenen Schlüssel einzeln als postgres auf 1 setzen und lesend verifizieren. Jede Änderung muss genau einen Schlüssel treffen. Aktivierungen sind gesondert freizugeben.

| Datenbankschlüssel | Bedingung für Aktivierung |
| --- | --- |
| `creator_b2b_release_writes_enabled` | Gemeinsame Freigabe für Creator und deutsche B2B-Angebote. `B2B_SELF_SERVICE_ENABLED` betrifft auch bestehende Checkout-Pfade und erfordert eine eigene Entscheidung. `B2B_OFFER_EMAIL_ENABLED` bleibt bis zur separaten Freigabe aus. Internationale Fälle mit ungeklärter Steuerbehandlung gesperrt lassen. |
| `matcha_lot_release_writes_enabled` | Wareneingang und Versand mit echten Nachweisen betreiben. Vor dem ersten chargengeführten Eingang Zuständigkeit und Umgang mit vorhandenem nicht zugeordnetem Bestand klären. Historische Sperren bleiben bestehen. |
| `invoice_release_writes_enabled` | Echte isolierte Auth-/Storage-Abnahme für PDF, XML und Fremdzugriff abschließen. Eine geprüfte Ausstellerversion mit Wirksamkeitsdatum und aktiver Owner-Freigabe anlegen. `GLOA_INVOICE_ISSUER_VERSION`, `GLOA_INVOICE_CUTOFF` und die Rechnungs-/XRechnungsflags abgestimmt konfigurieren. Versand gesondert freigeben. |
| `sandbox_pause_release_writes_enabled` | Nur in einer isolierten Testdatenbank aktivieren. Signierten Stripe-Empfang, Test Clock und keine Zustellung an das Vercel-Ziel nachweisen. Der Adapter sperrt Production ausdrücklich. |

## Datenwahrender Rückfall

Zuerst betroffene Starts anhalten und den passenden Schlüssel als postgres auf 0 setzen. Offene Vorgänge anhand vorhandener Kennungen abgleichen. Bezahlte Ansprüche, Dokumente, Nummern, Versandnachweise und Zahlungsreferenzen bleiben erhalten. Die additive Migration bleibt installiert. Fehlerhafte DB-Objekte später gezielt korrigieren.

- **Creator und B2B.** Den [bestehenden Rückfallplan](creator-b2b-release-rollback/README.md) einschließlich `freeze-new-writes.sql` nutzen. Beide Schutztrigger erhalten. Offene Checkout- und Zahlungsvorgänge abgleichen, bevor ältere App-Versionen wieder neue Starts annehmen.
- **Rechnungen.** Automatische Ausstellung und Mail deaktivieren. Bereits ausgestellte Dokumente privat abrufbar lassen. In Bearbeitung befindliche Register-, Storage- und Versandzustände anhand ihrer Referenzen abgleichen. Nummern und Sequenzen erhalten. Keine Dateilöschung oder Wiederholung unklarer Zustellungen.
- **Chargen.** Nach dem ersten erfassten Los sperrt der geschlossene Schalter relevante Bestandsbewegungen und die Versandprüfung bleibt wirksam. Erst nach Abgleich von Bestandsjournal und Chargen wieder öffnen. Keine fiktiven Zuordnungen anlegen. Historische Versanddaten bleiben unverändert.
- **Abo.** Neue Sandbox-Aktionen anhalten. Offene Stripe-Zustände und Webhook-Verarbeitung im identischen isolierten Konto abgleichen. Bezahlte Lieferansprüche, Pause-Fenster und Konkurrenzsperren erhalten. Bei ungeklärtem Ausgang den zuständigen Webhook-Pfad weiter betreiben und keine veraltete Version mit laufender Verarbeitung betrauen.

Das vorige Deployment erst wieder zuweisen, wenn es die verbleibenden Geschäftsvorgänge korrekt verarbeiten kann. Bei Teilausführung die tatsächliche Registry und Objektlage nutzen. Der gemeinsame Plan setzt keinen vollständigen Supabase-Restore voraus.

## Rechnungsfreigabe

Vor einem Wechsel der Ausstellerversion die Ausstellung sperren und die konfigurierte Version mit der zuletzt wirksam gewordenen Version abgleichen. Wiederholungen behalten den gespeicherten Snapshot. Korrekturen behalten die Ausstellerversion des Originals.

Die B2B-Zahlungswebhooks korrelieren Abrechnungsnachweise. Vor der automatischen XRechnung fehlen der belegte Snapshot mit Adressat, Ausstellerkontakt, Leistungs- und Zahlungsdaten sowie die Anbindung an die Ausstellung. Das validierte Profil weiterhin unveraendert verwenden.
