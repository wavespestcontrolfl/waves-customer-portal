# Mobile-First Admin Audit

> Step 1 deliverable for the mobile-first admin overhaul. No code changes in this PR — just the snapshot of where the admin portal stands today on a phone, and where it falls down. PR #2 (shell + sticky action bars) and PR #3 (Square-style list & detail treatments) follow.

Audit date: **2026-04-18**
Scope: every route mounted under `/admin/*` in `client/src/App.jsx`.
Viewport reference: iPhone 13/14/15 (`390px` wide), iPhone SE (`375px` wide).

---

## Q1 — What nav pattern does the admin portal currently use on mobile (<640px)?

**Hamburger + left slide-out sidebar.** No bottom tab bar.

Implementation lives in `client/src/components/AdminLayout.jsx`:

- Lines 94–107 — fixed top bar, 56px tall, `display: none` by default and switched to `flex` at `max-width: 767px` via the `.mobile-topbar` CSS class (line 197). Contents: hamburger `☰` (line 99), centered Waves logo + wordmark, `<NotificationBell type="admin" />`.
- Lines 117–184 — the 240px sidebar. On mobile it's translated `-100%` off-screen and slides in when `sidebarOpen` toggles (line 121). Closes automatically on route change (line 71) and on resize past 768px (lines 74–79).
- Lines 110–114 — full-screen `rgba(0,0,0,0.5)` overlay behind the open drawer.
- Lines 196–211 — the only `@media (max-width: 767px)` block in the layout. Drops `margin-left` on the main content area (line 208) and shrinks padding to `68px 16px 24px` (line 209) so content clears the top bar.

**Result on a phone:** to reach any admin page the user has to (1) tap the hamburger, (2) scroll the 7-section / ~30-link drawer to find the page, (3) tap the link. The drawer is 240px wide on a 390px viewport, leaving ~150px of dimmed body — the operator can't see what page they're on while navigating. There is no persistent way to reach the 5 most-used surfaces (Dashboard, Schedule, Customers, Messages, More).

---

## Q2 — Are there persistent sticky bottom bars on any admin detail pages?

**No.** Zero admin detail pages render a sticky bottom action bar today. The pattern doesn't exist in the codebase.

Detail surfaces inspected:

| Detail surface | Sticky chrome? | Where actions live | File |
|---|---|---|---|
| Customer detail (Customer360Profile slide-out) | Sticky **top** header only | Text / Call / Book Appt / Invoice / Add Note pills inside the sticky top header (lines 240–271 of `Customer360Profile.jsx`). Pills are 36px min-height, set to `flex-wrap: wrap` on desktop and `overflow-x: auto` on mobile via `.c360-header-actions` (line 227). They scroll horizontally — not full-width thumb targets. | `client/src/components/admin/Customer360Profile.jsx:240` |
| Estimate detail (V2 estimator form) | None | Inline buttons at the bottom of the form. User has to scroll the entire estimator to reach Send/Save. | `client/src/pages/admin/EstimateToolViewV2.jsx` (no `position: fixed/sticky` references) |
| Estimate detail (V1 estimator) | None | Inline at the bottom of the form. | `client/src/pages/admin/EstimatePage.jsx` |
| Job detail (Schedule slide-outs) | None | `EditServiceModal`, `CompletionPanel`, `RescheduleModal`, `ProtocolPanel` are full-screen overlays on mobile (`width: isMobile ? '100%' : '60%'`, `SchedulePage.jsx:1259, 1715`). Action buttons live inline inside the modal body — no sticky footer. | `client/src/pages/admin/SchedulePage.jsx:977, 1259, 1499, 1713, 1715` |
| Invoice detail | None — has a **bulk-selection floating bar** instead | `position: fixed, bottom: 20, left: 50%` action bar that appears when checkboxes are selected (`AdminInvoicesPage.jsx:233–237`). This is bulk-action chrome, not detail-page chrome. There is also a transient toast at `bottom: 20, right: 20` (line 78). Neither matches the spec's full-width action bar. | `client/src/pages/admin/AdminInvoicesPage.jsx:78, 233` |
| Reviews / Referrals / Communications detail | None | All inline. | — |

**The only `position: fixed/sticky` patterns in the admin tree** that touch the bottom of the viewport are: bulk-selection bars (Invoices), toast notifications (Invoices, Equipment, Inventory), modal backdrops, and the Customer360 sticky **top** header. There is no precedent for the persistent sticky **bottom** action bar described in Step 3 of the overhaul.

---

## Q3 — Every admin route, classified by mobile readiness

Legend:
- **(a) mobile-optimized** — viewport-aware layout, thumb-sized targets, no horizontal scroll, no broken chrome at 390px
- **(b) functional but cramped** — content renders without breaking the page, but is desktop-density: tiny tap targets, sub-14px text, dense tables, multi-column grids that don't restack
- **(c) broken on mobile** — content is unusable, overflows the viewport horizontally, or chrome covers content with no escape

Routes are pulled from `client/src/App.jsx:177–217`. Pure redirects (`<Navigate />`) are listed at the bottom. The "mobile refs" column counts occurrences of `max-width|isMobile|innerWidth` in the page file as a rough proxy for whether the author considered mobile at all.

| Route | Component | Class | Mobile refs | Notes |
|---|---|---|---:|---|
| `/admin/dashboard` | `DashboardPageV2` (V2) / `DashboardPage` (V1) | **(b)** | V2: 5 / V1: 15 | V2 is monochrome but uses fixed Tailwind grids (no `sm:`/`md:` responsive prefixes) — KPI cards, MRR chart, and tables all stack into a single 390px column with no resizing. V1 has more `@media` work but the chart blocks still overflow. Both miss the "one job per screen" goal. |
| `/admin/customers` | `CustomersPageV2` (V2) / `CustomersPage` (V1) | **(b)** | V2: 6 / V1: 7 | V2 directory list collapses to mobile cards (good) but the 4-pill filter row (`City / Tier / Status / Has Balance`) wraps onto two lines and the search input is full-width so the `+ Add` button drops below. Pipeline columns are 260px wide and require horizontal scroll on phone. The Customer360 slide-out fills the screen (good) but its in-header actions are 36px scroll-pills, not the spec's full-width bottom bar. |
| `/admin/estimates` | `EstimatesPageV2` (V2) / `EstimatePage` (V1) | **(b)** | V2: 0 / V1: 2 | List view: stat row (6 cards) and 7-pill filter row both wrap awkwardly. Each estimate row crams customer + source icon + 2–3 inline badges + tier + monthly total + timeline + 3 action buttons into one row — at 390px this becomes 5–6 lines per row and tap targets shrink under 32px. EstimateToolView (the form) has zero mobile refs. |
| `/admin/schedule` | `DispatchPageV2` (V2) / `SchedulePage` (V1) | **(c)** | V2: 2 / V1: 8 | Day Board: TechSection columns are designed for side-by-side desktop layout. ServiceCard rows are dense with status badge + customer + address + service type + tech + time. Week/Month calendar views (`CalendarViewsV2`) use a 7-column grid that overflows the viewport — currently requires horizontal scroll. Today's Focus / weather bar / stats strip stack vertically (OK). The slide-out modals fill the screen which works, but inside them the 3-column action grids don't restack. |
| `/admin/communications` | `CommunicationsPageV2` (V2) / `CommunicationsPage` (V1) | **(b)** | V2: 0 / V1: 6 | V2 SMS tab works on mobile because thread list is naturally vertical. ConversationViewV2 reply composer fits. But the Compose Card has FROM-select + TO-autocomplete + textarea + 7 template chips + Send + AI-Draft side-by-side — at 390px these wrap and the page becomes long scroll. Calls / Templates / CSR / Email / Notifications tabs render V1 panels with desktop-density tables. |
| `/admin/reviews` | `AdminReviewsPage` | **(b)** | 7 | Stat header restacks. Review list rows are functional. Reply panel is a side panel that becomes a stacked block on mobile — works. |
| `/admin/referrals` | `ReferralsPageV2` | **(b)** | 0 | List + cards. Acceptable on mobile but no thumb-target sizing. |
| `/admin/ppc` | `AdsPage` | **(b)** | 0 | Charts + tables. Tables overflow. |
| `/admin/seo` | `SEOPage` | **(b)** | 1 | Multi-tab dashboard with embedded `SEOIntelligenceBar`. Tab pills wrap; tables overflow. |
| `/admin/knowledge` | `KnowledgePage` | **(b)** | 0 | Document list. Basic. |
| `/admin/social-media` | `SocialMediaPage` | **(b)** | 9 | Post composer + schedule grid. Some `@media` work, mostly cramped. |
| `/admin/tax` | `TaxPage` | **(b)** | 8 | Tax dashboard + expense table. Has `@media` work — most usable of the finance pages. |
| `/admin/pricing` | `PricingStrategyPage` | **(c)** | 8 | Strategy matrix uses a wide grid that pushes off-screen. |
| `/admin/lawn-assessment` | `LawnAssessmentPanel` | **(c)** | 0 | Multi-column form with a side-by-side preview. Breaks below 768px. |
| `/admin/equipment` | `EquipmentPage` | **(b)** | 6 | Asset table + photos. Cramped. |
| `/admin/kb` | `KnowledgeBasePage` (Claudeopedia) | **(a)** | 43 | Most mobile-aware page in the tree. Sidebar collapses; article view is full-width readable. The closest thing we have to a mobile-good page. |
| `/admin/invoices` | `AdminInvoicesPage` | **(b)** | 17 | Has a real responsive list. Bulk-action floating bar works on mobile. Detail drawer is OK. Still uses the V1 dark `D` palette — no V2 yet. |
| `/admin/inventory` | `InventoryPage` | **(b)** | 0 | Product table — overflows. |
| `/admin/settings` | `SettingsPage` | **(b)** | 0 | Form pages, generally OK on mobile. |
| `/admin/timetracking` | `TimeTrackingPage` | **(b)** | 6 | Has some `@media` work. Tables still overflow. |
| `/admin/fleet` | `EquipmentMaintenancePage` | **(b)** | 9 | Mileage + maintenance log. OK. |
| `/admin/service-library` | `ServiceLibraryPage` | **(b)** | 0 | List + edit panels. Cramped. |
| `/admin/compliance` | `CompliancePage` | **(b)** | 0 | Document checklist. |
| `/admin/badges` | `BadgesPage` | **(b)** | 0 | Grid of badges. Wraps. |
| `/admin/email` | `EmailPage` | **(b)** | 0 | Template editor — desktop-only ergonomics. |
| `/admin/banking` | `BankingPage` | **(b)** | 8 | Cash flow charts + transactions. Charts overflow. |
| `/admin/pricing-logic` | `PricingLogicPage` | **(b)** | 0 | Configuration table. |
| `/admin/tool-health` | `ToolHealthPage` | **(b)** | 0 | Dev/admin only. |
| `/admin/_design-system` | `DesignSystemPage` | **(a)** | 0 | Built with V2 primitives — primitives themselves are flex-friendly. |
| `/admin/_design-system/flags` | `DesignSystemFlagsPage` | **(a)** | 0 | Toggle list — trivially mobile-OK. |

**Pure redirects (no own page, follow the target):** `/admin` → `/admin/dashboard`, `/admin/dispatch` → `/admin/schedule`, `/admin/revenue` → `/admin/dashboard`, `/admin/ads` → `/admin/ppc`, `/admin/blog` → `/admin/seo`, `/admin/health` → `/admin/customers?view=health`, `/admin/leads` → `/admin/estimates`, `/admin/discounts` → `/admin/service-library?tab=discounts`, `/admin/call-recordings` → `/admin/communications`, `/admin/phone-numbers` → `/admin/communications`.

**Tally:** 3 mobile-optimized · 26 functional but cramped · 3 broken. The five Tier 1 V2 redesigns (Dashboard, Customers, Estimates, Dispatch, Communications) are all classified (b) — they're visually clean but were built desktop-first with fixed grids and no responsive prefixes. The redesign cleaned up the visual register but did not fix the mobile layout.

---

## Q4 — Where does the GlobalCommandPalette (⌘K / Intelligence Bar) surface on mobile?

**Nowhere.** It is unreachable from a touch device.

`client/src/components/admin/GlobalCommandPalette.jsx:134–146` — the palette is opened exclusively via the `keydown` handler listening for `metaKey || ctrlKey + 'k'`. There is no button, icon, gesture, or fallback trigger anywhere in the admin shell. The mobile top bar in `AdminLayout.jsx:94–107` contains only the hamburger, the logo+wordmark, and the notification bell — no search/command icon.

If the user could open it (e.g. via an attached Bluetooth keyboard), the palette modal itself does render at `width: 90%, maxWidth: 640` (line 224 of GlobalCommandPalette) so the surface itself is mobile-tolerant. But the path to opening it doesn't exist. On a phone, the entire 104-tool Intelligence Bar — across all 13 contexts — is dark.

---

## Audit summary

| Question | Finding |
|---|---|
| Mobile nav pattern | Hamburger + slide-out 240px sidebar. No bottom tab bar. |
| Sticky bottom action bars | None exist on any detail page. Nearest precedent: bulk-selection floating bar in Invoices. |
| Routes mobile-optimized | 3 of 32 own-page routes (kb, _design-system, _design-system/flags). |
| ⌘K reachable on mobile | No. Keyboard-only trigger; no touch alternative. |

## What this implies for PR #2 and PR #3

PR #2 (mobile shell + sticky action bars) needs to:
- Add a `<MobileAdminShell />` that renders below 768px and replaces the hamburger drawer with the 5-tab persistent bottom bar (Dashboard / Schedule / Customers / Messages / More).
- Pull every nav item that isn't one of the 5 tabs into a `/admin/more` scrollable list (the existing drawer's contents fit cleanly into this pattern — Operations, Communications, Marketing, Field & Equipment, Intelligence, Finance, System sections become list groups).
- Add a top-right Search/Command icon in the mobile top bar that opens the existing `GlobalCommandPalette` (the palette already auto-detects context — only the trigger is missing).
- Add `<StickyActionBar />` with variants for customer / estimate / job / invoice. None of these surfaces have any sticky-footer chrome to migrate, so the work is greenfield. The Customer360 slide-out's existing in-header pill row should move to the bottom and be widened to full-height columns (lifting actions down where the thumb naturally lives).

PR #3 (Square-style list & detail treatments) needs to:
- Replace the cramped customer list rows with the spec's 64px-tall row stack (name + city/tier + status dot + swipe-to-action).
- Restructure Customer360 header to match the Amy Richie reference (back / menu / Edit pills top, large name, three-stat row).
- Rebuild the schedule day view as the Square calendar reference (week strip, hour rail, color-per-tech blocks, current-time line, route-order numbers).

Defer until later PRs:
- The five Tier 1 V2 pages need their fixed grids replaced with `sm:` / `md:` Tailwind responsive prefixes — that's a follow-up cleanup, not a blocker for the shell.
- Tier 2 pages keep the V1 `D` palette and don't get any mobile work in this overhaul beyond inheriting the new shell + bottom tab bar.
