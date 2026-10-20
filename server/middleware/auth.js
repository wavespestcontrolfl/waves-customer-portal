const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');
const db = require('../models/db');
const logger = require('../services/logger');

const REFRESH_TABLE = 'customer_refresh_tokens';
const DEFAULT_ACCESS_TOKEN_EXPIRY = '15m';
const CONCURRENT_ROTATION_GRACE_MS = 10 * 1000;

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function tokenHashMatches(storedHash, suppliedHash) {
  const stored = Buffer.from(String(storedHash || ''), 'utf8');
  const supplied = Buffer.from(String(suppliedHash || ''), 'utf8');
  return stored.length === supplied.length && crypto.timingSafeEqual(stored, supplied);
}

function accountIdForCustomer(customer) {
  return customer?.account_id || customer?.id || null;
}

// C4 (GATE_CANCEL_FLOW_V2): a CANCELLED customer — active=false AND
// pipeline_stage 'churned', the pair the cancellation processor stamps —
// keeps READ-ONLY portal access: login, session refresh, and the explicit
// read routes that opt in through allowCancelledRead below (history, reports,
// open balance + the tokenized pay page). Any other inactive row (staff
// deactivation, NULL active) stays out exactly as before, and every route
// that does not opt in keeps the strict active=true contract. Call-time gate
// read so a Railway flip needs no restart; gate off = today's behavior.
function cancelledReadAllowed() {
  try {
    return require('../services/cancellation-resolution').cancelFlowV2Enabled();
  } catch {
    return false;
  }
}

function isCancelledCustomerRow(customer) {
  // Exactly the processor's stamp: active EXPLICITLY false. An active=NULL
  // legacy/partially-populated churned row is not a processed cancellation
  // and gains nothing from the allowance.
  return !!customer && customer.active === false && customer.pipeline_stage === 'churned';
}

function sessionCustomerAdmitted(customer) {
  if (!customer) return false;
  if (customer.active === true) return true;
  return cancelledReadAllowed() && isCancelledCustomerRow(customer);
}

// The ONLY portal routes a cancelled customer may reach (method + mounted
// path, matched exactly — a pattern only where a path carries an id). Every
// one is a read the Billing / Documents / Visits / Plan tabs render from,
// plus the tokenized-pay hand-off (/balance mints the /pay link) and the
// customer-initiated restart. Anything not listed — bookings, schedule
// changes, card management, preference writes, referrals, AI chat — keeps
// the strict active=true contract. Extend this list deliberately.
const CANCELLED_READ_ROUTES = [
  ['GET', '/api/auth/me'],
  ['GET', '/api/auth/properties'],
  ['GET', '/api/billing'],
  ['GET', '/api/billing/balance'],
  // NOT /api/billing/cards: the cancelled tab hides Payment Methods, so
  // saved-method details (brand, last four, expiry, bank) stay unreadable
  // from a long-lived cancelled session.
  ['GET', '/api/billing/autopay'],
  ['GET', '/api/schedule'],
  ['GET', '/api/schedule/next'],
  // Saved-property twin of /next (GATE_APP_PROPERTY_SCOPE): the same visit
  // data as /schedule, per property — read-only, so a cancelled session may
  // read it (codex #4207 r1 P2). /auth/select-property stays out: a switch
  // mints credentials, and the cancelled list is one entry anyway.
  ['GET', '/api/schedule/properties-next'],
  ['GET', '/api/services'],
  ['GET', '/api/services/stats/summary'],
  ['GET', '/api/documents'],
  ['GET', /^\/api\/documents\/service-report\/[^/]+$/],
  ['GET', /^\/api\/documents\/[^/]+\/download$/],
  ['GET', '/api/property/termite-bond'],
  // NOT the notification-preference reads: the cancelled Visits tab hides
  // every preference control (their writes are blocked), so nothing renders
  // from those reads.
  ['POST', '/api/requests/restart-plan'],
  // The one write besides restart: in-app account deletion (App Store
  // Guideline 5.1.1(v)) must stay reachable after cancellation — the route
  // soft-deletes every profile and revokes all sessions itself (codex GH r5
  // P1: the strict contract 401'd a cancelled customer AFTER the confirm).
  ['DELETE', '/api/auth/account'],
  // Native sign-out's device-token deactivation (codex GH r12 P1): the app
  // posts this BEFORE clearing credentials and swallows failures, so a
  // 401 here left the push_subscriptions row active and billing/service
  // notifications kept reaching a signed-out device. Narrow write: it only
  // deactivates the caller's own token.
  ['POST', '/api/push/native-unsubscribe'],
  // Activity beacons (GATE_PORTAL_ACTIVITY): the cancelled portal still
  // opens tabs and taps billing pushes, and a 401 here would churn the
  // refresh token on every tab change. Write-only analytics rows for the
  // caller's own session — nothing is read back.
  ['POST', '/api/customer/activity/page-view'],
  ['POST', '/api/customer/activity/push-open'],
  ['POST', '/api/customer/activity/heartbeat'],
];

function routeListed(req, list) {
  const full = `${req.baseUrl || ''}${req.path || ''}`.replace(/\/+$/, '') || '/';
  return list.some(([method, path]) => method === req.method
    && (path instanceof RegExp ? path.test(full) : path === full));
}

function cancelledReadRoute(req) {
  return routeListed(req, CANCELLED_READ_ROUTES);
}

// Contact login (GATE_CONTACT_LOGIN): an on-location contact signed in with
// their own number holds a CONTACT session on the account holder's row. The
// ONLY routes it may reach — every one a read the Visits / Documents tabs
// render from, plus the contact's own notification choices and the activity
// beacons. Owner ruling 2026-10-20: view only — no confirm, no reschedule,
// no requests. Nothing here reads billing, cards, credits, referrals, the
// holder's preferences or contacts, or subscribes a device (push rows are
// keyed by customer, so a contact device would get the holder's billing
// pushes). Anything not listed answers 403 ACCOUNT_HOLDER_ONLY (not 401, so
// the client never reads it as a dead session). Extend deliberately.
const CONTACT_SESSION_ROUTES = [
  ['GET', '/api/auth/me'],
  ['GET', '/api/auth/properties'],
  ['GET', '/api/schedule'],
  ['GET', '/api/schedule/next'],
  // NOT /account-next or /properties-next: those list the account's OTHER
  // profiles and saved houses; a contact session lists one entry, so the
  // client never asks.
  ['GET', '/api/services'],
  ['GET', '/api/services/stats/summary'],
  ['GET', /^\/api\/services\/[^/]+$/],
  // The documents handlers narrow a contact session to service reports and
  // answer nothing at all for a contact the report rule withholds from.
  ['GET', '/api/documents'],
  ['GET', /^\/api\/documents\/service-report\/[^/]+$/],
  ['GET', /^\/api\/documents\/[^/]+\/download$/],
  ['GET', '/api/tracking/active'],
  ['GET', '/api/tracking/today'],
  ['GET', '/api/tracking/maps-key'],
  // Token-scoped release of THIS device's native push registration: a
  // device a holder signed out of (release failed) that a contact now signs
  // into must stop receiving the holder's pushes (codex #6363 r4 P1). The
  // route deactivates only the token presented; subscribe stays holder-only
  // here (contact app devices are the follow-up PR).
  ['POST', '/api/push/native-unsubscribe'],
  ['GET', '/api/notifications/contact-preferences'],
  ['PUT', '/api/notifications/contact-preferences'],
  ['POST', '/api/customer/activity/page-view'],
  ['POST', '/api/customer/activity/push-open'],
  ['POST', '/api/customer/activity/heartbeat'],
];

function contactSessionRoute(req) {
  return routeListed(req, CONTACT_SESSION_ROUTES);
}

function contactLoginLive() {
  try {
    return require('../config/feature-gates').contactLoginLive();
  } catch {
    return false;
  }
}

// The contact slot a session claim names on this customer row, or null when
// the claim no longer holds (gate off, contact removed or replaced, the
// number now the holder's own). Pure apart from the gate read.
function contactSessionFor(customer, contactKey) {
  if (!contactKey || !contactLoginLive()) return null;
  const { findServiceContactSlotByPhoneKey, contactSlotMayLogIn } = require('../services/customer-contact');
  // The holder's attestation covers this number (customer-contact.js
  // contactSlotMayLogIn): an inferred, still-unconsented slot phone is no
  // session, and a session dies if its number becomes one.
  if (!contactSlotMayLogIn(customer, contactKey)) return null;
  return findServiceContactSlotByPhoneKey(customer, contactKey);
}

// Admission of a CONTACT access token on this request. Fail closed on every
// request: gate off, an inactive row (no cancelled allowance), or a number
// that no longer occupies a contact slot all end the session (401); a route
// outside CONTACT_SESSION_ROUTES answers 403 so the client keeps the session
// and simply never shows that surface. Returns { contact } or { status, body }.
function admitContactSession(req, customer, contactKey) {
  const contact = customer.active === true ? contactSessionFor(customer, contactKey) : null;
  if (!contact) return { status: 401, body: { error: 'Customer not found or inactive' } };
  if (!contactSessionRoute(req)) {
    return { status: 403, body: { error: 'This part of the portal is for the account holder.', code: 'ACCOUNT_HOLDER_ONLY' } };
  }
  return { contact };
}

function refreshExpiryDate(token) {
  const decoded = jwt.decode(token);
  return decoded?.exp ? new Date(decoded.exp * 1000) : null;
}

function verifyRefreshCredential(refreshToken) {
  try {
    const decoded = jwt.verify(refreshToken, config.jwt.secret);
    if (decoded.type !== 'refresh' || !decoded.customerId) return null;
    // A transition token minted before refresh-session persistence has neither
    // claim. A partially shaped token is never valid.
    if (Boolean(decoded.jti) !== Boolean(decoded.familyId)) return null;
    return decoded;
  } catch {
    return null;
  }
}

async function insertRefreshRecord(
  executor,
  customerId,
  accountId,
  familyId = crypto.randomUUID(),
  jti = crypto.randomUUID(),
  parentJti = null,
  propertyId = null,
  contactKey = null,
) {
  const refreshToken = generateRefreshToken(customerId, accountId, { jti, familyId, propertyId, contactKey });
  const expiresAt = refreshExpiryDate(refreshToken);
  await executor(REFRESH_TABLE).insert({
    jti,
    family_id: familyId,
    customer_id: customerId,
    account_id: accountId || null,
    token_hash: hashRefreshToken(refreshToken),
    parent_jti: parentJti,
    expires_at: expiresAt,
    // The contact phone a CONTACT family was minted for (GATE_CONTACT_LOGIN):
    // the holder's contact save revokes the families of phones it removed
    // (revokeRemovedContactRefreshSessions), so re-adding the number later
    // never revives a removed device's session (codex #6363 r6 P2).
    contact_key: contactKey || null,
  });
  return { refreshToken, familyId, jti, expiresAt };
}

// The holder rewrote this row's contact slots: every contact refresh family
// on the row whose phone no longer occupies a slot ends now. Inside the
// save's transaction. Phones are keyed as the session claim keys them.
async function revokeRemovedContactRefreshSessions(trx, customerId, keepPhones = []) {
  const { phoneKeyOf } = require('../services/customer-contact');
  const keep = [...new Set(keepPhones.map(phoneKeyOf).filter(Boolean))];
  const now = new Date();
  const q = trx(REFRESH_TABLE).where({ customer_id: customerId }).whereNotNull('contact_key').whereNull('revoked_at');
  if (keep.length) q.whereNotIn('contact_key', keep);
  return q.update({ revoked_at: now, revoke_reason: 'contact_removed', updated_at: now });
}

/**
 * Customers created by paths that skip the account layer (public estimate
 * accept, self-book, lead webhooks, call pipeline) have account_id NULL and
 * no customer_accounts row, so the refresh-session insert's NOT NULL FK on
 * account_id rejects their login AFTER Twilio approves the SMS code.
 * Adopt the customer as their own account — the same self-adoption the
 * 20260504000008 backfill applied to then-existing customers — before
 * minting the session. Only the customerId-fallback case can be missing a
 * row: a non-null customers.account_id is itself an FK onto customer_accounts.
 */
async function ensureSelfAccountRow(trx, customerId, accountId) {
  if (String(accountId) !== String(customerId)) return;
  const existing = await trx('customer_accounts').where({ id: accountId }).first('id');
  if (existing) return;
  const customer = await trx('customers').where({ id: customerId }).first();
  if (!customer) return;
  await trx('customer_accounts')
    .insert({
      id: customer.id,
      first_name: customer.first_name || 'Customer',
      last_name: customer.last_name || null,
      email: customer.email || null,
      phone: customer.phone || null,
      company_name: customer.company_name || null,
    })
    .onConflict('id')
    .ignore();
  await trx('customers')
    .where({ id: customerId })
    .whereNull('account_id')
    .update({
      account_id: customer.id,
      is_primary_profile: true,
      profile_label: customer.profile_label || 'Primary',
    });
  logger.info(`[auth] adopted account-less customer ${customerId} as own account at login`);
}

/** Create a durable, revocable refresh-token family for a login session. */
async function createRefreshSession(customerId, accountId = null, { contactKey = null } = {}) {
  return db.transaction(async (trx) => {
    const resolvedAccountId = accountId || customerId;
    await ensureSelfAccountRow(trx, customerId, resolvedAccountId);
    return insertRefreshRecord(trx, customerId, resolvedAccountId, undefined, undefined, null, null, contactKey);
  });
}

/**
 * Atomically consume a refresh token and replace it inside the same family.
 * Reusing any consumed token revokes every descendant in that family.
 *
 * Legacy signed refresh tokens (minted before this table existed) get one
 * compatible exchange. Their SHA-256 hash becomes the durable old-token row,
 * so a second exchange is detected as replay instead of creating a new family.
 */
async function rotateRefreshSession(refreshToken, options = {}) {
  const decoded = verifyRefreshCredential(refreshToken);
  if (!decoded) return { ok: false, code: 'INVALID_REFRESH_TOKEN' };
  if (options.expectedCustomerId
    && String(decoded.customerId) !== String(options.expectedCustomerId)) {
    return { ok: false, code: 'INVALID_REFRESH_TOKEN' };
  }
  if (options.expectedFamilyId
    && String(decoded.familyId || '') !== String(options.expectedFamilyId)) {
    return { ok: false, code: 'INVALID_REFRESH_TOKEN' };
  }
  const suppliedHash = hashRefreshToken(refreshToken);

  const result = await db.transaction(async (trx) => {
    // A cancelled customer's saved session keeps refreshing under the C4
    // read-only allowance (sessionCustomerAdmitted); every other inactive
    // row is rejected exactly as before.
    const customer = await trx('customers')
      .where({ id: decoded.customerId })
      .whereNull('deleted_at')
      .first();
    if (!sessionCustomerAdmitted(customer)) return { ok: false, code: 'INVALID_REFRESH_TOKEN' };

    const accountId = decoded.accountId || accountIdForCustomer(customer);
    if (decoded.accountId && String(decoded.accountId) !== String(accountIdForCustomer(customer))) {
      return { ok: false, code: 'INVALID_REFRESH_TOKEN' };
    }
    if (options.expectedAccountId && String(accountId) !== String(options.expectedAccountId)) {
      return { ok: false, code: 'INVALID_REFRESH_TOKEN' };
    }

    // Contact session (GATE_CONTACT_LOGIN): the family stays bound to the
    // phone it was minted for. It rotates only while the gate is on, the
    // row is ACTIVE (no cancelled allowance: a churned account's contacts
    // have nothing to see) and the number still occupies a contact slot —
    // the holder removing the contact ends the session here. A profile
    // switch is never a contact's to make.
    const contactKey = decoded.contactKey || null;
    if (contactKey) {
      if (!contactLoginLive()) return { ok: false, code: 'INVALID_REFRESH_TOKEN' };
      if (customer.active !== true || !contactSessionFor(customer, contactKey)) {
        // The number is gone from the row (or the row is inactive): the
        // family ends here, not just this exchange — a later re-add of the
        // same phone must not revive it (codex #6363 r6 P2). A gate flip is
        // not that: it only refuses, so the sessions survive it.
        if (decoded.familyId) {
          const now = new Date();
          await trx(REFRESH_TABLE)
            .where({ family_id: decoded.familyId })
            .whereNull('revoked_at')
            .update({ revoked_at: now, revoke_reason: 'contact_removed', updated_at: now });
        }
        return { ok: false, code: 'INVALID_REFRESH_TOKEN' };
      }
      if (options.targetCustomerId && String(options.targetCustomerId) !== String(customer.id)) {
        return { ok: false, code: 'INVALID_REFRESH_TOKEN' };
      }
    }

    let nextCustomer = customer;
    if (options.targetCustomerId && String(options.targetCustomerId) !== String(customer.id)) {
      nextCustomer = await trx('customers')
        .where({ id: options.targetCustomerId, active: true })
        .whereNull('deleted_at')
        .first();
      if (!nextCustomer || String(accountIdForCustomer(nextCustomer)) !== String(accountId)) {
        return { ok: false, code: 'INVALID_REFRESH_TOKEN' };
      }
    }
    // Selected saved property (GATE_APP_PROPERTY_SCOPE). A same-profile
    // rotation forwards the claim the family was minted with; a profile
    // switch drops it unless the switch names a target property. Never
    // validated here — the access-token middleware re-checks the row
    // against the customer on every request, so a stale claim can only ever
    // fall back to the primary.
    const nextPropertyId = options.targetPropertyId !== undefined
      ? (options.targetPropertyId || null)
      : (String(nextCustomer.id) === String(customer.id) ? (decoded.propertyId || null) : null);

    let row;
    if (decoded.jti && decoded.familyId) {
      row = await trx(REFRESH_TABLE)
        .where({ jti: decoded.jti, family_id: decoded.familyId })
        .forUpdate()
        .first();
    } else {
      const legacyFamilyId = crypto.randomUUID();
      const [inserted] = await trx(REFRESH_TABLE).insert({
        jti: suppliedHash,
        family_id: legacyFamilyId,
        customer_id: decoded.customerId,
        account_id: accountId,
        token_hash: suppliedHash,
        expires_at: new Date(decoded.exp * 1000),
      }).onConflict('token_hash').ignore().returning('*');
      row = inserted || await trx(REFRESH_TABLE)
        .where({ token_hash: suppliedHash })
        .forUpdate()
        .first();
    }

    if (!row || !tokenHashMatches(row.token_hash, suppliedHash)) {
      return { ok: false, code: 'INVALID_REFRESH_TOKEN' };
    }
    if (String(row.customer_id) !== String(decoded.customerId)
      || (row.account_id && String(row.account_id) !== String(accountId))) {
      return { ok: false, code: 'INVALID_REFRESH_TOKEN' };
    }

    const now = new Date();
    // Check consumption first: rows may already carry revoked_at from a prior
    // replay or property switch, but replay must still revoke descendants.
    if (row.consumed_at) {
      // Two same-origin tabs can submit the same token before the first tab
      // publishes its replacement to shared storage. Do not hand the second
      // caller any credential, but give it a brief signal to adopt the pair
      // published by the winner. A later reuse remains theft-like and revokes
      // the entire family below.
      const consumedAgoMs = now.getTime() - new Date(row.consumed_at).getTime();
      if (consumedAgoMs >= 0
        && consumedAgoMs <= CONCURRENT_ROTATION_GRACE_MS
        && row.replaced_by_jti) {
        const liveReplacement = await trx(REFRESH_TABLE)
          .where({ jti: row.replaced_by_jti, family_id: row.family_id })
          .whereNull('consumed_at')
          .whereNull('revoked_at')
          .first();
        if (liveReplacement && new Date(liveReplacement.expires_at) > now) {
          return {
            ok: false,
            code: 'REFRESH_TOKEN_ALREADY_ROTATED',
            familyId: row.family_id,
          };
        }
      }
      await trx(REFRESH_TABLE)
        .where({ family_id: row.family_id })
        .whereNull('revoked_at')
        .update({ revoked_at: now, revoke_reason: 'replay_detected', updated_at: now });
      return { ok: false, code: 'REFRESH_TOKEN_REUSED', familyId: row.family_id };
    }
    if (row.revoked_at || new Date(row.expires_at) <= now) {
      return { ok: false, code: 'REFRESH_SESSION_REVOKED' };
    }

    const nextJti = crypto.randomUUID();
    const consumeUpdate = { consumed_at: now, replaced_by_jti: nextJti, updated_at: now };
    if (options.revokeReason) {
      consumeUpdate.revoked_at = now;
      consumeUpdate.revoke_reason = options.revokeReason;
    }
    const consumed = await trx(REFRESH_TABLE)
      .where({ jti: row.jti })
      .whereNull('consumed_at')
      .whereNull('revoked_at')
      .update(consumeUpdate);
    if (consumed !== 1) {
      // The row lock should make this unreachable, but fail closed if a
      // database/adapter behaves unexpectedly.
      await trx(REFRESH_TABLE)
        .where({ family_id: row.family_id })
        .whereNull('revoked_at')
        .update({ revoked_at: now, revoke_reason: 'rotation_conflict', updated_at: now });
      return { ok: false, code: 'REFRESH_SESSION_REVOKED' };
    }

    const next = await insertRefreshRecord(
      trx,
      nextCustomer.id,
      accountId,
      row.family_id,
      nextJti,
      row.jti,
      nextPropertyId,
      contactKey,
    );
    return { ok: true, ...next, customer: nextCustomer, accountId, propertyId: nextPropertyId, contactKey };
  });

  if (result.code === 'REFRESH_TOKEN_REUSED') {
    // Do not log the token, JTI, customer ID, or family ID.
    logger.warn('[auth] refresh-token replay detected; session family revoked');
  }
  return result;
}

/**
 * Replace the current family token when an authenticated customer switches
 * service properties. New access tokens carry the family ID; legacy access
 * tokens without it start a new family during the rollout window.
 */
async function reissueRefreshSessionForProperty(
  refreshToken,
  customerId,
  accountId,
  expectedCustomerId,
  expectedFamilyId,
  { propertyId = null } = {},
) {
  return rotateRefreshSession(refreshToken, {
    targetCustomerId: customerId,
    expectedAccountId: accountId,
    expectedCustomerId,
    expectedFamilyId,
    // Explicit (null included) so a switch to a profile's PRIMARY clears a
    // previously selected secondary instead of forwarding it.
    targetPropertyId: propertyId || null,
    revokeReason: 'property_switch',
  });
}

/** Revoke the whole family represented by a refresh credential. */
async function revokeRefreshSession(refreshToken, reason = 'logout') {
  const decoded = verifyRefreshCredential(refreshToken);
  if (!decoded) return { revoked: false };
  const suppliedHash = hashRefreshToken(refreshToken);

  return db.transaction(async (trx) => {
    let row;
    if (decoded.jti && decoded.familyId) {
      row = await trx(REFRESH_TABLE)
        .where({ jti: decoded.jti, family_id: decoded.familyId })
        .forUpdate()
        .first();
    } else {
      row = await trx(REFRESH_TABLE)
        .where({ token_hash: suppliedHash })
        .forUpdate()
        .first();

      if (!row) {
        // A signed pre-rollout token has no durable row until its first
        // refresh. Logout must still leave a tombstone or that same token can
        // later take the legacy migration path and create a live family.
        // Validate the current customer/account exactly as rotation does
        // before inserting anything; arbitrary, access, deleted-customer, or
        // account-mismatched credentials never reach the session table.
        // Same admission rule as rotation (C4): a cancelled customer CAN
        // rotate, so their logout must tombstone too — otherwise a retained
        // legacy token outlives the logout and migrates into a live family.
        const customer = await trx('customers')
          .where({ id: decoded.customerId })
          .whereNull('deleted_at')
          .first();
        if (!sessionCustomerAdmitted(customer)) return { revoked: false };

        const accountId = decoded.accountId || accountIdForCustomer(customer);
        if (!accountId
          || (decoded.accountId
            && String(decoded.accountId) !== String(accountIdForCustomer(customer)))) {
          return { revoked: false };
        }

        const expiresAt = Number.isFinite(decoded.exp)
          ? new Date(decoded.exp * 1000)
          : null;
        const now = new Date();
        if (!expiresAt || expiresAt <= now) return { revoked: false };

        const [inserted] = await trx(REFRESH_TABLE).insert({
          // The legacy token has no JTI. Its collision-resistant fingerprint
          // is already the rollout identifier used by rotateRefreshSession.
          jti: suppliedHash,
          family_id: crypto.randomUUID(),
          customer_id: decoded.customerId,
          account_id: accountId,
          token_hash: suppliedHash,
          expires_at: expiresAt,
          revoked_at: now,
          revoke_reason: reason,
        }).onConflict('token_hash').ignore().returning('*');

        // A concurrent logout/refresh may have won the unique-hash insert.
        // Lock and revoke that winner's whole family, including a replacement
        // created by a simultaneous legacy migration refresh.
        row = inserted || await trx(REFRESH_TABLE)
          .where({ token_hash: suppliedHash })
          .forUpdate()
          .first();
      }
    }
    if (!row || !tokenHashMatches(row.token_hash, suppliedHash)) return { revoked: false };

    const now = new Date();
    await trx(REFRESH_TABLE)
      .where({ family_id: row.family_id })
      .whereNull('revoked_at')
      .update({ revoked_at: now, revoke_reason: reason, updated_at: now });
    return { revoked: true };
  });
}

async function revokeCustomerRefreshSessions(customerId, accountId = null, reason = 'account_deleted') {
  const query = db(REFRESH_TABLE).whereNull('revoked_at');
  if (accountId) query.where({ account_id: accountId });
  else query.where({ customer_id: customerId });
  return query.update({ revoked_at: new Date(), revoke_reason: reason, updated_at: new Date() });
}

/**
 * Verify JWT token and attach customer to request
 */
async function authenticateCore(req, res, next, { allowInactive = false, allowCancelledRead = false } = {}) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, config.jwt.secret);

    // Refresh tokens are exchange-only (POST /auth/refresh). They're minted
    // with a longer TTL, so accepting one here would let a leaked refresh
    // token act as a long-lived access token.
    if (decoded.type === 'refresh') {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    const query = db('customers')
      .where({ id: decoded.customerId })
      .whereNull('deleted_at');
    if (!allowInactive && !allowCancelledRead) query.where({ active: true });
    const customer = await query.first();

    // Fail closed: an inactive row passes only through the allowance the
    // route asked for — any inactive (allowInactive) or a gated cancelled
    // read (allowCancelledRead + GATE_CANCEL_FLOW_V2 + churned stage).
    const admitted = !!customer && (
      customer.active === true
      || allowInactive
      || (allowCancelledRead && sessionCustomerAdmitted(customer))
    );
    if (!admitted) {
      return res.status(401).json({ error: 'Customer not found or inactive' });
    }

    const customerAccountId = customer.account_id || customer.id;
    if (decoded.accountId && String(decoded.accountId) !== String(customerAccountId)) {
      return res.status(401).json({ error: 'Invalid token account' });
    }

    // Contact session (GATE_CONTACT_LOGIN) — see admitContactSession.
    req.contactSession = null;
    if (decoded.contactKey) {
      const admission = admitContactSession(req, customer, decoded.contactKey);
      if (!admission.contact) return res.status(admission.status).json(admission.body);
      req.contactSession = admission.contact;
    }

    req.customer = customer;
    req.customerId = customer.id;
    // Anything other than active === true counts as inactive (the column is
    // nullable; the strict middleware requires active=true, so a NULL-active
    // customer must not slip past allow-inactive routes' per-action gates).
    req.customerInactive = customer.active !== true;
    req.accountId = decoded.accountId || customerAccountId;
    req.authSessionId = decoded.sessionId || null;
    // Selected saved property (GATE_APP_PROPERTY_SCOPE). Honored only when
    // the row is THIS customer's and active; anything else — another
    // customer's property, a row the office retired, gate off — resolves to
    // "no selection", which every property-scoped read treats as the
    // primary. Fail-safe rather than 401: no other customer's data is
    // reachable through the claim, and a property retired mid-session must
    // not sign the customer out.
    req.propertyId = null;
    req.property = null;
    if (decoded.propertyId && require('../config/feature-gates').gateEnvValue('GATE_APP_PROPERTY_SCOPE')) {
      let property;
      try {
        property = await db('customer_properties')
          .where({ id: decoded.propertyId, customer_id: customer.id, active: true })
          .first();
      } catch (lookupErr) {
        // Infrastructure failure, not "no such row" (codex #4199 r1 P2): a
        // silent fall-back to the primary would answer the WRONG home's
        // visits and texts. Retryable 503 — never the outer catch's 401,
        // which the client reads as a dead session.
        logger.warn(`[auth] property-claim lookup failed: ${lookupErr.message}`);
        return res.status(503).json({
          error: 'Property selection is temporarily unavailable. Please try again.',
          code: 'PROPERTY_SCOPE_UNAVAILABLE',
        });
      }
      if (property) {
        req.propertyId = property.id;
        req.property = property;
      }
    }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function authenticate(req, res, next) {
  // C4: a cancelled customer is admitted ONLY on the enumerated read routes
  // (CANCELLED_READ_ROUTES) and only while GATE_CANCEL_FLOW_V2 is on; the
  // handler sees req.customerInactive = true.
  return authenticateCore(req, res, next, { allowInactive: false, allowCancelledRead: cancelledReadRoute(req) });
}

/**
 * Same as authenticate but admits an INACTIVE (not deleted) customer, setting
 * req.customerInactive so the route can gate per-action. Exists for the
 * cancellation-request path: auto-processing churns the account (active=false)
 * mid-flight, and a client retry after a lost response must still reach the
 * idempotent dedupe/repair sweep instead of dying on a 401 here. Routes using
 * this MUST explicitly reject inactive customers for anything else.
 */
function authenticateAllowInactive(req, res, next) {
  return authenticateCore(req, res, next, { allowInactive: true });
}

/**
 * Generate JWT for a customer
 */
function generateToken(customerId, accountId = null, sessionId = null, { propertyId = null, contactKey = null } = {}) {
  return jwt.sign(
    {
      customerId,
      accountId: accountId || undefined,
      sessionId: sessionId || undefined,
      // Selected saved property (customer_properties.id) — absent = primary.
      propertyId: propertyId || undefined,
      // Contact session (GATE_CONTACT_LOGIN): the last-10 phone key of the
      // on-location contact this session belongs to — absent = the holder.
      contactKey: contactKey || undefined,
    },
    config.jwt.secret,
    // Customer access tokens are deliberately short-lived. Existing signed
    // tokens still verify until their original expiry, while the client uses
    // the durable refresh session to renew new 15-minute access tokens.
    { expiresIn: DEFAULT_ACCESS_TOKEN_EXPIRY }
  );
}

function generateRefreshToken(customerId, accountId = null, options = {}) {
  const jti = options.jti || crypto.randomUUID();
  const familyId = options.familyId || crypto.randomUUID();
  return jwt.sign(
    {
      customerId,
      accountId: accountId || undefined,
      type: 'refresh',
      jti,
      familyId,
      propertyId: options.propertyId || undefined,
      contactKey: options.contactKey || undefined,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.refreshExpiry }
  );
}

// Optional-auth resolver for public routes that ACCEPT a customer bearer but
// must not demand one (e.g. /booking/confirm under the customers-only gate).
// Mirrors authenticateCore's access-token contract — refresh tokens rejected,
// active non-deleted customer required, accountId consistency enforced — but
// returns the customer row (or null) instead of writing 401 responses, so an
// absent/expired/garbage header simply resolves to "not a verified customer"
// and the caller decides what that means.
//
// One side-channel: an EXPIRED (but otherwise well-formed) access token stamps
// req.bearerTokenExpired = true. Access tokens live 15 minutes and a customer
// can easily spend longer picking a slot, so callers gating on the resolver
// should answer that case with authenticateCore's refreshable
// 401 { code: 'TOKEN_EXPIRED' } — the api client refreshes and retries —
// instead of a terminal refusal. Garbage/forged headers get no such hint.
async function resolveBearerCustomer(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], config.jwt.secret);
    if (decoded.type === 'refresh' || !decoded.customerId) return null;
    // A contact session is never "the verified customer" for a public
    // booking or confirm flow — only the holder books.
    if (decoded.contactKey) return null;
    const customer = await db('customers')
      .where({ id: decoded.customerId, active: true })
      .whereNull('deleted_at')
      .first();
    if (!customer) return null;
    const customerAccountId = customer.account_id || customer.id;
    if (decoded.accountId && String(decoded.accountId) !== String(customerAccountId)) return null;
    return customer;
  } catch (err) {
    if (err.name === 'TokenExpiredError') req.bearerTokenExpired = true;
    return null;
  }
}

module.exports = {
  authenticate,
  authenticateAllowInactive,
  isCancelledCustomerRow,
  sessionCustomerAdmitted,
  resolveBearerCustomer,
  createRefreshSession,
  generateToken,
  generateRefreshToken,
  reissueRefreshSessionForProperty,
  revokeCustomerRefreshSessions,
  revokeRemovedContactRefreshSessions,
  revokeRefreshSession,
  rotateRefreshSession,
  verifyRefreshCredential,
  _test: { CONCURRENT_ROTATION_GRACE_MS, CANCELLED_READ_ROUTES, cancelledReadRoute, CONTACT_SESSION_ROUTES, contactSessionRoute },
};
