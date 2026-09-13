# Multi-property model

One customer can own several service addresses (e.g. a landlord's rental + their
own home). This replaces the awkward "each property = a duplicate customer row"
pattern (`customer_accounts`, migration `20260504000008`), which is now **frozen
for new data**.

## Phase 1 (this PR) — additive, gated, no rewiring

- **`customer_properties` table** (migration `20260629000001`): one customer →
  many properties, each with `occupancy_type` (owner_occupied / family_occupied
  / rental_investment / commercial / seasonal / vacant / unknown — `family_occupied`
  is office-set only, the call extractor's enum does not include it), `is_primary` (partial-unique: one
  per customer), address + lat/lng, and mirrored property attributes. Backfills a
  PRIMARY property per existing customer from their address (defaults
  `owner_occupied`; the schema-drift-safe backfill only mirrors columns that
  exist on `customers`).
- **`customers.address_*` stays the denormalized mirror of the primary property**,
  so the ~310 readers (scheduling, estimates, billing, Stripe) are untouched.
- **Call pipeline** (`call-recording-processor.js`): when a call surfaces a
  service address different from the one on file, it now stores a second
  (non-primary) property instead of only raising the `second_service_address`
  flag — occupancy inferred from the rental signal. Ensures a primary exists for
  any resolved customer. **Gated behind `GATE_CUSTOMER_PROPERTIES` (default off)**
  so it ships dark; flip it on after the migration has run in prod.
- **Admin API** (`admin-customers.js`): `GET/POST/PATCH /:id/properties`
  (read lazily backfills a primary; POST adds a non-primary; PATCH edits
  occupancy/label). Read is open; writes require admin.
- **Booking anchor** (`soleActivePropertyId`): a booking with no explicit
  property resolves the customer's sole active property. A customer with NO
  row yet (created since the migration through a quote / lead / webhook path
  that never read the properties) gets the primary backfilled here too, so
  the visit-group stamp has an anchor instead of NULL. An inactive-only
  primary stays untouched. Historical gap: `ops/agents/primary-property-backfill.js`.
- **Daily backstop** (`sweepMissingPrimaryProperties`, scheduler 3:20 AM ET,
  job `primary-property-backstop`): none of the customer-insert paths create
  the primary, so any live, addressed customer with no property row gets one
  within the day (newest first, per-row lock + re-check, same core as the
  lazy reads). A later consumer may therefore assume the row exists after at
  most a day — never at insert time; the booking anchor above backfills its
  own at booking time, so the sweep is what covers every customer no booking
  has reached.
  The day holds while the backlog is under the run's `maxRows` guard (2000);
  a capped run logs a warning and the remainder waits for the next tick.
  Rows the sweep creates carry `source = 'backfill'`, so with
  `GATE_PROPERTY_ENRICH_BACKFILL` on they enter the nightly paid enrichment
  candidate set (`fetchBackfillCandidates`, `call-property-lookup.js`) —
  bounded by `PROPERTY_BACKFILL_BATCH` (default 20/night) and the 14-day
  attempt cooldown, so it reorders that spend rather than adding to it; with
  the gate off (call-recovery mode) candidates are fenced to call-pipeline
  provenance and these rows are untouched.

Service: `server/services/customer-properties.js` (pure helpers `normStreet` /
`normalizeOccupancy` / `isNewStreet` are unit-tested in
`tests/customer-properties.test.js`).

## Deferred — needs owner decisions before building

- **Phase 1b (UI):** Customer 360 "Property" tab renders the list with occupancy
  badges; repoint `CustomersPageV2.onAddProperty` from "create sibling customer
  row" to `POST /:id/properties`.
- **Phase 2 (property-aware ops):** add nullable `property_id` to
  `scheduled_services` (it already has a `lat`/`lng` seam), `estimates`, `leads`;
  booking/dispatch resolve location from the property when present.
- **Phase 3:** move property attributes (`lawn_type`, `property_sqft`, …) to be
  authoritative on the property; stop writing the `customers.address_*` mirror.

Decided 2026-06-29: **new table (not extend `customer_accounts`); WaveGuard tier
stays per-customer** (applies to all of a customer's properties). Open: sibling-
row reconciliation, FK required/nullable, billing grain, backfill occupancy
default.

## 2026-09-06 — New Appointment service-address picker

- When the customer has 2+ active properties AND `GATE_EDIT_APPT_ADDRESS=true`,
  the New Appointment modal renders a radio list of their saved addresses
  (incomplete rows shown disabled; default = the primary when it is complete,
  else the first complete row) and POSTs `propertyId`. The create route
  resolves it through `bookingPropertyStamp` (`services/customer-properties.js`)
  into the same `property_id` + `service_address_*` + `lat`/`lng` stamp the
  Edit-appointment address change writes; recurring children and boosters
  inherit it via `copyStampedServiceAddressFields`; zone / tech match use the
  chosen property; the duplicate-series guards run with the converter's
  `buildSeriesAddressScope` so a series at the home does not 409 one at the
  rental. Off-gate a `propertyId` is refused (409); absent, the sole-property
  anchor applies as before. A linked estimate quoted for a different property
  is refused (422 `ESTIMATE_PROPERTY_MISMATCH`); the modal narrows the estimate
  list to the chosen property (`schedule-estimates` / `schedule-source` return
  `propertyId`) and drops a mismatched quote's lines on switch. Find-a-Time and
  the best-times hint score at the chosen property's coords, or geocode its
  address before any customer-primary fallback.
- Known limit (Phase 3): auto-priced lines (the one-time mosquito lot ladder)
  still read `customers.lot_sqft` — the PRIMARY's lot — so the picker says so
  and a typed price is the office's override until pricing attributes move
  onto the property row.

## 2026-09-06 — property relationship field

- **`customer_properties.relationship`** (migration `20260906000020` adds the
  column; `20260906000050` corrects its backfill — see below; vocabulary
  `constants/property-relationships.js`): `own_home` / `rental_owned` /
  `family_home` / `managed_for_client`, nullable, CHECK-constrained. Owner
  decision 2026-09-06: "family" is a RELATIONSHIP (the payer's tie to the
  address), not a seventh occupancy value. Backfilled only where the contact
  role proves it (property-manager profiles → `managed_for_client`);
  occupancy is never read as ownership evidence, so every other legacy row
  stays NULL for the office to set. `20260906000020`'s first revision derived
  `own_home` / `rental_owned` from occupancy and had already run on the PR's
  Railway preview when that was corrected, so the file stays at the revision
  those environments ran and `20260906000050` clears the occupancy-derived
  values (untouched rows only, prior values in `audit_log`). The original
  manager stamp stands and is never re-asserted — an office edit after it
  wins; the correction only records which rows that stamp touched
  (`original_backfill_manager_rows` on its audit row). A property-manager
  profile's lazily created primary carries `managed_for_client` by default
  (`defaultRelationshipForContactRole`). Editable on the
  Customer 360 Properties panel (row select + add form); `POST`/`PATCH
  /:id/properties` validate it; `recordCallProperty` accepts it but the call
  pipeline does not classify it yet.
- Still deferred: per-property on-site contact / access notes, per-property
  pricing attributes (Phase 3), and the multi-property estimate group UI
  (reuses the existing multi-home discount — owner 2026-09-06).

## 2026-09-08 — App property scope (PR 1 of 4: session claim + saved-property list)

The customer app scoped everything by sibling PROFILE (#3971): the session
points at one `customers` row and every read filters on `customer_id`. That
misses every customer whose second house is a `customer_properties` row on the
same profile (prod 2026-09-08: 23 such customers vs 6 profile-based accounts).

Under `GATE_APP_PROPERTY_SCOPE` (call-time; off = tonight's behavior exactly):

- **Session claim.** Customer access and refresh tokens carry `propertyId`
  (the selected `customer_properties.id`). `middleware/auth` honors it only
  when the row is the signed-in customer's and active — anything else is "no
  selection" (`req.propertyId = null`), never a 401. A same-profile refresh
  forwards the claim; a profile switch drops it unless the switch names one.
- **Unified list.** `GET /auth/properties?scope=saved` returns every active
  saved property of every profile on the account (`services/account-properties`
  `accountSavedProperties`): entry = `{ key, customerId, propertyId, label,
  relationship, occupancyType, address, isPrimaryProfile, isPrimaryProperty }`
  plus `selected`. The profile list stays the default, so shipped clients see
  no change. `POST /auth/select-property` accepts the pair
  `{ customerId, propertyId }`; a same-profile switch re-issues the tokens
  with the new claim.
- **Visit rule.** `resolveSessionScope(req)` + `scopeVisitsToProperty(qb, scope)`
  (PR 2 wires them into the schedule routes): a property's visits are the
  customer's visits stamped with it, plus unstamped visits when it is the
  primary. Customers with 0–1 active properties get no property predicate.

### PR 2 of 4 — visits by saved property (client + schedule/tracking routes)

- **Schedule routes** (`routes/schedule.js`): `GET /` and `GET /next` resolve
  the session scope (`resolveSessionScope`) and apply the property half of the
  visit rule (`applyPropertyPredicate`) on top of today's customer predicate;
  the confirm and reschedule lookups do the same, so a visit at another of the
  customer's properties is a 404 exactly like a foreign id. New
  `GET /schedule/properties-next` (gate on only, 404 dark): one row per unified
  entry — `{ key, customerId, propertyId, next }` — with visits assigned by
  `assignVisitsToEntries` (unstamped → the profile's primary entry; stamped →
  that entry; a stamp on a property no longer listed → nobody, matching what
  the list route would show). `/account-next` is unchanged for shipped
  clients.
- **Tracking** (`routes/tracking.js`): the canonical tracker query takes the
  scope (`opts.scope`) so `/tracking/active` and `/tracking/today` follow the
  house being viewed; the pin/ETA already prefer the visit's stamped geocode.
- **Client**: `useAuth` asks `GET /auth/properties?scope=saved`, maps saved
  entries onto the client property shape (`id` = entry key; label = office
  label → "Home" for the primary → street for a secondary), exposes
  `propertyScope` + `selectedProperty`, and `switchProperty` takes a string
  (profile id, legacy) or `{ customerId, propertyId }`. The page compares every
  switcher against `activePropertyId` (the selection's key, else the profile),
  keys the read cache on it, and the Visits tab reads `/schedule/properties-next`
  under the saved scope. Preview harness: `?properties=saved[&selected=<key>]`.
- Gate off: the server answers the profile list, the client stays in profile
  mode, every query is byte-identical to today's.

### PR 3 of 4 — appointment texts by saved property (migration + card + sender seams + shadow log)

- **Schema** (`20260909000030_property_notification_prefs`): `property_notification_prefs`
  — one row per `customer_properties` row, the five appointment toggles
  (`appointment_confirmation`, `service_reminder_72h`, `service_reminder_24h`,
  `tech_en_route`, `tech_arrived`) plus `appointment_notify_primary`, every
  column NULLABLE (NULL = not chosen). No backfill: an absent row IS the
  default, and the PRIMARY property never gets a row — it keeps reading the
  customer's `notification_prefs` row byte-for-byte. `property_text_decisions`
  is the ruling-R5 shadow log (below).
- **Ruling R1 default** (`services/property-notification-prefs.js`
  `defaultPropertyToggles`): `own_home`, `family_home` and unrecorded
  relationships inherit the customer row; `rental_owned` and
  `managed_for_client` start OFF for the five toggles (the 2026-09-06
  "rentals default off" ruling); "send these to me too" always inherits.
- **Two gates, read at call time.** `GATE_APP_PROPERTY_SCOPE` off: the new
  table is never read and every resolver answers the customer row.
  `GATE_APP_PROPERTY_TEXTS` off (ruling R5, shadow mode): each sender seam
  resolves the visit's NON-primary saved property, records what the property
  rule WOULD decide next to what the customer row DID decide, and sends on
  the customer row. On: the property decision is enforced. A property lookup
  that FAILS answers the customer row in shadow mode (logged) and THROWS under
  enforcement — the seams read that as prefs-unavailable / held / retry,
  never as the customer row's answer.
- **Sender seams** (`resolveAppointmentPrefs` / `prefsForVisit`): reminders
  `getReminderPrefs(customerId, { scheduledServiceId })` (every call site
  passes its visit; the channel re-check does not need it); twilio
  `sendServiceReminder`, `sendTechEnRoute` (new `scheduledServiceId` option,
  threaded from track-transitions), `sendTechArrived`; appointment-email
  `resolveRecipients(customer, { scheduledServiceId })` via `sendTemplate`
  (notify-primary → "send these to me too"); notification-service
  `customerPreferenceEnabled(customerId, key, { scheduledServiceId })` from
  the bell's `appointmentId`; the consent validator's per-purpose toggle via
  `input.appointmentId`. Delivery channels, App-first choices and quiet hours
  stay on the customer row (#4057).
- **Card + route.** While `GATE_APP_PROPERTY_TEXTS` is off (shadow mode) the
  card keeps today's per-profile shape — it shows and edits the row that
  actually sends. Once enforced, `GET /notifications/property-preferences`
  answers one entry per SAVED property (`id` = the `/auth/properties` entry
  key; `chosen` marks toggles the property picked vs inherited;
  `quietByDefault`; `contactsShared: true`). `PUT
  /notifications/property-preferences/:customerId` takes `propertyId`: a
  non-primary property upserts its own row (contacts in the same body are
  refused — ruling R2 pending, contacts stay per profile); the primary
  property or no `propertyId` = today's profile write. The Visits tab's
  Appointment-texts card follows the page's selected house.
- **Shadow-log hygiene.** One row per (property, visit, seam) — the resolver
  writes `ON CONFLICT … DO UPDATE` (latest decision wins, `created_at` refreshed so the review query and the prune see the newest observation) on the unique index from
  `20260909000031`, on the ROOT db handle (never a caller's transaction),
  only in shadow mode, and only where the two rules CAN disagree (a chosen
  toggle, or a rental / managed house); an inheriting house with no chosen
  toggle agrees by construction and is not logged. The 3:30 AM ET retention
  sweep (next to stripe_webhook_events) prunes rows older than 90 days.
- **Replays.** The scheduled-SMS executor forwards a deferred notice's
  `scheduled_service_id` as `appointmentId`, and the deferred-replay
  recipient recheck reads the visit-aware row, so a queued notice for a quiet
  rental is re-judged by the property, not the profile. The call-booking
  confirmation email resolves the property toggle before its email-only
  slots.
- **Shadow-log review (read-only, prod)** before flipping
  `GATE_APP_PROPERTY_TEXTS` — one week, expect `agreed = true` for every
  inheriting house and `false` only where a rental/managed house would go
  quiet:
  `SELECT source, relationship, agreed, count(*) FROM property_text_decisions
  WHERE created_at > now() - interval '7 days' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;`
  Disagreements to eyeball:
  `SELECT created_at, source, relationship, customer_decisions, property_decisions
  FROM property_text_decisions WHERE NOT agreed ORDER BY created_at DESC LIMIT 50;`
- **Failure posture, one rule.** An unreadable preferences row — the
  customer row's read, or a saved property's under enforcement — is a
  RETRYABLE hold everywhere: `safeSendAppointment` sends nothing and stamps
  `sendOutcome.retryable` (the cancellation / series / admin-reschedule
  callers keep their claims retryable; the admin sees "could not be read —
  send again"; a no-show bells the office because it has no retry rail);
  `sendTemplate` answers `held` without writing an attempt row; the
  call-booking confirmation throws into its existing fan-out catch; en-route
  / arrived bell the office before rethrowing (an ungrouped visit has no
  scheduler retry lane). The scheduled-SMS replay treats a MOVE_HOLD answer
  (now reachable because the replay names its visit) as a deferral, never a
  terminal block.
- **Row hygiene.** The primary never has a row: a primary flip
  (`applyPropertyRoleProposals`) drops the promoted house's row; a profile
  merge (`repointCustomerProperties`) re-points a moved row's `customer_id`.
- **Deferred** — ruling R2 (on-location contacts per property) is its own
  PR; per-house Property-tab details remain Phase C.

### PR 4 of 4 — lawn health by saved property (history stays customer-wide)

- **Completed visits and reports stay CUSTOMER-wide** (ruling from PR 2
  review, kept after PR 4 review): a retired house has no picker entry left
  to reach its visits and reports, and pre-linkage (unstamped) visits must
  stay reachable when the primary itself is retired. The Completed
  disclosure says so. Home's Last Visit is the one property-scoped
  history read (`GET /services?propertyScoped=1`, PR 2).
- **Lawn health** (`GET /lawn-health/:customerId` and `/history`): while
  `GATE_LAWN_PROPERTY_HISTORY` (#4039, the owner's flip) is on, the session's
  selected saved property is handed to the per-property history reader, the
  no-assessments probe is scoped the same way, the customer-wide
  neighborhood benchmark is omitted, and both routes echo `propertyScope`.
  `useLawnHealth(customerId, scope)` validates that echo centrally for Home
  and My Plan (a read scoped to another house than the tab shows is
  withheld and the property list re-read); Home shows the lawn teaser under
  a secondary house only when the echo names it. Gate off = no property
  reads, the reader's own default, no echo.
- **Requests** already carry their house since PR 2 (`metadata.property`,
  shown in staff triage); no `service_requests.property_id` column was added.
- **Property tab** under a non-primary house shows the read-only primary
  details notice since PR 2 (ruling R3).
