/**
 * procurement/vendor-order-email.js — "email the SiteOne order" (owner ruling
 * 2026-10-26, "OK DO OPTION B"; dark behind GATE_SITEONE_EMAIL_ORDER).
 *
 * SiteOne's website blocks the Playwright order bot, so an owner previews and
 * sends ONE pickup-order email to SiteOne for an open restock request from the
 * Restock tab. The request then becomes ordered, through the same code path
 * the Restock tab's mark-ordered action uses, so receiving works as today.
 * The bot (adapters/siteone.js), the dispatcher's ordering logic and the
 * SITEONE_BOT_* settings are not touched.
 *
 * Send claim (copied from price-scan/price-match-draft.js sendDraft) so a
 * transport failure never causes a duplicate external email:
 *   1. claim   — one vendor_order_emails row per request (UNIQUE), created
 *                'sending' with a claim_token, under the request's row lock;
 *   2. stamp   — send_attempted_at is written BEFORE the provider call; once
 *                set, nothing reopens the row by itself;
 *   3. send    — SendGrid from SENDGRID_FROM_EMAIL;
 *   4. finalize— 'sent' + provider id, matched on the claim_token.
 * A definite rejection (HTTP 4xx) releases the row to 'failed' (retryable). An
 * ambiguous failure (5xx, network, timeout) leaves it 'sending' and is never
 * resent automatically. A failure before the stamp sends nothing and leaves
 * the request open.
 *
 * Settings (all read at call time):
 *   SITEONE_ORDER_EMAIL     recipient (required)
 *   SITEONE_ORDER_CC        cc, comma separated (optional)
 *   SITEONE_ORDER_BRANCH    pickup branch (default Lakewood Ranch #238, 5115 Lena Rd)
 *   SITEONE_ORDER_PAYMENT   pickup (default) | card_on_file
 *   SITEONE_ORDER_CARD_LAST4  4 digits, required for card_on_file
 */
const { randomUUID, createHash } = require('crypto');
const db = require('../../models/db');
const sendgrid = require('../sendgrid-mail');
const logger = require('../logger');
const featureGates = require('../../config/feature-gates');
const { WAVES_BRAND_NAME, WAVES_SUPPORT_PHONE_DISPLAY } = require('../../constants/business');
const { eligibleVendorPricing } = require('../vendor-pricing-eligibility');
const dispatch = require('./order-dispatch');

const TABLE = 'vendor_order_emails';
const DEFAULT_BRANCH = 'Lakewood Ranch #238, 5115 Lena Rd';
// SiteOne sells by the package: the converter divides the request by the price
// row's pack. Passed as the adapter shape vendorOrderQuantity reads, so the
// Playwright adapter module is not loaded just for this flag.
const PACKAGE_VENDOR = { key: 'siteone', packagedQuantity: true };
// A 'sending' claim whose provider call was NEVER attempted (a crash between
// claim and stamp) is safe to take over after this long.
const STALE_UNATTEMPTED_MS = 10 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function orderEmailError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code, isOperational: true });
}
const refuse = (code, message) => orderEmailError(409, code, message);

const cleanLine = (v) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const purchaseOrderFor = (requestId) => `WAVES-${String(requestId).slice(0, 8).toUpperCase()}`;

function paymentLine(env = process.env) {
  const mode = String(env.SITEONE_ORDER_PAYMENT || 'pickup').trim().toLowerCase();
  if (mode === 'pickup') return 'We will pay at pickup.';
  if (mode === 'card_on_file') {
    const last4 = String(env.SITEONE_ORDER_CARD_LAST4 || '').trim();
    if (!/^\d{4}$/.test(last4)) throw refuse('card_last4_required', 'SITEONE_ORDER_PAYMENT is card_on_file, but SITEONE_ORDER_CARD_LAST4 is not a 4-digit number.');
    return `Please charge the card on file ending ${last4}.`;
  }
  throw refuse('payment_setting_invalid', 'SITEONE_ORDER_PAYMENT must be pickup or card_on_file.');
}

/**
 * The email, from facts already read. Pure: no database, no mail.
 * Returns { subject, text, html, po, packages, itemNumber, estimateCents }.
 * estimateCents (packages x the price row's price, before tax) is for the
 * owner's preview only; it is not part of the email.
 */
function buildSiteOneOrderEmail({ requestId, accountNumber, packages, itemNumber, productName, packSize, unitPrice }, env = process.env) {
  const po = purchaseOrderFor(requestId);
  const account = cleanLine(accountNumber);
  const branch = cleanLine(env.SITEONE_ORDER_BRANCH) || DEFAULT_BRANCH;
  const payment = paymentLine(env);
  const item = cleanLine(itemNumber);
  const itemLine = `${packages} x ${item} ${cleanLine(productName)} (${cleanLine(packSize)})`;
  const subject = `Pickup order: ${WAVES_BRAND_NAME}, account ${account}, PO ${po}`;
  const paragraphs = [
    'Hello,',
    `Please prepare this order for pickup at ${branch}.`,
    `Account: ${account}\nPO: ${po}`,
    itemLine,
    payment,
    'Please reply to confirm and tell us when it is ready.',
    `Thank you,\n${WAVES_BRAND_NAME}\n${WAVES_SUPPORT_PHONE_DISPLAY}`,
  ];
  const text = `${paragraphs.join('\n\n')}\n`;
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2933;">${
    paragraphs.map((p) => `<p style="margin:0 0 14px 0;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')
  }</body></html>`;
  const price = Number(unitPrice);
  const estimateCents = Number.isFinite(price) && price > 0 ? Math.round(packages * price * 100) : null;
  return { subject, text, html, po, packages, itemNumber: item, estimateCents };
}

const recipientOf = (env = process.env) => cleanLine(env.SITEONE_ORDER_EMAIL);
const splitList = (v) => cleanLine(v).split(/[,;\s]+/).filter(Boolean);
const ccListOf = (env = process.env) => splitList(env.SITEONE_ORDER_CC);

// A row a new claim may take over: nothing reached the provider, or the
// provider definitely refused it.
function claimable(row, now = Date.now()) {
  if (!row) return true;
  if (['pending', 'failed', 'dismissed'].includes(row.status)) return true;
  return row.status === 'sending' && !row.send_attempted_at
    && !!row.claimed_at && new Date(row.claimed_at).getTime() < now - STALE_UNATTEMPTED_MS;
}
const CLAIMABLE_SQL = `(${TABLE}.status IN ('pending', 'failed', 'dismissed') OR (${TABLE}.status = 'sending' AND ${TABLE}.send_attempted_at IS NULL AND ${TABLE}.claimed_at < ?))`;

// The order bot and this email must never both buy a request: the bot claims
// an open auto-reorder request on its own schedule, and its claim does not
// look at this table. So the email refuses while the bot would place THIS
// request for real (gates on, credentials set, not a dry run). A dry run
// submits nothing, so it does not block. The dispatcher is read, not changed.
async function assertBotCannotOrder(conn, request, vendor, env) {
  if (request.source !== 'auto_reorder') return;
  if (String(env.SITEONE_BOT_DRY_RUN || '').toLowerCase() === 'true') return;
  if (await dispatch.canAutoOrder({ conn, vendor })) {
    throw refuse('bot_can_order', 'The automatic SiteOne order bot is turned on and would also order this request. Turn off GATE_AUTO_ORDER_SITEONE before emailing the order, so SiteOne is not ordered twice.');
  }
}

// A request whose order email went to SiteOne (or may have) cannot be cancelled
// from the Restock tab: a cancelled request drops out of the reorder sweep's
// dedupe, and the next tick would raise a new request and buy the product
// again on top of the emailed order. Called by the Restock cancel path.
// The order email for a request that SiteOne has, or may have: sent, or sending with the outcome
// unknown. null = no email out. The cancel guard and the reorder sweep's stand-down both read it.
function findEmailOrderOut(conn, requestId) {
  return conn(TABLE).where({ restock_request_id: requestId }).whereIn('status', ['sent', 'sending']).first('po', 'status');
}

async function assertNoEmailOrderOut(conn, requestId) {
  const out = await findEmailOrderOut(conn, requestId);
  if (!out) return;
  throw refuse('email_order_out', `SiteOne was emailed an order for this request (PO ${out.po})${out.status === 'sending' ? ', and the email may have gone out' : ''}. Receive it when it arrives. To cancel it, tell SiteOne first, then mark the email row dismissed.`);
}

// What a SENT order email's packages hold, in the request's own unit: the
// Receive default when the admin types no quantity (301 lb asked of a 50 lb
// pack is 7 packages, and 350 lb is what arrives). null = no sent email.
async function emailOrderedQuantityFor(conn, requestId) {
  const row = await conn(TABLE).where({ restock_request_id: requestId, status: 'sent' }).first('ordered_quantity');
  const quantity = row && row.ordered_quantity != null ? Number(row.ordered_quantity) : null;
  return quantity > 0 ? quantity : null;
}

async function findSiteOneVendor(conn) {
  let vendor = await conn('vendors').where({ code: 1 }).first();
  if (!vendor) vendor = await conn('vendors').whereRaw("LOWER(TRIM(name)) = 'siteone'").first();
  return vendor || null;
}

/**
 * Everything the preview and the send share: the gate, the request, the
 * SiteOne vendor and price row, the package count, the settings, any earlier
 * email. Refuses (409 + code) unless the email can go out. `lock` reads the
 * request row FOR UPDATE (the claim runs it inside its transaction).
 */
async function loadOrderEmail(conn, requestId, { lock = false, env = process.env, now = Date.now() } = {}) {
  if (!featureGates.siteOneEmailOrderLive()) throw refuse('gate_off', 'Emailing SiteOne an order is not turned on.');
  if (!UUID_RE.test(String(requestId || ''))) throw orderEmailError(404, 'request_not_found', 'Restock request not found');
  let query = conn('product_restock_requests').where({ id: requestId });
  if (lock) query = query.forUpdate();
  const request = await query.first();
  if (!request) throw orderEmailError(404, 'request_not_found', 'Restock request not found');
  if (String(request.status).toLowerCase() !== 'open') throw refuse('request_not_open', `Only an open request can be emailed to SiteOne (this one is ${request.status}).`);

  const to = recipientOf(env);
  if (!to) throw refuse('no_recipient', 'SITEONE_ORDER_EMAIL is not set, so there is nowhere to send the order.');
  if (!EMAIL_RE.test(to)) throw refuse('recipient_invalid', 'SITEONE_ORDER_EMAIL is not a valid email address.');
  const ccList = ccListOf(env);
  if (ccList.some((c) => !EMAIL_RE.test(c))) throw refuse('cc_invalid', 'SITEONE_ORDER_CC is not a valid email address list.');

  // The same guards the Restock tab's manual actions use: a bot claim being
  // placed right now refuses every action, and an automatic order that is
  // already out for this product means SiteOne has the order.
  await dispatch.assertManualActionAllowed(conn, requestId, 'mark_ordered');
  await dispatch.assertNoLiveAutoOrder(conn, request.product_id);

  const vendor = await findSiteOneVendor(conn);
  if (!vendor || vendor.active === false) throw refuse('no_vendor', 'The SiteOne vendor is missing or inactive.');
  if (!cleanLine(vendor.account_number)) throw refuse('no_account_number', 'The SiteOne vendor row has no account number.');
  await assertBotCannotOrder(conn, request, vendor, env);
  const product = await conn('products_catalog').where({ id: request.product_id }).first('id', 'name');
  if (!product) throw refuse('no_product', 'The request\'s product no longer exists.');

  const pricing = await eligibleVendorPricing(conn('vendor_pricing').where({ product_id: product.id, vendor_id: vendor.id }))
    .orderBy('is_best_price', 'desc').first();
  if (!pricing) throw refuse('no_price_row', `${product.name} has no approved, active SiteOne price row.`);
  if (!cleanLine(pricing.vendor_sku)) throw refuse('no_vendor_sku', `${product.name}'s SiteOne price row has no item number.`);
  const order = dispatch.vendorOrderQuantity({ adapter: PACKAGE_VENDOR, request, pricing });
  if (order.error) throw refuse(order.error, order.message);
  if (!(order.quantity >= 1)) throw refuse('no_packages', 'The request works out to less than one package.');

  const earlier = await conn(TABLE).where({ restock_request_id: requestId }).first();
  if (earlier && earlier.status === 'sent') throw refuse('email_already_sent', `SiteOne was already emailed for this request (PO ${earlier.po}).`);
  if (earlier && !claimable(earlier, now)) throw refuse('email_sending', `An email to SiteOne for this request is being sent, or may already have gone out (PO ${earlier.po}). Check SendGrid or ask SiteOne before sending again.`);

  const built = buildSiteOneOrderEmail({
    requestId, accountNumber: vendor.account_number, packages: order.quantity, itemNumber: pricing.vendor_sku,
    productName: product.name, packSize: order.packSize, unitPrice: pricing.price_amount ?? pricing.price,
  }, env);
  return { ...built, request, vendor, product, pricing, to, cc: ccList.join(', ') || null, packSize: order.packSize, orderedQuantity: order.orderedQuantity };
}

// A fingerprint of everything the admin approves in the preview. Send must
// carry it, and the claim recomputes it under the lock: if the price row's
// item or pack, the recipient or the payment setting changed in between, the
// send is refused and the admin opens a fresh preview.
const versionOf = (ctx) => createHash('sha256').update(JSON.stringify([
  ctx.request.id, ctx.to, ctx.cc, ctx.subject, ctx.text, ctx.packages, ctx.itemNumber, ctx.packSize, ctx.estimateCents, ctx.orderedQuantity,
])).digest('hex').slice(0, 32);

const previewView = (ctx) => ({
  version: versionOf(ctx),
  requestId: ctx.request.id,
  to: ctx.to,
  cc: ctx.cc,
  subject: ctx.subject,
  text: ctx.text,
  html: ctx.html,
  po: ctx.po,
  packages: ctx.packages,
  itemNumber: ctx.itemNumber,
  packSize: ctx.packSize,
  productName: ctx.product.name,
  estimateCents: ctx.estimateCents,
});

/** What would go out, read-only. Refuses with a 409 and a code when it cannot. */
async function previewOrderEmail(requestId, deps = {}) {
  const ctx = await loadOrderEmail(deps.db || db, requestId, { env: deps.env || process.env });
  return previewView(ctx);
}

// HTTP status of a SendGrid failure: a 4xx is a DEFINITE rejection (not
// accepted); anything else is AMBIGUOUS (it may have been accepted).
function sendFailureStatus(err) {
  if (err && Number.isInteger(err.status)) return err.status;
  const m = err && typeof err.message === 'string' && err.message.match(/SendGrid (\d{3})\b/);
  return m ? Number(m[1]) : null;
}
const isDefiniteRejection = (err) => {
  const s = sendFailureStatus(err);
  return s != null && s >= 400 && s < 500;
};

// Claim the request's email: lock the request row (and the bot's claim row, in
// the order updateRestockRequest takes them), re-run every check under that
// lock, then create or take over the one row as 'sending'.
async function claimEmail(conn, requestId, token, { env, now, version }) {
  return conn.transaction(async (trx) => {
    await trx('vendor_orders').where({ restock_request_id: requestId }).forUpdate().first('id');
    const ctx = await loadOrderEmail(trx, requestId, { lock: true, env, now });
    if (versionOf(ctx) !== version) throw refuse('preview_changed', 'The order changed after you opened the preview. Close this window and open the preview again.');
    const stamp = new Date(now);
    const claim = {
      restock_request_id: requestId, vendor_id: ctx.vendor.id, recipient: ctx.to, cc: ctx.cc,
      subject: ctx.subject, text_body: ctx.text, html: ctx.html, status: 'sending',
      claim_token: token, claimed_at: stamp, send_attempted_at: null, sent_at: null, provider_message_id: null, sent_by: null,
      po: ctx.po, packages: ctx.packages, item_number: ctx.itemNumber, estimate_cents: ctx.estimateCents,
      ordered_quantity: ctx.orderedQuantity, updated_at: stamp,
    };
    const rows = await trx(TABLE).insert(claim)
      .onConflict('restock_request_id').merge(claim)
      .whereRaw(CLAIMABLE_SQL, [new Date(now - STALE_UNATTEMPTED_MS)])
      .returning('*');
    if (!rows.length) throw refuse('email_sending', 'An email to SiteOne for this request is already in progress or sent.');
    return { ctx, row: rows[0] };
  });
}

/**
 * Send the order email, then mark the request ordered.
 * Returns { ok: true, email, messageId, requestMarked, reconcile? }; throws an
 * error with statusCode + code on a refusal or a send failure.
 * deps (tests): { db, sendgrid, env, now, token }.
 */
async function sendOrderEmail(requestId, { actor, actorId, version } = {}, deps = {}) {
  const conn = deps.db || db;
  const mailer = deps.sendgrid || sendgrid;
  const env = deps.env || process.env;
  const now = deps.now ?? Date.now();
  // Check the gate, the request and the settings BEFORE claiming anything.
  const current = await loadOrderEmail(conn, requestId, { env, now });
  // The send is bound to the preview the admin saw (see versionOf).
  if (!version) throw refuse('preview_required', 'Open the preview first; Send needs the preview it is sending.');
  if (versionOf(current) !== version) throw refuse('preview_changed', 'The order changed after you opened the preview. Close this window and open the preview again.');
  // sendOne throws before any network call without SENDGRID_API_KEY; claiming
  // first would leave a claim for an email that can never go out.
  if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) {
    throw refuse('not_configured', 'Email sending is not configured (SENDGRID_API_KEY missing), so nothing was sent.');
  }
  const token = deps.token || randomUUID();
  const { row } = await claimEmail(conn, requestId, token, { env, now, version });
  const mine = { id: row.id, status: 'sending', claim_token: token };

  // Record the attempt BEFORE calling the provider. If this write fails
  // nothing has been sent, so release the claim and leave the request open.
  let stamped;
  try {
    stamped = await conn(TABLE).where(mine).update({ send_attempted_at: new Date(), updated_at: new Date() }).returning('id');
  } catch {
    await conn(TABLE).where(mine).update({ status: 'failed', updated_at: new Date() }).catch(() => {});
    throw orderEmailError(503, 'send_attempt_unrecorded', 'Could not record the send attempt, so nothing was sent. Try again.');
  }
  // Still the owner of the claim right before the external send?
  if (!stamped.length) throw refuse('claim_lost', 'This email changed state before it could send. Refresh and check.');

  const fromEmail = env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';
  const fromName = env.SENDGRID_FROM_NAME || WAVES_BRAND_NAME;
  const cc = splitList(row.cc);
  let res;
  try {
    res = await mailer.sendOne({
      to: row.recipient,
      ...(cc.length ? { cc } : {}),
      fromEmail,
      fromName,
      subject: row.subject,
      html: row.html,
      text: row.text_body,
      categories: ['vendor-order'],
      disableTracking: true,
      // sendOne would log the raw SendGrid body, which can echo an address (PII); the catch below logs ids and status only.
      suppressErrorLog: true,
    });
  } catch (err) {
    if (isDefiniteRejection(err)) {
      // The provider received and REFUSED it: nothing went out, so reopen the
      // row for a retry. Claim-scoped, so it never touches a newer claim.
      await conn(TABLE).where(mine).update({ status: 'failed', claim_token: null, send_attempted_at: null, updated_at: new Date() });
      throw orderEmailError(502, 'rejected', `SendGrid rejected the email (HTTP ${sendFailureStatus(err)}). Check SENDGRID_FROM_EMAIL and SITEONE_ORDER_EMAIL, then try again.`);
    }
    // Ambiguous: SendGrid may have accepted it. Keep the row 'sending' and
    // stamped; nothing resends it, and the request stays open.
    logger.error('siteone order email send unconfirmed', { emailId: row.id, requestId, status: sendFailureStatus(err) });
    throw orderEmailError(502, 'send_unconfirmed', 'SendGrid did not confirm the email, so it may have gone out. Do not send again until you check SendGrid or ask SiteOne.');
  }

  // The email WAS sent. A database problem from here on must never look like
  // a failed send: report the send, leave the row, and let a person reconcile.
  const messageId = (res && res.messageId) || null;
  const sentAt = new Date();
  let finalized = null;
  try {
    [finalized] = await conn(TABLE).where(mine).update({
      status: 'sent', sent_at: sentAt, sent_by: actor || null, provider_message_id: messageId, updated_at: sentAt,
    }).returning('*');
  } catch {
    // finalized stays null; reported just below
  }
  if (!finalized) logger.error('siteone order email sent but claim not finalized, reconcile', { emailId: row.id, requestId, messageId });

  // Mark the request ordered through the Restock tab's own path, so a later
  // Receive works as today. The email already went out; a failure here is
  // reported, not retried (a second email would be worse).
  let requestMarked = false;
  try {
    await require('../inventory-operations').updateRestockRequest(requestId, {
      action: 'mark_ordered', note: `Emailed SiteOne, PO ${row.po}`,
    }, {
      actorId: actorId || null,
      source: 'siteone_email_order',
      metadataPatch: { emailOrder: { emailId: row.id, sentAt: sentAt.toISOString(), po: row.po, packages: row.packages, itemNumber: row.item_number, to: row.recipient } },
    });
    requestMarked = true;
  } catch (markErr) {
    logger.error('siteone order email sent but request not marked ordered, reconcile', { emailId: row.id, requestId, code: markErr && markErr.code });
  }
  return {
    ok: true,
    email: { id: row.id, po: row.po, packages: row.packages, itemNumber: row.item_number, sentAt: sentAt.toISOString(), to: row.recipient },
    messageId,
    requestMarked,
    ...(finalized ? {} : { reconcile: true }),
  };
}

module.exports = {
  findEmailOrderOut,
  buildSiteOneOrderEmail,
  previewOrderEmail,
  sendOrderEmail,
  purchaseOrderFor,
  assertNoEmailOrderOut,
  emailOrderedQuantityFor,
  _internals: { claimable, loadOrderEmail, paymentLine, STALE_UNATTEMPTED_MS },
};
