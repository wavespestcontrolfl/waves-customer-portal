# Multi-property model

One customer can own several service addresses (e.g. a landlord's rental + their
own home). This replaces the awkward "each property = a duplicate customer row"
pattern (`customer_accounts`, migration `20260504000008`), which is now **frozen
for new data**.

## Phase 1 (this PR) — additive, gated, no rewiring

- **`customer_properties` table** (migration `20260629000001`): one customer →
  many properties, each with `occupancy_type` (owner_occupied / rental_investment
  / commercial / seasonal / vacant / unknown), `is_primary` (partial-unique: one
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

- **`customer_properties.relationship`** (migration `20260906000020`,
  vocabulary `constants/property-relationships.js`): `own_home` /
  `rental_owned` / `family_home` / `managed_for_client`, nullable,
  CHECK-constrained. Owner decision 2026-09-06: "family" is a RELATIONSHIP
  (the payer's tie to the address), not a seventh occupancy value. Backfilled
  only where the contact role proves it (property-manager profiles →
  `managed_for_client`); occupancy is never read as ownership evidence, so
  every other legacy row stays NULL for the office to set. Editable on the
  Customer 360 Properties panel (row select + add form); `POST`/`PATCH
  /:id/properties` validate it; `recordCallProperty` accepts it but the call
  pipeline does not classify it yet.
- Still deferred: per-property on-site contact / access notes, per-property
  pricing attributes (Phase 3), and the multi-property estimate group UI
  (reuses the existing multi-home discount — owner 2026-09-06).
