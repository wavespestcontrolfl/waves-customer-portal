# Customer workspace reference implementation

The local proof is available at `/admin/customers?customer360=workspace`. A selected record adds `&customerId=<id>`. The query option defaults off and preserves existing customer links and the standalone profile used by other screens.

## Design direction

[Square Dashboard](https://developer.squareup.com/docs/devtools/seller-dashboard) and [Square customer profiles](https://squareup.com/help/us/en/article/8401-edit-merge-or-delete-customer-profiles) are the sole visual and interaction reference for this iteration. The proof applies their compact hierarchy, explicit editing, overflow actions, readable directory, and connection between customer information and everyday work. Waves retains its own terminology, relationships, permissions, business rules, Roboto typography, and semantic colors.

The directory uses the existing Waves Table controls. Columns show customer/contact, property, services on record, next service, and existing balance/health signals. “Services on record” describes the historical service types returned by the current list endpoint; it does not imply an active subscription. Row actions move into one native disclosure, which supports keyboard access, Escape, and dismissal when focus or a pointer moves outside it. Mobile presents the same rows with visible field labels.

The profile occupies the admin shell's full content width. All customers returns to the directory with its search and filters retained. The compact header contains contact details and Message, Create estimate, Edit, and More actions. Action buttons retain the requested white surfaces. Actual warnings and customer status signals remain visible.

| Section | Existing capabilities available here |
| --- | --- |
| Summary | Next appointment, recurring service summary, and customer health |
| Activity | Customer conversation and composer, owed commitments, notes, the searchable account timeline, service records/photos, and scheduled services |
| Billing | Existing billing controls, saved methods, payments, invoices, account credit/prepay/pause actions where eligible, and historical estimates |
| Details | Contact and recipient settings, billing routing, property information, compliance records, contracts, and authorization forms/history |

The full account timeline has one home in Activity. Financial actions are grouped in Billing. Less frequent actions remain in More or the relevant section. Existing eligibility and role checks still govern actions. Earlier owner-requested omission of notification preference switches in this workspace remains in place; saved preferences and recipient routing remain authoritative.

## UI inventory and component foundation

The application already uses React 18, Vite 5, Tailwind 3, and JSX. This change adds no dependencies or build-system migration.

| Layer | Existing source of truth | Decision for this proof |
| --- | --- | --- |
| Semantic styles | `client/tailwind.config.js`, shared CSS, admin Roboto override in `client/src/index.css` | Retain existing tokens and typography; scope the reference layout styles to the customer workspace |
| Shared controls | `client/src/components/ui/`: Button, Input, Select, Checkbox, Radio, Switch, Textarea, Badge, Card, Table, Dialog, Sheet, Tabs | Reuse the Waves controls |
| Component catalog | `client/src/pages/admin/_DesignSystemPage.jsx`, at `/admin/_design-system` in development | Keep this as the single control catalog; do not create a competing Storybook/catalog in the pilot |
| Page patterns | AdminLayoutV2, AdminCommandHeader, Customer360Sections, Customer360Activity, existing customer forms | Extend existing patterns, with CustomerDirectoryTable as the directory composition |
| Accessible primitives | Existing native controls and Waves Dialog/Sheet/Tabs behavior | No Base UI, Radix, or shadcn package is currently installed; no new primitive is required for this proof |
| Types | Existing JavaScript/JSX application | TypeScript remains an incremental follow-up: establish tooling first, then type shared props and response boundaries as components are touched |

The user's proposed shadcn/Base UI foundation is a possible later addition for a demonstrated control gap. Working controls do not need replacement to apply this layout. [shadcn's Base UI announcement](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default) also retains Radix support; the default change does not require migrating an existing system. Estimate creation and technician job layouts remain subsequent reference implementations after the Customers proof is accepted.

## Messaging and unread count

Message opens Activity within the selected customer record and reuses the existing Messages composer. Fixed recipient, business-line context, image attachments, AI draft/rewrite, dictation, link insertion, delayed sending, and draft retention across section changes stay in that implementation. Changing customers resets the composer. Immediate sends clear only after provider acceptance; suppressed sends retain the draft. The existing scheduler does not support scheduled MMS and explains this without dropping the text or images.

The badge counts unread conversations, matching the global Messages badge's unit. The existing admin-only `/admin/communications/unread-count` endpoint now accepts an optional validated `customerId`; its default global response is unchanged. The query retains inbound/SMS/unread and internal-phone exclusions. Opening the customer conversation uses the existing `/messages/read` writer for the loaded inbound SMS, then refreshes badges after acknowledgment. Failed polls retain the last confirmed count, and late requests cannot overwrite a newer refresh or another customer's state. Technicians do not request admin-only counts.

This small functional addition is explicit; the directory/profile reorganization does not introduce alternative billing or pricing logic.

## Financial and document continuity

Historical estimates display stored monthly, annual recurring, and one-time quote amounts alongside recorded recurring per-application values. Different service cadences are never combined into a per-application total. Missing values remain “Not recorded”; the UI does not reprice historical estimates.

Contract history cards retain statuses, dates, audit events, and existing actions. Auto Pay setup, document creation, full terms/signature preview, and authorization history remain expandable. Collapsing a section preserves its draft inputs.

`AdminInvoicesPage.jsx` still owns invoice creation/editing, send/resend, PDFs, attachments, payment/delivery history, saved-method charges, recorded payments, account credit, payment plans, and void/reverse workflows. More and Billing link to that existing workflow, and invoice references select the individual invoice. Stripe and pricing decisions remain in their authoritative services.

## Verification

Validation: 83 focused client tests and two server query-compilation tests passed. The production build, its prebuild domain/brand gates, and ESLint completed with zero lint errors; structural and legacy warnings remain.

Focused client checks cover section navigation, directory/filter/edit state, profile roles and customer changes, account history, historical quote values, composer behavior, and unread-count refresh races. Server tests compile the unread query with parameter bindings; this is not database integration verification.

Browser verification uses local synthetic fixtures with backend/provider requests intercepted. Desktop Chromium and mobile/tablet WebKit checks exercise the directory, menus, editing, four sections, billing links, contract expansion and draft retention, messaging tools, history search, and overflow. Desktop and mobile screenshots are retained with the local QA artifacts.

No migrations or real database end-to-end verification were run: no verified development database was configured for this task. No real messages, AI requests, charges, or deployment were performed. Device speech recognition and the installed iPhone home-screen experience still require an on-device check.
