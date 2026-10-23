# Tool inventory tracker (truck kit): scope

> **Status 2026-10-23:** owner approved the recommendation ("do whatever you
> recommend"). PR 0, PR 1 and PR 2 below are BUILT on branch
> `claude/tool-inventory-tracker-scope-oh0xoa` (three commits, one per slice),
> with the recommended answer taken on each owner decision: weekly cadence
> (`CHECK_INTERVAL_DAYS` in `server/services/truck-kit.js`), one technician
> write endpoint (`own-truck` bucket), nothing deducts anything, the vehicle
> inspection stays a staff document, gate `GATE_TRUCK_KIT` (dark). Two
> implementation choices differ from the PR 1 text: `equipment_checks` has no
> `kind` column (only the truck check exists, so a one-value CHECK earned
> nothing) and a tool reported missing or damaged on an earlier check defaults
> to that state on the next check, so a tap on "Everything's here" can never
> quietly find it. PR 3 (receipt link, Intelligence Bar reads, the tax de
> minimis threshold) is NOT built: decision 7 is still the owner's and the
> accountant's. No database was available to the build session; the two
> migrations were exercised against stub builders only, so the first preview
> deploy is the migration proof.

Scope proposal, 2026-10-22. It proposes; it decides nothing. Section 8 lists the
owner decisions. Every "exists" claim below was read from the portal checkout at
`1cd5552` with no database access, so it describes code and seeds, not
production rows.

**Ask (Adam, 2026-10-22):** a post on X about a service company's truck and
tools prompted "that's why people call us first" and "tool inventory tracker, I
think this might be useful, scope it out". The post itself could not be fetched
from the scoping session (x.com and its mirrors are blocked by the session's
network policy), so this scope works from the framing: Waves gets called first
because the truck shows up with what the job needs, and the owner wants that to
stay true as the team grows past one truck. If the post was about something
else (theft, or per-truck chemical stock), say so: section 5 changes.

## 1. Verdict

Worth doing, in a narrow shape. Build a **truck kit standard with a one-minute
truck check and a one-tap missing-or-broken report**, on top of the asset
register the portal already has. Do not build a barcode custody ledger (scan
out, scan in, cycle counts) yet.

Why this shape:

- The portal already holds most of the data model. `equipment` has per-item
  identity (`asset_tag`, `serial_number`), a holder (`assigned_to`), a vehicle
  link (`assigned_vehicle_id`, never wired), a `location`, a `status` list that
  includes `lost`, a `condition_rating`, a purchase price and a photo column.
  The trucks are already rows in that table (`category='vehicle'`, VEH-001).
  The per-service "what to grab" lists already exist in `equipment_checklists`.
  A "tech reports an equipment problem" endpoint already exists with no button.
  What is missing is the roster per truck, the check itself and the tech-side
  write path. That is a small build, not a new system.
- Why now: the owner ruling of 2026-10-22 behind `GATE_TECH_START_POINTS` says
  a second tech may take the truck home. A truck's contents will be out of the
  owner's sight overnight for the first time. The kit standard has to live
  somewhere other than Adam's head, and a missing tool has to reach the office
  before the next job, not after it.
- Why not the full ledger: at one or two trucks the custody question is "did it
  leave with the truck", not "which of forty techs has the drill". Scan-based
  check-out gets skipped on a 6:30 am departure and the data rots within a
  month. Revisit when there are three or more trucks, a shared tool pool at a
  shop, or a loss history that justifies it (section 5, option B).

The return is honest but modest at one truck: it removes the second trip (a
tech hour plus drive time plus the customer's patience) and the "where is the
moisture meter" text thread. At two trucks with one parked at a tech's home it
becomes real, because that is when tools walk and when a job gets booked onto a
truck that lacks the tool for it.

## 2. What already exists (verified in code)

| Piece | State | Where |
|---|---|---|
| Operational asset register `equipment`: `name`, `category`, `asset_tag` (unique), `serial_number`, `purchase_price`, `assigned_to` (FK `technicians`), `assigned_vehicle_id` (self FK), `location` (free text, default `van`), `status` (`active`, `maintenance`, `retired`, `sold`, `lost` in the UI), `condition_rating`, `photo_url` | Built, live at `/admin/equipment` Assets tab, Tier 1 UI | migrations `20260401000073`, `20260401000097`; `client/src/pages/admin/EquipmentPage.jsx` |
| Trucks are `equipment` rows (`category='vehicle'`); a tech's truck is the row with `assigned_to = tech`, the rule Bouncie mileage attribution already uses | Built | `server/services/bouncie-mileage.js:353-362`; seed VEH-001 (Ford Transit 250 AWD) in `20260401000098` |
| Hand equipment already entered as rows (LESCO 50 lb and 5 lb spreaders, B&G 1 gal sprayer, FlowZone soil injector kit), one row per model, no truck link | Built (seed) | `20260927020000_tree_shrub_owned_equipment.js` |
| Per-service "what to grab" checklists for lawn, quarterly pest, tree and shrub, termite and mosquito; items carry `required` | Built, read-only display, no check-off state | `equipment_checklists`; `GET /api/admin/protocols/equipment`; `TechProtocolsPage.jsx` Equipment tab; job card Protocol panel |
| Tech issue report backend: `POST /api/admin/equipment-maintenance/issue` writes a `maintenance_alerts` row and drops `condition_rating` on high severity | Built, **no client caller** | `routes/admin-equipment-maintenance.js:712`; `services/equipment-maintenance.js:526` |
| Maintenance alerts list on the Fleet tab (`maintenance_alerts`: `alert_type`, `severity`, `status` new, acknowledged, resolved) | Built; DB rows only, no bell or push | `EquipmentMaintenancePage.jsx` |
| Admin bell contract `raiseAdminAlert` (area `Inventory` exists; subject types are customer, visit, invoice, estimate, lead, call, check) | Built | `server/services/admin-alert-compose.js`; `docs/admin-notifications.md` |
| Receipt inventory agent flags a purchased sprayer or tool as `agent_equipment` and rings "add it to the equipment list if you're keeping it" | Built, dark (`GATE_INVENTORY_AGENT`); no auto-create of an `equipment` row | `services/purchase-receipts/inventory-agent.js:1220` |
| Tax register reconciliation (`equipment` against `equipment_register`), with a serial match and an "active asset with a price and no tax link" finding | Built, read-only panel | `services/equipment-reconciliation.js:276`; Calibrations tab |
| Technician allow-list: equipment and inventory are GET-only for techs; two field writes kept (owner 2026-10-03, "narrow") | Built, enforced only when `GATE_STAFF_DEFAULT_DENY` is on | `server/middleware/technician-scope.js:163-177`; `docs/technician-reachable-routes.md` |
| Tech field workspace at `/admin/today` (the `/tech/*` paths redirect there) with a Tools tab grid and a Today column that carries the Time Clock card | Built | `client/src/pages/tech/TechHomePage.jsx:806-812`; `TechFieldHome.jsx` |
| Staff document starters `vehicle-use-commuting-agreement` ("Assigned vehicle" as free text) and `vehicle-inspection-record` with `[DECISION: confirm inspection items and cadence]` | Starters only, unissued | `server/services/staff-document-starters.js:103-121` |
| Quick Move reason "Equipment trouble" (`equipment_issue`): reschedules and texts the customer | Built, dark (`GATE_QUICKMOVE_EXTRA_REASONS`); writes no equipment record | `services/rain-out.js:55`; `TechHomePage.jsx:1511` |
| Company stock (`products_catalog.inventory_on_hand`) is one global pool with no truck or holder dimension: "Stock means company inventory, not a truck count" | Built, by design | `docs/dispatch-readiness-strips.md`; `services/inventory-operations.js` |

Two findings from the survey are defects regardless of this scope:

- The tech Protocols page's Equipment tab renders each checklist group as raw
  JSON. The seeded shape is `[{category, items:[{item, required}]}]`; the
  renderer looks for `label` or `name` on each top-level entry and falls back
  to `JSON.stringify` (`TechProtocolsPage.jsx:325`). The job card version
  renders the same rows correctly.
- The Assets add/edit form cannot set `asset_tag`, `location`,
  `assigned_vehicle_id` or `condition_rating`: the create destructure and
  `ALLOWED_FIELDS` in `routes/admin-equipment.js:66-112` exclude them, and
  "Assigned To" is a plain text input for a uuid. Those columns are reachable
  only through seeds or the uncalled `/api/admin/equipment-maintenance` POST,
  which spreads `req.body` into the table unfiltered.

## 3. What does not exist

- A roster per truck. `assigned_vehicle_id` is the only item-to-truck link and
  nothing reads or writes it. There is no expected loadout and no way to say
  "truck 2 carries what truck 1 carries".
- Small tools as rows. Flashlights, moisture meters, dusters, bait guns and PPE
  exist only as free text inside checklists. The Assets form offers no `tool`
  or `safety` category (the Fleet icon map has both).
- A check. No table records "on this date this tech confirmed these items were
  on this truck". Under the allow-list a technician has no equipment write at
  all.
- A loss or damage report with a trail. `status='lost'` is a dropdown value:
  no when, no who, no last check that showed the item present.
- A link from a service type's required tools to what a given truck carries,
  so nothing can warn "this termite inspection needs a moisture meter and that
  truck has none".
- Any notification: maintenance alerts are rows on a tab nobody is paged to.
- A receipt-to-asset path: an `agent_equipment` receipt line is a bell and a
  dead end.
- Intelligence Bar coverage of operational equipment (the only equipment tool
  reads the tax depreciation register).

## 4. Industry baseline

From general knowledge, not fetched: the reference sites were unreachable from
the scoping session. Tool trackers sold to pest and lawn operators (Sortly-class
apps, the asset modules in field-service suites) converge on a catalog with
photos and labels, QR or barcode scanning, per-location quantities (shop,
truck, tech), check-out and check-in with a holder, missing and low-stock
alerts, periodic counts, and loss and replacement-cost reporting. The parts
that earn their keep at Waves' size are the catalog, the per-truck roster, the
periodic count and the missing alert. The parts that do not are scanning,
per-tool custody history and per-truck consumable counts. Third-party apps are
also out by rule 9 (all automation and site infrastructure native).

## 5. Options

**A. Truck kit standard plus truck check (recommended).** Tools become
`equipment` rows assigned to a truck. The truck's roster is the kit standard. A
tech runs a grouped checklist in about a minute: everything present by default,
tap an item to mark it missing or damaged, optional note. Issues become
`maintenance_alerts` rows and one office bell per check. Later, a job-type gap
check compares the day's visits against each truck's roster. Three PRs plus one
optional (section 6).

**B. Full custody ledger.** Everything in A plus QR labels, scan check-out and
check-in per tool, per-tool custody history, cycle counts with photo evidence.
Roughly double the build, and the daily scan is the part that gets skipped.
Defer. Revisit triggers: three or more trucks, a shared tool pool at a shop or
storage unit, or a documented loss in a year that costs more than the build.

**C. Paper equivalent: issue the vehicle inspection staff form with tool
checkboxes.** The controlled-staff-documents lane
(`GATE_CONTROLLED_STAFF_DOCUMENTS`) already has a `vehicle-inspection-record`
starter. Add the tool items as checkboxes, resolve the `[DECISION]` marker,
issue it. No new code path. But it is a compliance record, not an operations
tool: no link to asset rows, no alert to the office, no job-type gap check, no
photos (staff forms carry text, date and checkbox fields only), and completed
records are immutable by trigger. Acceptable as a week-one stopgap while A
ships; not a substitute.

## 6. Recommended build (option A)

### PR 0: fix the plumbing (no gate, about a day)

1. Render the checklist groups on the tech Protocols page (the raw-JSON
   defect).
2. Assets form: a truck picker for `assigned_vehicle_id` (rows with
   `category='vehicle'`), a `location` select (`van`, `storage`, `field`, the
   values the seeds use), `asset_tag` and `condition_rating`; "Assigned To"
   becomes a technician picker. Extend the create and update whitelist in
   `routes/admin-equipment.js` to match. Add `tool` and `safety` to the
   category list (the icon map already has them).
3. Assets list: show truck and holder on the card and filter by truck (the
   list endpoint already accepts `assigned_to`).

The owner then enters rows once, from the five seeded checklists: roughly 25
to 40 tracked items on the van. Rule of thumb for what gets a row: anything you
would be annoyed to discover missing at a job, or anything with a serial
number. Gloves, glue boards and baits stay consumables in `products_catalog`.

### PR 1: truck check, dark behind `GATE_TRUCK_KIT` (three to four days)

- **Migration.** `equipment_checks`: `id`, `vehicle_id` FK `equipment`,
  `technician_id` FK `technicians`, `kind` CHECK (`truck`, `pre_job`),
  `scheduled_service_id` nullable, `started_at`, `completed_at`, `results`
  jsonb (`[{equipment_id, state: present | missing | damaged, note}]`),
  `missing_count`, `damaged_count`. New `maintenance_alerts.alert_type` values
  `tool_missing` and `tool_damaged` (the column has no CHECK; the values live
  in code). No new truck table: the decision recorded in
  `20260422000008_vehicle_locations.js` stands, trucks stay `equipment` rows
  plus the Bouncie columns on `technicians`.
- **Tech route** `server/routes/tech-truck-check.js`, opened with
  `router.use(adminAuthenticate, requireTechOrAdmin)`. `GET /api/tech/truck-check`
  returns the signed-in tech's truck, its roster grouped by category and the
  last check; `POST /api/tech/truck-check` records one. The truck resolves the
  way mileage attribution does it: the non-retired `category='vehicle'` row with
  `assigned_to = req.technicianId`. One allow-list entry in
  `technician-scope.js` (new bucket `own-truck`), then
  `npm run check:technician-routes` to regenerate
  `docs/technician-reachable-routes.md` (CI fails when it is stale).
- **Effects of a submit.** Each missing or damaged item opens or refreshes one
  `maintenance_alerts` row (dedupe on an open alert per `equipment_id`); damaged
  goes through `reportEquipmentIssue` so the condition drop stays in one place;
  a check with at least one issue raises one bell through `raiseAdminAlert`
  (area `Inventory`, severity `needs-you`, link
  `/admin/equipment?tab=maintenance`). The subject-type list needs an
  `equipment` entry, a one-line contract change in `admin-alert-compose.js` and
  `docs/admin-notifications.md`. A clean check writes its row and nothing else
  (hands-off by default, rule 14). Marking an item `lost` stays an office action
  on the Assets dialog.
- **Tech UI.** A "Truck check" tile on the Tools tab (`fieldTools` plus an icon
  key in `TechFieldHome.jsx`) and a Today-column card when the truck's last
  check is older than the cadence, beside the Time Clock card. The sheet uses
  the field-workspace tokens (`tech-field.css`, `--tfx-*`) like the other
  workspace pages, one component on one style system (rule 4). Target under
  sixty seconds: "Everything's here" is one tap.
- **Admin.** The Fleet tab's alert list already renders alert rows; add the two
  types and a resolve action with an outcome (`found`, `replaced`,
  `written_off`) that updates the asset's `status`. Resolution closes the bell
  through `closeAdminAlertKeys`.
- **Docs and gates.** `GATE_TRUCK_KIT` in `server/config/feature-gates.js`, one
  paragraph in `docs/gates-and-env.md`, `npm run gates:index`. A contract test
  for the route shape. The alert ratchet test forbids a raw `notifyAdmin` call,
  so the lane goes through `raiseAdminAlert` from the start.

### PR 2: job-type gap check (two to three days)

This is the piece that delivers "never show up without it".

- Give tools a stable key: `equipment.kit_key` (varchar, for example
  `moisture_meter`, `bg_sprayer`, `hammer_drill`) and an optional `kit_key` on
  checklist items (`{ item: 'Moisture meter', required: true, kit_key:
  'moisture_meter' }`). A truck has a required tool when an active row with
  that key is assigned to it and the latest check did not flag it.
- Surfaces: a new "tools" exception on the Schedule readiness strips
  (`docs/dispatch-readiness-strips.md`; the readiness route already builds
  per-visit facts) for visits whose service line needs a tool the assigned
  truck lacks, and a line on the tech's "Up next" card ("needs: moisture meter,
  not on your truck").
- Keyed items only: free-text checklist items without a key stay display-only,
  so the five seeded lists can be keyed one at a time.

### PR 3 (optional): close the loops (one to two days)

- Receipt agent: when an `agent_equipment` line arrives while a `tool_missing`
  or `tool_damaged` alert is open, the bell names the asset and links to the
  Assets dialog with the row pre-filled; the line gets an `equipment_id` so
  the purchase is traceable.
- Intelligence Bar, read tools only. Admin equipment context: `get_truck_kit`,
  `get_tool_issues`. Tech context: `get_my_truck_kit` (the tech bar stays
  read-only and isolated). No write tool; the sheet is the write path.
- Tax noise: the reconciliation flags every active row with a `purchase_price`
  and no tax link (`equipment-reconciliation.js:276`). Thirty priced hand tools
  would raise thirty info findings. Add a de minimis threshold to that finding
  (the number is an owner and accountant call) so cheap tools can carry a
  replacement price without becoming tax-register work.

Effort in developer days, excluding the owner's one-time data entry:

| Slice | Days | Delivers |
|---|---|---|
| PR 0 | 1 | Working asset form, tools as rows, checklist defect fixed |
| PR 1 | 3 to 4 | Truck check, missing or damaged report, office bell |
| PR 2 | 2 to 3 | Job-type gap warnings on dispatch and on the tech's next stop |
| PR 3 | 1 to 2 | Receipt link, IB reads, tax de minimis |

PR 0 and PR 1 together are the product. PR 2 is the differentiator. PR 3 is
polish.

## 7. Non-goals and guardrails

- No per-truck consumable counts. Company stock stays one pool; a truck check
  covers durable tools only. Per-truck chemical stock is a different and much
  larger change (about 96 server files touch `products_catalog`).
- No scanning, QR labels or custody ledger in v1 (option B).
- No new `vehicles` table and no third-party inventory app.
- No customer communication from any of this (rule 12). A missing tool reaches
  the office; the customer-facing "Equipment trouble" Quick Move stays as it is.
- `equipment_register` (tax) is not collapsed into `equipment` (capabilities
  audit ruling).
- The tech Intelligence Bar stays read-only.
- Technician writes stay on the narrow allow-list: one new bucket for the truck
  check, nothing opened on the admin equipment routers.

## 8. Owner decisions

1. **The thesis.** Confirm the post was about preparedness (right tool on the
   truck) rather than theft or per-truck chemical stock. The recommendation
   changes if it was.
2. **Cadence.** Weekly truck check plus ad hoc is the recommendation; daily is
   check fatigue; pre-job only misses the overnight gap. The Today card nags
   only when the check is overdue.
3. **What gets a row.** The threshold for a tracked tool (recommended:
   job-critical, or serial-numbered, or roughly fifty dollars and up);
   everything else stays a consumable.
4. **Tech writes.** Approve one new technician write endpoint (the truck check)
   under the narrow allow-list policy of 2026-10-03.
5. **Accountability.** Whether a lost tool ever ties to
   `{{policy.equipment_deduction_terms}}` (an allowed policy binding with no
   seeded text) is an HR and legal decision. The tracker's job is only to
   record the last check that showed the tool present and who had the truck.
   Nothing in this scope deducts anything.
6. **Vehicle inspection.** Keep the safety inspection as a controlled staff
   document (immutable compliance record; its cadence decision is still open in
   the starter) and the tool check as an operations tool, or fold the
   inspection items into the truck check. Recommendation: keep them separate;
   they answer different questions.
7. **Tax de minimis** threshold for the reconciliation finding (PR 3).
8. **Gate name.** `GATE_TRUCK_KIT`, or a name of the owner's choosing.

Adjacent, not in scope: the preparedness promise is also content. A hub page on
what rides on every Waves truck would turn the same kit standard into a trust
page. Say the word and it gets its own scope.
