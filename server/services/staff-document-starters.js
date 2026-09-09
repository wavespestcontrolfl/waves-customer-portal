// Unissued authoring starters. Owner decisions remain explicit release blockers.
// Existing signed policies and uploaded forms are retained as historical evidence.
const source = (title, body, fields = [], citations = []) => ({ title, body, metadata: { owner_role: 'Office Manager', review_on: null, citations, fields } });
const field = (id, label, type = 'text', required = true) => ({ id, label, type, required });
const compensation = `## Pay schedule {#pay-schedule}
Pay frequency: {{policy.pay_frequency}}. Pay dates and processing rules: {{policy.pay_schedule}}.

## PTO accrual {#pto-accrual}
Approved accrual schedule: {{policy.pto_accrual}}.

## Holidays {#holidays}
Paid holidays: {{policy.paid_holidays}}. Unpaid holidays: {{policy.unpaid_holidays}}.

## Equipment deduction terms {#equipment-deductions}
{{policy.equipment_deduction_terms}}`;

module.exports = [
  { key: 'owner-coverage-continuity', kind: 'procedure', access: 'staff', source: source('Owner Coverage & Continuity', `## Tuesday, 8 a.m.: establish coverage {#establish-coverage}
The Owner is unreachable. A customer calls about a missed appointment and a declined payment. The Office Manager opens this procedure and records the time, the attempted owner contact, and the callback details in the customer account. Keep credentials, access codes and medical information out of this record.

Use the role coverage roster to find the current primary and alternate contacts. The Office Manager owns customer coordination; the Operations Lead handles field exceptions. Owner-level exceptions go to the Owner or the explicitly designated Acting Owner within written authority. Do not treat silence as approval.

## Use roles and current coverage assignments {#role-coverage}
These are responsibilities, not a requirement to hire separate managers. One qualified person may hold several roles. The Owner explicitly assigns any unfilled role; nobody gains authority from a title or from being the only person available.

- Office Manager: intake, schedule coordination, customer updates, complaint ownership, billing administration and document review coordination.
- Operations Lead: technician coverage, service recovery, vehicle holds and repair coordination within approved authority.
- Certified Operator in Charge: technical product, protocol and training decisions within the applicable certification categories.
- Owner: employment terms, hiring and termination decisions, policy changes, contracts, and spending or remedies beyond delegated limits.
- Acting Owner: temporary business decision coverage expressly delegated by the Owner, with a scope, ceiling and end date. This is an assignment to an existing role holder, not an automatic promotion or a substitute for technical credentials.

The Office Manager maintains a separate coverage roster showing each role's primary and alternate staff IDs, approved contact methods, coverage dates, delegated limits and approval reference. Change that roster when staff change; keep these procedures written by role. If the same person holds the primary and alternate roles, that is not independent backup coverage. [DECISION: approve the role assignments, accessible roster location, contact and retry method, and temporary Acting Owner authority].

## Escalate the decision that is needed {#decision-routing}
Keep routine work moving inside existing authority. Escalate field capacity and service recovery to the Operations Lead; route a product or treatment question to the Certified Operator in Charge. Send a fee exception, over-limit remedy, unbudgeted purchase or employment decision to the Owner or authorized Acting Owner.

If the needed approver and their qualified alternate cannot be reached, hold only the affected decision, record why, and set the next customer or staff update. Continue fact gathering, existing authorized service and coordination. Immediate danger goes directly to emergency services; staff can stop unsafe work without waiting for a business approval. An Acting Owner cannot waive a safety hold or replace a required credential.

## Check the appointment before promising a remedy {#missed-appointment}
Open Dispatch and the customer account. Confirm the scheduled date, arrival window, technician assignment, status history and last customer message. Contact the assigned Technician or Operations Lead to establish whether the service was missed, delayed or completed without an update. Record confirmed facts separately from the customer's report.

Use the existing scheduling workflow for any approved reschedule. Confirm availability and the customer’s agreement before saving. Do not mark a service completed based on a phone assumption. The Office Manager coordinates routine reschedules under the approved scheduling rules; the Operations Lead resolves capacity and service-recovery exceptions. Charge waivers and credits follow the financial authority limit. [DECISION: approve rescheduling and callback authority, per-case remedy limits and when Owner approval is required].

## Check the declined payment separately {#declined-payment}
Open the existing invoice and payment history. Confirm whether the payment failed, is pending, or succeeded; record the invoice ID and payment status. If it is pending or unclear, leave the balance unresolved until an authorized person verifies it. Do not create a replacement invoice or repeatedly retry a charge to clear the screen.

Use the existing customer payment-link workflow when authorized and explain that a missed appointment and a declined payment are being reviewed separately. Never request card details in a note or message. The Office Manager owns billing follow-up. A retry, refund, credit or fee change requires the applicable payment authorization and written delegation; portal admin access alone grants neither. Escalate an exception to the Owner or authorized Acting Owner. [DECISION: approve each billing action and its limit; an unspecified limit authorizes no discretionary financial action].

## Give the customer one accountable follow-up {#customer-follow-up}
Create or update the complaint record. Assign one case owner and a next-action deadline, link the customer, appointment and invoice by their portal IDs, and record the response promised to the customer. The Office Manager remains accountable for the next update even when the Operations Lead or Owner must make the decision. Communicate only verified facts and actions within delegated authority.

The existing complaint form calls for an initial response within two hours, a resolution target of 24–48 hours, and a seven-day satisfaction check. Reconcile those targets with the approved policy before issuing this guide: [DECISION: confirm complaint targets and coverage outside business hours].

## Escalate an unresolved case on day three {#complaint-day-three}
At the start of day three, review the open complaint, attempted remedies and next promised update. A missing response is not a reason to close the case. The Office Manager remains the accountable case owner on day three and assigns the operational blocker to the Operations Lead. Escalate unresolved remedies outside delegated authority to the Owner or authorized Acting Owner. Record the next promised update before ending the review, and retain case ownership until a replacement explicitly accepts the handover. [DECISION: approve the day-three update interval and complaint coverage outside business hours]. The case record must distinguish proposed, approved, performed and customer-confirmed actions.

## Keep an unsafe vehicle on hold {#vehicle-release}
If the missed appointment involves a vehicle defect, link the inspection and repair evidence to the case. Keep a vehicle identified as unsuitable for operation on hold until the authorized release is recorded. The person requesting a repair and the person authorizing return to service may have different authority.

The Operations Lead coordinates qualified inspection or repair and records evidence resolving each safety defect. The Operations Lead may authorize return to service only if the Owner has delegated that release authority; otherwise the Owner or a qualified authorized alternate must approve it. The Office Manager schedules around the hold. [DECISION: approve the vehicle-release delegation, qualified alternate and required inspection or repair evidence]. A purchase receipt by itself does not prove that the defect was repaired; a business title does not establish repair competence.

## Handle a chemical purchase above the limit {#chemical-purchase}
Check the approved product and protocol, available stock and intended service before requesting a purchase. Record the product, quantity, supplier quote and proposed total in the existing purchasing record. Keep the requested purchase pending when its total exceeds the delegated limit.

The Certified Operator in Charge reviews technical product or protocol changes; the Office Manager can place an approved routine reorder only within delegated purchasing authority. Above the purchase limit, obtain the Owner or authorized Acting Owner approval in addition to any required technical approval. [DECISION: approve routine reorder authority, per-order and aggregate spending ceilings, and temporary purchasing delegation]. Do not split an order to fit a limit or substitute a product without the required approval. If a qualified technical approver is unavailable, hold the affected purchase or work; spending approval alone does not resolve the technical question.

## Handover when coverage ends {#coverage-handover}
Give the returning Owner or next designated role holder the case IDs, current appointment and payment facts, decisions made, approvals obtained and outstanding deadlines. Confirm who owns each open action. Mark this procedure run complete only after the handover is recorded; completion of this checklist does not close an unresolved customer complaint.`, [], [
    { anchor: 'chemical-purchase', label: 'Florida Statutes §482.152(1)–(5): technical supervision responsibilities', url: 'https://www.flsenate.gov/Laws/Statutes/2026/482.152', verified_on: '2026-09-07', review_on: '2026-12-06' },
  ]) },
  { key: 'daily-admin-operations', kind: 'procedure', access: 'staff', source: source('Daily Admin Operations', `## Start the day with ownership {#opening-review}
The Office Manager reviews today's Dispatch schedule, unassigned work, open customer messages and unresolved cases. Assign an owner and next action to each exception. Use the current role coverage roster and Owner Coverage & Continuity to confirm Operations Lead, Certified Operator in Charge and Acting Owner coverage. The same person may fill more than one role; an unavailable primary is not their own backup.

## Confirm schedule exceptions {#schedule-exceptions}
Verify technician assignment, customer agreement and availability in Dispatch before changing an appointment. Use the existing schedule controls and record the reason. Escalate work that has no available or qualified Technician to the Operations Lead. Technical eligibility questions go to the Certified Operator in Charge.

## Review customer messages and complaints {#message-review}
Use the customer account to avoid duplicate replies. The Office Manager owns each complaint and its next update, with an assigned staff member and deadline. On day three, the Office Manager retains case ownership while escalating field blockers to the Operations Lead and exceptions beyond delegated authority to the Owner or authorized Acting Owner. Separate the customer's report, verified facts and the remedy actually performed.

## Review billing exceptions {#billing-exceptions}
Review failed, pending and disputed payments in the existing billing workflow. Check the invoice and payment history before acting. Use the approved payment-link, refund or credit workflow only within delegated authority. The Office Manager coordinates billing follow-up; exceptions go to the Owner or authorized Acting Owner under the approved authority in Owner Coverage & Continuity. That guide is the authority reference; do not copy its dollar limits into this SOP. [DECISION: verify the issued continuity authority reference before issuance].

## Check readiness and records {#field-readiness}
Review outstanding vehicle holds, missing inspections, training expirations and supply requests. A checklist tick does not release a vehicle or approve a purchase. Route vehicle holds to the Operations Lead, credential or product questions to the Certified Operator in Charge, and spending exceptions to the Owner or authorized Acting Owner. Retain the approval and supporting evidence.

## Close the day with a handover {#closing-handover}
Reconcile today's schedule exceptions and customer promises against the portal records. Record the next action, owner and due time for unfinished work. The Office Manager hands open field actions to the Operations Lead and owner-level decisions to the Owner or authorized Acting Owner. Each recipient accepts the action and due time. [DECISION: approve the shared staff handover channel and coverage access]. Complete this run after the handover is recorded.`) },
  { key: 'complaint-resolution-record', kind: 'form', access: 'admin', source: source('Complaint & Resolution Record', `## Intake and ownership {#complaint-intake}
Record the customer account and service or invoice IDs, the issue reported, when it was received and the accountable case owner. Set the next-action deadline on the record. Do not include payment credentials or access codes.

## Investigation and escalation {#complaint-investigation}
Separate the report from verified findings. Record each contact attempt and decision. The Office Manager retains case ownership through day three and until another case owner accepts a handover. The Operations Lead owns assigned field actions; exceptions beyond delegated remedy limits go to the Owner or authorized Acting Owner. Use the authority limits and update intervals in Owner Coverage & Continuity. [DECISION: verify the issued continuity authority reference and approved complaint targets].

## Resolution and follow-up {#complaint-resolution}
Record the remedy proposed, who approved it, when it was performed and the evidence. Close only after documenting the outcome and required follow-up. An offered remedy is not a completed remedy.`, [field('account-reference', 'Customer / service / invoice IDs'), field('reported-issue', 'Issue reported', 'textarea'), field('findings', 'Verified findings and contact attempts', 'textarea'), field('approvals', 'Approval reference and action performed', 'textarea'), field('outcome', 'Outcome and follow-up evidence', 'textarea'), field('closure-verified', 'I verified the recorded outcome', 'checkbox')]) },
  { key: 'incident-record', kind: 'form', access: 'admin', source: source('Incident / Accident Record', `## Immediate response {#incident-response}
Call emergency services when needed and notify the Operations Lead immediately; use the designated alternate when unavailable. Notify the Certified Operator in Charge promptly for pesticide-related incidents and the Owner or authorized Acting Owner for business escalation. The incident form documents that response; it does not replace immediate notification. Record the time and responder references. Keep medical results and diagnosis documents in the restricted medical record, with only a reference here.

## Facts and follow-up {#incident-follow-up}
Record observed facts, immediate controls, notification evidence and the corrective-action owner and deadline. The Office Manager tracks paperwork and deadlines, the Operations Lead owns immediate field controls, and the Owner or authorized Acting Owner owns final business review. The Certified Operator in Charge handles applicable regulatory reporting; internal approval must not delay required reporting. [DECISION: verify the incident contact roster, applicable reporting deadlines and review responsibilities].`, [field('incident-time', 'Incident date and time'), field('location-reference', 'Work location / service ID'), field('observed-facts', 'Observed facts', 'textarea'), field('notifications', 'Who was notified and when', 'textarea'), field('corrective-action', 'Controls and corrective-action evidence', 'textarea'), field('review-reference', 'Supervisor review reference')]) },
  { key: 'vehicle-inspection-record', kind: 'form', access: 'staff', source: source('Vehicle Inspection & Release Record', `## Inspect before operation {#vehicle-inspection}
Follow the vehicle's approved inspection checklist and record its asset ID, odometer and any defects. The original daily, weekly and monthly inspection requirements must be reconciled before issuance: [DECISION: confirm inspection items and cadence].

## Defect disposition {#defect-disposition}
Record whether the vehicle is held out of service, sent for repair or cleared under the approved release rule. Keep repair evidence separate from the release decision. Do not certify an unresolved safety defect as fit for operation.

## Authorized release {#authorized-release}
The Operations Lead coordinates repair and evidence review; the release approver and qualified alternate are those expressly authorized in Owner Coverage & Continuity. The Office Manager coordinates schedule changes around the hold. [DECISION: verify the issued vehicle-release authority reference and evidence requirements]. Record who released the vehicle, when, and the evidence reviewed. This record does not automatically change a vehicle's operational status.`, [field('asset-id', 'Vehicle asset ID'), field('odometer', 'Odometer'), field('inspection', 'Completed inspection items and defects', 'textarea'), field('disposition', 'Disposition and operating restrictions', 'textarea'), field('repair-evidence', 'Repair / inspection evidence reference'), field('release-reference', 'Authorized release reference or unresolved hold', 'textarea')]) },
  { key: 'training-certification-register', kind: 'form', access: 'admin', source: source('Training & Certification Register', `## Employee identification cards {#employee-id-renewal}
Employee identification cards require annual renewal by the licensed business location's anniversary date. Use the actual credential and FDACS record to establish the renewal date. This register does not authorize work or replace required training and supervision.

## Operator certificates {#operator-certificate-renewal}
Pest control operator certificates renew annually by the anniversary of issuance. Track the certificate category, expiration and renewal evidence separately from an employee identification card.

## Verification and next action {#credential-verification}
Record the staff ID, credential type and category, credential reference, verified expiration, training evidence and next action. The Office Manager maintains dates and renewal evidence. The Certified Operator in Charge verifies technical qualifications and supervision requirements; the Operations Lead adjusts assignments for missing or expired evidence. Escalate unresolved staffing or spending decisions to the Owner or authorized Acting Owner. [DECISION: verify the current credential-review role assignment and qualified alternate].`, [field('staff-reference', 'Staff ID'), field('credential-type', 'Credential type and category'), field('credential-reference', 'Credential / official record reference'), field('expiration', 'Verified expiration date', 'date'), field('training-evidence', 'Training and renewal evidence references', 'textarea'), field('verification', 'Reviewer and next action', 'textarea')], [
    { anchor: 'employee-id-renewal', label: 'Florida Statutes §482.091(4)', url: 'https://www.flsenate.gov/Laws/Statutes/2026/0482.091', verified_on: '2026-09-07', review_on: '2026-12-06' },
    { anchor: 'operator-certificate-renewal', label: 'Florida Statutes §482.111(3)', url: 'https://www.flsenate.gov/Laws/Statutes/2026/0482.111', verified_on: '2026-09-07', review_on: '2026-12-06' },
  ]) },
  ...[
    ['employee-handbook', 'Employee Handbook'],
    ['offer-letter', 'Offer Letter — Shared Employment Terms'],
    ['job-descriptions', 'Job Descriptions — Shared Employment Terms'],
  ].map(([key, title]) => ({ key, kind: 'policy', access: 'staff', source: { ...source(title, `${compensation}

## Existing terms review {#existing-terms-review}
[DECISION: reconcile and incorporate the remaining approved clauses from the existing ${title} attachment, confirm its issued status and link the historical source before issuing this replacement].`), metadata: { owner_role: 'Owner', review_on: null, citations: [], fields: [] } } })),
];
