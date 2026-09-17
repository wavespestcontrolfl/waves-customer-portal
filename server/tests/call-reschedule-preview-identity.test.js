jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/call-booking-catalog', () => ({ ...jest.requireActual('../services/call-booking-catalog'), planCallFollowUpShift: jest.fn().mockResolvedValue([]) }));
const { previewProposal, applyProposal } = require('../services/call-reschedule-proposals');
describe('proposal preview identity', () => {
  test.each(['service_id', 'service_type', 'service_address_state', 'deleted_at', 'address_missing'])('changing %s after preview cannot apply the old approval', async (field) => {
    const priorGate = process.env.GATE_RESCHEDULE_PROPOSAL_CARD;
    process.env.GATE_RESCHEDULE_PROPOSAL_CARD = 'true';
    const now = new Date('2099-09-09T08:00:00-04:00');
    const target = '2099-09-10T14:00:00-04:00';
    const quote = 'Could you come Thursday at two instead?';
    const selected = { id: 'visit', customer_id: 'customer', service_id: 'service-a', service_type: 'Original service',
      scheduled_date: '2099-09-10', window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed', property_id: null,
      service_address_state: 'FL' };
    const tables = {
      triage_items: [{ id: 'card', call_log_id: 'call', status: 'open', updated_at: now,
        payload: { reschedule_proposal: { call_generation: 1, proposed_start_at: target } } }],
      call_log: [{ id: 'call', customer_id: 'customer', processing_generation: 1, v2_extraction_status: 'valid',
        direction: 'inbound', from_phone: '+15555550101', transcription: `Caller: ${quote}`, created_at: now,
        ai_extraction_enriched: { scheduling: { status: 'reschedule_requested', proposed_start_at: target },
          evidence: [{ field_path: '/scheduling/proposed_start_at', speaker: 'caller', quote }] } }],
      customers: [{ id: 'customer', phone: '+15555550101', address_line1: '100 Example Avenue' }],
      scheduled_services: [selected], services: [{ id: 'service-a', name: 'Original service' }, { id: 'service-b', name: 'Other service' }],
    };
    const conn = (table) => {
      const query = { where: () => query, whereIn: () => query, orderBy: () => query, leftJoin: () => query, select: () => query,
        first: async () => ({ ...tables[table][0] }), then: (resolve, reject) => Promise.resolve(tables[table].map((row) => ({ ...row }))).then(resolve, reject) };
      return query;
    };
    conn.transaction = async (fn) => fn(conn);
    const rebooker = { collectiveMoveGateOn: () => false, reschedule: jest.fn(), previewMoveConflicts: jest.fn() };
    try {
      rebooker.previewMoveConflicts.mockResolvedValue(field === 'service_address_state' ? [{
        target_id: 'visit', target_date: '2099-09-10', target_start: '14:00', target_end: '15:00',
        conflict_id: 'conflict-1', conflict_date: '2099-09-10', conflict_start: '13:30', conflict_end: '15:30',
        status: 'confirmed', service_type: 'Conflicting service',
      }] : []);
      const preview = await previewProposal(conn, 'card', { visitId: 'visit', now, rebooker });
      expect(preview.displayAddress.address_line1).toBe('100 Example Avenue');
      if (field === 'service_address_state') {
        expect(preview.overlap).toEqual({ count: 1, appointments: [{ id: 'conflict-1', scheduled_date: '2099-09-10',
          current_window: { start_at: '2099-09-10T17:30:00.000Z', end_at: '2099-09-10T19:30:00.000Z' },
          status: 'confirmed', service_name: 'Conflicting service' }] });
        expect(rebooker.previewMoveConflicts).toHaveBeenCalledWith('visit', '2099-09-10', { start: '14:00', end: '15:00' },
          { conn: expect.any(Function), adminWindowRules: true, overlapAdvisory: true, seriesPolicy: 'single' });
      }
      if (field === 'deleted_at') tables.customers[0].deleted_at = now;
      else if (field === 'address_missing') tables.customers[0].address_line1 = null;
      else selected[field] = field === 'service_id' ? 'service-b' : (field === 'service_address_state' ? 'GA' : 'Changed service');
      await expect(applyProposal(conn, 'card', { actorId: 'staff', visitId: 'visit', previewHash: preview.preview_hash, now, rebooker }))
        .rejects.toMatchObject({ status: 409 });
      expect(rebooker.reschedule).not.toHaveBeenCalled();
    } finally {
      if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_PROPOSAL_CARD;
      else process.env.GATE_RESCHEDULE_PROPOSAL_CARD = priorGate;
    }
  });
});
