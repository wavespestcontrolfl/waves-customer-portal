/**
 * estimates.use_v2_view — Stage 2 of the React-estimate rollout (PR B.2).
 *
 * Stage 1 (migration 20260423000002) shipped the column default=false: every
 * estimate served the legacy server-rendered HTML until admin/IB flipped it
 * on per-estimate via the toggle_estimate_v2_view IB tool. That validation is
 * done, so Stage 2 makes the React redesign the default for NEW estimates.
 *
 * This flips the column DEFAULT to true. It deliberately does NOT touch
 * existing rows:
 *   - Every current estimate keeps its stored value, so anything still at
 *     false stays on the HTML page (as the Stage-1 docstring promised:
 *     "Existing rows with v2=false stay HTML").
 *   - Every newly-created estimate that doesn't set the column (all six
 *     insert paths rely on the default) is born with use_v2_view=true and
 *     renders in React.
 *
 * The per-estimate override still wins both ways — the IB tool can force a
 * specific quote back to HTML (false) or on to React (true). The gate in
 * routes/estimate-public.js is unchanged; it already routes
 * use_v2_view===true to the SPA. Stage 3 (backfill existing rows + remove the
 * HTML path) remains a separate future PR.
 *
 * Raw ALTER ... SET DEFAULT (not knex .alter()) so this only changes the
 * default for future inserts: no column rewrite, no nullability change, and
 * existing row values are left exactly as they are.
 */
exports.up = async function (knex) {
  await knex.raw('ALTER TABLE estimates ALTER COLUMN use_v2_view SET DEFAULT true');
};

exports.down = async function (knex) {
  await knex.raw('ALTER TABLE estimates ALTER COLUMN use_v2_view SET DEFAULT false');
};
