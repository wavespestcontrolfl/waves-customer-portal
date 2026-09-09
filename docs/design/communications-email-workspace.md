# Communications Email workspace

September 9, 2026. This lane applies the accepted workspace presentation to Email inside Communications and refines the inbox and conversation layout for desktop and phones. The release is divided into component, workspace, recovery and QA slices based on main revision `f818ab669`, including its email-body encoding fix.

## Existing contract captured before changes

- Canonical route: `/admin/communications#tab=email`; `?id=<email id>` selects a message, including an archived or off-page message. `/admin/email` remains the redirect for old bookmarks, notifications and OAuth returns. Query/hash context and browser Back/Forward remain owned by the existing router and mailbox controller.
- Email is available only to the server-verified admin role. CSR and technician sessions do not mount it. All non-callback server routes retain admin authentication and `requireAdmin`.
- `useEmailInbox` owns connection status, list/filter/search/page/archive state, selected mail, thread, stats, digest and blocked senders. Search remains debounced; list changes do not refetch independent metrics. Inactive Email pauses new reads and refreshes when re-entered.
- Reads: `/api/admin/email/oauth/status`, `/inbox?page=&limit=50&is_archived=&category=&search=`, `/stats`, `/daily-digest`, `/blocked`, `/message/:id`, `/thread/:threadId` and authenticated attachment downloads. Opening a message retains its existing read behavior. List filters remain All, Unread, Starred, Leads, Invoices, Customer, Complaints and Vendor, plus Archived.
- Actions: authenticated OAuth `/oauth/auth-url`; POST `/message/:id/read`, `/star`, `/archive`, `/trash`, `/reclassify`, `/ai-draft`; POST `/block` with email/domain and existing reason; DELETE `/blocked/:id`. Categories, extracted details, daily digest and automatic-action labels retain their meanings.
- Sending remains POST `/api/admin/email/send`: new mail carries `to`, `subject`, `body`; replies also carry the original `threadId` and reply subject. `useEmailEditor` and `emailDrafts` retain ownership of account-scoped browser-tab recovery, per-message replies, revision protection, single-flight send locks and success/failure cleanup.
- Existing attachments are downloaded from received messages; this slice does not add an outgoing attachment upload. Quick Links inserts public links and retains its separate, explicit prep-guide delivery flow. Pending guide work must survive a hidden Email channel.
- Before migration: the list expands a selected conversation inline, summary cards precede the inbox, and new mail opens a custom persistent portal. The portal's persistence preserves pending guide work; its existing focus owner and safe-area behavior remain relevant during visual migration.

## Implementation and verification

Visual control adoption and workspace arrangement are recorded in separate commits. Reuse shared fields, buttons, surfaces and action feedback, Roboto at the semantic type sizes, neutral chrome and comfortable 44px controls. Keep APIs and server behavior in their existing owners.

Verification uses only the managed local frontend and synthetic intercepted APIs: focused existing draft/navigation tests, additional changed-behavior regressions, desktop/mobile browser interactions, screenshot inspection and a production build. No backend, migrations, OAuth account connection or customer communications were exercised.

## Recovery and focus behavior

- Connection checks, inbox searches, blocked senders, linked messages and conversations expose loading and retryable failures separately from empty results. HTTP-200 payload errors remain failures; failed activity/count reads show unavailable values.
- Mail actions show inline outcomes and hold a pending-action lock. Rejected archive, trash, star, classification and blocking requests preserve the previous message, reply or entered address. Partial Gmail block warnings remain visible. Send cleanup requires the existing endpoint's success response; unconfirmed sends retain drafts. Opening, editing or discarding a compose draft clears its previous send feedback.
- A late read or send for an earlier email cannot supersede the selected conversation's request. Manual selection invalidates pending linked-message reads immediately, and mark-read failure feedback belongs to the selected message. Draft revisions protect edits made during pending sends and AI drafts; unusable AI responses report failure without replacing the draft.
- Back to inbox returns to the original inbox history entry after row browsing, including a reload and browser Back/Forward. Direct-linked conversations replace their own entry when closed. The inbox count describes matching results even when an off-list linked message is pinned.
- The composer remains mounted while hidden so pending Quick Links guide work survives. Its header action keeps a stable identity when its label changes from New email to Resume draft, allowing Escape to restore keyboard focus.
- The IB census keeps its existing baseline. One reviewed exception records the connection-status hook's removed disconnected-on-error fallback; its authenticated GET and admin-only server contract are unchanged, and no Intelligence Bar parity is claimed.
- Older email date labels use the Eastern calendar date even in a UTC browser. This behavior change is covered separately from the visual refresh by a browser fixture at a UTC/Eastern date boundary.

## Local verification results

Verified with Node 20.20.2 on September 9, 2026:

| Check | Result |
| --- | --- |
| Email draft/workspace/inbox, draft storage, body encoding, header and Quick Links Vitest suites | 95 tests passed, covering draft ownership, HTTP-200 API errors, partial Gmail block warnings, stale responses, compose feedback and navigation history. |
| `node scripts/qa/admin-email-workspace.cjs` | 22 scenarios passed; 36 screenshots; zero unmatched API requests and zero page errors. Chromium desktop/mobile/tablet widths and WebKit at 390px cover replies, compose recovery, Quick Links, focus return, retries, filters, attachments, sandboxed HTML, browser history, conversation scrolling, CSR exclusion, summary/list alignment with native browser styles and a UTC/Eastern date boundary. |
| Screenshot inspection | Desktop at 1440px, mobile at 390px, WebKit, failed reply/partial data and contracted composer viewport reviewed. Visible controls meet the 44px target; buttons are at least 14px and inputs at least 16px. Physical iPhone notch/keyboard behavior was not tested. |
| `npm run build --workspace=client` | Passed. Portal-brand and IB coverage checks were also run directly. |
| ESLint on the Email files and QA script | Passed without warnings. |
| `npm run check:ib-coverage` | Passed with zero new/changed unmapped sites; existing unsupported/unverified capability rows remain recorded. |
| `git diff --check` | Passed. |

Release verification logs are under `.tmp/email-release/`; the final browser report and screenshots are under `.tmp/email-workspace/after/`. PR descriptions carry native screenshots and the requirement-to-test review map. Child PRs are reviewed against their stated parents; the main-branch integration gate applies after retargeting for release.
