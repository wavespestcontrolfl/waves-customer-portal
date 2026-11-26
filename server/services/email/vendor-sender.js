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

// The bare lowercase mailbox ("Name <a@x.com>" -> "a@x.com"), or ''.
function senderMailbox(address) {
  const m = String(address || '').toLowerCase().match(/([^\s<>"]+@[^\s<>"]+)/);
  return m ? m[1].replace(/\.$/, '') : '';
}

// Registrable domain of the sender ("Name <a@mail.x.com>" -> "x.com"), or null.
function registrableSenderDomain(address) {
  const mailbox = senderMailbox(address);
  if (!mailbox) return null;
  const reg = psl.get(mailbox.slice(mailbox.lastIndexOf('@') + 1));
  // Only plain hostname characters ever reach a LIKE pattern below.
  return reg && /^[a-z0-9.-]+$/.test(reg) ? reg : null;
}

// Vendor registry: the exact mailbox, then the domain and its parents (the
// invoice processor's own keys, so a per-company billing address such as
// siteoneus@billtrust.com counts), plus any listed subdomain of a
// vendor-owned registrable domain. A shared provider (gmail.com, …) matches
// only by its exact mailbox.
async function registryHasSender(mailbox, reg, shared) {
  const { senderVendorKeys } = require('./invoice-processor');
  const keys = shared ? [mailbox] : senderVendorKeys(mailbox);
  const row = await db('vendor_email_domains')
    .where((qb) => {
      qb.whereIn('domain', keys);
      if (!shared) qb.orWhere('domain', 'like', `%.${reg}`);
    })
    .first('id');
  return !!row;
}

// Earlier vendor mail from this sender. On a shared provider only the same
// mailbox counts; otherwise any mailbox on the registrable domain.
// strict (spam-block path): only a booked expense (expense_created /
// expense_duplicate) is evidence; a classifier label or a rejected invoice
// (invoice_detected:unauthenticated, …) is not.
async function historyHasSender(email, mailbox, reg, shared, strict) {
  const q = db('emails');
  if (shared) {
    q.whereRaw('(lower(from_address) = ? OR lower(from_address) LIKE ?)', [mailbox, `%<${mailbox}>`]);
  } else {
    q.whereRaw(
      '(lower(from_address) LIKE ? OR lower(from_address) LIKE ? OR lower(from_address) LIKE ? OR lower(from_address) LIKE ?)',
      [`%@${reg}`, `%@${reg}>`, `%.${reg}`, `%.${reg}>`],
    );
  }
  if (strict) {
    q.where('auto_action', 'like', 'expense\\_%');
  } else {
    q.where((qb) => qb
      .whereIn('classification', VENDOR_CLASSIFICATIONS)
      .orWhere('auto_action', 'like', 'expense\\_%')
      .orWhere('auto_action', 'like', 'invoice\\_%'));
  }
  if (email.id != null) q.whereNot('id', email.id);
  return !!(await q.first('id'));
}

/**
 * Is this sender a vendor we use? The fixed list first (no query), then the
 * vendor registry, then one LIMIT 1 lookup for earlier vendor mail. The
 * email's own row never vouches for itself.
 *
 * Unsubscribe path (default): a failed lookup answers true — keeping a promo
 * subscription is the safe side.
 * Spam-block path ({ strict: true }): history needs a booked expense, and a
 * failed lookup THROWS, so settleDeferredBlock keeps the row pending and
 * retries instead of marking the block done.
 */
async function isVendorWeUse(email, { strict = false } = {}) {
  const mailbox = senderMailbox(email && email.from_address);
  const reg = registrableSenderDomain(mailbox);
  if (!reg) return false;
  if (KEEP_PROMO_DOMAINS.includes(reg)) return true;
  const shared = require('./spam-blocker').isProtectedDomain(mailbox.slice(mailbox.lastIndexOf('@') + 1));
  try {
    if (await registryHasSender(mailbox, reg, shared)) return true;
    return await historyHasSender(email, mailbox, reg, shared, strict);
  } catch (err) {
    if (strict) throw err;
    logger.warn(`[vendor-sender] lookup failed, keeping the sender: ${err.message}`);
    return true;
  }
}

module.exports = { isVendorWeUse, registrableSenderDomain, senderMailbox, KEEP_PROMO_DOMAINS };
