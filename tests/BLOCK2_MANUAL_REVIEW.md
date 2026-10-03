# Block 2: lokale Sichtprüfung

Die automatisierte Browserprüfung konnte wegen des fehlenden Windows-Sandbox-Helfers nicht gestartet werden. Es liegt keine visuelle Freigabe vor. Die folgenden Prüfungen sind manuell erforderlich.

## Sichere Vorschau

Nach dem lokalen Build: `node tests/helpers/adminPortalPreview.mjs`.
Öffnen: http://127.0.0.1:4000/adminxyzuebersicht.
Die Vorschau nutzt synthetische Datensätze und eine ausschließlich lokale Testidentität. Jeder API-Schreibversuch wird mit 403 abgelehnt. Provider-Schlüssel sind leer; externe Fetch-Aufrufe des Anwendungsservers werden blockiert. Die Testidentität existiert nur im Vorschau-Proxy, nicht in der Anwendung. Mit Strg+C beenden.

## Alle Ansichten

Jede folgende Ansicht bei **1440, 1024 und 390 Pixeln** prüfen:

- Übersicht
- Verkauf: Bestellungen, Abos, Jahrespläne
- Verbraucherrechte
- Finanzen: Übersicht, Einnahmen, Ausgaben, Dokumente, Auswertungen
- Inventar
- Creator: Übersicht, Bewerbungen, Creator, Affiliate, Content, Auszahlungen
- B2B
- Aktivität

Je Ansicht: aktive Navigation und Tabs, lesbare kompakte Inhalte, mobile Karten, keine abgeschnittenen Bedienelemente, kein unbrauchbarer Navigationsstreifen. Detailansichten öffnen und per Escape schließen. Geschäftliche Referenzen vor technischen IDs prüfen. IDs sollen unter „Weitere Details“ stehen. Datums- und EUR-Formatierung prüfen.

## Abläufe und Zustände

- Übersicht: Aufgaben verlinken in gefilterte Bereiche; Jahreslieferungen erzeugen keinen zusätzlichen Einnahmenposten.
- Einnahmen: separate Einträge für Bestellung, Jahresvorauszahlung, B2B-Zahlung und Refund. Fehlende Gebühren/Kosten bleiben „nicht erfasst“. Zeitraum, Filter, Pagination und CSV prüfen.
- Verkauf: Zahlung, Refund und Versand getrennt; Abos „alle 4 Wochen“; ordentliche Jahreskündigung „Kündigung vorgemerkt“.
- Verbraucherrechte: Widerruf, Reklamation und Kündigung getrennt; außerordentliche Jahresentscheidung und öffentliche Abo-Ausführung getrennte Aktionen. Keine echte Aktion ausführen.
- Creator: kombinierbare Rollen, gespeicherte Affiliate-Regel, Held-/Adjusted-Zustände und gespeicherte Rechte-Notiz; keine freien Browser-Provisionsbeträge.
- Globale Suche: Testbestellung suchen und öffnen. Dokumentzuordnung über Geschäftsobjekt-Suche prüfen.
- Inventar: ausschließlich manuelle Bestandsbedienung; im Vorschau-Proxy keine Änderung möglich.
- Leere Zustände der synthetischen Abos-, Jahresplan-, B2B- und Rechte-Listen prüfen. Für besetzte Detailzustände sind zusätzliche rein synthetische Fixture-Datensätze erforderlich; keine Produktionsdaten einsetzen.
- Ladezustand durch lokale Netzwerkverlangsamung prüfen. Für Fehlerzustände `/api/admin/…` lokal im Browser blockieren: Fehlermeldung und Wiederholen müssen erscheinen, keine scheinbar gültige Null. Danach Blockierung entfernen und erneut laden.
- Direkter Schreibversuch gegen die Vorschau muss 403 liefern. Niemals Production, Stripe oder E-Mail-Provider für diese Prüfung benutzen.

## Echte Einschränkungen

Die Dokumentbasis unterstützt Metadaten und Zuordnung vorhandener privater Dateien/Providerreferenzen. Ein Datei-Upload beziehungsweise eine Rechnungs-/PDF-Generierung ist ohne vorhandenen Storage-/Generator-Backendvertrag nicht umgesetzt. Das Ergebnis bleibt unbekannt, solange Vollständigkeit der Kosten nicht autoritativ feststeht. Versandzählungen außerhalb des vorhandenen begrenzten RPC-Fensters werden als unvollständig dargestellt.
