const {
  MIN_STAFF_PASSWORD_LENGTH,
  MAX_STAFF_PASSWORD_BYTES,
  MAX_STAFF_PASSWORD_LENGTH,
  validateStaffPassword,
} = require('../utils/staff-password-policy');

describe('staff password policy', () => {
  test('requires a string within the supported length', () => {
    expect(validateStaffPassword(null)).toBe('New password is required');
    expect(validateStaffPassword('A1!short')).toContain(`${MIN_STAFF_PASSWORD_LENGTH}`);
    expect(validateStaffPassword(`Aa1!${'x'.repeat(MAX_STAFF_PASSWORD_LENGTH)}`)).toContain(`${MAX_STAFF_PASSWORD_LENGTH}`);
  });

  test('rejects input bcrypt would silently truncate after 72 UTF-8 bytes', () => {
    expect(validateStaffPassword(`Aa1!${'x'.repeat(MAX_STAFF_PASSWORD_BYTES - 4)}`)).toBeNull();
    expect(validateStaffPassword(`Aa1!${'é'.repeat(35)}`)).toContain(`${MAX_STAFF_PASSWORD_BYTES} UTF-8 bytes`);
  });

  test('requires at least three character categories', () => {
    expect(validateStaffPassword('alllowercaseletters')).toMatch(/three/i);
    expect(validateStaffPassword('lowercaseand1234')).toMatch(/three/i);
  });

  test('accepts long passphrases with three character categories', () => {
    expect(validateStaffPassword('Ocean-waves-are-7-feet')).toBeNull();
  });
});
