---
name: ui-verify
description: Verify rendered Waves UI changes locally or before PR review — render the page, inspect desktop and mobile screenshots, and exercise changed interactions. Not for server-internal changes that do not affect rendered output.
---

# Vision-verify UI changes before review

Tests and a clean build do not prove a UI change looks right. Before tagging
Codex on a UI-touching PR:

## Inputs and tool availability

Identify the changed surfaces, expected behavior, selected checkout,
target environment, and synthetic test account or fixture before starting.
Inspect available browser tools before choosing commands. Use an available
Chrome DevTools or Playwright tool, or the selected checkout's existing
browser-QA script. Do not assume an MCP declaration means a tool is loaded.

If the required browser, safe backend, or fixture is unavailable, continue
independent authorized checks and report the exact missing prerequisite.
Do not claim browser interaction or screenshot review. Installing tools,
enabling integrations, and creating fixtures remain subject to task scope
and existing permissions.

Use only safe fixture/test flows for interactions. Preserve the prohibition
on exercising real customer records or payment flows with live credentials.

## Procedure

1. Run the app in the background and navigate to the changed page with the
   available browser tool or existing QA script. For client-only changes
   use `npm run dev:managed-client` after `worktree:setup` and frontend
   `dev:doctor` (or standalone `dev:client`). Full managed `dev` checks
   the dedicated dev database without migrating; follow `docs/development.md`.
   Codex sessions must never connect to production. Reserve full `npm run dev` for
   server-rendered or backend-dependent pages, against a dev/preview DB.
2. Screenshot at TWO widths minimum: desktop (~1440) and mobile (390 —
   Virginia and the techs live on phones). With Chrome DevTools, use
   `resize_page` then `take_screenshot` with a distinct `filePath` per width (e.g.
   `<scratchpad>/desktop-1440.png`, `<scratchpad>/mobile-390.png`) —
   without `filePath` the image is attached to the tool response only and
   there is no file to hand to step 5. With another browser tool or script,
   save equivalent artifacts at both widths.
3. Read the screenshots with vision and check, explicitly:
   - Does the rendered result match what the task asked for?
   - Admin pages: monochrome V2 rules — `components/ui` primitives, zinc
     ramp, `border-hairline`; red (`alert-fg`) ONLY for genuine alerts;
     14px minimum readable text; no customer-brand styling inside
     `/admin/*`.
   - Customer surfaces: warm tone per
     `docs/design/waves-customer-facing-design-brief.md` — do NOT apply the
     admin spec.
   - Nothing else on the page regressed (check the whole viewport, not just
     the changed element).
4. Interact with what you changed (click the button, open the modal, submit
   the form) — a screenshot of initial render misses broken states.
5. For a PR task, put screenshots/findings in the PR description. For a
   local-only task, report local artifact paths and findings. When publishing
   evidence, attach the step-2 files natively: `gh pr create
   --attach <file>` on a new PR, `gh pr edit --attach <file>` to update an
   existing PR's description (`gh` ≥ 2.99.0; alt text via
   `--attach './mobile-390.png#Mobile 390'`). Never a local path, a
   base64 blob, or an external image host. If `gh --version` is below
   2.99, write the findings in the PR body as text and say the screenshots
   were reviewed in-session but not attached. Details and limits are in
   waves-ship §4.

## Additional checks

- New `top:0` fixed/sticky headers, bottom bars, or full-screen overlays:
  verify safe-area padding on an iPhone-sized viewport — `viewport-fit=cover`
  is global in the standalone PWA and desktop Chrome emulation does NOT
  reproduce notch/status-bar overlap (see waves-design hard lines).
- When jsdom-only checks aren't enough, a full local stack is workable:
  scratch `createdb` + `migrate:latest` (~10 min), seed an admin
  `technicians` row + a customer, run server with `DATABASE_URL`/`JWT_SECRET`
  + `npm run dev` in `client/`, login via `/api/admin/auth/login` and stash
  `waves_admin_token` in localStorage. Routing trap: admin Customer 360 is a
  PANEL at `/admin/customers?customerId=<id>` — `/admin/customers/<id>`
  falls through to the customer login.
- NEVER verify against a real customer's live record — use the staff
  `adminDraftPreview` path or owner-created test records. On a real
  estimate page, frequency-tab clicks POST selection events even in
  adminPreview: inspect the payload JSON, never click.

## Estimate UIs specifically

The canonical spec for estimate-facing UI is the **server-rendered**
`server/routes/estimate-public.js`. React estimate views mirror it — when
specs are ambiguous, match the existing estimate UI rather than asking.

## When this is mandatory

- Any change under `client/src/` that alters rendered output.
- Any server-rendered page change (`estimate-public.js`, prep guides, /pay).
- Email/newsletter template changes: render the HTML and screenshot it.
