# Search Console, Bing und Crawler-Politik

Stand: 15.09.2026 · Shop-Status: `prelaunch`

Diese Datei beschreibt die **manuellen** Schritte bei Google und Bing,
hält die Crawler-Entscheidung fest und dokumentiert IndexNow.

Im Repository liegen **keine Verification-Tokens**, und es wurde keiner
erfunden — die Google- und Bing-Verifizierung unten läuft über DNS und
kommt ohne eine Datei im Projekt aus. Die IndexNow-Key-Datei in
Abschnitt 4 ist etwas anderes und ist bewusst öffentlich; Abschnitt 4
erklärt den Unterschied.

---

## 1. Technische Voraussetzungen

Alles davon ist erfüllt und wird von `tests/seo-discovery.test.mjs` und
`tests/shop-product-discovery.test.mjs` laufend geprüft:

| Prüfpunkt | Zustand |
|---|---|
| `https://gloamatcha.com/` | 200, eigener Canonical, eigene Metadaten |
| `https://gloamatcha.com/robots.txt` | 200, `text/plain`, default-allow, Sitemap-Zeile |
| `https://gloamatcha.com/sitemap.xml` | 200, `application/xml`, gültiges `urlset` |
| Sitemap-Inhalt | exakt `INDEXABLE_ROUTES` aus `lib/publicRoutes.ts` |
| Canonicals | ausnahmslos auf `https://gloamatcha.com` |
| Unbekannte Routen | echter HTTP 404 |
| Unbekannte Produkt-Slugs | echter HTTP 404 (`lib/catalogProducts.ts`) |
| Private / zurückgehaltene Seiten | `noindex` |
| JSON-LD | Organization, Brand, WebSite — absolute URLs, verknüpft |

`/sitemap.xml` und `/robots.txt` sind statische Dateien unter `public/`.
Sie brauchen weder Build-Schritt noch Deploy-Sonderfall.

---

## 2. Google Search Console — Domain-Property per DNS

Bevorzugt die **Domain-Property**, nicht die URL-Präfix-Property: sie
deckt `http`, `https`, `www` und jede Subdomain in einem Eintrag ab, und
sie braucht keine Datei und kein Meta-Tag im Repository.

1. https://search.google.com/search-console öffnen, mit dem Google-Konto
   anmelden, das die Property dauerhaft besitzen soll.
2. **Property hinzufügen → Domain**.
3. Als Domain eintragen: `gloamatcha.com`
   (ohne `https://`, ohne `www.`, ohne Pfad).
4. Google zeigt einen **TXT-Record** der Form
   `google-site-verification=…`. Diesen Wert kopieren.
5. Beim DNS-Anbieter der Domain einen TXT-Record anlegen:
   - Name / Host: `@` (also `gloamatcha.com` selbst)
   - Typ: `TXT`
   - Wert: die Zeile aus Schritt 4, unverändert
   - TTL: Standard
   Bestehende TXT-Records (z. B. SPF) **nicht** ersetzen — TXT-Records
   dürfen nebeneinander stehen.
6. DNS-Propagierung abwarten (meist Minuten, bis zu 48 h), dann in der
   Search Console auf **Bestätigen** klicken.
7. Den TXT-Record danach **stehen lassen**. Google prüft ihn regelmäßig
   nach; wird er gelöscht, verliert die Property ihre Bestätigung.

### Sitemap einreichen

8. In der bestätigten Property: **Sitemaps** öffnen.
9. Eintragen: `sitemap.xml`
   (die Oberfläche stellt `https://gloamatcha.com/` voran; vollständig
   lautet die URL `https://gloamatcha.com/sitemap.xml`).
10. **Senden**. Status „Erfolgreich" plus 14 gefundene URLs ist das
    erwartete Ergebnis.

### Danach

- **URL-Prüfung** für `https://gloamatcha.com/` und
  `https://gloamatcha.com/shop/matcha` ausführen und jeweils
  **Indexierung beantragen**. Das ist der schnellste Weg zur ersten
  Erfassung.
- Der Bericht **Seiten** wird `/shop/metal-case` und die Account-Routen
  als „Durch noindex ausgeschlossen" führen. Das ist beabsichtigt und
  kein Fehler.
- Der Bericht **Shopping / Produkt-Snippets** bleibt leer, solange
  `SHOP_STATUS = "prelaunch"` ist. Product-Markup wird erst bei `live`
  ausgeliefert (siehe `lib/productStructuredData.ts`).

---

## 3. Bing Webmaster Tools — Import aus Google

Der Import spart die zweite Verifizierung vollständig; er ist deshalb der
empfohlene Weg. Er setzt Schritt 2 voraus.

1. https://www.bing.com/webmasters öffnen und anmelden.
2. **Import your sites from Google Search Console** wählen.
3. Mit demselben Google-Konto anmelden und den Zugriff bestätigen.
4. `gloamatcha.com` in der Liste auswählen und importieren. Verifizierung
   und eingereichte Sitemap werden mit übernommen.
5. Unter **Sitemaps** prüfen, dass `https://gloamatcha.com/sitemap.xml`
   gelistet ist. Falls nicht: dort manuell ergänzen.

Falls der Import nicht möglich ist, ist der Ersatzweg ebenfalls DNS:
**Add site → gloamatcha.com → Verify via DNS**, TXT-Record nach demselben
Muster wie oben anlegen, bestätigen, Sitemap manuell einreichen.

> Bing speist auch DuckDuckGo und ChatGPTs Websuche. Der Eintrag ist
> damit mehr als ein zweiter Suchindex.

---

## 4. IndexNow — Bing & Co. aktiv benachrichtigen

Eine Sitemap ist ein Angebot: Der Crawler liest sie, wann er möchte.
IndexNow ist eine Meldung: Ein HTTPS-Request nennt die URLs, die sich
geändert haben, und die teilnehmenden Suchmaschinen holen genau die ab.

### Wer teilnimmt

| | |
|---|---|
| Erreicht | Bing, Yandex, Seznam, Naver, Yep — über einen gemeinsamen Endpoint |
| Mittelbar | DuckDuckGo und ChatGPTs Websuche, weil beide von Bing gespeist werden |
| **Nicht erreicht** | **Google. Google nimmt an IndexNow nicht teil.** |

Für Google ändert sich durch IndexNow **nichts**. Die Erfassung dort
bleibt exakt das, was in Abschnitt 2 steht: Sitemap plus „Indexierung
beantragen". Search Console und IndexNow sind zwei getrennte Wege, und
keiner ersetzt den anderen.

### Der Key ist öffentlich — und das ist die Spezifikation, kein Leak

IndexNow beweist Eigentum so: Der Key liegt als Textdatei auf dem Host,
und dieselbe Zeichenkette steht im Request. Die Suchmaschine holt die
Datei und vergleicht. Der Key **muss** also für jeden lesbar sein.

| | |
|---|---|
| Key | `d40c9f52109c6efb876517ffc2e9cf20` |
| Datei | `public/d40c9f52109c6efb876517ffc2e9cf20.txt` |
| URL | https://gloamatcha.com/d40c9f52109c6efb876517ffc2e9cf20.txt |
| Inhalt | exakt der Key, nichts sonst, kein Zeilenumbruch |

Das ist **kein Verification-Token** im Sinne von Abschnitt 5. Ein
Verification-Token beweist, wem eine Property *gehört*, und schaltet
einen Account frei. Dieser Key beweist nur, dass ein Request von
jemandem kommt, der ins Web-Root schreiben kann, und schaltet eine
Crawl-Anfrage frei. Wer ihn hat, kann Suchmaschinen bitten, ohnehin
öffentliche Seiten neu zu lesen — mehr nicht. Deshalb liegt er im
Repository, so wie `robots.txt` dort liegt: kein Secret, keine ENV-
Variable, kein Rotationsplan.

> Wird der Key je geändert, muss die Datei mitumbenannt werden.
> `tests/indexnow.test.mjs` liest beides und schlägt fehl, wenn sie
> auseinanderlaufen — ein Key ohne passende Datei ist bei jeder
> Suchmaschine HTTP 403 und sonst nichts.

### Welche URLs gemeldet werden

Genau die 14 URLs aus `INDEXABLE_ROUTES` (`lib/publicRoutes.ts`) — also
exakt der Inhalt von `sitemap.xml`. Es gibt **keine zweite Liste**: das
Script mappt dieselbe Konstante, die die Sitemap baut und die über
`noindex` entscheidet.

Damit sind die Ausschlüsse automatisch richtig, weil sie nur einmal
entschieden werden:

| Nicht gemeldet | Grund |
|---|---|
| `/rezepte`, `/journal` | für diesen Launch zurückgehalten, `noindex` |
| `/wholesale` | Alias; kanonisch ist `/for-cafes` |
| `/shop/metal-case` | zurückgehaltenes Produkt, `noindex` |
| `/shop/gloa-matcha` | Alias; kanonisch ist `/shop/matcha` |
| `/account/*`, `/auth/*`, `/order/*` | privat bzw. transaktional, `noindex` |
| `/api/*`, `/adminxyzuebersicht` | keine öffentlichen Seiten |

### Ausführen

```
npm run indexnow -- --dry-run    # zeigt Payload und URLs, sendet nichts
npm run indexnow                 # prüft die Key-Datei live, dann EIN POST
```

Das Script holt zuerst `https://gloamatcha.com/<key>.txt` und vergleicht
den Inhalt. Erst wenn das stimmt, geht ein einziger POST mit allen URLs
raus. Es gibt keinen Retry-Loop: 403/422 würden identisch erneut
scheitern, und 429 ist die Bitte um weniger Traffic.

Antworten: `200` gesendet · `202` angenommen, Key-Prüfung läuft noch —
beides Erfolg. `400` Payload kaputt · `403` Key nicht verifizierbar ·
`422` fremder Host oder Key-Schema · `429` Rate Limit.

### Wann ausführen

**Nach dem Production-Deployment**, und nur wenn sich inhaltlich etwas
Relevantes geändert hat:

- **Launch-Umstellung `SHOP_STATUS` → `live`.** Der wichtigste Fall:
  Preise, Offer-Markup und Kauf-Flow erscheinen auf einen Schlag.
- Neue öffentliche Seite (dann steht sie ohnehin schon in
  `INDEXABLE_ROUTES`, sonst wäre sie nicht in der Sitemap).
- Freigabe zurückgehaltener Bereiche, z. B. `/rezepte`.
- Größere inhaltliche Überarbeitung bestehender Seiten.

**Nicht** ausführen bei Deployments ohne inhaltliche Änderung, nicht
mehrmals am selben Tag für dieselben URLs, und nicht „zur Sicherheit
nochmal".

### Warum das ein Kommando ist und keine Automatik

| Variante | Warum nicht |
|---|---|
| bei jedem Request | tausende Meldungen täglich für unveränderte Seiten — genau der Spam, gegen den 429 existiert |
| aus dem Browser | gibt jedem Besucher eine Crawl-Anfrage in die Hand |
| `postbuild`-Hook | Vercel baut auch **Preview**-Deployments; jeder Branch-Push würde Production-URLs melden |
| Cron | feuert nach Uhr. IndexNow meldet *Änderungen*; eine Uhr weiß von Änderungen nichts |

Was gemeldet werden soll, ist „wir haben gerade etwas Relevantes
ausgeliefert" — und das weiß nur ein Mensch. Zuverlässigkeit vor
Automatik.

---

## 5. Search-, User-Request- und Training-Crawler

**Keine Änderung an der bestehenden Konfiguration.** `public/robots.txt`
ist default-allow für alle Agents; dieser Abschnitt hält nur fest, was
das konkret bedeutet. Dieselbe Erklärung steht als Kommentar in der
`robots.txt` selbst, damit sie dort gefunden wird, wo sie gilt.

| Gruppe | Beispiele | Zustand |
|---|---|---|
| Suche / Discovery | Googlebot, Bingbot, DuckDuckBot | erlaubt |
| Nutzer-angefragt | OAI-SearchBot, ChatGPT-User, PerplexityBot, Google-Extended | erlaubt |
| Training | GPTBot, CCBot, ClaudeBot, Applebot-Extended | erlaubt |

Die Training-Gruppe ist **nicht** aktiv freigegeben worden — sie fällt
unter dieselbe `User-agent: *`-Regel wie alles andere. Wird sie später
ausgeschlossen, gehört das als eigener `Disallow`-Block **unter** die
`User-agent: *`-Regel und darf die beiden oberen Gruppen nicht berühren:
ein falsches Token entfernt die Seite aus der Suche statt aus einem
Trainingskorpus.

---

## 6. Was hier bewusst nicht steht

- **Kein Verification-Token.** Weder Datei noch Meta-Tag im Repository;
  Google und Bing werden oben per DNS bestätigt. Die IndexNow-Key-Datei
  aus Abschnitt 4 ist keine Ausnahme davon: sie bestätigt keine
  Property und schaltet keinen Account frei, sie ist der öffentliche
  Teil eines Meldeverfahrens.
- **Kein Google Business Profile.** Setzt einen bedienten Standort oder
  ein Liefergebiet mit Kundenkontakt voraus. Erst prüfen, wenn das
  zutrifft.
- **Kein Ranking-Versprechen.** Die Einreichung sorgt für Erfassung,
  nicht für Position.
