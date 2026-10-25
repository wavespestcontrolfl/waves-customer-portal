/**
 * Merge one neighborhood gate-code entry into another (GATE_NEIGHBORHOOD_MERGE,
 * owner ruling 2026-10-25).
 *
 * The directory makes one entry per county plat name, so one gated community
 * can show up several times ("Country Club East Lwr", "Country Club East at
 * Lakewood Ranch") and a code saved on one never reaches stops on the others.
 * The office merges an entry (the source) into another of the same county
 * (the target):
 *
 *  - every home, gate entry and filing-ledger row on the source moves to the
 *    target;
 *  - a live code both hold is kept once: the one confirmed more recently stays,
 *    the other is retired;
 *  - when the target keeps a live entry of its own, each moved live entry's
 *    label names where it came from ("Main gate (Cove at Twin Rivers)"), so the
 *    office can tell two gates' codes apart; statuses never change;
 *  - the source stays as an inactive row pointing at the target, under its own
 *    name, so lockCommunity (neighborhood-access.js) sends a new home with that
 *    name to the target.
 *
 * Each merge writes a neighborhood_merges row with the journal its undo needs.
 * Undo puts back what the merge moved and nobody changed since (an entry the
 * office edited after the merge stays where it is), and switches the source
 * back on. A merge whose target was merged again is undone after that later one.
 *
 * Lock order (the property writers' order, then the directory's): the source's
 * community advisory lock (so a county upsert of its name waits, then reads the
 * pointer), each affected customer's preference advisory lock and row, the
 * properties, both neighborhood rows by id, then their entries. Callers run
 * this inside a transaction that yields (lock_timeout + retry), so a merge
 * never makes a property, visit or billing write fail.
 *
 * Never log a code or a label — ids and counts only.
 */
const { communityLockKey } = require('./neighborhood-access');

const MAX_LABEL = 60;

async function lockCustomers(trx, customerIds) {
  const ids = [...new Set(customerIds.filter(Boolean))].sort();
  for (const id of ids) {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['property-preferences', String(id)]);
  }
  if (ids.length) await trx('customers').whereIn('id', ids).orderBy('id').forUpdate().select('id');
}

async function lockNeighborhoods(trx, ids) {
  const rows = await trx('neighborhoods').whereIn('id', [...new Set(ids)]).orderBy('id').forUpdate()
    .select('id', 'name', 'county', 'active', 'merged_into_id');
  return new Map(rows.map((r) => [r.id, r]));
}

const basis = (e) => new Date(e.last_confirmed_at || e.created_at).getTime();

function withOrigin(label, sourceName) {
  const full = `${label} (${sourceName})`;
  return full.length <= MAX_LABEL ? full : `${full.slice(0, MAX_LABEL - 2)}…)`;
}

// The live code both entries hold, kept once: the more recently confirmed
// copy stays (the target's on a tie). Returns the ids to retire.
function duplicateLosers(sourceLive, targetLive) {
  const targetByCode = new Map(targetLive.filter((e) => e.code).map((e) => [e.code.toLowerCase(), e]));
  const losers = [];
  for (const s of sourceLive) {
    const t = s.code && targetByCode.get(s.code.toLowerCase());
    if (t) losers.push(basis(s) > basis(t) ? t : s);
  }
  return losers;
}

// Re-read under the locks: both entries exist, differ, share a county and are
// live, unmerged directory entries.
function checkPair(source, target) {
  if (!source || !target) return 'not_found';
  if (source.id === target.id) return 'same';
  if ((source.county || null) !== (target.county || null)) return 'county';
  if (!source.active || source.merged_into_id || !target.active || target.merged_into_id) return 'not_live';
  return null;
}

// The journal keeps each row's updated_at as it was (Postgres text, microseconds
// intact): undo writes it back, so a row an undo restores reads as untouched to
// the earlier merge it came through (A into B, B into C, undo both in turn).
async function moveEntries(trx, source, targetId, sourceLive, targetLive) {
  // Read before anything is written, so every journaled stamp is the prior one.
  const all = await trx('neighborhood_access').where({ neighborhood_id: source.id })
    .select('id', 'gate_label', 'status', trx.raw('updated_at::text AS updated_at'));
  const entries = all.map((e) => ({ id: e.id, gate_label: e.gate_label, updated_at: e.updated_at }));
  const losers = duplicateLosers(sourceLive, targetLive);
  const retired = losers.map((e) => ({ id: e.id, status: e.status, updated_at: e.updated_at }));
  // Retire first: the live-code unique index would refuse the move otherwise.
  if (losers.length) {
    await trx('neighborhood_access').whereIn('id', losers.map((e) => e.id))
      .update({ status: 'retired', updated_at: trx.fn.now() });
  }
  const loserIds = new Set(losers.map((e) => e.id));
  const targetKeepsOwn = targetLive.some((e) => !loserIds.has(e.id));
  let relabeled = 0;
  for (const e of all) {
    const live = e.status !== 'retired' && !loserIds.has(e.id);
    const label = live && targetKeepsOwn ? withOrigin(e.gate_label, source.name) : e.gate_label;
    if (label !== e.gate_label) relabeled += 1;
    await trx('neighborhood_access').where({ id: e.id })
      .update({ neighborhood_id: targetId, gate_label: label, updated_at: trx.fn.now() });
  }
  const liveMoved = all.filter((e) => e.status !== 'retired' && !loserIds.has(e.id)).length;
  return { entries, retired, relabeled, liveMoved, duplicates: losers.length };
}

const pinned = (rows) => rows.some((e) => e.gate_lat != null);

/**
 * Returns { error } (not_found | same | county | not_live | pins) or
 * { mergeId, homes, entries, duplicatesRetired, relabeled }.
 */
async function mergeNeighborhood(trx, { sourceId, targetId, actorId = null }) {
  const peek = await trx('neighborhoods').where({ id: sourceId }).first('id', 'name', 'county');
  if (!peek) return { error: 'not_found' };
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [communityLockKey(peek.county, peek.name)]);
  const homeOwners = await trx('customer_properties').where({ neighborhood_id: sourceId }).pluck('customer_id');
  await lockCustomers(trx, homeOwners);
  await trx('customer_properties').where({ neighborhood_id: sourceId }).orderBy('id').forUpdate().select('id');

  const hoods = await lockNeighborhoods(trx, [sourceId, targetId]);
  const source = hoods.get(sourceId);
  const target = hoods.get(targetId);
  const refused = checkPair(source, target);
  if (refused) return { error: refused };

  const live = (id) => trx('neighborhood_access').where({ neighborhood_id: id }).whereNot('status', 'retired')
    .orderBy('id').forUpdate()
    .select('id', 'code', 'status', 'gate_lat', 'last_confirmed_at', 'created_at', trx.raw('updated_at::text AS updated_at'));
  const sourceLive = await live(sourceId);
  const targetLive = await live(targetId);
  // One pinned gate per neighborhood: the office clears one pin first.
  if (pinned(sourceLive) && pinned(targetLive)) return { error: 'pins' };

  const moved = await moveEntries(trx, source, targetId, sourceLive, targetLive);
  // The journal lists exactly the homes this update moved, with how each was
  // linked (source and checked-at), so undo leaves a home the office or the
  // county re-linked since.
  const homes = (await trx.raw(`UPDATE customer_properties SET neighborhood_id = ?, updated_at = now()
    WHERE neighborhood_id = ?
    RETURNING id, active, neighborhood_source, neighborhood_checked_at::text AS checked_at`, [targetId, sourceId])).rows;
  const filings = await trx('neighborhood_access_filings').where({ neighborhood_id: sourceId })
    .update({ neighborhood_id: targetId }).returning('customer_id');
  await trx('neighborhoods').where({ id: sourceId })
    .update({ active: false, merged_into_id: targetId, updated_at: trx.fn.now() });

  // Journal: properties [{ id, source, checked_at }], entries [{ id, gate_label,
  // updated_at }], retired [{ id, status, updated_at }], filings [customer_id].
  // Ids, labels, statuses and stamps only; never a code.
  const journal = {
    properties: homes.map((h) => ({ id: h.id, source: h.neighborhood_source, checked_at: h.checked_at })),
    entries: moved.entries,
    retired: moved.retired,
    filings: filings.map((f) => (typeof f === 'object' ? f.customer_id : f)),
  };
  const [row] = await trx('neighborhood_merges').insert({
    source_id: sourceId, target_id: targetId, journal: JSON.stringify(journal), merged_by: actorId,
  }).returning('id');
  return {
    mergeId: row.id ?? row,
    homes: homes.filter((h) => h.active).length,
    entries: moved.liveMoved,
    duplicatesRetired: moved.duplicates,
    relabeled: moved.relabeled,
  };
}

// The merge's own stamp: every row it wrote carries updated_at = merged_at
// (one transaction, one now()), so an equal stamp means nobody changed it since.
const UNCHANGED_SINCE = 'updated_at = (SELECT merged_at FROM neighborhood_merges WHERE id = ?)';

// A journaled stamp written back exactly; now() when the journal has none.
const priorStamp = (trx, text) => (text ? trx.raw('?::timestamptz', [text]) : trx.fn.now());

async function restoreEntries(trx, merge, journal) {
  const retiredPrior = new Map((journal.retired || []).map((r) => [r.id, r]));
  let back = 0;
  for (const e of journal.entries || []) {
    const restore = { neighborhood_id: merge.source_id, gate_label: e.gate_label, updated_at: priorStamp(trx, e.updated_at) };
    if (retiredPrior.has(e.id)) restore.status = retiredPrior.get(e.id).status;
    back += await trx('neighborhood_access')
      .where({ id: e.id, neighborhood_id: merge.target_id }).whereRaw(UNCHANGED_SINCE, [merge.id])
      .update(restore);
  }
  // The target's own copy the merge retired as a duplicate: live again when
  // untouched and no live copy of that code is there now.
  const moved = new Set((journal.entries || []).map((e) => e.id));
  for (const [id, prior] of retiredPrior) {
    if (moved.has(id)) continue;
    const row = await trx('neighborhood_access').where({ id, status: 'retired' }).whereRaw(UNCHANGED_SINCE, [merge.id])
      .first('id', 'neighborhood_id', 'code');
    if (!row) continue;
    const twin = row.code && await trx('neighborhood_access').where({ neighborhood_id: row.neighborhood_id })
      .whereNot('status', 'retired').whereRaw('lower(code) = lower(?)', [row.code]).first('id');
    if (!twin) await trx('neighborhood_access').where({ id }).update({ status: prior.status, updated_at: priorStamp(trx, prior.updated_at) });
  }
  return { back, total: (journal.entries || []).length };
}

/**
 * Returns { error } (not_found | undone | later | changed) or
 * { homes, homesKept, entries, entriesKept }. `later` carries laterName: the
 * entry the target was merged into since, whose merge is undone first.
 */
async function undoMerge(trx, { mergeId, actorId = null }) {
  const peek = await trx('neighborhood_merges as m').join('neighborhoods as s', 's.id', 'm.source_id')
    .where('m.id', mergeId).first('m.id', 'm.source_id', 'm.target_id', 'm.undone_at', 's.name', 's.county');
  if (!peek) return { error: 'not_found' };
  if (peek.undone_at) return { error: 'undone' };
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [communityLockKey(peek.county, peek.name)]);
  const merge = await trx('neighborhood_merges').where({ id: mergeId }).first();
  const journal = typeof merge.journal === 'string' ? JSON.parse(merge.journal) : merge.journal;
  const homes = journal.properties || [];
  const propertyIds = homes.map((p) => p.id);
  const owners = propertyIds.length ? await trx('customer_properties').whereIn('id', propertyIds).pluck('customer_id') : [];
  await lockCustomers(trx, owners);
  if (propertyIds.length) await trx('customer_properties').whereIn('id', propertyIds).orderBy('id').forUpdate().select('id');
  const hoods = await lockNeighborhoods(trx, [merge.source_id, merge.target_id]);
  const locked = await trx('neighborhood_merges').where({ id: mergeId }).forUpdate().first('undone_at');
  if (locked.undone_at) return { error: 'undone' };
  const source = hoods.get(merge.source_id);
  const target = hoods.get(merge.target_id);
  if (!source || !target || source.merged_into_id !== target.id) return { error: 'changed' };
  if (target.merged_into_id) {
    const later = await trx('neighborhoods').where({ id: target.merged_into_id }).first('name');
    return { error: 'later', laterName: later ? later.name : null };
  }

  const entries = await restoreEntries(trx, merge, journal);
  // A home goes back only while it is still linked the way the merge left it:
  // an office pick (even of the same entry) or a county re-link since stays.
  const homesBack = propertyIds.length
    ? (await trx.raw(`UPDATE customer_properties p SET neighborhood_id = ?, updated_at = now()
      FROM jsonb_to_recordset(?::jsonb) AS j(id uuid, source text, checked_at timestamptz)
      WHERE p.id = j.id AND p.neighborhood_id = ?
        AND p.neighborhood_source IS NOT DISTINCT FROM j.source
        AND p.neighborhood_checked_at IS NOT DISTINCT FROM j.checked_at
      RETURNING p.id, p.active`, [source.id, JSON.stringify(homes), target.id])).rows
    : [];
  if ((journal.filings || []).length) {
    await trx('neighborhood_access_filings').whereIn('customer_id', journal.filings).where({ neighborhood_id: target.id })
      .update({ neighborhood_id: source.id });
  }
  await trx('neighborhoods').where({ id: source.id }).update({ active: true, merged_into_id: null, updated_at: trx.fn.now() });
  await trx('neighborhood_merges').where({ id: mergeId }).update({ undone_at: trx.fn.now(), undone_by: actorId });
  return {
    homes: homesBack.filter((h) => h.active).length,
    homesKept: propertyIds.length - homesBack.length,
    entries: entries.back,
    entriesKept: entries.total - entries.back,
  };
}

// Each listed neighborhood's live merges (newest last): what the page offers
// to undo. Never the journal.
async function mergesInto(conn, targetIds) {
  if (!targetIds.length) return new Map();
  const rows = await conn('neighborhood_merges as m').join('neighborhoods as s', 's.id', 'm.source_id')
    .whereIn('m.target_id', targetIds).whereNull('m.undone_at')
    .orderBy([{ column: 'm.merged_at' }, { column: 's.name' }])
    .select('m.id', 'm.target_id', 'm.merged_at', 's.name');
  const byTarget = new Map();
  for (const r of rows) {
    const list = byTarget.get(r.target_id) || [];
    list.push({ mergeId: r.id, name: r.name, mergedAt: new Date(r.merged_at).toISOString() });
    byTarget.set(r.target_id, list);
  }
  return byTarget;
}

module.exports = { mergeNeighborhood, undoMerge, mergesInto, duplicateLosers, withOrigin };
