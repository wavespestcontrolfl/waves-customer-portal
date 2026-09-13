jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/call-booking-catalog', () => ({
  ...jest.requireActual('../services/call-booking-catalog'), planCallFollowUpShift: jest.fn().mockResolvedValue([]),
}));
const { proposalEvidence, proposalAddress, customerWindow, previewProposal, applyProposal } = require('../services/call-reschedule-proposals');
const { planRescheduleFromCall } = require('../services/call-reschedule-apply');
const { classifyTriageItem } = require('../services/triage-auto-resolve');

describe('reviewed proposed times', () => {
  const quote = 'Could you come Thursday at two instead?';
  const v2 = { scheduling: { status: 'reschedule_requested', proposed_start_at: '2099-09-10T14:00:00-04:00', confirmed_start_at: null },
    evidence: [{ field_path: '/scheduling/proposed_start_at', speaker: 'caller', quote }] };
  test('only a grounded caller turn can create a proposal', () => {
    expect(proposalEvidence(v2, `Caller: ${quote}\nAgent: We will check.`)).toBe(quote);
    expect(proposalEvidence(v2, `Agent: ${quote}\nCaller: Maybe.`)).toBeNull();
    expect(proposalEvidence(v2, quote)).toBeNull();
  });
  test('staff can select a past occurrence explicitly without treating the request as agreement', () => {
    const call = { customer_id: 'customer', direction: 'inbound', from_phone: '+15555550101' };
    const customer = { id: 'customer', phone: call.from_phone };
    const candidates = [{ id: 'missed', customer_id: customer.id, scheduled_date: '2099-09-07', window_start: '16:00', window_end: '17:00', status: 'confirmed' },
      { id: 'later', customer_id: customer.id, scheduled_date: '2099-12-07', window_start: '16:00', window_end: '17:00', status: 'confirmed' }];
    const args = { call, customer, candidates, v2, now: new Date('2099-09-09T08:00:00-04:00') };
    expect(planRescheduleFromCall(args).reason).toBe('agent_did_not_commit');
    expect(planRescheduleFromCall({ ...args, humanOverride: { visitId: 'missed' } })).toMatchObject({ action: 'apply', visitId: 'missed', newWindow: { start: '14:00', end: '15:00' } });
    expect(planRescheduleFromCall({ ...args, candidates: candidates.map((row) => ({ ...row, customer_id: 'foreign' })), humanOverride: { visitId: 'missed' } }).reason).toBe('no_visit_on_books');
    expect(customerWindow('2099-09-10', '14:00')).toEqual({ start_at: '2099-09-10T18:00:00.000Z', end_at: '2099-09-10T20:00:00.000Z' });
  });
  test('an old proposal stays open instead of aging out as an advisory', () => {
    expect(classifyTriageItem({ status: 'open', severity: 'advisory', reason_code: 'reschedule_or_cancel', created_at: '2001-01-01',
      payload: { reschedule_proposal: { proposed_start_at: v2.scheduling.proposed_start_at } } }, { evidence: new Map() })).toBeNull();
  });
});


describe('proposal preview identity', () => {
  test.each(['service_id', 'service_type', 'deleted_at', 'address_missing'])('changing %s after preview cannot apply the old approval', async (field) => {
    const priorGate = process.env.GATE_RESCHEDULE_PROPOSAL_CARD;
    process.env.GATE_RESCHEDULE_PROPOSAL_CARD = 'true';
    const now = new Date('2099-09-09T08:00:00-04:00');
    const target = '2099-09-10T14:00:00-04:00';
    const quote = 'Could you come Thursday at two instead?';
    const selected = { id: 'visit', customer_id: 'customer', service_id: 'service-a', service_type: 'Original service',
      scheduled_date: '2099-09-10', window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed', property_id: null };
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
    const rebooker = { collectiveMoveGateOn: () => false, reschedule: jest.fn() };
    try {
      const preview = await previewProposal(conn, 'card', { visitId: 'visit', now, rebooker });
      expect(preview.displayAddress.address_line1).toBe('100 Example Avenue');
      if (field === 'deleted_at') tables.customers[0].deleted_at = now;
      else if (field === 'address_missing') tables.customers[0].address_line1 = null;
      else selected[field] = field === 'service_id' ? 'service-b' : 'Changed service';
      await expect(applyProposal(conn, 'card', { actorId: 'staff', visitId: 'visit', previewHash: preview.preview_hash, now, rebooker }))
        .rejects.toMatchObject({ status: 409 });
      expect(rebooker.reschedule).not.toHaveBeenCalled();
    } finally {
      if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_PROPOSAL_CARD;
      else process.env.GATE_RESCHEDULE_PROPOSAL_CARD = priorGate;
    }
  });
});


describe('proposal display addresses preserve the raw property identity', () => {
  const customer = { address_line1: '100 Example Avenue', city: 'Example City', state: 'FL', zip: '00000' };
  test('an active property outranks legacy and customer addresses', () => {
    const visit = { property: { address_line1: '300 Property Lane' }, service_address_line1: '200 Visit Court' };
    expect(proposalAddress(visit, customer).address_line1).toBe('300 Property Lane');
  });
  test('a legacy visit keeps its own address and null property', () => {
    const visit = { property: null, service_address_line1: '200 Visit Court', service_address_city: 'Visit City' };
    expect(proposalAddress(visit, customer)).toMatchObject({ address_line1: '200 Visit Court', city: 'Visit City' });
    expect(visit.property).toBeNull();
  });
  test('customer address is the last fallback; no usable address stays unavailable', () => {
    expect(proposalAddress({ property: null }, customer)).toEqual({ ...customer, address_line2: null });
    expect(proposalAddress({ property: null }, {})).toBeNull();
  });
});
