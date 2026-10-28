# Bladerboek

Een webtool om je boeken als realistisch bladerboek aan klanten te laten zien.

- Upload een PDF op de beheerpagina en stuur de klant een deellink (`/b/<code>`).
- De klant bladert met een echte pagina-krul (slepen aan de hoek, klikken, pijltjestoetsen of swipen op mobiel).
- Uitvoering: **hardcover** (harde kaft met overstek, schutbladen, stijve omslag), **softcover** (meebuigende omslag) of **magazine** (dun papier, nietjes in het middelste katern). De dikte van het papierblok links en rechts hangt af van het aantal pagina's en hoe ver je bent.
- Afloop wordt automatisch weggesneden op basis van de TrimBox in de PDF, zodat spreads precies op de rug aansluiten.
- Kaartje in beeld met titel, formaat (bijv. 17 × 24 cm) en omvang (pagina's, uitvoering, rugdikte).
- Opmerkingen: een speld op een plek in een pagina, een opmerking over een pagina, of een algemene opmerking. Jij ziet ze allemaal op de beheerpagina en kunt ze afvinken.
- PDF downloaden (per boek aan of uit te zetten).
- Keuze van omgeving: houten tafel, lichte studio, donker of linnen.

## Lokaal starten

```bash
npm install
ADMIN_PASSWORD=kies-een-wachtwoord npm start
```

Open daarna http://localhost:3000 (beheer, inloggen met een willekeurige gebruikersnaam en je wachtwoord).

`public/viewer.html` werkt ook zonder deellink: open hem en sleep er een PDF in. Opmerkingen blijven dan alleen in je eigen browser.

## Online zetten

Elke host die Node.js 18+ draait en een blijvende map heeft voor de bestanden werkt, bijvoorbeeld een VPS, Render, Railway of Fly.io. Er zit een `Dockerfile` bij.

Instellingen (omgevingsvariabelen):

| Variabele | Betekenis |
| --- | --- |
| `ADMIN_PASSWORD` | Wachtwoord voor de beheerpagina. Verplicht instellen. |
| `DATA_DIR` | Map waar PDF's en opmerkingen worden bewaard (standaard `./data`, in Docker `/data`). Moet blijvend zijn. |
| `PORT` | Poort (standaard 3000). |

Zet de site achter HTTPS (bij de meeste hosts automatisch).

## Opbouw

- `server.js`: Express-server met beheer-API (wachtwoord), deellinks en opmerkingen. Opslag per boek in `DATA_DIR/books/<id>/` (`book.pdf`, `meta.json`, `comments.json`).
- `public/viewer.*`: de bladerviewer (pdf.js voor het renderen, StPageFlip voor de pageturn, eigen laag voor kaft, papierblok, rug, nietjes en spelden).
- `public/admin.html`: beheerpagina.
- `public/vendor/`: meegeleverde bibliotheken (pdf.js 4.10, StPageFlip 2.0.7, pdf-lib 1.17), zodat er geen externe CDN nodig is.
