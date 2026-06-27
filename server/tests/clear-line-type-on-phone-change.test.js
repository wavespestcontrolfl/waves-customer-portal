const { clearLineTypeOnPhoneChange } = require('../utils/intake-normalize');

describe('clearLineTypeOnPhoneChange', () => {
  test('clears line_type when the primary phone changes to a different number', () => {
    const updates = { phone: '+19415550199' };
    clearLineTypeOnPhoneChange(updates, { phone: '+18777175476', line_type: 'landline' });
    expect(updates.line_type).toBeNull();
  });

  test('does NOT touch line_type when the phone is unchanged (just reformatted)', () => {
    const updates = { phone: '+19415550101' };
    clearLineTypeOnPhoneChange(updates, { phone: '(941) 555-0101', line_type: 'landline' });
    expect(updates).not.toHaveProperty('line_type');
  });

  test('no-op when phone is not part of the update', () => {
    const updates = { first_name: 'Taylor' };
    clearLineTypeOnPhoneChange(updates, { phone: '+19415550101', line_type: 'landline' });
    expect(updates).not.toHaveProperty('line_type');
  });

  test('no-op when there is no cached line_type to clear', () => {
    const updates = { phone: '+19415550199' };
    clearLineTypeOnPhoneChange(updates, { phone: '+18777175476', line_type: null });
    expect(updates).not.toHaveProperty('line_type');
  });

  test('clears when the phone is being removed entirely', () => {
    const updates = { phone: '' };
    clearLineTypeOnPhoneChange(updates, { phone: '+18777175476', line_type: 'mobile' });
    expect(updates.line_type).toBeNull();
  });

  test('safe when before/updates are missing', () => {
    expect(() => clearLineTypeOnPhoneChange(null, null)).not.toThrow();
    const updates = { phone: '+19415550199' };
    clearLineTypeOnPhoneChange(updates, null);
    expect(updates).not.toHaveProperty('line_type');
  });
});
