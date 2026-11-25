# GLOA Matcha Sandbox — einmaliges Abo-Testfenster

## Lesend erfasster Ausgangszustand

- Konto: GLOA Matcha Sandbox, `acct_1U6B3cDASU5R3UGE`, `livemode=false`
- Endpoint: `we_1U6GTJDASU5R3UGE7b0tAd9l`
- Status: `enabled`
- Ziel: `https://variante-1-cyan.vercel.app/api/stripe/webhook`
- API-Version: `2026-07-29.dahlia`
- Abonnierte Ereignisse: `checkout.session.completed`, `charge.refunded`, `charge.refund.updated`, `refund.created`, `refund.updated`, `refund.failed`

Das Ziel ist ein Alias des GLOA-Production-Deployments. Stripe CLI aendert die Zustellung an den bestehenden Endpoint nicht. Dieses Verfahren ist erst nach ausdruecklicher Freigabe des Testfensters auszufuehren.

## Einmaliger Ablauf

1. In der **GLOA Matcha Sandbox** ausschliesslich den oben identifizierten Endpoint voruebergehend deaktivieren. Den Status `disabled` lesend bestaetigen. URL, Ereignisse, API-Version und Signing Secret nicht bearbeiten.
2. Stripe CLI mit einem nachweislich zu diesem Sandbox-Konto gehoerenden Testschluessel ueber die geschuetzte Prozessvariable `STRIPE_API_KEY` starten. Keine Schluessel als CLI-Argument oder im Repository ablegen. Falls das normale CLI-Profil den Windows-Dateizugriff verweigert, fuer diese Sitzung vor dem Start `XDG_CONFIG_HOME` auf ein frisches lokales Temp-Verzeichnis setzen und die bestehende Konfiguration unangetastet lassen.

   ```powershell
   stripe listen --events customer.subscription.updated,customer.subscription.paused,customer.subscription.resumed --forward-to http://127.0.0.1:4242/api/stripe/webhook
   ```

3. Nach bestaetigter Abschaltung genau ein synthetisches Vier-Wochen-Abo mit Flexible Billing vorbereiten, nach Eignung mit Test Clock. In der Empfaenger-Sitzung die Werte `GLOA_TEST_STRIPE_KEY`, `GLOA_TEST_WEBHOOK_SECRET` (Secret des laufenden CLI-Listeners) und `GLOA_TEST_SUBSCRIPTION_ID` sowie `GLOA_TEST_LOCAL_SUBSCRIPTION_ID` nur im Prozess setzen. Das synthetische Abo muss die lokale UUID in `gloa_subscription_id` und den Marker `gloa_test_fixture=pause-loopback` tragen. Den Empfaenger mit `node scripts/stripe-pause-loopback.mjs --listen` starten. Konto und Testabonnement werden vor dem Binden an Loopback lesend verifiziert.
4. Erst nach erfolgreicher Listener-Verbindung und Empfaengerbereitschaft die autorisierten Sandbox-Uebergaenge ausfuehren. Der Empfaenger akzeptiert nur die drei angegebenen Statusereignisse fuer das konkrete Testabo. Stripe-Signatur und lokale Reconciliation sind getrennt vom Stripe-API-Zustand zu protokollieren. `invoice.paid`, Lieferansprueche und Supabase-E2E liegen ausserhalb dieser Abnahme. Die Befehle `pause` und `resume` in der Empfaenger-Konsole nutzen die bestehende Anwendungsroute und deren Pause-Adapter. Der Aufrufer verweigert Schreibaktionen, solange der dokumentierte Endpoint oder ein anderer gelisteter Sandbox-Webhook aktiv ist.
5. Auch bei Abbruch den Listener und den Loopback-Empfaenger beenden. Prozessvariablen mit Zugangsdaten entfernen. Ausstehende Zustellungen an den Production-Alias lesend pruefen. Bei ungeklaerter Zustellung keine Testereignisse erneut senden. In der Sandbox denselben Endpoint erneut aktivieren und Status, URL, API-Version und vollstaendige Ereignisliste gegen den Ausgangszustand abgleichen. Keine Secret-Rotation und kein neuer Endpoint.

## Abnahmegrenze

Das lokale synthetische Preflight-Ergebnis liegt vor. Die Sandbox-Anmeldung der Stripe CLI wurde vom Windows-Owner lesend bestaetigt. `node scripts/stripe-pause-loopback.mjs --check-actions` prueft den isolierten Aufruf mit synthetischem Stripe-Transport. Der echte Testlauf steht aus. Bei `unconfirmed` keine weiteren Schreibaktionen ausfuehren und den Empfaenger zur Wiederholung nicht neu starten. Zuerst den tatsaechlichen Stripe-Zustand lesend abgleichen.

## Resume-only-Folgeabnahme

Der erste Owner-Lauf bleibt verbraucht. Sein Runner und sein Sperrmarker werden weder zur Wiederaufnahme verwendet noch zurueckgesetzt.

- Die Stripe-Ereignisse `evt_1UfTkFDASU5R3UGEF8zuuKkh` und `evt_1UfTkKDASU5R3UGE5kq567UH` belegen die GLOA-Terminplanung und die tatsaechliche Pause. Der erste Event verknuepft den Zeitplan mit der GLOA-Pause-Idempotenzkennung, dem synthetischen Abo und der Test Clock. Der zweite bestaetigt denselben Pausenzeitpunkt wie der freigegebene Zeitplan. Vor einer lokalen Wiederherstellung des Pausenbelegs diese Verknuepfungen erneut lesend pruefen.
- Fuer ein spaeter gesondert freigegebenes Fenster braucht der Resume-only-Aufruf eine eigene atomare Einmalsperre vor der ersten Mutation sowie denselben verifizierten Wiederherstellungsweg fuer den Sandbox-Webhook.
- Die Test Clock steht exakt auf der Pause. Einen spaeteren minimalen Zeitvorschub nur in diesem gesonderten Fenster und nur fuer diese Clock vornehmen. Vor der anschliessenden Wiederaufnahme Stripe-Zustand und Abrechnungsvorschau pruefen. Erlaubt ist ausschliesslich der neue volle Vier-Wochen-Zyklus ohne alte Positionen, Nachberechnung oder Proration. Bei anderer oder nicht belegter Vorschau stoppen.
- Fuer die lokale Lieferfreigabe muessen die exakte vom Resume zurueckgegebene Rechnungs-ID, eine bezahlte und dem normalen Abo-Zyklus zuordenbare Rechnung und der neue Stripe-Zyklusbeginn zusammenpassen. Andere Rechnungsgruende bleiben gesperrt. Die signierte Sandbox-Zustellung und dieser konkrete Rechnungsnachweis stehen aus. Der Status-Loopback allein erteilt keine Lieferfreigabe.

Nach gesonderter Owner-Freigabe erfolgt die einmalige Folgeabnahme mit `node scripts/stripe-resume-only-owner.mjs` in der Windows-Owner-PowerShell. Die Prozessvariablen `GLOA_TEST_STRIPE_KEY` (verdeckt eingelesener vorhandener Sandbox-Testschluessel), `GLOA_TEST_STRIPE_CLI` (Pfad zu stripe.exe) und `GLOA_TEST_QUIET_WINDOW=YES` sind erforderlich. Das Sandbox-Profil liegt unter `%LOCALAPPDATA%\GLOA-Stripe-CLI-Sandbox`. Vor dem Start muessen Port 4242 frei, Testabo und Test Clock aktuell und alle anderen vom Endpoint abhaengigen Tests beendet sein. Das Signing Secret kommt ueber die Prozess-Pipe vom CLI-Listener.

Die eigene Einmalsperre bleibt auch erhalten, wenn die Vorschau nach dem Clock-Vorlauf blockiert. Bei hartem Abbruch in GLOA Matcha Sandbox den Endpoint `we_1U6GTJDASU5R3UGE7b0tAd9l` manuell wieder aktivieren und URL, API-Version und alle sechs Ereignisse gegen den dokumentierten Ursprung abgleichen. Der Loopback erfasst das signierte `invoice.paid`, prueft die zugehoerige bezahlte Stripe-Rechnung und erzeugt keinen Versandauftrag. Der Datenbank-Transaktionsschutz wird getrennt durch den vorhandenen lokalen PostgreSQL-Nachweis abgedeckt.
