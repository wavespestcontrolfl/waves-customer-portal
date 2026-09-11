# Liquid Glass consistency audit harness (2026-09-09)

Synthetic, frontend-only rendered-evidence runner for the customer glass
surfaces (and the admin/tech theme-scope check). No database, no real customer
records, no provider calls: every `/api/*` request is answered by the
scenario's `handle` fixture; unmatched calls 404 and are recorded; every
external origin is blocked.

## Run

```sh
export PATH=/opt/homebrew/opt/node@20/bin:$PATH        # repo pins Node 20
node scripts/qa/glass-audit/render-server-html.cjs   # optional: run.cjs renders client/glass-audit-html/ (gitignored) on demand
npm run qa:glass -- --only <id>[,<id>] --run <name>  # alias for the line below
node scripts/qa/glass-audit/run.cjs --only <id>[,<id>] --run <name> [--url http://127.0.0.1:23817] [--extra] [--engine webkit]
```

- `--url` reuses an already-running Vite dev server for this checkout (the
  audit keeps one on port 23817); without it the runner starts and stops its own.
- Widths default to 390 and 1440; `--extra` adds 320/375/430/768/1024 for
  scenarios flagged `extraWidths: true`.
- Output: `.tmp/glass-audit/<run>/<scenario>/<state>-<width>.png|json` and
  `summary.json`.
- Exit status is non-zero when any capture failed (readiness timeout, HTTP >= 400
  on navigation, screenshot or metrics error, a contrast or focus probe that
  threw, an uncaught page error, or any failed interaction); the remaining
  captures still run. `--engine` accepts only `chromium` or `webkit`, and a run
  name holds one engine: a second engine into the same `--run` is refused
  (capture files are named per state/width) — use a separate run per engine. An
  unknown `--only` id or `--family` fails before anything launches (no run
  directory, no server) instead of silently auditing less than was asked.
- `server-html` scenarios are re-rendered by `render-server-html.cjs` on every run
  that selects one, so `client/glass-audit-html/` always reflects the current
  `email-template.js` / `public-newsletter.js`. The newsletter landing pages are
  not replicas: the renderer parses `public-newsletter.js` (acorn), slices
  `renderConfirmPage` / `escapeHtml`, and evaluates each route handler's own
  `heading` / `bodyHtml` template (located by route + heading text) with fixture
  inputs, so a copy or markup change in a branch is captured on the next run and
  a missing branch exits non-zero. Their `ready` text is page-specific copy so Vite's fallback document
  can never be captured in their place.
- Same-origin iframes (the newsletter archive's `srcdoc` article) are traversed by
  the metrics collector and the contrast walker; their rows are prefixed
  `iframe>` and their boxes are in top-page coordinates. Landmarks stay
  top-document.
- Metrics notes: `controls[].inFooter` marks universal-footer controls (they are
  counted, not hidden); `contrast` composites translucent text over the sampled
  background and screens on the WORST sampled ratio (`min`, with `avg` kept for
  the digest) so text over a gradient is caught where it is least readable;
  `layout.footer.top` is in document space, `belowFold` = outside the
  initial viewport, `beyondDocument` = pushed past the document end; the focus
  probe drives real `Tab` presses (only elements in the Tab order are reported)
  and treats a `box-shadow` as a ring only when it differs from the resting
  shadow; every capture records its `engine`. `analyze.cjs` and `matrix.cjs` let
  the LAST run in argument order supersede earlier captures of the same
  scenario/state/width AND engine (a Chromium rerun never supersedes a WebKit
  capture; non-Chromium rows are labelled `[webkit]`) even when that latest capture FAILED (it is then excluded
  and listed under "Latest capture failed" / shown as `BLOCKED`, never masked by an
  older success); `matrix.cjs` derives expected states from the scenario
  declaration (honouring a state's `widths`). Interactions run in sequence on one
  page, so an interaction that needs a clean page must close what the previous one
  opened (see `account-menu` in `10-previews.cjs`); fixtures with "N ago"
  timestamps are stamped relative to the run (see `liveTrack` in `70-spa-parity.cjs`).

## Scenario contract (`scenarios/NN-<family>.cjs`)

```js
module.exports = [{
  id: 'pay-card',                 // unique, kebab-case
  family: 'document-billing',     // page family for the coverage matrix
  surface: 'customer',            // customer | admin | tech | server-html
  role: 'public token',           // who can reach it
  route: '/pay/:token',           // canonical app route pattern
  url: '/pay/' + 'a'.repeat(64),  // what the harness opens (SPA route or preview html)
  ready: 'Pay now',               // text | 'css:<selector>' | async (page) => {}
  localStorage: { waves_token: '…' },   // optional seed
  handle: ({ method, path, query, body }) => {   // API fixture; return null = unmatched
    if (method === 'GET' && path === `/api/pay/${TOKEN}`) return { body: PAYLOAD };
    return null;
  },
  extraWidths: true,              // opt into 320/375/430/768/1024 with --extra
  settle: 800,                    // ms to wait after ready before capture
  states: [                       // optional; each gets its own captures
    { name: 'default' },
    { name: 'paid', handle: (...) => ..., ready: '…' },
    { name: 'error', handle: () => ({ status: 500, body: { error: 'x' } }), ready: 'try again' },
    { name: 'reduced-motion', reducedMotion: true, widths: [390] },
    { name: 'forced-colors', forcedColors: true, widths: [390] },   // Playwright forcedColors: 'active' (Chromium)
  ],
  interactions: [                 // optional; screenshot + metrics after each
    { name: 'open-dialog', widths: [390, 1440], fullPage: false, run: async (page, { width, mobile }) => { await page.getByRole('button', { name: /…/ }).click(); } },
  ],
}];
```

Rules for fixture authors:

- Fictional data only (Jordan Rivera / 1200 Sample Lane style). Never a real
  name, address, phone, email, token, or invoice number.
- Tokens must satisfy the page's format gate (most are 64 hex chars; check
  the page and `docs/public-route-contracts.md`).
- Derive payload shapes from the page's fetch usage and the server route's
  response (`server/routes/*.js`); populate enough for the populated state.
- Do not edit application code. Scenarios and fixtures live only under
  `scripts/qa/glass-audit/`.
- A scenario is done when the run prints `[ok]` with `unmatched:0` (or the
  remaining unmatched calls are deliberately unmocked and listed in the
  scenario's `notes` field) and `err:0`, and the screenshot shows the
  populated state, not a loading or error card.
