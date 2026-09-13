# Liquid Glass consistency audit — 2026-09-09

**Scope.** Every surface that mounts the Waves Liquid Glass system (`html[data-glass-theme]` via `useGlassSurface` / `EstimateGlassTheme`, plus the server-rendered glass chrome), read against the pinned worktree `~/wt-glass-audit-20260909` at `eaf9a8745` (origin/main, 2026-09-09). The admin and technician portals were inspected for theme-scope leakage and are documented as intentional non-glass systems (section 1.3); they are not restyled here.

**Status.** Audit-first. No application code was changed. Everything under `scripts/qa/glass-audit/` (harness, fixtures, scenarios), `client/glass-audit-html/` (rendered server HTML) and `.tmp/glass-audit/` (screenshots + measurements) is audit tooling and evidence. The harness, fixtures and this report are committed on `docs/liquid-glass-consistency-audit-2026-09-09`; the rendered HTML and `.tmp/` captures are regenerable and gitignored.

**Companion files.**
- `docs/design/liquid-glass-consistency-audit-2026-09-09-coverage-matrix.md` — the route/state coverage matrix with evidence pointers.
- `scripts/qa/glass-audit/README.md` — how to re-run the evidence harness.
- `.tmp/glass-audit/<run>/<scenario>/<state>-<width>.png|json` — screenshots and per-capture measurements; `.tmp/glass-audit/digest-*.md` — cross-capture digests produced by `analyze.cjs`.

**Relation to the 2026-09-07 audit.** `docs/design/ui-consistency-audit-2026-09-07.md` covered every React surface from source with a 45-route admin render census; its section G proposed the glass tier spec and section K.2 queued the owner rulings. This audit is narrower (glass surfaces only) and deeper (every glass route rendered, measured, and compared). Findings already carried in the 09-07 tables are cross-referenced by their `F0nnn` id rather than re-argued; new findings carry `G-` ids.

---

## 1. Source of truth

### 1.1 What governs a glass surface (explicitly approved)

There is no `docs/design/WAVES-UI-STANDARD.md` in the repository. The approved standard for customer glass surfaces is spread across five documents plus one stylesheet that DECISIONS declares to be the base rule:

| Authority | What it decides | Status |
|---|---|---|
| `client/src/glass/glass-theme.css` ("the sheet") | Type roles, glass tiers, geometry, controls, fallbacks, print. DECISIONS 2026-09-05 batch A: "the sheet IS the base rule". | Approved, enforced at runtime with `!important` |
| `docs/design/DECISIONS.md` entries 2026-07-06, 07-17, 07-18, 07-21, 09-04 (two), 09-05 (batches A, B, C) | Glass unconditional on every customer surface; universal footer owned by `WavesShell`; the estimate is the template for all customer React; no status chips; one `SchedulePicker`; one scene; 14px floor / 16px prose / weights ≤700; sentence-case buttons; mobile keeps full glass but no lift; `/book` is glass | Approved owner rulings, append-only |
| `docs/design/customer-doc-style-guide.md` | Written form of the sheet: type scale, controls, three tiers, spacing scale, 760px column, radii, colour roles, primitives | Approved (rewritten to the sheet 2026-09-05) |
| `docs/design/waves-customer-facing-design-brief.md` + liquid-glass addendum | Tone and intent; the addendum points estimate surfaces at the glass plan | Approved direction, partly superseded (see 1.4) |
| `docs/design/estimate-glass-plan.md` + `estimate-glass-blueprint.js` | Original estimate glass spec | Approved 2026-07-04, carries a "superseded by the sheet" note |
| `.claude/skills/waves-design/SKILL.md` "Customer surfaces are GLASS" | Canonical navy `#04395E`, system font stack under glass, 14px floor, iOS safe-area rule, no brand fonts inside `/admin` | Operating rule for agents |
| `scripts/check-portal-brand.js` | Mechanical gate: emoji, hardcoded font strings, local palettes, `fontSize` < 14, `fontWeight` > 700 — on a listed subset of directories | Enforcement (partial coverage, by design) |

### 1.2 Existing implementation patterns (not standards)

These are what the code does today. They are repeated widely but are not owner-approved rules, and several contradict the sheet:

- `theme-brand.js` marketing tokens (`BUTTON_BASE` weight 800 / pill 9999, `BTN_BASE` uppercase, Anton / Montserrat font stacks, `#1B2C5B` navy) still feed customer components; the sheet overrides most of them at runtime.
- `theme-doc.js` (`FS`, `SP`, `RADIUS`, `DOC_COLUMN_MAX` 760, `FLOW_COLUMN_MAX` 640, `docButton`, `docInput`) — the authored twin of the sheet, used by the document pages.
- `components/estimate/tokens.js` (`W` palette, `PRICE_FONT`), `components/estimate/cardStyles.js` (`estimateCard` / `estimateInnerBox`) — the estimate grammar the 09-04 ruling made the template.
- Page-local column recipes: inline `padding: '32px 20px'` (estimate, reports), `'24px 16px 40px'` (track, secure, schedule flow), `.waves-receipt-page` / `.waves-contract-page` / `.waves-rate-page` / `.waves-customer-page` in `index.css` (760 / 1080 / 520 / 1080 max), `PortalPage` `shellMaxWidth` 760.
- `PortalPage.jsx` local card / button / label objects (13 card objects, 5 button styles per the 09-07 audit) instead of `BrandCard` / `BrandButton`.
- The estimate DOM walker (`EstimateGlassTheme.jsx classify()`) and `.gc-*` classes in `glass-components.css` re-declaring chip / accent / nav material inline.
- `server/services/email-template.js GLASS_THEME` — the email twin of the tokens, with its own values.

### 1.3 Intentional differences that this audit preserves

- **Admin portal is not glass.** `/admin/*` is the Roboto monochrome Tier-1 system (`docs/design/admin-ui-consistency-contract.md`, `waves-portal-ui-redesign-spec.md`), scoped by `.admin-shell-v2` in `index.css`. The waves-design skill forbids customer brand styling inside `/admin`. The 09-07 audit G says "Admin and tech never carry `backdrop-filter`."
- **Technician portal is not glass.** `TechLayout` is the dark inline palette with Nunito Sans / Montserrat (DECISIONS 2026-04 "Tech Home will not be touched").
- **Print / PDF modes** (`?mode=pdf`, `EstimateProposalDocument`, `ServiceReportDocument`, WDO and pre-treatment certificates) are deliberately non-glass paper documents.
- **`CardPage`** (`/card/:token`) is an inverted dark-glass business card — flagged for a ruling in batch C, not flattened.
- **Portal app shell on phones has no footer** (owner D5, batch B) and keeps its app bar + bottom nav; documents keep the universal footer.
- **Estimate `?website=1` embed** renders without `WavesShell` for the marketing site.
- **Emails are opaque** (owner 2026-08-02): flat page, white cards, no blur — the glass language stays on web surfaces.

### 1.4 Documented conflicts between authorities (owner decision needed)

| # | Conflict | Where each side lives | Rendered today |
|---|---|---|---|
| C1 | Button case. The design brief and `theme-brand.js BTN_BASE` / `buttons.css` say UPPERCASE CTAs are brand identity; DECISIONS 2026-09-04 (batch B) rules sentence case on glass and the style guide repeats it. | `waves-customer-facing-design-brief.md` "Do not strip UPPERCASE"; `customer-doc-style-guide.md` Controls | Mixed: `TrackPage` renders "TEXT ALEX" and `/book` renders "FIND MY BEST TIMES →" / "CONTINUE →" via `buttons.css`; every other glass CTA is sentence case |
| C2 | CTA ink on gold. `glass-theme.css:296-299` pins `#04395e` for `[data-glass-accent]`; `email-template.js:96-98` pins `#1B2C5B` and its comment claims to match the sheet. | `glass-theme.css`, `email-template.js`, `public-newsletter.js:491` | Web gold CTAs render navy `#04395E`; email and newsletter-landing gold CTAs render `#1B2C5B` |
| C3 | Control floor vs chip floor. The style guide sets primary 48, gold accent ≥44, choice chips ≥40; the 09-07 audit and the admin contract treat 44 as the touch floor; `BrandButton` authors 48 for every variant but the sheet forces `data-glass="chip"` (the `secondary` variant) to 40. | `customer-doc-style-guide.md` Controls; `glass-theme.css:461-462`; `BrandButton.jsx` | `BrandButton secondary` renders 40px; the portal account-menu chip renders 40px in the header |
| C4 | Numeric display sizes. The sheet defines h1/h2/h3/eyebrow/fine/body and a `metric` role with weight and tabular figures but no size; pages author 17, 19, 22, 24, 28, 34, 50 and 64px metrics. | `glass-theme.css:136-142`; `theme-doc.js FS` (no metric size) | Seven metric sizes across portal, secure, track, billing |
| C5 | Report review-card heading. `glass-theme.css:468` deliberately renders the review-request and cross-sell `h2` at 20px while every other `h2` is 26px. | `glass-theme.css:468` | Report "How did Alex do today?" is a 20px h2 |
| C6 | Document column. The style guide says 760px is the document column; `index.css` gives `.waves-contract-page` and `.waves-customer-page` 1080px and `.waves-rate-page` 520px; flow pages use 640. | `customer-doc-style-guide.md` Layout; `index.css:435-483`; `theme-doc.js` | Contract renders in a 1080px column on desktop; rate in 520 |
| C7 | Reduced motion. `glass-engine.js` comments say reduced motion "mounts none" of the orbs; `applyGlassScene` always mounts five orbs and the CSS only disables transitions and parallax. | `glass-engine.js:88-90` vs `:30-70` | Five orbs render under `prefers-reduced-motion: reduce` (static) |
| C9 | Serif inside the newsletter archive. The sheet forces the system stack on every glass element; `NewsletterArchivePage.jsx:60` authors `FONTS.serif` headings inside its sandboxed article iframe, which the sheet cannot reach. | `glass-theme.css:78-85`; `NewsletterArchivePage.jsx:53-60` | Serif h2/h3 on `/newsletter/archive/:id`, the only serif on a glass surface |
| C8 | Brand-gate coverage. The policy is repo-wide ("nothing under 14px on a glass surface"); the gate excludes `components/estimate` and `components/` root, so `SecurePlanChoice` ships 13px and the 09-07 audit's `NotificationBell` / `InstallPrompt` / `NewsletterSignup` sizes are invisible to it. | `scripts/check-portal-brand.js` SCAN_DIRS; waves-design skill hard lines | 13px on `/secure`; see G-06 |

### 1.5 Audit reference table

Expected values used for every measurement in this audit. "Source" cites the authority; "Ambiguity" records where the authorities disagree or are silent.

| Design property | Expected token / variant | Expected rendered value | Applies to | Source | Ambiguity |
|---|---|---|---|---|---|
| Theme mount | `useGlassSurface(true)` → `html[data-glass-theme]` | attribute present, 5 orbs, 1 grain layer, html background = scene gradient, body transparent | every customer React route, every state incl. loading/error | DECISIONS 2026-07-06, 07-17; `glass-engine.js` | none |
| Font family | sheet stack | `-apple-system, system-ui, "SF Pro Display", "SF Pro Text", Inter, …` on every element | all glass | `glass-theme.css:78-85`; skill | brief still names Anton/Montserrat/Inter/Source Serif |
| h1 | sheet | `clamp(32px, 4vw, 40px)` / 700 / 1.08 / −0.03em / `--brand` | all glass; one per page/state | sheet:90-96; DECISIONS 09-04 | print keeps 34 (`.waves-print-h1`) |
| h2 | sheet | 26 / 600 / 1.15 / −0.02em / `--brand` | all glass | sheet:97-104 | C5 (report review card 20) |
| h3 / h4 | sheet | 20 / 600 / 1.2 / −0.02em | all glass | sheet:105-113 | none |
| Eyebrow | `[data-gt="eyebrow"]` / `DOC_EYEBROW` | 14 / 600 / +0.06em / uppercase / `--ts` `#3F4A65` | section labels | sheet:128-135; `theme-doc.js DOC_EYEBROW` | none |
| Body prose | `FS.bodyLg` | 16 / 400 / 1.5 / `#3F4A65` | running copy | DECISIONS 09-05 batch C (owner D1) | none |
| Meta / labels / buttons / table cells / fine print | `FS.body`, `[data-gt="fine"]` | 14 minimum, weight ≤700 | everything else | sheet:143-149; skill hard line; gate | C8 (gate coverage) |
| Metric / price | `[data-gt="metric"]`, `PRICE_FONT` | 700 / tabular-nums / `--brand`; estimate price `clamp(24px, 10.5vw, 40px)` | prices, counts | sheet:136-142; `components/estimate/tokens.js` | C4 (no size token) |
| Ink | `--brand` / `COLORS.glassNavy` | `#04395E` headings, links on cards; body `#3F4A65`; muted `#475569`; placeholder `#64748B` italic 14 | all glass | sheet:6-35, 474; skill; `theme-customer.js` | none |
| Card tier | `data-glass="card"` / `BrandCard` | warm tint `rgba(244,239,224,.36)` + white gradient; border `rgba(255,255,255,.62)`; blur 32 / sat 185 (20 below 640); radius 12; double shadow | outer sections | sheet:180-191, 455, 479-481; style guide | none |
| Soft tier | `data-glass="soft"` | inner box, blur 18 / sat 165 (14 mobile), radius 12 (sheet) — style guide says 10 for inner boxes | nested boxes | sheet:192-199, 493-495; style guide | radius 10 vs 12 (sheet wins at runtime: 12) |
| Chip tier | `data-glass="chip"` (+`data-glass-pill`) | blur 18 / sat 170; radius 10 (control rule) or 999 with pill; min-height 40 (44 for `.pill-chip`) | choice chips, secondary actions | sheet:200-207, 456-467 | C3 |
| Accent (gold CTA) | `data-glass-accent` / `BrandButton primary` | gold gradient, ink `#04395E`, min-height 44, radius 10 (999 pill) | every primary action | sheet:283-335, 461 | C2 (email #1B2C5B) |
| Primary button | `BrandButton` | 48px, radius 10, weight 600, sentence case | document primary action | style guide Controls; DECISIONS 09-04 | C1, C3 |
| Modal tier | `data-glass="modal"` | white .5 base, blur 36 / sat 190, border white .75, radius 24 | dialogs, sheets, popovers | sheet:340-349 | popover radius not specified (09-07 G proposes 12) |
| Scrim | `data-glass-scrim` | navy .38 + radial white; blur 8 (not `!important`) | overlay backdrops | sheet:350-355 | 09-07 F0247 |
| Inputs | `docInput()` / sheet controls | 48px, radius 10, 16px text, placeholder 14 italic `#64748B`, border navy .16, white .8 | forms | sheet:460, 474, 502; style guide | none |
| Focus | shared ring | 2px `rgba(10,126,194,.9)` outline, 2px offset, on every control | all glass | sheet:265-273 | none |
| Hover / active | card specular + lift on desktop; no lift ≤640; chip lift −1px; accent −1px | as sheet | pointer devices | sheet:220-280, 396-433; DECISIONS 07-18 | none |
| Page column | `DOC_COLUMN_MAX` 760 / `FLOW_COLUMN_MAX` 640 | documents 760, flows 640, portal 760 | per family | style guide Layout; DECISIONS 09-04 | C6 |
| Page gutter | not tokenised | phone gutter: every page the same (the sheet says nothing; SP has 16/20) | all glass | — | **unspecified** — measured five values (G-01) |
| Vertical rhythm | `SP` 4-grid; card rhythm 16 | section gap 16 inside cards; page top 24–32 | all glass | style guide Spacing; sheet:492, 540 | page top clearance unspecified |
| Header | `WavesShell` sticky bar | 49px, `env(safe-area-inset-top)` padding, logo centred, store links left, phone right | every shell page | `WavesShell.jsx`; DECISIONS 07-06 | portal app bar is a different bar (intended) |
| Footer | `WavesShell` `<footer role="contentinfo">` = `BrandFooter` + `TrustFooter` | one contentinfo landmark per page, full width, never page-owned | every customer page except the phone app shell | DECISIONS 2026-09-04 | none |
| Landmarks | `WavesShell` `<main id="waves-shell-main">` + skip link | exactly one `main`, one `contentinfo`, skip link first | every shell page | `WavesShell.jsx` comments | none |
| Status chips | none | no status pills / badges on customer pages; state reads from heading + copy | all glass | DECISIONS 2026-09-04 (no-chips) | chips still awaiting a ruling: WaveGuard tier, setup-fee badges, "Tech nearby", report "Ready now" |
| Reduced transparency / forced colours / no backdrop-filter | sheet fallbacks | solid `rgba(255,255,255,.93)` + `#7C8DA0` border, no sheen; accent solid `#F4B014` | all tiers | sheet:547-625 | `.gc-*` and inline recipes have their own fallback blocks |
| Reduced motion | sheet + engine | no transitions, no lift, no reveal delay, no confetti, no parallax | all glass | sheet:435-448; engine | C7 (orbs still mount) |
| Touch target | 44 (48 primary) | no interactive control under 44px tall except inline text links | all glass | style guide Controls; admin contract density table; 09-07 F0160 | C3 |
| Contrast | WCAG AA | ≥4.5:1 for text < 24px on the composited scene | all glass | sheet comment on `--tt` ("AA-safe on white AND the translucent cards") | measured on the composited screenshot, see 4.9 caveat |

---
## 2. Inventory and coverage

### 2.1 Routes discovered

From `client/src/App.jsx` (the only router), the portal tab registry in `PortalPage.jsx`, `server/index.js` mounts and the server HTML renderers:

| Group | Routes | Glass? |
|---|---|---|
| Customer token documents | `/estimate/:token` (+`?website=1` embed, + marketing slug redirects), `/report/:token`, `/report/project/:token`, `/lawn-report/:token`, `/pest-report/:token`, `/pay/:token`, `/pay/statement/:token`, `/receipt/:token`, `/contract/:token`, `/prep/:token`, `/price-change/:token`, `/service-outlines/:token`, `/newsletter/archive/:id`, `/card/:token` | yes (card: own dark variant) |
| Customer flows | `/track/:token`, `/appointment/:token`, `/secure/:token`, `/reschedule/:token`, `/reservice/:token`, `/rate/:token`, `/book` | yes |
| Customer app | `/*` → `PortalPage` with tabs `dashboard`, `plan`, `visits` (upcoming / completed), `billing`, `refer`, `documents`, `property`, `learn`, cancelled-account clamp; `/login`; app-level auth-check and failure screens | yes |
| Redirect-only | `/recap/:token`, `/review/:token`, `/book/:estimateToken`, `/estimate`, `/quote`, `/newsletter` | n/a (no render) |
| Server-rendered customer HTML | newsletter confirm / unsubscribe / quiz / feedback landing pages (`public-newsletter.js renderConfirmPage`), every customer email (`email-template.js wrapEmail / wrapServiceEmail / wrapNewsletter`), the legacy estimate HTML renderer (`estimate-public.js renderPage`) | glass tokens (opaque email chrome by ruling) |
| Admin | 41 page routes + 27 redirects under `/admin`, `/admin/login`, `/admin/_design-system` | no (intentional) |
| Tech | `/tech`, `/tech/tools`, `/tech/more`, `/tech/protocols`, `/tech/documents`, `/tech/lawn-diagnostic`, `/tech/social-post` | no (intentional) |

Routes discovered: **41 customer-facing render routes / tab states + 6 redirects + 4 server HTML families**, plus 48 admin and 7 tech routes.

### 2.2 Routes in scope and inspected

Every customer glass route above is in scope, plus every server HTML family, plus the admin/tech shells for scoping evidence. The coverage matrix lists 123 scenarios (163 scenario-states), all of which are `inspected` at 390 and 1440 in headless Chrome; 11 also in WebKit at 390; 22 at 320/375/430/768/1024; emails at 640. The server-rendered family covers every `renderConfirmPage` branch in `public-newsletter.js` (19 pages): confirm GET pending / already active / unsubscribed / invalid, confirm POST confirmed / unsubscribed / invalid, unsubscribe GET confirm form / already unsubscribed / invalid and POST result / expired link, quiz confirm form and thank-you with and without the booking CTA, feedback confirm form, needs-work checkbox form, needs-work result and positive result (added after review; runs `codex-r1` … `codex-r4`). The newsletter pages are rendered from the route handlers' own templates (parsed from `public-newsletter.js`, not hand-copied), the `account-menu` overlay capture on `portal-home` at 390 is taken with the More sheet closed (one dialog, the state a customer reaches), and the live tracker's "Updated N ago" is stamped relative to the run. Totals: 595 captures (587 usable; the 8 failures are 6 first attempts superseded by successful re-runs and 2 from a scenario retired from the registry after the first run, none of them the latest capture of a registered scenario), 157 interaction captures (hover, focus, sheet / menu / dialog open, slot pick, confirm, rate, booking steps 2–4, contract focus, quote request), 2 reduced-motion states, 2 forced-colours states (`forcedColors: true` on `portal-home` and `estimate-pest` at 390, reproducible via `qa:glass`), and a keyboard-Tab focus probe on every capture.

Not inspected (recorded, not passed): see section 7.

### 2.3 Evidence method (what the numbers mean)

Each capture stores a full-page PNG plus a JSON of computed styles: theme mount state; loaded fonts and computed families; a text census (every visible text node's size, weight, family, colour); heading sizes against the sheet; every `[data-glass]` / `[data-glass-accent]` element's tier, radius, background, border, backdrop-filter, shadow and nesting; every control's height, radius, weight and case; inputs and placeholders; landmarks, header, footer, sticky and fixed bars; elements extending past the viewport; status-chip-like pills; contrast samples from the composited screenshot; a programmatic focus probe. `analyze.cjs` de-duplicates across captures. Dev-only preview chrome (the scenario switcher bars) was hidden before capture and is excluded from the numbers below.

Two method limitations matter when reading the tables:
- **Contrast sampling is a screening tool.** It samples six pixels around each text box on the composited page and (from run `codex-r3`) flags an element when its WORST sampled background fails the threshold, not the average, so text over a gradient or variegated glass is caught where it is least readable; pills, avatars and text over gradients therefore produce more false lows, and every contrast finding below was re-checked by computing the ratio from the authored colours, or is marked "candidate". A contrast or focus probe that throws fails the capture rather than reading as "no violations".
- **Footer controls are in the census** (rows carry `inFooter: true`), so `controls.small` counts include the universal footer's badges and links on every shell page; page-local figures in G-13 exclude them by that flag.
- **Translucent text is composited** over each sampled background before the ratio is computed (`contrast.cjs composite`), so `rgba(255,255,255,.6)` on `CardPage` is measured as the dimmer paint it produces, not as opaque white.
- **Form-control text is sampled explicitly** (run `codex-r5`): an input's current value or its `::placeholder` is not a DOM text node, so the contrast probe adds each visible field as a target; iframe content is measured against its own frame width for overflow, and the Tab probe descends into a focused same-origin iframe instead of reading the repeated `IFRAME` as wrap-around.
- **The focus probe is real keyboard traversal** (`page.keyboard.press('Tab')` on the pristine page, up to 25 stops), so only controls in the Tab order are reported and `:focus-visible` applies as it does for a keyboard user; a `box-shadow` only counts as a ring when it changes from the control's resting shadow (glass controls carry decorative elevation shadows). Re-run after review (`codex-r2`, `codex-r3`): every tabbed control on `portal-home` and `estimate-pest` paints the sheet's ring. A separate keyboard-Tab probe on the estimate, portal and reschedule pages confirmed the sheet's ring (`2px rgba(10,126,194,.9)`, 2px offset) on all 42 tabbed controls, so no focus finding is raised from the programmatic probe.

---

## 3. Confirmed findings

Severity: **P1** = breaks a documented rule on a primary surface or blocks the "one product" goal; **P2** = documented rule broken on secondary surfaces or measurable drift between equivalent elements; **P3** = minor drift / hygiene. "Shared" means one correction fixes every listed consumer.

### G-01 · P1 · Five phone gutters and five column recipes for the same customer document

- **Affected.** Every glass page. Measured left gutter at 390 (card left edge): portal app **10**; pay, statement, receipt, rate **12**; track, secure, reschedule, re-service, appointment, prep, contract, price-change, login, lawn / pest diagnostic, service report (real route) **16**; estimate, project report, booking **20**; newsletter archive **24**; service report *preview* 24 (harness-only). Desktop column (widest card at 1440): flow pages **608**, estimate / reports **720**, portal / lawn report / price-change **728**, pay / receipt / contract / statement **760**, rate **420**.
- **Expected.** One gutter per breakpoint and two named columns (document 760, flow 640) — `customer-doc-style-guide.md` Layout, DECISIONS 2026-09-04 (1). The gutter itself is unspecified anywhere (reference table).
- **Evidence.** `.tmp/glass-audit/digest-…md` "Layout geometry" @390 / @1440; e.g. `previews/estimate-pest/default-390.png` vs `agent-billing/pay-card/default-390.png` vs `agent-flows/newsletter-archive/default-390.png`.
- **Root cause (shared).** No page-column primitive. `theme-doc.js` exports two max-widths but no gutter or top clearance; each page authors its own wrapper: `EstimateViewPage.jsx:593` / `ReportViewPage.jsx:5609` / `ProjectReportViewPage.jsx:589` (`padding: '32px 20px …'`), `TrackPage.jsx:167` / `ScheduleFlowPage.jsx:87` / `SecureAppointmentPage.jsx:70` (`'24px 16px 40px'`), `index.css:435-483` (`.waves-customer-page` 1080, `.waves-receipt-page` 760 / 32px top, `.waves-estimate-page`, `.waves-rate-page` 520, `.waves-contract-page` 1080), `PortalPage.jsx:6509` (`0 16px`, rendering 10 after nested card insets), `NewsletterArchivePage.jsx`.
- **Correction.** Add one layout primitive (e.g. `components/brand/CustomerColumn.jsx` or a `WavesShell` `column="document" | "flow"` prop) that owns max-width, phone gutter, top clearance and bottom clearance from `theme-doc.js` tokens; migrate the eleven wrappers to it; delete the four `index.css` page classes when their last consumer moves. Preserve the two widths (760 / 640) and the portal's app-shell exception if the owner wants it (its 10px is the only value below 12).
- **Verify.** Re-run `run.cjs --extra`; the "Layout geometry" digest must show one gutter per breakpoint outside the portal app and only 760 / 640 columns.

### G-02 · P1 · The not-found / load-error card is a different component on every family

- **Affected.** `/estimate`, `/report`, `/track`, `/reschedule`, `/secure`, `/pay` (+ `/receipt`, `/contract`, `/price-change`, `/prep`, `/rate`, `/card`, `/lawn-report`, `/newsletter/archive`, `/service-outlines`).
- **Measured at 390.** Card padding 32 (estimate, report) / 20 (pay) / 24 (reschedule, secure, track, prep, rate); gutter 20 vs 16; heading present as `h1` (pay, secure) or as a styled `div` (estimate, report, reschedule, track, rate) or absent (report load-error, statement / price-change error); CTA set none (estimate 404, pay 404, track 404) / "Try again" as gold 44 (estimate, pay, report, `PublicLoadError`) / "Try again" as plain 40 (reschedule) / 44 (track) / "Text Waves" + "Call Waves" (reschedule, secure) / "Call Waves" alone (report). The report 404 card is vertically centred in a full-viewport area with the footer pushed below the fold; the pay 404 card sits at the top with the footer immediately after (DECISIONS 09-04: "page roots use `flex: 1` … so the footer never floats").
- **Evidence.** `agent-diag/{estimate,report,track,reschedule,secure,pay}-404/default-390.png` and `load-error-390.png`; `agent-billing/*/error-390.png`; `agent-flows/*/error-390.png`.
- **Root cause (shared).** `PublicLoadError` covers the *load-error* branch on eight pages, but each page hand-rolls its *not-found* / *expired* branch, and four flow pages hand-roll both.
- **Correction.** One `PublicStateCard` (`components/brand`) with `state="not-found" | "expired" | "error"`, an `h1`, body copy, and an optional CTA set from the phone constants; used by every token page for every terminal state; rendered inside the shared column (G-01) so the footer follows the card.
- **Verify.** `--family error-states`; digest must show one card padding, one heading tag, one gutter; `layout.footer.belowFold === false` everywhere.

### G-03 · P1 · Primary `BrandButton` renders 44px, not the 48px the standard specifies

- **Affected.** Every `BrandButton variant="primary"` (pay, statement, contract, the tokens showcase) and every gold accent authored ≥44 without extra padding.
- **Measured.** Showcase "Approve my plan" and "Send code" (primary) **44px**; "Show all open times" (secondary) **40px**; ghost "Not now" **48px**; `a[data-glass-accent]` "Pay …" 56px (padding-driven).
- **Expected.** `customer-doc-style-guide.md` Controls: "Primary action = `BrandButton` (48px …)"; `BrandButton.jsx` authors `minHeight: 48` for every variant.
- **Root cause (shared).** `glass-theme.css:461-462` sets `min-height: 44px !important` on `[data-glass-accent]` and `40px !important` on `[data-glass="chip"]`. `!important` wins over the inline 48, so the *floor* rule has become the *height*. The same mechanism makes `BrandButton secondary` a 40px chip (09-07 F0143, conflict C3).
- **Correction.** In the sheet, express the floors so they cannot lower an authored height — either drop the `!important` on those two `min-height` rules (inline 48 then wins, floor still applies to untagged elements) or give `BrandButton` a `data-glass-size="primary"` hook the sheet honours at 48. Keep 44 as the floor for hand-authored accents. Decide C3 for the secondary variant.
- **Verify.** Showcase primary = 48, secondary per ruling, gold accents ≥44; re-capture pay / contract / statement.

### G-04 · P1 · Weights above 700 survive on glass through shared tokens the gate cannot see

- **Affected / measured.** Portal: every `PORTAL_BUTTON_BASE` button (Get pricing, Request visit, Confirm, Replace card, Copy / Text / Email, Restart my plan …) and every `.pill-chip` (property preferences, irrigation days) at **800** (88 distinct elements); `/book` primary "Find my best times →" **800**; newsletter archive "Subscribe" **850**; mosquito V2 report `strong` **900**.
- **Expected.** Weights stop at 700 (DECISIONS 09-04 (3), batch B/C; gate rule 4).
- **Root cause (shared).** `theme-brand.js BUTTON_BASE.fontWeight: 800` spread into `PortalPage.jsx:431 PORTAL_BUTTON_BASE`; `styles/buttons.css:61,116` (`.btn-primary` / `.btn-nav` 800) used by `/book`; `NewsletterSignup` / `GlassNewsletterCard` (outside the gate's scan roots, 09-07 F0031); the gate scans JSX literals and `<style>` blocks, not `theme-brand.js` constants or `.css` files.
- **Correction.** Set `BUTTON_BASE.fontWeight` and the customer `.btn-*` weights to 600 (matching `BrandButton` / the sheet's accent normalisation); snap the newsletter and mosquito literals; extend `check-portal-brand.js` to `theme-brand.js`, `styles/buttons.css`, `components/*.jsx` root files (see section 6).
- **Verify.** Digest "Weights above 700" empty for every customer scenario.

### G-05 · P2 · Text under 14px on five glass surfaces, all outside the gate's scan roots

- **Measured.** `/secure`: "/ application", "/ year · N applications", the two setup-fee sub-lines — **13px** (`components/estimate/SecurePlanChoice.jsx:99,102`). Estimate commercial proposal: "* Taxable line…" 13px. `/service-outlines`: "Lawn Care Program" chip, "Fertilizer" / "Insect control" / "Weed control" category labels, "EPA Reg. No." — **12px** (`text-xs`, `ServiceOutlinePage.jsx`; 09-07 F0332). Newsletter archive: "Free, no spam, unsubscribe anytime." 13px (`NewsletterSignup`, F0031).
- **Root cause.** C8: `components/estimate` and `components/` root are excluded from `check-portal-brand.js`; Tailwind `text-xs` is not a literal the gate recognises.
- **Also measured (run `codex-r4`).** Newsletter archive signup strip blurb "Free, no spam, unsubscribe anytime." **13px** (`NewsletterArchivePage.jsx:243` via the signup card, outside the gate's scan roots like G-04's Subscribe button).
- **Correction.** Snap the seven sites to 14; extend the gate to `components/estimate` (its ~35 legacy violations need one cleanup pass first, as the gate comment says) and to the `text-xs`/`text-[1[0-3]px]` utilities in customer files.

### G-06 · P2 · Reports render two footer landmarks on the real route

- **Measured.** `/report/:token` and `/report/project/:token` (spa-report-*, spa-project-report-*): `contentinfoCount = 2` — the page's own `<footer className="sr-footer">` (`ReportViewPage.jsx:9433`) / `<footer>` (`ProjectReportViewPage.jsx:793`) plus `WavesShell`'s `<footer role="contentinfo">`. Every other shell page = 1.
- **Expected.** DECISIONS 2026-09-04 (1): the shell owns the single footer landmark; pages never mount their own.
- **Correction.** Keep the closing sentence but render it as `<p>` / `<aside>` (the report's `.sr-footer` line is copy, not a landmark). Preview harnesses omit `WavesShell` (`service-report-preview-main.jsx`, `project-report-preview-main.jsx`), which is why this never showed in `qa:previews`; add the shell to those harnesses or rely on the `spa-*` scenarios.

### G-07 · P2 · Pages and states without an `h1`, and display text authored as `div`

- **Measured `h1Count = 0`.** `/track` en-route (all widths; F0260 partly fixed — scheduled / on-property / complete have one), `/appointment` all four states (F0260), `/rate` ("Hey Jordan, how'd we do?" is a 30px `div`), `/card`, report load-error, statement error, price-change error / not-found, prep-guide error, digital-card error.
- **Correction.** Promote the state title to `h1` (the sheet sizes it); G-02's shared card carries an `h1` by construction.

### G-08 · P2 · Uppercase CTAs on two glass surfaces

- **Measured.** `/track`: "TEXT ALEX" (`TrackPage.jsx:617`, authored uppercase); `/book`: "FIND MY BEST TIMES →", "CONTINUE →" (`styles/buttons.css:46` `text-transform: uppercase` on every customer `.btn`).
- **Expected.** Sentence case on glass (DECISIONS 09-04 batch B, owner D4; style guide Controls). Conflict C1 records that the brief and `buttons.css` still say uppercase — an owner confirmation closes it.

### G-09 · P2 · Status chips still render on seven surfaces

- **Measured.** Portal billing "paid" gold pill; `/secure` "$99.00 setup fee applies / waived" badges; estimate "Recommended", "Tech nearby", "WaveGuard Bronze"; appointment "45% rain" chip (gated); service outline "Lawn Care Program" 12px chip; report V2 bodies: lawn "Watch" / "Healthy" / "Balanced" / photo scores, pest "Before next service", mosquito "Weekly habit" / "Treated", tree & shrub "Watch" / "Healthy" (09-07 F0153); service report "Ready now" (F0326).
- **Status.** DECISIONS 2026-09-04 (4) removed chips from ten pages and explicitly left the estimate's and the report's for a ruling. Listed here as **owner decisions**, not defects, with the render evidence attached.

### G-10 · P2 · Overlay scrim blur is 5px, not the sheet's 8px

- **Measured.** Portal More sheet and Waves Assistant dialog: scrim `rgba(4,57,94,.38)` + `blur(5px)`; the sheet rule is `blur(8px)` (`glass-theme.css:353`, not `!important`, so the inline recipe wins — 09-07 F0247). Dialog tier itself is consistent: all three captured overlays are `data-glass="modal"`, radius 24.
- **Correction.** Make the scrim material `!important` in the sheet and delete the inline scrim recipes (09-07 G "Scrim").

### G-11 · P2 · Server twins drift from the sheet (email + newsletter landing)

- **Measured.** Gold CTA ink `#1B2C5B` on every email and landing CTA (C2); landing `h1` **30px** (sheet 32–40) on all nine landing branches including the quiz and feedback pages; email `h2` **22px** (sheet 26); the feedback needs-work form renders five native `<input type="checkbox">` at **13×13** with no styled hit area (touch floor 44); landing frosted `.box` uses `blur(14px)` with no `data-glass` attributes and its own fallback; footer social icons 28×28 and store badges 38–40px in `universalWavesFooterHtml` (each link IS named by its image's `alt`; only the hit size is a finding).
- **Root cause (shared).** `email-template.js GLASS_THEME` and `public-newsletter.js renderConfirmPage` are hand-maintained copies of the tokens.
- **Correction.** Generate `GLASS_THEME` from one token module shared with `theme-doc.js` (ink, accent, radii, type scale), or at minimum fix the two comments/values so the twin matches (`ctaText` → `#04395E`, landing h1 32, email h2 26), and wrap the feedback checkboxes in a 44px `<label>` hit area. Emails stay opaque by ruling.

### G-12 · P2 · The estimate's `.gc-*` recipes keep blur under forced colours and duplicate the tiers

- **Measured.** With `forced-colors: active`, tagged tiers go solid (`background: Canvas`, `backdrop-filter: none`) but `.gc-proof`, `.gc-section-cta` and `.gc-mbb` keep `blur(18–22px)`. Ten untagged inline-blur surfaces on every estimate scenario; 56–59 nested backdrop-filter elements per estimate page (reports 7–21, portal 3–46, flows 1–9).
- **Expected.** Three tiers only; nested surfaces tint-only (09-07 G "Inner / raised" rule); fallbacks cover every frosted surface.
- **Correction.** Fold `.gc-*` into the tiers (09-07 G sequence), and add the nested-blur cap. Performance impact is a **suspected** risk only — no frame-time measurement was taken.

### G-13 · P2 · Controls under 44px

- **Shared (one fix, every page).** `BrandFooter` store badges 42px, contact links 40px, "Customer portal" 41px — present on all 80+ shell captures.
- **Page-local.** Estimate "Text this to someone" / "Ask a question" 29px links, "What each season covers" 18px, "See everything included" 17px; portal account-menu chip 40 (C3), plan calendar 26px (F0304), property 30/32/39 (F0283), "Apply my account credit" 30, "Traveling?" 35; rate score buttons 40×29; pay "View full authorization" 17, "Retry" 37; receipt / reschedule "Try again" 40; lawn photo arrows 36; card page 36–40 (F0262).
- **Width, not only height (run `codex-r5`).** The census now flags a control when EITHER side is under 44. The reschedule week picker's day buttons (`.wpk-day`) are 39×48 at 390 — fourteen per capture on `spa-reschedule`, the only width-only rows across the login, booking, newsletter and reschedule re-captures.
- **Correction.** `BrandFooter` links to 44 (or a 44px hit area); then the page list; the week-picker day cell to a 44px minimum width (or a 44px hit area). Inline text links inside prose are exempt.

### G-14 · P2 · Contrast on the composited scene

- **Confirmed by authored colours.** "Tech nearby" `#16A34A` 14px on the slot card ≈ 3.1:1 (estimate, booking, reschedule); track "On the way" `#009CDE` 14px ≈ 2.9:1 (F0335); terminal-card "Call" white 15px on `#009CDE` ≈ 2.7:1 (F0139); GBP review "5.0" `#70757a` on the pale card ≈ 4.2:1 (documented literal palette, still below 4.5); newsletter archive article links `#009CDE` 16px on the white `srcdoc` iframe ≈ 2.9:1 (`NewsletterArchivePage.jsx` iframe stylesheet `a{color:wavesBlue}`; measured once the harness traversed the iframe, run `codex-r4`).
- **Candidates (sampler only, need a manual look).** Estimate "Recommended" badge, portal "JR" avatar initials, email footer links `#0A7EC2` on `#EDF4FA` (≈ 3.6:1 by authored colours — likely real), newsletter "Unsubscribe" `#4F5B70`. The worst-sample screen (run `codex-r3`, see §2.3) adds eleven more sampler-only rows on the re-captured pages (portal "For your property" / date line, estimate "Print" / "Quarterly" / plan eyebrow / tech name / contact link, tracker footer links and legal lines): every one has an average ratio above threshold and a single edge sample below it, consistent with a sample landing on an icon, rule or card edge rather than on the text's own background, so none is confirmed.
- **Placeholders (run `codex-r5`, sampled from the control's own paint).** Every glass input's placeholder is `#64748B` (slate-500) on a translucent field, so its ratio depends on the scene behind it: booking street address ≈ 2.8:1 average at both widths (field sits over the blue hero band), booking apt/unit ≈ 3.9:1, login phone ≈ 4.1:1, reschedule note ≈ 4.2:1, archive email ≈ 4.5:1. The address field is a confirmed failure; the others are within sampler tolerance of the threshold and are candidates.
- **Correction.** Move the five confirmed sites to the ink / muted tokens (the archive iframe's link colour included), give input placeholders the muted ink token and the field a floor opacity so the ratio no longer depends on the scene; re-sample.

### G-15 · P3 · Remaining drift (grouped)

- Off-scale sizes (C4): 17 / 19 / 22 / 24 / 28 / 30 / 50 / 64px metrics in portal, secure, track, rate; 14.5px runs in lawn and tree & shrub V2 reports (F0155); `smart-status-result` 24px on every report.
- Contract page header order (eyebrow → h1 → intro *above* the `DocumentActionBar`) differs from estimate / pay / receipt / prep (bar first). Owner ruled the contract follows the estimate header order (09-04); the bar position was not specified.
- Rate page renders its own logo block inside the card (identity duplicated with the shell header), card padding 0, 520px column.
- Newsletter archive adds a second dark chrome bar ("← WAVES NEWSLETTER") under the shell header, and its sandboxed article iframe authors `FONTS.serif` headings — the only serif on a glass surface (new conflict, needs a ruling: C9).
- Reduced motion mounts the five orbs (C7) — static, so low impact; doc/code drift.
- `/tech/<unknown>` falls through to the customer glass login (admin has a catch-all since #4201; tech does not).
- Three portal font stacks (admin Roboto, tech Inter — documented as Nunito Sans, customer system stack). Intentional split; the tech doc is stale.
- Full-page screenshot width 422 / 1472 on the estimate is the review ticker (`gc-proof-track`) extending past the viewport under `overflow-x: clip`; no user-visible scroll. Not a defect, but any visual-diff tool will see it.

### 3.1 Content / functional observations (not visual, out of scope for normalisation)

- Pay page with Stripe blocked shows two stacked error treatments ("Failed to load Stripe" red box + retry card) — `agent-billing/pay-card/stripe-blocked-390.png`.
- Contract load-error copy concatenates the API message and the help sentence without punctuation — `agent-billing/contract/error-390.png`.
- Booking confirmation joins address + city/zip with a trailing comma when city/zip are empty — `agent-diag/booking/step-1-390-step-4.png` (fixture-induced, real join-without-guard).
- Invoice table header clips "AMOUNT" at 320px — `agent-billing/pay-card/default-320.png`.

### 3.2 Documented intentional differences observed (no action)

Portal phone shell without footer; portal app bar instead of the shell header; `/card` dark glass; WDO / certificate reports non-glass (`glass=OFF` measured on `report-project-wdo` / `certificate`); emails opaque; report review-card `h2` at 20 (C5); `.waves-print-h1` 34 in print; admin and tech non-glass with no `backdrop-filter` anywhere (17 admin / tech scenarios, `glass.count = 0`, `inlineBlur = []`), and the theme attribute, orb / grain layers and inline html / body backgrounds all removed when navigating from `/login` to `/admin/login` inside the SPA.

---

## 4. Dimension summaries

- **A. Shells / margins.** One shell header (49px sticky, safe-area padded) and one footer on every shell page; the column and gutter fragmentation is G-01; reports double the footer landmark (G-06). Sticky / fixed bars all pad with `env(safe-area-inset-*)` in source; not provable in this environment.
- **B. Typography.** The sheet wins everywhere it reaches: one computed family on 100% of customer text nodes, h1 32 / 40, h2 26, h3 20, eyebrow 14/600/.06em on every page. Drift is at the edges the sheet does not reach: weights via shared tokens (G-04), sub-14 outside the gate (G-05), metric sizes (C4), server twins (G-11), the newsletter iframe serif (C9).
- **C. Glass materials.** Tier geometry is uniform: card 12 / soft 12 / accent 10 / chip 10 or 999 on every customer capture (the irrigation *preview* renders 8 because it is a component harness outside the theme). Untagged recipes remain on the estimate, the newsletter landing page and the card page (G-12); nested blur is heavy on the estimate; scrim blur drifts (G-10). Solid fallbacks work for tagged tiers under forced colours.
- **D. Components.** `BrandButton` primary 44 not 48 (G-03); secondary = 40 chip (C3); inputs 48 / r10 / 16px / italic 14 placeholder on every page except the portal's 44px search / referral inputs at 14px text and the login phone input at 52px / 18px; the portal still re-declares its own buttons, cards and dialogs (09-07 K.4 programme 7).
- **E. Navigation / chrome.** Consistent shell; newsletter archive adds a second bar; rate duplicates the logo; overlays share the modal tier; the tech portal leaks into the customer login on unknown routes.
- **F. Content / data.** Money everywhere renders through the estimate / receipt formatters with tabular figures; two content bugs noted in 3.1.
- **G. Interaction states.** Focus ring confirmed on keyboard Tab; hover specular and lift captured on desktop (`*-hover-card.png`); no lift at 390; disabled accent at .55 opacity; loading (auth-check card, estimate skeleton), empty, error and success states captured per family.
- **H. Responsiveness / accessibility.** No horizontal scroll on any customer capture at any width (`overflowX = 0`); the 320px invoice header clip is the one narrow-width regression; landmarks correct except G-06 / G-07; reduced motion honoured for transitions; contrast G-14.
- **I. CSS architecture.** Two `!important` layers (sheet + `.gc-*`), one hand-maintained server twin, five column recipes, a marketing token file still feeding weights and case into glass pages — the shared root causes behind G-01, G-03, G-04, G-11, G-12.

---

## 5. Remediation plan (ordered by level)

| Batch | Level | Change | Closes | Dependencies | Consumers affected | Regression checks | Rollback |
|---|---|---|---|---|---|---|---|
| R1 | Tokens / theme | `glass-theme.css`: accent `min-height` no longer clamps authored heights (48 stays 48); scrim material `!important`; forced-colours block covers `.gc-*`; `BUTTON_BASE` weight 800 → 600 and `.btn` customer weights / uppercase per C1 ruling; `email-template.js GLASS_THEME` + `renderConfirmPage` aligned (ink `#04395E`, h1 32, h2 26) or generated from one token module | G-03, G-04, G-08, G-10, G-11, G-12 (fallback half) | C1, C2, C3 rulings | every glass page, `/book`, all emails, newsletter landing | `run.cjs` full pass; `qa:previews`; email suite (`server` jest email tests); `check:portal-brand` | revert the two files; no data impact |
| R2 | Layout primitives | `CustomerColumn` (or `WavesShell` column prop) with document 760 / flow 640, one gutter, one top clearance; `PublicStateCard` for not-found / expired / error | G-01, G-02, G-07 (error states) | R1 not required | 11 page wrappers, 15 token pages' terminal states | `--extra` widths; digest "Layout geometry" one gutter; error-states family | keep old wrappers behind the primitive for one PR; revert per page |
| R3 | Shared components | `BrandFooter` 44px hit areas + icon names; `BrandButton` secondary per C3; report `<footer>` → `<p>`; `TrackPage` / `AppointmentPage` / `RatePage` `h1`; `SecurePlanChoice` 13 → 14; newsletter `Subscribe` 850 → 600, "Free, no spam" 14; `NewsletterSignup` scan | G-05, G-06, G-07, G-13 (shared half) | R1 | every shell page (footer), reports, three flow pages | `spa-*` parity scenarios; a11y landmark assertions | per component |
| R4 | Page families | Estimate `.gc-*` → tiers + nested-blur cap (walker retirement per 09-07 G); portal local buttons / cards / chips → `BrandButton` / `BrandCard` + 44px controls (F0283, F0304); report V2 chips per G-09 ruling; service outline onto `theme-doc` (F0332 ruling); `/book` case + chip style | G-09, G-12, G-13 (page half), G-15 | R1–R3, owner rulings in section 7 | estimate, portal, six report folders, outline, booking | family scenarios at all widths; `check:portal-brand` extended | per family PR |
| R5 | Route exceptions | `/tech/*` catch-all; rate page identity block / column; newsletter archive second bar + serif (C9); contract header order | G-15 | rulings | four routes | route scenarios | per route |

Not recommended: any global `!important` override on top of the sheet, shrinking text to fit, hiding the ticker overflow (it is already clipped), flattening the flow / document widths into one, or replacing `BrandButton` / `BrandCard` with another primitive.

---

## 6. Regression protection (existing tooling only)

1. **Keep the harness.** `scripts/qa/glass-audit/run.cjs` + scenarios become `npm run qa:glass` (Playwright is already a devDependency; `qa:previews` already uses the same `browser.js`). It never touches a database or provider.
2. **Layout assertions**, not screenshot diffs: per family assert `layout.gutterLeft`, `widestCard` ∈ {760, 640}, `contentinfoCount === 1`, `mainCount === 1`, `h1Count === 1`, `overflowX === 0`, no `text.under14`, no `text.over700`, no `controls.small` outside an allowlist, `glass.inlineBlur` empty outside `CardPage`, `glass.radiusByTier` ⊆ {12, 10, 999, 24}. These are the assertions `analyze.cjs` already computes; turn the digest sections into `assert` calls with a documented exception list (chips awaiting rulings, GBP palette, print modes).
3. **Theme-scope checks**: `theme-scope` family asserts `theme.mounted === false` and `glass.count === 0` on every admin / tech route, and `mounted === true` on every customer route (the `/tech/*` leak becomes a failing test until fixed).
4. **Accessibility**: landmark counts, keyboard-Tab ring probe on three pages, icon-only names — already in the harness; keep `eslint-plugin-jsx-a11y` out until the owner approves the dependency (09-07 K.4 8).
5. **Narrow-screen overflow**: `--extra` pass on the six `extraWidths` scenarios in CI weekly (not per PR — ~10 minutes).
6. **Token-usage gate**: extend `check-portal-brand.js` to `.css` under `client/src/glass`, `client/src/styles/buttons.css`, `theme-brand.js` constants, `components/estimate`, `components/*.jsx`, Tailwind `text-xs` / `text-[1[0-3]px]` in customer files; add `fontWeight` in shared constants to the scan; document exceptions in the script header.
7. **Fixtures**: the extracted preview payloads (`scripts/qa/glass-audit/fixtures/*.json`) and the agent-authored fixtures are fictional and stable; keep them with the harness. Add `WavesShell` to the report preview harnesses so `qa:previews` sees the real chrome.
8. **Reference screenshots**: the `.tmp/glass-audit/previews` and `parity2` captures at `eaf9a8745` are the baseline. New baselines are accepted only with a PR that names the finding they close — never to make a red run green.

**Canonical standard updates** (clarify, do not fork): add to `customer-doc-style-guide.md` — the phone gutter and top clearance values, the metric size role, the not-found / error card contract, the footer-landmark rule for reports, the overlay / popover radius, the scrim blur as `!important`; record C1–C9 rulings in DECISIONS. Point the design brief's "UPPERCASE CTAs" and font sections at the sheet.

**Proposed instruction for future agents** (for `.claude/skills/waves-design/SKILL.md` "Customer surfaces are GLASS"):

> Before changing any customer-facing render, read `docs/design/customer-doc-style-guide.md` and the 2026-09-04/05 DECISIONS entries; author with the shared primitives (`WavesShell`, `CustomerColumn`, `BrandCard`, `BrandButton`, `PublicStateCard`, `SchedulePicker`) and the sheet's `data-glass` tiers — never a local card, button, column, scrim or blur recipe. Before requesting review, run `npm run qa:glass -- --only <affected scenarios>` (or the ui-verify skill at 390 and 1440) and attach the captures; a passing build or unit suite is not evidence that the surface still matches the sheet. If a change touches a shared primitive, re-capture every family that consumes it.

---

## 7. Unresolved decisions and unverified areas

**Owner decisions needed** (in priority order): C1 button case on glass and on `/book`; C3 secondary `BrandButton` 40 vs 44/48 and the header account chip; the chip list in G-09 (WaveGuard tier, "Recommended", "Tech nearby", setup-fee badges, rain chip, report V2 status words, "Ready now"); C4 a metric size role; C6 rate (520) and contract (1080 wrapper) columns; C2 email CTA ink; C9 serif inside the newsletter iframe; C5 keep or drop the report review-card 20px exception; C7 orbs under reduced motion; whether the portal app keeps its 10px phone gutter; `ServiceOutlinePage`'s style system (09-07 F0332); `CardPage` dark glass (batch C).

**R2 status (2026-09-11).** R2a shipped: `CustomerColumn` (document 760 / flow 640, one 16px gutter, 28px top / 56px bottom clearance) replaced the eleven-plus wrappers and the five `index.css` classes G-01 names, per DECISIONS "R2a: one customer page column". R2b shipped: `PublicStateCard` (`state="not-found" | "expired" | "error"`, an `h1` by construction, `BrandCard`'s single padding, contact actions from `constants/business.js`) replaced the per-family terminal cards on all fifteen token pages, and `PublicLoadError` became a preset over it rather than a ninth recipe — per DECISIONS "R2b: one terminal-state card". Two carve-outs are recorded there and remain open: the four surviving phrasings of "not found" are a copy decision for the owner, and the pages whose phone number sits inside a sentence keep `contact="none"` rather than have that sentence rewritten.

**Access blockers / not verified.**
- Real iOS Safari / installed PWA: safe-area insets, notch overlap, keyboard viewport, Reduce Transparency, `backdrop-filter`-less engines, momentum-scroll behaviour of blur — none reproducible here.
- Touch hover / press feedback on a physical device.
- Print / PDF output of estimates and reports (the `@media print` block was read, not rendered).
- Stripe Payment Element, Google Places, Socket.IO tracker updates, recap video, social feed: external origins were blocked, so the populated in-iframe states are not captured.
- The legacy server-rendered estimate (`estimate-public.js renderPage`) — still served in production for quote-required, authored-proposal, manager-approval and `/api/estimates/:token` links (agent report, `estimate-public.js:8443-8495`, migration `20260628000001`) — could not be rendered without a database. Its parity with the React page (09-07 audit #4) is **NOT VERIFIED** in this pass.
- Email clients (Gmail dark transform, Outlook): only the raw HTML was rendered in Chrome.
- Native app (Capacitor) chrome, `BiometricGate`, `InstallPrompt`, `NotificationBell` sheet: not reachable through the fixtures.
- Portal tabs were rendered through the `preview-portal.html` harness (real component, stubbed API), not the authenticated `/` route; the app-level auth-check and failure screens were rendered on the real route.
- Admin / tech pages beyond the shell (populated data) — out of scope, empty / error states only.

---

## 8. Summary

- **Routes discovered:** 41 customer render routes / tab states, 6 redirects, 4 server-HTML families, 48 admin routes, 7 tech routes.
- **Routes in scope:** every customer glass route and server-HTML family (glass); admin and tech shells for scope leakage.
- **Routes actually inspected:** all of them — 123 scenarios / 163 scenario-states; no scenario is `NOT VERIFIED` or `BLOCKED` in the matrix.
- **Desktop / mobile coverage:** 100% of scenarios at 390 and 1440 (headless Chrome); 11 in WebKit at 390; 22 at 320 / 375 / 430 / 768 / 1024; emails at 640. 595 captures, 157 interaction captures.
- **States and overlays verified:** populated, loading (auth check, estimate skeleton), empty (cancelled account, no visits), error (500), not-found (404), expired, paid / unpaid / covered-by-credit, unsigned / signed / autopay, upcoming / confirmed / cancelled, four tracker states, booking steps 1–4, reduced motion, forced colours; More sheet, account menu, Waves Assistant dialog, slot pick, confirm, rate, quote request, hover and keyboard focus.
- **Confirmed findings:** P1 × 4 (G-01 columns / gutters, G-02 error cards, G-03 primary button height, G-04 weights via shared tokens), P2 × 10 (G-05 … G-14), P3 × 1 group (G-15), plus 4 content observations and 9 standards conflicts (C1–C9) needing rulings.
- **Highest-impact shared root causes:** (1) no page-column primitive; (2) `!important` floors in the sheet that override authored control heights; (3) marketing tokens (`BUTTON_BASE`, `buttons.css`) still feeding glass pages outside the gate; (4) per-page terminal-state cards; (5) hand-maintained server twins of the tokens.
- **Explicitly unverified:** real iOS / PWA behaviour, reduced transparency, legacy SSR estimate, email clients, third-party iframes, native app chrome (section 7).
- **Recommended implementation order:** R1 sheet + tokens → R2 column + state-card primitives → R3 shared components → R4 page families → R5 route exceptions, each followed by a `qa:glass` re-capture of the affected families, not just a build.
