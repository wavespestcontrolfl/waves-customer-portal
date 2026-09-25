# Customer Photo ID issue association

`GATE_CUSTOMER_PHOTO_ID_ISSUES=true` enables the pest-only issue contract on
the authenticated `/api/photo-id` API. It is strict opt-in in every
environment and also requires the existing `GATE_CUSTOMER_PHOTO_ID` surface.
It requires `GATE_APP_PROPERTY_SCOPE=true`; while that gate is off or no saved
property resolves, pest submissions return 503 before analysis or persistence.

While enabled, `POST /api/photo-id/pest` accepts optional `issue_id` and
`observed_on` (`YYYY-MM-DD` or `null`). Omitting `issue_id` creates an issue
for the authenticated customer, selected property and submitted area.
Providing it appends a new identification only when that issue belongs to the
same customer and selected property. Ownership is checked before vision spend
and rechecked under a row lock in the save transaction. The issue and
identification insert commit together. A missing observation date remains
`null`; upload time is never substituted.

Pest POST, list and detail responses add `issue_id` and `observed_on` while the
gate is enabled. With the gate off, existing requests and responses keep their
current shape; an explicit `issue_id` or `observed_on` is rejected with 400.
The association defines no issue state, resolution, review, action plan,
message send, or automatic inference.
