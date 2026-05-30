const {
  normalizeChecklist,
  missingRequiredTasks,
} = require('../services/lawn-protocol-completion');

describe('lawn protocol completion', () => {
  test('normalizes required checklist tasks and reports missing required items', () => {
    const checklist = normalizeChecklist({
      checklist: {
        chinch_float_test: true,
        irrigation_audit: { completed: false, note: 'Dry edge near driveway' },
      },
    }, ['chinch_float_test', 'irrigation_audit', 'problem_photos']);

    expect(checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'chinch_float_test', completed: true }),
      expect.objectContaining({ key: 'irrigation_audit', completed: false, note: 'Dry edge near driveway' }),
      expect.objectContaining({ key: 'problem_photos', completed: false }),
    ]));

    expect(missingRequiredTasks(checklist, ['chinch_float_test', 'irrigation_audit', 'problem_photos']))
      .toEqual([
        { key: 'irrigation_audit', label: 'irrigation audit' },
        { key: 'problem_photos', label: 'problem photos' },
      ]);
  });
});
