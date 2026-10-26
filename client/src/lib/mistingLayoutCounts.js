// Misting layout counts as text (GATE_MISTING_LAYOUT_DESIGNER, step 3). No imports, so the customer estimate
// document can use it without pulling in the map engine.

/**
 * The legend lines printed on the sketch and shown under it. `flaggedCount` is the nozzles inside a
 * no-mist zone; its row appears only when there are some (the saved server counts carry no such count,
 * so the estimate PDF's counts line leaves it out).
 */
export function legendRows({ nozzleCount, eaveCount, fenceCount, riserCount, hasPump, zoneCount, linearFt, flaggedCount = 0 }) {
  const rows = [
    `Nozzles: ${nozzleCount} (eave ${eaveCount}, fence ${fenceCount})`,
    `Risers: ${riserCount}`,
    `Pump: ${hasPump ? 'placed' : 'not placed'}`,
    `No-mist zones: ${zoneCount}`,
    `Line: ${Math.round(linearFt)} ft`,
  ];
  if (flaggedCount > 0) rows.push(`In a no-mist zone: ${flaggedCount} (aim away or move)`);
  return rows;
}

/** One line from the server's saved counts (the /data `mistingLayout.counts` shape). */
export function mistingLayoutCountsLine(counts) {
  const c = counts || {};
  return legendRows({
    nozzleCount: c.nozzles || 0,
    eaveCount: c.eave || 0,
    fenceCount: c.fence || 0,
    riserCount: c.risers || 0,
    hasPump: Boolean(c.pump),
    zoneCount: c.zones || 0,
    linearFt: c.linearFt || 0,
  }).join(' · ');
}
