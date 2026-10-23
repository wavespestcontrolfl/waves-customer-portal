# Bid Desk checklist

Behind `GATE_BID_CHECKLIST` (dark; needs `GATE_BID_DESK`). Off, the Bid Desk works exactly as before. The gate row in `docs/gates-and-env.md` has the full contract; this page is the working guide.

Nothing here is sent to a buyer, a general contractor or an agency. The only output is the admin bell.

## What a bid carries

| Field | Where | Notes |
| --- | --- | --- |
| Solicitation type | `bid_opportunities.solicitation_type` | quote, itb, rfq, rfp, itn, federal, gc_subcontract, other. Checked by the database. |
| Scored or pass/fail | `scored` | true = scored proposal, false = pass/fail, NULL = not set. |
| Questions due | `questions_due_at` | Typed by the operator (Eastern time). Never read from mail, so a value counts as confirmed. |
| Job walk | `job_walk_at`, `job_walk_mandatory` | The date may be read from a BuildingConnected invite. A mandatory walk is named so in its reminder. |
| Estimate and proposal | `estimate_id` | Must be an existing estimate. The page links to `/admin/estimates/:id/proposal`. |
| Documents | read-only, from `email_attachments` | Every attachment of every email linked to the bid. Listed by reference; downloaded through `/api/admin/email/message/:emailId/attachment/:attachmentId`. No file is copied. |
| Checklist | `bid_checklist_items` | See below. |
| Submission record | `submitted_at`, `submission_confirmation` | Typed by the operator. Setting the status to Submitted invites these fields; it never requires them. |

## Checklist

`shared/bid-checklist-templates.cjs` is the one place to edit the wording. It holds the ten-line bid-form check (the base list) and the lines each type adds:

- quote: written quote on the agency's own form, references, insurance certificate;
- itb: the five papers Sarasota County Schools asked for with bid 24-0118;
- rfp: section order, evaluation criteria with page references, page limits, separate price, references;
- federal: SAM registration, reps and certs, SF 1449, wage determination.

A type with no overlay (rfq, itn, gc_subcontract, other) gets the base list only.

Routes (all under `/api/admin/bid-desk/:id/checklist`, 404 while the gate is off):

- `POST /start` with an optional `{ "type": "..." }` copies the template lines into the bid, once. A second press changes nothing. The type in the body is saved on the bid. `POST /start?add=missing` adds only template lines the bid does not carry; a line the operator archived still counts as carried and does not come back.
- `POST /` adds a custom line (`label`, optional `sourceText` = the quote or page from the solicitation, `notes`, `required`).
- `PATCH /:itemId` edits a line, or ticks it (`{ "checked": true }`, which stamps `checked_at` and `checked_by`) or unticks it.
- `POST /reorder` with `{ "ids": [...] }`: every live line, each once, in the new order. A stale list answers 409.
- `DELETE /:itemId` archives the line (`archived_at`); the row stays.

Progress is `checked / required`: ticked required lines out of required lines.

## Reminders

Admin bell only. Each fires once for the date it was computed for; the date is in the dedupe key, and the route clears the sent stamp when the date changes.

| Reminder | When | Needs |
| --- | --- | --- |
| 14-day | more than 7 and at most 14 days before `due_at` | a confirmed due date |
| 7-day, 2-day | unchanged | a confirmed due date |
| Questions | 2 days before `questions_due_at` | the date |
| Job walk | 2 days before `job_walk_at` | the date |

For all of them: the bid is not historical, its status is new or bid, a SAM.gov notice is still open, and no date is flagged `needs_date_confirmation` (an addendum may move these dates; confirming the due date clears the flag). An unconfirmed due date never reminds.

## Reading the page

With the gate on, the detail panel shows Bid details, Estimate and proposal, Documents, Checklist and Submission record, and the list shows a progress chip such as 7/12. The list and detail replies carry `checklist_live: true` while the gate is on; without that key the page shows nothing new.
