const psl = require('psl');
const db = require('../../models/db');
const logger = require('../logger');

// Owner ruling 2026-11-25: "I want to subscribe to all promos for everything we
// are using: Claude, OpenAI, and wherever we buy products, software, etc."
// The inbox agent never unsubscribes from, and never auto-blocks, a vendor we
// use. This fixed list is the floor: a vendor is also anyone in
// vendor_email_domains, or anyone whose earlier mail carried a vendor
// classification or an expense/invoice action. The SiteOne maker list is
// guarded separately by isDealSenderDomain (siteone-deals-digest.js, #7956).
const KEEP_PROMO_DOMAINS = ['anthropic.com', 'claude.com', 'openai.com', 'siteone.com'];

const VENDOR_CLASSIFICATIONS = ['vendor_invoice', 'vendor_communication'];

// Registrable domain of the sender ("Name <a@mail.x.com>" -> "x.com"), or null.
function registrableSenderDomain(address) {
  const m = String(address || '').toLowerCase().match(/@([^@\s<>]+)\s*>?\s*$/);
  if (!m) return null;
  const reg = psl.get(m[1]);
  // Only plain hostname characters ever reach a LIKE pattern below.
  return reg && /^[a-z0-9.-]+$/.test(reg) ? reg : null;
}

/**
 * Is this sender a vendor we use? One cheap check per email: the fixed list
 * first (no query), then vendor_email_domains (tiny table), then one
 * LIMIT 1 lookup for an earlier vendor row in emails. `email.id` is left out
 * of that lookup so a row never vouches for itself.
 * A failed lookup answers true: keeping a promo sender is the safe side.
 *
 * `strict` (the spam-block path): history counts only money evidence — a
 * vendor_invoice row or an expense_/invoice_ action. A classifier
 * "vendor_communication" label alone is not enough to exempt a spammer
 * from the block list; it still stops an automatic unsubscribe.
 */
async function isVendorWeUse(email, { strict = false } = {}) {
  const reg = registrableSenderDomain(email && email.from_address);
  if (!reg) return false;
  if (KEEP_PROMO_DOMAINS.includes(reg)) return true;
  try {
    const vendorDomain = await db('vendor_email_domains')
      .whereRaw('(domain = ? OR domain LIKE ?)', [reg, `%.${reg}`])
      .first('id');
    if (vendorDomain) return true;

    const q = db('emails')
      .whereRaw(
        '(lower(from_address) LIKE ? OR lower(from_address) LIKE ? OR lower(from_address) LIKE ? OR lower(from_address) LIKE ?)',
        [`%@${reg}`, `%@${reg}>`, `%.${reg}`, `%.${reg}>`],
      )
      .where((qb) => qb
        .whereIn('classification', strict ? ['vendor_invoice'] : VENDOR_CLASSIFICATIONS)
        .orWhere('auto_action', 'like', 'expense\\_%')
        .orWhere('auto_action', 'like', 'invoice\\_%'));
    if (email.id != null) q.whereNot('id', email.id);
    return !!(await q.first('id'));
  } catch (err) {
    logger.warn(`[vendor-sender] lookup failed, treating sender as a vendor: ${err.message}`);
    return true;
  }
}

module.exports = { isVendorWeUse, registrableSenderDomain, KEEP_PROMO_DOMAINS };
