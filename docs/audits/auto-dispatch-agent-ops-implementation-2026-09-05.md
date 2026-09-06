# Auto-Dispatch in Agent Ops — implementation and verification

Implemented locally on `fix/auto-dispatch-agent-ops`, based on `a2bb0bc49b9f6a1ebb776af29ee58a3d1439c9cf`.

Auto-Dispatch now lives at `/admin/agents?tab=dispatch`. Schedule provides an admin-only shortcut. Existing `/admin/auto-dispatch` and `/admin/dispatch?tab=automation` links redirect while preserving run/query/hash context. The existing Dispatch Agent links to this workspace and reads Auto-Dispatch's own run ledger, independently of the route-reorder ledger. Healthy runs remain informational; failed/degraded runs surface as exceptions.

The dashboard now refreshes the selected audit with the run list, rejects stale responses after selection changes, displays request errors with retry, shows fatal run errors even without decision rows, and selects/reports manual-run outcomes. Run selection is URL-backed. Current effective configuration and scheduled-job availability are distinct from historical configuration snapshots. The dry-run explanation includes geocoding and coordinate persistence.

Decision cards identify the customer and appointment, show before/candidate/applied placement and score/preference evidence, and link to the existing appointment detail sheet on the visit's current date. Lock and exclusion controls call the existing admin endpoints. Readable content uses at least 14px text and retains the embedded page's inline style system.

The optimizer, cron schedule, apply permission, advisory lock, customer communication behavior, and appointment-moving rules were not changed. No new dependency or migration was added. Existing admin auth remains in place; no public route was added. API changes enrich existing admin reads and make the manual response's `ok` match its run outcome.

## Verification

- Client: 37 tests passed across AutoDispatchPage, AdminDispatchPage, AgentsHubPage, AdminTabRedirect, and DispatchPageV2 completion-predicate suites.
- Server: 215 tests passed across Auto-Dispatch dashboard/API, optimizer, route tiers, and route reorder suites. Four schema checks skipped without `DATABASE_URL`.
- `npm run build` passed, including blog-schema, affiliate-registry, portal-brand, and domain-rule checks.
- Focused ESLint passed without new warnings. Existing structural warnings in untouched portions of `admin-agents.js` were observed during review.
- `git diff --check` passed.
- Chrome/Playwright verified real hub/page components with synthetic responses at 1440px and 390px: both legacy redirects, selected-decision refresh, lock/exclusion, failed manual run, detail error/retry, and opening the existing appointment detail sheet. No page JavaScript errors or mobile document overflow occurred. All requests were intercepted; no real API, database, geocoding, appointment write, or customer communication was triggered.

Local screenshot artifacts reviewed:

- `/tmp/auto-dispatch-agent-ops-verify/desktop-1440.png`
- `/tmp/auto-dispatch-agent-ops-verify/mobile-390.png`
- `/tmp/auto-dispatch-agent-ops-verify/failed-run-mobile.png`
- `/tmp/auto-dispatch-agent-ops-verify/appointment-detail-mobile.png`
- Machine-readable interaction evidence: `/tmp/auto-dispatch-agent-ops-verify/evidence.json`

The browser harness mounted the real Agents/Schedule wrappers with admin CSS scopes, not the global sidebar/login shell. Database reads were mocked in tests: joined SQL identifiers/types and deployed data have not been verified against a development database. Migrations were not run. No push, PR, merge, deployment, or gate flip was performed.
