// Bounded UNPOOLED database sessions — lifted from reschedule-link-promises.js
// (its send interlock, codex #4293) so every raw-connection user shares one
// mechanism. A session that must outlive a pooled transaction (a session
// advisory lock held while the flow it guards opens pooled transactions)
// runs on its own connection outside DB_POOL_MAX, so it has to be bounded in
// both count and time: an unbounded burst of raw connections exhausts the
// database's slots, and a connect that never returns hangs the caller.
//
// rawConnectionSlots({ max, connectMs, logPrefix }) returns:
//   acquire() — a raw connection (db.client.acquireRawConnection: the SAME
//     connectionSettings, SSL and search_path the pool's connections get), or
//     null when all `max` slots are taken or the connect has not finished
//     within `connectMs`. The caller decides what null means (a retry, or an
//     ordinary path without the session).
//   release(connection, counted = true) — destroys the connection and frees
//     its slot.
//
// A timed-out attempt keeps its slot until the underlying connect actually
// settles (codex #4293 P1 r8): the timer winning the race proves nothing about
// the socket, and freeing the slot on the timer alone let a burst of slow
// connects each release theirs while the real sockets stayed open. A late
// connection is destroyed — ITS destroy frees the slot — and a late rejection
// frees it directly.
const db = require('../models/db');

const CONNECT_TIMED_OUT = 'raw connection connect timed out';

function rawConnectionSlots({ max, connectMs, logPrefix }) {
  let open = 0;

  async function release(connection, counted = true) {
    if (counted) open -= 1;
    if (!connection) return;
    await db.client.destroyRawConnection(connection).catch((err) => {
      require('./logger').warn(`${logPrefix} close failed (${err.code || err.name || 'error'})`);
    });
  }

  async function acquire() {
    if (open >= max) {
      require('./logger').warn(`${logPrefix} at its connection cap (${max})`);
      return null;
    }
    open += 1;
    let timer = null;
    let opening = null;
    try {
      opening = Promise.resolve(db.client.acquireRawConnection());
      return await Promise.race([
        opening,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(CONNECT_TIMED_OUT)), connectMs); }),
      ]);
    } catch (err) {
      if (err.message === CONNECT_TIMED_OUT) {
        opening.then((late) => release(late), () => { open -= 1; });
      } else {
        // acquireRawConnection() itself rejected before the timer fired.
        open -= 1;
      }
      require('./logger').warn(`${logPrefix} connection unavailable (${err.code || err.name || 'error'})`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { acquire, release, openCount: () => open };
}

// A dedicated raw connection's own error/end/close events are the one
// authority for "is this session still held" — lifted from
// reschedule-link-promises.js's send interlock (codex #4293) so every
// session-lock user shares one mechanism (Codex #4971 r15 P1: the
// parent-decision lock session adopted this too). Postgres releases every
// advisory lock a session held the instant its connection drops; nothing
// else observes that on its own — an AsyncLocalStorage context (or any
// other in-memory "I'm holding this" flag) keeps believing the lock is held
// long after the session that actually took it is gone. `held` is the
// caller's own { lost: boolean } — mutated in place, never replaced, so a
// caller that already threads it through nested closures keeps working
// unchanged.
function trackConnectionLoss(connection, held) {
  if (typeof connection?.on !== 'function') return;
  const lost = () => { held.lost = true; };
  for (const event of ['error', 'end', 'close']) connection.on(event, lost);
}

module.exports = { rawConnectionSlots, trackConnectionLoss };
