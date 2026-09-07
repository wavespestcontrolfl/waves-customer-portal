// Unissued authoring starters. Owner decisions remain explicit release blockers.
// Existing signed policies and uploaded forms are retained as historical evidence.
const source = (title, body, fields = [], citations = []) => ({ title, body, metadata: { owner_id: null, review_on: null, citations, fields } });
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
The owner is unreachable. A customer calls about a missed appointment and a declined payment. The office coordinator opens this procedure and records the time, the attempted owner contact, and the callback details in the customer account. Keep credentials, access codes and medical information out of this record.

Assigned backup decision-maker and contact method: [DECISION: name the backup decision-maker and approved contact method]. If the backup also cannot be reached, use [DECISION: name the next escalation contact and retry interval]. Do not treat silence as approval.

## Check the appointment before promising a remedy {#missed-appointment}
Open Dispatch and the customer account. Confirm the scheduled date, arrival window, technician assignment, status history and last customer message. Contact the assigned technician or dispatch lead to establish whether the service was missed, delayed or completed without an update. Record confirmed facts separately from the customer's report.

Use the existing scheduling workflow for any approved reschedule. Confirm availability and the customer’s agreement before saving. Do not mark a service completed based on a phone assumption. Office authority to reschedule, offer a callback application, waive a charge or issue a credit: [DECISION: define each delegated action and its limit].

## Check the declined payment separately {#declined-payment}
Open the existing invoice and payment history. Confirm whether the payment failed, is pending, or succeeded; record the invoice ID and payment status. If it is pending or unclear, leave the balance unresolved until an authorized person verifies it. Do not create a replacement invoice or repeatedly retry a charge to clear the screen.

Use the existing customer payment-link workflow when authorized and explain that a missed appointment and a declined payment are being reviewed separately. Never request card details in a note or message. Authority to retry a payment, issue a refund, apply a credit or change a fee: [DECISION: identify the billing decision-maker and delegated limits].

## Give the customer one accountable follow-up {#customer-follow-up}
Create or update the complaint record. Assign one case owner and a next-action deadline, link the customer, appointment and invoice by their portal IDs, and record the response promised to the customer. Communicate only verified facts and actions within the office coordinator's approved authority.

The existing complaint form calls for an initial response within two hours, a resolution target of 24–48 hours, and a seven-day satisfaction check. Reconcile those targets with the approved policy before issuing this guide: [DECISION: confirm complaint targets and coverage outside business hours].

## Escalate an unresolved case on day three {#complaint-day-three}
At the start of day three, review the open complaint, attempted remedies and next promised update. A missing response is not a reason to close the case. Day-three accountable owner, escalation recipient and update interval: [DECISION: assign day-three complaint ownership and escalation timing]. The case record must distinguish proposed, approved, performed and customer-confirmed actions.

## Keep an unsafe vehicle on hold {#vehicle-release}
If the missed appointment involves a vehicle defect, link the inspection and repair evidence to the case. Keep a vehicle identified as unsuitable for operation on hold until the authorized release is recorded. The person requesting a repair and the person authorizing return to service may have different authority.

Release authority, required repair evidence and alternate approver: [DECISION: identify who can release a vehicle and on what evidence]. A purchase receipt by itself does not prove that the defect was repaired.

## Handle a chemical purchase above the limit {#chemical-purchase}
Check the approved product and protocol, available stock and intended service before requesting a purchase. Record the product, quantity, supplier quote and proposed total in the existing purchasing record. Keep the requested purchase pending when its total exceeds the delegated limit.

Routine purchase limit, technical product approver, spending approver and emergency alternate: [DECISION: define chemical purchase authority and over-limit escalation]. Do not split an order to fit a limit or substitute a product without the required approval.

## Handover when coverage ends {#coverage-handover}
Give the returning owner or next coverage person the case IDs, current appointment and payment facts, decisions made, approvals obtained and outstanding deadlines. Confirm who owns each open action. Mark this procedure run complete only after the handover is recorded; completion of this checklist does not close an unresolved customer complaint.`) },
  { key: 'daily-admin-operations', kind: 'procedure', access: 'staff', source: source('Daily Admin Operations', `## Start the day with ownership {#opening-review}
Review today's Dispatch schedule, unassigned work, open customer messages and unresolved cases. Assign an owner and next action to each exception. Confirm who provides coverage when the owner is unavailable using Owner Coverage & Continuity.

## Confirm schedule exceptions {#schedule-exceptions}
Verify technician assignment, customer agreement and availability in Dispatch before changing an appointment. Use the existing schedule controls and record the reason. Escalate work that has no available or qualified technician.

## Review customer messages and complaints {#message-review}
Use the customer account to avoid duplicate replies. Assign every complaint a case owner and deadline. At day three, follow the approved continuity escalation. Separate the customer's report, verified facts and the remedy actually performed.

## Review billing exceptions {#billing-exceptions}
Review failed, pending and disputed payments in the existing billing workflow. Check the invoice and payment history before acting. Use the approved payment-link, refund or credit workflow only within delegated authority. Billing limits: [DECISION: confirm office billing authority and escalation owner].

## Check readiness and records {#field-readiness}
Review outstanding vehicle holds, missing inspections, training expirations and supply requests. A checklist tick does not release a vehicle or approve a purchase. Resolve those through the authorized approver and retain their evidence.

## Close the day with a handover {#closing-handover}
Reconcile today's schedule exceptions and customer promises against the portal records. Record the next action, owner and due time for unfinished work. Send the approved handover through the established staff channel: [DECISION: identify the handover recipient and channel]. Complete this run after the handover is recorded.`) },
  { key: 'complaint-resolution-record', kind: 'form', access: 'admin', source: source('Complaint & Resolution Record', `## Intake and ownership {#complaint-intake}
Record the customer account and service or invoice IDs, the issue reported, when it was received and the accountable case owner. Set the next-action deadline on the record. Do not include payment credentials or access codes.

## Investigation and escalation {#complaint-investigation}
Separate the report from verified findings. Record each contact attempt and decision. Day-three escalation owner and threshold for owner approval: [DECISION: confirm complaint ownership and remedy approval rules].

## Resolution and follow-up {#complaint-resolution}
Record the remedy proposed, who approved it, when it was performed and the evidence. Close only after documenting the outcome and required follow-up. An offered remedy is not a completed remedy.`, [field('account-reference', 'Customer / service / invoice IDs'), field('reported-issue', 'Issue reported', 'textarea'), field('findings', 'Verified findings and contact attempts', 'textarea'), field('approvals', 'Approval reference and action performed', 'textarea'), field('outcome', 'Outcome and follow-up evidence', 'textarea'), field('closure-verified', 'I verified the recorded outcome', 'checkbox')]) },
  { key: 'incident-record', kind: 'form', access: 'admin', source: source('Incident / Accident Record', `## Immediate response {#incident-response}
Call emergency services when needed and notify the supervisor immediately. The incident form documents that response; it does not replace immediate notification. Record the time and responder references. Keep medical results and diagnosis documents in the restricted medical record, with only a reference here.

## Facts and follow-up {#incident-follow-up}
Record observed facts, immediate controls, notification evidence and the corrective-action owner and deadline. Supervisor contact, alternate, reporting deadlines and final-review authority: [DECISION: confirm incident reporting and review responsibilities].`, [field('incident-time', 'Incident date and time'), field('location-reference', 'Work location / service ID'), field('observed-facts', 'Observed facts', 'textarea'), field('notifications', 'Who was notified and when', 'textarea'), field('corrective-action', 'Controls and corrective-action evidence', 'textarea'), field('review-reference', 'Supervisor review reference')]) },
  { key: 'vehicle-inspection-record', kind: 'form', access: 'staff', source: source('Vehicle Inspection & Release Record', `## Inspect before operation {#vehicle-inspection}
Follow the vehicle's approved inspection checklist and record its asset ID, odometer and any defects. The original daily, weekly and monthly inspection requirements must be reconciled before issuance: [DECISION: confirm inspection items and cadence].

## Defect disposition {#defect-disposition}
Record whether the vehicle is held out of service, sent for repair or cleared under the approved release rule. Keep repair evidence separate from the release decision. Do not certify an unresolved safety defect as fit for operation.

## Authorized release {#authorized-release}
Release approver, alternate and required evidence: [DECISION: specify vehicle release authority]. Record who released the vehicle, when, and the evidence reviewed. This record does not automatically change a vehicle's operational status.`, [field('asset-id', 'Vehicle asset ID'), field('odometer', 'Odometer'), field('inspection', 'Completed inspection items and defects', 'textarea'), field('disposition', 'Disposition and operating restrictions', 'textarea'), field('repair-evidence', 'Repair / inspection evidence reference'), field('release-reference', 'Authorized release reference or unresolved hold', 'textarea')]) },
  { key: 'training-certification-register', kind: 'form', access: 'admin', source: source('Training & Certification Register', `## Employee identification cards {#employee-id-renewal}
Employee identification cards require annual renewal by the licensed business location's anniversary date. Use the actual credential and FDACS record to establish the renewal date. This register does not authorize work or replace required training and supervision.

## Operator certificates {#operator-certificate-renewal}
Pest control operator certificates renew annually by the anniversary of issuance. Track the certificate category, expiration and renewal evidence separately from an employee identification card.

## Verification and next action {#credential-verification}
Record the staff ID, credential type and category, credential reference, verified expiration, training evidence and next action. Responsible credential reviewer and escalation for missing or expired evidence: [DECISION: name the credential reviewer and escalation owner].`, [field('staff-reference', 'Staff ID'), field('credential-type', 'Credential type and category'), field('credential-reference', 'Credential / official record reference'), field('expiration', 'Verified expiration date', 'date'), field('training-evidence', 'Training and renewal evidence references', 'textarea'), field('verification', 'Reviewer and next action', 'textarea')], [
    { anchor: 'employee-id-renewal', label: 'Florida Statutes §482.091(4)', url: 'https://www.flsenate.gov/Laws/Statutes/2026/0482.091', verified_on: '2026-09-07', review_on: '2026-12-06' },
    { anchor: 'operator-certificate-renewal', label: 'Florida Statutes §482.111(3)', url: 'https://www.flsenate.gov/Laws/Statutes/2026/0482.111', verified_on: '2026-09-07', review_on: '2026-12-06' },
  ]) },
  ...[
    ['employee-handbook', 'Employee Handbook'],
    ['offer-letter', 'Offer Letter — Shared Employment Terms'],
    ['job-descriptions', 'Job Descriptions — Shared Employment Terms'],
  ].map(([key, title]) => ({ key, kind: 'policy', access: 'staff', source: source(title, `${compensation}

## Existing terms review {#existing-terms-review}
[DECISION: reconcile and incorporate the remaining approved clauses from the existing ${title} attachment, confirm its issued status and link the historical source before issuing this replacement].`) })),
];
