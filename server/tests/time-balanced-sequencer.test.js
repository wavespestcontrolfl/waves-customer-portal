/**
 * The CI shards (`server-unit`, `server-db`) split test files by recorded time
 * with tests/helpers/time-balanced-sequencer.js. A sharding bug would drop or
 * repeat test files silently: CI would still read green with fewer tests run.
 * These cases pin that every real test file lands in exactly one shard, that
 * every shard process computes the same split, and that the split is balanced.
 */
const fs = require('fs');
const path = require('path');
const TimeBalancedSequencer = require('./helpers/time-balanced-sequencer');
const TIMINGS = require('./helpers/ci-shard-timings.json');

const { assignShards } = TimeBalancedSequencer;
const SERVER_ROOT = path.join(__dirname, '..');

const realTests = () => fs.readdirSync(__dirname)
  .filter((name) => name.endsWith('.test.js'))
  .map((name) => ({ path: path.join(__dirname, name), context: { config: { rootDir: SERVER_ROOT } } }));

function shardAll(tests, shardCount) {
  const sequencer = new TimeBalancedSequencer();
  return Array.from({ length: shardCount }, (_, i) => sequencer.shard(tests, { shardIndex: i + 1, shardCount }));
}

describe('time-balanced CI sharding', () => {
  const savedUrl = process.env.DATABASE_URL;
  afterEach(() => {
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
  });

  test.each([
    ['unit lanes (no DATABASE_URL)', undefined],
    ['DB-gated lanes (DATABASE_URL set)', 'postgresql://ci/waves_test'],
  ])('%s: every test file lands in exactly one of 4 shards', (_label, url) => {
    if (url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = url;
    const tests = realTests();
    const shards = shardAll(tests, 4);
    const placed = shards.flat().map((t) => t.path);
    expect(placed).toHaveLength(tests.length);
    expect(new Set(placed).size).toBe(tests.length);
    expect(shards.every((s) => s.length > 0)).toBe(true);
  });

  test('every shard process computes the same split, whatever order Jest lists the files in', () => {
    delete process.env.DATABASE_URL;
    const tests = realTests();
    const forward = shardAll(tests, 4).map((s) => s.map((t) => t.path).sort());
    const reversed = shardAll([...tests].reverse(), 4).map((s) => s.map((t) => t.path).sort());
    expect(reversed).toEqual(forward);
  });

  test('DATABASE_URL selects the DB timings, where DB-gated suites run for real', () => {
    process.env.DATABASE_URL = 'postgresql://ci/waves_test';
    const tests = realTests();
    const key = (t) => path.relative(SERVER_ROOT, t.path);
    const expected = assignShards(
      tests.map((t) => ({ key: key(t), seconds: TIMINGS.db.files[key(t)] ?? TIMINGS.db.defaultSeconds })),
      4,
    );
    shardAll(tests, 4).forEach((shard, i) => {
      for (const t of shard) expect(expected.get(key(t))).toBe(i);
    });
  });

  test('loads differ by no more than the largest single file', () => {
    const entries = [{ key: 'a', seconds: 76 }, { key: 'b', seconds: 40 }, { key: 'c', seconds: 39 },
      ...Array.from({ length: 200 }, (_, i) => ({ key: `f${i}`, seconds: (i % 7) + 0.5 }))];
    const shardOf = assignShards(entries, 4);
    const loads = [0, 0, 0, 0];
    for (const e of entries) loads[shardOf.get(e.key)] += e.seconds;
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(76);
  });
});
