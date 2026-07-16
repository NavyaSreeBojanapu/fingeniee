# FinGenie

AI financial wellness & loan transparency demo. A single Express server
serves both the REST API and the static frontend, so the whole app runs
from one process on one port.

## Project structure

```
fingenie/
  server.js         Express API + static file server
  package.json
  index.html         Frontend markup
  styles.css          Frontend styling
  app.js              Frontend logic (calls the API via fetch)
  .gitignore
  .env.example
  LICENSE
  README.md
```

## Run it locally

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

Then open **http://localhost:4000** in your browser. Sign up for an
account on the auth screen, then sign in — everything (agent console,
debate room, leak scanner, digital twin, loan analyzer, etc.) is served
from that same URL.

To use a different port:

```bash
PORT=5000 npm start
```

## What's in the API

All endpoints live under `/api` and are implemented in `server.js`,
using an in-memory store (swap for a real database for production use):

- `POST /api/auth/register`, `/login`, `/recover/question`, `/recover/verify`
- `GET  /api/overview` — dashboard stats
- `POST /api/agents/chat` — agent console replies
- `GET  /api/debate/:topic` — AI debate room scripts
- `GET/POST /api/family` — family workspace
- `GET  /api/stability` — Financial Stability Engine
- `POST /api/leak-scan` — Money Leak Detector
- `POST /api/twin/project` — Digital Twin compound-growth projection
- `POST /api/loan/analyze` — Loan document analyzer (mock)
- `GET  /api/trust/sessions`, `/events` — Trust Center
- `GET  /api/admin/stats`, `/users` — Admin Panel

## Setting up a git repository

From inside this folder:

```bash
git init
git add .
git commit -m "Initial commit — FinGenie full-stack app"
```

Then connect it to a remote (e.g. on GitHub):

```bash
git remote add origin https://github.com/<your-username>/<your-repo>.git
git branch -M main
git push -u origin main
```

`node_modules/` and `.env` are already excluded via `.gitignore`, so
anyone who clones the repo just runs `npm install` and `npm start`.

## Notes

This is a working demo — figures, agent replies, debate arguments, and
loan-document flags are illustrative, not real financial data or advice.
