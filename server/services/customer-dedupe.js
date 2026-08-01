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
// Units may carry a hyphenated suffix letter ("Apt 12-B") that distinguishes
// separate properties — the hyphen survives until the unit is captured, then
// strips from the captured value so "12-B" ≡ "12B" but ≠ "12-C".
const UNIT_RE = /\b(?:apt|apartment|unit|ste|suite|lot|bldg|building|trlr|rm)\s*#?\s*([a-z0-9]+(?:-[a-z0-9]+)*)\b/;

function normalizeStreetKey(raw) {
  if (!raw) return null;
  let s = String(raw).toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let unit = null;
  const unitMatch = s.match(UNIT_RE);
  if (unitMatch) {
    unit = unitMatch[1].replace(/-/g, '');
    s = s.replace(unitMatch[0], ' ');
  }
  s = s.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
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

// A unit can live in address_line2 ("Apt 4", "#4", or a bare "4") instead of
// embedded in line1 — both must feed the unit comparison or same-building
// different-unit rows read as a clean match.
function unitFromLine2(line2) {
  if (!line2) return null;
  const s = String(line2).toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const m = s.match(UNIT_RE);
  if (m) return m[1].replace(/-/g, '');
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= 8 ? s.replace(/-/g, '') : null;
}

// Case-preserving unit substring from a raw address_line1 ("...Apt 1418" →
// "Apt 1418") — used when a merge must carry a loser-only unit onto a
// street-only winner's address_line2.
function rawUnitText(line1) {
  if (!line1) return null;
  const m = String(line1).match(/\b(?:apt|apartment|unit|ste|suite|lot|bldg|building|trlr|rm)\s*#?\s*[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\b/i);
  return m ? m[0].trim() : null;
}

function addressCompat(winner, loser) {
  const wRaw = String(winner.address_line1 || '').trim();
  const lRaw = String(loser.address_line1 || '').trim();
  const wk = normalizeStreetKey(winner.address_line1);
  const lk = normalizeStreetKey(loser.address_line1);
  // A NON-EMPTY address that doesn't parse (PO Box, lot name, no leading
  // street number) is not "missing" — it's an address we can't compare.
  // Identical raw strings still match; anything else fails toward review,
  // never toward an auto-merge. Not a positive conflict either: a PO Box vs
  // a street address can be the same person's mailing/service split, so it
  // must not feed the two-people red rule.
  if ((wRaw && !wk) || (lRaw && !lk)) {
    if (!lRaw) return { status: 'loser_missing' };
    if (!wRaw) return { status: 'winner_missing' };
    const squash = (s) => s.toLowerCase().replace(/\s+/g, ' ');
    return squash(wRaw) === squash(lRaw) ? { status: 'match' } : { status: 'unparsable' };
  }
  if (!lk && !wk) return { status: 'both_missing' };
  if (!lk) return { status: 'loser_missing' };
  if (!wk) return { status: 'winner_missing' };
  if (wk.key !== lk.key) return { status: 'conflict' };
  const wUnit = wk.unit || unitFromLine2(winner.address_line2);
  const lUnit = lk.unit || unitFromLine2(loser.address_line2);
  if (wUnit && lUnit && wUnit !== lUnit) return { status: 'unit_conflict' };
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
  // An assigned promo/referral/custom discount is billing state the discount
  // engine reads at invoice/estimate time — silently repointing one onto a
  // live account grants a discount nobody approved. Review queue instead.
  'customer_discounts',
];

// Batched: one grouped count per table for the whole candidate set, not one
// query per (loser, table) — detection runs on dashboard/API paths.
async function batchAutoBlockers(database, losers) {
  const byId = new Map(losers.map((l) => [l.id, []]));
  for (const loser of losers) {
    if (loser.stripe_customer_id) byId.get(loser.id).push('stripe_customer_id');
    if (loser.password_hash) byId.get(loser.id).push('portal_login');
    // A default third-party payer is billing state: invoice creation resolves
    // scheduled_service.payer_id ?? customers.payer_id, so silently retiring
    // a payer-linked row flips the merged account to self-pay and bills the
    // homeowner instead of the AP payer. Review-queue only; the manual path
    // transfers or refuses inside executeMerge.
    if (loser.payer_id) byId.get(loser.id).push('third_party_payer');
    // A non-null billing_mode (per_application / annual_prepay) is billing
    // state: the monthly cron reads NULL as legacy monthly membership, so
    // retiring the only row that carries the mode flips the merged account
    // to the wrong cadence. Review-queue only; the manual path transfers or
    // refuses inside executeMerge.
    if (loser.billing_mode) byId.get(loser.id).push('billing_mode');
    // A priced row (admin-set monthly_rate on a lead) carries accepted
    // billing terms the backfill deliberately does not copy — losing them
    // before the first invoice exists is unrecoverable. Review queue.
    if (Number(loser.monthly_rate) > 0) byId.get(loser.id).push('monthly_rate');
    // A live-stage row (any stage whereLiveCustomer treats as a real
    // customer — active, won, or at-risk) is never a disposable shell:
    // retiring it would drop account state (stage/tier/rate) the merge
    // deliberately does not copy. A won/at_risk row can carry pricing and
    // membership state before its first invoice exists. Also feeds winner
    // selection: live rows weigh like billed rows.
    if (REAL_CUSTOMER_STAGES.has(loser.pipeline_stage)) byId.get(loser.id).push('live_stage');
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

// The stages whereLiveCustomer treats as a real customer — mirrored here so
// blocker/winner logic can't drift from the live-customer definition.
const REAL_CUSTOMER_STAGES = new Set(['active_customer', 'won', 'at_risk']);

function winnerScore(row) {
  return (row.stripe_customer_id ? 8 : 0)
    + (row.password_hash ? 4 : 0)
    + (REAL_CUSTOMER_STAGES.has(row.pipeline_stage) ? 2 : 0);
}

// extraScore lets detection weight real business rows (invoices, scheduled
// services, ...) ABOVE the static column signals — a newer billed row must
// never lose to an older shell, because executeMerge deliberately backfills
// only contact fields and would retire the billed row's account state
// (tier/rate/member_since) with it.
function pickWinner(rows, extraScore = () => 0) {
  return [...rows].sort((a, b) =>
    ((winnerScore(b) + extraScore(b)) - (winnerScore(a) + extraScore(a)))
    || (new Date(a.created_at) - new Date(b.created_at)))[0];
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

async function findDuplicateGroups(database = db, { failClosedOnDismissals = false } = {}) {
  // Live ROWS only (active + not deleted) — deliberately NOT restricted to
  // whereLiveCustomer's real-customer stages: the duplicates this tool exists
  // to clean up ARE lead-stage shells (intake guards refuse ambiguous
  // linking and mint new_lead rows on repeat calls — every green shell in
  // the prod dry-run is one). Retiring a shell that duplicates a real
  // customer is the feature; identity compatibility + the shell blockers,
  // not pipeline stage, are what make it safe. The active/deleted filter
  // still matters: a churned inactive record must never be picked as a
  // winner — its Stripe/portal signals would outrank a NEW active shell and
  // the merge would retire the active row into a hidden customer.
  const rows = await database('customers')
    .where('active', true)
    .whereNull('deleted_at')
    .whereRaw("COALESCE(phone, '') <> ''")
    .select('id', 'first_name', 'last_name', 'email', 'phone', 'address_line1',
      'address_line2', 'city', 'zip', 'stripe_customer_id', 'password_hash',
      'pipeline_stage', 'lead_source', 'created_at', 'payer_id', 'billing_mode', 'monthly_rate');
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
    // Display fails OPEN (a dismissed pair reappearing in the queue is
    // annoying, not dangerous). The auto-WRITER fails CLOSED: merging blind
    // to operator "not a duplicate" verdicts is how a dismissed pair gets
    // auto-merged anyway.
    if (failClosedOnDismissals) throw e;
    logger.warn(`[customer-dedupe] dismissals read failed (continuing without): ${e.message}`);
  }

  // Batch the blocker lookups across every duplicate-phone member up front —
  // cross-identity candidates need them too, not just same-cluster losers.
  const allMembers = [];
  for (const members of byPhone.values()) {
    if (members.length >= 2) allMembers.push(...members);
  }
  const blockersById = await batchAutoBlockers(database, allMembers);

  const evaluatePair = (winner, loser) => {
    const addr = addressCompat(winner, loser);
    const namesOk = namesCompatible(winner, loser);
    const blockers = blockersById.get(loser.id) || [];
    const reasons = [];
    if (!namesOk) reasons.push('name_conflict');
    if (!ADDRESS_COMPATIBLE.has(addr.status)) reasons.push(`address_${addr.status}`);
    blockers.forEach((blocker) => reasons.push(`loser_has_${blocker}`));
    const lastNamesDiffer = normName(winner.last_name) && normName(loser.last_name)
      && normName(winner.last_name) !== normName(loser.last_name);
    let tier = 'green';
    // Different last name at a POSITIVELY different address (different
    // street, unit, ZIP, or city) = two people sharing a line.
    if (lastNamesDiffer && ADDRESS_CONFLICTS.has(addr.status)) tier = 'red';
    else if (reasons.length) tier = 'yellow';
    return { loser, tier, reasons, namesOk, addrStatus: addr.status };
  };

  const groups = [];
  for (const [p10, members] of byPhone) {
    if (members.length < 2) continue;
    // Partition the phone group into IDENTITY CLUSTERS: repeatedly pick the
    // strongest remaining row and pull in every name-compatible member.
    // Multiple clusters = the phone is shared by multiple identities. Each
    // cluster gets its own group + winner, so loser-vs-loser duplicates of a
    // second identity are surfaced and mergeable — not stuck behind a single
    // picked winner they conflict with.
    //
    // Cluster SEEDS must have a known name: a blank/"Unknown" row is
    // name-compatible with everyone, so seeding from it would collapse
    // genuinely distinct identities into one cluster and hide the conflict.
    // Unnamed rows attach to the single known identity when there is exactly
    // one; with multiple known identities they are unattributable and form
    // their own cluster, which flips multiIdentity and demotes everything to
    // review.
    // Weight = COUNT of business signals (billing tables + active stage),
    // excluding stripe/portal which winnerScore already weighs — a Stripe-only
    // shell (24 under a binary boost) must never outrank a row with actual
    // invoices/services.
    const businessBoost = (r) => 16 * (blockersById.get(r.id) || [])
      .filter((b) => b !== 'stripe_customer_id' && b !== 'portal_login').length;
    const hasKnownName = (m) => !!(normName(m.first_name) || normName(m.last_name));
    let pool = members.filter(hasKnownName);
    const unnamed = members.filter((m) => !hasKnownName(m));
    const clusters = [];
    while (pool.length) {
      const w = pickWinner(pool, businessBoost);
      const mine = [w];
      const rest = [];
      for (const m of pool) {
        if (m.id === w.id) continue;
        (namesCompatible(w, m) ? mine : rest).push(m);
      }
      clusters.push(mine);
      pool = rest;
    }
    if (unnamed.length) {
      if (clusters.length === 1) {
        clusters[0].push(...unnamed);
      } else {
        const w = pickWinner(unnamed, businessBoost);
        clusters.push([w, ...unnamed.filter((m) => m.id !== w.id)]);
      }
    }
    // Re-pick each cluster's winner AFTER membership settles: named rows seed
    // clusters (identity), but an unnamed row appended later can be the real
    // account (invoices/Stripe/active) — it must be the kept row, with the
    // name backfilled from the merged duplicate, not retired under a shell.
    const finalClusters = clusters.map((cluster) => {
      const w = pickWinner(cluster, businessBoost);
      return [w, ...cluster.filter((m) => m.id !== w.id)];
    });
    // Conflict evidence is structural (cluster count), NOT queue-visibility:
    // dismissing a red pair hides it from the queue, but the other identity
    // still exists as a cluster, so the shells stay demoted below.
    const multiIdentity = finalClusters.length > 1;

    finalClusters.forEach((cluster, idx) => {
      const winner = cluster[0];
      const candidates = cluster.slice(1).map((loser) => evaluatePair(winner, loser));
      // Cross-identity pairs surface once, on the first cluster's card, so
      // the shared-phone conflict stays visible and dismissable.
      if (idx === 0) {
        for (const other of finalClusters.slice(1)) candidates.push(evaluatePair(winner, other[0]));
      }
      if (multiIdentity) {
        for (const c of candidates) {
          if (c.tier === 'green') {
            c.tier = 'yellow';
            c.reasons.push('group_has_identity_conflict');
          }
        }
      }
      // Dismissals filter the VISIBLE queue only — after demotion, so
      // adjudicating one pair never re-greens the rest of the group.
      const visible = candidates.filter((c) => {
        const [a, b] = pairKey(winner.id, c.loser.id);
        return !dismissed.has(`${a}:${b}`);
      });
      if (visible.length) {
        groups.push({
          phone10: p10,
          winner: sanitizeCustomer(winner),
          candidates: visible.map((c) => ({
            loser: sanitizeCustomer(c.loser),
            tier: c.tier,
            reasons: c.reasons,
            evidence: { phone10: p10, names_compatible: c.namesOk, address: c.addrStatus },
          })),
        });
      }
    });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Merge executor
// ---------------------------------------------------------------------------

// Never repointed: the journal must keep pointing at the historical loser, a
// dismissal pair must not collapse into a self-pair.
const REPOINT_EXCLUDED_TABLES = new Set(['customer_merge_journal', 'customer_duplicate_dismissals']);

// Above this many rows in one table the journal records count-only instead of
// per-row ids (an unbounded id list would bloat the journal row); the revert
// endpoint treats count-only tables as not auto-revertible and reports them.
const REPOINT_ID_CAP = 10000;

// Tables whose PK is not a plain `id` column: the merge-time id capture AND
// the undo's verification/reverse-repoint select and match by THIS column
// instead, so their repoints journal REAL key lists and restore exactly
// (journal keys stay `${table}.${fk_column}`; the PK override is looked up
// by table name on both sides).
//   customer_refresh_tokens — PK jti (20260716000000). Without the
//   override its repoints journaled count-only and the undo skipped them,
//   leaving the restored loser's sessions winner-assigned so
//   rotateRefreshSession rejected every refresh. Repointing back BY JTI
//   restores the pre-merge session state precisely — the rows are
//   ownership pointers + hashed fingerprints, so no token rotation is
//   needed or wanted. PRE-UPGRADE journals recorded this table count-only;
//   those keep the skip-and-report path (sessions are neither financial
//   nor consent — a stale winner-assigned session merely fails rotation
//   and forces a re-login).
const REPOINT_PK_COLUMNS = { customer_refresh_tokens: 'jti' };

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
// Column defaults that mean "never filled in", not a real choice — a winner
// holding one of these must still take the loser's actual value (pet details,
// preferred day) before the loser's row is deleted.
const PREF_DEFAULT_SENTINELS = {
  property_preferences: new Set([0, '0', 'no_preference']),
};

async function mergeSingletonPrefRow(trx, table, column, winnerId, loserId) {
  const loserRow = await trx(table).where(column, loserId).first();
  if (!loserRow) return 'no loser row';
  const winnerRow = await trx(table).where(column, winnerId).first();
  if (!winnerRow) {
    const count = await trx(table).where(column, loserId).update({ [column]: winnerId });
    return count;
  }
  const booleanMode = SINGLETON_BOOLEAN_SEMANTICS[table] || 'and';
  const sentinels = PREF_DEFAULT_SENTINELS[table];
  // Empty jsonb defaults ([] / {}) mean "never filled in" exactly like null:
  // a winner with special_features [] must still take the loser's real
  // access/pet/irrigation details before the loser's row is deleted. knex
  // returns jsonb as parsed values, but check string forms too.
  const isEmptyJson = (v) => {
    if (Array.isArray(v)) return v.length === 0;
    if (v && typeof v === 'object' && v.constructor === Object) return Object.keys(v).length === 0;
    if (typeof v === 'string') { const s = v.trim(); return s === '[]' || s === '{}'; }
    return false;
  };
  const isDefaultish = (v) => v === null || v === '' || isEmptyJson(v) || (sentinels ? sentinels.has(v) : false);
  // Plain arrays/objects headed for a jsonb column must be stringified: the
  // pg driver would otherwise encode a JS array as a Postgres ARRAY literal,
  // which jsonb rejects. Dates and other typed objects pass through.
  const forUpdate = (v) => (Array.isArray(v) || (v && typeof v === 'object' && v.constructor === Object))
    ? JSON.stringify(v) : v;
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
    } else if (isDefaultish(winnerVal) && !isDefaultish(loserVal)) {
      updates[col] = forUpdate(loserVal);
    }
  }
  if (Object.keys(updates).length) {
    await trx(table).where(column, winnerId).update({ ...updates, updated_at: trx.fn.now() });
  }
  await trx(table).where(column, loserId).del();
  return `merged ${Object.keys(updates).length} fields into winner row, dropped loser row`;
}

// conversations dedupe on a partial unique (customer_id, channel,
// our_endpoint_id): both duplicates can hold the SAME SMS/email thread.
// Colliding threads MERGE instead of aborting: the loser conversation's
// messages move to the winner's thread FIRST (the FK is ON DELETE CASCADE —
// deleting first would destroy the history), AI-decision and training rows
// follow (SET NULL FKs — a delete would orphan them), counters and
// last-activity stamps fold in, then the empty loser row drops. NULL
// endpoints never collide (Postgres treats unique NULLs as distinct), so a
// collision always has a concrete winner thread to merge into.
const CONVERSATION_CHILD_TABLES = ['messages', 'agent_decisions', 'reply_training_examples'];

function laterOf(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) > new Date(b) ? a : b;
}

async function mergeConversationRows(trx, table, column, winnerId, loserId) {
  const rows = await trx(table).where(column, loserId).select('*');
  let moved = 0;
  let merged = 0;
  for (const row of rows) {
    try {
      await trx.transaction(async (sp) => {
        await sp(table).where({ id: row.id }).update({ [column]: winnerId });
      });
      moved += 1;
    } catch (e) {
      if (!(e && e.code === '23505')) throw e;
      const target = await trx(table)
        .where({ [column]: winnerId, channel: row.channel, our_endpoint_id: row.our_endpoint_id })
        .first();
      if (!target) throw new Error(`conversations merge: collision without a winner thread for ${row.id}`);
      for (const child of CONVERSATION_CHILD_TABLES) {
        await trx(child).where({ conversation_id: row.id }).update({ conversation_id: target.id });
      }
      await trx(table).where({ id: target.id }).update({
        message_count: Number(target.message_count || 0) + Number(row.message_count || 0),
        last_message_at: laterOf(target.last_message_at, row.last_message_at),
        last_inbound_at: laterOf(target.last_inbound_at, row.last_inbound_at),
        updated_at: trx.fn.now(),
      });
      await trx(table).where({ id: row.id }).del();
      merged += 1;
    }
  }
  return `moved ${moved}, merged ${merged} thread(s) into the winner's conversations`;
}

// customer_properties carries two partial uniques — one primary per customer,
// one active row per (customer, address_key). Repoint row-by-row: the loser's
// properties demote from primary ONLY when the winner already has a live
// primary (an address-less shell winner inherits the loser's primary intact —
// otherwise the merged customer ends up with no primary service address), and
// an address the winner already holds active comes across deactivated instead
// of colliding (the winner's copy of that address is the live one).
async function repointCustomerProperties(trx, table, column, winnerId, loserId) {
  const winnerPrimary = await trx(table)
    .where({ [column]: winnerId, is_primary: true, active: true })
    .first('id');
  const demote = winnerPrimary ? { is_primary: false } : {};
  const rows = await trx(table).where(column, loserId).select('id');
  let moved = 0;
  let deactivated = 0;
  for (const { id } of rows) {
    try {
      await trx.transaction(async (sp) => {
        await sp(table).where({ id }).update({ [column]: winnerId, ...demote });
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

// Generated per-customer period rows (e.g. customer_mrr_snapshots, unique on
// (period_month, customer_id)): both duplicates can legitimately be in the
// same month's snapshot. The winner's row is the authoritative one — repoint
// the loser's rows for periods the winner lacks, drop the colliding ones.
// The journal snapshot keeps nothing here because these are derived rows,
// regenerated by their own jobs.
async function repointRowwiseDropCollisions(trx, table, column, winnerId, loserId) {
  const rows = await trx(table).where(column, loserId).select('id');
  let moved = 0;
  let dropped = 0;
  for (const { id } of rows) {
    try {
      await trx.transaction(async (sp) => {
        await sp(table).where({ id }).update({ [column]: winnerId });
      });
      moved += 1;
    } catch (e) {
      if (!(e && e.code === '23505')) throw e;
      await trx(table).where({ id }).del();
      dropped += 1;
    }
  }
  return `moved ${moved}, dropped ${dropped} duplicate row(s) (winner already has them)`;
}

const UNIQUE_COLLISION_HANDLERS = {
  notification_prefs: mergeSingletonPrefRow,
  property_preferences: mergeSingletonPrefRow,
  customer_properties: repointCustomerProperties,
  conversations: mergeConversationRows,
  // Derived / duplicate-safe per-customer rows: the winner's copy is
  // authoritative (regenerated by their own jobs, or an already-earned
  // badge); the loser's colliding copies drop instead of aborting the merge.
  // Deliberately NOT customer_turf_profiles — that is operator-authored data
  // and a collision there should abort for a human to reconcile.
  customer_mrr_snapshots: repointRowwiseDropCollisions,
  customer_ltv: repointRowwiseDropCollisions,
  customer_health_scores: repointRowwiseDropCollisions,
  customer_badges: repointRowwiseDropCollisions,
  badge_reward_queue: repointRowwiseDropCollisions,
  // UNIQUE(customer_id, tag): both duplicates carrying the same CRM tag is
  // identical content, not divergent data — move the tags the winner lacks,
  // drop the loser's copies of tags the winner already has.
  customer_tags: repointRowwiseDropCollisions,
};

// Customer ids also hide behind polymorphic recipient columns the
// schema-driven sweep cannot recognize (no *customer_id name, no declared
// FK). Each (table, type column, id column) triple repoints only rows
// explicitly typed 'customer', so the winner keeps the loser's notification
// and email history. audit_log's actor_type/actor_id pair is deliberately
// NOT listed — an audit row records who actually acted, and the journal
// snapshot preserves that identity.
const POLYMORPHIC_CUSTOMER_POINTERS = [
  { table: 'notifications', typeColumn: 'recipient_type', idColumn: 'recipient_id' },
  { table: 'email_messages', typeColumn: 'recipient_type', idColumn: 'recipient_id' },
  // Pending data-hygiene proposals resolve their target through BOTH pairs
  // (apply reads resource_id AND scope_id) — left behind, they 404/stale or
  // act on the retired profile instead of following the merged account.
  { table: 'data_hygiene_proposals', typeColumn: 'scope_type', idColumn: 'scope_id' },
  { table: 'data_hygiene_proposals', typeColumn: 'resource_type', idColumn: 'resource_id' },
];

let fkColumnsCache = null;
async function customerFkColumns(database) {
  if (fkColumnsCache) return fkColumnsCache;
  // Union of (a) DECLARED foreign keys referencing customers(id) — catches
  // FK columns with any name — and (b) every `customer_id` or
  // `*_customer_id` column on a base table, because many customer-owned
  // tables in this repo store the pointer WITHOUT a declared FK
  // (payment_plans, customer_discounts, leads) or under a soft-pointer name
  // (geofence_events.matched_customer_id, route_decisions.created_customer_id,
  // outbox_messages.related_customer_id) and their history would otherwise
  // stay attached to the retired row after a merge.
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
        AND c.column_name ~ '(^|_)customer_id$' AND c.table_name <> 'customers'
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
    // Saved cards live on a specific STRIPE customer: charge paths attach
    // PaymentIntents to ensureStripeCustomer(winner), so a moved method
    // attached elsewhere would strand and autopay/card-on-file charges fail.
    // Validate before the sweep moves them; when neither customer row names
    // a Stripe profile but the saved cards agree on one, derive it (same
    // spirit as the loser-only-profile transfer below).
    let derivedStripeCustomerId = null;
    const pmStripeIdsFor = async (customerId) => [...new Set((await trx('payment_methods')
      .where({ customer_id: customerId })
      .whereNotNull('stripe_customer_id')
      .select('stripe_customer_id')).map((r) => r.stripe_customer_id))];
    // The survivor ends with ONE Stripe profile (its own, or the loser's via
    // the transfer below) and EVERY saved card on EITHER side must live on
    // it — including the winner's own cards when its customer row hasn't
    // named a profile yet (backfilling the loser's would strand them).
    const loserPmStripeIds = await pmStripeIdsFor(loserId);
    const winnerPmStripeIds = await pmStripeIdsFor(winnerId);
    const allPmStripeIds = [...new Set([...winnerPmStripeIds, ...loserPmStripeIds])];
    const effectiveWinnerStripe = winner.stripe_customer_id || loser.stripe_customer_id || null;
    const foreignPmStripe = allPmStripeIds.filter((id) => id !== effectiveWinnerStripe);
    let stripeDerivedFrom = null;
    if (foreignPmStripe.length) {
      if (!effectiveWinnerStripe && allPmStripeIds.length === 1) {
        derivedStripeCustomerId = allPmStripeIds[0];
        // WHICH side's cards identified the derived profile — journaled so
        // an undo knows where the id belongs: 'loser' restores it to the
        // split-out customer; 'winner'/'both' means the kept customer's
        // own cards ride it and it stays put (the undo refuses if it would
        // also return cards onto it).
        const winnerHasIt = winnerPmStripeIds.includes(derivedStripeCustomerId);
        const loserHasIt = loserPmStripeIds.includes(derivedStripeCustomerId);
        stripeDerivedFrom = winnerHasIt && loserHasIt ? 'both' : (winnerHasIt ? 'winner' : 'loser');
      } else {
        throw new Error("executeMerge: saved cards belong to a different Stripe profile than the surviving customer's — resolve in Stripe first");
      }
    }
    // Two DIFFERENT third-party payer defaults is a human billing decision,
    // exactly like both-have-Stripe: refuse. (A loser-only payer transfers
    // with the backfills below — invoice precedence is
    // scheduled_service.payer_id ?? customers.payer_id, so dropping it would
    // flip the merged account to self-pay.)
    if (winner.payer_id && loser.payer_id && winner.payer_id !== loser.payer_id) {
      throw new Error('executeMerge: customers have different third-party payers — resolve billing first');
    }
    // Same contract for billing cadence: two DIFFERENT non-null modes is a
    // human billing decision. (A loser-only mode transfers with the
    // backfills below — the monthly cron treats NULL as legacy monthly
    // membership, so dropping the only per_application/annual_prepay marker
    // would bill the merged account on the wrong cadence.)
    if (winner.billing_mode && loser.billing_mode && winner.billing_mode !== loser.billing_mode) {
      throw new Error('executeMerge: customers have different billing modes — reconcile billing first');
    }
    // Same mode but DIFFERENT per-application fees is still a billing
    // conflict: completion billing reads the surviving row's fee for visits
    // without an explicit price, so the loser's moved visits would invoice
    // at the wrong accepted amount.
    if (winner.billing_mode === 'per_application' && loser.billing_mode === 'per_application') {
      const wFee = Number(winner.per_application_fee);
      const lFee = Number(loser.per_application_fee);
      if (Number.isFinite(wFee) && Number.isFinite(lFee) && wFee !== lFee) {
        throw new Error('executeMerge: customers have different per-application fees — reconcile billing first');
      }
    }
    // Legacy NULL is a real cadence too — the monthly cron treats NULL as
    // monthly membership, and completion billing reads the SURVIVOR's mode.
    // Mixing a special-mode side with a legacy side is only safe when the
    // side whose cadence would flip has no billing artifacts to flip: a
    // null-mode winner adopting the loser's special mode flips its own
    // history; a special-mode winner absorbs the loser's legacy visits into
    // special billing.
    const winnerMode = winner.billing_mode || null;
    const loserMode = loser.billing_mode || null;
    if (winnerMode !== loserMode && (winnerMode === null || loserMode === null)) {
      const flippingSideId = winnerMode === null ? winnerId : loserId;
      let hasArtifacts = false;
      for (const table of ['scheduled_services', 'invoices']) {
         
        const row = await trx(table).where({ customer_id: flippingSideId }).first('id');
        if (row) { hasArtifacts = true; break; }
      }
      if (hasArtifacts) {
        throw new Error('executeMerge: merging legacy and special billing modes with live billing history — reconcile billing first');
      }
    }
    // Multi-property account groups: retiring a loser whose account still
    // has OTHER live member profiles would strand them — the portal's
    // property switcher lists rows by the login's account_id, so the
    // siblings become invisible after the merge. Reconcile accounts first.
    if (loser.account_id && loser.account_id !== winner.account_id) {
      const sibling = await trx('customers')
        .where({ account_id: loser.account_id, active: true })
        .whereNull('deleted_at')
        .whereNotIn('id', [loserId, winnerId])
        .first('id');
      if (sibling) {
        throw new Error('executeMerge: the duplicate belongs to a multi-property account with other live members — reconcile accounts first');
      }
    }
    // Same-account primary handoff: shared notification/channel prefs
    // resolve via (account_id, is_primary_profile=true) — retiring the
    // account's primary without promoting the survivor would leave sibling
    // properties falling back to their own/default prefs.
    const promoteWinnerAsPrimary = Boolean(
      loser.is_primary_profile
      && loser.account_id
      && loser.account_id === winner.account_id
      && !winner.is_primary_profile,
    );
    // The queue was computed OUTSIDE this transaction — re-verify under the
    // row lock that the pair still shares a phone (intake flows and admin
    // edits can change either side between detection and the merge click).
    const winnerPhone = phone10(winner.phone);
    if (!winnerPhone || winnerPhone !== phone10(loser.phone)) {
      throw new Error('executeMerge: rows no longer share a phone — refresh the queue');
    }
    // The route's red-tier check also ran outside this transaction. Re-apply
    // the detection red rule on the LOCKED rows in every mode: an edit that
    // lands between the queue recheck and this lock must not merge a pair
    // that now reads as two different people (different last names at a
    // positively different address).
    const addr = addressCompat(winner, loser);
    const lastNamesDiffer = normName(winner.last_name) && normName(loser.last_name)
      && normName(winner.last_name) !== normName(loser.last_name);
    if (lastNamesDiffer && ADDRESS_CONFLICTS.has(addr.status)) {
      throw new Error('executeMerge: pair now reads as two different people — refresh the queue');
    }
    if (mode === 'auto') {
      const blockers = await loserAutoBlockers(trx, loser);
      if (blockers.length) throw new Error(`executeMerge(auto): loser is not a shell (${blockers.join(', ')})`);
      if (!namesCompatible(winner, loser)) throw new Error('executeMerge(auto): names conflict');
      if (!ADDRESS_COMPATIBLE.has(addr.status)) throw new Error(`executeMerge(auto): address ${addr.status}`);
    }

    const repointed = {};
    // Row-precise record of every PLAIN repoint for the journal's
    // repointed_ids column — what the revert endpoint replays. Values are
    // arrays of moved row ids, or { count } when ids could not be captured
    // (no plain `id` PK, over REPOINT_ID_CAP, or a mid-merge insert made the
    // list unreliable). Collision-handled tables (prefs folds, dropped
    // derived rows, conversation merges) are deliberately NOT recorded —
    // those moves are not plain repoints and are not auto-revertible, so the
    // journal lists WHICH handlers ran (collision_handlers) and the revert
    // endpoint refuses any merge where one did.
    const repointedIds = {};
    const collisionHandlers = [];

    // BEFORE the sweep: an unstamped visit renders its address via
    // COALESCE(scheduled_services.service_address_line1, customers.
    // address_line1) on the schedule board — after the repoint that fallback
    // becomes the WINNER's address and can dispatch a tech to the wrong
    // property. Stamp the loser's unstamped visits with the loser's own
    // address while it is still theirs. (Auto mode never gets here with
    // visits — scheduled_services is a shell blocker.)
    if (loser.address_line1) {
      const stamped = await trx('scheduled_services')
        .where({ customer_id: loserId })
        .whereNull('service_address_line1')
        .update({
          service_address_line1: loser.address_line1,
          service_address_line2: loser.address_line2 || null,
          service_address_city: loser.city || null,
          service_address_state: loser.state || null,
          service_address_zip: loser.zip || null,
        });
      if (stamped) repointed['scheduled_services.service_address_stamp'] = stamped;
    }
    // BEFORE the sweep: if the winner already has a default card, the
    // loser's cards must arrive DEMOTED — autopay picks .first() among
    // is_default+autopay_enabled rows, and two defaults after the repoint
    // would charge an arbitrary card. (Reachable when both rows share a
    // Stripe profile or the loser's stripe_customer_id is stale/null.)
    const winnerHadDefault = await trx('payment_methods')
      .where({ customer_id: winnerId, is_default: true })
      .first('id');
    // Capture each loser card's ORIGINAL default/autopay flags for the
    // journal: the demotion below clears them, and an undo must restore the
    // loser's cards exactly as they were (billing continuity — autopay picks
    // the default card).
    const loserCards = await trx('payment_methods')
      .where({ customer_id: loserId }).select('id', 'is_default', 'autopay_enabled');
    const loserCardIds = loserCards.map((r) => r.id);
    // The winner's OWN pre-merge cards, journaled so the undo's
    // new-card-on-transferred-profile guard can tell them apart from cards
    // saved AFTER the merge: in the derived-profile case the derivation
    // aggregates BOTH sides' cards, so a pre-merge winner card legitimately
    // sits on the transferred profile — the undo returns the winner to
    // exactly its pre-merge state (cards on that profile, row naming none),
    // which is restoration-exact, not a strand. Pre-upgrade journals lack
    // the key and keep the conservative refusal.
    const winnerPremergePmIds = (await trx('payment_methods')
      .where({ customer_id: winnerId }).select('id')).map((r) => r.id);
    const paymentMethodFlags = {};
    for (const card of loserCards) {
      paymentMethodFlags[card.id] = {
        is_default: card.is_default === true,
        autopay_enabled: card.autopay_enabled === true,
      };
    }

    // BEFORE the sweep: remember the loser's referral enrollment — after the
    // sweep both promoter rows sit on the winner and can no longer be told
    // apart by customer_id. (referral_promoters has no unique on customer_id,
    // so the sweep succeeds and silently leaves two rows.)
    const loserPromoter = await trx('referral_promoters')
      .where({ customer_id: loserId }).first('id');

    // Repoint every FK. Each table gets its own savepoint (knex nested
    // transaction) so a unique-collision on a droppable singleton can be
    // handled without poisoning the outer transaction.
    const fks = await customerFkColumns(trx);
    for (const { table_name: table, column_name: column } of fks) {
      // Capture the moving row keys BEFORE the update, in an own savepoint:
      // a table without a plain `id` PK (and no REPOINT_PK_COLUMNS entry)
      // must not poison the outer transaction — it just journals count-only
      // and stays non-revertible.
      const pkColumn = REPOINT_PK_COLUMNS[table] || 'id';
      let rowIds = null;
      try {
        await trx.transaction(async (sp) => {
          rowIds = (await sp(table).where(column, loserId).select(pkColumn)).map((r) => r[pkColumn]);
        });
      } catch {
        rowIds = null;
      }
      try {
        await trx.transaction(async (sp) => {
          const count = await sp(table).where(column, loserId).update({ [column]: winnerId });
          if (count) {
            repointed[`${table}.${column}`] = count;
            // Record ids only when the update provably covered exactly them
            // (READ COMMITTED: a row committed between the id select and the
            // update makes the list unreliable — fall back to count-only).
            repointedIds[`${table}.${column}`] = (rowIds && rowIds.length === count && count <= REPOINT_ID_CAP)
              ? rowIds
              : { count };
          }
        });
      } catch (e) {
        const uniqueViolation = e && e.code === '23505';
        const handler = UNIQUE_COLLISION_HANDLERS[table];
        if (uniqueViolation && handler) {
          repointed[`${table}.${column}`] = await handler(trx, table, column, winnerId, loserId);
          // The handler moved/merged/deleted rows that are NOT in
          // repointedIds — this merge can no longer be replayed backwards.
          if (!collisionHandlers.includes(table)) collisionHandlers.push(table);
        } else {
          throw new Error(`executeMerge: repoint failed on ${table}.${column}: ${e.message}`);
        }
      }
    }
    // Normalize payment-method defaults now that the loser's cards moved:
    // the winner's own pre-merge default stays the ONE default/autopay card.
    if (winnerHadDefault && loserCardIds.length) {
      const demoted = await trx('payment_methods')
        .whereIn('id', loserCardIds)
        .where((q) => q.where({ is_default: true }).orWhere({ autopay_enabled: true }))
        .update({ is_default: false, autopay_enabled: false, updated_at: trx.fn.now() });
      if (demoted) repointed['payment_methods.demoted_defaults'] = demoted;
    }

    // Polymorphic customer pointers (recipient_type/recipient_id) — see
    // POLYMORPHIC_CUSTOMER_POINTERS. Same fail-closed contract as the FK
    // sweep: any failure aborts the merge.
    for (const { table, typeColumn, idColumn } of POLYMORPHIC_CUSTOMER_POINTERS) {
      let rowIds = null;
      try {
        await trx.transaction(async (sp) => {
          rowIds = (await sp(table)
            .where({ [typeColumn]: 'customer', [idColumn]: loserId })
            .select('id')).map((r) => r.id);
        });
      } catch {
        rowIds = null;
      }
      try {
        await trx.transaction(async (sp) => {
          const count = await sp(table)
            .where({ [typeColumn]: 'customer', [idColumn]: loserId })
            .update({ [idColumn]: winnerId });
          if (count) {
            repointed[`${table}.${idColumn}`] = count;
            repointedIds[`${table}.${idColumn}`] = (rowIds && rowIds.length === count && count <= REPOINT_ID_CAP)
              ? rowIds
              : { count };
          }
        });
      } catch (e) {
        throw new Error(`executeMerge: repoint failed on ${table}.${idColumn}: ${e.message}`);
      }
    }
    // Referral surfaces load ONE promoter per customer (`.first()` in
    // referral-engine/referrals-v2) — if both sides were enrolled, the sweep
    // left two rows on the winner and the second row's rewards would vanish
    // from the portal. Fold the loser's enrollment into the winner's
    // ORIGINAL row (its referral code/link is the one in the wild): repoint
    // referrals + invites, add the balance/counter columns, drop the
    // duplicate row.
    if (loserPromoter) {
      const winnerPromoter = await trx('referral_promoters')
        .where({ customer_id: winnerId }).whereNot({ id: loserPromoter.id }).first();
      if (winnerPromoter) {
        await trx('referrals').where({ promoter_id: loserPromoter.id })
          .update({ promoter_id: winnerPromoter.id });
        await trx('referral_invites').where({ promoter_id: loserPromoter.id })
          .update({ promoter_id: winnerPromoter.id });
        // Click history and payout rows key on promoter_id too — payout
        // approval looks the promoter back up, so orphaning them would strand
        // pending payouts and understate promoter stats.
        await trx('referral_clicks').where({ promoter_id: loserPromoter.id })
          .update({ promoter_id: winnerPromoter.id });
        await trx('referral_payouts').where({ promoter_id: loserPromoter.id })
          .update({ promoter_id: winnerPromoter.id });
        const loserRow = await trx('referral_promoters').where({ id: loserPromoter.id }).first();
        // Legacy counters AND the live v2 balances (available/pending) the
        // referral portal displays and payout approval checks.
        // click_balance_cents was DROPPED by 20260401000100_referral_unification
        // — only live columns here (a stale column in the UPDATE below would
        // abort the whole merge).
        const counters = ['referral_balance_cents', 'total_earned_cents',
          'total_paid_out_cents', 'total_clicks', 'total_referrals_sent', 'total_referrals_converted',
          'available_balance_cents', 'pending_earnings_cents'];
        const sums = {};
        for (const col of counters) {
          const add = Number(loserRow?.[col] || 0);
          if (add) sums[col] = Number(winnerPromoter[col] || 0) + add;
        }
        if (Object.keys(sums).length) {
          await trx('referral_promoters').where({ id: winnerPromoter.id })
            .update({ ...sums, updated_at: trx.fn.now() });
        }
        // Flatten alias chains: older aliases pointing at the promoter now
        // being retired follow it to the survivor, so the /r/:code resolver
        // stays single-hop.
        await trx('referral_promoters')
          .where({ merged_into_promoter_id: loserPromoter.id })
          .update({ merged_into_promoter_id: winnerPromoter.id });
        // The loser row becomes a RETIRED ALIAS instead of deleting: its
        // /r/:code links are already in the wild (SMS/email invites), and
        // the public resolver attributes clicks/rewards only via a promoter
        // row. customer_id nulls (the portal loads one promoter per customer
        // via .first()), balances zero (they folded above), and
        // merged_into_promoter_id points the resolver at the winner so
        // in-flight invites keep earning credit there.
        // Balances AND lifetime counters zero on the alias — they folded
        // into the winner, and analytics/top-promoter queries read
        // referral_promoters without always excluding status='merged', so a
        // populated alias would double-count every click/referral/reward.
        await trx('referral_promoters').where({ id: loserPromoter.id }).update({
          customer_id: null,
          status: 'merged',
          merged_into_promoter_id: winnerPromoter.id,
          referral_balance_cents: 0,
          available_balance_cents: 0,
          pending_earnings_cents: 0,
          total_earned_cents: 0,
          total_paid_out_cents: 0,
          total_clicks: 0,
          total_referrals_sent: 0,
          total_referrals_converted: 0,
          updated_at: trx.fn.now(),
        });
        repointed['referral_promoters.consolidated'] = `folded promoter ${loserPromoter.id} into ${winnerPromoter.id} (loser kept as code alias)`;
        // This consolidation folded balances/counters and retired the loser
        // promoter as a customer-less alias — moves repointed_ids has no
        // per-row record of, exactly like a unique-collision fold. Register
        // it so revertMerge 409s and GET /merges shows revertible:false.
        // (A loser-only enrollment repoints plainly in the FK sweep above
        // and stays revertible.)
        if (!collisionHandlers.includes('referral_promoters')) collisionHandlers.push('referral_promoters');
      }
    }

    // Operator context (CRM + technician notes) must survive the retire:
    // APPEND the loser's notes onto the winner — both sides can hold real
    // context, fill-if-empty would drop one, and the merge journal is not an
    // operator surface.
    const noteAppends = {};
    for (const col of ['crm_notes', 'technician_notes']) {
      const loserVal = String(loser[col] || '').trim();
      if (!loserVal) continue;
      const winnerVal = String(winner[col] || '').trim();
      if (winnerVal.includes(loserVal)) continue;
      noteAppends[col] = winnerVal
        ? `${winnerVal}\n\n[From merged duplicate ${String(loserId).slice(0, 8)}]: ${loserVal}`
        : loserVal;
    }
    // Journal the winner's PRIOR notes alongside the applied concatenation
    // ({ before, applied }, same shape as winner_autopay_before) so the undo
    // can put the winner's own notes back when still the merge-written text
    // — the loser's snapshot restores ITS originals, but without this the
    // folded copy stayed on the winner silently. Pre-upgrade journals lack
    // the key and keep today's behavior (folded text stays).
    let winnerNoteAppends = null;
    if (Object.keys(noteAppends).length) {
      winnerNoteAppends = { before: {}, applied: noteAppends };
      for (const col of Object.keys(noteAppends)) {
        winnerNoteAppends.before[col] = winner[col] === undefined ? null : winner[col];
      }
      await trx('customers').where({ id: winnerId })
        .update({ ...noteAppends, updated_at: trx.fn.now() });
      repointed['customers.notes_appended'] = Object.keys(noteAppends).join(', ');
    }

    // Autopay consent is most-restrictive, like notification_prefs: an
    // explicit opt-out or live pause on EITHER row survives the merge — the
    // monthly cron must never charge a customer whose retired row said stop.
    // autopay_log keeps the provenance; re-enabling is an operator action on
    // the surviving row.
    const autopayRestrictions = {};
    if (loser.autopay_enabled === false && winner.autopay_enabled !== false) {
      autopayRestrictions.autopay_enabled = false;
    }
    const pauseTs = (v) => (v ? new Date(v).getTime() : null);
    const loserPause = pauseTs(loser.autopay_paused_until);
    const winnerPause = pauseTs(winner.autopay_paused_until);
    if (loserPause && loserPause > Date.now() && (!winnerPause || loserPause > winnerPause)) {
      autopayRestrictions.autopay_paused_until = loser.autopay_paused_until;
      if (loser.autopay_pause_reason) autopayRestrictions.autopay_pause_reason = loser.autopay_pause_reason;
    }
    // Journal the winner's ORIGINAL customer-level autopay fields for
    // exactly the columns this block overwrites (applied directly, not via
    // winner_backfills), so an undo can put the winner's own autopay state
    // back when it is still the merge-written value. Pre-upgrade journals
    // lack this key and keep today's behavior: the winner stays
    // most-restrictive after an undo (never a silent re-enable).
    let winnerAutopayBefore = null;
    if (Object.keys(autopayRestrictions).length) {
      winnerAutopayBefore = { before: {}, applied: autopayRestrictions };
      for (const col of Object.keys(autopayRestrictions)) {
        winnerAutopayBefore.before[col] = winner[col] === undefined ? null : winner[col];
      }
      await trx('customers').where({ id: winnerId })
        .update({ ...autopayRestrictions, updated_at: trx.fn.now() });
      repointed['customers.autopay_restrictions'] = Object.keys(autopayRestrictions).join(', ');
    }

    // customers.account_credits caches the ledger sum (customer-credit.js
    // invariant: cache and ledger written in the same transaction, customer
    // row locked — both hold here, the rows are forUpdate-locked above). The
    // sweep moved the loser's ledger rows to the winner, so the cached
    // balance moves with them; the retire below zeroes the loser's cache so
    // cache == ledger-sum stays true on BOTH rows.
    const loserCredits = Math.round(Number(loser.account_credits || 0) * 100) / 100;
    if (loserCredits) {
      await trx('customers').where({ id: winnerId }).increment('account_credits', loserCredits);
      repointed['customers.account_credits'] = `moved ${loserCredits} cached credit to winner`;
    }

    // Winner values the merge deliberately OVERWROTE (as opposed to
    // fill-if-empty backfills) — journaled under
    // repointed_ids.winner_prior_values so the undo can RESTORE them, not
    // merely null them out. Covers the self-referral clear here, the
    // address-tuple replacement, and the consent-stamp clear below.
    // Pre-upgrade journals lack the key and keep the old behavior
    // (overwritten values stay lost; restore by hand from the audit trail).
    const winnerPriorValues = {};

    // Repointing referred_by can produce a self-referral if the loser had
    // referred the winner; a customer can't be their own referrer.
    const selfReferralCleared = await trx('customers')
      .where({ id: winnerId, referred_by_customer_id: winnerId })
      .update({ referred_by_customer_id: null });
    // Journal that deliberate clear: the FK sweep already moved the pointer
    // loser→winner, so the undo's reverse repoint finds no row still
    // matching referred_by_customer_id = winnerId and reads it as drift —
    // without this record the winner's original "referred by the loser"
    // link would stay permanently null. Only when the winner's PRE-MERGE
    // value was the loser (a pre-existing self-reference restores to
    // nothing, not to the loser).
    if (selfReferralCleared && winner.referred_by_customer_id === loserId) {
      winnerPriorValues.referred_by_customer_id = loserId;
    }

    // Retire the loser's contact identity BEFORE backfilling the winner, so a
    // shared email can move over without tripping any uniqueness. Phone is
    // NOT NULL, so it gets an unmatchable sentinel; the journal snapshot keeps
    // the real values.
    await trx('customers').where({ id: loserId }).update({
      phone: `merged-${String(loserId).slice(0, 8)}`,
      email: null,
      stripe_customer_id: null,
      payer_id: null,
      billing_mode: null,
      is_primary_profile: false,
      account_credits: 0,
      active: false,
      deleted_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    });

    const backfills = {};
    for (const field of BACKFILL_FIELDS) {
      if (isEmptyValue(winner[field]) && !isEmptyValue(loser[field])) backfills[field] = loser[field];
    }
    // An address backfills as a TUPLE: a winner with no street but a stale
    // city/ZIP absorbing the loser's real service address must not mint a
    // mixed address (dispatch and report fallbacks read these columns
    // together). When the street comes from the loser, the whole tuple does.
    if (backfills.address_line1) {
      // The tuple REPLACES the winner's partial address wholesale — journal
      // any non-empty prior value being overwritten (e.g. the winner's
      // original ZIP) so the undo can put it back. Empty priors need no
      // record: the generic backfill-clear already vacates those to null.
      for (const field of ['address_line2', 'city', 'state', 'zip']) {
        if (!isEmptyValue(winner[field])) winnerPriorValues[field] = winner[field];
      }
      backfills.address_line2 = loser.address_line2 || null;
      backfills.city = loser.city || null;
      backfills.state = loser.state || null;
      backfills.zip = loser.zip || null;
    }
    // A loser-only Stripe profile must move with its payment methods: the
    // repointed payment_methods rows live on THAT Stripe customer, and a
    // later ensureStripeCustomer(winner) would mint a fresh profile and
    // strand every saved card. (Both-have-Stripe was refused above.)
    if (!winner.stripe_customer_id && (loser.stripe_customer_id || derivedStripeCustomerId)) {
      backfills.stripe_customer_id = loser.stripe_customer_id || derivedStripeCustomerId;
    }
    // A loser-only third-party payer default transfers the same way —
    // without it the merged account self-pays and bills the homeowner
    // instead of the AP payer. (Different-payers was refused above.)
    if (!winner.payer_id && loser.payer_id) {
      backfills.payer_id = loser.payer_id;
    }
    // A loser-only billing mode transfers the same way; per_application_fee
    // rides along when the winner has none (the completion biller reads it
    // with the mode).
    if (!winner.billing_mode && loser.billing_mode) {
      backfills.billing_mode = loser.billing_mode;
      if (isEmptyValue(winner.per_application_fee) && !isEmptyValue(loser.per_application_fee)) {
        backfills.per_application_fee = loser.per_application_fee;
      }
    }
    // A street-only winner absorbing a unit-bearing loser (same street key,
    // one-sided unit = a compatible match) must keep the unit — it is the
    // only piece of the service address that distinguishes the apartment.
    // The loser's line2 copies as-is; a unit embedded in the loser's line1
    // is re-extracted with case preserved.
    const winnerKey = normalizeStreetKey(winner.address_line1);
    const loserKey = normalizeStreetKey(loser.address_line1);
    const winnerHasUnit = Boolean((winnerKey && winnerKey.unit) || unitFromLine2(winner.address_line2));
    const loserUnitText = loser.address_line2
      || rawUnitText(loser.address_line1)
      || null;
    if (!winnerHasUnit && winnerKey && loserKey && winnerKey.key === loserKey.key
      && ((loserKey && loserKey.unit) || unitFromLine2(loser.address_line2))
      && isEmptyValue(winner.address_line2) && loserUnitText) {
      backfills.address_line2 = loserUnitText;
    }
    if (promoteWinnerAsPrimary) {
      backfills.is_primary_profile = true;
    }
    // On-location service contacts route appointment/service-report comms
    // (customer-contact.js): copy slot-WISE, never field-wise — mixing one
    // slot's name with another's phone would invent a contact that doesn't
    // exist. A slot moves only when the winner's whole slot is empty.
    const CONTACT_SLOTS = [
      ['service_contact_name', 'service_contact_phone', 'service_contact_email', 'service_contact_role'],
      ['service_contact2_name', 'service_contact2_phone', 'service_contact2_email', 'service_contact2_role'],
      ['service_contact3_name', 'service_contact3_phone', 'service_contact3_email', 'service_contact3_role'],
    ];
    let movedContactSlot = false;
    let movedContactPhone = false;
    const winnerHadAnyContact = CONTACT_SLOTS.some((slot) => slot.some((f) => !isEmptyValue(winner[f])));
    for (const slot of CONTACT_SLOTS) {
      const winnerSlotEmpty = slot.every((f) => isEmptyValue(winner[f]));
      if (!winnerSlotEmpty) continue;
      for (const f of slot) {
        if (!isEmptyValue(loser[f])) {
          backfills[f] = loser[f];
          movedContactSlot = true;
          // slot[1] is the phone column — only a moved TEXTING target can
          // invalidate the winner's SMS-consent stamp below.
          if (f === slot[1]) movedContactPhone = true;
        }
      }
    }
    // Consent artifact travels WITH the contacts it describes (#2948) — but
    // ONLY when the resulting contact list is exactly the loser's (winner
    // had no contacts at all and no stamp). If the winner already held any
    // contact — including one whose stamp an admin edit cleared — carrying
    // the loser's stamp would re-authorize texting people it never
    // described; leave it cleared and require re-attestation instead.
    if (movedContactSlot
      && !winnerHadAnyContact
      && isEmptyValue(winner.service_contacts_consent_at)
      && !isEmptyValue(loser.service_contacts_consent_at)) {
      backfills.service_contacts_consent_at = loser.service_contacts_consent_at;
      backfills.service_contacts_consent_source = loser.service_contacts_consent_source;
      backfills.service_contacts_consent_text_version = loser.service_contacts_consent_text_version;
    } else if (movedContactPhone && winnerHadAnyContact
      && !isEmptyValue(winner.service_contacts_consent_at)) {
      // Mixed list: the winner's stamp described only the winner's own
      // contacts; loser slots just joined the row, so the stamp no longer
      // describes the stored list — clear it and require re-attestation.
      backfills.service_contacts_consent_at = null;
      backfills.service_contacts_consent_source = null;
      backfills.service_contacts_consent_text_version = null;
      // winner_backfills records the APPLIED value (null) — journal the
      // winner's PRIOR stamps separately so an undo can restore them once
      // the appended loser contacts are gone (the stamp describes the
      // winner's own list again). Pre-upgrade journals lack this key and
      // keep today's behavior (stamp stays cleared; re-attest by hand).
      winnerPriorValues.service_contacts_consent_at = winner.service_contacts_consent_at;
      winnerPriorValues.service_contacts_consent_source = winner.service_contacts_consent_source ?? null;
      winnerPriorValues.service_contacts_consent_text_version = winner.service_contacts_consent_text_version ?? null;
    }
    if (Object.keys(backfills).length) {
      await trx('customers').where({ id: winnerId }).update({ ...backfills, updated_at: trx.fn.now() });
    }

    const [journal] = await trx('customer_merge_journal').insert({
      winner_customer_id: winnerId,
      loser_customer_id: loserId,
      loser_snapshot: JSON.stringify(loser),
      repointed: JSON.stringify(repointed),
      // Row-precise repoint record + the transferred Stripe id — everything
      // revertMerge needs. Additive column (nullable); the pre-existing
      // repointed COUNTS map keeps its exact shape for old readers.
      repointed_ids: JSON.stringify({
        version: 1,
        tables: repointedIds,
        stripe_transferred_id: backfills.stripe_customer_id || null,
        // Source of the transferred id: null (nothing transferred),
        // 'loser' (the loser's row named it — the classic transfer), or
        // 'loser'/'winner'/'both' when it was DERIVED from saved cards
        // (whose cards identified it). Drives the undo's restore-vs-stay
        // decision; see the derivation capture above.
        stripe_derived_from: backfills.stripe_customer_id
          ? (derivedStripeCustomerId ? stripeDerivedFrom : 'loser')
          : null,
        // ORIGINAL per-card default/autopay flags for every loser payment
        // method (the demotion above may have cleared them on the moved
        // rows) — the revert restores them, and REFUSES journals that moved
        // payment_methods rows without this record.
        payment_method_flags: paymentMethodFlags,
        // The winner's own pre-merge card ids — exempt from the undo's
        // new-card-on-transferred-profile refusal (see the capture above).
        winner_premerge_pm_ids: winnerPremergePmIds,
        // The winner's pre-fold notes + the applied concatenations
        // ({ before, applied }) — the undo restores the winner's own notes
        // while still the merge-written text; null when nothing was folded.
        winner_note_appends: winnerNoteAppends,
        // Tables whose unique-collision handler ran: those rows were
        // folded/merged/dropped, not plainly repointed, so the merge is not
        // auto-revertible (the revert endpoint 409s when any are listed).
        collision_handlers: collisionHandlers,
        // The winner's ORIGINAL customer-level autopay fields for the exact
        // columns the most-restrictive block overwrote ({ before, applied }),
        // or null when the merge left the winner's autopay alone.
        winner_autopay_before: winnerAutopayBefore,
        // Winner values the merge deliberately NULLED (consent stamps) —
        // the prior values, keyed by column, for the undo to restore.
        winner_prior_values: winnerPriorValues,
      }),
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
  let groups;
  try {
    groups = await findDuplicateGroups(db, { failClosedOnDismissals: true });
  } catch (e) {
    logger.warn(`[customer-dedupe] auto-merge sweep aborted — dismissals unreadable, refusing to merge blind: ${e.message}`);
    return { merged: [], skipped: [], aborted: 'dismissals_unreadable' };
  }
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
        const name = [group.winner.first_name, group.winner.last_name].filter(Boolean).join(' ') || 'Unknown';
        results.merged.push({ winnerId: group.winner.id, loserId: candidate.loser.id, winnerName: name });
      } catch (e) {
        // A failed green merge means the row changed under us — leave it for
        // the next sweep / the review queue rather than retrying in-loop.
        logger.warn(`[customer-dedupe] auto-merge ${candidate.loser.id} -> ${group.winner.id} failed: ${e.message}`);
        results.skipped.push({ loserId: candidate.loser.id, tier: 'green', reasons: [`merge_failed: ${e.message}`] });
      }
    }
  }

  // ONE digest bell per sweep (never per merge — green work is quiet, the
  // digest is the audit surface). Names capped so the body stays scannable.
  if (results.merged.length) {
    try {
      const names = results.merged.slice(0, 5).map((m) => m.winnerName).join(', ');
      const more = results.merged.length > 5 ? ` and ${results.merged.length - 5} more` : '';
      await require('./notification-service').notifyAdmin(
        'customer',
        `${results.merged.length} duplicate customer${results.merged.length === 1 ? '' : 's'} auto-merged`,
        `Merged into: ${names}${more}. Same phone, matching identity, no billing on the duplicates. All reversible — full snapshots in the merge journal.`,
        {
          // The SPA registers /admin/customers and opens Customer 360
          // via ?customerId= — a /admin/customers/<uuid> path 404s.
          link: results.merged.length === 1
            ? `/admin/customers?customerId=${results.merged[0].winnerId}`
            : '/admin/customers',
          metadata: { merged: results.merged.map(({ winnerId, loserId }) => ({ winnerId, loserId })) },
        },
      );
    } catch (notifyErr) {
      logger.warn(`[customer-dedupe] merge digest notify failed (non-blocking): ${notifyErr.message}`);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Red-pair auto-dismiss sweep (cron entry point — caller owns the gate)
// ---------------------------------------------------------------------------
//
// Red tier is the detector's own "two different people sharing a phone"
// verdict (different last names AND a positively different address) — those
// pairs can never be merged from the queue, so left alone they park in the
// owner's review list forever. This sweep records the same "not a duplicate"
// dismissal an operator would click, attributed 'auto:red-tier'. Dismissal
// semantics are untouched (display reads them fail-open at :299, the
// auto-merge sweep fail-closed): a dismissal only hides the pair from the
// QUEUE — identity-conflict demotion is structural (cluster count) and keeps
// green shells demoted, and a dismissed pair can never be auto-merged even
// if the rows later drift toward matching. Reversal = delete the row.
async function runRedPairAutoDismissSweep({ performedBy = 'auto:red-tier' } = {}) {
  let groups;
  try {
    // Fail-closed like the auto-merge sweep: the upsert itself is idempotent,
    // but an unreadable dismissals table means adjudication state we cannot
    // see — an autonomous writer does not act blind to it.
    groups = await findDuplicateGroups(db, { failClosedOnDismissals: true });
  } catch (e) {
    logger.warn(`[customer-dedupe] red-pair auto-dismiss aborted — dismissals unreadable: ${e.message}`);
    return { dismissed: [], aborted: 'dismissals_unreadable' };
  }
  const results = { dismissed: [], skippedStale: 0 };
  for (const group of groups) {
    for (const candidate of group.candidates) {
      if (candidate.tier !== 'red') continue;
      const [a, b] = pairKey(group.winner.id, candidate.loser.id);
      try {
        const outcome = await db.transaction(async (trx) => {
          // The red verdict came from a findDuplicateGroups read that
          // finished BEFORE this write — an admin edit in between (name
          // fix, address correction, retire) can turn the pair non-red, and
          // a PERMANENT dismissal must never land on it. Re-read both rows
          // under lock and re-apply the detection red rule at write time:
          // still-live rows sharing the phone, with different last names AND
          // a positively different address.
          const rows = await trx('customers').whereIn('id', [a, b]).forUpdate().select('*');
          const rowA = rows.find((r) => r.id === a);
          const rowB = rows.find((r) => r.id === b);
          const stillRed = Boolean(rowA && rowB
            && !rowA.deleted_at && !rowB.deleted_at
            && rowA.active !== false && rowB.active !== false
            && phone10(rowA.phone) && phone10(rowA.phone) === phone10(rowB.phone)
            && normName(rowA.last_name) && normName(rowB.last_name)
            && normName(rowA.last_name) !== normName(rowB.last_name)
            && ADDRESS_CONFLICTS.has(addressCompat(rowA, rowB).status));
          if (!stillRed) return 'no_longer_red';
          // Idempotent by the ordered-pair unique constraint — a re-run or a
          // race with a manual dismissal is an ignored conflict, never an
          // error.
          await trx('customer_duplicate_dismissals')
            .insert({
              customer_id_a: a,
              customer_id_b: b,
              reason: `auto-dismissed: red tier (${candidate.reasons.join(', ')})`.slice(0, 500),
              created_by: performedBy,
            })
            .onConflict(['customer_id_a', 'customer_id_b'])
            .ignore();
          return 'dismissed';
        });
        if (outcome === 'dismissed') {
          results.dismissed.push({ winnerId: group.winner.id, loserId: candidate.loser.id });
        } else {
          // Counted in the digest metadata; the pair simply stays queued for
          // the next sweep to re-classify.
          results.skippedStale += 1;
        }
      } catch (e) {
        // One bad pair must not stop the sweep; the pair simply stays queued.
        logger.warn(`[customer-dedupe] red-pair auto-dismiss failed for ${a}/${b}: ${e.message}`);
      }
    }
  }

  // ONE digest bell per sweep, mirroring the merge digest above.
  if (results.dismissed.length) {
    try {
      const n = results.dismissed.length;
      await require('./notification-service').notifyAdmin(
        'customer',
        `${n} duplicate pair${n === 1 ? '' : 's'} auto-dismissed as different people`,
        'Different last names at a different address on a shared phone — the detector\'s own "two people" verdict, so these pairs can never be merged. Removed from the duplicate review queue; to re-surface one, delete its customer_duplicate_dismissals row.',
        {
          link: '/admin/customers/duplicates',
          metadata: { dismissed: results.dismissed, skippedStale: results.skippedStale },
        },
      );
    } catch (notifyErr) {
      logger.warn(`[customer-dedupe] red-dismiss digest notify failed (non-blocking): ${notifyErr.message}`);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Merge undo (journal-backed revert — owner-initiated, no gate)
// ---------------------------------------------------------------------------

// Refuse-vs-skip policy for the revert's per-row ownership checks: money
// OWNERSHIP must never be partially reverted — if ANY recorded row in a
// financially-relevant table (invoices, payments, the credit ledger, saved
// payment methods) no longer points at the winner (or was journaled
// count-only), the whole revert refuses and the split is a hand job from the
// journal snapshot. These tables are also verified under SELECT ... FOR
// UPDATE and their reverse-repoints must move EXACTLY the planned row count
// (any shortfall rolls the whole transaction back) — a plain READ COMMITTED
// select-then-update could otherwise verify rows that move on before the
// update lands. Everything else (call logs, notifications, leads, derived
// snapshot rows, ...) is history/derived data where a row that moved on is
// skipped and reported — a partial revert there is strictly better than
// refusing the whole undo.
const REVERT_FINANCIAL_TABLES = new Set([
  'invoices', 'payments', 'customer_credit_ledger', 'payment_methods',
  // The rest of the service's own billing blockers (AUTO_BLOCKER_TABLES):
  // deposits and card holds move real held money, prepay terms drive the
  // annual biller, and an assigned discount changes what invoices charge —
  // all repoint with plain uuid `id` PKs + customer_id, so they verify
  // under FOR UPDATE and refuse on drift exactly like invoices/payments.
  'estimate_deposits', 'estimate_card_holds', 'annual_prepay_terms', 'customer_discounts',
  // A payment plan is the homeowner-scoped arrangement that pauses an
  // invoice's collection path (admin-invoices.js) — an unverifiable or
  // moved-on plan must refuse, never skip, or a winner-owned plan keeps
  // governing the restored loser's invoice. Plain uuid `id` PK +
  // customer_id (20260530000001), so the standard machinery applies.
  'payment_plans',
]);

// Comms-CONSENT tables where a MISSING row semantically means "allowed":
// recipient_optin has a composite PK (customer_id, phone_key) and no id
// column, so its repoints always journal count-only — and a skipped
// restoration there doesn't merely lose history, it WIDENS consent
// (recipient-optin.js: no row = grandfathered/allowed, so a pending or
// declined contact would start receiving texts after the split). Count-only
// journal records for these tables REFUSE the undo exactly like the
// financial set. Add future composite-PK consent tables here.
const CONSENT_CRITICAL_TABLES = new Set(['recipient_optin']);

// The undo's email-clear guard probes every surface that delivers to a
// denormalized copy of the customer email. This table MIRRORS the canonical
// registry in server/services/customer-email-fanout.js (:108-244 — leads,
// open estimates incl. 'sending', active automation enrollments, queued
// template runs, referral promoters, billing prefs, open contracts, pending
// booking follow-ups, newsletter subscribers). That module exports functions
// and a disclosure string, not a machine-readable surface list, so the
// mirror is BY HAND: extend BOTH in the same commit (same rule as its own
// EMAIL_FANOUT_DISCLOSURE). Each entry: winner-link column (linkValue maps
// the id — template runs store recipient_id as text), the email column, and
// the "still delivers" predicate, matched to the fan-out's own filters.
const EMAIL_BOUND_SURFACES = [
  {
    table: 'leads',
    emailColumn: 'email',
    linkColumn: 'customer_id',
    active: (q) => q.whereNull('deleted_at')
      .where((w) => w.whereNull('status').orWhereNotIn('status', ['won', 'lost', 'disqualified', 'duplicate', 'unresponsive'])),
    label: 'open lead(s)',
  },
  {
    table: 'estimates',
    emailColumn: 'customer_email',
    linkColumn: 'customer_id',
    active: (q) => q.whereIn('status', ['draft', 'scheduled', 'sending', 'sent', 'viewed', 'send_failed'])
      .whereNull('archived_at'),
    label: 'open estimate(s)',
  },
  {
    table: 'automation_enrollments',
    emailColumn: 'email',
    linkColumn: 'customer_id',
    active: (q) => q.where({ status: 'active' }),
    label: 'active automation enrollment(s)',
  },
  {
    table: 'email_template_automation_runs',
    emailColumn: 'recipient_email',
    linkColumn: 'recipient_id',
    linkValue: (id) => String(id),
    active: (q) => q.whereIn('status', ['queued', 'scheduled', 'retry_scheduled']),
    label: 'queued template send(s)',
  },
  {
    table: 'referral_promoters',
    emailColumn: 'customer_email',
    linkColumn: 'customer_id',
    active: (q) => q,
    label: 'referral promoter row(s)',
  },
  {
    table: 'notification_prefs',
    emailColumn: 'billing_email',
    linkColumn: 'customer_id',
    active: (q) => q,
    label: 'billing email preference(s)',
  },
  {
    table: 'customer_contracts',
    emailColumn: 'recipient_email',
    linkColumn: 'customer_id',
    active: (q) => q.whereNotIn('status', ['signed', 'cancelled', 'voided']),
    label: 'open contract(s)',
  },
  {
    table: 'booking_intents',
    emailColumn: 'email',
    linkColumn: 'customer_id',
    active: (q) => q.whereRaw('followup_email_sent IS NOT TRUE')
      .whereRaw('suppressed IS NOT TRUE')
      .whereNull('converted_at'),
    label: 'pending booking follow-up(s)',
  },
  {
    table: 'newsletter_subscribers',
    emailColumn: 'email',
    linkColumn: 'customer_id',
    // PENDING counts too (fanout-canonical — customer-email-fanout.js
    // moves pending rows and re-sends their DOI confirmation): a pending
    // subscriber's emailed confirmation link is a live bearer token, so
    // clearing the email out from under it strands a signup mid-opt-in.
    // Unsubscribed rows have no future deliveries and stay out.
    active: (q) => q.whereIn('status', ['active', 'pending']),
    label: 'active/pending newsletter subscription(s)',
  },
];

// Winner backfills the generic clearing loop must NOT touch: the Stripe id
// has its own provably-still-there guard, and is_primary_profile is a
// boolean demotion, not a null-out.
const REVERT_BACKFILL_CLEAR_EXCLUDED = new Set(['stripe_customer_id', 'is_primary_profile']);

// "Unchanged since the merge" comparison for backfilled winner fields. DB
// reads can restringify numerics ('65.00' vs 65), so numeric-looking values
// compare numerically.
function backfillValueUnchanged(current, recorded) {
  if (current === recorded) return true;
  if (current === null || current === undefined || recorded === null || recorded === undefined) return false;
  if (String(current) === String(recorded)) return true;
  const a = Number(current);
  const b = Number(recorded);
  return String(current).trim() !== '' && String(recorded).trim() !== ''
    && Number.isFinite(a) && Number.isFinite(b) && a === b;
}

function parseJsonb(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// ---------------------------------------------------------------------------
// UNDO CONTRACT (r8): the undo reverts ONLY UNTOUCHED merges. When any
// probed surface shows activity on either customer since the merge, the
// undo REFUSES (409, zero writes) instead of reasoning about how to unwind
// it — restoration finesse is reserved for state the journal recorded.
// "Activity" on a probed surface means:
//   - a row OUTSIDE the journaled repoint set — regardless of created_at
//     when the surface's rows can be UPDATED in place by soft-pointer
//     writers (an old booking intent re-captured post-merge keeps its old
//     created_at), or scoped to created/updated-since-merge for surfaces
//     where old rows legitimately pre-exist (the winner's own invoices);
//   - a JOURNALED row whose updated_at moved past the merge (the merge
//     itself never touches updated_at on plain repoints, and same-
//     transaction stamps share the merge's transaction timestamp, so
//     strictly-greater means someone touched it afterwards).
// ---------------------------------------------------------------------------
function countActivityRows(rows, { keyColumn = 'id', journaledIds, mergeAt, sinceOnly = false }) {
  const after = (v) => Boolean(mergeAt && v && new Date(v).getTime() > new Date(mergeAt).getTime());
  let n = 0;
  for (const row of rows) {
    if (journaledIds.has(row[keyColumn])) {
      if (after(row.updated_at)) n += 1;
    } else if (!sinceOnly || after(row.created_at) || after(row.updated_at)) {
      n += 1;
    }
  }
  return n;
}

// "Still the merge-written value" comparison for directly-applied winner
// fields (autopay). Timestamps round-trip through the journal's JSON as ISO
// strings while knex reads them back as Date objects — when both sides parse
// as instants, compare the instants.
function mergeWrittenValueUnchanged(current, applied) {
  if (backfillValueUnchanged(current, applied)) return true;
  if (current === null || current === undefined || applied === null || applied === undefined) return false;
  const ta = current instanceof Date ? current.getTime() : Date.parse(current);
  const tb = applied instanceof Date ? applied.getTime() : Date.parse(applied);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

/**
 * Record the customer_properties row the link-as-property flow created AFTER
 * the merge transaction committed, so the revert can remove it (the address
 * belongs to the restored loser again). One atomic jsonb_set — either the
 * journal knows about the property or the write fails whole; propertyId null
 * records "link flow completed, nothing created" (deduped / no address).
 * The revert REFUSES link-as-property merges whose journal lacks this key,
 * so a failed call here leaves the merge non-revertible, never half-recorded.
 */
async function recordLinkedProperty({ journalId, propertyId = null }) {
  await db('customer_merge_journal')
    .where({ id: journalId })
    .update({
      repointed_ids: db.raw(
        `jsonb_set(coalesce(repointed_ids, '{}'::jsonb), '{linked_property_id}',
           coalesce(to_jsonb(?::text), 'null'::jsonb))`,
        [propertyId],
      ),
    });
}

/**
 * Revert a journaled merge: un-retire the loser from its snapshot, repoint
 * the recorded row ids back, move a transferred Stripe id back ONLY when it
 * provably still sits on the winner, stamp undone_at/undone_by, one admin
 * bell. Repoints OWNERSHIP records only — never touches Stripe itself and
 * never creates or modifies charges. Refusals throw with statusCode 409 and
 * a human-readable reason.
 */
async function revertMerge({ journalId, performedBy, performedById }) {
  const refuse = (reason) => {
    const err = new Error(reason);
    err.statusCode = 409;
    throw err;
  };
  const result = await db.transaction(async (trx) => {
    const journal = await trx('customer_merge_journal').where({ id: journalId }).forUpdate().first();
    if (!journal) refuse('Merge journal entry not found');
    if (journal.undone_at) refuse('This merge has already been undone');
    const snapshot = parseJsonb(journal.loser_snapshot);
    if (!snapshot || !snapshot.id) refuse('Journal has no loser snapshot — cannot revert');
    const recorded = parseJsonb(journal.repointed_ids);
    if (!recorded || !recorded.tables) {
      refuse('This merge predates row-level undo records and cannot be auto-reverted — restore by hand from the journal snapshot');
    }
    // A unique-collision handler folded/merged/dropped rows the journal has
    // no per-row record of — replaying the recorded repoints would restore
    // only part of the loser's data. Not auto-revertible.
    if (Array.isArray(recorded.collision_handlers) && recorded.collision_handlers.length) {
      refuse(`This merge folded colliding rows (${recorded.collision_handlers.join(', ')}) that cannot be split back apart automatically — restore by hand from the journal snapshot`);
    }
    // Link-as-property merges create the winner-owned property row AFTER the
    // merge transaction commits; if the journal never learned its id, an
    // undo would leave the restored loser's address duplicated on the
    // winner. Fail closed.
    const evidence = parseJsonb(journal.evidence) || {};
    if (evidence.via === 'admin_link_as_property' && !('linked_property_id' in recorded)) {
      refuse('The property row this merge created was never recorded in the journal — revert by hand');
    }
    // Shared by every activity probe below: the merge's timestamp and the
    // journaled key set for a given table (union of that table's recorded
    // per-row lists; count-only records contribute nothing — their tables
    // refuse or skip through their own paths).
    const mergeAt = journal.created_at || null;
    const journaledIdsFor = (table) => {
      const set = new Set();
      for (const [key, ids] of Object.entries(recorded.tables)) {
        if (key.startsWith(`${table}.`) && Array.isArray(ids)) {
          for (const id of ids) set.add(id);
        }
      }
      return set;
    };
    // payment_methods rows moved without their original default/autopay
    // flags journaled: restoring ownership but not the flags could leave
    // autopay charging the wrong card. Fail closed (billing continuity).
    const pmTableKeys = Object.keys(recorded.tables).filter((k) => k.startsWith('payment_methods.'));
    const pmFlags = recorded.payment_method_flags || null;
    for (const key of pmTableKeys) {
      const ids = recorded.tables[key];
      if (!Array.isArray(ids)) continue; // count-only — refused below as financial
      if (ids.length && (!pmFlags || ids.some((id) => !pmFlags[id]))) {
        refuse('Payment methods were moved without their default/autopay flags journaled — revert by hand (billing continuity)');
      }
    }
    const winnerId = journal.winner_customer_id;
    const loserId = journal.loser_customer_id;
    const locked = await trx('customers').whereIn('id', [winnerId, loserId]).forUpdate().select('*');
    const winner = locked.find((r) => r.id === winnerId);
    const loserRow = locked.find((r) => r.id === loserId);
    if (!winner) refuse('The kept customer no longer exists');
    if (winner.deleted_at || winner.active === false) {
      refuse('The kept customer is inactive or deleted — reactivate it before undoing the merge');
    }
    if (!loserRow) refuse('The merged-away customer row was purged — cannot restore it');
    if (!loserRow.deleted_at) refuse('The merged-away customer is already live — nothing to undo');

    // Stripe drift + moved saved cards is a REFUSAL, not a skip: when the
    // journal records a transferred Stripe id that no longer sits on the
    // winner, the id cannot move back — but the recorded payment_methods
    // rows WOULD still repoint, leaving the restored customer holding saved
    // cards that reference a Stripe profile its row doesn't have. A
    // financially-relevant restoration that can't be exact refuses whole
    // (409, zero writes). Without moved cards the id is merely reported as
    // not restored (skip) below.
    const transferredStripe = recorded.stripe_transferred_id || null;
    const pmRowsRecorded = pmTableKeys.some((key) => {
      const ids = recorded.tables[key];
      return Array.isArray(ids) ? ids.length > 0 : true;
    });
    if (transferredStripe && winner.stripe_customer_id !== transferredStripe && pmRowsRecorded) {
      refuse("The kept customer's Stripe profile has changed since the merge, and saved payment methods were moved — repointing the cards back would leave them referencing a Stripe profile the restored customer no longer has; revert by hand");
    }
    // The mirror-image failure: the transferred Stripe id DID stay on the
    // winner, but the winner saved NEW payment methods after the merge —
    // rows not in the journaled repointed set, attached (per their
    // stripe_customer_id linkage) to the profile the undo would hand back
    // to the loser. Moving the id back would leave those winner-owned cards
    // referencing a Stripe customer the winner's row no longer has, and
    // autopay/card-on-file charges would strand. Financially-relevant
    // restoration can't be exact → refuse whole (409, zero writes). A
    // non-journaled card with a NULL stripe_customer_id is ambiguous
    // linkage — fail closed the same way. Nothing here touches Stripe
    // itself; the fix is to move/detach the new card in Stripe first.
    if (transferredStripe && winner.stripe_customer_id === transferredStripe) {
      const journaledPmIds = new Set();
      for (const key of pmTableKeys) {
        const ids = recorded.tables[key];
        if (Array.isArray(ids)) for (const id of ids) journaledPmIds.add(id);
      }
      // The winner's OWN pre-merge cards are exempt: in the derived-profile
      // case they legitimately sat on the transferred profile before the
      // merge, and the undo returns the winner to exactly that pre-merge
      // state — not a strand. Pre-upgrade journals lack the key (empty set)
      // and keep the conservative refusal.
      const winnerPremergePmIds = new Set(
        Array.isArray(recorded.winner_premerge_pm_ids) ? recorded.winner_premerge_pm_ids : [],
      );
      const winnerCards = await trx('payment_methods')
        .where({ customer_id: winnerId })
        .select('id', 'stripe_customer_id');
      const postMergeCards = winnerCards.filter((card) => !journaledPmIds.has(card.id)
        && !winnerPremergePmIds.has(card.id)
        && (!card.stripe_customer_id || card.stripe_customer_id === transferredStripe));
      if (postMergeCards.length) {
        refuse(`The kept customer saved ${postMergeCards.length} new payment method(s) on the transferred Stripe profile after the merge — moving the profile back to the restored customer would strand them; detach or move the new card(s) in Stripe first, then revert`);
      }
    }

    // Verification pass BEFORE any write: every recorded row must still point
    // at the winner, or it is state that moved on since the merge.
    const skipped = [];
    const plans = [];
    for (const [key, ids] of Object.entries(recorded.tables)) {
      const dot = key.indexOf('.');
      const table = key.slice(0, dot);
      const column = key.slice(dot + 1);
      if (!table || !column) continue;
      if (!Array.isArray(ids)) {
        // Count-only record (no plain id PK / over cap / mid-merge race).
        if (REVERT_FINANCIAL_TABLES.has(table)) {
          refuse(`${table} rows were repointed without row-level records — revert by hand from the journal`);
        }
        // Consent tables refuse too: skipping a recipient_optin restoration
        // doesn't lose history, it WIDENS consent — the table's semantics
        // treat a missing row as "allowed", so a pending/declined contact
        // left on the winner would start receiving texts after the split.
        if (CONSENT_CRITICAL_TABLES.has(table)) {
          refuse(`${table} rows (comms consent — a missing row means "allowed to text") were repointed without row-level records and cannot be exactly restored — revert by hand from the journal`);
        }
        skipped.push({ key, reason: 'no_row_ids_recorded' });
        continue;
      }
      if (!ids.length) continue;
      // Non-`id` PKs (REPOINT_PK_COLUMNS) verify and repoint by their real
      // key column — the journal recorded those keys at merge time.
      const pkColumn = REPOINT_PK_COLUMNS[table] || 'id';
      const isFinancial = REVERT_FINANCIAL_TABLES.has(table);
      let stillOnWinner = [];
      try {
        // Financial rows verify under FOR UPDATE so nothing can move them
        // between this check and the reverse repoint below; the repoint's
        // affected-count check is the belt to this suspender. They also
        // read updated_at: a journaled financial row TOUCHED since the
        // merge is activity, and moving it back would unwind state the
        // touch depends on (untouched-merges contract).
        let verifyQuery = trx(table).whereIn(pkColumn, ids).where(column, winnerId);
        if (isFinancial) verifyQuery = verifyQuery.forUpdate();
        const verified = await verifyQuery.select(isFinancial ? [pkColumn, 'updated_at'] : [pkColumn]);
        if (isFinancial) {
          const touched = countActivityRows(verified, {
            keyColumn: pkColumn, journaledIds: new Set(ids), mergeAt,
          });
          if (touched) {
            refuse(`${touched} ${table} row(s) recorded by this merge were updated after it — the undo reverts only untouched merges; reconcile them by hand`);
          }
        }
        stillOnWinner = verified.map((r) => r[pkColumn]);
      } catch (e) {
        if (e && e.statusCode === 409) throw e;
        if (isFinancial) {
          refuse(`Cannot verify ${table} ownership (${e.message}) — refusing to revert`);
        }
        skipped.push({ key, reason: `verify_failed: ${e.message}`, count: ids.length });
        continue;
      }
      const moved = ids.length - stillOnWinner.length;
      if (moved > 0) {
        if (REVERT_FINANCIAL_TABLES.has(table)) {
          refuse(`${moved} ${table} row(s) no longer belong to the kept customer — state has moved on; revert by hand`);
        }
        skipped.push({ key, reason: 'rows_changed_since_merge', count: moved });
      }
      if (stillOnWinner.length) plans.push({ key, table, column, pkColumn, ids: stillOnWinner });
    }

    // Child financial rows acquired by a journaled INVOICE since the merge:
    // a payment recorded against an invoice this undo moves back stays
    // winner-owned (payments repoint by customer_id, and an unjournaled one
    // is not in the plans), so the invoice would land on the restored
    // customer while the money that settled it sits on the kept one. Probed
    // HERE, in the pre-write pass, so no repoint ordering can defeat it.
    // Linkage per table (verified against the schema):
    //   payments — NO invoice_id column; invoices are referenced through
    //     metadata jsonb (invoice_id / dispute_invoice_id /
    //     waves_invoice_id), exactly as invoice.js resolves applied money.
    //   customer_credit_ledger — real invoice_id column.
    // (payment_plans and annual_prepay_terms also key on invoices, but they
    // are themselves REVERT_FINANCIAL_TABLES: an unjournaled plan for the
    // winner is not repointed and does not follow the invoice, while a
    // journaled one is already covered by the drift refusal above.)
    const journaledInvoiceIds = [...journaledIdsFor('invoices')];
    if (journaledInvoiceIds.length) {
      const invoiceChildProbes = [
        {
          table: 'payments',
          query: (q) => q.whereRaw(
            "(metadata::jsonb ->> 'invoice_id' = ANY(?) OR metadata::jsonb ->> 'dispute_invoice_id' = ANY(?) OR metadata::jsonb ->> 'waves_invoice_id' = ANY(?))",
            [journaledInvoiceIds, journaledInvoiceIds, journaledInvoiceIds],
          ),
          label: 'payment(s)',
        },
        {
          table: 'customer_credit_ledger',
          query: (q) => q.whereIn('invoice_id', journaledInvoiceIds),
          label: 'credit-ledger entr(ies)',
        },
      ];
      for (const probe of invoiceChildProbes) {
        let rows = [];
        try {
          rows = await probe.query(trx(probe.table)).select('id', 'updated_at');
        } catch (e) {
          refuse(`Cannot verify ${probe.table} against the invoices this merge moved (${e.message}) — refusing to revert`);
        }
        const activity = countActivityRows(rows, {
          journaledIds: journaledIdsFor(probe.table), mergeAt,
        });
        if (activity) {
          refuse(`${activity} ${probe.label} recorded against this merge's invoices are outside its journal — undoing would separate the invoice from the money that settled it; reconcile by hand`);
        }
      }
    }

    // Payment-method consents are IMMUTABLE authorizations bound to
    // (customer, method) — hasConsentFor requires both to match, so a
    // consent captured for the WINNER on a card this undo returns to the
    // loser authorizes nothing after the split, and a consent row we did
    // not journal is post-merge activity. Any unjournaled consent tied to
    // a returned card REFUSES the undo (untouched-merges contract).
    const pmReturnIds = plans.filter((p) => p.table === 'payment_methods').flatMap((p) => p.ids);
    if (pmReturnIds.length) {
      let consentRows = [];
      try {
        consentRows = await trx('payment_method_consents')
          .whereIn('payment_method_id', pmReturnIds)
          .select('id');
      } catch (e) {
        refuse(`Cannot verify payment_method_consents for the returned card(s) (${e.message}) — refusing to revert`);
      }
      const consentActivity = countActivityRows(consentRows, {
        journaledIds: journaledIdsFor('payment_method_consents'), mergeAt,
      });
      if (consentActivity) {
        refuse(`${consentActivity} payment-method consent record(s) tied to the returned card(s) are outside this merge's journal — post-merge authorizations cannot be split back; revert by hand`);
      }
    }

    const repointedBack = {};
    for (const plan of plans) {
      const count = await trx(plan.table)
        .whereIn(plan.pkColumn, plan.ids)
        .where(plan.column, winnerId)
        .update({ [plan.column]: loserId });
      // The update must cover EXACTLY the verified rows. On a financial
      // table any shortfall aborts (throw → transaction rollback → zero
      // writes); elsewhere it is reported like any other moved-on row.
      if (count !== plan.ids.length) {
        if (REVERT_FINANCIAL_TABLES.has(plan.table)) {
          refuse(`${plan.table} changed while reverting (${count}/${plan.ids.length} rows moved back) — nothing was changed; retry`);
        }
        skipped.push({ key: plan.key, reason: 'rows_changed_during_revert', count: plan.ids.length - count });
      }
      if (count) repointedBack[plan.key] = count;
    }

    // Restore each moved-back payment method's ORIGINAL default/autopay
    // flags (the merge demoted them when the winner already had a default).
    // Presence of a flag record for every moved id was verified above.
    for (const plan of plans) {
      if (plan.table !== 'payment_methods') continue;
      for (const id of plan.ids) {
        const flags = pmFlags[id];
        await trx('payment_methods').where({ id, customer_id: loserId }).update({
          is_default: flags.is_default === true,
          autopay_enabled: flags.autopay_enabled === true,
          updated_at: trx.fn.now(),
        });
      }
    }

    // The property row link-as-property created from the loser's address
    // belongs to the restored loser again — take it off the winner. HOW
    // matters: scheduled_services.property_id references customer_properties
    // ON DELETE SET NULL (20260709000001), so deleting a row that
    // appointments point at would silently strip their property link — it
    // never errors, so an FK-failure fallback can never catch it. Check for
    // referencing visits FIRST: referenced rows TRANSFER to the restored
    // loser (the address is theirs and the appointments keep their link);
    // only an unreferenced row deletes. A savepoint still guards the delete
    // against RESTRICT references from other tables acquired since the
    // merge — those degrade to the same transfer.
    if (recorded.linked_property_id) {
      const propWhere = { id: recorded.linked_property_id, customer_id: winnerId };
      const transferToLoser = async () => trx('customer_properties')
        .where(propWhere)
        .update({ customer_id: loserId, updated_at: trx.fn.now() });
      // LOCK ORDER — property row FIRST (FOR UPDATE), THEN its referencing
      // visits. A booking insert must take a KEY SHARE lock on the parent
      // property row for its FK, which conflicts with our FOR UPDATE: a
      // concurrent booking therefore either commits BEFORE our lock (and
      // the probe below sees its visit) or blocks until this transaction
      // ends (and then errors on the FK if we deleted the row) — it can
      // never slip between probe and delete to be silently property-
      // stripped by the SET NULL FK. The visits lock is the belt: a probed
      // visit's customer_id can't change under the classification below.
      const lockedProperty = await trx('customer_properties')
        .where(propWhere)
        .forUpdate()
        .first('id');
      const referencingVisits = lockedProperty
        ? await trx('scheduled_services')
          .where({ property_id: recorded.linked_property_id })
          .forUpdate()
          .select('id', 'customer_id')
        : [];
      // The transfer must leave EVERY referencing visit belonging to the
      // RESTORED customer. The journaled visits (the loser's own) were
      // moved back above and read loser-owned here; anything else — a
      // winner visit booked after the merge, or a journaled visit the
      // skip path left on the winner or a THIRD customer — would end up
      // referencing a property on someone else's account. Moving visits
      // between customers has billing/comms side effects we must not
      // automate — REFUSE (409; the throw rolls the transaction back to
      // zero writes). Rebook or reassign the appointment first, then
      // revert. (Untouched-merges contract.)
      const strandedVisits = referencingVisits.filter((v) => v.customer_id !== loserId);
      if (strandedVisits.length) {
        refuse(`${strandedVisits.length} appointment(s) referencing the linked property would not belong to the restored customer after the undo — moving visits between customers has billing/comms side effects; rebook or reassign them first, then revert`);
      }
      let removed = 0;
      let transferred = 0;
      if (!lockedProperty) {
        // Row already gone or re-owned — nothing to act on (and nothing was
        // locked); report it like any moved-on state.
      } else if (referencingVisits.length) {
        transferred = await transferToLoser();
        if (transferred) {
          repointedBack['customer_properties.linked_property_transferred'] = transferred;
        }
      } else {
        try {
          await trx.transaction(async (sp) => {
            removed = await sp('customer_properties').where(propWhere).del();
          });
          if (removed) repointedBack['customer_properties.linked_property_removed'] = removed;
        } catch (e) {
          transferred = await transferToLoser();
          if (transferred) {
            repointedBack['customer_properties.linked_property_transferred'] = transferred;
            skipped.push({ key: 'customer_properties.linked_property', reason: `transferred_not_deleted: ${e.message}` });
          }
        }
      }
      if (!removed && !transferred) {
        skipped.push({ key: 'customer_properties.linked_property', reason: 'row_missing_or_moved' });
      }
    }

    // Winner-side undo: the transferred Stripe id (only when it provably
    // still sits on the winner), a primary-profile demotion, the moved
    // cached credits, and EVERY recorded winner backfill (billing AND
    // contact — payer_id, billing_mode, per_application_fee, name/address
    // copies, consent stamps, ...) that is UNCHANGED on the winner since the
    // merge. A backfill an admin has since edited stays put and is reported.
    const backfills = parseJsonb(journal.winner_backfills) || {};
    const winnerPatch = {};
    let stripeMovedBack = false;
    if (transferredStripe) {
      if (winner.stripe_customer_id !== transferredStripe) {
        skipped.push({ key: 'customers.stripe_customer_id', reason: 'winner_stripe_changed_since_merge' });
      } else {
        // WHICH side supplied the transferred id decides where it goes
        // back (repointed_ids.stripe_derived_from, journaled at merge
        // time): null/'loser' — the loser's row named it, or its cards
        // alone identified it → moves back to the loser as before.
        // 'winner'/'both' — the KEPT customer's own cards identified the
        // profile (the derivation aggregates both sides' cards), so it
        // stays with the winner; if the undo is also returning cards, they
        // would ride a profile the restored customer doesn't own → REFUSE
        // ('both' is treated as winner-involved conservatively — the id
        // cannot follow both sides). Pre-upgrade journals lack the key:
        // with returned cards the attribution is unknowable → REFUSE
        // (conservative); without cards, the classic move-back stands.
        const derivedFrom = Object.prototype.hasOwnProperty.call(recorded, 'stripe_derived_from')
          ? recorded.stripe_derived_from
          : undefined;
        const pmRowsReturned = pmTableKeys.some((k) => {
          const ids = recorded.tables[k];
          return Array.isArray(ids) && ids.length > 0;
        });
        if (derivedFrom === undefined && pmRowsReturned) {
          refuse('This merge predates Stripe-derivation records and moved payment methods — which side the transferred profile belongs to cannot be attributed; revert by hand');
        } else if (derivedFrom === 'winner' || derivedFrom === 'both') {
          if (pmRowsReturned) {
            refuse("The transferred Stripe profile was identified from the kept customer's own saved cards — the returned cards would ride a profile the restored customer doesn't own; resolve in Stripe first, then revert");
          }
          skipped.push({ key: 'customers.stripe_customer_id', reason: 'stripe_profile_winner_derived' });
        } else {
          winnerPatch.stripe_customer_id = null;
          stripeMovedBack = true;
        }
      }
    }
    if (backfills.is_primary_profile === true && winner.is_primary_profile === true) {
      winnerPatch.is_primary_profile = false;
    }
    // Winner fields the merge deliberately OVERWROTE (address-tuple
    // replacement, consent-stamp clear): winner_prior_values holds the
    // pre-merge values, so those fields RESTORE below instead of merely
    // vacating to null here. Pre-upgrade journals lack the key and keep the
    // old behavior (clear-to-null / stay-cleared).
    const priorValues = recorded.winner_prior_values || {};
    for (const [field, value] of Object.entries(backfills)) {
      if (REVERT_BACKFILL_CLEAR_EXCLUDED.has(field)) continue;
      // Restored (not just vacated) by the prior-values pass below.
      if (Object.prototype.hasOwnProperty.call(priorValues, field)) continue;
      // Null backfills (e.g. the consent-stamp clear) copied nothing onto
      // the winner — there is nothing to vacate.
      if (value === null || value === undefined) continue;
      if (backfillValueUnchanged(winner[field], value)) {
        winnerPatch[field] = null;
      } else {
        skipped.push({ key: `customers.${field}`, reason: 'winner_value_changed_since_merge' });
      }
    }
    // Email-bound artifacts created AFTER the merge: the merge backfilled
    // the loser's email onto the winner, and comms/billing surfaces created
    // since then deliver to it. The probe set is EMAIL_BOUND_SURFACES — the
    // hand-mirror of customer-email-fanout.js's canonical registry (see the
    // constant's comment). Clearing the email out from under any of them
    // orphans its delivery target, and re-pointing or rotating them has
    // comms side effects we must not automate — REFUSE (409, zero writes).
    // Journaled rows are pre-merge (they move back with the undo) and the
    // created_at cut excludes them too. Only runs when the undo would
    // actually clear the email; a since-edited winner email skips the clear
    // and needs no probe. An unreadable probe table refuses too — an
    // artifact we can't check is an artifact we can't clear from under.
    if (backfills.email && winnerPatch.email === null
      && Object.prototype.hasOwnProperty.call(winnerPatch, 'email')) {
      // Serialize against concurrent email-queue inserts BEFORE probing:
      // the template-run executor writes email_template_automation_runs
      // keyed by recipient_id — a STRING customer id with no FK — so none
      // of the row locks above can fence its insert path; a run queued
      // between probe and commit would deliver to the email this undo is
      // clearing. Both sides take the same per-customer advisory lock.
      // KEY DERIVATION (must stay byte-identical to
      // email-template-automation-executor.js createRun — extend BOTH in
      // the same commit): pg_advisory_xact_lock(hashtextextended(
      //   'customer-comms:' || <customer id>, 0)) — transaction-scoped, so
      // it releases with this undo's commit/rollback.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`customer-comms:${winnerId}`]);
      const emailLower = String(backfills.email).trim().toLowerCase();
      const emailBlockers = [];
      for (const probe of EMAIL_BOUND_SURFACES) {
        let rows = [];
        try {
          let query = trx(probe.table)
            .where(probe.linkColumn, probe.linkValue ? probe.linkValue(winnerId) : winnerId)
            .whereRaw(`lower(${probe.emailColumn}) = ?`, [emailLower])
            .select('id', 'updated_at');
          query = probe.active(query);
          // Deliberately NO created_at cut (untouched-merges contract):
          // soft-pointer writers UPDATE old rows in place (capture-intent
          // re-captures an existing booking intent with post-merge contact
          // data while its created_at stays pre-merge), so any matching
          // row outside the journal is activity regardless of age — and a
          // JOURNALED row whose updated_at moved past the merge is too.
          rows = await query;
        } catch (e) {
          refuse(`Cannot verify ${probe.table} for artifacts bound to the merged-in email (${e.message}) — refusing to revert`);
        }
        const found = countActivityRows(rows, { journaledIds: journaledIdsFor(probe.table), mergeAt });
        if (found) emailBlockers.push(`${found} ${probe.label}`);
      }
      if (emailBlockers.length) {
        refuse(`The kept customer has ${emailBlockers.join(', ')} that still deliver to the merged-in email outside this merge's journal — the undo reverts only untouched merges; resolve or re-address them first, then revert`);
      }
    }
    // Inherited billing identity (billing_mode / per_application_fee /
    // payer_id) clears only on an UNTOUCHED merge: completion billing and
    // the monthly cron read these LIVE off the customer row, so winner
    // billing artifacts created or updated since the merge outside the
    // journal were priced/routed under the inherited values — clearing
    // them out from under that history is not an exact restoration →
    // REFUSE. The winner's own pre-merge artifacts are exempt (sinceOnly):
    // they existed under the winner's original identity.
    const clearingBillingIdentity = ['billing_mode', 'per_application_fee', 'payer_id']
      .some((f) => Object.prototype.hasOwnProperty.call(winnerPatch, f) && winnerPatch[f] === null);
    if (clearingBillingIdentity) {
      for (const table of ['scheduled_services', 'invoices']) {
        let rows = [];
        try {
          rows = await trx(table)
            .where({ customer_id: winnerId })
            .select('id', 'created_at', 'updated_at');
        } catch (e) {
          refuse(`Cannot verify ${table} for billing activity since the merge (${e.message}) — refusing to revert`);
        }
        const activity = countActivityRows(rows, {
          journaledIds: journaledIdsFor(table), mergeAt, sinceOnly: true,
        });
        if (activity) {
          refuse(`${activity} ${table} row(s) were created or updated since the merge while the kept customer carried the merged-in billing identity — clearing it now would orphan how they were billed; reconcile billing first, then revert`);
        }
      }
    }
    // Winner customer-level autopay state the merge overwrote directly (the
    // most-restrictive carry): restore the winner's ORIGINAL values, but
    // only where the current value is still the merge-written one — an
    // admin's later autopay change stays put and is reported. Pre-upgrade
    // journals lack winner_autopay_before (no way to detect an
    // autopay-affected merge retroactively) and keep today's behavior: the
    // winner simply stays most-restrictive, never a silent re-enable.
    const autopayBefore = recorded.winner_autopay_before || null;
    if (autopayBefore && autopayBefore.applied && autopayBefore.before) {
      for (const [col, appliedVal] of Object.entries(autopayBefore.applied)) {
        if (mergeWrittenValueUnchanged(winner[col], appliedVal)) {
          winnerPatch[col] = Object.prototype.hasOwnProperty.call(autopayBefore.before, col)
            ? autopayBefore.before[col]
            : null;
        } else {
          skipped.push({ key: `customers.${col}`, reason: 'winner_value_changed_since_merge' });
        }
      }
    }
    // The merge folded the loser's crm/technician notes into the winner;
    // the loser's originals restore from its snapshot, and the winner's own
    // pre-fold notes restore here while the current value is still the
    // merge-written concatenation — an operator who edited the notes since
    // keeps their edit, REPORTED as skipped (never silent). Pre-upgrade
    // journals lack winner_note_appends: the folded text stays.
    const noteAppendsRecorded = recorded.winner_note_appends || null;
    if (noteAppendsRecorded && noteAppendsRecorded.applied && noteAppendsRecorded.before) {
      for (const [col, appliedVal] of Object.entries(noteAppendsRecorded.applied)) {
        if (mergeWrittenValueUnchanged(winner[col], appliedVal)) {
          winnerPatch[col] = Object.prototype.hasOwnProperty.call(noteAppendsRecorded.before, col)
            ? noteAppendsRecorded.before[col]
            : null;
        } else {
          skipped.push({ key: `customers.${col}`, reason: 'winner_value_changed_since_merge' });
        }
      }
    }
    // Winner fields the merge deliberately OVERWROTE: restore each journaled
    // prior value while the winner's current value is still the
    // merge-written one — winner_backfills records what the merge wrote
    // (null for the consent-stamp clear, the loser's value for the
    // address-tuple replacement). A field an admin edited since stays put
    // and is reported.
    for (const [field, prior] of Object.entries(priorValues)) {
      if (prior === null || prior === undefined) continue;
      const current = winner[field];
      const appliedVal = Object.prototype.hasOwnProperty.call(backfills, field) ? backfills[field] : null;
      const stillMergeWritten = (appliedVal === null || appliedVal === undefined)
        ? (current === null || current === undefined || String(current).trim() === '')
        : mergeWrittenValueUnchanged(current, appliedVal);
      if (stillMergeWritten) {
        winnerPatch[field] = prior;
      } else {
        skipped.push({ key: `customers.${field}`, reason: 'winner_value_changed_since_merge' });
      }
    }
    // Cached credit balance: when recorded ledger rows moved back above,
    // RECOMPUTE both caches from the ledgers post-move so cache == ledger
    // holds on BOTH sides (customer-credit.js invariant) — and refuse when
    // the winner's spending since the merge has consumed the loser's credit
    // (its ledger would sum negative after giving the rows back). Without
    // moved ledger rows, fall back to moving the snapshot amount only while
    // the winner still holds it.
    const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const ledgerMovedBack = plans.some((p) => p.table === 'customer_credit_ledger');
    let creditsMovedBack = 0;
    let loserCreditsAfter = 0;
    if (ledgerMovedBack) {
      const ledgerSum = async (customerId) => {
        const row = await trx('customer_credit_ledger')
          .where({ customer_id: customerId }).sum('delta as total').first();
        return round2(row && row.total);
      };
      const winnerLedgerSum = await ledgerSum(winnerId);
      loserCreditsAfter = await ledgerSum(loserId);
      if (winnerLedgerSum < 0) {
        refuse("The kept customer's spending has consumed the merged-in credit — undoing would leave a negative balance; reconcile credits by hand");
      }
      if (loserCreditsAfter < 0) {
        refuse("The restored customer's credit ledger would go negative — reconcile credits by hand");
      }
      winnerPatch.account_credits = winnerLedgerSum;
      creditsMovedBack = loserCreditsAfter;
    } else {
      const movedCredits = round2(snapshot.account_credits);
      if (movedCredits > 0) {
        if (Number(winner.account_credits || 0) >= movedCredits) {
          creditsMovedBack = movedCredits;
          loserCreditsAfter = movedCredits;
        } else {
          skipped.push({ key: 'customers.account_credits', reason: 'winner_balance_below_moved_amount' });
        }
      }
    }
    if (Object.keys(winnerPatch).length) {
      await trx('customers').where({ id: winnerId }).update({ ...winnerPatch, updated_at: trx.fn.now() });
    }
    if (!ledgerMovedBack && creditsMovedBack) {
      await trx('customers').where({ id: winnerId }).decrement('account_credits', creditsMovedBack);
    }

    // Un-retire the loser from the snapshot: exactly what the retire cleared.
    // Anything the merge merely folded (notes appends, pref merges, dropped
    // derived rows) is out of scope — the snapshot keeps the originals.
    const restore = {
      active: true,
      deleted_at: null,
      phone: snapshot.phone,
      email: snapshot.email || null,
      payer_id: snapshot.payer_id || null,
      billing_mode: snapshot.billing_mode || null,
      is_primary_profile: snapshot.is_primary_profile === true,
      account_credits: loserCreditsAfter,
      updated_at: trx.fn.now(),
    };
    // Restore the RECORDED transferred id, not the snapshot's: in the
    // derived-Stripe case (neither customer row named a profile, the
    // loser's saved cards identified one) the snapshot holds null while the
    // repointed cards live on the derived profile — the restored loser must
    // own it or its cards reference a Stripe customer its row doesn't
    // have. In the loser-only-profile case the two values are identical.
    // Guarded as elsewhere: stripeMovedBack is only true when the id
    // provably still sat on the winner (drift and post-merge-cards
    // refusals above).
    if (stripeMovedBack) {
      restore.stripe_customer_id = transferredStripe;
    } else if (!transferredStripe && snapshot.stripe_customer_id) {
      // SHARED-profile case: both rows named the SAME Stripe customer
      // pre-merge (a differing pair is refused at merge time), so nothing
      // was transferred (stripe_transferred_id null) and the retire cleared
      // the loser's copy. Restoring the snapshot's own id is safe — the
      // winner keeps the shared profile, and without it the loser's
      // returned cards would reference a Stripe customer its row doesn't
      // have. The drift-skip case (transferredStripe set but not moved
      // back) deliberately still restores NO id.
      restore.stripe_customer_id = snapshot.stripe_customer_id;
    }
    try {
      await trx.transaction(async (sp) => {
        await sp('customers').where({ id: loserId }).update(restore);
      });
    } catch (e) {
      if (!(e && e.code === '23505')) throw e;
      // Email uniqueness tripped: another live customer now owns the
      // address. A null-email partial restoration would leave every
      // repointed sendable (estimates, contracts, queued runs) targeting
      // an address that belongs to SOMEONE ELSE — identity cannot be
      // partially restored. REFUSE the whole transaction (409, zero
      // writes via rollback). Untouched-merges contract.
      refuse("The merged-away customer's email address is now used by another live customer — restoring the account without its address would leave its communications targeting someone else's mailbox; resolve the address conflict first, then revert");
    }

    await trx('customer_merge_journal').where({ id: journalId }).update({
      undone_at: trx.fn.now(),
      undone_by: performedBy || 'unknown',
    });

    // ID-only in plaintext logs — the full staff identity lives in the
    // journal's undone_by audit column, never the log stream.
    logger.info(`[customer-dedupe] merge ${journalId} reverted: ${loserId} split back out of ${winnerId} by tech ${performedById || 'unknown'}`);
    return {
      journalId,
      winnerId,
      loserId,
      repointedBack,
      skipped,
      stripeMovedBack,
      creditsMovedBack,
      loserName: [snapshot.first_name, snapshot.last_name].filter(Boolean).join(' ') || 'Unknown',
      winnerName: [winner.first_name, winner.last_name].filter(Boolean).join(' ') || 'Unknown',
    };
  });

  // Post-commit on purpose: a failed bell must never roll back the revert.
  try {
    const back = Object.values(result.repointedBack).reduce((n, c) => n + Number(c || 0), 0);
    const skippedNote = result.skipped.length
      ? ` ${result.skipped.length} item(s) could not be restored automatically (state moved on since the merge).`
      : '';
    await require('./notification-service').notifyAdmin(
      'customer',
      `Merge undone: ${result.loserName} restored`,
      `${result.loserName} was split back out of ${result.winnerName}; ${back} row(s) repointed back.${skippedNote}`,
      {
        link: `/admin/customers?customerId=${result.loserId}`,
        metadata: {
          journalId: result.journalId,
          skipped: result.skipped,
          stripeMovedBack: result.stripeMovedBack,
        },
      },
    );
  } catch (notifyErr) {
    logger.warn(`[customer-dedupe] revert notify failed (non-blocking): ${notifyErr.message}`);
  }
  return result;
}

module.exports = {
  findDuplicateGroups,
  executeMerge,
  runAutoMergeSweep,
  runRedPairAutoDismissSweep,
  revertMerge,
  recordLinkedProperty,
  // Refuse-policy sets, exported so GET /merges' revertible mirror can never
  // drift from the revert endpoint's own count-only refusals.
  REVERT_FINANCIAL_TABLES,
  CONSENT_CRITICAL_TABLES,
  // exported for tests
  _test: {
    EMAIL_BOUND_SURFACES,
    REPOINT_PK_COLUMNS,
    countActivityRows,
    phone10,
    normalizeStreetKey,
    namesCompatible,
    addressCompat,
    pickWinner,
    isEmptyValue,
    mergeSingletonPrefRow,
    repointRowwiseDropCollisions,
    mergeConversationRows,
    resetFkCache: () => { fkColumnsCache = null; },
  },
};
