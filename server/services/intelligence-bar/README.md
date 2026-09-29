# Intelligence Bar — Tool Module Template

## Platform actions

The catalog-only review split introduces the policy and census first. Runtime
integration behind `GATE_IB_PLATFORM` is in dependent #4019; the following
describes that integrated contract. See the foundation review split document.

With `GATE_IB_PLATFORM`, the server-owned `action-registry.js` discovers actions
across pages. Add the module there and classify every action in
`action-policy.json`; unknown policies fail closed. Do not add a second business
writer or an arbitrary HTTP/SQL executor. Call the same authoritative operation
as the corresponding portal action, including its route-owned validation and
effects where those need extraction.

Writes must also register in `write-gates.js` and the write-gate contract test.
The model can prepare a proposal, never approve it. Bind target IDs, recipient,
amount, quantity, scope, and current versions; check them under the domain lock
at execution. The existing pending-action record is the durable receipt and
dedupe authority. A provider timeout needs reconciliation, not another send.
Task writes proceed one at a time after recorded successful predecessors.

Map each new/changed portal request site in
`docs/intelligence-bar-capabilities.json`, with the reviewed source fingerprint,
role/approval/inputs/effects and actual outcome evidence. A tool-list assertion
does not establish coverage. `npm run check:ib-coverage` rejects unmapped changes;
dynamic endpoints and server-generated action variants must stay in scope.
Reviewed exceptions require a concrete reason and review reference. Never reset
the original baseline to hide missing actions.

See `docs/intelligence-bar-platform-implementation.md` for rollout, verification,
and remaining work. The wiring below describes the retained non-platform path;
new platform-only tools do not need another branch in that legacy dispatcher.

## Gap reports

What the bar could not do, recorded for the owner's weekly review. The model
has no tool that writes here: a model-facing write goes through the
confirmation card (#1568), so collection is server-owned. The route feeds
`createGapCollector()` (`server/services/agent-gap-reports.js`) what the
server itself observed in the tool loop:

- its own `discover_capabilities` results, noting whether a tool a search
  surfaced later ran successfully;
- `capability_unimplemented`: a tool name the registry does not have, or a
  registered tool that does not support this case. The latter keeps the
  tool's own description of the case.

At the end of the request, `flush()` records those signals only when the reply
told the operator the bar could not do something. The server cannot tell
which part of a partly declined request failed (listing refunds is not
issuing one), so a declined request records every search it made, each
noting whether a related tool ran. Broken tools are not gap reports: every
tool call's outcome is already in `tool_health_events` (Tool Health). The platform
prompt asks the model to search with a short, general description before
declining, so that search becomes the gap's summary. It is stored as written
(owner 2026-09-28: no name or contact scrubbing), trimmed to 300 characters.

The Monday email carries
gap numbers, areas and counts only; the descriptions stay in the bar. Rows dedupe by a
fingerprint of source, kind and the summary's word set. A recurrence bumps
the lifetime `occurrences`, reopens a `fixed` gap as `new`, and fills in a
domain or tool the first sighting lacked. It also writes one
`agent_gap_report_sightings` row in the same transaction; windowed counts
read those rows.

Four sources write today, each server-owned (no model-facing write tool
anywhere in this list):

- `intelligence-bar` — the admin platform collector above (full
  `discover_capabilities` signal collection).
- `tech-bar` — the tech portal's own collector, created independent of
  `platformEnabled` (the tech context never runs platform mode). It has no
  discovery loop to sample, so `flush()` takes an extra `ask` (the
  operator's own request text): a decline with no signals collected records
  `ask` itself, trimmed, with `attempted: 'The bar declined; no capability
  search ran'` — only for a refusal that names the bar itself
  (`BAR_DECLINE_RE`; "not supported by the label" is an answer), and not
  when a tool genuinely failed on that request (an outage,
  already in Tool Health). A decline that did collect signals is unaffected — `ask` is
  ignored whenever there is anything to record already.
- `texting-ai` — `recordGap()` called from `escalate()` in
  `services/ai-assistant/assistant.js` (the live texting and portal-chat
  assistant), only when the escalate tool sets its optional
  `not_supported: true`. The keyword classifier plays no part.
  (`managed-assistant.js` is not loaded at runtime and records nothing.)
- `phone-agent` — `recordGap()` called from Sandy's human handoff
  (`voice-agent/relay-transfer.js`, right after a confirmed
  `transfer_to_office`) that Sandy marks `not_supported: true` (an optional
  tool field; most transfers are staff workflows by design), except on the
  sandbox and when anything broke on
  the call (the provider-failure recovery transfer, `RECOVERY_INTENT`, or
  any failed tool in the handoff packet). Tool timeouts and model-provider failures are not
  recorded: slow or broken tools are Tool Health's job, not a missing
  feature. The call fires and forgets (`recordGap(...).catch(() => {})`) so
  a write, slow or failed, never touches the live call.

`recordGap({ source, summary, attempted, closestTool })` is the one-shot
path for a source with no per-request collector to sample (texting AI and
the phone agent each observe exactly one signal per event) — same table,
same dedupe, same never-throws contract as `writeGapRows()`, which it
wraps.

`list_gap_reports` (`gap-report-tools.js`) is the read side, for "show gap
reports" and "what should we build next". It groups by domain and ranks by
sightings in the window, showing `times_seen_in_window` beside
`times_seen_total`, and each gap carries its `source`. It returns up to 50
rows with the real `total_matching` and `has_more`. The list tool and the
digest share one reader, `listRecentGaps()`. The owner's triage (`building`,
`fixed`, `by_design`, `dismissed`) is set by a session through
`ops/agents/gap-status.js`, which dry-runs by default.
`server/services/agent-gap-digest.js` sends a short weekly reminder (Monday
8:15am ET, `scheduler.js`) when the last 7 days recorded anything still open
(not fixed, by_design or dismissed); a quiet week sends nothing. Each line
names its source through a short label map (`SOURCE_LABELS`: `intelligence-bar`
→ "bar", `tech-bar` → "tech bar", `texting-ai` → "texting AI", `phone-agent`
→ "phone agent"), e.g. `gap #3 (new, ops, texting AI): seen 2x this week, 5x
total`. The bell carries a fixed two-line instruction, and the
full list is in the bar and in the email fallback (`AGENT_GAP_DIGEST_EMAIL`,
internal recipients only, default contact@). Kill switch:
`AGENT_GAP_REPORTS=off`, read at call time. It drops the prompt line, stops
every write and skips the digest; `list_gap_reports` keeps reading what was
already recorded.

## Retained context modules

How to add a new context-specific tool module. One file per context, six lines of wiring in the route, optional UI hookup.

## Step 1: Create the tool module

Create `server/services/intelligence-bar/{context}-tools.js`:

```js
const db = require('../../models/db');
const logger = require('../logger');

const MY_TOOLS = [
  {
    name: 'tool_name',
    description: `What this tool does and when to use it.
Use for: "example query 1", "example query 2"`,
    input_schema: {
      type: 'object',
      properties: {
        param1: { type: 'string', description: 'What this param does' },
      },
    },
  },
  // ... more tools
];

async function executeMyTool(toolName, input) {
  try {
    switch (toolName) {
      case 'tool_name': return await toolImplementation(input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:mycontext] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

async function toolImplementation(input) {
  // Query the database, return JSON
  const rows = await db('some_table').where(/* ... */).select(/* ... */);
  return { results: rows, total: rows.length };
}

module.exports = { MY_TOOLS, executeMyTool };
```

**Test your SQL.** Wrap uncertain tables or columns in try/catch — don't let one bad query crash the whole tool module.

## Step 2: Wire into the route (6 changes in `server/routes/admin-intelligence-bar.js`)

```js
// 1. Import (top of file, with other imports)
const { MY_TOOLS, executeMyTool } = require('../services/intelligence-bar/my-tools');

// 2. Tool names set (after other TOOL_NAMES)
const MY_TOOL_NAMES = new Set(MY_TOOLS.map(t => t.name));

// 3. Context prompt (in CONTEXT_PROMPTS object)
CONTEXT_PROMPTS.mycontext = `
MY CONTEXT:
Description of what this page does and what the operator is trying to accomplish.
...`;

// 4. Tool loading (in getToolsForContext)
if (context === 'mycontext') {
  return [...TOOLS, ...MY_TOOLS];
}

// 5. Tool execution (in executeToolByName)
if (MY_TOOL_NAMES.has(toolName)) {
  return executeMyTool(toolName, input);
}

// 6. Quick actions (in GET /quick-actions handler)
} else if (context === 'mycontext') {
  res.json({ actions: [
    { id: 'action1', label: 'Label', prompt: 'What to ask Claude', icon: '📊' },
    // ...
  ] });
```

## Step 3: Add to GlobalCommandPalette route mapping

In `client/src/components/admin/GlobalCommandPalette.jsx`:

```js
// In ROUTE_CONTEXT_MAP:
'/admin/mypage': 'mycontext',

// In CONTEXT_LABELS:
mycontext: 'My Page Name',

// In CONTEXT_COLORS:
mycontext: D.teal,  // or D.purple, D.green, D.amber, '#3b82f6'
```

## Client entry points

`AdminLayoutV2` mounts `GlobalCommandPalette` for admin pages. Use the route
mapping above to expose a context through the existing ⌘K / Ctrl+K and
Ask AI entry points. The former page-level admin embeds were retired;
adding a context does not require another embedded bar.

`AgentEstimatePage` has a dedicated workflow using `useIntelligenceBar`
with `buildPageData` for its live lead and draft context. It also imports
the named `AttachIcon` export from `IntelligenceBarShell`; keep that shared
module and hook. The separate `TechIntelligenceBar` and `WdoIntelligenceBar`
surfaces remain in use.
