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

// Billing platforms send for many merchants from one domain (invoice
// processor: siteoneus@billtrust.com, Stripe invoice+statements+acct_…
// addresses). Like a shared mail provider, only the exact mailbox identifies
// a vendor there.
const BILLING_PLATFORM_DOMAINS = ['billtrust.com', 'stripe.com'];

// 'vendor' is what email-sync persists for a registry match.
const VENDOR_CLASSIFICATIONS = ['vendor', 'vendor_invoice', 'vendor_communication'];

// The bare lowercase mailbox, or ''. A display form ("Name <a@x.com>") uses
// the address inside the LAST angle brackets, never an address-like display
// name.
function senderMailbox(address) {
  const raw = String(address || '').toLowerCase();
  const bracketed = [...raw.matchAll(/<([^<>\s"]+@[^<>\s"]+)>/g)].pop();
  const m = bracketed || raw.match(/([^\s<>"]+@[^\s<>"]+)/);
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
      // Domain-only rows: a mailbox row (merchant@billing.example) never
      // vouches for its siblings.
      if (!shared) qb.orWhere((sub) => sub.where('domain', 'like', `%.${reg}`).whereNot('domain', 'like', '%@%'));
    })
    .first('id');
  return !!row;
}

// Earlier vendor mail from this sender. Scope: on a shared provider or a
// billing platform only the SAME mailbox; on a vendor-owned registrable
// domain any mailbox (receipts come from billing@, promos from offers@).
// strict (spam-block path) narrows the EVIDENCE, not the scope: only a booked
// expense (expense_created / expense_duplicate) whose expense row still
// exists. A classifier label or a rejected invoice never exempts a sender
// from the block list.
async function historyHasSender(email, mailbox, reg, shared, strict) {
  const q = db('emails');
  if (shared) {
    // Exact mailbox, bare or display form: the value must END with
    // "<mailbox>" (the real address; a quoted display name never ends the
    // field). right(), not LIKE: no character can act as a wildcard.
    const tail = `<${mailbox}>`;
    q.whereRaw('(lower(from_address) = ? OR right(lower(from_address), ?) = ?)', [mailbox, tail.length, tail]);
  } else {
    q.whereRaw(
      '(lower(from_address) LIKE ? OR lower(from_address) LIKE ? OR lower(from_address) LIKE ? OR lower(from_address) LIKE ?)',
      [`%@${reg}`, `%@${reg}>`, `%.${reg}`, `%.${reg}>`],
    );
  }
  if (strict) {
    // The expense must still exist: a deleted expense can leave the marker.
    q.where('auto_action', 'like', 'expense\\_%')
      .whereRaw('EXISTS (SELECT 1 FROM expenses WHERE expenses.id = emails.expense_id)');
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
 * Spam-block path ({ strict: true }): history needs a live booked expense, and a
 * failed lookup THROWS, so settleDeferredBlock keeps the row pending and
 * retries instead of marking the block done.
 */
async function isVendorWeUse(email, { strict = false } = {}) {
  const mailbox = senderMailbox(email && email.from_address);
  const reg = registrableSenderDomain(mailbox);
  if (!reg) return false;
  if (KEEP_PROMO_DOMAINS.includes(reg)) return true;
  const shared = BILLING_PLATFORM_DOMAINS.includes(reg)
    || require('./spam-blocker').isProtectedDomain(mailbox.slice(mailbox.lastIndexOf('@') + 1));
  try {
    if (await registryHasSender(mailbox, reg, shared)) return true;
    return await historyHasSender(email, mailbox, reg, shared, strict);
  } catch (err) {
    // Never log or rethrow err.message: a knex error can carry the bound
    // mailbox. Keep only the row id and the driver's error code.
    const code = err && err.code ? String(err.code) : 'unknown';
    if (strict) {
      const safe = new Error(`vendor lookup failed (email ${email && email.id}, code ${code})`);
      safe.code = code;
      throw safe;
    }
    logger.warn(`[vendor-sender] lookup failed, keeping the sender (email ${email && email.id}, code ${code})`);
    return true;
  }
}

module.exports = { isVendorWeUse, registrableSenderDomain, senderMailbox, KEEP_PROMO_DOMAINS };
