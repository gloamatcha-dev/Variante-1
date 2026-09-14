# Search Console, Bing und Crawler-Politik

Stand: 14.09.2026 · Shop-Status: `prelaunch`

Diese Datei beschreibt die **manuellen** Schritte bei Google und Bing und
hält die Crawler-Entscheidung fest. Im Repository liegen **keine**
Verification-Tokens, und es wurde keiner erfunden — beide Verfahren unten
kommen ohne eine Datei im Projekt aus.

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

## 4. Search-, User-Request- und Training-Crawler

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

## 5. Was hier bewusst nicht steht

- **Kein Verification-Token.** Weder Datei noch Meta-Tag im Repository;
  beide Wege oben laufen über DNS.
- **Kein Google Business Profile.** Setzt einen bedienten Standort oder
  ein Liefergebiet mit Kundenkontakt voraus. Erst prüfen, wenn das
  zutrifft.
- **Kein Ranking-Versprechen.** Die Einreichung sorgt für Erfassung,
  nicht für Position.
