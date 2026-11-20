/**
 * Jest test sequencer that splits `--shard=i/n` by recorded run time.
 *
 * Jest's own sharding gives each shard the same number of files (by path
 * hash), so one shard can get most of the slow files: on 2026-11-20 the three
 * `server-unit` shards ran 342, 287 and 502 s, and the two DB-gated halves
 * 6.3 and 9.2 min (medians). Here every file goes, longest first, to the
 * shard with the least recorded time so far. Every file the run finds still
 * lands in exactly one shard, so a stale or missing time only makes the
 * shards less even; it never drops a test.
 *
 * Times come from tests/helpers/ci-shard-timings.json (refresh it with
 * server/scripts/ci-shard-timings.js). It has two maps because a DB-gated
 * suite runs for real only when DATABASE_URL is set (the `server-db` lanes)
 * and skips in under a second without it (`server-unit`).
 *
 * Used from .github/workflows/tests.yml:
 *   npx jest --shard=2/4 --testSequencer=./tests/helpers/time-balanced-sequencer.js
 */
const path = require('path');
const Sequencer = require('@jest/test-sequencer').default;
const TIMINGS = require('./ci-shard-timings.json');

const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// Longest first, each file to the least-loaded shard. Ties break by path, so
// every shard process computes the same split. Returns key -> shard (0-based).
function assignShards(entries, shardCount) {
  const loads = new Array(shardCount).fill(0);
  const shardOf = new Map();
  for (const { key, seconds } of [...entries].sort((a, b) => b.seconds - a.seconds || byKey(a, b))) {
    const shard = loads.indexOf(Math.min(...loads));
    loads[shard] += seconds;
    shardOf.set(key, shard);
  }
  return shardOf;
}

class TimeBalancedSequencer extends Sequencer {
  shard(tests, { shardIndex, shardCount }) {
    const timings = process.env.DATABASE_URL ? TIMINGS.db : TIMINGS.unit;
    const keyOf = (test) => path.relative(test.context.config.rootDir, test.path).split(path.sep).join('/');
    const shardOf = assignShards(
      tests.map((test) => ({ key: keyOf(test), seconds: timings.files[keyOf(test)] ?? timings.defaultSeconds })),
      shardCount,
    );
    return tests.filter((test) => shardOf.get(keyOf(test)) === shardIndex - 1);
  }
}

module.exports = TimeBalancedSequencer;
module.exports.assignShards = assignShards;
