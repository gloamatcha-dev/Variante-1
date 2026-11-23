# GLOA Production-Recovery

Zielprojekt ist Supabase `yphubqploumfeabytotc`. Der Owner entscheidet über eine Production-Wiederherstellung und benennt die ausführende Person. Die aktuell zugewiesene Betriebsverantwortung sowie PITR, Aufbewahrungsdauer und letzter verfügbarer Wiederherstellungspunkt sind separat im Betriebsnachweis zu bestätigen.

## Vorhandener Nachweis

Der abgegrenzte Windows-Restore eines vorhandenen verschlüsselten Archivs ist mit `PASS_SCOPED_WINDOWS_RESTORE` protokolliert. Der lokale Nachweis liegt im Haupt-Workspace unter `outputs/windows-backup-v1/restore-only-result.json`. Das Ergebnis verzeichnet keine Production-Verbindung, keinen neuen Export und keine Production-Schreibzugriffe.

Der geprüfte Restore umfasst den dokumentierten PostgreSQL-Umfang. Vault, Storage-Dateiinhalte und die vollständige Wiederinbetriebnahme der Supabase-Dienste benötigen eigene Nachweise. Wiederhergestellte Storage-Tabellen belegen die Wiederherstellung der Metadaten.

## Vor einer Freigabe

1. Projekt, verfügbaren Wiederherstellungspunkt, Aufbewahrung und verantwortliche Person mit den vorhandenen Betreiberunterlagen abgleichen.
2. Für Datenbank, Vault, Storage-Dateiinhalte und Dienstkonfiguration jeweils festhalten, welche Wiederherstellungsquelle existiert und welcher Nachweis ihren Umfang belegt.
3. Beim Owner Ziel, Umfang und Auswirkungen schriftlich freigeben lassen. Der bestandene lokale Restore dient als Nachweis für seinen geprüften Umfang.
