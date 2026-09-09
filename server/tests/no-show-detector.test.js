jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { evaluateNoShow, latestPromises } = require('../services/no-show-detector');
const { replay } = require('../../ops/agents/replay-no-show-detector');

describe('missing tracking stages', () => {
  const promise = { visit_id: 'visit', start_at: '2026-09-10T09:00:00-04:00', communicated_at: '2026-09-09T12:00:00-04:00', source: 'message' };
  const visit = { id: 'visit', status: 'pending', scheduled_date: '2026-09-10' };
  const at = (time, extra = {}) => evaluateNoShow({ visit: { ...visit, ...extra }, promise, now: new Date(`2026-09-10T${time}:00-04:00`) });
  test('45 minutes warns; an en-route stamp stops stage 1 but cannot stop stage 2', () => {
    expect(at('09:44')).toBeNull();
    expect(at('09:45')?.stage).toBe(1);
    expect(at('09:45', { en_route_at: '2026-09-10T09:30:00-04:00' })).toBeNull();
    expect(at('11:30', { en_route_at: '2026-09-10T09:30:00-04:00' })).toMatchObject({ stage: 2, evidence: 'missing_tracking' });
  });
  test('a later arrival is not used in the past, but an observed arrival clears the card', () => {
    const stamps = { arrived_at: '2026-09-10T11:40:00-04:00' };
    expect(at('11:30', stamps)?.stage).toBe(2);
    expect(at('11:45', stamps)).toBeNull();
    expect(at('11:30', { arrived_at: '2026-09-09T09:30:00-04:00' })?.stage).toBe(2);
  });
  test('an internal move cannot reset the old promised window', () => {
    expect(at('11:30', { scheduled_date: '2026-09-12', window_start: '14:00' })?.stage).toBe(2);
    expect(at('11:30', { status: 'completed' })).toBeNull();
  });
  test('a newer unknown communication window cannot be replaced by an older known one', () => {
    const map = latestPromises([promise, { ...promise, start_at: null, communicated_at: '2026-09-10T08:00:00-04:00' }], new Date('2026-09-10T12:00:00-04:00'));
    expect(map.get('visit').start_at).toBeNull();
  });
  test('replay reconstructs state before a later completion and compares both thresholds', () => {
    const report = replay({ synthetic: true, from: '2026-09-01T00:00:00Z', to: '2026-09-11T00:00:00Z', visits: [{
      id: 'visit', initial: visit, promises: [promise], events: [{ at: '2026-09-10T12:00:00-04:00', patch: { status: 'completed' } }],
      outcome: 'late', complaint_at: '2026-09-10T11:40:00-04:00',
    }] });
    expect(report.thresholds.map((r) => [r.stage1_minutes, r.stage1_alerts, r.stage2_alerts, r.before_complaint])).toEqual([[45, 1, 1, 2], [60, 1, 1, 2]]);
  });
});
