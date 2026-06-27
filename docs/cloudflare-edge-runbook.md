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

Every inbound webhook below is already signature-verified in the app, so skipping it
at the edge loses no security — it only prevents a challenge from black-holing
automated callers.

**Cloudflare expression** (scoped to the portal host so it never loosens the
marketing site):

```
(http.host eq "portal.wavespestcontrol.com" and (
  starts_with(http.request.uri.path, "/api/webhooks/") or
  http.request.uri.path eq "/api/stripe/webhook" or
  starts_with(http.request.uri.path, "/api/stripe/terminal/") or
  http.request.uri.path eq "/api/bouncie" or
  http.request.uri.path eq "/api/health"
))
```

| Path | Method | Provider | Auth in app |
|---|---|---|---|
| `/api/stripe/webhook` | POST | Stripe | `Stripe-Signature` (raw body, `constructEvent`) |
| `/api/stripe/terminal/*` | POST | WavesPay iOS (Tap-to-Pay, first-party) | bearer / handoff token |
| `/api/webhooks/sendgrid/events` | POST | SendGrid event webhook | ECDSA sig over raw body |
| `/api/webhooks/resend/events` | POST | Resend (dormant until secret set) | Svix HMAC |
| `/api/webhooks/twilio/sms` | POST | Twilio inbound SMS | `X-Twilio-Signature` |
| `/api/webhooks/twilio/status` | POST | Twilio SMS status callback | `X-Twilio-Signature` |
| `/api/webhooks/twilio/voice` + voice/call/recording/transcription callbacks | POST | Twilio voice | `X-Twilio-Signature` |
| `/api/webhooks/bouncie` + `/bouncie/ping` | POST/GET | Bouncie GPS telematics | shared secret header |
| `/api/bouncie` | POST | Bouncie mileage webhook | shared secret header |
| `/api/health` | GET | Railway healthcheck probe | none (public) |

**Deliberately NOT skipped — `/api/webhooks/lead` and `/api/leads`** (website lead-form
intake). These are browser-originated and should *keep* bot protection (they're a spam
target). **Caveat:** the Astro forms post cross-subdomain (apex → portal host), so after
enabling any bot rule, **submit a real test lead** — if legitimate submissions get
challenged, protect those two paths with **Cloudflare Turnstile** rather than adding
them to this skip-list.

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
</content>
</invoke>
