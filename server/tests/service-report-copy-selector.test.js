const { selectReportCopyPrompt } = require('../services/service-report/lawn-report-copy-prompt');

const shared = `# Shared writer
## HARD CONSTRAINTS
Keep provenance and never invent an observation.
## ANTI-TEMPLATE RULES
Old examples and unrelated service guidance.`;

describe('service-specific main report writer selection', () => {
  test.each([
    ['Every 6 Weeks Lawn Care Service', 'LAWN v5', 'LAWN'],
    ['Quarterly Pest Control Service', 'RECURRING PEST v1', 'PEST'],
    ['Monthly Pest Control Service', 'RECURRING PEST v1', 'PEST'],
    ['General Pest Control', 'RECURRING PEST v1', 'PEST'],
    ['Bi-Monthly Tree & Shrub Care Service', 'TREE AND SHRUB v1', 'TREE'],
    ['Palm Care Service', 'TREE AND SHRUB v1', 'TREE'],
  ])('selects the main adapter for %s', (serviceType, title, lane) => {
    const prompt = selectReportCopyPrompt(shared, serviceType);
    expect(prompt).toContain(title);
    expect(prompt).toContain('Keep provenance');
    expect(prompt).toContain('WHAT WE DID');
    expect(prompt).toContain('WHAT WE FOUND');
    expect(prompt).not.toContain('Old examples');
    expect(prompt).not.toContain('Return JSON only');
    expect(prompt).not.toContain('exactly these top-level keys');
    if (lane === 'TREE') expect(prompt).toContain('root injection');
    if (lane === 'PEST') expect(prompt).toContain('other labeled crawling pests');
  });

  test.each(['WDO Inspection', 'Pre-Slab Termite Treatment'])('excludes compliance documents from the AI writer for %s', (serviceType) => {
    expect(selectReportCopyPrompt(shared, serviceType)).toBeNull();
  });

  test.each(['Rodent Control', 'Mosquito Control', 'Bed Bug Treatment', 'Unknown Specialty'])('does not guess a specialty writer from %s', (serviceType) => {
    expect(selectReportCopyPrompt(shared, serviceType)).toBeNull();
  });

  test.each([
    ['mosquito_monthly', 'MOSQUITO'],
    ['rodent_trapping', 'RODENT TRAPPING'],
    ['cockroach_control', 'COCKROACH'],
    ['termite_liquid', 'TERMITE LIQUID'],
    ['palm_injection', 'PALM-SPECIFIC'],
    ['dethatching', 'PHYSICAL'],
  ])('canonical %s overrides a stale general-pest display label', (serviceKey, module) => {
    const prompt = selectReportCopyPrompt(shared, 'Quarterly Pest Control Service', { serviceKey });
    expect(prompt).toContain(`SERVICE MODULE — ${module}`);
    expect(prompt).toContain('WHAT WE DID');
    expect(prompt).not.toContain('RECURRING PEST v1');
    expect(prompt.match(/SERVICE MODULE — /g)).toHaveLength(1);
  });

  test('canonical lawn/tree/general-pest identities preserve dedicated writers', () => {
    for (const [serviceKey, version] of [['pest_initial_cleanout', 'RECURRING PEST v1'], ['lawn_care_6week', 'LAWN v5'], ['tree_shrub_program', 'TREE AND SHRUB v1'], ['pest_general_monthly', 'RECURRING PEST v1']]) {
      expect(selectReportCopyPrompt(shared, 'Old label', { serviceKey })).toContain(version);
    }
  });

  test('dedicated profile identities reject conflicts and preserve their exact supported schemas', () => {
    for (const context of [
      { serviceKey: 'lawn_care_one_time', findingsType: 'cockroach' },
      { serviceKey: 'tree_shrub_program', findingsType: null },
      { serviceKey: 'pest_general_monthly', findingsType: 'rodent_trapping' },
      { requireCanonical: true, findingsType: 'bogus' },
      { serviceKey: 'wdo_inspection' }, { serviceKey: 'termite_slab_pretreat' },
    ]) expect(selectReportCopyPrompt(shared, 'General Pest Control', context)).toBeNull();
    expect(selectReportCopyPrompt(shared, 'Old label', { serviceKey: 'lawn_care_one_time', findingsType: 'one_time_lawn_treatment' })).toContain('LAWN v5');
    expect(selectReportCopyPrompt(shared, 'Old label', { serviceKey: 'tree_shrub_program', findingsType: 'tree_shrub' })).toContain('TREE AND SHRUB v1');
    expect(selectReportCopyPrompt(shared, 'Old label', { serviceKey: 'pest_initial_cleanout', findingsType: null })).toContain('RECURRING PEST v1');
  });

  test('the established typed pretreatment report keeps its existing writer without opening the certificate lane', () => {
    expect(selectReportCopyPrompt(shared, 'Termite Pretreatment Service', { serviceKey: 'termite_pretreatment', findingsType: 'termite_treatment' })).toBe(shared);
    expect(selectReportCopyPrompt(shared, 'Termite Pretreatment Service', { serviceKey: 'termite_pretreatment' })).toBeNull();
    expect(selectReportCopyPrompt(shared, 'Termite Pretreatment Service', { serviceKey: 'termite_pretreatment', findingsType: null })).toBeNull();
    expect(selectReportCopyPrompt(shared, 'Termite Pretreatment Service', { serviceKey: 'termite_pretreatment', findingsType: 'termite_bait_station' })).toBeNull();
  });

  test.each([['pest_rodent_quarterly', 'RECURRING PEST v1'], ['pest_termite_bait_quarterly', 'RECURRING PEST v1'], ['lawn_tree_shrub_combo', 'LAWN v5']])(
    'retired combined key %s preserves its prescribed recurring fallback', (serviceKey, title) => {
      expect(selectReportCopyPrompt(shared, 'Old combined label', { serviceKey, findingsType: null })).toContain(title);
      expect(selectReportCopyPrompt(shared, 'Old combined label', { serviceKey, findingsType: 'rodent_trapping' })).toBeNull();
    },
  );

  test('unknown or conflicting canonical identity never receives the legacy success prompt', () => {
    expect(selectReportCopyPrompt(shared, 'General Pest Control', { requireCanonical: true })).toBeNull();
    expect(selectReportCopyPrompt(shared, 'General Pest Control', { serviceKey: 'unknown' })).toBeNull();
    expect(selectReportCopyPrompt(shared, 'Pre-treatment', { serviceKey: 'unknown' })).toBeNull();
    expect(selectReportCopyPrompt(shared, 'Fire ant', { serviceKey: 'fire_ant', findingsType: 'flea' })).toBeNull();
  });
});
