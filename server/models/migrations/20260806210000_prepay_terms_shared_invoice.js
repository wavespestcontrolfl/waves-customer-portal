/**
 * WITHDRAWN — permanent no-op placeholder.
 *
 * The original migration (dropped annual_prepay_terms' one-term-per-invoice
 * UNIQUE for a grouped-prepay shared invoice) shipped on the #3244 PR branch
 * and was descoped in review before merge — the code path it served was
 * removed. The Railway PR environment had already run it, and knex refuses to
 * run with a recorded migration whose file is missing, so the file stays as a
 * no-op (same pattern as 20260415000018): environments that ran the original
 * keep their row; fresh environments record a harmless no-op.
 * 20260806230000 restores the UNIQUE constraint where the original dropped it.
 */

exports.up = async function () {};
exports.down = async function () {};
