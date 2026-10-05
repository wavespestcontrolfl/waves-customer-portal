// Pure composer for the weekly price-match request email to the SiteOne rep
// (Mark). Maps verified "a competitor beats our SiteOne price" opportunities
// into { subject, html, text }. Two hard rules, both unit-tested:
//
//   1. PROOF-OF-PRICE — an opportunity with no competitor source_url (the proof
//      link Mark clicks to verify) is NEVER included. No proof = no ask.
//   2. PER-UNIT pricing — every price is shown in the pack's OWN unit
//      (oz / lb / gal / g), never total-only, so it's apples-to-apples. Savings
//      are computed on the normalized $/oz-equivalent basis (robust even when the
//      two vendors list different pack units).
//   3. DELIVERED pricing — per-unit prices and savings use price + shipping (see
//      shipping-rules.js), and each line carries a short shipping note ("free
//      shipping", "incl. ~$15.00 est. shipping") so Mark sees what we'd really pay.
//      Free / published-rule shipping is stated as firm; an 'estimated' basis is flagged
//      "shipping estimated" so Mark is never quoted a guess as a fact.
//
// No I/O: the wiring layer gathers the week's opportunities and hands them in;
// the cron/send/recipient resolution lives elsewhere.

const { parsePackSize, convertToOz } = require('../product-costing');
const { wrapServiceEmail, ctaButton, colors } = require('../email-template');
const { shippingFor, shippingLabel, shippingProofText } = require('./shipping-rules');

const round = (n, p = 2) => Math.round(Number(n) * 10 ** p) / 10 ** p;
const fmtMoney = (n) => `$${round(n, 2).toFixed(2)}`;
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function hasProof(competitor) {
  const url = competitor && competitor.source_url;
  return typeof url === 'string' && /^https?:\/\/\S+/i.test(url.trim());
}

// Price in the pack's OWN unit: "78 oz" $95 -> $1.22/oz; "10 lb" $40 -> $4.00/lb;
// "2.5 gal" $300 -> $120/gal. Multipack totals roll up (4 x 78 oz -> per oz of
// 312 oz). Returns { value, unit } or null.
function perPackUnit(price, quantity) {
  const pack = parsePackSize(quantity);
  const p = Number(price);
  if (!pack || !(pack.amount > 0) || !Number.isFinite(p) || p <= 0) return null;
  return { value: p / pack.amount, unit: pack.unit };
}

// The shipping object for one side of a match: the persisted/forwarded one when present
// ({ amount, basis }), else the vendor rule looked up from the side's own host (competitor
// source_url) or name. The SiteOne baseline is free by rule. Never throws.
function shippingOfSide(side, fallbackVendorHost) {
  const sh = side && side.shipping;
  if (sh && Number.isFinite(Number(sh.amount)) && sh.basis) {
    return { amount: round(sh.amount, 2), basis: sh.basis, note: sh.note || '' };
  }
  return shippingFor({
    vendor: side || {},
    vendorHost: fallbackVendorHost,
    vendorName: side && typeof side.vendor === 'string' ? side.vendor : undefined,
    price: side && side.price,
    quantity: side && side.quantity,
    freeShipping: !!(side && (side.free_shipping === true || side.freeShipping === true)),
    hazmat: !!(side && (side.hazmat_shipping === true || side.hazmat === true)),
  });
}
const landedOf = (side, shipping) => {
  const p = Number(side && side.price);
  return Number.isFinite(p) ? round(p + shipping.amount, 2) : NaN;
};

// $/oz-equivalent — the normalized comparison basis for savings.
function perOzEquiv(price, quantity) {
  const pack = parsePackSize(quantity);
  const p = Number(price);
  if (!pack || !Number.isFinite(p) || p <= 0) return null;
  const oz = convertToOz(pack.amount, pack.unit);
  return oz > 0 ? p / oz : null;
}

// parsePackSize normalizes some units to internal keys (e.g. "fl oz" -> "fl_oz").
// Map them back to vendor-readable labels so the email never shows "$4.82/fl_oz".
const UNIT_LABELS = { fl_oz: 'fl oz' };
const unitLabel = (u) => UNIT_LABELS[u] || u;

function fmtPerUnit(pu) {
  if (!pu) return '—';
  const digits = pu.value >= 1 ? 2 : 4;
  return `$${pu.value.toFixed(digits)}/${unitLabel(pu.unit)}`;
}

// Savings % on the DELIVERED $/oz basis. ALWAYS derived from the persisted baseline /
// competitor prices (+ shipping) being displayed — not a supplied savingsPct that could be
// stale/inconsistent (supplied is only a fallback if a price won't parse). A negative
// result means the competitor is actually more expensive once shipping is counted.
function savingsPctOf(match) {
  const bShip = shippingOfSide(match.baseline, 'siteone.com');
  const cShip = shippingOfSide(match.competitor);
  const base = perOzEquiv(landedOf(match.baseline, bShip), match.baseline && match.baseline.quantity);
  const comp = perOzEquiv(landedOf(match.competitor, cShip), match.competitor && match.competitor.quantity);
  if (base && comp && base > 0) return (base - comp) / base;
  return Number.isFinite(match.savingsPct) ? match.savingsPct : null;
}

// One normalized line for an included match (pure data, used by html + text).
function lineFor(match) {
  const b = match.baseline || {};
  const c = match.competitor || {};
  const pct = savingsPctOf(match);
  const bShip = shippingOfSide(b, 'siteone.com');
  const cShip = shippingOfSide(c);
  const siteLanded = landedOf(b, bShip);
  const compLanded = landedOf(c, cShip);
  return {
    product: match.product || c.name || '(unnamed product)',
    epaReg: match.epaReg || null,
    sitePrice: Number(b.price),
    siteQty: b.quantity || null,
    sitePerUnit: perPackUnit(siteLanded, b.quantity), // delivered, per unit
    siteLanded,
    siteShipping: bShip,
    siteShippingNote: shippingLabel(bShip),
    compVendor: c.vendor || 'competitor',
    compPrice: Number(c.price),
    compQty: c.quantity || null,
    compPerUnit: perPackUnit(compLanded, c.quantity), // delivered, per unit
    compLanded,
    compShipping: cShip,
    shippingNote: shippingLabel(cShip),
    shippingBasis: cShip.basis,
    shippingFirm: cShip.basis !== 'estimated',
    shippingProof: shippingProofText(cShip),
    siteShippingProof: shippingProofText(bShip),
    listedName: c.name || null, // the product name exactly as the competitor lists it
    sourceUrl: c.source_url,
    savingsPct: pct,
  };
}

// matches: [{ product, epaReg?, baseline:{vendor,price,quantity},
//             competitor:{vendor,price,quantity,source_url,name?}, savingsPct? }]
// Returns { subject, html, text, includedCount, included, skipped:[{product,reason}] }
// — or null when nothing is left to ask about after the proof gate. `included` is
// the subset of input matches that actually made it into the email (proof-backed,
// priced, positive savings), in the same biggest-savings-first order — so a caller
// can persist a review snapshot that matches exactly what gets sent.
function composeMarkEmail(matches, opts = {}) {
  const repName = opts.repName || 'Mark';
  const minPct = Number.isFinite(opts.minSavingsPct) ? opts.minSavingsPct : 0; // require positive savings
  const skipped = [];
  const kept = []; // { line, match } for entries that pass EVERY gate
  for (const m of matches || []) {
    if (!m || !m.competitor || !hasProof(m.competitor)) {
      skipped.push({ product: (m && m.product) || null, reason: 'no_proof_url' });
      continue;
    }
    const line = lineFor(m);
    if (line.sitePerUnit == null || line.compPerUnit == null) {
      skipped.push({ product: line.product, reason: 'unpriced_per_unit' });
      continue;
    }
    // Only ask Mark to match a price that's actually cheaper. A competitor that's
    // higher (or not enough lower) than SiteOne has no business in the email.
    if (!(line.savingsPct > minPct)) {
      skipped.push({ product: line.product, reason: 'no_savings' });
      continue;
    }
    kept.push({ line, match: m });
  }
  if (!kept.length) return null;

  // Sort biggest savings first — lines (rendered) and included (snapshot) stay aligned.
  kept.sort((a, b) => (b.line.savingsPct || 0) - (a.line.savingsPct || 0));
  const lines = kept.map((k) => k.line);
  const included = kept.map((k) => k.match);
  const topPct = lines[0].savingsPct;
  const subject = `Price-match request: ${lines.length} item${lines.length === 1 ? '' : 's'}`
    + (Number.isFinite(topPct) ? ` (up to ${Math.round(topPct * 100)}% per unit)` : '');

  return {
    subject,
    html: renderHtml(lines, repName, opts),
    text: renderText(lines, repName, opts),
    includedCount: lines.length,
    included,
    skipped,
  };
}

function pctLabel(pct) {
  return Number.isFinite(pct) ? `${(pct * 100).toFixed(1)}% per unit` : '—';
}

// "Delivered $X (free shipping)" sub-line under a price cell.
function deliveredHtml(landed, note, C) {
  if (!Number.isFinite(landed)) return '';
  const tail = note ? ` (${esc(note)})` : '';
  return `<br><span style="color:${C.MUTED};font-size:12px;">Delivered ${fmtMoney(landed)}${tail}</span>`;
}

function renderHtml(lines, repName, opts) {
  const C = colors;
  const rows = lines.map((l) => {
    const epa = l.epaReg ? `<div style="color:${C.MUTED};font-size:12px;">EPA Reg. ${esc(l.epaReg)}</div>` : '';
    return `
      <tr>
        <td style="padding:10px 8px;border-bottom:1px solid ${C.RULE};vertical-align:top;">
          <strong style="color:${C.INK};">${esc(l.product)}</strong>${epa}
        </td>
        <td style="padding:10px 8px;border-bottom:1px solid ${C.RULE};vertical-align:top;white-space:nowrap;">
          ${fmtMoney(l.sitePrice)} / ${esc(l.siteQty)}<br>
          <strong>${esc(fmtPerUnit(l.sitePerUnit))}</strong>
          ${deliveredHtml(l.siteLanded, l.siteShippingProof || l.siteShippingNote, C)}
        </td>
        <td style="padding:10px 8px;border-bottom:1px solid ${C.RULE};vertical-align:top;white-space:nowrap;">
          ${esc(l.compVendor)}: ${fmtMoney(l.compPrice)} / ${esc(l.compQty)}${l.listedName ? `<br><span style="color:${C.MUTED};font-size:12px;">Listed as: ${esc(l.listedName)}</span>` : ''}<br>
          <strong style="color:${C.WAVES_BLUE};">${esc(fmtPerUnit(l.compPerUnit))}</strong>
          ${deliveredHtml(l.compLanded, l.shippingProof || l.shippingNote, C)}
        </td>
        <td style="padding:10px 8px;border-bottom:1px solid ${C.RULE};vertical-align:top;">${esc(pctLabel(l.savingsPct))}</td>
        <td style="padding:10px 8px;border-bottom:1px solid ${C.RULE};vertical-align:top;">
          <a href="${esc(l.sourceUrl)}" style="color:${C.WAVES_BLUE};">View listing</a>
        </td>
      </tr>`;
  }).join('');

  const body = `
    <p>Hi ${esc(repName)},</p>
    <p>We found lower published prices on the products below and would like to keep them on our SiteOne account. Each row shows <strong>your current delivered price per unit</strong> next to the competitor's (price plus shipping), with a link to the live listing as proof. Can you match these?</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;font-size:14px;color:${C.BODY};">
      <tr>
        <th align="left" style="padding:8px;border-bottom:2px solid ${C.RULE};">Product</th>
        <th align="left" style="padding:8px;border-bottom:2px solid ${C.RULE};">SiteOne (current)</th>
        <th align="left" style="padding:8px;border-bottom:2px solid ${C.RULE};">Competitor</th>
        <th align="left" style="padding:8px;border-bottom:2px solid ${C.RULE};">Savings</th>
        <th align="left" style="padding:8px;border-bottom:2px solid ${C.RULE};">Proof</th>
      </tr>
      ${rows}
    </table>
    ${lines.some((l) => !l.shippingFirm) ? `<p style="font-size:12px;color:${C.MUTED};">${esc(ESTIMATE_NOTE)}</p>` : ''}
    <p style="margin-top:18px;">Thanks,<br>Waves Pest Control</p>`;

  return wrapServiceEmail({
    preheader: `${lines.length} price-match request${lines.length === 1 ? '' : 's'} with proof links`,
    body,
    footerNote: 'Sent by Waves procurement.',
  });
}

// "; delivered $48.55" — appended to a text line.
function deliveredText(landed, note) {
  if (!Number.isFinite(landed)) return '';
  return `; delivered ${fmtMoney(landed)}${note ? ` (${note})` : ''}`;
}

const ESTIMATE_NOTE = 'Lines marked "shipping estimated" use our own estimate of the freight, not a quote from the vendor; every other shipping figure is free or the vendor\'s published rate.';

function renderText(lines, repName, opts) {
  const rows = lines.map((l) => [
    `• ${l.product}${l.epaReg ? ` (EPA Reg. ${l.epaReg})` : ''}`,
    `    SiteOne (current): ${fmtMoney(l.sitePrice)} / ${l.siteQty}${l.siteShippingProof ? `; ${l.siteShippingProof}` : ''}${deliveredText(l.siteLanded, '')} = ${fmtPerUnit(l.sitePerUnit)}`,
    `    ${l.compVendor}${l.listedName ? ` (listed as: ${l.listedName})` : ''}: ${fmtMoney(l.compPrice)} / ${l.compQty}${l.shippingProof ? `; ${l.shippingProof}` : ''}${deliveredText(l.compLanded, '')} = ${fmtPerUnit(l.compPerUnit)}  (${pctLabel(l.savingsPct)})`,
    `    Proof: ${l.sourceUrl}`,
  ].join('\n')).join('\n\n');
  return [
    `Hi ${repName},`,
    '',
    'We found lower published prices on the products below and would like to keep them on our SiteOne account. '
      + "Each line shows your current delivered price per unit next to the competitor's (price plus shipping), with a proof link. Can you match these?",
    '',
    rows,
    ...(lines.some((l) => !l.shippingFirm) ? ['', ESTIMATE_NOTE] : []),
    '',
    'Thanks,',
    'Waves Pest Control',
  ].join('\n');
}

module.exports = {
  composeMarkEmail,
  perPackUnit,
  perOzEquiv,
  hasProof,
  // exported for tests
  lineFor,
  savingsPctOf,
  shippingOfSide,
};
