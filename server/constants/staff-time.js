// Database-enforced deployment generation for active Staff time writes.
//
// Phase A (schema preparation) uses 1. The Staff auth migration advances the
// database constraint to 2 in the same transaction that revokes sessions, and
// the Staff application commit advances this constant to 2. Older application
// generations then fail closed if they attempt to start/reopen a timer during
// Railway's pre-deploy/cutover overlap.
const ACTIVE_WRITE_GENERATION = 1;

module.exports = { ACTIVE_WRITE_GENERATION };
