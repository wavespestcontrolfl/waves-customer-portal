/**
 * customer-dedupe — duplicate-customer detection, tiering, and merge executor.
 *
 * Duplicates are grouped by normalized 10-digit phone, then tiered:
 *   green  — names compatible (equal, or one side empty/"Unknown"), addresses
 *            compatible (normalized street key match, or the loser has none),
 *            and the losing row is a shell (no Stripe/billing/portal
 *            artifacts). Safe to auto-merge on the gated cron.
 *   yellow — anything ambiguous: name conflicts, address disagreement (often a
 *            genuine multi-property customer — offer link-as-property, not
 *            merge), unit/zip conflicts, or billing on the losing row. Surfaces
 *            in the /admin/customers/duplicates review queue.
 *   red    — different last names AND different addresses on a shared line:
 *            almost certainly two people. Report-only; never one-click merged.
 *
 * The merge executor discovers every FK column referencing customers(id) from
 * information_schema at run time (110+ tables and growing — a hardcoded list
 * would rot silently) and repoints each inside one transaction. The losing row
 * is soft-deleted with its phone/email replaced by sentinels, because intake
 * phone lookups (webhook, call pipeline) match on raw phone and do not all
 * filter deleted_at — a merged-away row must never be matchable again. The
 * full original row is preserved in customer_merge_journal.
 */
const db = require('../models/db');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function phone10(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// Suffix and directional words are identity-bearing ("100 Oak St" is not
// "100 Oak Ave"; "100 1st St N" is not "100 1st St S") — so they are
// CANONICALIZED, never dropped: every spelled-out variant maps to its short
// form and the whole street is squashed so spacing variants ("De Soto" vs
// "Desoto") compare equal. Real prod pairs pinned in tests: "221 36th St NE"
// ≡ "221 36th Street Northeast", "5350 Desoto Rd" ≡ "5350 De Soto Rd Apt
// 1418" (same key, unit captured separately). A missing-vs-present suffix or
// directional now reads as a conflict — that fails toward the review queue,
// never toward an auto-merge.
const STREET_WORD_CANON = {
  street: 'st', str: 'st',
  avenue: 'ave', av: 'ave',
  road: 'rd', drive: 'dr', lane: 'ln', court: 'ct',
  circle: 'cir', terrace: 'ter', trail: 'trl', boulevard: 'blvd',
  place: 'pl', parkway: 'pkwy', highway: 'hwy', glen: 'gln',
  cove: 'cv', point: 'pt', bend: 'bnd', crossing: 'xing',
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
};
const UNIT_RE = /\b(?:apt|apartment|unit|ste|suite|lot|bldg|building|trlr|rm)\s*#?\s*([a-z0-9]+)\b/;

function normalizeStreetKey(raw) {
  if (!raw) return null;
  let s = String(raw).toLowerCase()
    .replace(/[.,#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let unit = null;
  const unitMatch = s.match(UNIT_RE);
  if (unitMatch) {
    unit = unitMatch[1];
    s = s.replace(unitMatch[0], ' ').replace(/\s+/g, ' ').trim();
  }
  const m = s.match(/^(\d+[a-z]?)\s+(.+)$/);
  if (!m) return null;
  const number = m[1];
  const words = m[2].split(' ').filter(Boolean).map((w) => STREET_WORD_CANON[w] || w);
  if (!words.length) return null;
  return { key: `${number} ${words.join('')}`, unit };
}

function normName(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return (v === 'unknown' || v === 'n/a' || v === 'na') ? '' : v;
}

// Compatible = equal or one side missing. "Trent Ryles" vs "Trent Ryals" is a
// conflict on purpose — typo-variants go to the review queue, never auto-merge.
function namesCompatible(a, b) {
  const ok = (x, y) => !x || !y || x === y;
  return ok(normName(a.first_name), normName(b.first_name))
    && ok(normName(a.last_name), normName(b.last_name));
}

function addressCompat(winner, loser) {
  const wk = normalizeStreetKey(winner.address_line1);
  const lk = normalizeStreetKey(loser.address_line1);
  if (!lk && !wk) return { status: 'both_missing' };
  if (!lk) return { status: 'loser_missing' };
  if (!wk) return { status: 'winner_missing' };
  if (wk.key !== lk.key) return { status: 'conflict' };
  if (wk.unit && lk.unit && wk.unit !== lk.unit) return { status: 'unit_conflict' };
  const wz = String(winner.zip || '').slice(0, 5);
  const lz = String(loser.zip || '').slice(0, 5);
  if (wz && lz && wz !== lz) return { status: 'zip_conflict' };
  // ZIP is nullable — when it can't disambiguate, the city must: the same
  // street key exists in multiple service-area cities (100 Main St Bradenton
  // vs Sarasota are different properties).
  if (!(wz && lz)) {
    const wc = String(winner.city || '').trim().toLowerCase();
    const lc = String(loser.city || '').trim().toLowerCase();
    if (wc && lc && wc !== lc) return { status: 'city_conflict' };
  }
  return { status: 'match' };
}

const ADDRESS_COMPATIBLE = new Set(['match', 'loser_missing', 'winner_missing', 'both_missing']);
// Every way two addresses can be POSITIVELY different (as opposed to merely
// unknown). Any of these plus differing last names = two people = red.
const ADDRESS_CONFLICTS = new Set(['conflict', 'unit_conflict', 'zip_conflict', 'city_conflict']);

// ---------------------------------------------------------------------------
// Hard blockers — what makes a losing row NOT a shell
// ---------------------------------------------------------------------------

// Row counts in any of these tables mean the loser has real business history.
// Green (auto) refuses ALL of them; manual merges repoint them (that is the
// point of a merge) but still refuse the both-have-Stripe case below.
const AUTO_BLOCKER_TABLES = [
  'payment_methods', 'invoices', 'payments', 'scheduled_services',
  'service_records', 'customer_contracts', 'annual_prepay_terms',
  'estimate_deposits', 'estimate_card_holds', 'termite_bonds',
  'customer_credit_ledger',
];

// Batched: one grouped count per table for the whole candidate set, not one
// query per (loser, table) — detection runs on dashboard/API paths.
async function batchAutoBlockers(database, losers) {
  const byId = new Map(losers.map((l) => [l.id, []]));
  for (const loser of losers) {
    if (loser.stripe_customer_id) byId.get(loser.id).push('stripe_customer_id');
    if (loser.password_hash) byId.get(loser.id).push('portal_login');
  }
  const ids = [...byId.keys()];
  if (!ids.length) return byId;
  for (const table of AUTO_BLOCKER_TABLES) {
    try {
      const rows = await database(table).whereIn('customer_id', ids)
        .groupBy('customer_id').select('customer_id').count('* as n');
      for (const row of rows) {
        if (Number(row.n) > 0 && byId.has(row.customer_id)) byId.get(row.customer_id).push(table);
      }
    } catch (e) {
      // Fail closed: a table we can't check is a table we can't clear.
      logger.warn(`[customer-dedupe] blocker check failed on ${table}: ${e.message}`);
      ids.forEach((id) => byId.get(id).push(`${table} (check failed)`));
    }
  }
  return byId;
}

async function loserAutoBlockers(database, loser) {
  const map = await batchAutoBlockers(database, [loser]);
  return map.get(loser.id) || [];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function winnerScore(row) {
  return (row.stripe_customer_id ? 8 : 0)
    + (row.password_hash ? 4 : 0)
    + (row.pipeline_stage === 'active_customer' ? 2 : 0);
}

function pickWinner(rows) {
  return [...rows].sort((a, b) =>
    (winnerScore(b) - winnerScore(a)) || (new Date(a.created_at) - new Date(b.created_at)))[0];
}

function pairKey(idA, idB) {
  return idA < idB ? [idA, idB] : [idB, idA];
}

// Detection output travels to the admin browser via the review-queue route —
// never ship the stored credential hash or raw Stripe id; the UI only needs
// existence booleans for its badges.
function sanitizeCustomer(row) {
  const { password_hash: passwordHash, stripe_customer_id: stripeCustomerId, ...rest } = row;
  return { ...rest, has_portal_login: !!passwordHash, has_stripe: !!stripeCustomerId };
}

async function findDuplicateGroups(database = db) {
  // Live rows only (active + not deleted, mirroring whereLiveCustomer): a
  // churned inactive record must never be picked as a winner — its Stripe/
  // portal signals would outrank a NEW active shell and the merge would
  // retire the active row into a customer hidden from live surfaces.
  const rows = await database('customers')
    .where('active', true)
    .whereNull('deleted_at')
    .whereRaw("COALESCE(phone, '') <> ''")
    .select('id', 'first_name', 'last_name', 'email', 'phone', 'address_line1',
      'address_line2', 'city', 'zip', 'stripe_customer_id', 'password_hash',
      'pipeline_stage', 'lead_source', 'created_at');
  const byPhone = new Map();
  for (const row of rows) {
    const p10 = phone10(row.phone);
    if (!p10) continue;
    if (!byPhone.has(p10)) byPhone.set(p10, []);
    byPhone.get(p10).push(row);
  }

  // Fail-open: an unreadable dismissals table only means an adjudicated pair
  // re-appears in the queue — never hide detection behind it.
  let dismissed = new Set();
  try {
    dismissed = new Set(
      (await database('customer_duplicate_dismissals').select('customer_id_a', 'customer_id_b'))
        .map((d) => `${d.customer_id_a}:${d.customer_id_b}`),
    );
  } catch (e) {
    logger.warn(`[customer-dedupe] dismissals read failed (continuing without): ${e.message}`);
  }

  // Batch the blocker lookups across every group's losers up front.
  const allLosers = [];
  for (const members of byPhone.values()) {
    if (members.length < 2) continue;
    const winner = pickWinner(members);
    members.forEach((m) => { if (m.id !== winner.id) allLosers.push(m); });
  }
  const blockersById = await batchAutoBlockers(database, allLosers);

  const groups = [];
  for (const [p10, members] of byPhone) {
    if (members.length < 2) continue;
    const winner = pickWinner(members);
    const candidates = [];
    for (const loser of members) {
      if (loser.id === winner.id) continue;
      const [a, b] = pairKey(winner.id, loser.id);
      if (dismissed.has(`${a}:${b}`)) continue;
      const addr = addressCompat(winner, loser);
      const namesOk = namesCompatible(winner, loser);
      const blockers = blockersById.get(loser.id) || [];
      const reasons = [];
      if (!namesOk) reasons.push('name_conflict');
      if (!ADDRESS_COMPATIBLE.has(addr.status)) reasons.push(`address_${addr.status}`);
      blockers.forEach((blocker) => reasons.push(`loser_has_${blocker}`));

      let tier = 'green';
      const lastNamesDiffer = normName(winner.last_name) && normName(loser.last_name)
        && normName(winner.last_name) !== normName(loser.last_name);
      // Different last name at a POSITIVELY different address (different
      // street, unit, ZIP, or city) = two people sharing a line.
      if (lastNamesDiffer && ADDRESS_CONFLICTS.has(addr.status)) tier = 'red';
      else if (reasons.length) tier = 'yellow';

      candidates.push({
        loser: sanitizeCustomer(loser),
        tier,
        reasons,
        evidence: { phone10: p10, names_compatible: namesOk, address: addr.status },
      });
    }
    // Once the phone is known to belong to conflicting identities (any red
    // pair or name conflict in the group), an address-less/"Unknown" shell is
    // no longer safely attributable to the picked winner — it could be the
    // OTHER person. Demote greens to review; only clean groups auto-merge.
    if (candidates.some((c) => c.tier === 'red' || c.reasons.includes('name_conflict'))) {
      for (const c of candidates) {
        if (c.tier === 'green') {
          c.tier = 'yellow';
          c.reasons.push('group_has_identity_conflict');
        }
      }
    }
    if (candidates.length) groups.push({ phone10: p10, winner: sanitizeCustomer(winner), candidates });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Merge executor
// ---------------------------------------------------------------------------

// Never repointed: the journal must keep pointing at the historical loser, a
// dismissal pair must not collapse into a self-pair.
const REPOINT_EXCLUDED_TABLES = new Set(['customer_merge_journal', 'customer_duplicate_dismissals']);

// One-row-per-customer preference tables: when both sides have a row, the
// loser's row can't just be dropped — it may hold opted-OUT notification
// consent or gate/pet/safety details the winner's row lacks. Boolean
// semantics differ by table:
//   notification_prefs   — booleans are CONSENT: AND (false/opted-out wins, a
//                          merge can never widen consent). Its *_channel
//                          strings (sms|email|both) take the LEAST-SMS value
//                          (email > sms > both) so an explicit email-only
//                          choice on either row can never resume SMS.
//   property_preferences — booleans are FACTS (irrigation_system, ...): OR
//                          (known-true survives; dropping a safety fact is
//                          the failure mode).
// Everything else: empty winner fields fill from the loser, then the loser's
// row is removed. Anything not copied survives in the journal snapshot.
const SINGLETON_BOOLEAN_SEMANTICS = { notification_prefs: 'and', property_preferences: 'or' };
const CHANNEL_RESTRICTIVENESS = { email: 2, sms: 1, both: 0 };

async function mergeSingletonPrefRow(trx, table, column, winnerId, loserId) {
  const loserRow = await trx(table).where(column, loserId).first();
  if (!loserRow) return 'no loser row';
  const winnerRow = await trx(table).where(column, winnerId).first();
  if (!winnerRow) {
    const count = await trx(table).where(column, loserId).update({ [column]: winnerId });
    return count;
  }
  const booleanMode = SINGLETON_BOOLEAN_SEMANTICS[table] || 'and';
  const updates = {};
  for (const [col, loserVal] of Object.entries(loserRow)) {
    if (['id', column, 'created_at', 'updated_at'].includes(col)) continue;
    const winnerVal = winnerRow[col];
    if (typeof loserVal === 'boolean' && typeof winnerVal === 'boolean') {
      if (booleanMode === 'and' && winnerVal && !loserVal) updates[col] = false;
      if (booleanMode === 'or' && !winnerVal && loserVal) updates[col] = true;
    } else if (
      table === 'notification_prefs' && col.endsWith('_channel')
      && CHANNEL_RESTRICTIVENESS[winnerVal] !== undefined && CHANNEL_RESTRICTIVENESS[loserVal] !== undefined
    ) {
      if (CHANNEL_RESTRICTIVENESS[loserVal] > CHANNEL_RESTRICTIVENESS[winnerVal]) updates[col] = loserVal;
    } else if ((winnerVal === null || winnerVal === '') && loserVal !== null && loserVal !== '') {
      updates[col] = loserVal;
    }
  }
  if (Object.keys(updates).length) {
    await trx(table).where(column, winnerId).update({ ...updates, updated_at: trx.fn.now() });
  }
  await trx(table).where(column, loserId).del();
  return `merged ${Object.keys(updates).length} fields into winner row, dropped loser row`;
}

// customer_properties carries two partial uniques — one primary per customer,
// one active row per (customer, address_key). Repoint row-by-row: demote the
// loser's properties from primary (the winner keeps its own primary), and an
// address the winner already has active comes across deactivated instead of
// colliding (the winner's copy of that address is the live one).
async function repointCustomerProperties(trx, table, column, winnerId, loserId) {
  const rows = await trx(table).where(column, loserId).select('id');
  let moved = 0;
  let deactivated = 0;
  for (const { id } of rows) {
    try {
      await trx.transaction(async (sp) => {
        await sp(table).where({ id }).update({ [column]: winnerId, is_primary: false });
      });
      moved += 1;
    } catch (e) {
      if (!(e && e.code === '23505')) throw e;
      await trx(table).where({ id }).update({ [column]: winnerId, is_primary: false, active: false });
      deactivated += 1;
    }
  }
  return `moved ${moved}, deactivated ${deactivated} (winner already had the address)`;
}

const UNIQUE_COLLISION_HANDLERS = {
  notification_prefs: mergeSingletonPrefRow,
  property_preferences: mergeSingletonPrefRow,
  customer_properties: repointCustomerProperties,
};

let fkColumnsCache = null;
async function customerFkColumns(database) {
  if (fkColumnsCache) return fkColumnsCache;
  // Union of (a) DECLARED foreign keys referencing customers(id) — catches
  // differently-named columns like referred_by_customer_id — and (b) any
  // customer_id column on a base table, because several customer-owned
  // tables in this repo (payment_plans, customer_discounts, ...) store
  // customer_id WITHOUT a declared FK and would otherwise stay attached to
  // the retired row after a merge.
  const result = await database.raw(`
    SELECT DISTINCT table_name, column_name FROM (
      SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND ccu.table_name = 'customers' AND ccu.column_name = 'id'
      UNION
      SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND c.column_name = 'customer_id' AND c.table_name <> 'customers'
    ) refs
    ORDER BY table_name, column_name`);
  fkColumnsCache = result.rows.filter((r) => !REPOINT_EXCLUDED_TABLES.has(r.table_name));
  return fkColumnsCache;
}

// Contact/identity fields copied onto the winner ONLY where the winner's value
// is empty. Deliberately excludes money/tier fields (waveguard_tier,
// monthly_rate) and property measurements — those are business decisions, not
// contact data.
const BACKFILL_FIELDS = [
  'first_name', 'last_name', 'email', 'address_line1', 'address_line2',
  'city', 'state', 'zip', 'lead_source', 'lead_source_detail', 'preferred_language',
];

function isEmptyValue(v) {
  return v === null || v === undefined || String(v).trim() === ''
    || normName(v) === '';
}

/**
 * Merge `loserId` into `winnerId`. Everything runs in one transaction; any
 * conflict aborts the whole merge (the pair stays in the review queue).
 *
 * mode 'auto'   — re-verifies the full green-tier guard inside the txn.
 * mode 'manual' — allows repointing billing history, but still refuses when
 *                 BOTH rows carry a Stripe customer (that must be resolved in
 *                 Stripe first — two payment profiles cannot be repointed).
 */
async function executeMerge({ winnerId, loserId, performedBy, mode = 'manual', evidence = {} }) {
  if (!winnerId || !loserId || winnerId === loserId) {
    throw new Error('executeMerge: winnerId and loserId must be distinct');
  }
  return db.transaction(async (trx) => {
    const locked = await trx('customers').whereIn('id', [winnerId, loserId]).forUpdate().select('*');
    const winner = locked.find((r) => r.id === winnerId);
    const loser = locked.find((r) => r.id === loserId);
    if (!winner || !loser) throw new Error('executeMerge: customer not found');
    if (winner.deleted_at || loser.deleted_at) throw new Error('executeMerge: refusing to merge a deleted customer');
    // The surviving row must be live: retiring an active customer into an
    // inactive winner would hide them from every live-customer surface.
    if (winner.active === false) throw new Error('executeMerge: winner is inactive — reactivate it first or keep the other row');

    if (winner.stripe_customer_id && loser.stripe_customer_id
      && winner.stripe_customer_id !== loser.stripe_customer_id) {
      throw new Error('executeMerge: both customers have Stripe profiles — resolve in Stripe first');
    }
    if (mode === 'auto') {
      const blockers = await loserAutoBlockers(trx, loser);
      if (blockers.length) throw new Error(`executeMerge(auto): loser is not a shell (${blockers.join(', ')})`);
      if (!namesCompatible(winner, loser)) throw new Error('executeMerge(auto): names conflict');
      const addr = addressCompat(winner, loser);
      if (!ADDRESS_COMPATIBLE.has(addr.status)) throw new Error(`executeMerge(auto): address ${addr.status}`);
    }

    // Repoint every FK. Each table gets its own savepoint (knex nested
    // transaction) so a unique-collision on a droppable singleton can be
    // handled without poisoning the outer transaction.
    const repointed = {};
    const fks = await customerFkColumns(trx);
    for (const { table_name: table, column_name: column } of fks) {
      try {
        await trx.transaction(async (sp) => {
          const count = await sp(table).where(column, loserId).update({ [column]: winnerId });
          if (count) repointed[`${table}.${column}`] = count;
        });
      } catch (e) {
        const uniqueViolation = e && e.code === '23505';
        const handler = UNIQUE_COLLISION_HANDLERS[table];
        if (uniqueViolation && handler) {
          repointed[`${table}.${column}`] = await handler(trx, table, column, winnerId, loserId);
        } else {
          throw new Error(`executeMerge: repoint failed on ${table}.${column}: ${e.message}`);
        }
      }
    }
    // Repointing referred_by can produce a self-referral if the loser had
    // referred the winner; a customer can't be their own referrer.
    await trx('customers').where({ id: winnerId, referred_by_customer_id: winnerId })
      .update({ referred_by_customer_id: null });

    // Retire the loser's contact identity BEFORE backfilling the winner, so a
    // shared email can move over without tripping any uniqueness. Phone is
    // NOT NULL, so it gets an unmatchable sentinel; the journal snapshot keeps
    // the real values.
    await trx('customers').where({ id: loserId }).update({
      phone: `merged-${String(loserId).slice(0, 8)}`,
      email: null,
      active: false,
      deleted_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    });

    const backfills = {};
    for (const field of BACKFILL_FIELDS) {
      if (isEmptyValue(winner[field]) && !isEmptyValue(loser[field])) backfills[field] = loser[field];
    }
    if (Object.keys(backfills).length) {
      await trx('customers').where({ id: winnerId }).update({ ...backfills, updated_at: trx.fn.now() });
    }

    const [journal] = await trx('customer_merge_journal').insert({
      winner_customer_id: winnerId,
      loser_customer_id: loserId,
      loser_snapshot: JSON.stringify(loser),
      repointed: JSON.stringify(repointed),
      winner_backfills: JSON.stringify(backfills),
      tier: mode === 'auto' ? 'green' : 'manual',
      evidence: JSON.stringify(evidence),
      performed_by: performedBy || 'unknown',
    }).returning('id');

    logger.info(`[customer-dedupe] merged ${loserId} -> ${winnerId} (${mode}, journal ${journal?.id || journal})`);
    // loserSnapshot lets callers act on the retired row post-commit (e.g. the
    // link-as-property route preserves the loser's address on the winner).
    return { journalId: journal?.id || journal, repointed, backfills, loserSnapshot: loser };
  });
}

// ---------------------------------------------------------------------------
// Auto-merge sweep (cron entry point — caller owns the feature gate)
// ---------------------------------------------------------------------------

async function runAutoMergeSweep({ performedBy = 'auto:dedupe-cron' } = {}) {
  const groups = await findDuplicateGroups();
  const results = { merged: [], skipped: [] };
  for (const group of groups) {
    for (const candidate of group.candidates) {
      if (candidate.tier !== 'green') {
        results.skipped.push({ loserId: candidate.loser.id, tier: candidate.tier, reasons: candidate.reasons });
        continue;
      }
      try {
        await executeMerge({
          winnerId: group.winner.id,
          loserId: candidate.loser.id,
          performedBy,
          mode: 'auto',
          evidence: candidate.evidence,
        });
        results.merged.push({ winnerId: group.winner.id, loserId: candidate.loser.id });
        try {
          const name = [group.winner.first_name, group.winner.last_name].filter(Boolean).join(' ') || 'Unknown';
          await require('./notification-service').notifyAdmin(
            'customer',
            'Duplicate customer auto-merged',
            `Merged a duplicate row into ${name} (same phone, matching identity, no billing on the duplicate). Reversible — full snapshot in the merge journal.`,
            {
              link: `/admin/customers/${group.winner.id}`,
              metadata: { winnerId: group.winner.id, loserId: candidate.loser.id },
            },
          );
        } catch (notifyErr) {
          logger.warn(`[customer-dedupe] merge notify failed (non-blocking): ${notifyErr.message}`);
        }
      } catch (e) {
        // A failed green merge means the row changed under us — leave it for
        // the next sweep / the review queue rather than retrying in-loop.
        logger.warn(`[customer-dedupe] auto-merge ${candidate.loser.id} -> ${group.winner.id} failed: ${e.message}`);
        results.skipped.push({ loserId: candidate.loser.id, tier: 'green', reasons: [`merge_failed: ${e.message}`] });
      }
    }
  }
  return results;
}

module.exports = {
  findDuplicateGroups,
  executeMerge,
  runAutoMergeSweep,
  // exported for tests
  _test: {
    phone10,
    normalizeStreetKey,
    namesCompatible,
    addressCompat,
    pickWinner,
    isEmptyValue,
    mergeSingletonPrefRow,
    resetFkCache: () => { fkColumnsCache = null; },
  },
};
