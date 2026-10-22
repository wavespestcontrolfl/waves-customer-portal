/**
 * GATE_NEWSLETTER_CLICK_BOUND (security audit run 2, 2026-10-22): the
 * newsletter event-click redirect only honours an event URL for a real
 * delivery whose send carries that event; anything else goes home.
 */

jest.mock('../models/db', () => ({}));
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const {
  recordEventClick,
  eventRedirectWithoutRecording,
} = require('../services/newsletter-event-clicks');

const HOME = 'https://www.wavespestcontrol.com/';
const LOCKED = '11111111-1111-4111-8111-111111111111';
const ALT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const TOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOPE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function fakeKnex({ deliveries = {}, sends = {}, events = {}, failInsert = false, failMembership = false } = {}) {
  const inserts = [];
  const tables = {
    events_raw: (where) => events[where.id] || undefined,
    newsletter_send_deliveries: (where) => {
      if (failMembership) throw new Error('db down');
      return deliveries[where.engagement_token] || undefined;
    },
    newsletter_sends: (where) => sends[where.id] || undefined,
  };
  const knex = (table) => {
    let where = {};
    const q = {
      where(w) { where = w; return q; },
      first: async () => (tables[table] ? tables[table](where) : undefined),
      insert(row) { inserts.push({ table, row }); return q; },
      onConflict() { return q; },
      ignore: async () => { if (failInsert) throw new Error('insert failed'); },
    };
    return q;
  };
  knex.inserts = inserts;
  return knex;
}

function world(opts = {}) {
  return fakeKnex({
    ...opts,
    deliveries: { [TOK]: { id: 'd1', send_id: 's1' } },
    sends: { s1: { event_ids: JSON.stringify([LOCKED]), alternate_event_ids: JSON.stringify([ALT]) } },
    events: {
      [LOCKED]: { id: LOCKED, event_url: 'https://venue.example/locked' },
      [ALT]: { id: ALT, event_url: 'https://venue.example/alt' },
      [OTHER]: { id: OTHER, event_url: 'https://elsewhere.example/x' },
    },
  });
}

afterEach(() => { delete process.env.GATE_NEWSLETTER_CLICK_BOUND; });

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_NEWSLETTER_CLICK_BOUND = 'true'; });

  test('locked event on a real delivery: records and redirects to the event', async () => {
    const knex = world();
    const r = await recordEventClick({ engagementToken: TOK, eventId: LOCKED, userAgent: 'Mozilla/5.0' }, knex);
    expect(r).toEqual({ redirectUrl: 'https://venue.example/locked', recorded: true });
    expect(knex.inserts).toHaveLength(1);
  });

  test('alternate event on a real delivery: redirects, not recorded', async () => {
    const r = await recordEventClick({ engagementToken: TOK, eventId: ALT, userAgent: 'Mozilla/5.0' }, world());
    expect(r).toEqual({ redirectUrl: 'https://venue.example/alt', recorded: false });
  });

  test('event outside the send lineup goes home', async () => {
    const r = await recordEventClick({ engagementToken: TOK, eventId: OTHER, userAgent: 'Mozilla/5.0' }, world());
    expect(r).toEqual({ redirectUrl: HOME, recorded: false });
  });

  test('unknown token goes home', async () => {
    const r = await recordEventClick({ engagementToken: NOPE, eventId: LOCKED, userAgent: 'Mozilla/5.0' }, world());
    expect(r).toEqual({ redirectUrl: HOME, recorded: false });
  });

  test('verified member still reaches the event when the click write fails', async () => {
    const r = await recordEventClick({ engagementToken: TOK, eventId: LOCKED, userAgent: 'Mozilla/5.0' }, world({ failInsert: true }));
    expect(r).toEqual({ redirectUrl: 'https://venue.example/locked', recorded: false });
  });

  test('a failed membership lookup goes home', async () => {
    const knex = world({ failMembership: true });
    const r = await recordEventClick({ engagementToken: TOK, eventId: LOCKED, userAgent: 'Mozilla/5.0' }, knex);
    expect(r).toEqual({ redirectUrl: HOME, recorded: false });
    await expect(eventRedirectWithoutRecording({ engagementToken: TOK, eventId: LOCKED }, knex)).resolves.toBe(HOME);
  });

  test('a token that is not a uuid goes home with no query at all', async () => {
    const knex = jest.fn(() => { throw new Error('no query expected'); });
    await expect(eventRedirectWithoutRecording({ engagementToken: 'junk', eventId: LOCKED }, knex)).resolves.toBe(HOME);
  });

  test('over-budget path applies the same binding', async () => {
    const knex = world();
    await expect(eventRedirectWithoutRecording({ engagementToken: TOK, eventId: LOCKED }, knex))
      .resolves.toBe('https://venue.example/locked');
    await expect(eventRedirectWithoutRecording({ engagementToken: TOK, eventId: OTHER }, knex)).resolves.toBe(HOME);
    await expect(eventRedirectWithoutRecording({ engagementToken: NOPE, eventId: LOCKED }, knex)).resolves.toBe(HOME);
  });
});

describe('gate off (unchanged behaviour)', () => {
  test('unknown token still redirects to the event URL', async () => {
    const r = await recordEventClick({ engagementToken: NOPE, eventId: OTHER, userAgent: 'Mozilla/5.0' }, world());
    expect(r).toEqual({ redirectUrl: 'https://elsewhere.example/x', recorded: false });
  });

  test('over-budget path returns the event URL', async () => {
    await expect(eventRedirectWithoutRecording({ engagementToken: NOPE, eventId: OTHER }, world()))
      .resolves.toBe('https://elsewhere.example/x');
  });

  test('unknown event goes home in both states', async () => {
    const r = await recordEventClick({ engagementToken: TOK, eventId: '44444444-4444-4444-8444-444444444444' }, world());
    expect(r).toEqual({ redirectUrl: HOME, recorded: false });
  });
});
