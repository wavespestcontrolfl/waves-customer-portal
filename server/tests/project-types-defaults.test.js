/**
 * applyFindingsDefaults — field-level `default` values seed findings at
 * project creation. The pre-treatment certificate pre-fills Adam Benetti's
 * personal FDACS applicator ID so the compliance form starts complete.
 */
const { applyFindingsDefaults, PROJECT_TYPES } = require('../services/project-types');

describe('applyFindingsDefaults', () => {
  test('pre-treat certificate seeds the applicator FDACS ID when findings are empty', () => {
    expect(applyFindingsDefaults('pre_treatment_termite_certificate', null)).toEqual({
      applicator_fdacs_id: 'JE362022',
    });
    expect(applyFindingsDefaults('pre_treatment_termite_certificate', {})).toEqual({
      applicator_fdacs_id: 'JE362022',
    });
  });

  test('seeds blank values but never overwrites a provided ID', () => {
    expect(
      applyFindingsDefaults('pre_treatment_termite_certificate', { applicator_fdacs_id: '  ' })
    ).toEqual({ applicator_fdacs_id: 'JE362022' });
    expect(
      applyFindingsDefaults('pre_treatment_termite_certificate', { applicator_fdacs_id: 'JF999999' })
    ).toEqual({ applicator_fdacs_id: 'JF999999' });
  });

  test('preserves unrelated findings and does not mutate the input', () => {
    const input = { treatment_method: 'Soil barrier (chemical)' };
    const out = applyFindingsDefaults('pre_treatment_termite_certificate', input);
    expect(out).toEqual({
      treatment_method: 'Soil barrier (chemical)',
      applicator_fdacs_id: 'JE362022',
    });
    expect(input).toEqual({ treatment_method: 'Soil barrier (chemical)' });
  });

  test('types without defaults (and unknown types) pass findings through unchanged', () => {
    expect(applyFindingsDefaults('pest_inspection', { notes: 'x' })).toEqual({ notes: 'x' });
    expect(applyFindingsDefaults('not_a_type', null)).toEqual({});
  });

  test('the FDACS ID default is registered on the certificate field definition', () => {
    const field = PROJECT_TYPES.pre_treatment_termite_certificate.findingsFields
      .find((f) => f.key === 'applicator_fdacs_id');
    expect(field.default).toBe('JE362022');
  });
});
