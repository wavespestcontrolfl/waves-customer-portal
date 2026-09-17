const { callSideBlockForEstimateData, estimateOffCustomerSurface } = require('../utils/estimate-claim-sql');
const { proposalExpiry, groupLinkViewableThrough } = require('./proposal-bid');

function parseEstimateData(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return typeof value === 'object' ? value : null;
}

// A marker names only the most recent publisher. Every eligible delivered
// token remains an entry link, including one whose own offer has expired.
async function publishedGroupLinks(database, estimate, { lock = false } = {}) {
  if (!estimate?.estimate_group_id) return [];
  let query = database('estimates')
    .where({ estimate_group_id: estimate.estimate_group_id })
    .whereNull('archived_at')
    .whereIn('status', ['sent', 'viewed', 'expired']);
  if (lock) query = query.forUpdate();
  const rows = await query.select();
  const published = [];
  for (const candidate of Array.isArray(rows) ? rows : []) {
    if (!(candidate.sent_at || candidate.viewed_at)
      || candidate.disposition === 'expired_unsent'
      || candidate.price_locked_at
      || estimateOffCustomerSurface(candidate)) continue;
    // The public reader uses the same durable call-side verdict. An
    // estimate-side quarantine marker may be absent after a failed write.
    if (await callSideBlockForEstimateData(database, parseEstimateData(candidate.estimate_data))) continue;
    published.push(candidate);
  }
  return published;
}

function publishedOfferExpiry(row) {
  const fixed = proposalExpiry(row);
  if (fixed) return fixed;
  const expiry = row.expires_at ? new Date(row.expires_at) : null;
  return expiry && !Number.isNaN(expiry.getTime()) ? expiry : null;
}

// Called inside the SAME transaction as publication, reconciliation or a
// recovery read. Promise sources are published offer expiries, never another
// link's prior navigation floor; each link still keeps its own older promise.
async function extendPublishedGroupLinks(trx, estimate, links = null) {
  const published = links || await publishedGroupLinks(trx, estimate, { lock: true });
  const through = published.map(publishedOfferExpiry)
    .filter(Boolean).reduce((latest, at) => (!latest || at > latest ? at : latest), null);
  for (const link of published) {
    const promised = groupLinkViewableThrough(link);
    if (through && (!promised || through > promised)) {
      await trx('estimates').where({ id: link.id, estimate_group_id: estimate.estimate_group_id }).update({
        estimate_data: trx.raw("COALESCE(estimate_data, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ groupLinkViewableThrough: through.toISOString() })]),
        updated_at: trx.fn.now(),
      });
    }
  }
}

// A call can be temporarily reprocessing when a different group member is
// delivered. Once it settles cleanly, a public read of an expired entry
// token can backfill the missed promise. Recheck under the same group lock
// as publication; blocked calls neither source nor receive grants. Return
// the current anchor even when there is no future offer, so the caller can
// apply its ordinary 404 deadline rule to the fresh row.
async function refreshExpiredGroupNavigation(database, estimate) {
  if (!estimate?.id || !estimate?.token || !estimate?.estimate_group_id) return null;
  return database.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['estimate-group-send', String(estimate.estimate_group_id)]);
    const anchor = await trx('estimates')
      .where({ id: estimate.id, token: estimate.token, estimate_group_id: estimate.estimate_group_id })
      .forUpdate().first();
    if (!anchor) return null;
    const links = await publishedGroupLinks(trx, anchor, { lock: true });
    if (!links.some((link) => String(link.id) === String(anchor.id))) return null;
    const futureOffer = links.map(publishedOfferExpiry).filter(Boolean)
      .some((expiry) => expiry > new Date());
    if (futureOffer) await extendPublishedGroupLinks(trx, anchor, links);
    return trx('estimates').where({ id: anchor.id, estimate_group_id: anchor.estimate_group_id }).first();
  });
}

module.exports = { publishedGroupLinks, publishedOfferExpiry, extendPublishedGroupLinks, refreshExpiredGroupNavigation };
