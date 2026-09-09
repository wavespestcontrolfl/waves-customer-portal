jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { proposalEvidence, customerWindow } = require('../services/call-reschedule-proposals');
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
