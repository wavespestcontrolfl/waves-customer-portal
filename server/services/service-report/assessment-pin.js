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
// Bound to the report token as well as the assessment id, so a signature
// harvested from one report cannot be replayed onto another.
const PIN_SECRET_ENV = ['REPORT_PIN_SECRET', 'JWT_SECRET'];

function pinSecret() {
  for (const key of PIN_SECRET_ENV) {
    const value = process.env[key];
    if (value && String(value).trim()) return String(value);
  }
  return null;
}

function signAssessmentPin(token, assessmentId) {
  const secret = pinSecret();
  if (!secret || !token || !assessmentId) return null;
  return crypto.createHmac('sha256', secret)
    .update(`${token}:${assessmentId}`)
    .digest('hex');
}

// Constant-time verification. Returns false rather than throwing so a caller
// can answer with the same fixed refusal it uses for an unauthorized pin —
// a timing-distinguishable or differently-worded rejection would leak whether
// a given assessment exists.
function verifyAssessmentPin(token, assessmentId, signature) {
  const expected = signAssessmentPin(token, assessmentId);
  if (!expected || typeof signature !== 'string' || signature.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

module.exports = { signAssessmentPin, verifyAssessmentPin };
