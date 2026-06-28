/**
 * estimates.use_v2_view — Stage 3 of the React-estimate rollout.
 *
 * Stage 1 (20260423000002) added the column with default=false: every
 * estimate served the legacy server-rendered HTML until flipped per-estimate.
 * Stage 2 (20260626000001) flipped the column DEFAULT to true so NEW estimates
 * render in the React view, but deliberately left existing rows untouched —
 * anything created before Stage 2 stayed on the HTML page.
 *
 * Stage 3 (this migration) backfills every existing row to true so the React
 * redesign is the default for ALL estimates, not just newly-created ones.
 *
 * The render gate in routes/estimate-public.js (handleEstimateView) still keeps
 * unpublished (draft/scheduled) estimates on the legacy server-HTML renderer
 * regardless of this flag, so office staff can still preview a draft via
 * /estimate/<token> before it's sent — only PUBLISHED estimates flip to React.
 *
 * The legacy HTML path is intentionally NOT removed: it remains the fallback
 * for drafts and for any estimate explicitly toggled back to HTML via the
 * toggle_estimate_v2_view IB tool (the per-estimate override still wins).
 *
 * IS DISTINCT FROM true catches both stored `false` rows and any NULLs.
 *
 * down() is a no-op: the pre-backfill per-row values are not recoverable, and
 * reverting every estimate to HTML is not the intended rollback.
 */
exports.up = async function (knex) {
  await knex('estimates')
    .whereRaw('use_v2_view IS DISTINCT FROM true')
    .update({ use_v2_view: true });
};

exports.down = async function () {
  // No-op — prior per-row values are not recoverable. See docstring.
};
