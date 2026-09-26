# Intelligence Bar — Deployment Guide

## Pre-flight

The Intelligence Bar is fully built. 104 tools, 11 modules, 13 pages wired, ⌘K global overlay in AdminLayout. The route is already registered in `server/index.js`. This guide covers what remains to go live.

## Step 1: Verify Files Exist

Confirm all 11 tool modules are present:
```bash
ls server/services/intelligence-bar/
# Expected: tools.js schedule-tools.js dashboard-tools.js seo-tools.js
#           procurement-tools.js revenue-tools.js review-tools.js
#           comms-tools.js tax-tools.js leads-tools.js tech-tools.js
```

Confirm the route file exists and is registered:
```bash
grep "intelligence-bar" server/index.js
# Expected: two lines — require + app.use
```

Confirm the migration exists:
```bash
ls server/models/migrations/*intelligence_bar*
# Expected: 20260413000001_intelligence_bar.js
```

## Step 2: Run Migration

```bash
npx knex migrate:latest
```

This creates the `intelligence_bar_queries` table for logging queries, tools called, and latency.

## Step 3: Verify Environment Variables

In Railway dashboard, confirm these are set:
- `ANTHROPIC_API_KEY` — Required. Used by all Intelligence Bar queries.
- `DATABASE_URL` — Already set (PostgreSQL).

Optional:
- `INTELLIGENCE_BAR_TECH_MODEL` — Override the tech portal model (default: `claude-sonnet-4-20250514`)

## Step 4: Deploy

Push to Railway. The standard build/deploy pipeline handles it — no special build steps.

## Step 5: Smoke Test Each Context

Test every context by sending a POST to the Intelligence Bar endpoint. Use curl or the admin UI.

```bash
# Set your admin token
TOKEN="your-admin-jwt-token"
BASE="https://portal.wavespestcontrol.com/api"

# Test each context
for ctx in customers leads schedule dashboard seo procurement revenue reviews comms tax; do
  echo "=== Testing: $ctx ==="
  curl -s -X POST "$BASE/admin/intelligence-bar/query" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"prompt\": \"test\", \"context\": \"$ctx\"}" | head -c 200
  echo ""
done

# Test tech context separately (uses Sonnet)
echo "=== Testing: tech ==="
curl -s -X POST "$BASE/admin/intelligence-bar/query" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"prompt\": \"what is my route today?\", \"context\": \"tech\", \"pageData\": {\"tech_name\": \"Adam\"}}" | head -c 200
```

## Step 6: Verify ⌘K Overlay

1. Log into the admin portal
2. Press ⌘K (Mac) or Ctrl+K (Windows) on any page
3. Verify the context badge matches the current page:
   - `/admin/dashboard` → "Dashboard"
   - `/admin/leads` → "Leads Pipeline"
   - `/admin/communications` → "Communications"
   - `/admin/tax` → "Tax Center"
   - `/admin/inventory` → "Procurement"
   - `/admin/revenue` → "Revenue"
   - `/admin/reviews` → "Reviews & Reputation"
4. Type a query and verify tools are called (check server logs)

## Step 7: Verify Embedded Bars

Visit each of these pages and confirm the Intelligence Bar appears:
- [ ] DashboardPage — teal bar at top
- [ ] CustomersPage — teal bar at top
- [ ] SchedulePage — teal bar at top
- [ ] RevenuePage — green bar after header
- [ ] InventoryPage — purple bar after stats
- [ ] SEODashboardPage — teal bar
- [ ] BlogPage — teal bar
- [ ] WordPressSitesPage — teal bar
- [ ] ReviewsPage — teal bar before tab toggle
- [ ] CommunicationsPage — teal bar after header, before tabs
- [ ] TaxPage — teal bar after header, before dashboard stats
- [ ] LeadsPage — amber bar after header, before tabs
- [ ] TechHomePage — teal mobile bar after greeting

## Step 8: Monitor

Watch Railway logs for the first few days:
```
[intelligence-bar] Tool call: get_unanswered_threads {...}
[intelligence-bar] Tool call: draft_sms_reply {...}
```

Key things to watch:
- **Errors**: Any `[intelligence-bar] Tool X failed:` messages → fix the SQL query or missing table
- **Latency**: Tool-use loops with 4+ rounds → might need query optimization
- **Model usage**: Verify tech context logs show `claude-sonnet-4-20250514`, not Opus
- **Token costs**: Each Opus query with 2-3 tool rounds costs ~$0.05-0.15. Monitor daily spend.

## Troubleshooting

**"Tool X failed: relation does not exist"**
A database table referenced by a tool doesn't exist. Check which table is missing and run any pending migrations. Some tools (CSR coaching, mileage, expense categories) reference tables that may need separate migrations.

**"ANTHROPIC_API_KEY not set"**
The `draft_review_reply`, `draft_sms_reply`, and `run_tax_advisor` tools make their own Anthropic API calls (Sonnet for drafting). They read `process.env.ANTHROPIC_API_KEY` directly. Make sure it's set in Railway.

**Tool-use loop hits 8 rounds without resolving**
The max is 8 rounds. If a query is hitting this limit, the system prompt for that context may need to be more specific about when to stop calling tools and respond.

**⌘K shows wrong context**
Check `ROUTE_CONTEXT_MAP` in `GlobalCommandPalette.jsx`. The mapping uses prefix matching — if `/admin/leads` isn't listed but `/admin` is, it'll fall through to `dashboard`.

## Context → Tools Quick Reference

| Context | Admin tools | Context tools | Total |
|---------|------------|---------------|-------|
| customers | 14 | — | 14 |
| leads | 14 | 9 | 23 |
| schedule / dispatch | 14 | 9 | 23 |
| dashboard | 14 | 10 | 24 |
| seo / blog / wordpress | 14 | 10 | 24 |
| procurement | 14 | 10 | 24 |
| revenue | 14 | 6 | 20 |
| reviews | 14 | 9 | 23 |
| comms | 14 | 9 | 23 |
| tax | 14 | 10 | 24 |
| tech | — | 8 | 8 (Sonnet, read-only) |
