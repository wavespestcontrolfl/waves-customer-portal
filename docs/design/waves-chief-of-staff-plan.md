# Waves Chief of Staff: commitments, code, and operations

Status: Hermes team installed on the Hostinger instance; Chief of Staff and
Code Watcher and Operations Watcher schedules enabled. Promise Keeper remains
paused pending release/activation of its new scoped integration. See installation evidence below.
Inspected base: `a2bb0bc49b9f6a1ebb776af29ee58a3d1439c9cf`.

## Outcome

Own authorized work through verified completion. A persistent Chief of Staff
prioritizes durable cases and assembles temporary specialists. Promise Keeper,
Code Watcher, and Operations Watcher feed the same coordination board. Existing
portal records remain authoritative for customer and operational state.

The owner authorized implementation in the conversation, then added code and
operations watchers. The later “ok keep going” approved the specifically proposed
existing watchdog gate/secret connection and redeploy. Customer messages,
production database access from Codex, and new-code merges remain outside scope.

## Verified integration points

| Responsibility | Existing mechanism | Integration constraint |
| --- | --- | --- |
| Open customer promises | `server/services/call-commitments.js`, IB `get_open_commitments` | Keep grounded evidence, party distinction, implicit deadlines, and conservative fulfillment. |
| Owed queue | `server/routes/admin-call-recordings.js`, `/api/admin/call-recordings/commitments/open` | Admin/tech authenticated; queue reads can refresh fulfillment, so this is not a side-effect-free machine read. |
| Overdue detection | `server/services/call-commitments-watchdog.js` | Extend the existing detection; do not add a competing overdue cron. |
| Operational backlog | `server/services/ops-queue.js` | Read-only projection, not a claimable task ledger; lane errors and truncated counts must remain explicit. |
| External uptime/agent watch | `server/routes/integrations-watchdog-worker.js`, `docs/hermes/watchdog_poll.py` | Existing HMAC watchdog capability returns counts and stable reasons, not customer records. Preserve its paging and heartbeat behavior. |
| Application defects | `server/services/intelligence-bar/sentry-ops-tools.js` | Existing issue list/detail tools; remote watcher access is not currently exposed by this module. |
| Change correlation | `server/services/intelligence-bar/github-ops-tools.js` | Existing merged-PR and commit reads; CI failures require an additional GitHub read capability. A recent merge is correlation, not proof of causation. |
| Estimate preparation | `server/services/intelligence-bar/estimate-tools.js` | Engine owns prices. Existing draft/revision writes retain operator confirmation and account eligibility checks. |
| Knowledge | `server/routes/mcp.js` | Knowledge-only MCP; no customer PII or write tools. Do not silently widen this credential. |
| Machine authentication | `server/middleware/link-worker-auth.js` | Fixed, server-derived capabilities. Existing watchdog/backlink keys do not authorize customer work. |

## Watchers and case routing

Promise Keeper starts with estimate commitments and callbacks already recorded
in the Owed queue. It checks current evidence before requesting work. A drafted
estimate does not fulfill a promise to send it; a completed callback can create
a separate revision obligation.

Code Watcher observes unresolved/new Sentry issues and relevant GitHub CI
failures. One incident key uses repository plus Sentry issue ID, or repository
plus workflow/run identity. Poll repeats update the same case. It supplies the
observed commit/environment, sanitized evidence, reproduction, and impact.
An engineering specialist reproduces, implements in an isolated worktree, tests,
and prepares a reviewable change. Independent review and applicable repository
shipping gates govern completion. No automatic merge is implied.

Operations Watcher consumes the existing watchdog snapshot and authoritative
lane checks. Stable reasons identify investigations; changing counts do not
mint new cases. The coarse snapshot opens an investigation, not an assertion
about a specific customer. A specialist resolves the underlying record through
its existing authorized mechanism. Source failure is unknown, never healthy.
The external watchdog remains able to notice a portal outage.

Cases that share a demonstrated cause link to one incident with separate
customer obligations. Similar wording alone does not establish a shared cause.

## Shared coordination contract

Use the selected runtime's durable task board, with one accountable owner and
atomic claim/lease semantics. Do not turn `ops-queue.js` into a second ledger.
For Hermes, evaluate its installed Kanban support before configuring it.

Each case records:

- Stable source identity and links to authoritative records.
- Requested outcome, evidence references, observation time, and record versions.
- Current owner, dependencies, deadline, and action-specific closure criteria.
- Allowed capabilities, approval receipts, remaining shared budget, and expiry.
- Specialist assignments, artifacts, contradictions, and verification results.

Board comments carry handoffs. Wiki entries distinguish approved policy from
hypotheses. Durable attachments preserve the exact draft/test evidence used in
a decision. Keep credentials and raw customer communications out of general
wiki pages and code artifacts.

Temporary specialists receive a bounded question, evidence, deliverable, and
remaining mission budget. Delegation never expands permissions. A worker cannot
approve its own operational proposal. Re-read source state before execution;
new evidence invalidates stale proposals and dependent artifacts.

On timeout after a possible side effect, reconcile by operation identity before
retrying. A restart resumes the same case. A failed verification keeps it open.
A new recurrence after verified resolution reopens or links a new occurrence
without losing the prior verification history.

## Required first acceptance checks

1. Repeated watcher observations create one case; a changed count updates it.
2. Unknown/unavailable source reads never close incidents or claim full coverage.
3. Workers cannot concurrently own the same execution, and expired ownership
   cannot commit an action.
4. Customer corrections invalidate pending work before execution.
5. Draft preparation does not close a send/callback obligation.
6. Customer-facing actions retain existing approvals; delegated credentials
   cannot impersonate an admin or use the knowledge/watchdog key for writes.
7. A code repair includes reproduction and meaningful verification; unrelated
   dirty checkout state remains untouched.
8. An operations repair verifies the authoritative outcome, not just job launch.
9. Restart and uncertain-result handling do not duplicate actions.
10. The owner sees Completed, Moving, Blocked, and Needs your decision, with
    evidence. This is a view of actual work, not the primary output.

## Installed runtime and evidence

Verified 2026-09-05 through authenticated Hermes WebUI HTTP APIs on the
Hostinger instance. No gateway credential is stored in this document.

- Dedicated board: `waves` (Waves Operations); default board preserved.
- Profiles: `waves-chief`, `waves-promises`, `waves-code`, `waves-ops`,
  `waves-engineer`, `waves-ops-worker`, `waves-verifier`.
- Shared skill: `waves-chief-of-staff`, installed globally and in each profile.
- Each profile has role-specific toolsets and `HERMES_KANBAN_BOARD=waves`;
  persisted settings were read back and verified. Existing model configuration
  remains unchanged. These are tool selections, not an OS security sandbox.
- Child limits are bounded; no global concurrency guarantee has been verified.
- Chief cron `6c54caf00f56`: enabled, every 30 minutes.
- Code cron `ead6c9155b54`: enabled, every 15 minutes; manual cron execution
  completed with source-linked cases. An overlapping builtin execution discarded
  its stale result. The next builtin-only run completed cleanly at 05:48:21 UTC
  (execution `da20964310ea404f9d36be450813f196`, no error).
- Promise cron `44043b39f539`: paused, pending scoped commitment access.
- Ops cron `fdb04740886c`: enabled every 10 minutes after host verification. Dedicated signing secret and
  portal gate are installed; deployment `6e39658b-5430-4e2f-a955-3b186ba635e6`
  succeeded. An identifying User-Agent fixed the observed Cloudflare 403.
- All cron delivery is local; no external notifications configured.

Live code scan task `t_3cfb9dc6` completed with both GitHub and Sentry available.
GitHub coverage was explicitly bounded to the latest 30 completed runs and
reported truncated. Three source-linked CI cases were created: `t_26876f33`,
`t_4d2355d0`, and `t_e950264a`. This establishes source access and real task
handoff, not repaired defects or complete historical coverage.

Follow-on repair `t_2c413aab` narrowed run 33945790838 to browser-previews.
Full reproduction is blocked by missing Playwright libraries in the managed
worker image; raw log access also failed for its unauthenticated request.
Credentials were installed only in the code profile. Credential permissions
were not introspected, so they must not be described as read-only tokens.

Configuration verifier `t_3851c271` completed and found a missing operations
worker profile, subsequently installed. Promise integration blocker
`t_f2c3025a` is explicitly blocked on the board. Existing admin commitment reads
are not a substitute for a scoped machine capability.

Remote code helper: `/data/profiles/waves-code/workspace/code_watch_read.py`.
It uses fixed GET requests, omits raw Sentry issue text, preserves unavailable
states, and never infers resolution from absence in a bounded result window.
Local mocked checks covered missing credentials without network, bounded
results with raw-message omission, and malformed-response unavailability.

Ops wrapper and existing signer/poller are installed in the ops workspace.
The dedicated `/data/workspace/.waves-link-worker-secret-watchdog` is installed
and verified mode 0600. A signed parent-side read returned HTTP 200 with attention
reasons for permit-sync, failed jobs and failed alerts. Host task `t_7dacea99`
then verified a fresh snapshot at 05:45:28 UTC and routed one case per reason.
The initial connectivity blocker was closed on that fresh evidence.
Existing backlink credentials do not grant watchdog or customer-data scope.
The watchdog gate and dedicated secret were changed under approval, followed
by the verified configuration redeploy. No customer records, communications,
charges or merges were performed. Signed reads record existing nonce/audit rows.

## Installed-version operational traps

- Cron creation ignored `enabled:false`; explicit pause plus read-back was
  required. Only the verified Chief and Code schedules were subsequently resumed.
- Profile-local cron lists do not prove other profiles have no jobs; use the
  WebUI all-profiles view.
- File-save updates existing files; workspace multipart upload creates new files.
- Keep secrets out of board cards, shared skills, logs, and source control.

Hermes references:
[Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban),
[delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation),
[profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles/).

## Promise Keeper implementation verification

Dedicated commitments-worker read, HMAC capability, dark gate, audit CHECK
migration and connection instructions are now implemented locally. Shared auth,
route and public-surface tests passed; independent review identified missing
flat-transcript character anchors, which were added with regression coverage.
Migration up/down passed inside a rolled-back transaction on an identity-checked
existing synthetic Railway preview database. After integrating current main, 204 auth/route/public-surface tests passed.
The pre-push review reported zero P0/P1. This new route is not deployed.

The managed Hermes runtime is non-root Debian 13, lacks Chromium libraries and
sudo, and cannot currently perform the full browser audit. Preflight task
`t_dc283b68` records exact missing packages and the root-level installation
proposal. Do not claim browser verification or silently accept weaker evidence.
