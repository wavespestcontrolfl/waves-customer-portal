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
