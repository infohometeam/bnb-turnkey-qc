# BNB Turnkey QC System — Free Edition

**$0/month** — SQLite + Gemini Free Tier

## What's Free

| Component | Free Option | Limitation |
|-----------|-------------|------------|
| Database | SQLite (file on disk) | Single-server only (fine for your volume) |
| AI Scoring | Gemini Free Tier | 15 requests/min, 1M tokens/day (~50 calls) |
| Hosting | Run locally or Render free tier | Render sleeps after 15min inactivity |
| Everything else | Included | None |

## Setup (5 minutes)

### 1. Get a Gemini API Key (free)
You already have one from your Google Scripts! Or get a new one:
→ https://aistudio.google.com/apikey

### 2. Install & Configure
```bash
cd bnb-qc-free
npm install

# Copy and edit config
cp .env.example .env
# Paste your GEMINI_API_KEY and set a WEBHOOK_SECRET_KEY
```

### 3. Create Database
```bash
npm run migrate
```
This creates `./data/qc.db` with all tables and seeds the BNB Turnkey rubric.

### 4. Start
```bash
npm start
```

You'll see:
```
  ╔═══════════════════════════════════════════════════╗
  ║   BNB Turnkey QC System — FREE EDITION           ║
  ║   The Rise Collective                            ║
  ║   Stack: SQLite + Gemini Free Tier                ║
  ║   Monthly cost: $0                               ║
  ╚═══════════════════════════════════════════════════╝
```

### 5. Point Webhooks Here
Update your Fathom and Aloware webhook URLs to:
```
http://localhost:3001/api/webhook?src=fathom-closers-1&key=YOUR_SECRET
http://localhost:3001/api/webhook?src=fathom-closers-2&key=YOUR_SECRET
http://localhost:3001/api/webhook?src=aloware-setters&key=YOUR_SECRET
```

For remote access (so Fathom/Aloware can reach your local machine), use:
- **ngrok**: `ngrok http 3001` (free, gives you a public URL)
- **Render free tier**: Push to GitHub → deploy on render.com

## API Quick Test
```bash
# Health check
curl http://localhost:3001/health

# View all calls
curl http://localhost:3001/api/calls

# View analytics
curl http://localhost:3001/api/analytics?period=week

# Manually trigger QC processing
curl -X POST http://localhost:3001/api/queue/process?max=3

# Retry all failed calls
curl -X POST http://localhost:3001/api/queue/retry-all
```

## Upgrading to Paid Later

When you're ready to upgrade (better AI scoring, hosted database, etc.):

| Upgrade | What Changes | Cost |
|---------|-------------|------|
| Claude API | Swap `gemini.js` → `claude.js` | ~$10-20/mo |
| PostgreSQL | Swap SQLite → Postgres (Supabase/Neon free tier or Railway) | $0-20/mo |
| Hosting | Railway or Render paid | $5-20/mo |

The code architecture is identical — just swap the AI service file. Everything else (ingestion, prompts, worker, API routes) stays the same.

## File Structure
```
bnb-qc-free/
├── src/
│   ├── index.js              # Express server + cron
│   ├── db.js                 # SQLite connection
│   ├── routes/
│   │   ├── webhooks.js       # Webhook receiver
│   │   └── api.js            # REST API (14 endpoints)
│   ├── services/
│   │   ├── gemini.js         # Gemini Free Tier API
│   │   ├── ingestion.js      # Payload parsing + dedup
│   │   ├── transcript.js     # Smart slicing (BNB keywords)
│   │   └── prompts.js        # QC prompt with BNB context
│   └── workers/
│       └── qcWorker.js       # Queue processor
├── migrations/
│   └── run.js                # Creates tables + seeds rubric
├── data/
│   └── qc.db                 # SQLite database (created on migrate)
├── .env.example
├── package.json
└── README.md
```
