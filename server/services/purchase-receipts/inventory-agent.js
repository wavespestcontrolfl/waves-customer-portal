/**
 * purchase-receipts/inventory-agent.js — resolves a purchase_receipt_lines
 * row the deterministic classifier could not (status 'agent_pending', see
 * receipt-processor.js's hand-off under GATE_INVENTORY_AGENT) with one
 * bounded LLM call per line, then checks EVERY number the model proposes
 * against the purchased title in plain code before writing anything.
 *
 * The model never supplies a quantity directly. It proposes a `kind`
 * (not_stock / equipment / existing / new_product / unsure) and, for
 * existing/new_product, a `reading` of the title's own size/pack wording.
 * validateReading() re-parses that reading's size_text against the SAME
 * title-size regex receipt-processor.js uses (TITLE_SIZE_RE/SIZE_UNITS,
 * imported, never duplicated) — extended here with the count-item nouns
 * (traps, stations, cartridges, …) receipt-processor.js has no reason to
 * know about — and requires it to reproduce the model's own size_number /
 * size_unit exactly. Anything that doesn't check out is 'agent_unsure': a
 * bell for a person, never a guessed amount.
 *
 * The LLM call runs OUTSIDE any DB transaction (dispatchWithFallback, the
 * highStakes chain, bounded by LLM_TIMEOUT_MS) so a slow provider never
 * holds a row lock. Validation is pure (no I/O). Only the final apply — one
 * transaction per line, mirroring processReceiptLine's own discipline — and
 * the attempt-count bookkeeping touch the database.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { gateEnvValue } = require('../../config/feature-gates');
const MODELS = require('../../config/models');
const { dispatchWithFallback } = require('../llm/call');
const { normalizeForMatch, containsWholeWords } = require('./product-matcher');
const { parsePackSize, parsePackCount } = require('../product-costing');
const { convertInventoryQuantity, normalizeInventoryUnit, unitDefinition } = require('../inventory-units');
const inventoryOperations = require('../inventory-operations');
const {
  classifyItem, findPossibleDuplicateMovement, lockShipment, SOURCES,
  TITLE_SIZE_RE, sizeUnit, parseSizeNumber, sizesAgree, round4,
} = require('./receipt-processor');

const GATE = 'GATE_INVENTORY_AGENT';
const BATCH_LIMIT = 10;
const MAX_ATTEMPTS = 3;
const CANDIDATE_LIMIT = 15;
const LLM_TIMEOUT_MS = 20000;
const INVENTORY_LINK = '/admin/inventory?tab=products';
const VENDOR_LABEL = { amazon: 'Amazon delivery', siteone: 'SiteOne invoice' };
const VENDOR_BEST = { amazon: 'Amazon', siteone: 'SiteOne' };

// Count-item nouns receipt-processor's own SIZE_UNITS has no reason to know
// (it only reads measured sizes): a title reading like "12 Count" or "1
// Station" normalizes to inventory unit 'each' (inventory-units.js already
// supports it as the count dimension).
const COUNT_UNIT_WORD_RE = /^(?:count|ct|each|ea|pcs|pieces|traps?|stations?|cartridges?|tablets?|dunks?|briquets?|briquettes?)$/i;

const EPA_REG_RE = /\bEPA\s*(?:Reg(?:istration)?\.?)?\s*(?:No\.?|#)?\s*[:#-]?\s*(\d{1,6}-\d{1,6}(?:-\d{1,6})?)\b/i;

function displayUnit(unit) {
  return String(unit || '').replace(/_/g, ' ');
}

function normalizeWhitespace(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Case/whitespace-insensitive substring check — the same tolerance every
// "must be a substring of the title" rule in the design uses.
function containsCI(haystack, needle) {
  const n = normalizeWhitespace(needle);
  return Boolean(n) && normalizeWhitespace(haystack).includes(n);
}

// A number that literally appears in `title`, deterministically — never
// trusting the model's own transcription of it.
function extractEpaRegNumber(title) {
  const match = String(title || '').match(EPA_REG_RE);
  return match ? match[1] : null;
}

// The title-size regex's unit word(s) resolved to an inventory-units token,
// extending sizeUnit (measured units) with the count-item nouns above.
function canonicalUnit(first, second) {
  const measured = (second && sizeUnit(`${first} ${second}`)) || sizeUnit(first);
  if (measured) return measured;
  return COUNT_UNIT_WORD_RE.test(String(first || '').trim()) ? 'each' : null;
}

// Every "<number> <unit>" claim inside `text` that resolves to a known unit
// (measured or count), reusing the exact TITLE_SIZE_RE/parseSizeNumber
// primitives receipt-processor.js parses full titles with.
function parsedSizeClaims(text) {
  const claims = [];
  for (const [, number, first, second] of String(text || '').matchAll(TITLE_SIZE_RE)) {
    const unit = canonicalUnit(first, second);
    if (!unit) continue;
    const value = parseSizeNumber(number);
    if (Number.isFinite(value) && value > 0) claims.push({ value, unit });
  }
  return claims;
}

function formatSizeNumber(n) {
  const rounded = Math.round(n * 1000) / 1000;
  return String(rounded);
}

// "78 fl oz", "12 each" — the canonical text a validated reading is stored
// or displayed as.
function canonicalSizeText(number, unit) {
  return `${formatSizeNumber(number)} ${displayUnit(unit)}`;
}

/**
 * Deterministically checks one proposed `reading` against the purchased
 * title and the purchase line's own ordered quantity. Returns
 * { ok: true, sizeNumber, unit, packCount, amount } (amount = lineQuantity
 * x packCount x sizeNumber, in `unit`) or { ok: false, reason }. Never
 * trusts size_number/size_unit/pack_count directly — every one is
 * re-derived from a substring of the title.
 */
function validateReading(reading, { rawTitle, lineQuantity }) {
  if (!reading || typeof reading !== 'object') return { ok: false, reason: 'no_reading' };
  const sizeText = String(reading.size_text || '');
  if (!sizeText || !containsCI(rawTitle, sizeText)) return { ok: false, reason: 'size_text_not_in_title' };

  const claims = parsedSizeClaims(sizeText);
  if (claims.length !== 1) return { ok: false, reason: 'size_text_unparseable' };
  const [claim] = claims;

  const claimedUnit = normalizeInventoryUnit(reading.size_unit);
  if (!claimedUnit || !unitDefinition(claimedUnit) || claimedUnit !== claim.unit) {
    return { ok: false, reason: 'size_unit_mismatch' };
  }
  const claimedNumber = Number(reading.size_number);
  if (!Number.isFinite(claimedNumber) || claimedNumber <= 0 || !sizesAgree(claim.value, claimedNumber)) {
    return { ok: false, reason: 'size_number_mismatch' };
  }

  const packCount = Number(reading.pack_count);
  if (!Number.isInteger(packCount) || packCount < 1 || packCount > 100) return { ok: false, reason: 'pack_count_range' };
  if (packCount > 1) {
    const packText = String(reading.pack_text || '');
    if (!packText || !containsCI(rawTitle, packText) || !packText.includes(String(packCount))) {
      return { ok: false, reason: 'pack_text_invalid' };
    }
  }

  const lineQty = Number(lineQuantity);
  if (!Number.isFinite(lineQty) || lineQty <= 0) return { ok: false, reason: 'bad_line_quantity' };

  return { ok: true, sizeNumber: claim.value, unit: claim.unit, packCount, amount: round4(lineQty * packCount * claim.value) };
}

// The same two-branch agreement receipt-processor's amountPerItem() checks
// title size against a catalog container with (sizesAgree is the shared
// tolerance primitive) — generalized here to run on either a measured
// amount (against container.amount) or a count (against a count
// container's N), since the arithmetic is identical either way.
function containerAgreement(sizeAmount, packCount, containerAmount) {
  if (sizesAgree(sizeAmount, containerAmount)) return packCount * containerAmount;
  if (sizesAgree(sizeAmount * packCount, containerAmount)) return containerAmount;
  return null;
}

function inventoryUnitForNewProduct(unit) {
  if (unit === 'each') return 'each';
  const def = unitDefinition(unit);
  if (!def) return null;
  // Liquids -> fl_oz (the volume base unit throughout inventory-units.js);
  // weights (and plain ambiguous "oz") keep the size's own unit, since
  // there is no single weight base and the catalog already carries
  // products in g, lb and kg side by side.
  return def.dimension === 'volume' ? 'fl_oz' : unit;
}

// A validated 'existing' decision, or 'agent_unsure' with why.
function validateExisting(raw, ctx) {
  const { candidates, rawTitle, lineQuantity } = ctx;
  const candidate = candidates.find((c) => c.id === raw.product_id);
  if (!candidate) return { kind: 'unsure', status: 'agent_unsure', reason: 'proposed product is not one of the candidates offered' };

  const reading = validateReading(raw.reading, { rawTitle, lineQuantity });
  if (!reading.ok) return { kind: 'unsure', status: 'agent_unsure', reason: `reading did not check out (${reading.reason})` };

  const container = parsePackSize(candidate.container_size);
  const countContainer = !container ? parsePackCount(candidate.container_size) : null;

  if (container) {
    if (reading.unit === 'each') return { kind: 'unsure', status: 'agent_unsure', reason: 'the title reads a count; the catalog container is a measured size' };
    const sizeInContainerUnit = convertInventoryQuantity(reading.sizeNumber, reading.unit, container.unit);
    if (sizeInContainerUnit == null) return { kind: 'unsure', status: 'agent_unsure', reason: 'the title size does not convert to the container unit' };
    const perItem = containerAgreement(sizeInContainerUnit, reading.packCount, container.amount);
    if (perItem == null) return { kind: 'unsure', status: 'agent_unsure', reason: "the title size disagrees with the catalog's container size" };
    const amount = round4(lineQuantity * perItem);
    const target = candidate.inventory_unit || container.unit;
    if (convertInventoryQuantity(amount, container.unit, target) == null) {
      return { kind: 'unsure', status: 'agent_unsure', reason: 'the amount does not convert to the product inventory unit' };
    }
    return { kind: 'existing', status: 'logged', product: candidate, amount, unit: container.unit, setContainerSize: null, reading: raw.reading };
  }

  if (countContainer) {
    if (reading.unit !== 'each') return { kind: 'unsure', status: 'agent_unsure', reason: 'the catalog container is a count; the title reads a measured size' };
    if (candidate.inventory_unit && normalizeInventoryUnit(candidate.inventory_unit) !== 'each') {
      return { kind: 'unsure', status: 'agent_unsure', reason: 'a count product must track in each' };
    }
    const perItem = containerAgreement(reading.sizeNumber, reading.packCount, countContainer.count);
    if (perItem == null) return { kind: 'unsure', status: 'agent_unsure', reason: "the title count disagrees with the catalog's container count" };
    return { kind: 'existing', status: 'logged', product: candidate, amount: round4(lineQuantity * perItem), unit: 'each', setContainerSize: null, reading: raw.reading };
  }

  // No readable container_size at all (never overwrite one that IS
  // readable, measured or count — only this branch may set one).
  if (reading.packCount !== 1) {
    return { kind: 'unsure', status: 'agent_unsure', reason: 'no catalog container size to check a multi-pack title against' };
  }
  const amount = round4(lineQuantity * reading.sizeNumber);
  return {
    kind: 'existing', status: 'logged', product: candidate, amount, unit: reading.unit,
    setContainerSize: canonicalSizeText(reading.sizeNumber, reading.unit), reading: raw.reading,
  };
}

// A validated 'new_product' decision, or 'agent_unsure' with why.
function validateNewProduct(raw, ctx) {
  const { rawTitle, lineQuantity, allActiveProducts, allowedCategories } = ctx;
  const proposed = raw.new_product;
  if (!proposed || !proposed.name || typeof proposed.name !== 'string' || !proposed.name.trim()) {
    return { kind: 'unsure', status: 'agent_unsure', reason: 'no product name proposed' };
  }
  const name = proposed.name.trim();
  const normName = normalizeForMatch(name);
  const normTitle = normalizeForMatch(rawTitle);
  const collides = allActiveProducts.some((p) => {
    const n = normalizeForMatch(p.name);
    return n === normName || n.includes(normName) || normName.includes(n) || containsWholeWords(normTitle, n);
  });
  if (collides) return { kind: 'unsure', status: 'agent_unsure', reason: `looks like an existing product ("${name}")` };

  const category = String(proposed.category || '').trim().toLowerCase();
  if (!category || !allowedCategories.has(category)) return { kind: 'unsure', status: 'agent_unsure', reason: 'proposed category is not in the catalog\'s allowed set' };

  const reading = validateReading(raw.reading, { rawTitle, lineQuantity });
  if (!reading.ok) return { kind: 'unsure', status: 'agent_unsure', reason: `reading did not check out (${reading.reason})` };

  const inventoryUnit = inventoryUnitForNewProduct(reading.unit);
  if (!inventoryUnit) return { kind: 'unsure', status: 'agent_unsure', reason: 'no inventory unit for the read size' };
  if (convertInventoryQuantity(reading.amount, reading.unit, inventoryUnit) == null) {
    return { kind: 'unsure', status: 'agent_unsure', reason: 'the amount does not convert to the derived inventory unit' };
  }

  const activeIngredient = typeof proposed.active_ingredient === 'string' && proposed.active_ingredient.trim() ? proposed.active_ingredient.trim() : null;
  const titleEpa = extractEpaRegNumber(rawTitle); // deterministic — never the model's own transcription
  return {
    kind: 'new_product', status: 'logged', amount: reading.amount, unit: reading.unit, reading: raw.reading,
    newProduct: {
      name, category, containerSize: canonicalSizeText(reading.sizeNumber, reading.unit), inventoryUnit,
      activeIngredient, epaRegNumber: titleEpa,
    },
  };
}

// Pure classification of the model's proposal — no I/O, no DB, no side
// effects. Every 'existing'/'new_product' path either fully validates or
// falls back to 'unsure'; nothing in between.
function classifyDecision(raw, ctx) {
  const kind = raw && raw.kind;
  if (kind === 'not_stock') return { kind, status: 'agent_ignored', reason: (raw.reason || 'Not a stock item.').slice(0, 500) };
  if (kind === 'equipment') return { kind, status: 'agent_equipment', reason: (raw.reason || 'Looks like equipment, not stock.').slice(0, 500) };
  if (kind === 'existing') return validateExisting(raw, ctx);
  if (kind === 'new_product') return validateNewProduct(raw, ctx);
  return { kind: 'unsure', status: 'agent_unsure', reason: (raw && raw.reason ? raw.reason : 'The agent was not sure.').slice(0, 500) };
}

// ---- catalog reads used to build a line's LLM context --------------------

function titleTokens(text) {
  return normalizeForMatch(text).split(' ').filter((word) => word.length > 2);
}

// Up to `limit` active catalog products ranked by name-token overlap with
// the title, with `mustInclude` (the deterministic matcher's own match, for
// a needs_size/size_mismatch line) always present and first.
async function candidateProducts(conn, rawTitle, mustInclude, limit = CANDIDATE_LIMIT) {
  const tokens = new Set(titleTokens(rawTitle));
  const products = await conn('products_catalog').where({ active: true }).select('id', 'name', 'category', 'container_size', 'inventory_unit');
  const scored = products
    .filter((p) => !mustInclude || p.id !== mustInclude.id)
    .map((product) => ({ product, score: titleTokens(product.name).filter((t) => tokens.has(t)).length }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.product);
  const rest = mustInclude ? [mustInclude, ...scored] : scored;
  return rest.slice(0, limit);
}

async function candidateAliases(conn, productIds) {
  if (!productIds.length) return {};
  const rows = await conn('product_aliases').whereIn('product_id', productIds).select('product_id', 'alias_name');
  const byProduct = {};
  for (const row of rows) {
    (byProduct[row.product_id] ||= []).push(row.alias_name);
  }
  return byProduct;
}

// A canonical lowercase set of the catalog's own categories — messy
// spellings ('Insecticide' vs 'insecticide') collapse to one entry each.
async function loadAllowedCategories(conn) {
  const rows = await conn('products_catalog').whereNotNull('category').distinct('category');
  return new Set(rows.map((row) => String(row.category).trim().toLowerCase()).filter(Boolean));
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// SiteOne's own extraction for THIS line only (unit price / line total /
// uom) — a minimal, read-only re-read of the same email_attachments row
// siteone-invoices.js reads for the whole invoice, keyed by this line's own
// line_no (both copies of an invoice key the same line the same way).
async function siteOneLineFields(conn, line) {
  if (!line.email_id) return null;
  const attachment = await conn('email_attachments').where({ email_id: line.email_id, is_invoice: true })
    .whereNotNull('extracted_data').first('extracted_data');
  const data = attachment?.extracted_data;
  const parsed = typeof data === 'string' ? safeParseJson(data) : data;
  const item = Array.isArray(parsed?.line_items) ? parsed.line_items[line.line_no - 1] : null;
  if (!item) return null;
  return { unitPrice: item.unit_price ?? null, total: item.total ?? null, uom: item.uom || null };
}

// ---- the LLM call ---------------------------------------------------------

const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // OpenAI strict mode requires EVERY property key in `required`.
  required: ['kind', 'reason', 'product_id', 'new_product', 'reading'],
  properties: {
    kind: { type: 'string', enum: ['not_stock', 'equipment', 'existing', 'new_product', 'unsure'] },
    reason: { type: 'string', minLength: 1, maxLength: 240 },
    product_id: { type: ['string', 'null'] },
    new_product: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['name', 'category', 'active_ingredient', 'epa_reg_no'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 150 },
        category: { type: 'string', minLength: 1, maxLength: 60 },
        active_ingredient: { type: ['string', 'null'], maxLength: 150 },
        epa_reg_no: { type: ['string', 'null'], maxLength: 40 },
      },
    },
    reading: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['size_text', 'size_number', 'size_unit', 'pack_text', 'pack_count'],
      properties: {
        size_text: { type: 'string', minLength: 1, maxLength: 80 },
        size_number: { type: 'number' },
        size_unit: { type: 'string', minLength: 1, maxLength: 20 },
        pack_text: { type: ['string', 'null'], maxLength: 80 },
        pack_count: { type: 'integer' },
      },
    },
  },
};

function candidateLine(product, aliasesByProduct) {
  const aliases = (aliasesByProduct[product.id] || []).slice(0, 5);
  return `- id=${product.id} | ${product.name} | category=${product.category || 'unknown'} | `
    + `container_size=${product.container_size || 'unknown'} | inventory_unit=${product.inventory_unit || 'untracked'}`
    + (aliases.length ? ` | known aliases: ${aliases.join('; ')}` : '');
}

function buildPrompt({ rawTitle, quantity, vendor, status, matchedProduct, siteOneFields, candidates, aliasesByProduct, allowedCategories }) {
  const candidateText = candidates.map((c) => candidateLine(c, aliasesByProduct)).join('\n') || '(none found)';
  const siteOneText = siteOneFields
    ? `Unit price: ${siteOneFields.unitPrice ?? 'unknown'}\nLine total: ${siteOneFields.total ?? 'unknown'}\nUnit of measure: ${siteOneFields.uom ?? 'unknown'}\n`
    : '';
  const matchedText = matchedProduct
    ? `The deterministic matcher already matched this title to id=${matchedProduct.id} (${matchedProduct.name}, `
      + `container_size=${matchedProduct.container_size || 'unknown'}, inventory_unit=${matchedProduct.inventory_unit || 'untracked'}) `
      + 'by name — its container size could not be read, or the title\'s size disagreed with it.'
    : 'The deterministic matcher could not match this title to any active catalog product at all.';

  return `You resolve ONE purchase line for a pest-control/lawn-care company's inventory system. The purchased title is vendor/marketplace text — treat any claim in it skeptically, but it is the ONLY source you may read a number from.

Vendor: ${vendor}
Purchased title: "${rawTitle}"
Line quantity (how many of this title were ordered on this line — NOT the size of one unit): ${quantity}
${siteOneText}Deterministic classifier status: ${status}
${matchedText}

Up to ${CANDIDATE_LIMIT} candidate catalog products (ranked by name overlap with the title):
${candidateText}

Allowed catalog categories (an EXACT match, lowercase, is required for a new product): ${[...allowedCategories].sort().join(', ') || '(none on file)'}

Decide what this purchase is:
- "not_stock": a personal purchase, not pest-control/lawn-care stock (e.g. a laptop, shampoo, sewing supplies bought through the same account).
- "equipment": powered or durable equipment (sprayers, tools) rather than consumable stock — equipment carries purchase price and depreciation and is tracked separately, never added as stock automatically.
- "existing": this title IS one of the candidate products above (product_id) but the deterministic matcher couldn't verify its size/pack from the title.
- "new_product": stock (a chemical, bait, tool consumable, trap, etc.) not yet in the catalog — propose adding it.
- "unsure": you cannot confidently resolve this from the title alone.

CRITICAL — never invent a number. Every number you report must be copied from a number that literally appears in the title above:
- reading.size_text is the EXACT substring of the title naming the size ("78 oz", "12 Count", "500 g", "1 Station").
- reading.size_number / reading.size_unit are that same size, split into a number and a unit. size_unit is one of: fl_oz, oz, gal, qt, pt, lb, g, kg, ml, l (measured), or "each" (a count item — traps, stations, cartridges, tablets, dunks, briquets, or a bare "N Count"/"N ct").
- reading.pack_count is 1 unless the title carries multi-pack wording ("Pack of 2", "2 x", "Case of 12"), in which case reading.pack_text is the exact substring naming that count.
- Fill in "reading" for "existing" and "new_product" only; leave it null otherwise. Fill in "new_product" only for kind "new_product" (name, category from the allowed list, active_ingredient if the title states one, epa_reg_no ONLY if an EPA registration number literally appears in the title — leave it null otherwise). Leave "product_id" null except for "existing".

Your reading is re-checked against the title in code; a mismatch discards the whole answer and holds the line for a person, so copy exactly what the title says.`;
}

async function callDecision(dispatch, prompt) {
  return dispatch(MODELS.TEXT_POLICIES.highStakes, {
    laneId: 'inventory_agent_decision',
    text: prompt,
    jsonMode: true,
    jsonSchema: DECISION_SCHEMA,
    maxTokens: 500,
    timeoutMs: LLM_TIMEOUT_MS,
  });
}

// ---- applying a validated decision (one transaction per line) -----------

function decisionRecord(decision, extra = {}) {
  return {
    kind: decision.kind,
    reason: decision.reason || null,
    productId: decision.kind === 'existing' ? decision.product.id : null,
    amount: decision.amount ?? null,
    unit: decision.unit ?? null,
    newProduct: decision.kind === 'new_product' ? decision.newProduct : null,
    reading: decision.reading || null,
    createdProductId: extra.createdProductId || null,
    createdAliasId: extra.createdAliasId || null,
  };
}

function sizesAgreeAcrossUnits(qtyA, unitA, qtyB, unitB) {
  const converted = convertInventoryQuantity(qtyA, unitA, unitB);
  return converted != null && sizesAgree(converted, qtyB);
}

async function ringBell(notifyAdmin, { lineId, emailId, status, title, body, trx }) {
  await notifyAdmin('inventory', title, body, {
    link: INVENTORY_LINK, bell: true, dedupeKey: `purchase-receipt:${lineId}`, trx, metadata: { emailId, status },
  });
}

// One purchase_receipt_lines row, one transaction: lock + re-read (skip if
// no longer agent_pending), lock the shipment, apply the decision, write
// the bell on the SAME transaction (a bell that can't be saved rolls the
// whole thing back, same discipline as processReceiptLine).
async function applyDecision(conn, { lineId, vendor, shipmentKey, email, decision }, notifyAdmin) {
  return conn.transaction(async (trx) => {
    const line = await trx('purchase_receipt_lines').where({ id: lineId }).forUpdate().first();
    if (!line || line.status !== 'agent_pending') return { applied: false, reason: 'no_longer_pending' };
    await lockShipment(trx, vendor, shipmentKey);

    if (decision.kind === 'not_stock' || decision.kind === 'equipment' || decision.kind === 'unsure') {
      await trx('purchase_receipt_lines').where({ id: lineId }).update({
        status: decision.status, agent_decision: decisionRecord(decision), agent_decided_at: new Date(),
      });
      if (decision.status === 'agent_equipment') {
        await ringBell(notifyAdmin, {
          lineId, emailId: email.id, status: decision.status, title: 'Inventory agent: equipment, not stock',
          body: `"${line.raw_title}" wasn't added: looks like equipment, not stock — add it to the equipment list if you're keeping it.`, trx,
        });
      } else if (decision.status === 'agent_unsure') {
        await ringBell(notifyAdmin, {
          lineId, emailId: email.id, status: decision.status, title: 'Inventory agent: not added',
          body: `"${line.raw_title}" wasn't added: ${decision.reason}. Log it by hand if it's stock.`, trx,
        });
      }
      // agent_ignored (not_stock): no bell, matching the deterministic
      // lane's own unmatched status.
      return { applied: true, status: decision.status };
    }

    // 'existing' / 'new_product' — resolve to one concrete, locked product.
    let productId;
    let createdProductId = null;
    let catalogChangeNote = null;

    if (decision.kind === 'existing') {
      productId = decision.product.id;
      const product = await trx('products_catalog').where({ id: productId }).forUpdate().first();
      if (!product || !product.active) return { applied: false, reason: 'product_no_longer_active' };
      if ((product.container_size || null) !== (decision.product.container_size || null)
        || (product.inventory_unit || null) !== (decision.product.inventory_unit || null)) {
        // The catalog moved under the decision between the LLM call and
        // this transaction — leave it pending for the next run to
        // re-decide against the current state, rather than apply a stale
        // agreement check.
        return { applied: false, reason: 'product_changed' };
      }
      if (decision.setContainerSize && !product.container_size) {
        await trx('products_catalog').where({ id: productId }).update({ container_size: decision.setContainerSize, updated_at: new Date() });
        catalogChangeNote = `set ${product.name}'s container size to ${decision.setContainerSize}`;
      }
    } else {
      const created = await inventoryOperations.createCatalogProduct({
        name: decision.newProduct.name,
        category: decision.newProduct.category,
        activeIngredient: decision.newProduct.activeIngredient || undefined,
        epaRegNumber: decision.newProduct.epaRegNumber || undefined,
        unitSize: decision.newProduct.containerSize,
        inventoryUnit: decision.newProduct.inventoryUnit,
        bestVendor: VENDOR_BEST[vendor] || null,
        autoReorderEnabled: false,
      }, { trx, source: 'inventory_agent_create' });
      productId = created.id;
      createdProductId = created.id;
      catalogChangeNote = `added "${created.name}" to the catalog`;
    }

    // Exact-title alias, only for a line that started with no matched
    // product at all, and only once the reading validated — a title with
    // no readable size never becomes an agent alias (classifyItem treats
    // an alias as owner-vetted for a size-less title).
    let createdAliasId = null;
    if (!line.product_id) {
      const existingAlias = await trx('product_aliases').whereRaw('LOWER(alias_name) = LOWER(?)', [line.raw_title]).first('id');
      if (!existingAlias) {
        const [alias] = await trx('product_aliases').insert({ product_id: productId, alias_name: line.raw_title, vendor_id: null }).returning('*');
        createdAliasId = alias.id;
      }
    }

    if (await findPossibleDuplicateMovement(trx, productId, email.received_at)) {
      await trx('purchase_receipt_lines').where({ id: lineId }).update({
        status: 'possible_duplicate', product_id: productId, received_qty: decision.amount, received_unit: decision.unit,
        agent_decision: decisionRecord(decision, { createdProductId, createdAliasId }), agent_decided_at: new Date(),
        agent_created_product_id: createdProductId, agent_created_alias_id: createdAliasId,
      });
      await ringBell(notifyAdmin, {
        lineId, emailId: email.id, status: 'possible_duplicate', title: 'Inventory agent: possible duplicate',
        body: `"${line.raw_title}" wasn't added. A manual restock or count was logged around the same time, so check the count.`, trx,
      });
      return { applied: true, status: 'possible_duplicate' };
    }

    // A catalog change just made (container size set, or a brand-new
    // product) can flip this SAME title to deterministically 'logged' next
    // sweep via classifyItem — if it already would, its own amount must
    // agree with what was just validated, or something is inconsistent and
    // this holds for a person rather than trusting either read blindly.
    const reclassified = await classifyItem({ title: line.raw_title, quantity: Number(line.quantity) }, trx);
    if (reclassified.status === 'logged' && !sizesAgreeAcrossUnits(reclassified.receivedQty, reclassified.receivedUnit, decision.amount, decision.unit)) {
      await trx('purchase_receipt_lines').where({ id: lineId }).update({
        status: 'agent_unsure',
        agent_decision: { ...decisionRecord(decision, { createdProductId, createdAliasId }), reclassifyDisagreed: true },
        agent_decided_at: new Date(),
      });
      await ringBell(notifyAdmin, {
        lineId, emailId: email.id, status: 'agent_unsure', title: 'Inventory agent: not added',
        body: `"${line.raw_title}" wasn't added: the catalog read disagreed with the agent's own amount after its change. Log it by hand if it's stock.`, trx,
      });
      return { applied: true, status: 'agent_unsure' };
    }

    const result = await inventoryOperations.adjustStock(productId, { movementType: 'restock', quantity: decision.amount, unit: decision.unit }, {
      source: SOURCES[vendor],
      extraMetadata: { inventoryAgent: true, orderNumber: line.order_number, emailId: email.id, rawTitle: line.raw_title, reading: decision.reading || null },
      trx,
    });

    await trx('purchase_receipt_lines').where({ id: lineId }).update({
      status: 'logged', product_id: productId, received_qty: decision.amount, received_unit: decision.unit, movement_id: result.movement.id,
      agent_decision: decisionRecord(decision, { createdProductId, createdAliasId }), agent_decided_at: new Date(),
      agent_created_product_id: createdProductId, agent_created_alias_id: createdAliasId,
    });

    await ringBell(notifyAdmin, {
      lineId, emailId: email.id, status: 'logged', title: 'Inventory agent logged a purchase',
      body: `${result.product.name} +${decision.amount} ${displayUnit(decision.unit)}`
        + `${catalogChangeNote ? ` — ${catalogChangeNote}` : ''} (line ${String(lineId).slice(0, 8)}).`,
      trx,
    });
    return { applied: true, status: 'logged' };
  });
}

// A failed/timed-out LLM call: bump the attempt count, or hand the line to
// a person on the 3rd. Its own short transaction, same bell-with-the-write
// discipline as everything else here.
async function recordLlmFailure(conn, lineId, notifyAdmin) {
  return conn.transaction(async (trx) => {
    const line = await trx('purchase_receipt_lines').where({ id: lineId }).forUpdate().first();
    if (!line || line.status !== 'agent_pending') return { status: 'no_longer_pending' };
    const attempts = Number(line.agent_attempts || 0) + 1;
    if (attempts < MAX_ATTEMPTS) {
      await trx('purchase_receipt_lines').where({ id: lineId }).update({ agent_attempts: attempts });
      return { status: 'still_pending' };
    }
    await trx('purchase_receipt_lines').where({ id: lineId }).update({
      status: 'agent_unsure', agent_attempts: attempts,
      agent_decision: { kind: 'unsure', reason: 'llm_unavailable' }, agent_decided_at: new Date(),
    });
    await ringBell(notifyAdmin, {
      lineId, emailId: line.email_id, status: 'agent_unsure', title: 'Inventory agent: not added',
      body: `"${line.raw_title}" wasn't added: the agent couldn't get a reading after ${attempts} tries. Log it by hand if it's stock.`, trx,
    });
    return { status: 'agent_unsure' };
  });
}

/**
 * The full decide-what-this-is pipeline for ONE title — build the prompt
 * context, call the LLM, and deterministically validate its answer. No I/O
 * beyond the reads candidateProducts/classifyItem/candidateAliases need and
 * the LLM call itself; never writes anything. Shared by processOneLine
 * (a real purchase_receipt_lines row) and ops/agents/inventory-agent-replay.js
 * (a title with no row at all — a read-only historical replay), so the two
 * can never compute a decision differently.
 */
async function decideForTitle(conn, dispatch, { rawTitle, quantity, vendor, siteOneFields }, { allowedCategories, activeProducts }) {
  const reClassified = await classifyItem({ title: rawTitle, quantity }, conn);
  const matchedProduct = reClassified.product || null;
  const candidates = await candidateProducts(conn, rawTitle, matchedProduct);
  const aliasesByProduct = await candidateAliases(conn, candidates.map((c) => c.id));

  const prompt = buildPrompt({
    rawTitle, quantity, vendor, status: reClassified.status, matchedProduct, siteOneFields, candidates, aliasesByProduct, allowedCategories,
  });
  const res = await callDecision(dispatch, prompt);
  if (!res.ok || !res.json) return { llmFailed: true, reClassified, reason: res.reason || null };

  const decision = classifyDecision(res.json, { rawTitle, lineQuantity: quantity, candidates, allActiveProducts: activeProducts, allowedCategories });
  return { decision, reClassified, raw: res.json };
}

async function processOneLine(conn, line, { dispatch, notifyAdmin, allowedCategories, activeProducts }) {
  const email = line.email_id && await conn('emails').where({ id: line.email_id }).first('id', 'received_at');
  if (!email) return { status: 'still_pending' }; // its email row is gone; nothing to key the duplicate guard on

  const siteOneFields = line.vendor === 'siteone' ? await siteOneLineFields(conn, line) : null;
  const outcome = await decideForTitle(conn, dispatch, { rawTitle: line.raw_title, quantity: Number(line.quantity), vendor: line.vendor, siteOneFields }, { allowedCategories, activeProducts });
  if (outcome.llmFailed) return recordLlmFailure(conn, line.id, notifyAdmin);

  const applied = await applyDecision(conn, { lineId: line.id, vendor: line.vendor, shipmentKey: line.shipment_key, email, decision: outcome.decision }, notifyAdmin);
  return applied.applied ? { status: applied.status } : { status: 'still_pending' };
}

/**
 * Works up to `limit` agent_pending lines, oldest first. Called from the
 * same scheduler job as the deterministic sweep, right after it, only when
 * GATE_INVENTORY_AGENT is on (also self-checks the gate — cheap, and every
 * other entry point in this lane does the same).
 */
async function runInventoryAgent({ conn = db, llm, notifyAdmin, limit = BATCH_LIMIT } = {}) {
  if (!gateEnvValue(GATE)) return { skipped: 'gated' };
  const notify = notifyAdmin || ((...args) => require('../notification-service').notifyAdmin(...args));
  const dispatch = llm || dispatchWithFallback;

  const lines = await conn('purchase_receipt_lines').where({ status: 'agent_pending' }).orderBy('created_at', 'asc').limit(limit);
  if (!lines.length) return { logged: 0, held: 0, stillPending: 0, errors: 0 };

  const [allowedCategories, activeProducts] = await Promise.all([
    loadAllowedCategories(conn),
    conn('products_catalog').where({ active: true }).select('id', 'name'),
  ]);

  const totals = { logged: 0, held: 0, stillPending: 0, errors: 0 };
  for (const line of lines) {
    try {
      const outcome = await processOneLine(conn, line, { dispatch, notifyAdmin: notify, allowedCategories, activeProducts });
      if (outcome.status === 'logged') totals.logged += 1;
      else if (outcome.status === 'still_pending' || outcome.status === 'no_longer_pending') totals.stillPending += 1;
      else totals.held += 1;
    } catch (err) {
      logger.error(`[inventory-agent] line ${line.id} ("${line.raw_title}") failed: ${err.message}`);
      totals.errors += 1;
    }
  }
  return totals;
}

module.exports = {
  runInventoryAgent,
  // Exported for unit tests — see server/tests/inventory-agent.test.js.
  // The first line is pure (no I/O); recordLlmFailure is the one small
  // DB-touching unit worth testing without a full Postgres suite.
  validateReading, canonicalUnit, containerAgreement, classifyDecision, extractEpaRegNumber,
  canonicalSizeText, inventoryUnitForNewProduct, candidateProducts, VENDOR_LABEL,
  recordLlmFailure,
  // The read-only decide pipeline — ops/agents/inventory-agent-replay.js reuses
  // this so a replay can never compute a decision differently than a live run.
  decideForTitle, loadAllowedCategories,
};
