# SMS Template Audit - 2026-05-25

## Summary

This starts the next notification audit area after inbound voice routing. Scope is
SMS template governance: seeded template inventory, editable admin surfaces,
runtime rendering, trigger-event mapping, variants, and failure behavior.

Current state: SMS templates are operational and broadly covered by tests, but
the SMS surface is less governed than the email template library. SMS has editable
copy, activation toggles, protected deletes, event mapping, weighted variants,
save-time placeholder validation, variant CRUD in the V2 template editor, and
recent template issue visibility from `audit_log`. It does not yet have version
history, approval/draft workflow, sample-data preview in the V2 UI, send history
per template, or a complete event-to-template catalog.

## Fix Pass Applied - 2026-05-25

Implemented after the initial audit:

- `PUT /admin/sms-templates/:id` now rejects body updates containing placeholders
  outside the row's declared `variables`.
- `POST /admin/sms-templates` now validates new custom template bodies against
  submitted variables.
- SMS variant create/update routes now validate variant bodies against the parent
  template variables.
- The V2 SMS Templates editor now displays exact save errors, including unknown
  placeholders.
- The V2 SMS Templates editor now supports variant create, edit, delete, status,
  weight, control flag, body editing, and placeholder validation errors.
- Focused route tests cover valid template saves, invalid template saves, and
  invalid variant saves.
- `estimate_accepted_annual_prepay` is now a protected SMS template and the
  estimate acceptance path renders it instead of hardcoding annual-prepay copy.
- SMS render issues now write `notification_template.sms.render_issue` rows to
  `audit_log`, and the V2 SMS Templates tab shows recent template issues with
  jump-to-template behavior.
- High-volume senders now pass workflow/entity context into SMS template rendering
  for estimate follow-ups, admin estimate sends, invoice sends, invoice
  follow-ups, public quote SMS, and email automation SMS companions.

## Inventory

Default SMS copy is centralized in:

```text
server/models/migrations/20260514000002_tighten_sms_template_copy.js
```

The exported `TEMPLATES` array currently contains 127 default templates:

| Category | Count |
|---|---:|
| automations | 7 |
| billing | 34 |
| estimates | 18 |
| internal | 1 |
| referrals | 5 |
| retention | 27 |
| reviews | 2 |
| sales | 1 |
| service | 32 |

The admin route imports that migration export as the protected default set:

```text
server/routes/admin-sms-templates.js
```

Protected rows are any default `template_key` from the clean template list.
Protected rows can be edited and toggled inactive, but cannot be hard-deleted.
Only `category === "custom"` rows outside the protected key set can be deleted.

## Runtime Architecture

Primary route:

```text
GET    /api/admin/sms-templates
GET    /api/admin/sms-templates/issues
GET    /api/admin/sms-templates/:id
POST   /api/admin/sms-templates
PUT    /api/admin/sms-templates/:id
DELETE /api/admin/sms-templates/:id
POST   /api/admin/sms-templates/preview
GET    /api/admin/sms-templates/:templateKey/variants
POST   /api/admin/sms-templates/:templateKey/variants
PUT    /api/admin/sms-templates/:templateKey/variants/:variantKey
DELETE /api/admin/sms-templates/:templateKey/variants/:variantKey
```

Runtime helpers:

```text
server/services/sms-template-renderer.js
server/services/sms-template-variants.js
```

Most senders call one of these paths:

- `smsTemplatesRouter.getTemplate(templateKey, vars)`
- `renderSmsTemplate(templateKey, vars)`
- `renderRequiredSmsTemplate(templateKey, vars)`
- `smsTemplatesRouter.isTemplateActive(messageType)`

Rendering behavior:

- Template rows are read from `sms_templates`.
- Inactive or missing rows return `null`.
- Active weighted variants can override the base body.
- Variables are normalized through `formatSmsTemplateVars`.
- Any unresolved `{placeholder}` makes rendering return `null`.
- `renderRequiredSmsTemplate` throws when rendering returns no body.

## Admin UI Surface

The current V2 SMS templates UI lives in:

```text
client/src/pages/admin/CommunicationsTabsV2.jsx
```

It supports:

- Listing all SMS templates.
- Category filtering.
- Body editing.
- Active/inactive toggling.
- Protected-delete awareness through `can_delete`.
- Hash deep links to a template key from notification events.
- Variable chips from `variables`.
- Variant create/edit/delete for body, weight, status, and control flag.
- Recent template render issues from `audit_log`.

It does not currently expose:

- Sample-data preview before saving.
- `trigger_event_key` editing in the SMS templates tab.
- Send history or per-template delivery metrics.
- Version history, rollback, or draft/approval state.

Notification event mapping is exposed separately through:

```text
server/routes/admin-notification-events.js
client/src/pages/admin/NotificationEventsTabV2.jsx
server/config/notification-events.js
```

The event catalog currently lists 15 shared notification events. SMS event mapping
is partial: migration `20260521000003_sms_template_trigger_event_key.js` maps 14
SMS template keys onto shared events, while the default SMS inventory contains
126 templates.

## Initial Findings

### 1. SMS edits are live edits with no version boundary

`PUT /admin/sms-templates/:id` updates `body`, `name`, `is_active`, and
`trigger_event_key` directly on the live row. There is no draft state, active
version pointer, review gate, or rollback path comparable to the email template
library.

Risk: an operator typo or placeholder mismatch can immediately affect future SMS
sends. The renderer prevents unresolved placeholders from being sent, but that
turns the mistake into a skipped/failed send depending on caller behavior.

### 2. Save path did not validate placeholders - fixed

The server preview route can render sample data, and runtime rendering refuses
unresolved placeholders. The first fix pass added save-time server validation for
template and variant bodies, plus V2 editor error display.

Remaining gap: the V2 editor still does not provide sample-data preview before
saving.

### 3. Failure behavior varies by caller - partially fixed

Some senders use `renderRequiredSmsTemplate`, which throws when the template is
missing, inactive, or invalid. Others use nullable `renderSmsTemplate` /
`getTemplate` and then decide locally whether to skip, fall back, or continue.

Risk: turning a template off can mean different things across workflows:
intentional skip, warning and pause, thrown error, or silent no-op. The existing
tests cover several individual paths, but there is no single governance table
that declares expected failure behavior per template.

Fix applied: central `getTemplate` render misses now write audit rows for missing
table, missing template, inactive template, unresolved placeholders, and render
errors. The Communications UI surfaces recent issues, and the highest-volume SMS
senders now provide workflow/entity context.

### 4. Variants existed but were not operator-visible in V2 - fixed

`sms_template_variants` supports active variants, weights, control flags, and
metadata. Runtime selection is weighted by active rows. The first fix pass added
read-only V2 visibility for configured variants while editing a template. The
follow-up pass added create, edit, delete, weight, status, and control management.

Remaining gap: operators cannot yet review recent variant performance from the
main SMS Templates tab.

### 5. Notification event mapping is incomplete by design, but not measured

The Notification Events tab separates mapped SMS rows from channel-only SMS rows.
That is useful, but the audit boundary is not yet explicit: some SMS templates
are lifecycle messages that should map to a shared event; others are channel-only
or manual-response snippets.

Risk: a future email/SMS pairing can be missed because the unmapped inventory is
not classified into "intentionally SMS-only" vs "needs shared event mapping."

### 6. Route self-seeding remains a runtime side effect

`ensureTable()` can create `sms_templates`, add `trigger_event_key`, and seed new
default templates from the route process. That makes the admin endpoint resilient
in local/dev environments, but schema and seed ownership is split between
migrations and runtime route code.

Risk: production behavior is harder to reason about during deploys because a GET
request can perform schema/seed work outside the normal migration path.

## Existing Test Coverage

Relevant tests already present:

```text
server/tests/admin-sms-templates-render.test.js
server/tests/admin-sms-templates-routes.test.js
server/tests/sms-template-variants.test.js
server/tests/sms-template-trigger-event-migration.test.js
server/tests/sms-contact-compliance-checks.test.js
server/tests/sms-quiet-hours.test.js
server/tests/estimate-public-sms-template.test.js
server/tests/new-recurring-welcome-sms.test.js
```

Notable coverage:

- Rendering replaces supplied variables.
- Rendering returns `null` instead of leaking unresolved placeholders.
- Weighted variants ignore zero-weight variants.
- Trigger-event migration maps known keys.
- Several lifecycle flows assert specific template usage.

Coverage gaps to consider next:

- Inactive-template behavior is declared and tested per critical workflow.
- Variant selection is observable in send metadata.
- Notification Events tab classification stays stable as template inventory
  grows.
- Lower-volume senders pass workflow/entity context into the central renderer so
  issue rows can identify the exact source entity.

## Recommended Next Audit Pass

1. Build a template usage matrix from `renderSmsTemplate`, `getTemplate`, and
   `renderRequiredSmsTemplate` call sites.
2. Classify every template key as one of:
   - shared notification event
   - customer lifecycle SMS-only
   - internal/admin alert
   - manual snippet
   - deprecated/legacy
3. For each key, record:
   - owning workflow
   - required variables
   - failure behavior when inactive or invalid
   - whether fallback copy exists
   - whether quiet hours/contact compliance applies
4. Decide whether SMS should adopt the email template versioning model or a
   lighter guardrail: validate-on-save, preview samples, and rollback snapshots.
5. Expose variants in the V2 SMS Templates tab or hide/disable variant execution
   until operators can see what is active.

## Candidate Follow-Up Area

If this audit switches to admin/internal email notifications instead, start with:

```text
server/services/email-template-library.js
server/routes/admin-email-templates.js
server/services/email-template-automation-executor.js
client/src/pages/admin/EmailTemplatesPanelV2.jsx
server/config/notification-events.js
```

That surface already has stronger governance primitives than SMS, so the useful
audit angle is likely internal/admin notification ownership, delivery visibility,
and event pairing rather than basic template lifecycle.
