// A lawn sheet opened with no sprayer picked while the big tanks are on different numbers (owner 2026-11-27: tank #1 at 2.0,
// tank #2 at 4.0) has no single coverage or full-tank mix: the server sends each tank's (equipment.tankOptions and each item's
// tankAmounts.tankOptions). These give the named text; with one rig, [fallback] (the single figure), or [] with no fallback.
const fmt = (value) => Number(value).toLocaleString("en-US", { maximumFractionDigits: 3 });
const unit = (value) => String(value || "").replace(/_/g, " ");

const orFallback = (lines, fallback) => (lines.length || fallback == null ? lines : [fallback]);

export function tankCoverageLines(equipment, fallback) {
  return orFallback((equipment?.tankOptions || []).filter((tank) => Number(tank?.tankCoverageSqft) > 0)
    .map((tank) => `${tank.systemName}: ${fmt(tank.carrierGalPer1000)} gal per 1,000 sq ft, ${fmt(tank.tankCoverageSqft)} sq ft per tank`), fallback);
}

// An item with its own full-tank mix (one rig) keeps it: [fallback]. Only an item the plan lets mix (an area mix: never a capped,
// held or apply-alone product) gets the tanks' fills.
export function tankFillLines(item, fallback) {
  const mixes = Boolean(item?.jobMix || item?.plannedMix) && !(item?.fullTankMix || item?.plannedFullTankMix);
  const tanks = mixes ? item?.tankAmounts?.tankOptions || [] : [];
  return orFallback(tanks.filter((tank) => tank.fullTank)
    .map(({ sprayerName, fullTank }) => `${fmt(fullTank.amount)}${fullTank.amountMax ? `-${fmt(fullTank.amountMax)}` : ""} ${unit(fullTank.amountUnit)} per ${fmt(fullTank.gallons)} gal · ${sprayerName}`), fallback);
}
