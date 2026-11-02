// Staff Sign in with Google (GATE_STAFF_GOOGLE_SIGNIN, owner 2026-11-02).
//
// A server-side OpenID Connect code flow; no Google script runs on our pages.
//   1. GET /api/admin/auth/google/start?client=web|ios&challenge=<S256 of a page secret>
//      stores one attempt (state, nonce, PKCE verifier, page challenge), puts
//      the state in an HttpOnly cookie and redirects to Google.
//   2. GET /api/admin/auth/google/callback: the state must match the cookie and
//      an unused, unexpired attempt. The server swaps Google's code (PKCE
//      verifier + client secret) for an ID token; google-auth-library checks
//      its signature, audience, issuer and expiry, and this module checks the
//      nonce, the verified address and the company domain (the `hd` claim, the
//      only domain Google signs). It then finds the staff row the owner linked
//      and hands the starting page a one-time result code.
//   3. POST /api/admin/auth/google/finish {result, verifier}: the page proves it
//      started the flow with the secret behind its challenge. The result is
//      single use and lives RESULT_TTL_MS; the route then answers exactly like a
//      password sign-in (a two-step challenge or a session).
// Waves Admin on iPhone runs step 1-2 in Apple's sign-in sheet
// (ASWebAuthenticationSession), because Google refuses sign-in inside an
// app's web view; its result arrives as wavespay://google-signin?result=...

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const featureGates = require('../config/feature-gates');
const { portalUrl } = require('../utils/portal-url');
const { canonicalStaffEmail } = require('../utils/staff-identity');

const ATTEMPT_TTL_MS = 10 * 60 * 1000;
const RESULT_TTL_MS = 2 * 60 * 1000;
const STALE_ATTEMPT_MS = 24 * 60 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CLIENTS = new Set(['web', 'ios']);
const STATE_COOKIE = 'waves_google_signin';
const COOKIE_PATH = '/api/admin/auth/google';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const DEFAULT_DOMAINS = 'wavespestcontrol.com';

// Resolved through the module object so a suite that stubs feature-gates
// partially reads "off" instead of throwing.
function staffGoogleSigninLive() {
  return typeof featureGates.staffGoogleSigninLive === 'function'
    && featureGates.staffGoogleSigninLive() === true;
}

function signinSettings() {
  const domains = String(process.env.GOOGLE_STAFF_SIGNIN_DOMAINS || DEFAULT_DOMAINS)
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  return {
    clientId: String(process.env.GOOGLE_STAFF_SIGNIN_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.GOOGLE_STAFF_SIGNIN_CLIENT_SECRET || '').trim(),
    domains,
    redirectUri: portalUrl('/api/admin/auth/google/callback'),
  };
}

// On only with the gate AND a configured Google client, so a flip before the
// Railway variables exist shows no button that cannot work.
function googleSigninReady() {
  if (!staffGoogleSigninLive()) return false;
  const s = signinSettings();
  return Boolean(s.clientId && s.clientSecret && s.domains.length);
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function s256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('base64url');
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readStateCookie(req) {
  const header = req?.headers?.cookie;
  if (typeof header !== 'string') return null;
  const target = `${STATE_COOKIE}=`;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(target)) {
      const value = trimmed.slice(target.length);
      return TOKEN_RE.test(value) ? value : null;
    }
  }
  return null;
}

function stateCookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: COOKIE_PATH,
    ...(maxAge === undefined ? {} : { maxAge }),
  };
}

// A Team tab link must be a company account: one of the sign-in domains.
// Returns { value } (null clears the link) or { error }.
function normalizeLinkedGoogleEmail(input) {
  if (input === null || input === '') return { value: null };
  const email = canonicalStaffEmail(input);
  if (!email) return { error: 'Enter a valid Google account address' };
  const domain = email.slice(email.lastIndexOf('@') + 1);
  const { domains } = signinSettings();
  if (!domains.includes(domain)) {
    return { error: `Use a company Google account (${domains.map((d) => `@${d}`).join(', ')})` };
  }
  return { value: email };
}

async function startAttempt({ client, challenge }) {
  if (!CLIENTS.has(client) || !TOKEN_RE.test(String(challenge || ''))) return { error: 'bad_request' };
  const s = signinSettings();
  const state = randomToken();
  const nonce = randomToken();
  const pkceVerifier = randomToken();
  // Best-effort tidy-up; a failure here never blocks a sign-in.
  await db('staff_google_signin_attempts')
    .where('created_at', '<', new Date(Date.now() - STALE_ATTEMPT_MS))
    .del()
    .catch((err) => logger.warn(`[staff-google-signin] stale attempt cleanup failed (${err?.code || 'db_error'})`));
  await db('staff_google_signin_attempts').insert({
    state_hash: sha256Hex(state),
    nonce,
    pkce_verifier: pkceVerifier,
    page_challenge: challenge,
    client,
    expires_at: new Date(Date.now() + ATTEMPT_TTL_MS),
  });
  const params = new URLSearchParams({
    client_id: s.clientId,
    redirect_uri: s.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: s256(pkceVerifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
    access_type: 'online',
  });
  // A hint for Google's account picker only; the signed `hd` claim decides.
  if (s.domains.length === 1) params.set('hd', s.domains[0]);
  return { state, authUrl: `${GOOGLE_AUTH_URL}?${params}` };
}

// Claims google-auth-library does not check. Returns a reason or null.
function claimsProblem(claims, nonce, domains) {
  if (!claims || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) return 'failed';
  if (typeof claims.nonce !== 'string' || !sameSecret(claims.nonce, nonce)) return 'failed';
  if (claims.email_verified !== true) return 'not_allowed';
  const hd = typeof claims.hd === 'string' ? claims.hd.toLowerCase() : '';
  const email = canonicalStaffEmail(claims.email);
  if (!hd || !domains.includes(hd) || !email) return 'not_allowed';
  if (!domains.includes(email.slice(email.lastIndexOf('@') + 1))) return 'not_allowed';
  return null;
}

async function verifiedGoogleClaims(code, attempt) {
  const s = signinSettings();
  const { google } = require('googleapis');
  const client = new google.auth.OAuth2(s.clientId, s.clientSecret, s.redirectUri);
  const { tokens } = await client.getToken({ code, codeVerifier: attempt.pkce_verifier });
  if (!tokens?.id_token) return { problem: 'failed' };
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: s.clientId });
  const claims = ticket.getPayload();
  const problem = claimsProblem(claims, attempt.nonce, s.domains);
  if (problem) return { problem };
  return { sub: claims.sub, email: canonicalStaffEmail(claims.email) };
}

const STAFF_ROLES = ['admin', 'technician'];

function staffMaySignIn(tech) {
  return Boolean(tech && tech.employment_status === 'active' && STAFF_ROLES.includes(tech.role));
}

// The staff row for a verified Google identity. Google's account id wins; an
// address match is accepted only while the row has no id yet, and the id is
// then pinned with a compare-and-set (a concurrent Team tab relink, or the
// same id on another row through the unique index, makes it miss).
async function linkedStaffRow({ sub, email }) {
  const bySub = await db('technicians').where({ google_sub: sub }).first();
  if (bySub) return staffMaySignIn(bySub) ? { tech: bySub } : { problem: 'not_allowed' };
  const byEmail = await db('technicians').whereRaw('LOWER(google_email) = ?', [email]).first();
  if (!byEmail || !staffMaySignIn(byEmail)) return { problem: 'not_allowed' };
  if (byEmail.google_sub) return { problem: 'relink_needed' };
  let pinned = 0;
  try {
    pinned = await db('technicians')
      .where({ id: byEmail.id })
      .whereNull('google_sub')
      .whereRaw('LOWER(google_email) = ?', [email])
      .update({ google_sub: sub, updated_at: new Date() });
  } catch (err) {
    if (err?.code !== '23505') throw err;
  }
  if (!pinned) return { problem: 'not_allowed' };
  return { tech: { ...byEmail, google_sub: sub } };
}

// Marks the attempt's callback once. A replayed callback, a missing or
// different cookie and an expired attempt all answer 'expired'.
async function claimAttempt(state, cookieState) {
  if (!TOKEN_RE.test(String(state || '')) || !cookieState || !sameSecret(state, cookieState)) return null;
  const [attempt] = await db('staff_google_signin_attempts')
    .where({ state_hash: sha256Hex(state) })
    .whereNull('callback_at')
    .where('expires_at', '>', new Date())
    .update({ callback_at: new Date() })
    .returning('*');
  return attempt || null;
}

// Which screen a refused callback returns to: the iPhone sheet must end on its
// own scheme, or it would show the web sign-in page inside the sheet.
async function attemptClient(state) {
  if (!TOKEN_RE.test(String(state || ''))) return 'web';
  const row = await db('staff_google_signin_attempts').where({ state_hash: sha256Hex(state) }).first('client');
  return row?.client === 'ios' ? 'ios' : 'web';
}

async function completeCallback({ state, cookieState, code, googleError }) {
  const attempt = await claimAttempt(state, cookieState);
  if (!attempt) return { client: await attemptClient(state), error: 'expired' };
  const { client } = attempt;
  if (googleError) return { client, error: googleError === 'access_denied' ? 'canceled' : 'failed' };
  if (typeof code !== 'string' || !code || code.length > 2048) return { client, error: 'failed' };
  let identity;
  try {
    identity = await verifiedGoogleClaims(code, attempt);
  } catch (err) {
    logger.warn(`[staff-google-signin] Google token check failed (${err?.code || err?.name || 'error'})`);
    return { client, error: 'failed' };
  }
  if (identity.problem) return { client, error: identity.problem };
  const linked = await linkedStaffRow(identity);
  if (linked.problem) {
    logger.info(`[staff-google-signin] refused sign-in (${linked.problem})`);
    return { client, error: linked.problem };
  }
  const result = randomToken();
  await db('staff_google_signin_attempts').where({ id: attempt.id }).update({
    result_hash: sha256Hex(result),
    technician_id: linked.tech.id,
    google_sub: identity.sub,
  });
  return { client, result };
}

// Where the callback sends the browser. The web result rides in the fragment,
// which never reaches a server log; the iPhone sheet catches its own scheme.
function callbackRedirect({ client, result, error }) {
  const key = result ? 'result' : 'error';
  const value = encodeURIComponent(result || error || 'failed');
  if (client === 'ios') return `wavespay://google-signin?${key}=${value}`;
  return `/admin/login#google_${key}=${value}`;
}

// Single use: the result is burned before the page secret is compared, so a
// stolen result cannot be retried. The staff row must still be signed-in-able
// and still carry the Google id the callback saw.
async function consumeResult({ result, verifier }) {
  if (!TOKEN_RE.test(String(result || '')) || !TOKEN_RE.test(String(verifier || ''))) return null;
  const [attempt] = await db('staff_google_signin_attempts')
    .where({ result_hash: sha256Hex(result) })
    .whereNull('consumed_at')
    .where('callback_at', '>', new Date(Date.now() - RESULT_TTL_MS))
    .update({ consumed_at: new Date() })
    .returning('*');
  if (!attempt || !sameSecret(s256(verifier), attempt.page_challenge)) return null;
  const tech = await db('technicians').where({ id: attempt.technician_id }).first();
  if (!staffMaySignIn(tech) || !tech.google_sub || tech.google_sub !== attempt.google_sub) return null;
  return tech;
}

module.exports = {
  ATTEMPT_TTL_MS,
  COOKIE_PATH,
  RESULT_TTL_MS,
  STATE_COOKIE,
  callbackRedirect,
  completeCallback,
  consumeResult,
  googleSigninReady,
  normalizeLinkedGoogleEmail,
  readStateCookie,
  signinSettings,
  staffGoogleSigninLive,
  startAttempt,
  stateCookieOptions,
  _test: { claimsProblem, linkedStaffRow, s256, sha256Hex },
};
