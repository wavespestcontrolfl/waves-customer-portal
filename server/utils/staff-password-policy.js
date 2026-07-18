const MIN_STAFF_PASSWORD_LENGTH = 12;
const MAX_STAFF_PASSWORD_LENGTH = 128;
// bcrypt truncates input after 72 bytes. Reject longer UTF-8 input instead of
// accepting two visibly different passwords that verify as the same secret.
const MAX_STAFF_PASSWORD_BYTES = 72;
// Detection only. This repository-known bootstrap credential must never be
// accepted for a staff login or assigned to an account again.
const RETIRED_LEGACY_STAFF_PASSWORD = 'waves2026';

function isRetiredLegacyStaffPassword(password) {
  return password === RETIRED_LEGACY_STAFF_PASSWORD;
}

function validateStaffPassword(password) {
  if (typeof password !== 'string') {
    return 'New password is required';
  }
  if (password.length < MIN_STAFF_PASSWORD_LENGTH) {
    return `New password must be at least ${MIN_STAFF_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_STAFF_PASSWORD_LENGTH) {
    return `New password must be ${MAX_STAFF_PASSWORD_LENGTH} characters or fewer`;
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_STAFF_PASSWORD_BYTES) {
    return `New password must be ${MAX_STAFF_PASSWORD_BYTES} UTF-8 bytes or fewer`;
  }

  const categories = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;
  if (categories < 3) {
    return 'New password must include at least three of: lowercase, uppercase, number, symbol';
  }
  return null;
}

module.exports = {
  MIN_STAFF_PASSWORD_LENGTH,
  MAX_STAFF_PASSWORD_BYTES,
  MAX_STAFF_PASSWORD_LENGTH,
  RETIRED_LEGACY_STAFF_PASSWORD,
  isRetiredLegacyStaffPassword,
  validateStaffPassword,
};
