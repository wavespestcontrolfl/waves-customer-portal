// Codex #4865 r4: a group-only pest identification (the two vision models
// split on the species) has no species_slug but keeps its group in the
// contract. The admin list and tech views show staff the same group wording
// the customer sees, never "Unidentified"/a bare category.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { configFor } = require('../services/photo-assessment-create');

const groupOnlyContract = {
  identification: { slug: null, group: 'ants', category: 'insect', confidence: 'low', contested: false },
  safety: { stinging: false, venomous: false, disease_vector: false, structural_threat: false },
  urgency: 'moderate',
  service: { line: 'pest', key: 'pest', label: 'General Pest Control', inspection_required: true },
  observations: [],
  distinguishing_features: [],
  alternate_slugs: [],
};

describe('admin pest views for a group-only identification', () => {
  test('the list headline uses the group wording', () => {
    const row = { species_slug: null, category: 'insect', urgency: 'moderate', service_line: 'pest', report_contract: JSON.stringify(groupOnlyContract) };
    expect(configFor('pest').listFields(row).headline).toBe('an ant species');
  });

  test('the tech view carries the group and its label', () => {
    const view = configFor('pest').techView({}, groupOnlyContract);
    expect(view.identification).toMatchObject({ slug: null, label: 'an ant species', group: 'ants' });
  });

  test('an unmatched row with no group still falls back to its category', () => {
    const row = { species_slug: null, category: 'insect', report_contract: JSON.stringify({ identification: { slug: null, category: 'insect' } }) };
    expect(configFor('pest').listFields(row).headline).toBe('insect');
  });
});
