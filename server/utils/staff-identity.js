const MAX_STAFF_EMAIL_LENGTH = 150;

function canonicalStaffEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (
    !email
    || email.length > MAX_STAFF_EMAIL_LENGTH
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return null;
  }
  return email;
}

module.exports = {
  MAX_STAFF_EMAIL_LENGTH,
  canonicalStaffEmail,
};
