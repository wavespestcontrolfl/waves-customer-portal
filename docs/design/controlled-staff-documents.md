# Controlled Staff documents

Policies, procedures and forms live in **Staff → Team → Documents**. Claudeopedia
continues to hold editable knowledge. The technician reader is `/tech/documents`.
Staff tabs, document selections and version selections survive a page reload;
clause anchors such as `#pto-accrual` open the matching procedure step on a phone.

The existing `document_templates` / `document_template_versions` mechanism stores
staff Markdown source with `audience = staff`. Customer template routes exclude
that audience and cannot create, reclassify or publish staff templates. Customer
contracts, delivery/reminders and expiring signing links are not involved in staff
issuance. All staff APIs require the existing bearer authentication and staff
role guard. Authoring, policy-value changes and issuance additionally require admin.

## Lifecycle and evidence

- **Policy:** an admin creates draft revisions and issues the latest reviewed
  version with an effective date. Acknowledgments capture the authenticated staff
  ID, typed name, intent statement, timestamp, version ID and SHA-256 hash.
- **Procedure:** collapsible numbered clauses double as required checklist steps.
  A saved run retains its owner, deadline, completed steps and source-version hash.
  There is no signature prompt.
- **Form:** a version declares typed fields and completion requirements. Open
  records have an owner and next-action deadline; completed records are immutable.
  Admins can assign records; technicians can create and update their own records.
  Completed records can be exported with their field values and version identity.

Every issued snapshot contains the owner name/ID, next-review date, bound
citations, resolved wording, form schema, effective timestamp and shared values.
Database triggers prevent modification/deletion of issued versions, policy-value
revisions, acknowledgments and completed records. Open records cannot be deleted.
Old versions remain readable, including the version in force at an Eastern date
and time. A rollback refuses to remove populated document history.

`policy_values` stores typed pay frequency/schedule, PTO tiers, paid/unpaid holiday
lists and equipment-deduction terms. Issuing values takes a transaction-scoped
library lock and creates a new version of every issued document using a policy
binding. Publication checks apply to the entire batch; one failed review check
rolls back the values and every replacement. Prior issued snapshots never change.
The audit log connects each revision to the prior values and new version hashes.
Concurrent draft or value changes require reload through a base-revision check.
Future effective versions are selected by time, without a second cron mechanism.

## Authoring and reviews

Each clause starts with `## Title {#stable-anchor}`. Retain its anchor when wording
changes. The supported Markdown subset is paragraphs, bullets, emphasis and HTTPS
links. Raw HTML, executable MDX, embeds and external image fetching are excluded.
The same escaped clause HTML renders in the portal and in PDFs, which reuse the
service-report browser launcher. PDFs include version and full hash in the footer;
an acknowledgment export includes the actual recorded signer and timestamp.

Bindings are restricted to `{{policy.pay_frequency}}`, `{{policy.pay_schedule}}`,
`{{policy.pto_accrual}}`, `{{policy.paid_holidays}}`,
`{{policy.unpaid_holidays}}` and `{{policy.equipment_deduction_terms}}`.
No owner-approved pay/benefit values are seeded. Unresolved bindings and explicit
`[DECISION: ...]` markers prevent issuance.

Every issued document requires an active staff owner and a next-review date within
one year. A citation is stored alongside its clause anchor, label, HTTPS source,
verification date and review date. Citation review is due within 90 days of
verification, and the document review cannot be later. An overdue review remains
visible in history; it does not erase an issued policy or acknowledgment.

## Initial draft scope

The reviewed starters contain the Tuesday 8 a.m. continuity scenario and Daily
Admin Operations; revised complaint, incident and vehicle inspection records;
and shared-term sections for the handbook, offer letter and job descriptions.
Each remains explicitly unissued. The three employment documents require the
remaining approved clauses to be reconciled from their existing attachments.
Continuity requires actual delegated authority, contacts, limits and deadlines.
No starter confers spending, billing or vehicle-release authority.

Uploaded originals remain in the existing attachment workflow and can be linked
as historical source evidence. They are not automatically archived or treated as
approved replacements. WDO reports continue through the existing official FDACS
form workflow; this feature does not generate a substitute inspection certificate.

## Acceptance checks

1. Drafts, admin-only documents and other staff members' records are inaccessible
   to unauthorized readers; customer-template routes cannot bypass issuance.
2. Changing shared values revises every bound issued document atomically. Prior
   content, hashes and acknowledgments are unchanged and retrievable by date.
3. Unknown fields, missing required fields, incomplete procedures, forged actor
   fields and hash mismatches cannot create completion/acknowledgment evidence.
4. Both concurrent acknowledgments return the same unique acknowledgment.
   Stale edits cannot overwrite another staff member's open record.
5. Desktop and 390-pixel layouts support clause links, authoring, signing,
   checklist completion and PDF exports without horizontal overflow.
