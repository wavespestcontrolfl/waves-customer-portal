// ============================================================
// rodent-bait-legacy-replay.js
//
// Saved rodent-bait pricing evidence for saved-estimate replays
// (codex #3591 r2 P0). A pre-2026-08-29 estimate carries a rodent line
// with NO new-model marker (perApplicationBilled / stations /
// RODENT_BAIT_BRACKET basis) — replaying it through the current engine
// would swap the disclosed monthly (or commercial cost-buildup) price for
// the new bracket ladder. This module derives a PIN from the stored
// result; the engine reproduces the pinned dollar figure as a
// legacy-posture line (monthly-billed, no tier count, no %).
//
// Shared by BOTH replay paths — estimate-public's
// savedFloorReplayOverrides (public view/accept recompute) and
// admin-estimate-persistence's authoritative recompute
// (replaySavedPricingKnobs) — same evidence, same verdict, mirroring
// commercial-floor-replay.js.
// ============================================================

// The realignment ROLLOUT INSTANT (owner directive 2026-08-29): the moment
// migration 20260829000040 ran in THIS database (knex_migrations.migration_time
// — the same rollout-instant source estimate-learning and review-reply read).
// A DIRECT rodent bait series (no source estimate — admin booking, call
// booking, /secure) whose ROOT row was created at/after that instant can only
// have been priced by the bracket ladder, so it is new-model; a root created
// before it keeps its snapshotted rate (codex #3591 r36/r37 P1 — a calendar
// date read through UTC mislabeled a legacy series booked the same day
// before the deploy, or after 20:00 ET the evening before). No migration row
// (env never migrated) or an unreadable one → 0 → nothing qualifies (fail
// closed). Cached per database handle; a failed lookup is not cached.
const RODENT_BAIT_REALIGNMENT_MIGRATION = '20260829000040_rodent_bait_bracket_realignment';
const rolloutCache = new WeakMap();
function rodentRealignmentRolloutMs(database) {
  if (!database || (typeof database !== 'function' && typeof database !== 'object')) return Promise.resolve(0);
  let pending = rolloutCache.get(database);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => database('knex_migrations')
        .where('name', 'like', `${RODENT_BAIT_REALIGNMENT_MIGRATION}%`)
        .orderBy('id', 'asc')
        .first('migration_time'))
      .then((row) => {
        const ts = new Date(row?.migration_time ?? NaN).getTime();
        if (!Number.isFinite(ts) || ts <= 0) { rolloutCache.delete(database); return 0; }
        // DEPLOY-OVERLAP DRAIN (codex #3591 r51 P1): Railway runs this
        // migration as preDeployCommand while the PREVIOUS instance still
        // takes traffic — a legacy writer can create a direct series for
        // minutes after migration_time. Rows born in the drain window are
        // treated as grandfathered (fail toward not re-pricing / not
        // charging), so the boundary is the migration instant PLUS the
        // window that outlives any realistic old-writer overlap.
        return ts + 30 * 60 * 1000;
      })
      .catch(() => { rolloutCache.delete(database); return 0; });
    rolloutCache.set(database, pending);
  }
  return pending;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function rodentBaitLegacyReplaySignal(estData = {}) {
  const result = estData?.result && typeof estData.result === 'object' ? estData.result : (estData || {});
  const containers = [result, estData?.engineResult].filter((c) => c && typeof c === 'object');
  for (const c of containers) {
    const rows = [
      ...(Array.isArray(c?.recurring?.services) ? c.recurring.services : []),
      ...(Array.isArray(c?.lineItems) ? c.lineItems : []),
    ];
    const rodentRows = rows.filter((svc) => {
      const raw = String(svc?.service || svc?.serviceKey || svc?.service_key || '').toLowerCase();
      return raw === 'rodent_bait' || raw === 'commercial_rodent_bait';
    });
    // Any new-model evidence on the stored result → replay live (no pin).
    if (rodentRows.some((svc) => svc.perApplicationBilled === true
      || Number(svc.stations) > 0
      || svc.pricingBasis === 'RODENT_BAIT_BRACKET')) return null;
    if (Number(c?.results?.rodentBait?.stations) > 0 || Number(c?.results?.rodBait?.stations) > 0) return null;

    const commercialRow = rodentRows.find((svc) => String(svc?.service || '').toLowerCase() === 'commercial_rodent_bait'
      && Number(svc.annual) > 0);
    if (commercialRow) {
      return {
        commercialAnnual: Number(commercialRow.annual),
        commercialVisits: Number(commercialRow.visitsPerYear) > 0 ? Number(commercialRow.visitsPerYear) : 4,
      };
    }
    const residentialRow = rodentRows.find((svc) => String(svc?.service || '').toLowerCase() === 'rodent_bait');
    const monthly = firstPositiveNumber(
      residentialRow?.mo,
      residentialRow?.monthly,
      c?.recurring?.rodentBaitMo,
      c?.results?.rodBaitMo,
    );
    if (monthly) return { monthly };
  }
  return null;
}

// NEW-MODEL posture freeze (codex #3591 r43 P1): a bracket-priced rodent row
// stamps the rodent_waveguard flags in force at save time (tierQualifier /
// excludeFromPctDiscount, service-pricing.js). A saved replay must keep that
// posture — flipping the live flag after send must not move a sent quote's
// tier or discounts. Returns { tierQualifier, excludeFromPctDiscount } from
// the stored new-model residential rodent row, or null when the estimate has
// no such row or the row predates the posture stamps (inject nothing).
function rodentWaveguardPostureReplaySignal(estData = {}) {
  const result = estData?.result && typeof estData.result === 'object' ? estData.result : (estData || {});
  const containers = [result, estData?.engineResult].filter((c) => c && typeof c === 'object');
  for (const c of containers) {
    const rows = [
      ...(Array.isArray(c?.recurring?.services) ? c.recurring.services : []),
      ...(Array.isArray(c?.lineItems) ? c.lineItems : []),
    ];
    const row = rows.find((svc) => String(svc?.service || svc?.serviceKey || svc?.service_key || '').toLowerCase() === 'rodent_bait'
      && (svc.perApplicationBilled === true || Number(svc.stations) > 0 || svc.pricingBasis === 'RODENT_BAIT_BRACKET')
      && (typeof svc.tierQualifier === 'boolean' || typeof svc.countsTowardWaveGuardTier === 'boolean'
        || typeof svc.excludeFromPctDiscount === 'boolean' || typeof svc.waveGuardDiscountEligible === 'boolean'));
    if (row) {
      return {
        tierQualifier: row.tierQualifier !== false && row.countsTowardWaveGuardTier !== false,
        excludeFromPctDiscount: row.excludeFromPctDiscount === true || row.waveGuardDiscountEligible === false,
      };
    }
  }
  return null;
}

module.exports = { rodentBaitLegacyReplaySignal, rodentWaveguardPostureReplaySignal, RODENT_BAIT_REALIGNMENT_MIGRATION, rodentRealignmentRolloutMs };
