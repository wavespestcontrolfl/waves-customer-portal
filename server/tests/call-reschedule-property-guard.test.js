jest.mock('../models/db', () => jest.fn());
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/call-booking-catalog', () => ({ ...jest.requireActual('../services/call-booking-catalog'), planCallFollowUpShift: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/call-reschedule-apply', () => ({
  ...jest.requireActual('../services/call-reschedule-apply'),
  applyReviewedCallReschedule: jest.fn(async ({ conn, guard }) => { await guard(conn); return { applied: true }; }),
}));
const { previewProposal, applyProposal } = require('../services/call-reschedule-proposals');
const { applyReviewedCallReschedule } = require('../services/call-reschedule-apply');

test.each(['single', 'series', 'arrival-route'])('%s preview binds disclosed conflicts and saved property through Apply', async (mode) => {
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
  const conflicts = [{ target_id: 'visit', target_date: '2099-09-10', target_start: '14:00', target_end: '15:00',
    conflict_id: 'other-visit', conflict_date: '2099-09-10', conflict_start: '14:30', conflict_end: '15:30',
    reason: null, warning: null, status: 'confirmed', service_type: 'Other service' }];
  if (mode === 'arrival-route') Object.assign(conflicts[0], { conflict_id: 'infeasible:arrival_window',
    reason: 'arrival_window', warning: 'The arrival window does not fit the route.' });
  if (mode === 'series') conflicts.push({ ...conflicts[0], target_id: 'later', target_date: '2099-10-10',
    conflict_id: 'later-conflict', conflict_date: '2099-10-10' });
  const rebooker = { collectiveMoveGateOn: () => mode === 'series',
    previewMoveConflicts: jest.fn(async () => conflicts),
    previewSeriesMove: jest.fn(async () => ({ collective: true, occurrenceIds: ['visit', 'later'],
      conflictSnapshot: conflicts })) };
  try {
    const preview = await previewProposal(conn, 'card', { visitId: 'visit', now, rebooker });
    expect(preview.displayAddress.address_line1).toBe('Saved property');
    expect(preview.overlap.appointments[0].service_name).toBe(conflicts[0].warning || 'Other service');
    if (mode === 'series') expect(preview.series.conflicts).toEqual([{ occurrenceId: 'later', date: '2099-10-10',
      appointments: [{ id: 'later-conflict', service_name: 'Other service', status: 'confirmed', window_start: '14:30', window_end: '15:30' }] }]);
    await expect(applyProposal(conn, 'card', { actorId: 'staff', visitId: 'visit', now, rebooker,
      previewHash: preview.preview_hash })).resolves.toEqual({ applied: true });
    expect(applyReviewedCallReschedule).toHaveBeenLastCalledWith(expect.objectContaining({ conflictSnapshot: conflicts }));
    const originalId = conflicts.at(-1).conflict_id;
    conflicts.at(-1).conflict_id = 'replacement-with-same-count';
    await expect(applyProposal(conn, 'card', { actorId: 'staff', visitId: 'visit', now, rebooker,
      previewHash: preview.preview_hash })).rejects.toMatchObject({ status: 409 });
    conflicts.at(-1).conflict_id = originalId;
    for (const table of ['customers', 'customer_properties']) {
      const saved = tables[table];
      applyReviewedCallReschedule.mockImplementationOnce(async ({ conn: liveConn, guard }) => {
        tables[table] = []; // Disappears after Apply's fresh preview, before its locked guard.
        await guard(liveConn);
        throw new Error('Missing identity must not pass the guard');
      });
      try {
        await expect(applyProposal(conn, 'card', { actorId: 'staff', visitId: 'visit', now, rebooker,
          previewHash: preview.preview_hash })).rejects.toMatchObject({ status: 409 });
      } finally { tables[table] = saved; }
    }
    tables.customer_properties[0].address_line1 = 'Changed property';
    await expect(applyProposal(conn, 'card', { actorId: 'staff', visitId: 'visit', now, rebooker,
      previewHash: preview.preview_hash })).rejects.toMatchObject({ status: 409 });
  } finally {
    if (previousGate === undefined) delete process.env.GATE_RESCHEDULE_PROPOSAL_CARD;
    else process.env.GATE_RESCHEDULE_PROPOSAL_CARD = previousGate;
  }
});
