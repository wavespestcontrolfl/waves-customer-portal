# Waves Pest Control — Customer Portal

A full-stack customer portal for Waves Pest Control, integrating **Twilio** (SMS notifications), **Stripe** (payments/invoicing), and a **React** frontend.

## Architecture

```
waves-portal/
├── server/                  # Node.js + Express API
│   ├── config/              # Environment & service configuration
│   ├── middleware/           # Auth, error handling, rate limiting
│   ├── models/              # Database schemas (PostgreSQL via Knex)
│   ├── routes/              # REST API endpoints
│   ├── services/            # Twilio, Stripe, and business logic
│   └── index.js             # Server entry point
├── client/                  # React frontend (Vite)
│   └── src/
│       ├── components/      # Reusable UI components
│       ├── pages/           # Tab/page-level views
│       ├── hooks/           # Custom React hooks
│       ├── utils/           # API client, helpers
│       └── styles/          # Global styles & theme
├── scripts/                 # DB migrations, seed data
├── docs/                    # API documentation
├── .env.example             # Required environment variables
├── package.json             # Root package.json (workspaces)
└── docker-compose.yml       # Local dev environment
```

## Tech Stack

| Layer       | Technology                        |
|-------------|-----------------------------------|
| Frontend    | React 18 + Vite + TailwindCSS     |
| Backend     | Node.js + Express                 |
| Database    | PostgreSQL via Knex.js             |
| Auth        | JWT + bcrypt (phone/email login)   |
| SMS         | Twilio Programmable Messaging      |
| Payments    | Stripe (Payment Element)           |
| File Storage| AWS S3 (service photos)            |
| Hosting     | Railway / Render / Vercel          |

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL 14+
- Twilio account (Account SID, Auth Token, Phone Number)
- Stripe account (Secret Key, Publishable Key, Webhook Secret)

### Setup

```bash
# 1. Clone and install
git clone <repo-url> && cd waves-portal
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your API keys

# 3. Run database migrations
npm run db:migrate

# 4. Seed sample data
npm run db:seed

# 5. Start development
npm run dev
```

This starts both the API server (port 3001) and React dev server (port 5173).

### Environment Variables

See `.env.example` for all required variables. At minimum you need:

- `DATABASE_URL` — PostgreSQL connection string
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
- `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`
- `JWT_SECRET` — random 64-char string for auth tokens
- `S3_BUCKET` — for service photo uploads

## API Endpoints

See `docs/API.md` for full documentation. Key routes:

- `POST /api/auth/login` — SMS-based login (sends Twilio verification code)
- `GET  /api/customers/:id` — Customer profile + tier info
- `GET  /api/services/:customerId` — Service history with tech notes
- `GET  /api/schedule/:customerId` — Upcoming service appointments
- `POST /api/schedule/:id/confirm` — Confirm an appointment
- `GET  /api/billing/:customerId` — Payment history (Stripe)
- `POST /api/billing/update-card` — Update payment method (Stripe)
- `PUT  /api/notifications/preferences` — Update SMS preferences

## Deployment

Recommended: **Railway** (easiest for full-stack Node + Postgres)

1. Push to GitHub
2. Connect Railway to repo
3. Add PostgreSQL plugin
4. Set environment variables
5. Deploy — Railway auto-detects the start script

Alternative: Vercel (frontend) + Render (API) + Supabase (DB)
