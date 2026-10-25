// Bid Desk checklist line -> Bid kit paper map (shared/bid-checklist-kit-map.cjs). Pure data, no database: every mapped
// line exists in the checklist templates, and every mapped kit key exists in the kit catalog.
const { CHECKLIST_KIT_MAP, REFERENCE_TARGET, lineKey, kitKeysForLine } = require('../../shared/bid-checklist-kit-map.cjs');
const { templateRows, TEMPLATE_TYPES } = require('../../shared/bid-checklist-templates.cjs');
const { ITEM_BY_KEY } = require('../../shared/bid-kit-catalog.cjs');

const allTemplateKeys = () => new Set(['other', ...TEMPLATE_TYPES].flatMap((type) => templateRows(type).map((row) => row.template_key)));

describe('checklist kit map', () => {
  test('every mapped line key is a line in the checklist templates', () => {
    const lines = new Set([...allTemplateKeys()].map(lineKey));
    for (const key of Object.keys(CHECKLIST_KIT_MAP)) expect([key, lines.has(key)]).toEqual([key, true]);
  });

  test('every mapped kit key is a kit catalog item', () => {
    for (const [line, keys] of Object.entries(CHECKLIST_KIT_MAP)) {
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) expect([line, key, Boolean(ITEM_BY_KEY[key])]).toEqual([line, key, true]);
    }
  });

  test('a bid\'s template_key (section.key) and a bare key both resolve; typed and unmapped lines resolve to nothing', () => {
    expect(kitKeysForLine('itb.business_license')).toEqual(['business_license_copy']);
    expect(kitKeysForLine('base.licenses')).toEqual(['business_license_copy', 'cpco_certificate', 'sunbiz_status', 'business_tax_receipt']);
    expect(kitKeysForLine('business_license')).toEqual(['business_license_copy']);
    expect(kitKeysForLine('base.signer')).toEqual([]);
    expect(kitKeysForLine('rfp.criteria_pages')).toEqual([]);
    expect(kitKeysForLine(null)).toEqual([]);
    expect(kitKeysForLine('')).toEqual([]);
    expect(kitKeysForLine('constructor')).toEqual([]);
    expect(kitKeysForLine('base.toString')).toEqual([]);
  });

  test('the lines the owner asked for are mapped, and the full-time statement is the kit\'s per-bid notarized paper', () => {
    expect(kitKeysForLine('itb.operator_statement')).toEqual(['cpco_fulltime_statement']);
    expect(ITEM_BY_KEY.cpco_fulltime_statement.notarized).toBe(true);
    for (const key of ['references', 'references_form', 'reference_surveys', 'reference_rules', 'past_performance']) expect(CHECKLIST_KIT_MAP[key]).toEqual(['reference']);
    expect(CHECKLIST_KIT_MAP.reps_certs).toEqual(['sam_uei', 'cage_code']);
    expect(REFERENCE_TARGET).toBe(3);
  });
});
