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

// The staff row that holds a canonical email, or undefined. `excludeId` leaves one row out (the row being edited).
async function findStaffByCanonicalEmail(connection, email, excludeId) {
  if (!email) return null;
  let query = connection('technicians')
    .whereNotNull('email')
    .whereRaw('LOWER(BTRIM(email)) = ?', [email]);
  if (excludeId) query = query.whereNot('id', excludeId);
  return query.first('id');
}

// The staff row a sign-in address belongs to: its staff email (password sign-in), or its linked Google address
// (staff-google-signin.js reads that column the same way). For a caller that must not give a new row an address
// some staff member already signs in with.
async function findStaffByLoginEmail(connection, email) {
  if (!email) return null;
  return (await findStaffByCanonicalEmail(connection, email))
    || connection('technicians').whereRaw('LOWER(google_email) = ?', [email]).first('id');
}

// The staff table is small and identity mutations are rare. Serialize them to
// make canonical-email uniqueness and last-admin checks race-safe.
async function lockStaffIdentityWrites(trx) {
  await trx.raw('LOCK TABLE technicians IN SHARE ROW EXCLUSIVE MODE');
}

module.exports = {
  MAX_STAFF_EMAIL_LENGTH,
  canonicalStaffEmail,
  findStaffByCanonicalEmail,
  findStaffByLoginEmail,
  lockStaffIdentityWrites,
};
