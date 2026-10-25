/**
 * GATE_AUTO_DISPATCH_KEEP_TECH (owner 2026-10-25): the commit-time backstop
 * for "each visit stays with its own technician".
 *
 * candidate-slots.js already drops other technicians' slots for a visit that
 * has a technician (`other_tech`). This is the second fence at the write:
 * apply.js refuses an auto-dispatch move that would change a visit's
 * technician when `config.keepTech` is on, before anything is written.
 * A visit with no technician is never fenced. Gate off: nothing here runs.
 */
const TECH_CHANGE_BLOCKED = 'TECH_CHANGE_BLOCKED';

const techChangeBlocked = () => Object.assign(
  new Error('Cannot auto-move this stop to another technician: the visit stays with its own technician'),
  { statusCode: 409, code: TECH_CHANGE_BLOCKED, isOperational: true },
);

// The audit reason for an apply that the fence refused, else null. Nothing was
// written, so the visit stays and the next run scores it again.
function techChangeRefusal(err) {
  if (!err || err.code !== TECH_CHANGE_BLOCKED || err.movedCount) return null;
  return {
    reason_code: TECH_CHANGE_BLOCKED,
    reason_description: 'Keep-technician rule: the move would change the visit\'s technician; the visit stays where it is',
  };
}

module.exports = { TECH_CHANGE_BLOCKED, techChangeBlocked, techChangeRefusal };
