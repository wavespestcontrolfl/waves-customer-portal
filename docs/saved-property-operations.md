# Shared saved-property operations

The native customer property routes use `customer-properties.js` for add, edit
and primary selection. The preview normalizes input without mutation, records
customer/property versions and legacy invoice IDs, and is checked again inside
the transaction. The writer verifies stored fields and the account address
before committing an audit. Add/edit request fields retain their existing shape;
primary selection requires the new impact preview and its version.

Primary eligibility is shared by listing and confirmation. Tenant accounts,
commercial occupancy/types, rental or managed relationships, and incomplete
addresses refuse promotion. A matching legacy account row is reused and passes
through the existing role writer so owner occupancy, custom labels, measurements
and irrigation review complete. Existing primary addresses are registered when
needed; the first property can fill an addressless account.

The shared role writer preserves appointment and recurring-service locations.
Manual selection additionally fills unstamped settled visits only when their
saved property or legacy estimate address agrees with the former primary.
Conflicting streets and units, existing visit addresses and service history are
preserved. Invoice history uses the preceding split's snapshot mechanism.

`customer-properties-db.test.js` verifies these guards and legacy cases on
isolated PostgreSQL, including independent connections for lock-order and billing
contention. `admin-customers-properties-route.test.js` covers native request
contracts. Intelligence Bar registration and Customer 360 controls follow in
the next two replacement PRs.

Split validation: all 10 PostgreSQL scenarios and 73 property/role/native-route
unit tests pass. Domain scanning is clean. Existing add/edit required fields are
retained; the new primary preview/write endpoints have no Astro or native callers.
