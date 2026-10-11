// stripe_orphan_charges.source for a charge the Intelligence Bar made: the base source plus the id of the confirmed bar
// action that made it (':ib:<id>', at most 64 characters, the column's width), so the bar's daily cap counts exactly its
// own orphans. Any other charge keeps the base source. No dependencies, so a test that mocks other services still loads it.
const BAR_ORPHAN_SOURCE_MARK = ':ib:';

function orphanSourceFor(base, ibActionId) {
  if (!ibActionId) return base;
  return `${base}${BAR_ORPHAN_SOURCE_MARK}${String(ibActionId).slice(0, 36)}`.slice(0, 64);
}

module.exports = { BAR_ORPHAN_SOURCE_MARK, orphanSourceFor };
