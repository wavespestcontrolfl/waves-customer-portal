---
name: ui-verify
description: Use before requesting review on ANY PR that touches client UI (admin, customer portal, or tech portal). Render the real page, screenshot it, and check it against the goal and the design spec with vision — past UI parity bugs shipped because nobody looked at the rendered page before review.
---

# Vision-verify UI changes before review

Tests and a clean build do not prove a UI change looks right. Before tagging
Codex on a UI-touching PR:

## Procedure

1. Run the app in the background and navigate to the changed page with the
   Chrome DevTools MCP (`new_page`/`navigate_page`). For client-only changes
   use `npm run dev:client` — the full `npm run dev` has a `predev` hook
   that runs `db:migrate` and fails without a `DATABASE_URL` (and agent
   sessions must not point one at prod). Reserve full `npm run dev` for
   server-rendered or backend-dependent pages, against a dev/preview DB.
2. Screenshot at TWO widths minimum: desktop (~1440) and mobile (390 —
   Virginia and the techs live on phones). `resize_page` then
   `take_screenshot`.
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
5. Put the screenshots/findings in the PR description so the reviewer sees
   the rendered result.

## Estimate UIs specifically

The canonical spec for estimate-facing UI is the **server-rendered**
`server/routes/estimate-public.js`. React estimate views mirror it — when
specs are ambiguous, match the existing estimate UI rather than asking.

## When this is mandatory

- Any change under `client/src/` that alters rendered output.
- Any server-rendered page change (`estimate-public.js`, prep guides, /pay).
- Email/newsletter template changes: render the HTML and screenshot it.
