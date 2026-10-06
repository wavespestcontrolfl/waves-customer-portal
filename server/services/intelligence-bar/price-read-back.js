// One-time price read-back for Intelligence Bar bookings.
//
// When a STATED price differs from the catalog price, the proposal is refused
// once so the model asks the operator which price to use. `price_confirmed` is
// model-supplied, so on its own it proves nothing: the model could set it on
// the first call or retry in the same loop. This record makes it verifiable.
// A confirmation counts only when a read-back for the SAME operator, customer
// and stated price was recorded by an EARLIER operator request (the request
// start differs) and is still fresh.
//
// Store: an in-process Map. No durable table fits (no migration for a display
// guard), and it fails closed: a restart or another instance simply asks the
// operator again, never skips the question.

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 500;
const records = new Map();

const cents = (n) => Math.round(Number(n) * 100);
const keyOf = (actorId, customerId, statedPrice) => `${actorId}|${customerId}|${cents(statedPrice)}`;

function prune(now) {
  for (const [key, rec] of records) {
    if (now - rec.at > TTL_MS) records.delete(key);
  }
  while (records.size > MAX_ENTRIES) records.delete(records.keys().next().value);
}

// A read-back was just sent to the model for this request.
function recordReadBack({ actorId, customerId, statedPrice, catalogPrice, requestStartedAt, now = Date.now() }) {
  prune(now);
  records.set(keyOf(actorId, customerId, statedPrice), { requestStartedAt, catalogPrice, at: now });
}

// True only for a read-back from an earlier request that is still fresh. A
// missing request start (cannot be ordered) never confirms.
function isConfirmed({ actorId, customerId, statedPrice, catalogPrice, requestStartedAt, now = Date.now() }) {
  const rec = records.get(keyOf(actorId, customerId, statedPrice));
  if (!rec || !Number.isFinite(requestStartedAt) || !Number.isFinite(rec.requestStartedAt)) return false;
  if (now - rec.at > TTL_MS) return false;
  if (cents(rec.catalogPrice) !== cents(catalogPrice)) return false;
  return rec.requestStartedAt < requestStartedAt;
}

// The confirmed card was made: the next differing price asks again.
function clear({ actorId, customerId, statedPrice }) {
  records.delete(keyOf(actorId, customerId, statedPrice));
}

function _resetForTests() { records.clear(); }

module.exports = { recordReadBack, isConfirmed, clear, TTL_MS, _resetForTests };
