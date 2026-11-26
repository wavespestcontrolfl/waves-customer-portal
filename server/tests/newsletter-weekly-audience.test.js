/**
 * The weekly events email's first-readers step (services/newsletter-weekly-audience.js): the
 * first 3 sent issues go to warm readers only, then everyone; the phase is recorded on the send;
 * a warm issue carries its own reader list; the sender refuses a weekly issue with no phase.
 * The database and the warm query are mocked; the real warm SQL is pinned in
 * pest-insider-audience.test.js and the shared module.
 */
jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql) => ({ raw: sql }));
  return db;
});
jest.mock('../services/newsletter-subscribers', () => ({ relinkArchivedLinkedSubscribers: jest.fn() }));
jest.mock('../services/newsletter-warm-audience', () => {
  const actual = jest.requireActual('../services/newsletter-warm-audience');
  return { ...actual, warmAudienceQuery: jest.fn() };
});
jest.mock('../services/newsletter-event-selection', () => ({ isFlagshipSend: jest.fn() }));
jest.mock('../services/newsletter-sender', () => ({ reachedDelivery: jest.fn((q) => q) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const NewsletterSubscribers = require('../services/newsletter-subscribers');
const warm = require('../services/newsletter-warm-audience');
const { isFlagshipSend } = require('../services/newsletter-event-selection');
const { reachedDelivery } = require('../services/newsletter-sender');
const {
  WARM_ISSUES, PHASE_WARM, PHASE_ALL, WEEKLY_WARM_PLAN, phaseForSentWarmIssues,
  planWeeklyAudience, ensureFlagshipAudience, recordFlagshipAudience, warmPhaseNote, sentWarmIssueCount,
} = require('../services/newsletter-weekly-audience');

const FLAGSHIP = 'local-weekly-fresh-events';

// A knex stand-in: counts come from `state.sentWarm`; the update records its where/patch.
function fakeKnex(state) {
  const knex = jest.fn((table) => {
    expect(['newsletter_sends', 'newsletter_sends as s']).toContain(table);
    const q = {
      where: jest.fn((cond) => { q.cond = cond; return q; }),
      whereExists: jest.fn((build) => {
        // the delivery sub-query: select 1 from newsletter_send_deliveries as d where d.send_id = s.id
        const sub = { select: jest.fn(() => sub), from: jest.fn(() => sub), whereRaw: jest.fn(() => sub) };
        build(sub);
        q.sub = sub;
        return q;
      }),
      whereNull: jest.fn(() => q),
      count: jest.fn(() => q),
      first: jest.fn(async () => (state.patch ? state.row : { c: state.sentWarm })),
      update: jest.fn(async (patch) => { state.patch = patch; state.where = q.cond; return state.updated ?? 1; }),
    };
    return q;
  });
  knex.raw = jest.fn(() => '1');
  return knex;
}

beforeEach(() => {
  jest.clearAllMocks();
  isFlagshipSend.mockImplementation(async (send) => send?.newsletter_type === FLAGSHIP);
  reachedDelivery.mockImplementation((q) => q);
  warm.warmAudienceQuery.mockResolvedValue([
    { id: 7, email: 'a@example.com' },
    { id: 9, email: 'B@Example.com ' },
  ]);
});

describe('which phase an issue uses', () => {
  test('the first 3 sent issues go to warm readers only; the 4th goes to everyone', () => {
    expect(WARM_ISSUES).toBe(3);
    expect([0, 1, 2].map(phaseForSentWarmIssues)).toEqual([PHASE_WARM, PHASE_WARM, PHASE_WARM]);
    expect([3, 4, 10].map(phaseForSentWarmIssues)).toEqual([PHASE_ALL, PHASE_ALL, PHASE_ALL]);
  });

  test('only sent warm issues that reached a reader count: phase, status and the sender\'s reachedDelivery on the issue\'s delivery rows', async () => {
    const state = { sentWarm: '2' };
    const knex = fakeKnex(state);
    await expect(sentWarmIssueCount(knex)).resolves.toBe(2);
    const q = knex.mock.results[0].value;
    expect(q.cond).toEqual({ 's.audience_phase': 'warm', 's.status': 'sent' });
    // the existence check runs reachedDelivery over this issue's rows (d.send_id = s.id)
    expect(q.whereExists).toHaveBeenCalledTimes(1);
    expect(reachedDelivery).toHaveBeenCalledTimes(1);
    expect(reachedDelivery).toHaveBeenCalledWith(q.sub);
    expect(q.sub.from).toHaveBeenCalledWith('newsletter_send_deliveries as d');
    expect(q.sub.whereRaw).toHaveBeenCalledWith('d.send_id = s.id');
  });
});

describe('planWeeklyAudience', () => {
  test('warm phase: a reader list with one address key per reader, no holdout group', async () => {
    const knex = fakeKnex({ sentWarm: '0' });
    const asOf = new Date('2026-12-02T12:15:00Z');
    const plan = await planWeeklyAudience({ asOf, knex });
    expect(plan.phase).toBe('warm');
    expect(plan.warmReaders).toBe(2);
    expect(plan.segmentFilter.holdout).toBe(WEEKLY_WARM_PLAN);
    expect(plan.segmentFilter.subscriber_ids).toEqual([7, 9]);
    expect(Object.keys(plan.segmentFilter.address_keys)).toEqual(['7', '9']);
    // the key is trimmed and case-folded, like the sender's re-check
    expect(plan.segmentFilter.address_keys['9']).toBe(warm.addressKey('b@example.com'));
    expect(NewsletterSubscribers.relinkArchivedLinkedSubscribers).toHaveBeenCalled();
    const { since, until } = warm.warmAudienceQuery.mock.calls[0][0];
    expect(until).toBe(asOf);
    expect(asOf.getTime() - since.getTime()).toBe(90 * 24 * 60 * 60 * 1000);
  });

  test('widened phase: no segment, no warm read', async () => {
    const knex = fakeKnex({ sentWarm: '3' });
    const plan = await planWeeklyAudience({ knex });
    expect(plan).toMatchObject({ phase: 'all', segmentFilter: null, warmReaders: null, sentWarmIssues: 3 });
    expect(warm.warmAudienceQuery).not.toHaveBeenCalled();
  });

  test('no warm readers at all: an empty list, which the send path counts as zero recipients (fails closed)', async () => {
    warm.warmAudienceQuery.mockResolvedValue([]);
    const plan = await planWeeklyAudience({ knex: fakeKnex({ sentWarm: '0' }) });
    expect(plan.phase).toBe('warm');
    expect(plan.segmentFilter.subscriber_ids).toEqual([]);
  });
});

describe('ensureFlagshipAudience', () => {
  const draft = (extra = {}) => ({ id: 'send-1', newsletter_type: FLAGSHIP, status: 'draft', audience_phase: null, ...extra });

  test('records the phase and the list on a draft that has none, without touching updated_at', async () => {
    const state = { sentWarm: '1', row: { id: 'send-1', audience_phase: 'warm' } };
    const row = await ensureFlagshipAudience(draft(), { knex: fakeKnex(state) });
    expect(state.where).toEqual({ id: 'send-1', status: 'draft' });
    expect(state.patch.audience_phase).toBe('warm');
    expect(JSON.parse(state.patch.segment_filter).holdout).toBe(WEEKLY_WARM_PLAN);
    expect(state.patch).not.toHaveProperty('updated_at');
    expect(row.audience_phase).toBe('warm');
  });

  test('a send with no type that the flagship calendar links gets a phase too', async () => {
    isFlagshipSend.mockResolvedValue(true);
    const state = { sentWarm: '0', row: { id: 'send-1', audience_phase: 'warm' } };
    await ensureFlagshipAudience(draft({ newsletter_type: null }), { knex: fakeKnex(state) });
    expect(isFlagshipSend).toHaveBeenCalledWith(expect.objectContaining({ id: 'send-1', newsletter_type: null }), expect.any(Object));
    expect(state.patch.audience_phase).toBe('warm');
    expect(JSON.parse(state.patch.segment_filter).holdout).toBe(WEEKLY_WARM_PLAN);
  });

  test('the widened phase stores a null segment', async () => {
    const state = { sentWarm: '3', row: { id: 'send-1', audience_phase: 'all' } };
    await ensureFlagshipAudience(draft(), { knex: fakeKnex(state) });
    expect(state.patch).toEqual({ audience_phase: 'all', segment_filter: null });
  });

  test.each([
    ['a draft that already has a phase', draft({ audience_phase: 'all' })],
    ['a send that is not a draft', draft({ status: 'scheduled' })],
    ['a Waves Pest Insider send', draft({ newsletter_type: 'pest-insider-monthly' })],
    ['a send with no type and no calendar link', draft({ newsletter_type: null })],
  ])('leaves %s as it is', async (_label, send) => {
    const knex = fakeKnex({ sentWarm: '0' });
    await expect(ensureFlagshipAudience(send, { knex })).resolves.toBe(send);
    expect(knex).not.toHaveBeenCalled();
  });
});

describe('recordFlagshipAudience', () => {
  test('a failed plan is logged and the draft comes back untouched, never thrown', async () => {
    warm.warmAudienceQuery.mockRejectedValue(new Error('db down'));
    const send = { id: 'send-1', newsletter_type: FLAGSHIP, status: 'draft', audience_phase: null };
    await expect(recordFlagshipAudience(send, { knex: fakeKnex({ sentWarm: '0' }) })).resolves.toBe(send);
  });
});

describe('warmPhaseNote (the owner copy)', () => {
  test('names the issue number of a warm issue and says nothing for any other', async () => {
    await expect(warmPhaseNote({ audience_phase: 'warm' }, { knex: fakeKnex({ sentWarm: '1' }) }))
      .resolves.toEqual({ phase: 'warm', issueNumber: 2, of: 3 });
    await expect(warmPhaseNote({ audience_phase: 'all' }, { knex: fakeKnex({ sentWarm: '3' }) })).resolves.toBeNull();
    await expect(warmPhaseNote({ audience_phase: null }, { knex: fakeKnex({ sentWarm: '3' }) })).resolves.toBeNull();
  });
});
