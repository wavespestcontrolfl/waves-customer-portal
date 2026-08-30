const crypto = require('crypto');

// Signed assessment pins (#3168).
//
// The pin tells the report page which lawn assessment to render, so the PDF a
// send fence produces provably carries the copy it sealed. That power cannot be
// public: `?assessment=none` suppresses the lawn section entirely, so an
// unsigned pin would let anyone holding a report token generate an official,
// share-able portal report with an unfavourable assessment removed. The pin
// narrows what a report says, which is its own kind of forgery even though it
// can never widen what a token can see.
//
// So a pin is only honoured when it carries a signature this server produced.
// The renderer signs; nobody else can.
//
// Bound to the report token AND an expiry, so a signature harvested from one
// report cannot be replayed onto another, and one that leaks (the signed URL is
// handed to an external browser-rendering service) stops working quickly.
const PIN_TTL_SECONDS = 15 * 60;

// Domain separation. JWT_SECRET is the deployment-wide auth secret; using it
// directly as an HMAC key for a second purpose means one construction's
// weakness becomes the other's. Deriving a purpose-bound key costs nothing and
// keeps the two uses independent. REPORT_PIN_SECRET, when set, is dedicated
// already but is derived the same way so both paths behave identically.
const PIN_KEY_INFO = 'waves:report-assessment-pin:v1';

function pinKey() {
  const base = process.env.REPORT_PIN_SECRET || process.env.JWT_SECRET;
  if (!base || !String(base).trim()) return null;
  return crypto.createHmac('sha256', String(base)).update(PIN_KEY_INFO).digest();
}

// `plan` = the week-plan snapshot identity the render is pinned to (ISO
// sent_at, or 'none'); '' when the render is unpinned for the plan. It is
// part of the signed payload so the browser's /data fetch renders exactly the
// plan the cache signature saw (codex #3565 r6).
// Without a plan pin the payload is the ORIGINAL format, so pins minted by
// the previous version keep verifying on new pods during a rolling deploy
// (in-flight report renders must not 409); a plan pin uses the extended
// format. New→old only fails for the deploy window and the render retries.
function computeSignature(key, token, assessmentId, expiresAt, plan = '') {
  const payload = plan ? `${token}:${assessmentId}:${expiresAt}:${plan}` : `${token}:${assessmentId}:${expiresAt}`;
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

// Returns { signature, expiresAt } or null when this server cannot sign.
// A null return is NOT an error the caller should surface — see the renderer:
// unable to sign means render UNPINNED rather than emit a pin that will be
// refused, which would fail every lawn delivery until retry exhaustion.
function signAssessmentPin(token, assessmentId, { nowSeconds = Math.floor(Date.now() / 1000), plan = '' } = {}) {
  const key = pinKey();
  if (!key || !token || !assessmentId) return null;
  const expiresAt = nowSeconds + PIN_TTL_SECONDS;
  return { signature: computeSignature(key, token, assessmentId, expiresAt, plan), expiresAt };
}

// Constant-time verification. Returns false rather than throwing so a caller
// can answer with the same fixed refusal it uses for an unauthorized pin — a
// timing-distinguishable or differently-worded rejection would leak whether a
// given assessment exists.
function verifyAssessmentPin(token, assessmentId, signature, expiresAt, { nowSeconds = Math.floor(Date.now() / 1000), plan = '' } = {}) {
  const key = pinKey();
  if (!key || typeof signature !== 'string') return false;

  const exp = Number(expiresAt);
  if (!Number.isFinite(exp) || exp <= nowSeconds) return false;

  const expected = computeSignature(key, token, assessmentId, String(expiresAt), plan);
  if (signature.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

module.exports = { signAssessmentPin, verifyAssessmentPin, PIN_TTL_SECONDS };
