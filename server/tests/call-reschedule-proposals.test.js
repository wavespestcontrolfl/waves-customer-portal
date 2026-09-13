jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { proposalEvidence, proposalAddress, customerWindow, stageProposal } = require('../services/call-reschedule-proposals');
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
  test('customer arrival windows preserve two Eastern wall-clock hours across spring forward', () => {
    expect(customerWindow('2029-03-11', '01:00')).toEqual({
      start_at: '2029-03-11T06:00:00.000Z',
      end_at: '2029-03-11T07:00:00.000Z',
    });
  });
  test('an old proposal stays open instead of aging out as an advisory', () => {
    expect(classifyTriageItem({ status: 'open', severity: 'advisory', reason_code: 'reschedule_or_cancel', created_at: '2001-01-01',
      payload: { reschedule_proposal: { proposed_start_at: v2.scheduling.proposed_start_at } } }, { evidence: new Map() })).toBeNull();
  });
});

function stageConn(call, card, { handledCard = null } = {}) {
  const updates = [];
  const conn = (table) => {
    const state = { where: {}, whereIn: {}, nullColumn: null };
    const query = {
      where(arg) { if (arg && typeof arg === 'object') Object.assign(state.where, arg); return query; },
      whereIn(column, values) { state.whereIn[column] = values; return query; },
      whereNull(column) { state.nullColumn = column; return query; },
      whereRaw() { return query; },
      forUpdate() { return query; },
      first() {
        if (table === 'call_log') return Promise.resolve(call);
        if (table === 'triage_items') {
          if (state.whereIn.reason_code) return Promise.resolve(handledCard);
          const matches = card && Object.entries(state.where).every(([key, value]) => card[key] === value)
            && (!state.nullColumn || card[state.nullColumn] == null)
            && card.payload?.reschedule_proposal;
          return Promise.resolve(matches ? card : undefined);
        }
        return Promise.resolve(undefined);
      },
      update(patch) {
        updates.push({ table, patch });
        if (table === 'triage_items') Object.assign(card, patch);
        return Promise.resolve(1);
      },
    };
    return query;
  };
  conn.raw = jest.fn().mockResolvedValue({ rows: [] });
  conn.transaction = (fn) => fn(conn);
  conn.updates = updates;
  return conn;
}

describe('proposal staging after call reprocessing', () => {
  test('a nonqualifying reprocess retires an unclaimed proposal but preserves a claimed one', async () => {
    const priorGate = process.env.GATE_RESCHEDULE_PROPOSAL_CARD;
    process.env.GATE_RESCHEDULE_PROPOSAL_CARD = 'true';
    const reprocessed = { id: 'call', customer_id: 'customer', processing_token: null, processing_generation: 2,
      v2_extraction_status: 'valid', ai_extraction_enriched: { meta: { is_spam: true } } };
    const payload = { reschedule_proposal: { call_generation: 1 }, other_evidence: { keep: true } };
    try {
      const openCard = { id: 'open-card', call_log_id: 'call', reason_code: 'reschedule_or_cancel', status: 'open',
        assigned_to: null, payload: { ...payload } };
      const openConn = stageConn(reprocessed, openCard);
      expect(await stageProposal(openConn, { callId: 'call', procGeneration: 2 })).toEqual({ staged: false });
      expect(openCard.payload).toEqual({ other_evidence: { keep: true } });
      expect(openConn.updates).toHaveLength(1);

      const claimedCard = { id: 'claimed-card', call_log_id: 'call', reason_code: 'reschedule_or_cancel', status: 'in_progress',
        assigned_to: 'staff', payload: { ...payload } };
      const claimedConn = stageConn(reprocessed, claimedCard);
      expect(await stageProposal(claimedConn, { callId: 'call', procGeneration: 2 })).toEqual({ staged: false });
      expect(claimedCard.payload).toEqual(payload);
      expect(claimedConn.updates).toHaveLength(0);
    } finally {
      if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_PROPOSAL_CARD;
      else process.env.GATE_RESCHEDULE_PROPOSAL_CARD = priorGate;
    }
  });

  test('expired requests and human-handled sibling workflows retire only an unclaimed proposal', async () => {
    const priorGate = process.env.GATE_RESCHEDULE_PROPOSAL_CARD;
    process.env.GATE_RESCHEDULE_PROPOSAL_CARD = 'true';
    const quote = 'Could you come Thursday at two instead?';
    const call = { id: 'call', customer_id: 'customer', processing_token: null, processing_generation: 2,
      v2_extraction_status: 'valid', transcription: `Caller: ${quote}`,
      ai_extraction_enriched: { scheduling: { status: 'reschedule_requested', proposed_start_at: '2099-09-10T14:00:00-04:00' },
        evidence: [{ field_path: '/scheduling/proposed_start_at', speaker: 'caller', quote }] } };
    const proposal = () => ({ id: 'proposal-card', call_log_id: 'call', reason_code: 'reschedule_or_cancel', status: 'open',
      assigned_to: null, payload: { reschedule_proposal: { call_generation: 1 }, keep: true } });
    try {
      const expired = proposal();
      const expiredCall = { ...call, ai_extraction_enriched: { ...call.ai_extraction_enriched,
        scheduling: { status: 'reschedule_requested', proposed_start_at: '2026-09-10T14:00:00-04:00' } } };
      await stageProposal(stageConn(expiredCall, expired), { callId: 'call', procGeneration: 2, now: new Date('2026-09-11T00:00:00Z') });
      expect(expired.payload).toEqual({ keep: true });

      for (const handledCard of [
        { id: 'coord-claimed', status: 'in_progress' },
        { id: 'coord-resolved', status: 'resolved', resolution_source: 'human' },
        { id: 'coord-dismissed', status: 'dismissed', resolution_source: 'human' },
      ]) {
        const open = proposal();
        await stageProposal(stageConn(call, open, { handledCard }), {
          callId: 'call', procGeneration: 2, now: new Date('2099-09-09T12:00:00Z'),
        });
        expect(open.payload).toEqual({ keep: true });
      }

      const claimed = { ...proposal(), status: 'in_progress', assigned_to: 'staff' };
      await stageProposal(stageConn(call, claimed, { handledCard: { id: 'coord-claimed', status: 'in_progress' } }), {
        callId: 'call', procGeneration: 2, now: new Date('2099-09-09T12:00:00Z'),
      });
      expect(claimed.payload).toHaveProperty('reschedule_proposal');
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
    const visit = { property: null, service_address_line1: '200 Visit Court', service_address_city: 'Visit City', service_address_state: 'GA' };
    expect(proposalAddress(visit, customer)).toMatchObject({ address_line1: '200 Visit Court', city: 'Visit City', state: 'GA' });
    expect(visit.property).toBeNull();
  });
  test('customer address is the last fallback; no usable address stays unavailable', () => {
    expect(proposalAddress({ property: null }, customer)).toEqual({ ...customer, address_line2: null });
    expect(proposalAddress({ property: null }, {})).toBeNull();
  });
});


describe('superseded proposal staging', () => {
  test.each([
    { agent_committed_booking: true, confirmed_start_at: '2099-09-10T15:00:00-04:00' },
    { agent_committed_booking: true },
    { confirmed_start_at: '2099-09-10T15:00:00-04:00' },
  ])('a later agreement retires only the unclaimed request: %j', async (agreement) => {
    const priorGate = process.env.GATE_RESCHEDULE_PROPOSAL_CARD;
    process.env.GATE_RESCHEDULE_PROPOSAL_CARD = 'true';
    const quote = 'Could you come Thursday at two instead?';
    const call = { id: 'call', customer_id: 'customer', processing_generation: 2, v2_extraction_status: 'valid',
      transcription: `Caller: ${quote}`, ai_extraction_enriched: {
        scheduling: { status: 'reschedule_requested', proposed_start_at: '2099-09-10T14:00:00-04:00', ...agreement },
        evidence: [{ field_path: '/scheduling/proposed_start_at', speaker: 'caller', quote }],
      } };
    try {
      for (const claimed of [false, true]) {
        const card = { id: 'card', call_log_id: 'call', reason_code: 'reschedule_or_cancel',
          status: claimed ? 'in_progress' : 'open', assigned_to: claimed ? 'staff' : null,
          payload: { keep: true, reschedule_proposal: { call_generation: 1 } } };
        const conn = stageConn(call, card);
        expect(await stageProposal(conn, { callId: 'call', procGeneration: 2, now: new Date('2099-09-09T12:00:00Z') }))
          .toEqual({ staged: false });
        expect(Boolean(card.payload.reschedule_proposal)).toBe(claimed);
        expect(card.payload.keep).toBe(true);
      }
    } finally {
      if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_PROPOSAL_CARD;
      else process.env.GATE_RESCHEDULE_PROPOSAL_CARD = priorGate;
    }
  });
});

test('terminal cleanup retires old evidence under the successful processing generation only', async () => {
  const priorGate = process.env.GATE_RESCHEDULE_PROPOSAL_CARD;
  process.env.GATE_RESCHEDULE_PROPOSAL_CARD = 'true';
  const call = { id: 'call', customer_id: 'customer', processing_generation: 2, v2_extraction_status: 'valid' };
  const card = { id: 'card', call_log_id: 'call', reason_code: 'reschedule_or_cancel', status: 'open',
    assigned_to: null, payload: { keep: true, reschedule_proposal: { call_generation: 1 } } };
  try {
    await stageProposal(stageConn(call, card), { callId: 'call', procGeneration: 1, retireOnly: true });
    expect(card.payload.reschedule_proposal).toBeDefined();
    await stageProposal(stageConn(call, card), { callId: 'call', procGeneration: 2, retireOnly: true });
    expect(card.payload).toEqual({ keep: true });
  } finally {
    if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_PROPOSAL_CARD;
    else process.env.GATE_RESCHEDULE_PROPOSAL_CARD = priorGate;
  }
});


test.each(['resolved', 'dismissed'])('shared triage %s rejects stale or missing versions of live proposals', async (nextStatus) => {
  const { transitionCore } = require('../routes/admin-triage');
  const call = { id: 'call' };
  const card = { id: 'card', call_log_id: 'call', reason_code: 'reschedule_or_cancel', status: 'open',
    updated_at: new Date('2026-09-13T04:00:00Z'), payload: { reschedule_proposal: { call_generation: 2 } } };
  for (const expectedUpdatedAt of [undefined, '2026-09-13T03:00:00Z']) {
    const conn = stageConn(call, card);
    const result = await transitionCore({ conn, id: card.id, nextStatus, expectedUpdatedAt });
    expect(result.outcome).toBe('stale_version');
    expect(conn.updates).toEqual([]);
  }
});
