# Email in Communications

Approved follow-up: establish draft recovery, then reuse the existing Email
inbox inside Communications. This branch starts at cleanup commit
`205f7b5ec6f3d7dc97d190b3e898fed958b30ab3` and is reviewed separately from
the cleanup PR. The earlier workspace proposal is not imported.

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

No extra inbox or approval queue was created. EmailPage remains the only inbox
implementation and uses the same routes and provider contract. The previous
inbox could fetch an off-list deep-linked message without rendering it; the
selected message is now visible above the filtered list. Existing query values
and fragment context survive selection, the alias, Back and Forward.

The Email module is imported by Communications, which already uses the App's
chunk-retry loader. This adds Email code to that page's chunk rather than
introducing another loader or parallel route. Opening another Communications
tab does not mount Email or request its APIs. The exact bundle effect is
recorded with verification below.
