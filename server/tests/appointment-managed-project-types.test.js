jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  appointmentManagedProjectTypes,
  serializeProfile,
  V1_EXCLUDED_PROJECT_TYPES,
  PROJECT_CREATION_KEPT_TYPES,
} = require('../services/service-completion-profiles');

function makeKnex({ rows = [], backedRows = [], hasTable = true, throwOnQuery = false } = {}) {
  // The helper now runs two distinct() queries — project_required rows
  // (still-backed types) first, then service_report rows. Discriminate on
  // the captured where() mode so each query gets its own row set.
  const knex = jest.fn(() => {
    let mode = null;
    const chain = {
      where: jest.fn((args) => {
        if (args && args.completion_mode) mode = args.completion_mode;
        return chain;
      }),
      whereNotNull: jest.fn(() => chain),
      whereNotIn: jest.fn(() => chain),
      distinct: jest.fn(async () => {
        if (throwOnQuery) throw new Error('boom');
        return mode === 'project_required' ? backedRows : rows;
      }),
    };
    return chain;
  });
  knex.schema = { hasTable: jest.fn(async () => hasTable) };
  return knex;
}

describe('appointmentManagedProjectTypes', () => {
  test('returns the set of project types with active service_report profiles', async () => {
    const knex = makeKnex({
      rows: [{ project_type: 'cockroach' }, { project_type: 'bed_bug' }, { project_type: null }],
    });
    const managed = await appointmentManagedProjectTypes(knex);
    expect(managed).toEqual(new Set(['cockroach', 'bed_bug']));
  });

  test('pre-cutover (no flipped rows) is an empty set — Projects creation unchanged', async () => {
    const managed = await appointmentManagedProjectTypes(makeKnex({ rows: [] }));
    expect(managed.size).toBe(0);
  });

  test('fails open to empty set when the table is missing or the query errors', async () => {
    expect((await appointmentManagedProjectTypes(makeKnex({ hasTable: false }))).size).toBe(0);
    expect((await appointmentManagedProjectTypes(makeKnex({ throwOnQuery: true }))).size).toBe(0);
  });

  // Phase-1b shadow flips ONE rodent key while sibling rodent services stay
  // project_required — the type is only partially cut over, so ad hoc rodent
  // project creation must stay available (linked creation is independently
  // guarded by the linked service's profile).
  test('partially-cutover types (some keys still project_required) are not managed', async () => {
    const knex = makeKnex({
      rows: [{ project_type: 'rodent_trapping' }, { project_type: 'cockroach' }],
      backedRows: [{ project_type: 'rodent_trapping' }],
    });
    const managed = await appointmentManagedProjectTypes(knex);
    expect(managed).toEqual(new Set(['cockroach']));
  });

  // Owner directive 2026-07-04: flea + rodent trapping stay in the Create
  // Project Report picker as standalone documentation projects even though
  // their routine appointment completions fully cut over to the typed
  // service-report flow. Creation-only exemption — no profile coercion.
  test('creation-kept types (flea, rodent trapping) never become appointment-managed', async () => {
    const knex = makeKnex({
      rows: [{ project_type: 'flea' }, { project_type: 'rodent_trapping' }, { project_type: 'cockroach' }],
    });
    const managed = await appointmentManagedProjectTypes(knex);
    expect(managed).toEqual(new Set(['cockroach']));
    expect(PROJECT_CREATION_KEPT_TYPES.has('flea')).toBe(true);
    expect(PROJECT_CREATION_KEPT_TYPES.has('rodent_trapping')).toBe(true);
  });

  // Unlike the V1 exclusion, the creation-kept exemption must NOT coerce the
  // profile: routine flea/rodent appointments keep completing through the
  // typed service-report flow.
  test('creation-kept types keep their service_report profiles uncoerced', () => {
    const profile = serializeProfile({
      service_key: 'flea_service',
      completion_mode: 'service_report',
      project_type: 'flea',
      active: true,
    });
    expect(profile.completionMode).toBe('service_report');
  });

  // wdo_inspection completion is compliance machinery (licensee e-signature
  // gate, signed FDACS-13645 PDF, archived filings) that the generic V1 flow
  // does not perform — a flipped profile row (one bad cutover-migration WHERE
  // clause) must not be able to route it through V1. Code-enforced, not data.
  test('V1-excluded types never become appointment-managed, even with a flipped row', async () => {
    const knex = makeKnex({
      rows: [{ project_type: 'wdo_inspection' }, { project_type: 'cockroach' }],
    });
    const managed = await appointmentManagedProjectTypes(knex);
    expect(managed).toEqual(new Set(['cockroach']));
    expect(V1_EXCLUDED_PROJECT_TYPES.has('wdo_inspection')).toBe(true);
  });
});

describe('serializeProfile V1 exclusion coercion', () => {
  test('a service_report profile for an excluded type is coerced back to special_project', () => {
    const profile = serializeProfile({
      service_key: 'wdo_inspection_svc',
      completion_mode: 'service_report',
      project_type: 'wdo_inspection',
      active: true,
    });
    expect(profile.completionMode).toBe('special_project');
    expect(profile.specialProject).toBe(true);
    expect(profile.projectBacked).toBe(true);
    expect(profile.requiresProject).toBe(true);
    // The project-flow pointer survives; the typed-findings pointer must not.
    expect(profile.projectType).toBe('wdo_inspection');
    expect(profile.findingsType).toBe(null);
  });

  test('coercion resets behavior fields from the flagged row to conservative defaults', () => {
    const profile = serializeProfile({
      service_key: 'wdo_inspection_svc',
      completion_mode: 'service_report',
      project_type: 'wdo_inspection',
      creates_service_record: false,
      portal_visibility: 'hidden',
      portal_attach_policy: 'always',
      followup_policy: 'auto',
      default_followup_days: 14,
      delivery_mode: 'review_first',
      active: true,
    });
    // A flagged row is not half-trusted: identity survives, behavior resets
    // FAIL-CLOSED — portal policy matches the seeded WDO special-project
    // posture (token_only + recurring_customer), not the broader
    // customer_portal registry defaults.
    expect(profile.completionMode).toBe('special_project');
    expect(profile.createsServiceRecord).toBe(true);
    expect(profile.portalVisibility).toBe('token_only');
    expect(profile.portalAttachPolicy).toBe('recurring_customer');
    expect(profile.followupPolicy).toBe('none');
    expect(profile.defaultFollowupDays).toBe(null);
    expect(profile.deliveryMode).toBe('auto_send');
    expect(profile.serviceKey).toBe('wdo_inspection_svc');
  });

  test('non-excluded service_report profiles are untouched', () => {
    const profile = serializeProfile({
      service_key: 'cockroach_svc',
      completion_mode: 'service_report',
      project_type: 'cockroach',
      active: true,
    });
    expect(profile.completionMode).toBe('service_report');
    expect(profile.findingsType).toBe('cockroach');
    expect(profile.projectType).toBe(null);
  });

  test('the legitimate WDO special_project profile is untouched', () => {
    const profile = serializeProfile({
      service_key: 'wdo_inspection_svc',
      completion_mode: 'special_project',
      project_type: 'wdo_inspection',
      active: true,
    });
    expect(profile.completionMode).toBe('special_project');
    expect(profile.projectType).toBe('wdo_inspection');
  });
});
