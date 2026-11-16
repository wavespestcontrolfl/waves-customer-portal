'use strict';

// The Lock Screen visit card's rules (services/visit-live-activity.js): which stop a visit belongs to, what
// a stop shows, when a card may start, and what a live card must do next. All pure, so no database and no
// Apple request. The card's whole life against real tables is visit-live-activity-postgres.test.js.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The tracker's customer-facing state, as track-transitions.customerTrackState derives it. (The real module
// loads the whole messaging stack; the Postgres suite runs the real one.)
jest.mock('../services/track-transitions', () => ({
  customerTrackState: (row) => {
    if (row.status === 'no_show') return 'no_show';
    if (row.status === 'cancelled' || row.status === 'skipped') return 'cancelled';
    if (row.status === 'completed') return 'complete';
    return row.track_state || null;
  },
}));

const db = require('../models/db');
const card = require('../services/visit-live-activity');

const NOW = new Date('2026-11-12T15:00:00.000Z');
const minutesAgo = (n) => new Date(NOW.getTime() - n * 60 * 1000);
const ALLOWED = '11111111-1111-4111-8111-111111111111';

const visit = (over = {}) => ({
  id: 'v1', customer_id: 'c1', property_id: 'p1', technician_id: 't1', day: '2026-11-12',
  status: 'confirmed', track_state: 'scheduled', en_route_at: null, arrived_at: null, completed_at: null,
  service_type: 'Pest Control', ...over,
});
const onTheWay = (over = {}) => visit({ status: 'en_route', track_state: 'en_route', en_route_at: minutesAgo(5), ...over });
const arrived = (over = {}) => visit({ status: 'on_site', track_state: 'on_property', en_route_at: minutesAgo(20), arrived_at: minutesAgo(8), ...over });
const finished = (over = {}) => visit({ status: 'completed', track_state: 'complete', en_route_at: minutesAgo(70), arrived_at: minutesAgo(55), completed_at: minutesAgo(2), ...over });

afterEach(() => {
  delete process.env.GATE_VISIT_LIVE_ACTIVITY;
  delete process.env.VISIT_LIVE_ACTIVITY_CUSTOMER_ALLOWLIST;
  db.mockReset();
});

describe('the stop a visit belongs to', () => {
  test('customer, saved address, ET day and technician: the rule of the on-the-way text', () => {
    const a = card.stopOf(visit({ id: 'v1' }));
    const b = card.stopOf(visit({ id: 'v2', service_type: 'Lawn Care' }));
    expect(a.key).toBe('stop:c1:p1:2026-11-12:t1');
    expect(b.key).toBe(a.key);
    expect(card.stopOf(visit({ technician_id: 't2' })).key).not.toBe(a.key);
    expect(card.stopOf(visit({ day: '2026-11-13' })).key).not.toBe(a.key);
    expect(card.stopOf(visit({ technician_id: null })).key).toBe('stop:c1:p1:2026-11-12:none');
  });

  test('a visit with no saved address is its own stop', () => {
    expect(card.stopOf(visit({ id: 'v1', property_id: null })).key).toBe('visit:v1');
    expect(card.stopOf(visit({ id: 'v2', property_id: null })).key).toBe('visit:v2');
  });
});

describe('what a stop shows', () => {
  test('nothing while no visit is on the way or on the property', () => {
    expect(card.viewOf([visit()])).toBeNull();
    expect(card.viewOf([])).toBeNull();
  });

  test('on the way, since the technician set off', () => {
    const v = onTheWay();
    expect(card.viewOf([v])).toEqual({ phase: 'en_route', visits: [v], since: v.en_route_at });
  });

  test('arrived, since the arrival', () => {
    const v = arrived();
    expect(card.viewOf([v])).toEqual({ phase: 'on_property', visits: [v], since: v.arrived_at });
  });

  test('complete only for a visit the card showed', () => {
    const v = finished();
    expect(card.viewOf([v], [])).toBeNull();
    expect(card.viewOf([v], ['v1'])).toEqual({ phase: 'complete', visits: [v], since: v.completed_at });
  });

  test('a cancelled, skipped or no-show visit shows nothing, whatever its tracker state says', () => {
    for (const status of ['cancelled', 'skipped', 'no_show']) {
      expect(card.viewOf([onTheWay({ status })], ['v1'])).toBeNull();
    }
  });

  test('a completed status counts before the tracker stamps its completion time', () => {
    const v = arrived({ status: 'completed' });
    expect(card.viewOf([v], ['v1'])).toEqual({ phase: 'complete', visits: [v], since: null });
  });

  test('one visit finished while another is still open reads as arrived, never back to on the way', () => {
    const first = finished({ id: 'v1' });
    const second = onTheWay({ id: 'v2', en_route_at: minutesAgo(70) });
    const view = card.viewOf([first, second], ['v1', 'v2']);
    expect(view.phase).toBe('on_property');
    expect(view.visits).toEqual([first, second]);
    expect(view.since).toEqual(first.arrived_at);
  });

  test('all the stop\'s visits finished: complete, at the last completion', () => {
    const first = finished({ id: 'v1', completed_at: minutesAgo(30) });
    const second = finished({ id: 'v2', completed_at: minutesAgo(1) });
    expect(card.viewOf([first, second], ['v1', 'v2'])).toEqual({ phase: 'complete', visits: [first, second], since: second.completed_at });
  });

  test('a morning visit that is long finished does not make the afternoon visit read as arrived', () => {
    const morning = finished({ id: 'v1' });
    const afternoon = onTheWay({ id: 'v2' });
    expect(card.viewOf([morning, afternoon], [])).toEqual({ phase: 'en_route', visits: [afternoon], since: afternoon.en_route_at });
  });
});

describe('when a card may start', () => {
  const stop = card.stopOf(onTheWay());

  test('for a visit on the way or just arrived, inside the first 20 minutes of that step', () => {
    expect(card.startRefusal(stop, card.viewOf([onTheWay()]), NOW)).toBeNull();
    expect(card.startRefusal(stop, card.viewOf([arrived()]), NOW)).toBeNull();
    expect(card.startRefusal(stop, card.viewOf([onTheWay({ en_route_at: minutesAgo(20) })]), NOW)).toBeNull();
    expect(card.startRefusal(stop, card.viewOf([onTheWay({ en_route_at: minutesAgo(21) })]), NOW)).toBe('too_late');
  });

  test('never for a visit that is not live, is already complete, or has no step time', () => {
    expect(card.startRefusal(stop, null, NOW)).toBe('visit_not_live');
    expect(card.startRefusal(stop, card.viewOf([finished()], ['v1']), NOW)).toBe('visit_not_live');
    expect(card.startRefusal(stop, card.viewOf([onTheWay({ en_route_at: null })]), NOW)).toBe('no_step_time');
  });

  test('the customer allowlist only narrows: unset = everyone, set = those customers, a typo = nobody', () => {
    const view = card.viewOf([onTheWay()]);
    const stopFor = (customerId) => ({ ...stop, customerId });
    process.env.VISIT_LIVE_ACTIVITY_CUSTOMER_ALLOWLIST = ALLOWED;
    expect(card.startRefusal(stopFor(ALLOWED.toUpperCase()), view, NOW)).toBeNull();
    expect(card.startRefusal(stopFor('22222222-2222-4222-8222-222222222222'), view, NOW)).toBe('not_on_the_list');
    process.env.VISIT_LIVE_ACTIVITY_CUSTOMER_ALLOWLIST = 'not-an-id';
    expect(card.startRefusal(stopFor(ALLOWED), view, NOW)).toBe('not_on_the_list');
  });
});

describe('what a live card does next', () => {
  const session = { phase: 'en_route', phase_since: minutesAgo(5), started_at: minutesAgo(5), created_at: minutesAgo(5) };

  test('on the way: shown, stale after 45 minutes, taken down after 90', () => {
    const fresh = card.targetOf(card.viewOf([onTheWay()]), session, NOW);
    expect(fresh).toEqual({ kind: 'show', since: minutesAgo(5), staleAt: new Date(minutesAgo(5).getTime() + card.STALE_AFTER_MS.en_route) });
    expect(card.STALE_AFTER_MS.en_route).toBe(45 * 60 * 1000);
    expect(card.targetOf(card.viewOf([onTheWay({ en_route_at: minutesAgo(89) })]), session, NOW).kind).toBe('show');
    expect(card.targetOf(card.viewOf([onTheWay({ en_route_at: minutesAgo(90) })]), session, NOW)).toEqual({ kind: 'end', reason: 'time_limit', dismissAt: NOW });
  });

  test('arrived: stale after 2 hours, taken down after 3', () => {
    const view = card.viewOf([arrived({ arrived_at: minutesAgo(119) })]);
    expect(card.targetOf(view, session, NOW).staleAt).toEqual(new Date(minutesAgo(119).getTime() + 120 * 60 * 1000));
    expect(card.targetOf(card.viewOf([arrived({ arrived_at: minutesAgo(180) })]), session, NOW)).toEqual({ kind: 'end', reason: 'time_limit', dismissAt: NOW });
  });

  test('complete: the card ends and stays on the Lock Screen 15 minutes', () => {
    const target = card.targetOf(card.viewOf([finished()], ['v1']), session, NOW);
    expect(target).toEqual({ kind: 'end', reason: 'complete', dismissAt: new Date(NOW.getTime() + 15 * 60 * 1000) });
  });

  test('a visit that is no longer live (cancelled, moved, rewound) takes the card down at once', () => {
    expect(card.targetOf(null, session, NOW)).toEqual({ kind: 'end', reason: 'visit_not_live', dismissAt: NOW });
  });

  test('gate off, or a customer no longer on the allowlist, takes the card down at once', () => {
    const view = card.viewOf([onTheWay()]);
    expect(card.targetOf(view, session, NOW, { live: false })).toEqual({ kind: 'end', reason: 'gate_off', dismissAt: NOW });
    expect(card.targetOf(view, session, NOW, { allowed: false })).toEqual({ kind: 'end', reason: 'not_on_the_list', dismissAt: NOW });
  });

  test('a step with no time of its own is timed from what the card already holds for that step', () => {
    const noStamp = card.viewOf([arrived({ arrived_at: null })]);
    const held = { phase: 'on_property', phase_since: minutesAgo(30), started_at: minutesAgo(50), created_at: minutesAgo(50) };
    expect(card.targetOf(noStamp, held, NOW).since).toEqual(minutesAgo(30));
    // The card holds a time for another step: fall back to when the card started.
    expect(card.targetOf(noStamp, { ...held, phase: 'en_route' }, NOW).since).toEqual(minutesAgo(50));
  });
});

describe('poke', () => {
  test('gate off: reads nothing, schedules nothing, never throws', async () => {
    expect(() => card.poke('v1')).not.toThrow();
    expect(() => card.poke(undefined)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(db).not.toHaveBeenCalled();
  });

  test('gate on: a failed sync is logged and swallowed', async () => {
    process.env.GATE_VISIT_LIVE_ACTIVITY = 'true';
    db.mockImplementation(() => { throw new Error('database is away'); });
    expect(() => card.poke('v1')).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(require('../services/logger').warn).toHaveBeenCalledWith(expect.stringContaining('sync failed for visit v1'));
  });
});
