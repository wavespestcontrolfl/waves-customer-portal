# Communications Email workspace

September 9, 2026. The approved next slice applies the accepted Customer/SMS workspace presentation to Email inside Communications, then refines the inbox and conversation layout for desktop and phones. Work is isolated on `feat/comms-email-workspace-20260909`, based on the completed SMS branch at `6ab5d9ab8`.

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

Verification will use only the managed local frontend and synthetic intercepted APIs: focused existing draft/navigation tests, additional changed-behavior regressions, desktop/mobile browser interactions, screenshot inspection and a production build. No backend, migrations, OAuth account connection or customer communications are exercised.
