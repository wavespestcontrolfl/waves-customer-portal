'use strict';

// Bid kit logging (GATE_BID_KIT, dark). A Knex or driver error message can carry the SQL bindings, and a binding in this
// kit can be a reference's name, email or address, or a custom label. So nothing in the bid-kit modules logs or passes on an
// error's message: a log line is a fixed sentence plus the error's code or name (the way the notification service logs).

// "23505", "ECONNRESET" or "TypeError": the error's code, else its name, plus the violated constraint when the driver names one.
function errorTag(err) {
  const bits = [err ? (err.code || err.name || 'Error') : 'Error'];
  if (err && err.constraint) bits.push(`constraint=${err.constraint}`);
  return bits.join(' ');
}

// An error safe to hand to the app's error handler (which logs it): the same code and status, a fixed message, no stack
// that quotes the original.
function scrubError(err) {
  const out = new Error(`Bid kit request failed (${errorTag(err)})`);
  out.name = (err && err.name) || 'Error';
  if (err && err.code) out.code = err.code;
  if (err && err.status) out.status = err.status;
  out.stack = `${out.name}: ${out.message}`;
  return out;
}

module.exports = { errorTag, scrubError };
