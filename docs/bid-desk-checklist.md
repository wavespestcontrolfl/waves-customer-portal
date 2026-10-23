# Bid Desk checklist

Behind `GATE_BID_CHECKLIST` (dark; needs `GATE_BID_DESK`). Off, the Bid Desk works exactly as before. The gate row in `docs/gates-and-env.md` has the full contract; this page is the working guide.

Nothing here is sent to a buyer, a general contractor or an agency. The only output is the admin bell.

## What a bid carries

| Field | Where | Notes |
| --- | --- | --- |
| Solicitation type | `bid_opportunities.solicitation_type` | quote, itb, rfq, rfp, itn, federal, gc_subcontract, other. Checked by the database. |
| Scored or pass/fail | `scored` | true = scored proposal, false = pass/fail, NULL = not set. |
| Questions due | `questions_due_at` | Typed by the operator (Eastern time). Never read from mail, so a value counts as confirmed. |
| Job walk | `job_walk_at`, `job_walk_mandatory`, `job_walk_confirmed` | The date may be read from a BuildingConnected or Procore invite; a read date is unconfirmed. A date the operator changes is confirmed; sending the stored value again is not an edit and leaves the flag as it is (the page sends a date only after the operator edits that field); clearing resets it. "Confirm site visit date" (`jobWalkConfirmed: true`) confirms a read date without retyping. A mandatory walk is named so in its reminder. |
| Estimate and proposal | `estimate_id` | Must be an existing estimate. The page links to `/admin/estimates/:id/proposal`. |
| Documents | read-only, from `email_attachments` | Every attachment of every email linked to the bid. Listed by reference; downloaded through `/api/admin/email/message/:emailId/attachment/:attachmentId`. No file is copied. |
| Checklist | `bid_checklist_items` | See below. |
| Submission record | `submitted_at`, `submission_confirmation` | Typed by the operator. Setting the status to Submitted invites these fields; it never requires them. |

## Checklist

`shared/bid-checklist-templates.cjs` is the one place to edit the wording. A started list is, in this order:

1. the type's **stop checks** (section `stop`, go / no-go questions: if the answer is no, do not bid; the label starts "Stop check:" except the ITB pre-bid meeting line);
2. the **ten base rows** (section `base`): the bid-form responsiveness check, reworded with "done when" detail from a harvest of 12 local pest solicitations;
3. the type's **own rows**.

| Type | Stop checks | Base | Own rows | Total |
| --- | --- | --- | --- | --- |
| other, or none | 0 | 10 | 0 | 10 |
| quote, rfq | 3 (license type, experience, price cap) | 10 | 5 | 18 |
| itb | 4 (local office, license and staffing, reference rules, pre-bid) | 10 | 11 | 25 |
| rfp, itn | 2 (criteria matrix, participation) | 10 | 9 | 21 |
| gc_subcontract | 2 (GC insurance, scope fit) | 10 | 6 | 18 |
| federal | 2 (set-aside, SAM active) | 10 | 5 | 17 |

The type's own rows:

- quote: the agency's form, references, insurance certificate, public-records answer, no contact before award;
- itb: the five papers Sarasota County Schools rejected bids for with bid 24-0118, then references form, local preference, post-opening deadlines, responsibility evidence, protest window, no contact;
- rfp: section order, evaluation criteria with page references, page limits, separate price, reference surveys, narrative, three similar contracts, presentation, no contact;
- gc_subcontract: the GC's bid form with every acknowledgment line initialed, the GC's prequalification form, insurance that meets the GC's insurance exhibit, price hold period stated and met, alternates and deducts priced, warranty terms matching the specification (model: the Cove + Willoughby termite package);
- federal: SAM registration, reps and certs, SF 1449, wage determination, past performance.

An RFQ uses the quote rows and an ITN uses the RFP rows (same keys, so changing between them adds nothing twice).

`add=missing` after a type change adds the new type's stop checks and own rows after the lines already on the bid (positions only grow); the page shows them in position order.

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
| Job walk | 2 days before `job_walk_at` | a confirmed date (`job_walk_confirmed`) |

For all of them: the bid is not historical, its status is new or bid, a SAM.gov notice is still open, and no date is flagged `needs_date_confirmation` (an addendum may move these dates; confirming the due date clears the flag). An unconfirmed date never reminds: not the due date, and not a site-visit date read from an invite. The questions date is always typed, so it counts as confirmed.

## Reading the page

With the gate on, the detail panel shows Bid details, Estimate and proposal, Documents, Checklist and Submission record, and the list shows a progress chip such as 7/12. The list and detail replies carry `checklist_live: true` while the gate is on; without that key the page shows nothing new.
