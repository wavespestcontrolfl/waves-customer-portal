/**
 * Ring fact service (GATE_CALL_RING_FACT): the arm and fact choice, the wait route's index parser, and the
 * read-only report that counts hang-ups before the answer per arm. The report runs against a fake db.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../config/feature-gates', () => ({ callRingFactLive: jest.fn(() => false) }));

const crypto = require('crypto');
const db = require('../models/db');
const featureGates = require('../config/feature-gates');
const { FACTS } = require('../services/call-hold-script');
const ringFact = require('../services/call-ring-fact');

const sid = (n) => `CA${crypto.createHash('md5').update(String(n)).digest('hex')}`;

describe('choose', () => {
  test('deterministic: the same CallSid always gets the same arm and fact', () => {
    for (let i = 0; i < 50; i += 1) expect(ringFact.choose(sid(i))).toEqual(ringFact.choose(sid(i)));
  });

  test('about half the calls take each arm over many SIDs', () => {
    let fact = 0;
    const N = 4000;
    for (let i = 0; i < N; i += 1) if (ringFact.choose(sid(i)).arm === 'fact') fact += 1;
    expect(fact / N).toBeGreaterThan(0.46);
    expect(fact / N).toBeLessThan(0.54);
  });

  test('the fact index is a whole number 0 to 11 and every fact turns up; it does not follow the arm', () => {
    const seen = { fact: new Set(), ring: new Set() };
    for (let i = 0; i < 3000; i += 1) {
      const { arm, fact } = ringFact.choose(sid(i));
      expect(Number.isInteger(fact)).toBe(true);
      expect(fact).toBeGreaterThanOrEqual(0);
      expect(fact).toBeLessThan(FACTS.length);
      seen[arm].add(fact);
    }
    expect(FACTS).toHaveLength(12);
    expect(seen.fact.size).toBe(12);
    expect(seen.ring.size).toBe(12);
  });

  test('arm is only fact or ring, even for an empty CallSid', () => {
    expect(['fact', 'ring']).toContain(ringFact.choose('').arm);
    expect(['fact', 'ring']).toContain(ringFact.choose(undefined).arm);
  });
});

describe('parseFactIndex', () => {
  test.each([['0', 0], ['7', 7], ['11', 11], ['05', 5]])('%p -> %p', (raw, want) => expect(ringFact.parseFactIndex(raw)).toBe(want));
  test.each([undefined, null, '', '12', '99', '100', '-1', '1.5', ' 3', '1e1', 'x', 3, ['1']])('%p -> null', (raw) => expect(ringFact.parseFactIndex(raw)).toBeNull());
});

describe('live + stampFor', () => {
  test('live reads the gate at call time and is false when the reader is missing', () => {
    expect(ringFact.live()).toBe(false);
    featureGates.callRingFactLive.mockReturnValueOnce(true);
    expect(ringFact.live()).toBe(true);
  });
  test('the stamp holds the arm, the index and a time, nothing else', () => {
    expect(ringFact.stampFor({ arm: 'fact', fact: 3, extra: 'x' }, new Date('2026-11-17T12:00:00Z'))).toEqual({ arm: 'fact', fact: 3, at: '2026-11-17T12:00:00.000Z' });
  });
});

describe('ringFactReport', () => {
  function fakeDb(rows) {
    const calls = { where: [], whereRaw: [] };
    const chain = {};
    chain.whereRaw = jest.fn((...a) => { calls.whereRaw.push(a); return chain; });
    chain.where = jest.fn((...a) => { calls.where.push(a); return chain; });
    chain.select = jest.fn(() => Promise.resolve(rows));
    db.mockImplementation(() => chain);
    db.raw = jest.fn((sql) => ({ sql }));
    return calls;
  }
  const row = (arm, { accepted = false, voicemail = false, closed = false } = {}) => ({ arm, accepted, voicemail, closed });

  test('counts per arm: total, answered, voicemail, and hang-ups before any answer', async () => {
    fakeDb([
      row('fact', { accepted: true, closed: true }),
      row('fact', { voicemail: true, closed: true }),
      row('fact', { closed: true }),
      row('fact', { closed: true }),
      row('fact'),
      row('ring', { accepted: true }),
      row('ring', { accepted: true, voicemail: true }),
      row('ring', { closed: true }),
      row('ring'),
    ]);
    const report = await ringFactReport();
    expect(report.fact).toEqual({ total: 5, answered: 1, voicemail: 1, hung_up_before_answer: 2 });
    expect(report.ring).toEqual({ total: 4, answered: 2, voicemail: 0, hung_up_before_answer: 1 });
    expect(report.since).toBe('2026-11-17T00:00:00.000Z');
  });

  test('an answered call that later closed is answered, not a hang-up', async () => {
    fakeDb([row('ring', { accepted: true, closed: true })]);
    expect((await ringFactReport()).ring).toEqual({ total: 1, answered: 1, voicemail: 0, hung_up_before_answer: 0 });
  });

  test('empty window and an unknown arm', async () => {
    fakeDb([row('other', { closed: true })]);
    const report = await ringFactReport();
    expect(report.fact.total).toBe(0);
    expect(report.ring.total).toBe(0);
  });

  test('reads call_log since the date, leaves out sandbox sources, and writes nothing (the fake chain cannot write)', async () => {
    const calls = fakeDb([]);
    await ringFactReport();
    expect(db).toHaveBeenCalledWith('call_log');
    expect(calls.where).toContainEqual(['created_at', '>=', new Date('2026-11-17T00:00:00Z')]);
    const sandboxFilters = calls.whereRaw.filter(([sql]) => /<> \?/.test(sql));
    expect(sandboxFilters.length).toBe(2);
    // The fake chain has no update, insert or delete: the report would throw if it tried to write.
  });

  test('accepts an ISO string; a bad date throws', async () => {
    fakeDb([]);
    expect((await ringFact.ringFactReport({ since: '2026-11-10T00:00:00Z' })).since).toBe('2026-11-10T00:00:00.000Z');
    await expect(ringFact.ringFactReport({ since: 'nope' })).rejects.toThrow(/since/);
  });
});

function ringFactReport() {
  return ringFact.ringFactReport({ since: new Date('2026-11-17T00:00:00Z') });
}
