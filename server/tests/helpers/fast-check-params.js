'use strict';

// Shared fast-check settings for the property tests (tests/*.property.test.js).
//
// CI uses a fixed seed, so every run checks the same generated cases and an
// unrelated PR never turns red on a new random case. To search new cases, run a
// property file with PBT_SEED set to any integer, and PBT_RUNS for a deeper
// search (default 100 cases per property). A failure prints the seed and the
// shrunk counterexample, so the same case can be replayed with that seed.
const DEFAULT_SEED = 20261104;
const DEFAULT_RUNS = 100;

function intFromEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

function fastCheckParams(overrides = {}) {
  return {
    seed: intFromEnv('PBT_SEED') ?? DEFAULT_SEED,
    numRuns: intFromEnv('PBT_RUNS') ?? DEFAULT_RUNS,
    ...overrides,
  };
}

module.exports = { fastCheckParams, DEFAULT_SEED, DEFAULT_RUNS };
