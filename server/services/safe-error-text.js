/**
 * A log-safe error summary (code or name only) that can never throw.
 *
 * A knex error message echoes the SQL and its bound values, which for the
 * estimator's text-bell queries include the sender's phone digits, so a catch
 * block must not log `err.message`. notification-service's safeErrorSummary
 * does the summary; some suites mock that module as a whole, and a catch block
 * must still never throw, so any failure falls back to a fixed string.
 * One shared wrapper (estimator-engine/index.js and sms-thread.js both use it).
 */
function safeErrorText(err) {
  try {
    const summarize = require('./notification-service').safeErrorSummary;
    return typeof summarize === 'function' ? summarize(err) : 'error';
  } catch {
    return 'error';
  }
}

module.exports = { safeErrorText };
