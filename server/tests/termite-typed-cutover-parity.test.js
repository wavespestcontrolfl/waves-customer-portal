/**
 * Termite typed cutover — field-parity contract (owner directive
 * 2026-07-13: the fields carried over from the Jobs/project report to the
 * typed completion must be EXACT and the same).
 *
 * Static, no DB. Pins:
 *  1. The cutover (20260713100000) is MODE-ONLY: each key flips onto the
 *     exact project_type pointer its Create Project Report flow used
 *     (20260521000005 seeds) — the mechanism that guarantees parity.
 *  2. The served typed-completion schema (findingsSchemaForType — the same
 *     slice the dispatch payload embeds for CompletionPanel) is
 *     field-for-field identical to PROJECT_TYPES[type].findingsFields —
 *     the schema the Jobs form + Create Project Report modal render — for
 *     every flipped service key: same keys, same order, same labels, input
 *     types, sections, options, placeholders, requiredUnless and internal
 *     flags. A future TYPE_MODULE_SECTIONS rule or slice edit that
 *     diverges the two surfaces fails here.
 *  3. The Phase-3 compliance fields (#2703) stay present and enforced on
 *     the typed path.
 *  4. The registry classifies the post-flip shape as healthy typed and the
 *     pre-flip shape as a loud defect, so an environment where the
 *     migration loud-skipped surfaces in the coverage audit instead of
 *     hiding.
 */
const { CUTOVERS } = require('../models/migrations/20260713100000_termite_typed_cutover');
const { PROJECT_TYPES } = require('../services/project-types');
const {
  findingsSchemaForType,
  REQUIRED_FINDINGS_FIELDS,
} = require('../services/service-report/activity-indicators');
const {
  ALL_LISTS,
  classifyCatalogRow,
} = require('../config/completion-lane-registry');

// The exact Jobs-flow shapes seeded by 20260521000005: trenching + liquid
// were special_project, the rest project_required; pointers unchanged by
// the flip.
const EXPECTED_TARGETS = {
  termite_inspection: { fromMode: 'project_required', toType: 'termite_inspection' },
  termite_spot_treatment: { fromMode: 'project_required', toType: 'termite_treatment' },
  termite_pretreatment: { fromMode: 'project_required', toType: 'termite_treatment' },
  termite_trenching: { fromMode: 'special_project', toType: 'termite_treatment' },
  termite_liquid: { fromMode: 'special_project', toType: 'termite_treatment' },
};

// One projection for both sides of the comparison. The served slice adds a
// derived `required` flag on top of these — asserted separately against
// REQUIRED_FINDINGS_FIELDS.
const fieldShape = (f) => ({
  key: f.key,
  label: f.label,
  type: f.type,
  section: f.section || null,
  options: f.options || null,
  placeholder: f.placeholder || null,
  requiredUnless: f.requiredUnless || null,
  internal: !!f.internal,
});

describe('termite typed cutover — field parity contract', () => {
  test('cutover is mode-only onto the exact Jobs-flow pointers', () => {
    const actual = Object.fromEntries(
      CUTOVERS.map((c) => [c.key, { fromMode: c.fromMode, toType: c.toType }]),
    );
    expect(actual).toEqual(EXPECTED_TARGETS);
    // acceptedTypes === [toType] on every key: the pointer going in is the
    // pointer coming out — no repoints hiding inside the flip.
    for (const c of CUTOVERS) {
      expect(c.acceptedTypes).toEqual([c.toType]);
    }
  });

  test('typed completion serves the full Jobs-form field list, field for field, for every flipped key', () => {
    for (const c of CUTOVERS) {
      const served = findingsSchemaForType(c.toType, { serviceKey: c.key });
      expect(served).not.toBeNull();
      expect(served.type).toBe(c.toType);
      const source = PROJECT_TYPES[c.toType].findingsFields;
      // Same fields, same order, same rendering inputs — the "exact and
      // the same" contract.
      expect(served.fields.map(fieldShape)).toEqual(source.map(fieldShape));
    }
  });

  test('served required flags mirror REQUIRED_FINDINGS_FIELDS exactly', () => {
    for (const type of ['termite_inspection', 'termite_treatment']) {
      const served = findingsSchemaForType(type, { serviceKey: `x_${type}` });
      expect(served.requiredFields).toEqual(REQUIRED_FINDINGS_FIELDS[type]);
      for (const f of served.fields) {
        expect(f.required).toBe(REQUIRED_FINDINGS_FIELDS[type].includes(f.key));
      }
    }
  });

  test('Phase-3 compliance fields stay present and enforced (#2703)', () => {
    // FS 482.226 — inspection report content.
    expect(REQUIRED_FINDINGS_FIELDS.termite_inspection)
      .toEqual(expect.arrayContaining(['areas_not_inspected', 'inspection_notice_affixed']));
    // FAC 5E-14 / FS 482.2265 — application-record detail + posted notice.
    expect(REQUIRED_FINDINGS_FIELDS.termite_treatment)
      .toEqual(expect.arrayContaining(['epa_registration', 'posted_notice']));
    // percent_solution is conditionally required (liquid-dilution methods
    // only) — the requiredUnless metadata must survive into the served
    // slice so the tech form mirrors the server gate.
    const served = findingsSchemaForType('termite_treatment', { serviceKey: 'termite_liquid' });
    const percent = served.fields.find((f) => f.key === 'percent_solution');
    expect(percent).toBeDefined();
    expect(percent.requiredUnless).toEqual(
      expect.objectContaining({ field: 'treatment_method' }),
    );
  });

  test('flipped keys are unlisted; post-flip is healthy typed; pre-flip is a loud defect', () => {
    for (const c of CUTOVERS) {
      for (const [list, keys] of Object.entries(ALL_LISTS)) {
        expect(keys.includes(c.key) ? `${c.key} still listed in ${list}` : null).toBeNull();
      }
      const after = classifyCatalogRow({
        service_key: c.key,
        billing_type: 'one_time',
        completion_mode: 'service_report',
        project_type: c.toType,
        delivery_mode: 'auto_send',
        profile_active: true,
      });
      expect(after.lane).toBe('typed');
      expect(after.flags).toEqual([]);
      // An environment where the migration loud-skipped keeps the project
      // shape — now an unlisted straggler the coverage audit must flag.
      const before = classifyCatalogRow({
        service_key: c.key,
        billing_type: 'one_time',
        completion_mode: c.fromMode,
        project_type: c.toType,
        delivery_mode: 'auto_send',
        profile_active: true,
      });
      expect(before.lane).toBe('legacy_project');
      expect(before.flags).toContain('unlisted_project_flow:straggler_needs_cutover_or_registry_decision');
    }
  });
});
