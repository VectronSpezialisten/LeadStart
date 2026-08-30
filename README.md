# Leadstart

Eigenständige Lead-Erfassungs-Anwendung für Thiede & Brauer GmbH.
Prüft eingehende Leads sofort gegen weclapp (Kontakt- und Firmen-Duplikat-Check)
und ergänzt eine Perplexity-Recherche, falls Firma/Gaststätte nicht eindeutig ist.

## Aufbau

- `index.html` — Formular (Name, Telefon, E-Mail, Firma/Betriebsstätte)
- `netlify/functions/leadstart.js` — komplette Backend-Logik als Netlify Function
- `netlify.toml` — Netlify-Konfiguration

Kein n8n, kein separates Backend — läuft komplett auf Netlify.

## Einrichtung

### 1. Repository auf GitHub anlegen
Dieses Verzeichnis in ein neues GitHub-Repository pushen (z.B. `leadstart`).

### 2. Mit Netlify verbinden
In Netlify: "Add new site" → "Import an existing project" → GitHub-Repo auswählen.
Build-Einstellungen können leer bleiben (kein Build-Schritt nötig, reine statische
Dateien + Functions).

### 3. Umgebungsvariablen setzen
In den Netlify Site-Settings unter "Environment variables":

| Variable | Wert |
|---|---|
| `WECLAPP_DOMAIN` | `thiedebrauer.weclapp.com` |
| `WECLAPP_API_TOKEN` | euer weclapp AuthenticationToken |
| `PERPLEXITY_API_KEY` | euer Perplexity API-Key (ohne "Bearer ") |

**Wichtig:** Diese Werte gehören ausschließlich in die Netlify-Umgebungsvariablen,
niemals in den Code oder ins Repository.

### 4. Deploy
Nach dem Verbinden deployt Netlify automatisch. Jeder weitere `git push`
löst automatisch ein neues Deployment aus.

### 5. Testen
Formular auf der ausgelieferten Netlify-URL öffnen, mit einem bekannten
weclapp-Kontakt testen, Ergebnis prüfen.

## Sicherheitshinweis

`leadstart.js` enthält keine Zugangsdaten im Code — alle Secrets kommen aus
Umgebungsvariablen (`process.env.*`). Das Repository kann daher grundsätzlich
auch privat auf GitHub liegen, ohne dass beim versehentlichen Öffentlichmachen
Zugangsdaten offengelegt würden — trotzdem sollte es aus Prinzip privat bleiben.
