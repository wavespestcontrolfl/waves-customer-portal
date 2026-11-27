// Mix amounts for a protocol card. A card's `mixRates` rows (server/config/protocols.json) each hold ONE per-gallon rate;
// the amounts for each sprayer are that rate times the sprayer's gallons, so the three columns can never disagree.
// A row with `dose` and no `perGallon` is a direct placement (gel, dust, dunk) and has no tank amount.

export const SPRAYERS = [
  { key: "bg_1_gal", label: "B&G 1 gal", gallons: 1 },
  { key: "flowzone_4_gal", label: "FlowZone 4 gal", gallons: 4 },
  { key: "rig_100_gal", label: "Rig 100 gal", gallons: 100 },
];

const ML_PER_FL_OZ = 29.5735;

function trim(n) {
  if (!Number.isFinite(n)) return "";
  const digits = n >= 100 ? 0 : n >= 10 ? 1 : n >= 1 ? 2 : 3;
  return String(Number(n.toFixed(digits)));
}

// One unit for the whole amount, picked from its largest value, so a band never mixes units ("500 to 1,500 g").
function scale(largest, unit) {
  if (unit === "g" && largest >= 1000) return { divide: 1000, unit: "kg" };
  if (unit === "fl oz" && largest >= 128) return { divide: 128, unit: "gal" };
  return { divide: 1, unit };
}

// "0.625 fl oz (18.5 mL)": under 1 fl oz a tech measures in mL. The mL figure is the same amount to the nearest
// tenth of a mL, so it is neither above a maximum rate nor below a minimum one by more than 0.05 mL.
export function formatMixAmount(amount, unit, amountMax) {
  if (!(amount > 0) || !unit) return "";
  const hasBand = amountMax > amount;
  const shown = scale(hasBand ? amountMax : amount, unit);
  const text = hasBand
    ? `${trim(amount / shown.divide)} to ${trim(amountMax / shown.divide)} ${shown.unit}`
    : `${trim(amount / shown.divide)} ${shown.unit}`;
  if (unit === "fl oz" && !hasBand && amount < 1) return `${text} (${Number((amount * ML_PER_FL_OZ).toFixed(1))} mL)`;
  return text;
}

// `sprayers` defaults to the pest cards' three; a card with its own tanks (Tree & Shrub: its rig is 110 gal) passes them.
export function mixTable(mixRates, sprayers = SPRAYERS) {
  const rows = (Array.isArray(mixRates) ? mixRates : []).filter((row) => row && row.product);
  const used = new Set();
  const out = rows.map((row) => {
    const amount = Number(row.perGallon?.amount);
    const amountMax = Number(row.perGallon?.amountMax);
    const unit = row.perGallon?.unit;
    const rowSprayers = Array.isArray(row.sprayers) ? row.sprayers : [];
    const amounts = {};
    if (amount > 0 && unit) {
      for (const sprayer of sprayers) {
        if (!rowSprayers.includes(sprayer.key)) continue;
        used.add(sprayer.key);
        amounts[sprayer.key] = formatMixAmount(
          amount * sprayer.gallons,
          unit,
          amountMax > amount ? amountMax * sprayer.gallons : undefined,
        );
      }
    }
    return { ...row, amounts };
  });
  return { rows: out, columns: sprayers.filter((sprayer) => used.has(sprayer.key)) };
}
