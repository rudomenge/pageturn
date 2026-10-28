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

## Online zetten op Cloudflare (aanbevolen)

De tool draait als Cloudflare Worker. PDF's en opmerkingen staan in één R2-bucket. Bij normaal gebruik valt dat binnen het gratis tegoed (10 GB opslag, gratis downloads). Een PDF mag maximaal 95 MB zijn.

1. **R2 aanzetten.** Ga in het [Cloudflare-dashboard](https://dash.cloudflare.com) naar *Storage & databases → R2* en zet R2 aan. Cloudflare vraagt een betaalmethode, ook voor het gratis deel.
2. **Bucket maken.** Klik op *Create bucket* en noem hem precies `pageturn`. De rest laat je staan.
3. **Worker koppelen aan GitHub.** Ga naar *Workers & Pages → Create → Import a repository*. Koppel GitHub, kies `rudomenge/pageturn` en laat de voorgestelde instellingen staan (deploycommando `npx wrangler deploy`). Klik op *Deploy*.
4. **Wachtwoord instellen.** Open de Worker *pageturn* → *Settings → Variables and Secrets → Add*. Kies type *Secret*, naam `ADMIN_PASSWORD` en vul je wachtwoord in. Sla op met *Deploy*.
5. **Klaar.** Open het adres dat Cloudflare toont (`https://pageturn.<jouw-naam>.workers.dev`). Log in met een willekeurige gebruikersnaam en je wachtwoord, en upload je eerste boek.
6. **Eigen domein (optioneel).** Bij *Settings → Domains & Routes → Add → Custom domain* kun je bijvoorbeeld `boeken.jouwdomein.nl` koppelen, als dat domein bij Cloudflare staat.

Elke wijziging die op `main` in GitHub komt, zet Cloudflare daarna automatisch online.

Lokaal testen met Cloudflare: zet `ADMIN_PASSWORD=...` in een bestand `.dev.vars` en start `npx wrangler dev`.

## Andere hosting (Node.js)

```bash
npm install
ADMIN_PASSWORD=kies-een-wachtwoord npm start
```

Open daarna http://localhost:3000 (beheer, inloggen met een willekeurige gebruikersnaam en je wachtwoord). Elke host met Node.js 18+ en een blijvende map werkt, bijvoorbeeld een VPS, Render of Railway. Er zit een `Dockerfile` bij.

| Variabele | Betekenis |
| --- | --- |
| `ADMIN_PASSWORD` | Wachtwoord voor de beheerpagina. Verplicht instellen. |
| `DATA_DIR` | Map waar PDF's en opmerkingen worden bewaard (standaard `./data`, in Docker `/data`). Moet blijvend zijn. |
| `PORT` | Poort (standaard 3000). |

`public/viewer.html` werkt ook zonder server: open hem en sleep er een PDF in. Opmerkingen blijven dan alleen in je eigen browser.

## Opbouw

- `worker/index.js` + `wrangler.toml`: de Cloudflare-versie. Opslag in R2 onder `books/<id>/` (`book.pdf`, `meta.json`, `comments/…`).
- `server.js`: dezelfde API als Node/Express-server, met opslag in `DATA_DIR/books/<id>/`.
- `public/viewer.*`: de bladerviewer (pdf.js voor het renderen, StPageFlip voor de pageturn, eigen laag voor kaft, papierblok, rug, nietjes en spelden).
- `public/admin.html`: beheerpagina.
- `public/vendor/`: meegeleverde bibliotheken (pdf.js 4.10, StPageFlip 2.0.7, pdf-lib 1.17), zodat er geen externe CDN nodig is.
