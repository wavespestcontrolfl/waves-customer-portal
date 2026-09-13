jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/visit-groups', () => ({
  openMembers: jest.fn(),
  frozenVisitVerdict: jest.fn(),
}));

const {
  planRescheduleFromCall,
  loadCandidates,
  humanHandledRescheduleCard,
  ACTIVITY_ACTION,
} = require('../services/call-reschedule-apply');
const { hasUnblockedVisitGroup } = require('../services/reschedule-link');
const visitGroups = require('../services/visit-groups');

const NOW = new Date('2099-09-09T12:00:00-04:00');
const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const VISIT_ID = '70000000-0000-4000-8000-000000000001';
const PHONE = '+15555550101';
const PROPOSED = '2099-09-10T14:00:00-04:00';
const CONFIRMED = '2099-09-11T16:00:00-04:00';
const CONFIRMED_QUOTE = 'We will see you on Friday September 11 at 4 PM.';

const call = {
  customer_id: CUSTOMER_ID,
  direction: 'inbound',
  from_phone: PHONE,
  created_at: NOW,
  transcription: `Agent: ${CONFIRMED_QUOTE}\nCaller: Thank you.`,
};
const customer = {
  id: CUSTOMER_ID,
  phone: PHONE,
  address_line1: '100 Example Street',
  city: 'Bradenton',
  zip: '34205',
};
const candidate = (overrides = {}) => ({
  id: VISIT_ID,
  customer_id: CUSTOMER_ID,
  scheduled_date: '2099-09-10',
  window_start: '09:00:00',
  window_end: '10:00:00',
  status: 'confirmed',
  source_action: null,
  visit_id: null,
  ...overrides,
});
const requestExtraction = (scheduling = {}) => ({
  meta: { is_spam: false, is_voicemail: false },
  caller: { decision_maker_present: true },
  consent: { do_not_contact_request: false },
  scheduling: {
    status: 'reschedule_requested',
    agent_committed_booking: false,
    proposed_start_at: PROPOSED,
    confirmed_start_at: null,
    ...scheduling,
  },
});

describe('reviewed request planner', () => {
  const plan = (v2, candidates = [candidate()]) => planRescheduleFromCall({
    v2,
    call,
    customer,
    candidates,
    now: NOW,
    humanOverride: { visitId: VISIT_ID },
  });

  test('uses the explicitly selected customer visit and proposed time', () => {
    expect(plan(requestExtraction())).toMatchObject({
      action: 'apply',
      visitId: VISIT_ID,
      newDate: '2099-09-10',
      newWindow: { start: '14:00', end: '15:00' },
    });
    expect(plan(requestExtraction(), [candidate({ customer_id: 'another-customer' })]))
      .toMatchObject({ action: 'skip', reason: 'no_visit_on_books' });
  });

  test('rejects a proposal once the agent committed a booking', () => {
    expect(plan(requestExtraction({ agent_committed_booking: true })))
      .toMatchObject({ action: 'skip', reason: 'agent_committed_booking' });
  });

  test('rejects a proposal once a confirmed start supersedes it', () => {
    expect(plan(requestExtraction({ confirmed_start_at: CONFIRMED })))
      .toMatchObject({ action: 'skip', reason: 'confirmed_start_supersedes_proposal' });
  });

  test('the automatic path keeps confirmed_start_at authoritative', () => {
    const v2 = {
      ...requestExtraction({ agent_committed_booking: true, confirmed_start_at: CONFIRMED }),
      confidence: { scheduling_window: 0.99 },
      service_request: { specific_service_name: 'Quarterly Pest Control Service' },
      evidence: [{
        field_path: '/scheduling/agent_committed_booking',
        speaker: 'agent',
        quote: CONFIRMED_QUOTE,
      }],
    };
    const automaticVisit = candidate({
      service_id: 'quarterly-pest',
      service_type: 'Quarterly Pest Control Service',
      catalog_service_name: 'Quarterly Pest Control Service',
    });
    expect(planRescheduleFromCall({
      v2,
      call,
      customer,
      candidates: [automaticVisit],
      now: NOW,
      transcriptLabelsTrusted: true,
    })).toMatchObject({
      action: 'apply',
      newDate: '2099-09-11',
      newWindow: { start: '16:00', end: '17:00' },
    });
  });

  test('keeps grouped, parked no-op, and office-review visits in the editor', () => {
    expect(plan(requestExtraction(), [candidate({ visit_id: 'group' })])).toMatchObject({ reason: 'grouped_visit' });
    expect(plan(requestExtraction(), [candidate({ status: 'rescheduled', window_start: '14:00', window_end: '15:00' })]))
      .toMatchObject({ reason: 'visit_parked_for_rebook' });
    expect(plan(requestExtraction(), [candidate({ source_action: 'voice_agent', customer_confirmed: true })]))
      .toMatchObject({ reason: 'office_review_unconfirmed' });
  });
});

describe('shared candidate and eligibility helpers', () => {
  test('candidate loading can include the prior 60 days and exposes address state', async () => {
    const calls = [];
    const query = {
      where(...args) { calls.push(['where', ...args]); return query; },
      whereIn(...args) { calls.push(['whereIn', ...args]); return query; },
      orderBy() { return query; },
      leftJoin() { return query; },
      select(...args) { calls.push(['select', ...args]); return query; },
    };
    await loadCandidates(() => query, CUSTOMER_ID, NOW, { includePast: true });
    expect(calls).toContainEqual(['where', 'scheduled_services.scheduled_date', '>=', '2099-07-11']);
    expect(calls.find(([kind]) => kind === 'select')).toContain('scheduled_services.service_address_state');
  });

  test('human-handled lookup excludes the proposal being reviewed', async () => {
    const calls = [];
    const query = {
      where(...args) { if (typeof args[0] === 'function') args[0](query); else calls.push(['where', ...args]); return query; },
      whereIn(...args) { calls.push(['whereIn', ...args]); return query; },
      orWhere(callback) { callback(query); return query; },
      whereNot(...args) { calls.push(['whereNot', ...args]); return query; },
      first(...args) { calls.push(['first', ...args]); return Promise.resolve({ id: 'handled' }); },
    };
    await expect(humanHandledRescheduleCard(() => query, 'call-1', { excludeId: 'proposal-1' }))
      .resolves.toEqual({ id: 'handled' });
    expect(calls).toContainEqual(['whereNot', 'id', 'proposal-1']);
    expect(ACTIVITY_ACTION).toBe('call_reschedule_applied');
  });

  test('visit-group eligibility requires fewer than two open members and no freeze', async () => {
    await expect(hasUnblockedVisitGroup(null, null)).resolves.toBe(true);
    visitGroups.openMembers.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    await expect(hasUnblockedVisitGroup('conn', 'group')).resolves.toBe(false);
    expect(visitGroups.frozenVisitVerdict).not.toHaveBeenCalled();
    visitGroups.openMembers.mockResolvedValueOnce([{ id: 1 }]);
    visitGroups.frozenVisitVerdict.mockResolvedValueOnce({ frozen: true });
    await expect(hasUnblockedVisitGroup('conn', 'group')).resolves.toBe(false);
  });
});
