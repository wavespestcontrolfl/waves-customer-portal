// A stand-in for estimate-public's composeEstimateDataPayload for suites that
// mock that route module (codex #6343 r14): the PDF fence hashes the payload
// the headless page renders. The stand-in projects the row the way the real
// composer does for the fields the document prints, and reads two per-test
// knobs from the row's estimate_data so a suite can move what the real
// composer would take from other tables: `__acceptance` (the acceptance
// contract, incl. the linked appointment) and `__billing` (a billing-lane
// marker). The real composer is exercised in estimate-email-pdf-document-input.test.js.
function parsed(row) {
  if (!row?.estimate_data) return {};
  return typeof row.estimate_data === 'string' ? JSON.parse(row.estimate_data) : row.estimate_data;
}

async function documentPayloadFromRow(estimate, { docRenderPin = null } = {}) {
  const data = parsed(estimate);
  const toIso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);
  return {
    estimate: {
      id: estimate.id,
      token: estimate.token,
      slug: estimate.estimate_slug || null,
      customerName: estimate.customer_name || null,
      customerPhone: estimate.customer_phone || null,
      customerEmail: estimate.customer_email || null,
      address: estimate.address || null,
      category: estimate.category || 'RESIDENTIAL',
      createdAt: toIso(estimate.created_at),
      expiresAt: docRenderPin?.validThrough || toIso(estimate.expires_at),
      satelliteUrl: estimate.satellite_url || null,
      acceptance: data.__acceptance || { mode: 'standard_slot_pick' },
      askToken: `per-request-${Math.random()}`,
    },
    proposal: data.proposal || null,
    cta: { monthlyBilled: data.__billing === 'monthly', terminalState: null },
    meta: { generatedAt: new Date().toISOString() },
  };
}

module.exports = { documentPayloadFromRow, reconcileFrozenMembershipSnapshot: async () => {} };
