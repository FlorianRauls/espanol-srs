# Español · SRS

A personal, single-user **spaced-repetition flashcard app for learning Spanish**, running
entirely in the browser. Mobile-first and installable (PWA). No backend, no accounts, no sync.

Built to be opened on an **iPhone in Safari** and used for quick 3-minute drills.

## Features

- **Review loop** with 4 ratings (Nochmal / Schwer / Gut / Leicht), tap-to-reveal, big touch targets.
- **Simple, correct scheduling** with learning steps + a daily new-card limit (data model is
  FSRS-ready, so it can be upgraded later with no migration — see `js/scheduler.js`).
- **Manual card creation/editing** with separate atomic fields (front, back, gender, example,
  notes, tags, direction, cloze).
- **IndexedDB persistence** for cards, an append-only review log, and settings.
- **Audio** pronunciation via the browser's built-in Web Speech API (Spanish voice, free, offline).
- **JSON export / import** — the backup safety net (no sync, so use it regularly).
- **CSV export** in Anki-friendly columns.
- **LLM features (Azure AI Foundry)**: auto-fill a card from a Spanish word, Tandem paste →
  card candidates, active production with correction, cloze/reverse variant generation, a rough
  CEFR orientation, and per-card grammar explanations.
- **Statistics**: retention, streak, due forecast, maturity distribution, activity heatmap.

The review loop, manual cards, audio, and export/import **all work offline** — only the LLM
features need a network and an Azure setup.

## How to run it

It's plain static files (no build step). The simplest path for iPhone use:

### Option A — GitHub Pages (recommended for the iPhone)
1. Put this folder in a GitHub repo and enable **Settings → Pages** (deploy from the branch).
2. Open the resulting `https://…github.io/<repo>/` URL in Safari on your iPhone.
3. Tap **Share → Add to Home Screen** to install it as an app.

> Hosting the *code* publicly is safe here: your Azure API key is **never** in the code — it
> lives only in your phone's IndexedDB, entered in Settings. The JSON export also omits the key.

### Option B — local (desktop testing)
From this folder, run any static server, e.g.:
```
python -m http.server 8080
```
then open `http://localhost:8080/`. (A service worker / install needs `localhost` or HTTPS —
it won't fully work from a raw `file://` link.)

## Azure AI Foundry setup (Settings screen)

Open **Mehr → Einstellungen** and fill in four values (nothing is hardcoded):

| Field | What to enter |
|---|---|
| **Endpoint** | Your Foundry endpoint, ending in `/openai/v1/`, e.g. `https://YOUR-RESOURCE.openai.azure.com/openai/v1/` |
| **API-Schlüssel** | Your Azure API key |
| **Deployment — Generierung** | **[your deployment name for cheap/fast tasks]** |
| **Deployment — Feedback** | **[your deployment name for stronger tasks]** |

`model` in the requests is the **Foundry deployment name**, not a model family name. The app uses
the *generation* deployment for auto-fill/splitting and the *feedback* deployment for
correction/assessment. All Azure calls go through one module (`js/llm.js`).

> Security note: the key is stored in-browser and sent directly from the browser to Azure. That's
> fine because this app is only ever run locally by you and is never hosted with the key embedded.
> If it were ever deployed publicly with a baked-in key, a small server-side proxy would be needed.

## ⚠️ Your data lives only in this browser

There is no cloud and no sync. If you clear your browser data (or lose the device), the cards and
history are gone. **Use _Mehr → Backup & Export → JSON exportieren_ regularly** and keep the file
somewhere safe. You can restore it from the same screen.

## Project layout

```
index.html              app shell + view containers
manifest.webmanifest    PWA manifest
sw.js                   service worker (offline shell)
css/styles.css          mobile-first styling
js/db.js                IndexedDB wrapper + data access
js/scheduler.js         isolated scheduling (swappable for real FSRS)
js/llm.js               isolated Azure Foundry module (the only place that knows Foundry)
js/speech.js            Web Speech API pronunciation
js/exportImport.js      JSON backup + Anki CSV
js/stats.js             statistics from the review log
js/app.js               router + views + wiring
icons/                  PWA / home-screen icons
```
