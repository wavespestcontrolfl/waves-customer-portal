# Customer Photo ID evidence

`GET /api/photo-id/:type/:id` retains its existing result and next-step fields and adds
`photos: [{ id, url, mime_type }]`. The parent must belong to the authenticated
customer, use customer mode, and satisfy the canonical selected-property predicate
before any photo is read or signed. Property-scope failures fail closed. Only
`customer_visible` photo rows are included, in capture order. Storage keys remain
internal. Responses use `Cache-Control: private, no-store`; viewing links use the
existing customer-dwell expiry and are refreshed when the report is reopened.
A null URL or failed browser image load is shown as unavailable evidence.

`POST /api/requests` accepts an optional additive field:

```json
{
  "photoIdSource": {
    "type": "pest",
    "id": "<submission UUID>",
    "photoIds": ["<selected saved photo UUID>"]
  }
}
```

Types are `pest`, `lawn`, and `tree_shrub`. The server rechecks customer, customer
mode, and the request's resolved property scope. Selected IDs must belong to that
submission's customer-visible photos. The server retrieves their private bytes
and copies them into the existing `service_requests.photos` data-URL array;
combined new and saved attachments obey the existing three-photo and size limits.
Missing photos return 409; failed storage reads return 503, with no request filed.
When no visible photo rows survived storage, a replacement upload is required;
this differs from explicitly removing selections from an existing photo set.
An already-filed retry returns the existing request before reading storage again.
No caller-supplied URL or storage key is fetched. Customers can remove individual
saved attachments before submitting.

The allowlisted source is retained in `service_requests.metadata.photoIdSource`
alongside existing property metadata. Live uploads send their existing data URLs
and an empty `photoIds` list, avoiding duplicates. A source-less legacy request
keeps its existing behavior. Source-backed requests require `GATE_CUSTOMER_PHOTO_ID`;
this repair uses the existing Photo ID gate and does not change its setting.

Consumers: customer `PhotoIdSheet` and `ReportIssueOverlay` (web/PWA/native bundle)
and the existing request handlers. Older clients can ignore the extra read field
and continue sending their current request bodies. Assessment token routes,
public website forms, model calls, coverage routing and communication behavior
are unchanged. The companion staff-attachment viewer must ship before this
handoff is released so staff can inspect the copied evidence from request triage.

This is evidence restoration, not technician confirmation or issue resolution.
