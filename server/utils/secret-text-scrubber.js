/**
 * Best-effort scrubber for credentials pasted into free text (a payer's
 * `notes`, a ledger `note`, a script body). Used by the Intelligence Bar's
 * general admin read on every string value before the answer is cut to its
 * cap. It is a net, not a guarantee: a secret in a shape it does not know, or
 * a password written as an ordinary word, passes.
 *
 *  A. Known secret formats, one named pattern each (SECRET_PATTERNS).
 *  B. Labelled secrets in prose: "password: hunter2", "PIN is 4821",
 *     "api key = abc", "OTP: 123456". The label stays, the value goes.
 *
 * Kept on purpose (owner ruling, owner login): gate code, access code, door
 * code, lockbox code. Ordinary prose that names a credential without giving
 * one ("PIN the note", "token of appreciation", "password reset requested")
 * is left alone.
 */
const REMOVED = '[removed]';

// Each pattern: a name (for tests and for the README), the regex, and what to
// keep. Publishable keys (pk_live_, pk_test_) are public and are not listed.
// A Twilio account id (AC + 32 hex) is an identifier, not a secret, and is
// not listed either.
const SECRET_PATTERNS = Object.freeze([
  { name: 'stripe_secret_key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { name: 'stripe_webhook_secret', re: /\bwhsec_[A-Za-z0-9]{16,}/g },
  { name: 'aws_access_key_id', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'github_token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g },
  { name: 'github_fine_grained_token', re: /\bgithub_pat_[A-Za-z0-9_]{30,}/g },
  { name: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'twilio_api_key_sid', re: /\bSK[0-9a-fA-F]{32}\b/g },
  { name: 'sendgrid_api_key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { name: 'anthropic_api_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai_api_key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g },
  { name: 'pem_private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { name: 'bearer_token', re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi, keep: 1 },
]);

// Words that name a credential. "access key" is a credential; "access code" is
// a gate/door code and is not in this list.
const LABEL_WORDS = '(?:password|passcode|passphrase|passwd|pwd|pin|secret|token|api[ _-]?key|access[ _-]?key|login[ _-]?code|verification[ _-]?code|otp)';
// label, separator (":" / "=" / " is "), optional quote, value up to the next
// whitespace or punctuation boundary.
const LABELLED_RE = new RegExp(`\\b(${LABEL_WORDS})\\b([ \\t]*[:=][ \\t]*|[ \\t]+is[ \\t]+)(["'\`]?)([^\\s"'\`,;)\\]<>]+)`, 'gi');
// "gate PIN: 1234", "lockbox pin 1234": a PIN or passcode that opens a gate,
// door or lockbox is the same kept data as a gate code.
const KEPT_BEFORE_RE = /\b(?:gate|door|lockbox|access|garage|keypad)\s+(?:pin|passcode)\s*$/i;
// After ":" / "=" these are not values; after "is" the value must also look
// like a secret (a digit or a symbol, or be quoted).
const NOT_A_VALUE = new Set(['none', 'n/a', 'na', 'unknown', 'required', 'needed', 'reset', 'changed', 'set', 'updated', 'sent',
  'expired', 'pending', 'yes', 'no', 'tbd', 'blank', 'empty', 'invalid', 'incorrect', 'wrong', 'missing', 'on', 'off', 'the', 'a', 'an',
  'not', 'same', 'saved', 'stored', 'given', 'provided', 'correct', 'valid', 'active', 'old', 'new', 'forgotten', 'lost', 'confirmed',
  'verified', 'enabled', 'disabled']);

function labelledReplacement(match, label, separator, quote, rawValue, offset, text) {
  // Sentence punctuation after the value is not part of it.
  const tail = (rawValue.match(/[.!?:]+$/) || [''])[0];
  const value = tail ? rawValue.slice(0, -tail.length) : rawValue;
  if (!value) return match;
  const lowered = value.toLowerCase();
  if (value === REMOVED || NOT_A_VALUE.has(lowered)) return match;
  if (/^pin|passcode/i.test(label) && KEPT_BEFORE_RE.test(text.slice(Math.max(0, offset - 20), offset + label.length))) return match;
  const viaIs = /\bis[ \t]*$/i.test(separator);
  if (viaIs && !quote && !/[\d!@#$%^&*_+=~/\\|-]/.test(value)) return match;
  return `${label}${separator}${quote}${REMOVED}${tail}`;
}

// Returns { text, removed } where removed counts the secrets taken out.
function scrubSecretText(input) {
  if (typeof input !== 'string' || input.length < 4) return { text: input, removed: 0 };
  let removed = 0;
  let text = input;
  for (const { re, keep } of SECRET_PATTERNS) {
    text = text.replace(re, (...args) => { removed += 1; return `${keep ? args[keep] : ''}${REMOVED}`; });
  }
  text = text.replace(LABELLED_RE, (...args) => {
    const replaced = labelledReplacement(...args);
    if (replaced !== args[0]) removed += 1;
    return replaced;
  });
  return { text, removed };
}

module.exports = { SECRET_PATTERNS, REMOVED, scrubSecretText };
