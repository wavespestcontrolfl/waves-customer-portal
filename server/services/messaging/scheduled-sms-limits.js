/**
 * Attempt cap for the scheduled-SMS rail. Lives in its own module so the
 * scheduler (which claims and counts attempts) and the deferred-replay
 * registry (whose rechecks decide retry-vs-final on the same count) read one
 * number without requiring each other.
 */
const SCHEDULED_SMS_MAX_ATTEMPTS = 3;

module.exports = { SCHEDULED_SMS_MAX_ATTEMPTS };
