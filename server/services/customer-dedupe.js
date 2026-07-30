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
    if (foreignPmStripe.length) {
      if (!effectiveWinnerStripe && allPmStripeIds.length === 1) {
        derivedStripeCustomerId = allPmStripeIds[0];
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
    const loserCardIds = (await trx('payment_methods')
      .where({ customer_id: loserId }).select('id')).map((r) => r.id);

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
      try {
        await trx.transaction(async (sp) => {
          const count = await sp(table)
            .where({ [typeColumn]: 'customer', [idColumn]: loserId })
            .update({ [idColumn]: winnerId });
          if (count) repointed[`${table}.${idColumn}`] = count;
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
    if (Object.keys(noteAppends).length) {
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
    if (Object.keys(autopayRestrictions).length) {
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
    repointRowwiseDropCollisions,
    mergeConversationRows,
    resetFkCache: () => { fkColumnsCache = null; },
  },
};
