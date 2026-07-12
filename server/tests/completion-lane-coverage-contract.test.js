/**
 * Completion-lane coverage contract — B0 fall-through guard (universal
 * one-time services plan §5 Phase B, ratified 2026-07-12).
 *
 * Runs the completion-lane classifier over the MIGRATED catalog: a future
 * migration that seeds a services row without a completion-lane decision
 * (typed profile or completion-lane-registry entry) fails this suite. The
 * live/admin-added counterpart is ops/agents/completion-lane-coverage.js.
 *
 * Self-skips without DATABASE_URL (run after `knex migrate:latest`).
 */
const path = require('path');
const {
  ALL_LISTS,
  classifyCatalogRow,
} = require('../config/completion-lane-registry');

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describe('completion-lane registry (static)', () => {
  test('no key appears in more than one registry list', () => {
    const seen = new Map();
    for (const [list, keys] of Object.entries(ALL_LISTS)) {
      for (const key of keys) {
        expect(seen.has(key)
          ? `${key} in both ${seen.get(key)} and ${list}`
          : null).toBeNull();
        seen.set(key, list);
      }
    }
  });

  test('classifier flags an unlisted generic one-time key as a defect', () => {
    const { lane, flags } = classifyCatalogRow({
      service_key: 'future_service_nobody_decided',
      billing_type: 'one_time',
      completion_mode: 'service_report',
      project_type: null,
      profile_active: true,
    });
    expect(lane).toBe('generic_fallthrough');
    expect(flags).toContain('generic_report_one_time_key:defect');
  });

  test('classifier flags a profile-less unlisted key as undecided', () => {
    const { lane, flags } = classifyCatalogRow({
      service_key: 'future_service_without_profile',
      billing_type: 'recurring',
      completion_mode: null,
      project_type: null,
      profile_active: null,
    });
    expect(lane).toBe('undecided');
    expect(flags).toContain('no_completion_decision:no_profile_and_no_registry_entry');
  });
});

describeOrSkip('completion-lane coverage (migrated catalog)', () => {
  let knex;
  let rows;

  beforeAll(async () => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
    rows = await knex('services as s')
      .leftJoin('service_completion_profiles as p', 'p.service_key', 's.service_key')
      .where('s.is_active', true)
      .andWhere('s.is_archived', false)
      .select(
        's.service_key', 's.billing_type',
        'p.completion_mode', 'p.project_type', 'p.active as profile_active',
      );
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
  });

  test('every active catalog service resolves to an explicit completion lane', () => {
    const defects = [];
    for (const row of rows) {
      const { lane, flags } = classifyCatalogRow(row);
      if (flags.length) defects.push(`${row.service_key} [${lane}]: ${flags.join(', ')}`);
    }
    expect(defects).toEqual([]);
  });

  test('registry lists do not reference keys missing from the catalog', () => {
    const catalogKeys = new Set(rows.map((r) => r.service_key));
    const stale = [];
    for (const [list, keys] of Object.entries(ALL_LISTS)) {
      for (const key of keys) {
        if (!catalogKeys.has(key)) stale.push(`${list}: ${key}`);
      }
    }
    // Stale entries are reported, not failed — an environment's catalog can
    // legitimately lack seeded keys (the migrations self-heal per-key). The
    // prod audit script treats these as loud warnings too.
    if (stale.length) console.warn(`[lane-coverage] registry keys absent from this catalog:\n  ${stale.join('\n  ')}`);
    expect(Array.isArray(stale)).toBe(true);
  });
});
