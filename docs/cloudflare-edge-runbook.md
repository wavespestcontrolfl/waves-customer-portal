# Cloudflare Edge Runbook — bot/WAF exemptions + dashboard hardening

_Last updated: 2026-06-27_

Manual runbook for the Cloudflare edge config that fronts both properties. These
steps are **dashboard actions** — the Cloudflare MCP token available to tooling is
read-limited (it can list zones/DNS/rulesets but cannot read zone settings or write
cache/WAF rules), so the changes below are done by hand in the Cloudflare dashboard.

## Context (architecture)

All Waves web traffic is proxied (orange-cloud) through Cloudflare:

- **`wavespestcontrol.com` (apex + `www`)** → CNAME to `wavespestcontrol-astro.pages.dev`
  (Cloudflare Pages, static Astro hub). Zone plan: **Pro**.
- **17 city domains** (e.g. `sarasotaflpestcontrol.com`) → their own Cloudflare Pages
  projects. Each is a separate **Free** zone.
- **`portal.wavespestcontrol.com`** → CNAME to `*.up.railway.app` (the Node portal /
  `/api`). Lives on the **same Pro zone** as the apex marketing site.

Because the portal shares the Pro zone with the marketing apex, any zone-wide bot/WAF
setting on `wavespestcontrol.com` also applies to the portal. The portal receives
**inbound server-to-server webhooks** whose callers cannot solve a JS/CAPTCHA
challenge — so they must be exempted **before** any bot/WAF tightening, or they fail
silently (broken payments, SMS, GPS, email-event sync).

---

## 1. Inbound webhook skip-list (do this FIRST, before any bot/WAF change)

These are automated server-to-server (or first-party app) callers that **cannot solve a
JS/CAPTCHA challenge** — a bot/WAF rule would black-hole them. Their app-layer auth
**varies** (see the **Auth in app** column), so the edge bypass is not uniformly backed
by a replay-safe signature:

- **Provider signature (replay-safe):** Stripe (`/api/stripe/webhook`), SendGrid, Resend,
  Twilio. These are the strongest — a forged request fails the signature check.
- **First-party bearer:** Stripe Terminal (`/api/stripe/terminal/*`) — a scoped Bearer
  JWT issued to the WavesPay iOS app, not an external provider.
- **Shared-secret header (no replay protection):** Bouncie and the voice-agent callback.
- **No app auth:** `/api/health` — a public liveness probe that exposes no data.

Skipping the edge bot/WAF check does **not** remove these app-layer checks. But treat the
shared-secret and no-auth rows as the weakest links: keep them path-exact (as below) and
re-evaluate before any of them is ever changed to return sensitive data.

**Cloudflare expression** — enumerate the server-to-server webhook prefixes
**explicitly**. Do **not** use a blanket `starts_with(…, "/api/webhooks/")`: the
browser-origin `/api/webhooks/lead` intake route lives under that same tree and must
stay protected (see the warning below). Scoped to the portal host so it never loosens
the marketing site:

```
(http.host eq "portal.wavespestcontrol.com" and (
  starts_with(http.request.uri.path, "/api/webhooks/twilio/") or
  starts_with(http.request.uri.path, "/api/webhooks/sendgrid/") or
  starts_with(http.request.uri.path, "/api/webhooks/resend/") or
  starts_with(http.request.uri.path, "/api/webhooks/bouncie") or
  starts_with(http.request.uri.path, "/api/webhooks/voice-agent/") or
  http.request.uri.path eq "/api/stripe/webhook" or
  starts_with(http.request.uri.path, "/api/stripe/terminal/") or
  http.request.uri.path eq "/api/bouncie" or
  http.request.uri.path eq "/api/health"
))
```

| Path (prefix) | Method | Provider | Auth in app |
|---|---|---|---|
| `/api/stripe/webhook` | POST | Stripe | `Stripe-Signature` (raw body, `constructEvent`) |
| `/api/stripe/terminal/*` | POST | WavesPay iOS (Tap-to-Pay, first-party) | bearer / handoff token |
| `/api/webhooks/sendgrid/*` | POST | SendGrid event webhook | ECDSA sig over raw body |
| `/api/webhooks/resend/*` | POST | Resend (dormant until secret set) | Svix HMAC |
| `/api/webhooks/twilio/*` | POST | Twilio SMS + voice (sms/status/voice/call/recording/transcription) | `X-Twilio-Signature` |
| `/api/webhooks/bouncie*` | POST/GET | Bouncie GPS (`/bouncie`, `/bouncie/ping`) | shared secret header |
| `/api/webhooks/voice-agent/*` | POST | Voice-AI agent callback (gated off today — pre-added) | shared-secret Bearer (`VOICE_AGENT_WEBHOOK_SECRET`) |
| `/api/bouncie` | POST | Bouncie mileage webhook — **exact match**, leaves the `/api/bouncie/callback` OAuth redirect protected | shared secret header |
| `/api/health` | GET | Railway healthcheck probe | none (public) |

> **⚠️ Why explicit prefixes, not the whole `/api/webhooks/` tree:** `/api/webhooks/lead`
> (website lead-form intake — `server/index.js:355`) lives under that path but is
> **browser-originated** and must **keep** bot protection — it's a spam target and accepts
> PII. A blanket `starts_with(…, "/api/webhooks/")` skip would silently expose it.
> (`/api/leads` — `server/index.js:356` — is the **same handler mounted at a separate
> path**, *not* under `/api/webhooks/`, so a webhooks-tree skip would not reach it; it is
> likewise browser-origin and must stay protected.) When a new server-to-server webhook
> provider is onboarded, add its prefix to the expression **deliberately**.

**Lead-form caveat:** the Astro forms post cross-subdomain (apex → portal host), so after
enabling any bot rule, **submit a real test lead** — if legitimate submissions get
challenged, protect `/api/webhooks/lead` + `/api/leads` with **Cloudflare Turnstile**
rather than adding them to this skip-list.

---

## 2. Dashboard steps

### A. Confirm SSL mode is `Full (strict)` — the one dangerous misconfig to rule out

`wavespestcontrol.com` → **SSL/TLS → Overview**. Mode must be **Full (strict)**. Both
origins have valid certs (Pages `*.pages.dev`, Railway `*.up.railway.app`), so it works.
If it says **Flexible**, fix it — Flexible sends Cloudflare→origin traffic in plaintext
and can cause redirect loops.

Then **SSL/TLS → Edge Certificates**: Always Use HTTPS = On, Minimum TLS = 1.2,
Automatic HTTPS Rewrites = On. (HSTS is already live — confirmed via response header.)

### B. Bot protection (Super Bot Fight Mode — Pro zone)

SBFM on `wavespestcontrol.com` applies to the **whole zone** (apex marketing site **and**
portal). Order matters:

1. **First** create the Skip rule — **Security → WAF → Custom rules → Create** →
   action **Skip** → check **"Super Bot Fight Mode"** (and "All managed rules") →
   paste the expression from §1 → deploy it at the **top** of the rule list.
2. **Then** enable SBFM — **Security → Bots**: "Definitely automated" → **Managed
   Challenge** (safer than Block to start), "Verified bots" → **Allow**.
3. **Verify**: submit a test lead form + run one test payment and one test SMS to
   confirm nothing legitimate is challenged.

The 17 city domains are separate **Free** zones, each with its own simpler "Bot Fight
Mode" toggle. No portal traffic on them → lower risk → a good place to be more
aggressive against scrapers.

### C. (Optional, low priority) Edge-cache HTML

Only if desired. **Caching → Cache Rules → Create** → expression
`(http.host eq "wavespestcontrol.com")` → "Eligible for cache" + Edge TTL ~1–2h.

**Caveat:** these are Cloudflare Pages sites, so HTML is already served from the nearest
edge PoP — the gain is marginal, and you'd then have to purge cache on every Pages deploy
or pages go stale. **Recommendation: skip it.** Static-asset caching (the real CWV win)
is already handled in the Astro repo's `public/_headers` (immutable 1-year cache on
`/_astro/*`, `/images/*`, `/fonts/*`, `/*.css`, images).

---

## Notes

- DNS / email hygiene is already strong: SPF (`include:_spf.google.com`), DKIM (Google +
  SendGrid s1/s2), DMARC at `p=reject` (50% sampling, aggregate reporting). Nothing to
  change there.
- WAF managed rulesets present on the Pro zone: OWASP Core, Cloudflare Managed,
  Exposed-Credentials, DDoS L7. (Their on/off state was not readable via the limited MCP
  token — verify in **Security → WAF → Managed rules** if tuning.)
