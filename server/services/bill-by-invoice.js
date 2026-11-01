'use strict';

/**
 * Bill by invoice (owner 2026-10-30, pipeline audit item 1, option A "Bill after each visit"). A visit booked from a
 * won commercial proposal in invoice mode bills by invoice, due on the agreement's Net term
 * (proposal-win.js proposalTermsDueDate). Auto Pay never collects that bill, whatever the customer's Auto Pay
 * enrollment says: the agreement says invoice. Every Auto Pay rail asks this module:
 *   - the completion charge, extended and per-application lanes (completion-charge-verdict.js);
 *   - the closeout-sheet charge (visit-completion-payment.js);
 *   - the full-balance sweep (completion-balance-sweep.js);
 *   - the Auto Pay hold sweep's charge, and the reminder ladder's Auto Pay hold, which would wait for a charge
 *     that never comes (invoice-followups.js, visit-completion-packets.js);
 *   - the sheets' charge promise (admin-schedule.js, closeout-status.js, annual-prepay-renewals.js).
 * An appointment card request is the customer's own card for that one visit, not Auto Pay: its lane is unchanged.
 *
 * Every read throws on failure. Each caller picks its own safe direction.
 */

const ESTIMATE_COLUMNS = ['id', 'status', 'bill_by_invoice', 'estimate_data'];

// The normalized proposal of an accepted, authored commercial proposal in any billing mode, else null. Pure.
function wonAuthoredProposal(estimate) {
  if (!estimate || estimate.status !== 'accepted') return null;
  const proposal = require('./estimate-proposal').normalizeProposal(estimate);
  return proposal.enabled === true && proposal.synthesized !== true ? proposal : null;
}

// The normalized proposal of an accepted, authored commercial proposal billed by invoice, else null. Pure.
function billByInvoiceProposal(estimate) {
  return estimate?.bill_by_invoice === true ? wonAuthoredProposal(estimate) : null;
}

// The ids among `estimateIds` that are such proposals, as strings (one read).
async function billByInvoiceEstimateIds(conn, estimateIds) {
  const ids = [...new Set((estimateIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Set();
  const rows = await conn('estimates').whereIn('id', ids).select(ESTIMATE_COLUMNS);
  return new Set(rows.filter((row) => billByInvoiceProposal(row)).map((row) => String(row.id)));
}

// True when the visit was booked from such a proposal. `svc` is the caller's visit row: its own source_estimate_id
// is used when the row carries the column, else the visit is read by id.
async function billByInvoiceVisit(conn, svc) {
  let sourceEstimateId = svc?.source_estimate_id;
  if (sourceEstimateId === undefined) {
    if (!svc?.id) return false;
    const row = await conn('scheduled_services').where({ id: svc.id }).first('source_estimate_id');
    sourceEstimateId = row?.source_estimate_id;
  }
  if (!sourceEstimateId) return false;
  return (await billByInvoiceEstimateIds(conn, [sourceEstimateId])).size > 0;
}

// True when the invoice bills such a visit: its own visit, else its service record's visit. An invoice object
// without either column is read by id.
async function billByInvoiceInvoice(conn, invoice) {
  const visitId = await invoiceVisitId(conn, invoice);
  return visitId ? billByInvoiceVisit(conn, { id: visitId }) : false;
}

// The id of the visit an invoice bills: its own visit, else its service record's visit, else null. An invoice object
// without either column is read by id.
async function invoiceVisitId(conn, invoice) {
  let doc = invoice;
  if (doc && doc.scheduled_service_id === undefined && doc.service_record_id === undefined) {
    if (!doc.id) return null;
    doc = await conn('invoices').where({ id: doc.id }).first('scheduled_service_id', 'service_record_id');
  }
  if (doc?.scheduled_service_id) return doc.scheduled_service_id;
  if (!doc?.service_record_id) return null;
  const record = await conn('service_records').where({ id: doc.service_record_id }).first('scheduled_service_id');
  return record?.scheduled_service_id || null;
}

// True when the invoice bills a visit booked from a won, authored commercial proposal in any billing mode: the bills
// whose due date the agreement's payment terms set (proposal-win.js proposalTermsDueDate), which the reminder ladder
// starts from that due date (invoice-followups.js newSequenceAnchor).
async function wonProposalInvoice(conn, invoice) {
  const visitId = await invoiceVisitId(conn, invoice);
  if (!visitId) return false;
  const visit = await conn('scheduled_services').where({ id: visitId }).first('source_estimate_id');
  if (!visit?.source_estimate_id) return false;
  const estimate = await conn('estimates').where({ id: visit.source_estimate_id }).first(ESTIMATE_COLUMNS);
  return wonAuthoredProposal(estimate) !== null;
}

module.exports = {
  billByInvoiceProposal,
  billByInvoiceEstimateIds,
  billByInvoiceVisit,
  billByInvoiceInvoice,
  invoiceVisitId,
  wonAuthoredProposal,
  wonProposalInvoice,
};
