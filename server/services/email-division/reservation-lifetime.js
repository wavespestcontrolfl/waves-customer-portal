// The marketing ledger's reservation lease, in ONE place: the ledger settles a
// 'reserved' row older than this as abandoned, and the automation executor's
// stale-claim timer must outlast it (a crashed run reclaimed sooner would meet
// its own still-live reservation). Both read this value; neither restates it.
module.exports = { RESERVATION_LIFETIME_MS: 30 * 60 * 1000 };
