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
  PROJECT_CREATION_LINKED_ONLY_TYPES,
} = require('../services/service-completion-profiles');

function makeKnex({ rows = [], backedRows = [], hasTable = true, throwOnQuery = false } = {}) {
  // The helper now runs two distinct() queries — project-backed rows
  // (whereIn project_required/special_project) first, then service_report
  // rows (where completion_mode). Discriminate on which clause captured the
  // mode so each query gets its own row set.
  const knex = jest.fn(() => {
    let mode = null;
    const chain = {
      where: jest.fn((args) => {
        if (args && args.completion_mode) mode = args.completion_mode;
        return chain;
      }),
      whereIn: jest.fn((col) => {
        if (col === 'completion_mode') mode = 'project_backed';
        return chain;
      }),
      whereNotNull: jest.fn(() => chain),
      whereNotIn: jest.fn(() => chain),
      distinct: jest.fn(async () => {
        if (throwOnQuery) throw new Error('boom');
        return mode === 'project_backed' ? backedRows : rows;
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

  test('pre-cutover (no flipped rows) still carries the code-enforced retired-untyped types', async () => {
    // bed_bug's pointer was CLEARED by the 20260731400000 untype — the type
    // must stay appointment-managed by code or /admin/projects re-exposes
    // the retired project form as a second completion lane (codex P1).
    const managed = await appointmentManagedProjectTypes(makeKnex({ rows: [] }));
    expect(managed).toEqual(new Set(['bed_bug']));
  });

  test('an ACTIVE special_project bed_bug profile also outranks the code retirement (codex P2 r11)', async () => {
    // serializeProfile treats special_project as project-backed too — a
    // drifted special_project row keeps its Projects lane like
    // project_required does.
    const managed = await appointmentManagedProjectTypes(makeKnex({
      rows: [{ project_type: 'cockroach' }],
      backedRows: [{ project_type: 'bed_bug', completion_mode: 'special_project' }],
    }));
    expect(managed).toEqual(new Set(['cockroach']));
  });

  test('an ACTIVE project_required bed_bug profile outranks the code retirement (drift-skip case)', async () => {
    // The untype migration loud-skips a drifted/project_required row — the
    // surviving profile still requires the Projects lane, so the retired
    // union must not hide it (codex P2 r7).
    const managed = await appointmentManagedProjectTypes(makeKnex({
      rows: [{ project_type: 'cockroach' }],
      backedRows: [{ project_type: 'bed_bug' }],
    }));
    expect(managed).toEqual(new Set(['cockroach']));
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
    expect(managed).toEqual(new Set(['cockroach', 'bed_bug']));
  });

  // Owner directive 2026-07-13 (supersedes 2026-07-04): the flea + rodent
  // ad-hoc documentation lanes are retired — the kept set is EMPTY, so
  // fully-typed types become appointment-managed like any other and drop
  // out of the Create Project Report picker. The exemption mechanism stays
  // for a future ruling.
  test('the creation-kept set is empty — flea and rodent trapping become appointment-managed', async () => {
    const knex = makeKnex({
      rows: [{ project_type: 'flea' }, { project_type: 'rodent_trapping' }, { project_type: 'cockroach' }],
    });
    const managed = await appointmentManagedProjectTypes(knex);
    expect(managed).toEqual(new Set(['flea', 'rodent_trapping', 'cockroach', 'bed_bug']));
    expect(PROJECT_CREATION_KEPT_TYPES.size).toBe(0);
  });

  // Retiring the ad-hoc lane must NOT coerce the profile: routine
  // flea/rodent appointments keep completing through the typed
  // service-report flow.
  test('flea profiles stay service_report — no coercion from the picker change', () => {
    const profile = serializeProfile({
      service_key: 'flea_service',
      completion_mode: 'service_report',
      project_type: 'flea',
      active: true,
    });
    expect(profile.completionMode).toBe('service_report');
  });

  // Owner ruling 2026-07-13: WDO + pre-treat certs are never done without a
  // scheduled visit — creation is linked-only (POST guard + picker flag).
  // Pinned here beside the V1 exclusion because both sets protect the same
  // compliance types, in different directions: linked-only closes ad-hoc
  // CREATION; the V1 exclusion protects COMPLETION routing.
  test('linked-only creation covers exactly the two compliance project types', () => {
    expect(PROJECT_CREATION_LINKED_ONLY_TYPES).toEqual(
      new Set(['wdo_inspection', 'pre_treatment_termite_certificate']),
    );
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
    expect(managed).toEqual(new Set(['cockroach', 'bed_bug']));
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
