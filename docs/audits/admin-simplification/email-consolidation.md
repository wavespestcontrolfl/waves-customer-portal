# Email in Communications

Approved follow-up: establish draft recovery, then reuse the existing Email
inbox inside Communications. This branch starts at cleanup commit
`205f7b5ec6f3d7dc97d190b3e898fed958b30ab3`, then incorporates the cleanup
review fixes through `da9e18b19`. It is reviewed separately from cleanup
PR #3980. The earlier workspace proposal is not imported.

Implementation contract:

- One Communications destination, with an owner-only Email tab. Preserve all
  existing SMS, call, promise, triage and configuration tabs and their roles.
- Reuse EmailPage and the existing Gmail/send endpoints. Its inbox, filters,
  classification, blocked senders, replies, compose, AI drafts, attachment
  downloads and OAuth remain. No provider, server, send-policy or schema edits.
- Recover compose and per-message reply text after channel switching and
  reload in the same browser session. Scope recovery to the server-verified
  account; clear it on explicit sign-out. Recovery contains typed text and
  IDs, not a copy of incoming mail. Never create a Gmail draft or auto-send.
- Storage failures remain visible and retain the draft during SPA navigation;
  warn before a reload that cannot recover it. Failed sends retain text;
  confirmed sends clear only the draft that was submitted. Explicit discard
  clears a draft. Late AI/thread/send responses cannot overwrite another
  message or a more recent edit.
- Keep `/admin/email` as a context-preserving alias for existing bells,
  OAuth returns and bookmarks. Keep message selection, query multiplicity,
  fragment context, browser history and refresh behavior. Off-list messages
  reached through a direct link must actually be visible.
- The global command palette selects the existing `email` tool context for
  the owner Email tab. Confirmation boundaries and tool definitions stay as-is.
- Use one command header with an Email sub-section row. Match the existing
  components' style systems; this is not a visual refresh.

Verification uses synthetic browser APIs and component tests for draft
recovery, account isolation, failed/late responses, permissions, aliases,
channel history and tool context. No production data, live messages,
payments, jobs, database or native integration is exercised. No development
DATABASE_URL is configured, so migrations are not run.

Events/library permissions remain an independent product decision: technician
SMS editing must not be lost by hiding it behind the owner-only email library.

## Result and limits

Email now lives at `/admin/communications#tab=email`; the standalone navigation
entry is removed and `/admin/email` remains an owner-guarded alias. Desktop
Email access takes Communications then Email; mobile takes Messages then
Email. The existing SMS composer stays mounted after first use so its text,
recipient, sender, attachments and tracked links survive channel switches.
Hidden SMS cannot keep dictating, open a portal dialog or mark a deferred
notification thread read. It does not gain reload recovery in this change.

Email recovery is local to this browser tab and verified admin account. It is
not synced across devices or into Gmail. Compose and per-message reply text
survive a reload; a quota/privacy failure retains SPA memory, shows a warning
and warns before reload. Explicit sign-out clears recovery and invalidates
outstanding callbacks. Discard and confirmed sends clear only the relevant
draft. A late successful send updates even an editor reopened while waiting.
Pending compose/reply requests retain their disabled send state across channel
navigation; the shared local draft session rejects a second submission until
the request settles. A pending request warns before leaving the page, including
while a different channel is open. This does not add provider idempotency or
claim recovery of an unknown send outcome after a forced reload.

After first use, the Email workspace stays mounted while switching channels,
preserving its search, classification, pagination, archived/blocked view,
selected message and compose state. Hidden Email cannot open a portal composer
or follow a newly changed message query; recipient lookup pauses until visible.
Returning to Email does not start another inbox/status load solely from a
remount. Refresh still has the existing filter reset behavior; typed Email
drafts and the URL-selected message have explicit reload recovery.

No extra inbox or approval queue was created. EmailPage remains the only inbox
implementation and uses the same routes and provider contract. The previous
inbox could fetch an off-list deep-linked message without rendering it; the
selected message is now visible above the filtered list. Existing query values
and fragment context survive selection, the alias, Back and Forward.

The Email module is imported by Communications, which already uses the App's
chunk-retry loader. This adds Email code to that page's chunk rather than
introducing another loader or parallel route. Opening another Communications
tab before visiting Email does not mount it or request its APIs. The exact bundle effect is
recorded with verification below.

## Capability parity

| Existing capability | Canonical location and access | Data/actions and state | Evidence and limit |
|---|---|---|---|
| Standalone Email entry | Communications → Email; verified admin only | Same EmailPage; old `/admin/email` aliases to the selected channel with repeated query values and fragments retained | Alias tests and browser old-link/refresh scenario; technician mount/API denial and owner-only IB context tests |
| Inbox, filters, pagination, message and blocked-sender detail | Email Inbox / Blocked Senders sub-sections | Existing list/detail/thread/read/classification/star/archive/trash/block endpoints, response fields and controls retained | Source comparison; synthetic inbox/off-list/blocked/browser scenarios; provider side effects not exercised |
| Compose and reply editors | Same Email composer and inline thread reply | Typed fields recover per verified account in this browser tab; failed sends retain text, explicit discard and successful sends clear the submitted draft | Eleven component regressions, store and sign-out tests; no cross-device or Gmail draft sync |
| SMS composer | Communications → SMS, existing staff access | Existing sender, recipient, text, MMS and link state stays mounted after use; hidden dictation and portal dialogs stop | Browser switches both channels with unsent text; SMS still has its existing reload/navigation-away limitation |
| Send, AI suggestion and late responses | Existing buttons and endpoints in Email | No send/provider policy change; local pending guard survives navigation; AI and send callbacks respect current draft/session | Synthetic failed/successful send and delayed-response tests; no live send, OAuth handshake or server idempotency claim |
| Attachments, classification, digest and provider connection | Existing Email controls and status surfaces | Same attachment downloads, safe email body rendering, digest and Gmail OAuth routes | Source/API contract comparison and existing suite; no attachment upload, signature or assignment feature invented |
| Email Intelligence Bar context | Global palette while owner Email is active | Existing `email` tools, history, confirm boundary and route; verified role replaces stored-role inference | Palette context tests; no live LLM/tool invocation |
| Mobile and keyboard compose | Same Communications header; Email sub-section and modal | Existing safe-area layout, labeled fields and shared modal focus trap; close retains draft, discard removes it | 1440/390 screenshots reviewed; synthetic close/resume, desktop keyboard behavior; native devices not exercised |

Events and the template library stay separate while their staff/owner editing
permissions differ. No queue, persisted business state, provider integration,
pricing or server route is merged or retired by this branch. Revert the Email
commits independently to restore its direct navigation and prior editor state.


## Verification evidence

Application/QA commit: `3c7471ecf`. Commands use Node 20.20.2 in the task-owned
worktree `/private/tmp/waves-admin-email-communications-20260906`; setup and
frontend doctor passed with no database or provider credentials. The branch
is stacked on cleanup `58d48129a`; no Email commits are published yet.

- Final production build passes, including schema/vendor/brand/domain checks
  (`.tmp/email-complete-build.log`, 26.32 seconds). No migrations ran locally.
- Six focused suites pass 59 tests covering Email draft recovery, pending
  send guards, account/sign-out isolation, role enforcement, aliases,
  navigation and the existing Email Intelligence Bar context
  (`.tmp/email-workspace-focused.log`). The final synchronous channel-selection
  adjustment is also covered by the browser run below.
- Nine synthetic browser scenarios pass with five reviewed screenshots at
  1440/390, zero page exceptions, zero unmatched APIs, and exactly three
  intercepted send requests (`.tmp/email-browser/report.json`,
  `.tmp/email-workspace-browser-final.log`). Tests cover old message URLs,
  both channel drafts and retained search, reload recovery, failed/successful
  compose, pending reply navigation, retained blocked view, inactive message
  reads and forged stored-role denial. No browser request reached a backend
  or email provider. Desktop and mobile images show one visible command
  header, the existing Email sub-section row and a usable compose dialog;
  no page overflow was found. Existing small Email labels remain unchanged.
- Scoped lint reports zero errors and nine warnings in existing large
  components/legacy code (`.tmp/email-complete-lint.log`). New small helpers
  do not exceed the structural warning threshold; no blanket refactor ran.
- A complete earlier Email run passed 267 suites / 2,535 tests at `c5ed984f6`
  before the pending-send and channel-filter regressions were added
  (`.tmp/email-final-client-verified.log`). The final-source coverage run at `3c7471ecf` passes **267 suites / 2,537
  tests** with two workers and exit 0 (`.tmp/email-complete-client.log`).

Regression history is retained. The first full Email run under machine load
above 300 failed the same two baseline timing-sensitive tests,
`PortalPage.silent-failures` and `CallLogTabV2`; both passed in the following
73-test focused run and in the complete 2,535-test run. Earlier browser starts
timed out while the machine was overloaded. The pending-send tests and
retained-filter browser assertion failed before their fixes. The initial
pending compose assertion used three dots where the existing label uses the
ellipsis character; only that selector was corrected. No test was removed or
weakened, and the unrelated baseline components were not edited.

Bundle effect (uncompressed bytes): Communications `275530 → 306734`; its
former separate Email chunk (`27291` bytes) is now included. The main chunk
is `472611 → 474074` bytes. These are build outputs, not timed latency or
bandwidth savings. Other Communications tabs do not start Email requests
before first use; returning to a visited channel retains the existing instance.

The unchanged server test baseline is recorded in `verification.md`:
40,418 passed tests with no DB and external network blocked. It is reused
because this branch changes no server, lockfile, schema, provider or native
contract. Live integration and native device behavior remain unverified locally.

## Resumed build verification

The continuation started from clean Email HEAD `b47c58fd9`. Cleanup PR #3980
remains open at `91b560832`; its runtime review fixes were already included
in this branch. Email remains a local, unpublished child of that cleanup.
The previous demonstration processes had stopped; the same checked fixtures
were reopened in dedicated Chrome windows with DevTools and both Vite servers.

Five regression cases exposed gaps in the draft contract and now pass:

- A storage-failure reload warning now follows the shared draft session after
  leaving Communications, until the text is discarded, saved or signed out.
- A delayed AI suggestion cannot restore a reply that was typed and discarded,
  including after the editor remounts.
- Late compose and reply send responses preserve newer edits even when the
  operator changes the text back to its earlier value. Compose compares its
  immutable snapshot; replies track per-message edits in memory.
- If storing a draft removal fails, recovery attempts to remove the stale
  browser snapshot so sent/discarded text cannot return after a quota failure.
  If the browser also refuses removal, storage remains unavailable; no
  cross-device or provider recovery guarantee is added.

The existing draft store owns these protections. No new persistence key,
server route, provider call site, dependency, schema or send policy was added.
The regressions extend the existing component/store suites and browser runner,
encoding the failure class without adding another permanent project rule.

Checks on the continuation source, using Node 20.20.2:

- Six focused suites: **64 tests passed** (`.tmp/email-resume-focused.log`).
- Full client coverage: **267 suites / 2,542 tests passed**, exit 0
  (`.tmp/email-resume-client.log`).
- Production build and schema/vendor/brand/domain prebuild checks passed,
  with no migrations (`.tmp/email-resume-build.log`).
- Changed-source lint: zero errors; three existing EmailPage warnings
  (`.tmp/email-resume-lint.log`). The final browser-runner lint also passes.
- **Eleven synthetic browser scenarios passed**, with zero page exceptions,
  zero unmatched APIs, three intercepted sends and one intercepted AI-draft
  request (`.tmp/email-resume-browser-complete.log`,
  `.tmp/email-browser/report.json`). The storage scenario uses DevTools to
  issue a real reload from Settings, dismisses the browser's beforeunload
  dialog, verifies the same document remains, recovers the reply after Back,
  and verifies discard survives a subsequent reload.
- Desktop inbox, mobile composer and storage-warning screenshots were reviewed.
  The existing header/layout remains intact; the new warning uses the existing
  alert treatment. No page overflow was found at 1440 or 390. Existing compact
  Email typography is unchanged; this does not claim a typography refresh.
  The open demo windows were also reloaded and inspected through DevTools at
  both widths (`.tmp/chrome-showcase/email-resumed-1440.png` and
  `email-resumed-390.png`).

Regression evidence is retained: four component tests failed before the first
fix (`.tmp/email-resume-red.log`); the stale-storage test then failed before
its fix (`.tmp/email-resume-storage-red.log`). Browser harness corrections
matched the existing icon-prefixed AI button label, scoped the quota failure
to sessionStorage so authentication storage remained functional, and used
DevTools reload because a deliberately dismissed reload never fires a new
document load event. Product assertions were retained.

No live messages, AI requests, database access, merge or deployment was made
in this continuation. Draft PR publication remains separate from local build
completion because repository publication starts an automatic isolated preview.
