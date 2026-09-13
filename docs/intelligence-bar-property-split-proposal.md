# Property workflow replacement stack

The owner approved this four-part replacement for #4021. The original review
history remains on that PR, including the tenant-account P1 that prompted the
split. The corrected implementation is carried through these branches from
foundation `54c6e8b8cd1d70654a3f900c0361a3f13e1c5285`.

| Order | Branch | Result and verification |
| --- | --- | --- |
| 1 | `feat/ib-property-invoice-history` (#4246) | Historical invoice and receipt addresses; unchanged snapshot migration; 2 PostgreSQL scenarios and 91 unit tests. |
| 2 | `feat/ib-property-operations` (#4247) | Shared native writes, tenant eligibility, legacy-primary restoration and visit history; 10 PostgreSQL scenarios and 73 unit tests. |
| 3 | `feat/ib-property-actions` | Confirmed IB property actions and provider-compatible tool definitions; 6 PostgreSQL workflows, 88 unit tests and 12 scoped contracts. |
| 4 | `feat/ib-property-controls` | Customer 360 opener, record scope, confirmation layer and refresh; 69 rendered tests, production build and desktop/mobile browser checks. |

All 16 original database scenarios are retained. Tenant and duplicate-address
coverage appears separately at the native and IB boundaries, making 18 scenarios
across the three suites. Shared fixture setup stays in `tests/helpers/property-db.js`.

After final-head review and CI pass, #4021 is superseded and #4029 moves to the
fourth branch. #4080 keeps #4029 as its parent. The already-verified local
inventory/estimate follow-ups are integrated before requesting their new-head
reviews. Existing migration contents and production rollout gates are preserved;
this review split does not authorize a production merge or gate change.
