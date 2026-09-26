# PostHog — session replay + funnel analytics (runbook)

Customer-acquisition funnel instrumentation across the **marketing site** (astro,
`wavespestcontrol.com`) and the **public portal pages** (`portal.wavespestcontrol.com`).
Ships **dark** — nothing loads until a PostHog key is provisioned, so it can be
merged ahead of go-live.

Tool: **PostHog Cloud (US)**. Not a replacement for `GATE_*` flags — those stay
server-side env booleans. PostHog flags are reserved for *new* funnel A/B tests.

## What's in the code

| Repo | Files |
|---|---|
| astro | `src/components/PostHogAnalytics.astro` (loader, consent-gated), `src/lib/analytics/events.ts` (taxonomy + `track()`), `src/components/CookieBanner.tsx` (now drops a `.wavespestcontrol.com` consent cookie), `BaseLayout.astro` (mounts loader), instrumentation in `EstimateForm/LeadForm/QuoteForm/SliderForm` |
| portal | `client/src/lib/analytics/posthog.js` (loader, path-scoped), `client/src/lib/analytics/events.js` (taxonomy + `track()`), `client/src/components/analytics/PublicFunnelTracking.jsx` (self-gating consent + boot, mounted in `App.jsx`), instrumentation in `PublicBookingPage.jsx`, CSP opened in `server/index.js` |

Scope guard: portal PostHog initializes with consent for the retained `/book`
acquisition route and without cookies for explicit events on
`/estimate/:token`. Public estimate and quote pages permanently redirect to the
marketing site, whose own PostHog loader owns their pageviews. Portal tracking
never loads on `/admin`, `/tech`, the authenticated customer portal, or other
tokenized customer pages such as `/pay/:token` and `/book/:token`. The
tokenized-estimate exception uses memory persistence, disables replay and
automatic pageviews, and emits only explicit redacted events. A `before_send`
hard-gate drops any event/replay snapshot fired
off-funnel after a client-side navigation **and** strips the query/hash from the
URL + referrer so a lead id never lands in an automatic pageview; the recorder
is also stopped on funnel exit.

Replay masks **all** input values AND **all** rendered text
(`maskTextSelector: '*'`) on **both** the marketing site and the portal funnel,
and **autocapture is off** on both — so no rendered name/phone/address, Google
Places suggestion, or href carrying a lead id can reach PostHog. Heatmaps (which
need autocapture) are a deliberate later opt-in after a PII audit. Funnel signal
comes from the explicit events + `$pageview`, which don't depend on autocapture.

The marketing `CookieBanner` backfills the `.wavespestcontrol.com` consent
cookie for visitors who opted in before this shipped (localStorage set, cookie
absent), so the marketing→portal handoff keeps stitching for existing users.

## Owner provisioning steps

1. Create a **PostHog Cloud US** project (https://us.posthog.com). Copy the
   **Project API key** (`phc_…`).
2. **Astro** (Cloudflare Pages env, all relevant builds):
   - `PUBLIC_POSTHOG_KEY=phc_…`
   - `PUBLIC_POSTHOG_HOST=https://us.i.posthog.com` (default; only set to override —
     or `PUBLIC_POSTHOG_HOST=https://portal.wavespestcontrol.com/ingest` to use the
     portal's first-party proxy, dark behind `GATE_POSTHOG_INGEST_PROXY`, if
     ad-blocker loss matters more than the extra hop; the Astro sites run on other
     origins, so the host must be absolute)
3. **Portal** (Railway, client build env — Vite reads these at build time):
   - `VITE_POSTHOG_KEY=phc_…`
   - `VITE_POSTHOG_HOST=https://us.i.posthog.com` (default, or `/ingest` with the
     proxy gate on)
4. Redeploy both. Verify consent-gated `/book` network calls appear only after
   accepting the cookie banner. Separately verify that `/estimate/:token` can
   emit only its explicit cookieless events, with memory persistence and no
   replay or automatic pageviews. Verify no calls appear on `/admin` or `/tech`.
5. In PostHog → **Settings → Replay**: set a recording **sampling rate** (start
   ~50–100% given low traffic; dial down later). Confirm "Mask all inputs" is on.

## Event taxonomy (the funnel)

Marketing (astro · `events.ts`):
`estimate_viewed → estimate_intake_submitted → estimate_property_measured →
estimate_confirm_submitted → estimate_quote_shown → estimate_book_cta_clicked`
(plus `estimate_property_lookup_failed`, `estimate_callback_shown`,
`lead_submitted` / `lead_form_viewed` / `lead_form_step_completed`).

Portal (`events.js`):
`booking_viewed → booking_service_selected → booking_availability_loaded →
booking_slot_selected → booking_contact_started → booking_confirmed`
(plus `booking_ai_search_used`). `estimate_accepted` is emitted after a
successful estimate acceptance in `EstimateViewPage`; `estimate_accept_opened`
is defined in the taxonomy but has no caller yet.

**The cross-property funnel to build in PostHog UI** (one funnel, both hosts —
they stitch via the shared `.wavespestcontrol.com` cookie):

```
estimate_viewed
  → estimate_intake_submitted
  → estimate_property_measured
  → estimate_quote_shown
  → estimate_book_cta_clicked      (handoff: wavespestcontrol.com → portal)
  → booking_viewed
  → booking_slot_selected
  → booking_confirmed
```

All event properties are PII-safe (service, city/zip, sqft, money-as-number,
booleans). No name/email/phone/full-address is ever sent as a property.

## Privacy / PII

- **Card data is never captured** — Stripe Payment Element is an iframe; raw PAN
  never touches the DOM.
- Replay masks **all input values** by default. PII *text nodes* (e.g. the
  "Customer found" name/address on the booking review) are tagged `.ph-mask`.
  Convention: tag any new PII text with `class="ph-mask"`; un-mask safe controls
  with `class="ph-no-mask"`.
- Consent: the marketing banner now writes a `.wavespestcontrol.com` cookie so
  the choice carries to the portal subdomain. Direct-to-portal visitors get a
  slim notice from `PublicFunnelTracking`.

## Known seams (by design, for now)

- **Spoke domains** (e.g. `bradentonpestcontrol.com`) → portal is true
  cross-domain and will **not** stitch into one person (different registrable
  domain). Hub → portal stitches cleanly. Estimate pages are hub-only today, so
  the main funnel is unaffected. Revisit with PostHog cross-domain linking if a
  spoke gets the estimate flow.
- **`/book` iframe embed**: the portal's own snippet records booking as its own
  (cookie-stitched) session; we don't fight iframe replay.

## Turning it off

Unset `PUBLIC_POSTHOG_KEY` / `VITE_POSTHOG_KEY` and redeploy — the loaders no-op
and nothing renders (including the portal consent notice).
