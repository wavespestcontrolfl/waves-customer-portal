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
