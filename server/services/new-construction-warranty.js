// New Construction Termite Warranty (Rule 5E-14.105(3)): one live warranty
// per pre-treat job. The warranty number (NCW-…, from the project id) names
// the job in every issued snapshot.
const NEW_CONSTRUCTION_WARRANTY_KEY = 'service_agreement.termite_new_construction_warranty';
const OPEN_STATUSES = ['draft', 'sent', 'viewed'];

function snapshotWarrantyNumber(snapshot) {
  let parsed = snapshot;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { parsed = null; }
  }
  return String(parsed?.warranty?.number || '').trim();
}

// Runs inside the issue transaction after the customer row lock. A signed
// warranty for the same job refuses the new one (409); an open one is
// cancelled as superseded, so the customer never holds two signing links.
async function supersedeOpenNewConstructionWarranty(trx, { templateKey, customerId, context, actorId }) {
  if (templateKey !== NEW_CONSTRUCTION_WARRANTY_KEY) return;
  const number = String(context?.warranty?.number || '').trim();
  if (!number) return;
  const prior = await trx('customer_contracts')
    .where({ customer_id: customerId, contract_type: 'document_template', document_template_key: templateKey })
    .whereIn('status', [...OPEN_STATUSES, 'signed'])
    .forUpdate()
    .select('id', 'status', 'document_variables_snapshot');
  const sameJob = prior.filter((row) => snapshotWarrantyNumber(row.document_variables_snapshot) === number);
  if (sameJob.some((row) => row.status === 'signed')) {
    throw Object.assign(new Error(`Warranty ${number} is already signed for this job.`), { status: 409 });
  }
  for (const row of sameJob) {
    const cancelled = await trx('customer_contracts')
      .where({ id: row.id })
      .whereIn('status', OPEN_STATUSES)
      .update({
        status: 'cancelled',
        cancelled_at: new Date(),
        cancelled_reason: 'Superseded by a newer issue of the same new construction warranty',
        updated_at: new Date(),
      });
    if (!cancelled) continue;
    await trx('customer_contract_events').insert({
      contract_id: row.id,
      customer_id: customerId,
      event_type: 'cancelled',
      actor_type: 'admin',
      actor_id: actorId || null,
      metadata: JSON.stringify({ reason: 'superseded_by_warranty_reissue' }),
    });
  }
}

// Job values come from certificate fields a technician can type into. In this
// warranty a value may never become its own line or a bold clause, so every
// string is flattened to one line and loses "**" before rendering.
function flattenWarrantyValue(value) {
  if (typeof value === 'string') return value.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  if (Array.isArray(value)) return value.map(flattenWarrantyValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, flattenWarrantyValue(v)]));
  }
  return value;
}

function warrantySafeValues(templateKey, values) {
  return templateKey === NEW_CONSTRUCTION_WARRANTY_KEY ? flattenWarrantyValue(values) : values;
}

module.exports = {
  NEW_CONSTRUCTION_WARRANTY_KEY,
  supersedeOpenNewConstructionWarranty,
  snapshotWarrantyNumber,
  warrantySafeValues,
};
