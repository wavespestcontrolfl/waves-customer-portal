/**
 * estimates.use_v2_view — Stage 3 of the React-estimate rollout (scoped backfill).
 *
 * Stage 1 (20260423000002) added the column with default=false.
 * Stage 2 (20260626000001) flipped the column DEFAULT to true so NEW estimates
 * render in the React view, but left existing rows untouched.
 *
 * Stage 3 (this migration) backfills existing rows to true so the React redesign
 * is the default for existing estimates too — EXCEPT the two legacy categories
 * the React page (client/src/pages/EstimateViewPage.jsx) cannot recap as
 * faithfully as the legacy server-HTML renderer, which would degrade what a
 * customer sees when reopening an old link:
 *
 *   1. Accepted estimates predating the accepted_service_mode / accepted_frequency_key
 *      columns (added 20260626000002). React gates its accepted price/service recap
 *      on `acceptedServiceMode` being present (EstimateViewPage.jsx ~2694); for these
 *      legacy rows it's NULL, so the agreed services/pricing recap disappears.
 *      Predicate: status = 'accepted' AND accepted_service_mode IS NULL.
 *
 *   2. Quote-required / commercial-proposal estimates. The React data endpoint
 *      returns canAccept:false / terminalState:'quote_required' for these, and the
 *      React !canAccept branch returns after TerminalStateCard WITHOUT the quote /
 *      proposal detail cards the legacy HTML still shows. Detected with the same
 *      signals routes/estimate-public.js#resolveEstimateQuoteRequirement(null, estData)
 *      uses: a persisted 'quote_required' status, an authored commercial proposal
 *      (estData.proposal.enabled), an unresolved manager approval (reused via the
 *      pure estimate-delivery-options helper), or any one-time item flagged
 *      quoteRequired / requiresCustomQuote (mirrors normalizeOneTimeBreakdown).
 *
 * Excluded rows keep the legacy HTML renderer (the render gate in
 * handleEstimateView already routes use_v2_view=false to it), which renders both
 * categories fully. New estimates remain React-by-default via the Stage 2 default,
 * so the redesign is still the go-forward default everywhere.
 *
 * down() is a no-op: the pre-backfill per-row values are not recoverable.
 */
const {
  estimateDataHasUnresolvedManagerApproval,
} = require('../../services/estimate-delivery-options');

function parseEstimateData(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// Mirrors routes/estimate-public.js#normalizeOneTimeBreakdown's quote-required
// item detection (item.quoteRequired / item.requiresCustomQuote) across the same
// arrays it scans — result.oneTime.items and result.results.oneTime.items.
function hasQuoteRequiredOneTimeItem(estData) {
  const result = estData?.result && typeof estData.result === 'object'
    ? estData.result
    : (estData?.engineResult && typeof estData.engineResult === 'object' ? estData.engineResult : null);
  if (!result) return false;
  const arrays = [];
  if (result.oneTime && Array.isArray(result.oneTime.items)) arrays.push(result.oneTime.items);
  if (result.results?.oneTime && Array.isArray(result.results.oneTime.items)) arrays.push(result.results.oneTime.items);
  return arrays.some((list) => list.some(
    (item) => item && (item.quoteRequired === true || item.requiresCustomQuote === true),
  ));
}

// TRUE when the React view would show a degraded recap vs. the legacy HTML, so the
// row should stay on the HTML renderer (NOT be flipped to use_v2_view=true).
function reactCannotFaithfullyRecap(row, estData) {
  // P1 — accepted before accepted_service_mode was stored.
  if (row.status === 'accepted' && !row.accepted_service_mode) return true;
  // P2 — quote-required / commercial-proposal.
  if (row.status === 'quote_required') return true;
  if (estData?.proposal?.enabled === true) return true;
  if (estimateDataHasUnresolvedManagerApproval(estData)) return true;
  if (hasQuoteRequiredOneTimeItem(estData)) return true;
  return false;
}

exports.up = async function up(knex) {
  const columns = await knex('estimates').columnInfo();
  if (!columns.use_v2_view) return;
  const hasAcceptedServiceMode = !!columns.accepted_service_mode;

  const rows = await knex('estimates')
    .select(
      'id',
      'status',
      'estimate_data',
      ...(hasAcceptedServiceMode ? ['accepted_service_mode'] : []),
    )
    .whereRaw('use_v2_view IS DISTINCT FROM true');

  const flipIds = [];
  for (const row of rows) {
    const estData = parseEstimateData(row.estimate_data);
    if (reactCannotFaithfullyRecap(row, estData)) continue;
    flipIds.push(row.id);
  }

  // Chunked so a large estimates table doesn't build one oversized IN list.
  const CHUNK = 500;
  for (let i = 0; i < flipIds.length; i += CHUNK) {
    const batch = flipIds.slice(i, i + CHUNK);
    await knex('estimates')
      .whereIn('id', batch)
      .whereRaw('use_v2_view IS DISTINCT FROM true')
      .update({ use_v2_view: true });
  }
};

exports.down = async function down() {
  // No-op — prior per-row values are not recoverable. See docstring.
};
