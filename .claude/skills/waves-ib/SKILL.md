---
name: waves-ib
description: Use when working on the Intelligence Bar — adding or modifying a tool or tool module, wiring a new context, changing the route, touching pageData wrappers, or debugging why a tool doesn't load. Covers the architecture, the context→tools mapping, the design decisions, and the contract-test gate every tool must pass. For WRITE tools also load ib-write-tools (the confirm trust boundary).
---

# Intelligence Bar — architecture and tool development

Natural-language AI command center embedded across admin + tech portals.
Replaces rigid UI elements (buttons, tabs, static panels) with conversational
queries powered by Claude.

## Architecture

```
⌘K (any admin page) or embedded bar
    ↓
POST /api/admin/intelligence-bar/query
    ↓
context param loads: base tools (admin only) + context tools
                   + context system prompt + pageData (live UI state)
    ↓
Claude (FLAGSHIP default; env-overridable via INTELLIGENCE_BAR_MODEL
        and INTELLIGENCE_BAR_TECH_MODEL) → up to 8 tool-use rounds
```

One Express route serves everything: `server/routes/admin-intelligence-bar.js`.
Tool modules live in `server/services/intelligence-bar/{context}-tools.js`,
one file per context. The `context` parameter drives which tools load and
which system-prompt extension applies — no page-specific endpoints.

## Context → Tools Mapping

| Context | Route(s) | Extra tool module |
|---|---|---|
| `customers` | `/admin/customers`, `/admin/health` | — (base only) |
| `leads` | `/admin/leads` | `leads-tools` |
| `schedule` / `dispatch` | `/admin/schedule`, `/admin/dispatch` | `schedule-tools` |
| `dashboard` | `/admin/dashboard`, `/admin` | `dashboard-tools` |
| `seo` / `blog` | `/admin/seo`, `/admin/ppc`, `/admin/social-media` | `seo-tools` |
| `procurement` | `/admin/inventory` | `procurement-tools` |
| `revenue` | `/admin/revenue`, `/admin/invoices` | `revenue-tools` |
| `reviews` | `/admin/reviews`, `/admin/referrals` | `review-tools` |
| `comms` | `/admin/communications` | `comms-tools` |
| `tax` | `/admin/tax` | `tax-tools` |
| `banking` | (via IB) | `banking-tools` |
| `email` | (via IB) | `email-tools` |
| `estimate` | `/admin/estimates` | `estimate-tools` |
| `tech` | `/tech/*` | `tech-tools` ONLY — no base tools, read-only, max_tokens 1024 |

All admin contexts get base tools from `tools.js` (customers incl.
`create_customer` / revenue / scheduling / SMS) plus the read-only comms
subset (`COMMS_READ_TOOLS`: conversation threads, message search, SMS stats,
call log) and the email read+reply subset (`EMAIL_SHARED_TOOLS`: inbox
summary, email search, threads, draft/send reply, reply-via-SMS — the reply
writes stay UI-confirm gated) so message history and the inbox are visible
from any page. Admin-role requests additionally get ALL infra ops modules
(`INFRA_TOOLS`: ops/Railway, sentry-ops, cloudflare-ops, twilio-ops,
stripe-ops, github-ops, store-ops, growthbook, google-ads-ops, token-health,
sendgrid-ops, dataforseo-ops, gbp-ops, ga4-ops) on EVERY admin context —
infra reads are context-independent, and the shared `INFRA_PROMPT` guidance
is appended for admin requests; technician tokens never see or execute them.
Tech portal is isolated — no base tools, strictly read-only, lower
max_tokens for field speed.

## Key Design Decisions

- **One route, many contexts.** No page-specific API endpoints.
- **Base tools always loaded on admin contexts.** Any admin page can answer
  "how many active customers?" even if it's the SEO page.
- **Tech portal is isolated.** Only `tech-tools` loads. All read-only.
  Field-speed max_tokens.
- **Write operations require UI confirmation (issue #1568).** With
  `GATE_IB_UI_CONFIRM=true` (prod default), write tools never execute from
  the model loop: the call returns a preview, the route persists a pending
  action (`ib_pending_actions` — actor-bound, 10-min expiry, payload hash,
  single-use), and the client renders a Confirm/Cancel card
  (`PendingActionsCard`). Only the operator's click commits, via
  `/confirm-action` — never a model tool, and the pending id is never
  model-visible. The gated tool list lives in
  `services/intelligence-bar/write-gates.js`, mirrored by
  `tests/intelligence-bar-write-gate-contract.test.js`. New write tools MUST
  be added to those sets — load the **ib-write-tools skill** for the full
  procedure. With the gate off (local dev), the legacy conversational
  `confirmed: true` two-step applies.
- **`SEOIntelligenceBar` is the generic reusable wrapper.** Pass a `context`
  prop. Only build a custom wrapper if you need to inject page-specific
  React state as `pageData`.
- **Some tools spawn their own Claude calls.** `run_price_lookup`,
  `draft_sms_reply` — they call Claude internally for content generation.
  Flag such tools `sonnetBacked` so contract-test smoke skips them.

## Adding a new tool / tool module

Template + 6-line route-wiring checklist:
`server/services/intelligence-bar/README.md`. Tool modules export `TOOLS` +
`executeTool`; wire 6 lines into the route file. Don't invent a new
architecture.

Every tool must pass the contract gate (`npm run test:contracts`, runs in
CI against the migrated DB; warnings block):

- **Knex queries** are statically checked against `information_schema` —
  including tables named inside `db.raw(...)` string literals and in-file
  SQL constants. Truly dynamic raw SQL (interpolated/bound table position)
  must declare its tables in `server/contract-tests/overrides/manual-contracts.js`.
- **Smoke execution** calls each tool with schema-valid minimal inputs
  (nil UUID for `format: 'uuid'` params — declare the format on UUID params
  so the probe is typed correctly). Tools that write rows or send anything
  MUST be flagged `sideEffects: true` in manual-contracts.js (or
  `_sideEffects` on the tool) so smoke never fires them.
- **Response shape**: return a JSON-serializable, non-empty plain object —
  never a bare Knex builder or scalar.
- Wrap uncertain tables/columns in try/catch and declare them
  `optionalTables` / `optionalColumns` — don't crash a tool module on one
  bad query (CLAUDE.md rule 6).
