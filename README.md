# Waves Pest Control — Operations Platform

AI-native operations platform for Waves Pest Control & Lawn Care (SW Florida).
One monorepo serves three surfaces plus the automation that runs the business:

- **Admin portal** (`/admin/*`) — owner/CSR dashboard: dispatch, customers,
  estimates, communications, revenue, SEO/content, and the ⌘K Intelligence Bar.
- **Customer portal** (`/`) — customer-facing PWA: service tracking, reports,
  payments, referrals.
- **Tech portal** (`/tech/*`) — field technician mobile app: route, protocols,
  service completion, estimating.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite (dual style system — see `CLAUDE.md`) |
| Backend | Node.js + Express + Knex.js |
| Database | PostgreSQL on Railway (migrations in `server/models/migrations/`) |
| Payments | Stripe — Payment Element (card/Apple Pay/Google Pay/ACH) + Terminal Tap-to-Pay via `ios/WavesPay` |
| SMS/Voice | Twilio (messaging, voice recording + transcription, Lookup) |
| AI | Anthropic Claude (+ routed OpenAI/Gemini for specific features) — model tiers in `server/config/models.js`, never hardcode model IDs |
| Storage | AWS S3 (service photos, report assets) |
| Hosting | Railway (`railway.toml`, plus `railway.seo-worker.toml`) |

The marketing/SEO site (hub + spoke fleet) is a **separate repo**
(`wavespestcontrolfl/wavespestcontrol-astro`) deployed to Cloudflare Pages;
this repo's content engine writes blog posts into it via PR.

## Layout

```
server/            Express API — routes/ (160+), services/ (business logic,
                   intelligence-bar/, pricing-engine/, content/, dispatch/, …),
                   models/migrations/ (Knex), middleware/, utils/, tests/
client/            React app (all three portals)
packages/          Workspaces: blog-schema, lawn-cost-floor
ios/WavesPay       Stripe Terminal companion app (xcodegen; project.yml is SoT)
ops/twilio/        Studio flow contract (legacy rollback path)
scripts/           Operational scripts + git hooks (hooks/pre-push = Codex audit)
docs/              Runbooks (DEPLOYMENT.md), design system (design/DECISIONS.md), audits
wiki/              Dispatch/service protocols (seeded into the in-app knowledge base)
.claude/skills/    Claude Code skills (ship flow, DB safety, billing, content)
```

## Development

```bash
npm install          # also wires the Codex pre-push hook (core.hooksPath)
cp .env.example .env # DATABASE_URL is required — `predev` runs migrations
npm run dev          # API :3001 + Vite :5173
```

Key commands:

- `npm run db:migrate` / `db:rollback` — Knex (always via `server/knexfile.js`)
- `npm run check:portal-brand` — customer-surface brand gate; **runs in Railway
  `prebuild` and a violation fails every deploy** — run before pushing `client/`
- `npm run verify:blog-schema` — blog schema vendor check (also in `prebuild`)
- `npm test` / `npm run test:contracts` — server tests / contract tests
- `npm run models:check` — compare available Anthropic models vs current tiers

## Deployment

Railway only — project `waves-pest-control`. Config-as-code in `railway.toml`
(health check, pre-deploy migrations). See `docs/DEPLOYMENT.md` for the full
runbook. User-visible features ship dark behind `GATE_*` env switches
(see `.env.example`).

## Where the real documentation lives

- `CLAUDE.md` — architecture, design systems, Intelligence Bar, rules
- `AGENTS.md` — code-review rulebook (P0/P1) used by the Codex hook + bot
- `CODEX.md` — sandbox/DB setup for agent sessions
- `docs/design/DECISIONS.md` — append-only architectural decision log
- `.claude/skills/` — operating procedures for ship flow, DB, billing, content
