// client/src/lib/lawn-mix-help.js
//
// Mix help of the lawn Fast Complete sheet (GATE_LAWN_MIX_HELP, owner 2026-10-09). The server does ALL the arithmetic of a tank
// amount (services/lawn-mix-help.js) and sends it as words per product and tank size; this file reads that block, remembers the tank
// size on the technician's device, and keeps the gallons -> area PREVIEW (the sheet figures the amount from the area, as for a typed
// area) identical to the server's conversion, which /complete redoes with the product's staged carrier and records.
//
// With no `mixHelp` in the context (the gate is off, or an older server) every function here answers "nothing" and the sheet renders
// and submits exactly as before.

const lowerId = (value) => String(value ?? '').toLowerCase();
const positive = (value) => (Number(value) > 0 ? Number(value) : null);

/** The context's mixHelp block, normalized, or null (no mix help). */
export function mixHelpOf(data) {
  const block = data?.plannedProducts?.mixHelp;
  if (!block || block.v !== 1 || !block.rows || typeof block.rows !== 'object' || Array.isArray(block.rows)) return null;
  const tanks = (Array.isArray(block.tanks) ? block.tanks : []).map(Number).filter((tank) => tank > 0);
  if (!tanks.length) return null;
  const rows = Object.fromEntries(Object.entries(block.rows).map(([id, entry]) => [lowerId(id), entry]));
  return { tanks, rows, weedOrder: Array.isArray(block.weedOrder) ? block.weedOrder.map(lowerId) : null };
}

/** One product's entry, or null. */
export const mixEntryFor = (help, productId) => help?.rows?.[lowerId(productId)] || null;

// ── the tank size, remembered per technician on this device ────────────────────────────────────────────────────────

const tankKey = (operatorId) => `waves.lawnMixTank.${operatorId || 'device'}`;

/** The remembered tank size when it is one the server offers, else the largest offered (the backpack's own tank). */
export function rememberedTank(operatorId, tanks) {
  let stored = null;
  try { stored = Number(window.localStorage.getItem(tankKey(operatorId))); } catch { stored = null; }
  return tanks.includes(stored) ? stored : Math.max(...tanks);
}

export function rememberTank(operatorId, tank) {
  try { window.localStorage.setItem(tankKey(operatorId), String(tank)); } catch { /* storage unavailable: the choice lasts until the sheet closes */ }
}

// ── the lines ───────────────────────────────────────────────────────────────

/**
 * The line a product shows for the chosen tank: `{ text, covers }` for a full-tank amount, `{ text }` for the per-1,000 dose of a row
 * with no carrier on file (the entry's own note says so), or null when the entry has neither.
 */
export function mixLine(entry, tank) {
  const dose = entry?.perTank?.[String(tank)];
  if (dose?.text) return { text: `${tank} gal tank: ${dose.text}`, covers: dose.coversSqft > 0 ? `Covers about ${Number(dose.coversSqft).toLocaleString('en-US')} sq ft.` : null };
  if (entry?.per1000) return { text: `Per 1,000 sq ft: ${entry.per1000}`, covers: null };
  return null;
}

/**
 * The weed card's lines: one per weed row on the sheet (name and its amount for the tank), the mixing order when the catalog states one
 * for EVERY product on the card, and the label lines the entries carry. `rows` are the weed-mix rows on the sheet.
 */
export function weedMixLines(help, rows, tank) {
  const listed = rows.map((row) => ({ row, entry: mixEntryFor(help, row.productId) })).filter(({ entry }) => entry);
  const order = Array.isArray(help?.weedOrder) ? help.weedOrder : null;
  const ordered = !!order && listed.length > 1 && listed.length === rows.length && listed.every(({ row }) => order.includes(lowerId(row.productId)));
  const sorted = ordered ? [...listed].sort((a, b) => order.indexOf(lowerId(a.row.productId)) - order.indexOf(lowerId(b.row.productId))) : listed;
  return {
    lines: sorted.map(({ row, entry }) => ({ id: row.productId, name: row.name, line: mixLine(entry, tank), note: entry.perTank ? null : entry.note })),
    order: ordered ? sorted.map(({ row }) => row.name) : null,
    labelLines: listed.flatMap(({ entry }) => (Array.isArray(entry.labelLines) ? entry.labelLines : [])),
  };
}

// ── gallons sprayed ─────────────────────────────────────────────────────────

/** The area (whole sq ft, at least 1) a number of gallons covers at a carrier volume: the server's areaFromGallons, character for character. */
export function gallonsToArea(gallons, carrier) {
  const gal = positive(gallons);
  const per = positive(carrier);
  return gal && per ? Math.max(1, Math.round((gal * 1000) / per)) : null;
}

/**
 * A spot row's recorded area from the gallons the tech entered (a preview of what /complete records): a plain spot row from its own
 * gallons, a weed-mix row from the entry's shared `weedGallons`. A row with no carrier on file is left alone. The surfactant (a share
 * of the tank, no area) is never given one.
 */
export function withGallonsArea(row, { help, weedGallons }) {
  if (!row.spotRule || row.spotExempt) return row;
  const gallons = positive(row.weedGroup ? weedGallons : row.spotGallons);
  const area = gallons ? gallonsToArea(gallons, mixEntryFor(help, row.productId)?.carrierGalPer1000) : null;
  return area ? { ...row, spotArea: area, areaFromGallons: gallons } : row;
}

/** The /complete row's gallons field: only a row whose area came from gallons carries it. */
export const gallonsBodyFields = (row) => (row.areaFromGallons > 0 ? { sprayedGallons: row.areaFromGallons } : {});

/** Whether the gallons entry is offered for a row or the weed entry: a carrier volume is on file for it. */
export const carrierOf = (help, productId) => positive(mixEntryFor(help, productId)?.carrierGalPer1000);

/** The weed entry's carrier: the one volume every sized weed row shares, else null (no gallons entry on the card). */
export function weedCarrier(help, rows) {
  const carriers = new Set(rows.filter((row) => !row.spotExempt).map((row) => carrierOf(help, row.productId)));
  return carriers.size === 1 && !carriers.has(null) ? [...carriers][0] : null;
}
