# Liquid Glass consistency audit harness (2026-09-09)

Synthetic, frontend-only rendered-evidence runner for the customer glass
surfaces (and the admin/tech theme-scope check). No database, no real customer
records, no provider calls: every `/api/*` request is answered by the
scenario's `handle` fixture; unmatched calls 404 and are recorded; every
external origin is blocked.

## Run

```sh
export PATH=/opt/homebrew/opt/node@20/bin:$PATH        # repo pins Node 20
node scripts/qa/glass-audit/render-server-html.cjs   # once per checkout: writes client/glass-audit-html/ (gitignored) for the server-html scenarios
npm run qa:glass -- --only <id>[,<id>] --run <name>  # alias for the line below
node scripts/qa/glass-audit/run.cjs --only <id>[,<id>] --run <name> [--url http://127.0.0.1:23817] [--extra] [--engine webkit]
```

- `--url` reuses an already-running Vite dev server for this checkout (the
  audit keeps one on port 23817); without it the runner starts and stops its own.
- Widths default to 390 and 1440; `--extra` adds 320/375/430/768/1024 for
  scenarios flagged `extraWidths: true`.
- Output: `.tmp/glass-audit/<run>/<scenario>/<state>-<width>.png|json` and
  `summary.json`.

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
