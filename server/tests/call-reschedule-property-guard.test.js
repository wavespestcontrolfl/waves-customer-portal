jest.mock('../models/db', () => jest.fn());
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/window-rules', () => ({ ...jest.requireActual('../services/scheduling/window-rules'), probeSlotOverlap: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/call-booking-catalog', () => ({ ...jest.requireActual('../services/call-booking-catalog'), planCallFollowUpShift: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/call-reschedule-apply', () => ({
  ...jest.requireActual('../services/call-reschedule-apply'),
  applyReviewedCallReschedule: jest.fn(async ({ conn, guard }) => { await guard(conn); return { applied: true }; }),
}));
const { previewProposal, applyProposal } = require('../services/call-reschedule-proposals');

test('an unchanged saved property passes the preview-to-apply identity guard', async () => {
  const previousGate = process.env.GATE_RESCHEDULE_PROPOSAL_CARD;
  process.env.GATE_RESCHEDULE_PROPOSAL_CARD = 'true';
  const now = new Date('2099-09-09T08:00:00-04:00');
  const target = '2099-09-10T14:00:00-04:00';
  const quote = 'Could you come Thursday at two instead?';
  const tables = {
    triage_items: [{ id: 'card', call_log_id: 'call', status: 'open', updated_at: now,
      payload: { reschedule_proposal: { call_generation: 1, proposed_start_at: target } } }],
    call_log: [{ id: 'call', customer_id: 'customer', processing_generation: 1, v2_extraction_status: 'valid',
      direction: 'inbound', from_phone: '+15555550101', transcription: `Caller: ${quote}`, created_at: now,
      ai_extraction_enriched: { scheduling: { status: 'reschedule_requested', proposed_start_at: target },
        evidence: [{ field_path: '/scheduling/proposed_start_at', speaker: 'caller', quote }] } }],
    customers: [{ id: 'customer', phone: '+15555550101', address_line1: 'Fallback address' }],
    technicians: [{ id: 'staff', employment_status: 'active' }],
    scheduled_services: [{ id: 'visit', customer_id: 'customer', service_id: 'pest', service_type: 'Pest Control',
      scheduled_date: '2099-09-10', window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed', property_id: 'property' }],
    services: [{ id: 'pest', name: 'Pest Control' }],
    customer_properties: [{ id: 'property', customer_id: 'customer', active: true, address_line1: 'Saved property',
      address_line2: null, city: 'Test City', state: 'FL', zip: '00000', updated_at: now }],
  };
  const conn = (table) => {
    let columns = [];
    const project = (row) => !row ? undefined : table === 'customer_properties' && columns.length
      ? Object.fromEntries(columns.map((column) => [column, row[column]])) : { ...row };
    const query = {
      where: () => query, whereIn: () => query, orderBy: () => query, leftJoin: () => query,
      forUpdate: () => query, forShare: () => query,
      select(...args) { columns = args.flat(); return query; },
      first(...args) { if (args.length) columns = args.flat(); return Promise.resolve(project(tables[table][0])); },
      update: jest.fn().mockResolvedValue(1),
      then: (resolve, reject) => Promise.resolve(tables[table].map(project)).then(resolve, reject),
    };
    return query;
  };
  conn.transaction = async (fn) => fn(conn);
  conn.raw = jest.fn().mockResolvedValue({ rows: [] });
  const rebooker = { collectiveMoveGateOn: () => false };
  try {
    const preview = await previewProposal(conn, 'card', { visitId: 'visit', now, rebooker });
    expect(preview.displayAddress.address_line1).toBe('Saved property');
    await expect(applyProposal(conn, 'card', { actorId: 'staff', visitId: 'visit', now, rebooker,
      previewHash: preview.preview_hash })).resolves.toEqual({ applied: true });
    tables.customer_properties[0].address_line1 = 'Changed property';
    await expect(applyProposal(conn, 'card', { actorId: 'staff', visitId: 'visit', now, rebooker,
      previewHash: preview.preview_hash })).rejects.toMatchObject({ status: 409 });
  } finally {
    if (previousGate === undefined) delete process.env.GATE_RESCHEDULE_PROPOSAL_CARD;
    else process.env.GATE_RESCHEDULE_PROPOSAL_CARD = previousGate;
  }
});
