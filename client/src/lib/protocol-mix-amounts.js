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

function one(amount, unit) {
  if (unit === "g" && amount >= 1000) return `${trim(amount / 1000)} kg`;
  if (unit === "fl oz" && amount >= 128) return `${trim(amount / 128)} gal`;
  return `${trim(amount)} ${unit}`;
}

// "0.625 fl oz (18 mL)": under 1 fl oz a tech measures in mL.
export function formatMixAmount(amount, unit, amountMax) {
  if (!(amount > 0) || !unit) return "";
  const hasBand = amountMax > amount;
  const text = hasBand ? `${trim(amount)} to ${one(amountMax, unit)}` : one(amount, unit);
  if (unit === "fl oz" && !hasBand && amount < 1) return `${text} (${Math.round(amount * ML_PER_FL_OZ)} mL)`;
  return text;
}

export function mixTable(mixRates) {
  const rows = (Array.isArray(mixRates) ? mixRates : []).filter((row) => row && row.product);
  const used = new Set();
  const out = rows.map((row) => {
    const amount = Number(row.perGallon?.amount);
    const amountMax = Number(row.perGallon?.amountMax);
    const unit = row.perGallon?.unit;
    const sprayers = Array.isArray(row.sprayers) ? row.sprayers : [];
    const amounts = {};
    if (amount > 0 && unit) {
      for (const sprayer of SPRAYERS) {
        if (!sprayers.includes(sprayer.key)) continue;
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
  return { rows: out, columns: SPRAYERS.filter((sprayer) => used.has(sprayer.key)) };
}
