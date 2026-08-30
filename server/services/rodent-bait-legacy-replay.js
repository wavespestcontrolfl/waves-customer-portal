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

// The realignment cutoff (owner directive 2026-08-29; migration
// 20260829000040). A DIRECT rodent bait series (no source estimate — admin
// booking, call booking, /secure) created on/after this date can only have
// been priced by the bracket ladder, so its ROOT row's created_at is the
// durable new-model signal for rows that carry no estimate provenance
// (codex #3591 r36 P1). Pre-cutoff roots keep their snapshotted rate.
const RODENT_BAIT_REALIGNMENT_DATE = '2026-08-29';

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

module.exports = { rodentBaitLegacyReplaySignal, RODENT_BAIT_REALIGNMENT_DATE };
