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
//     its slot ONLY once the session is confirmed gone (Codex #4971 r25 P2):
//     the count drops after destroy completes, never before. A destroy that
//     rejects or does not finish within `connectMs` is followed by a forced
//     close of the underlying socket (which ends the Postgres session and
//     every advisory lock it held); only if that is impossible too does the
//     slot stay occupied, loudly — a slot that cannot be proven free is
//     never handed out again, so the cap can never be exceeded.
//
// A timed-out attempt keeps its slot until the underlying connect actually
// settles (codex #4293 P1 r8): the timer winning the race proves nothing about
// the socket, and freeing the slot on the timer alone let a burst of slow
// connects each release theirs while the real sockets stayed open. A late
// connection is destroyed — ITS destroy frees the slot — and a late rejection
// frees it directly.
const db = require('../models/db');

const CONNECT_TIMED_OUT = 'raw connection connect timed out';
const CLOSE_TIMED_OUT = 'raw connection close timed out';

// Last resort when the driver's own close fails or hangs: destroy the TCP
// socket under the connection (pg: client.connection.stream). The server
// ends the session as soon as the socket drops. true = a socket was found
// and destroyed.
function forceCloseSocket(connection) {
  const stream = connection?.connection?.stream || connection?.stream || null;
  if (!stream || typeof stream.destroy !== 'function') return false;
  try {
    stream.destroy();
    return true;
  } catch {
    return false;
  }
}

function rawConnectionSlots({ max, connectMs, logPrefix }) {
  let open = 0;
  let unconfirmed = 0;

  // true once the session is confirmed gone: the driver closed it, or its
  // socket was force-closed after the driver's close failed / hung.
  async function closeConfirmed(connection) {
    let timer = null;
    try {
      await Promise.race([
        Promise.resolve(db.client.destroyRawConnection(connection)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(CLOSE_TIMED_OUT)), connectMs); }),
      ]);
      return true;
    } catch (err) {
      require('./logger').warn(`${logPrefix} close failed (${err.code || err.name || 'error'})`);
      return forceCloseSocket(connection);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function release(connection, counted = true) {
    if (!connection) {
      if (counted) open -= 1;
      return;
    }
    const closed = await closeConfirmed(connection);
    if (!counted) return;
    if (closed) {
      open -= 1;
      return;
    }
    unconfirmed += 1;
    require('./logger').error(`${logPrefix} could not be confirmed closed — its slot stays occupied (${unconfirmed} unconfirmed, ${open}/${max} in use)`);
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

  return { acquire, release, openCount: () => open, unconfirmedCount: () => unconfirmed };
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
