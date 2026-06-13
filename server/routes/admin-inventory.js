const express = require('express');
const { parse: parseCsvSync } = require('csv-parse/sync');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const MODELS = require('../config/models');
const { buildPlanForService } = require('../services/waveguard-plan-engine');
const { etDateString, addETDays } = require('../utils/datetime-et');
const {
  convertInventoryQuantity,
  describeInventoryConversion,
  normalizeInventoryUnit,
  unitDefinition,
} = require('../services/inventory-units');
const {
  calcLandedCost,
  costLineFromUsage,
  normalizeQuantityToOz,
} = require('../services/product-costing');
const protocols = require('../config/protocols.json');

router.use(adminAuthenticate, requireTechOrAdmin);

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isSupportedInventoryUnit(unit) {
  return Boolean(String(unit || '').trim() && unitDefinition(unit));
}

function assertSupportedInventoryUnit(unit, field = 'Inventory unit') {
  if (!unit) return;
  if (!isSupportedInventoryUnit(unit)) {
    const err = new Error(`${field} is not supported`);
    err.statusCode = 400;
    throw err;
  }
}

function looksLiquidProduct(product = {}) {
  const text = `${product.name || ''} ${product.category || ''} ${product.subcategory || ''} ${product.formulation || ''} ${product.unit_type || ''}`.toLowerCase();
  return /\b(liquid|flowable|sc|sl|ec|ew|solution|sprayable|hydretain|talstar|atrazine|dismiss|headway|medallion|primo|acelepryn|dispatch|carbonpro|k-flow)\b/.test(text);
}

function unitReviewReasons(product = {}) {
  const reasons = [];
  const stock = numberOrNull(product.inventory_on_hand);
  const threshold = numberOrNull(product.low_stock_threshold);
  const unit = product.inventory_unit || null;
  if ((stock != null || threshold != null) && !unit) {
    reasons.push({ code: 'missing_inventory_unit', severity: 'block', message: 'Inventory stock or threshold is set without an inventory unit.' });
  }
  if (unit && !isSupportedInventoryUnit(unit)) {
    reasons.push({ code: 'unsupported_inventory_unit', severity: 'block', message: `${unit} is not a supported inventory unit.` });
  }
  if (unit && normalizeInventoryUnit(unit) === 'oz') {
    reasons.push({
      code: 'ambiguous_oz_unit',
      severity: looksLiquidProduct(product) ? 'warn' : 'info',
      message: looksLiquidProduct(product)
        ? 'This product looks liquid but inventory is tracked as oz; use fl_oz if it is fluid ounces.'
        : 'Inventory uses oz, which can be dry ounces or fluid ounces. Confirm this is intentional.',
    });
  }
  return reasons;
}

function mapUnitReviewProduct(product) {
  const reasons = unitReviewReasons(product);
  return {
    id: product.id,
    name: product.name,
    category: product.category || null,
    subcategory: product.subcategory || null,
    formulation: product.formulation || null,
    inventoryOnHand: product.inventory_on_hand != null ? Number(product.inventory_on_hand) : null,
    inventoryUnit: product.inventory_unit || null,
    lowStockThreshold: product.low_stock_threshold != null ? Number(product.low_stock_threshold) : null,
    rateUnit: product.rate_unit || null,
    unitSizeOz: product.unit_size_oz != null ? Number(product.unit_size_oz) : null,
    reasons,
    suggestedUnit: looksLiquidProduct(product) && normalizeInventoryUnit(product.inventory_unit) === 'oz' ? 'fl_oz' : null,
  };
}

function csvEscape(value) {
  if (value == null) return '';
  const str = String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function rowsToCsv(headers, rows) {
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ].join('\n');
}

function truthy(value) {
  return ['true', '1', 'yes', 'y'].includes(String(value || '').trim().toLowerCase());
}

function cleanString(value) {
  const str = String(value ?? '').trim();
  return str || null;
}

function parseJsonObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseBoundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

const HERMES_LOGIN_DISCOVERY_CONNECTION_TYPES = [
  'portal_connector',
  'approved_feed',
  'api',
  'workwave_marketplace',
];
const HERMES_LOGIN_DISCOVERY_TERMINAL_STATUSES = ['completed'];
const HERMES_QUEUE_PRESERVED_VENDOR_STATUSES = [
  'configured',
  'not_required',
  'manual',
  'needs_rep_setup',
  'needs_api_key',
];

function isOpenLoginDiscoveryJob(loginDiscovery = {}) {
  if (loginDiscovery.status === 'queued') return true;
  if (loginDiscovery.status !== 'running') return false;
  const claimedUntil = Date.parse(loginDiscovery.claimedUntil || '');
  return Number.isFinite(claimedUntil) && claimedUntil > Date.now();
}

function isTerminalLoginDiscoveryJob(loginDiscovery = {}) {
  return HERMES_LOGIN_DISCOVERY_TERMINAL_STATUSES.includes(String(loginDiscovery.status || '').toLowerCase());
}

function loginDiscoveryFromConnection(connection = {}) {
  if (connection.loginDiscovery && typeof connection.loginDiscovery === 'object') return connection.loginDiscovery;
  return parseJsonObject(connection.config_json, {}).loginDiscovery || null;
}

function isLoginDiscoveryConnection(connection = {}) {
  return connection.is_active !== false
    && HERMES_LOGIN_DISCOVERY_CONNECTION_TYPES.includes(connection.connection_type);
}

function findOpenLoginDiscoveryConnection(connections = []) {
  return connections.find((connection) => (
    isLoginDiscoveryConnection(connection)
    && isOpenLoginDiscoveryJob(loginDiscoveryFromConnection(connection) || {})
  )) || null;
}

function hasTerminalLoginDiscoveryResult(connections = []) {
  return connections.some((connection) => (
    isLoginDiscoveryConnection(connection)
    && isTerminalLoginDiscoveryJob(loginDiscoveryFromConnection(connection) || {})
  ));
}

function vendorCredentialStatusWhileQueued(status) {
  const normalized = String(status || '').toLowerCase();
  return HERMES_QUEUE_PRESERVED_VENDOR_STATUSES.includes(normalized) ? status : 'needs_login';
}

function vendorHasLoginIdentity(vendor = {}) {
  return Boolean(cleanString(vendor.login_username) || cleanString(vendor.login_email) || cleanString(vendor.account_number));
}

function vendorNeedsLoginDiscovery(vendor = {}, connections = [], includePublic = false, options = {}) {
  if (vendor.active === false) return false;
  if (String(vendor.type || '') === 'competitor_reference') return false;
  if (!options.retryTerminal && hasTerminalLoginDiscoveryResult(connections)) return false;

  const hasLoginUrl = Boolean(cleanString(vendor.login_url));
  const hasLoginIdentity = vendorHasLoginIdentity(vendor);
  const credentialStatus = String(vendor.credential_status || '').toLowerCase();
  const syncMethod = String(vendor.sync_method || '').toLowerCase();
  if (['manual', 'manual_csv', 'manual_seed'].includes(credentialStatus)) return false;
  if (['manual', 'manual_csv', 'manual_seed'].includes(syncMethod)) return false;
  const accountConnection = connections.find(isLoginDiscoveryConnection);
  const configured = connections.some((connection) => (
    isLoginDiscoveryConnection(connection)
    && connection.credential_status === 'configured'
  ));

  if (configured && hasLoginUrl && hasLoginIdentity) return false;
  if (credentialStatus && ['configured', 'not_required'].includes(credentialStatus) && !includePublic) return false;
  if (syncMethod === 'public_scraper' && credentialStatus === 'not_required' && !includePublic) return false;
  if (!hasLoginUrl || !hasLoginIdentity) return true;
  if (['needs_login', 'needs_rep_setup', 'needs_api_key', 'missing', 'failed', 'expired'].includes(credentialStatus)) return true;
  return Boolean(accountConnection && accountConnection.credential_status !== 'configured');
}

async function ensureLoginDiscoveryConnection(trx, vendor) {
  const existingConnections = await trx('vendor_connections')
    .where({ vendor_id: vendor.id })
    .whereIn('connection_type', HERMES_LOGIN_DISCOVERY_CONNECTION_TYPES)
    .orderByRaw(`
      CASE connection_type
        WHEN 'portal_connector' THEN 0
        WHEN 'workwave_marketplace' THEN 1
        WHEN 'approved_feed' THEN 2
        WHEN 'api' THEN 3
        ELSE 4
      END
    `);
  const activeConnection = existingConnections.find((connection) => connection.is_active !== false);
  if (activeConnection) return activeConnection;
  if (existingConnections.length) {
    const inactiveConnection = existingConnections[0];
    const config = parseJsonObject(inactiveConnection.config_json, {});
    const [connection] = await trx('vendor_connections')
      .where({ id: inactiveConnection.id })
      .update({
        approval_status: inactiveConnection.approval_status === 'approved' ? 'approved' : 'requested',
        credential_status: inactiveConnection.credential_status === 'configured' ? 'configured' : 'missing',
        supports_account_pricing: true,
        supports_inventory: true,
        supports_branch_availability: true,
        is_active: true,
        config_json: JSON.stringify({
          ...config,
          reactivatedFrom: config.reactivatedFrom || 'hermes_login_discovery',
        }),
        failure_reason: null,
        updated_at: new Date(),
      })
      .returning('*');
    return connection;
  }

  const [connection] = await trx('vendor_connections')
    .insert({
      vendor_id: vendor.id,
      connection_type: 'portal_connector',
      approval_status: 'requested',
      credential_status: 'missing',
      supports_account_pricing: true,
      supports_public_pricing: false,
      supports_inventory: true,
      supports_branch_availability: true,
      supports_bulk_pricing: false,
      config_json: JSON.stringify({
        seededFrom: 'hermes_login_discovery',
      }),
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .returning('*');
  return connection;
}

function parseDecimalOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseMappingRows(body = {}) {
  if (Array.isArray(body.rows)) return body.rows;
  if (typeof body.csv === 'string' && body.csv.trim()) {
    return parseCsvSync(body.csv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  }
  return [];
}

function calculateMappingConfidenceCap(row, verified) {
  const hasIdentifier = Boolean(
    cleanString(row.vendor_sku)
    || cleanString(row.product_url)
    || cleanString(row.manufacturer_sku)
    || cleanString(row.upc)
    || cleanString(row.asin)
  );
  const hasPackage = Boolean(
    parseDecimalOrNull(row.package_size_value) != null
    && cleanString(row.package_size_unit)
    && cleanString(row.purchase_uom)
  );

  if (!hasIdentifier) return 0.50;
  if (!hasPackage) return 0.70;
  if (!verified) return 0.80;
  return 1.00;
}

function normalizeAvailabilityStatus(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['in_stock', 'limited', 'out_of_stock', 'backorder', 'unknown'].includes(normalized)) {
    return normalized;
  }
  return value ? 'unknown' : null;
}

function mapProduct(product, vendorPricing = []) {
  const inventoryOnHand = numberOrNull(product.inventory_on_hand);
  const lowStockThreshold = numberOrNull(product.low_stock_threshold);
  const lowStock = inventoryOnHand != null
    && lowStockThreshold != null
    && inventoryOnHand <= lowStockThreshold;
  return {
    id: product.id,
    name: product.name,
    category: product.category,
    subcategory: product.subcategory || null,
    activeIngredient: product.active_ingredient,
    moaGroup: product.moa_group,
    containerSize: product.container_size,
    formulation: product.formulation,
    sku: product.sku,
    bestPrice: product.best_price ? parseFloat(product.best_price) : null,
    bestVendor: product.best_vendor,
    needsPricing: product.needs_pricing,
    bestVendorPricingId: product.best_vendor_pricing_id || null,
    bestPriceAmountCached: product.best_price_amount_cached != null ? parseFloat(product.best_price_amount_cached) : null,
    bestPriceVendorIdCached: product.best_price_vendor_id_cached || null,
    bestPriceUpdatedAt: product.best_price_updated_at || null,
    bestPriceStatus: product.best_price_status || null,
    costPerUnit: product.cost_per_unit != null ? parseFloat(product.cost_per_unit) : null,
    costUnit: product.cost_unit || null,
    unitSizeOz: product.unit_size_oz || null,
    unitType: product.unit_type || null,
    monthlyCost: product.monthly_cost_estimate || null,
    inventoryOnHand,
    inventoryUnit: product.inventory_unit || null,
    lowStockThreshold,
    lowStock,
    vendorPricing,
    // Product Registry fields
    customerVisibility: product.customer_visibility || 'internal_only',
    contentStatus: product.content_status || 'draft',
    commonName: product.common_name || null,
    publicSummary: product.public_summary || null,
    portalSummary: product.portal_summary || null,
    customerSafetySummary: product.customer_safety_summary || null,
    petKidGuidanceText: product.pet_kid_guidance_text || null,
    targetPests: product.target_pests || null,
    applicationZones: product.application_zones || null,
    epaRegNumber: product.epa_reg_number || null,
    signalWord: product.signal_word || null,
    reentryText: product.reentry_text || null,
    rainfastMinutes: product.rainfast_minutes || null,
    labelUrl: product.label_url || null,
    sdsUrl: product.sds_url || null,
    productType: product.product_type || null,
    manufacturer: product.manufacturer || null,
    fertilizerAnalysis: product.fertilizer_analysis || null,
    labelSourceUrl: product.label_source_url || null,
    labelVerifiedAt: product.label_verified_at || null,
    labelVersion: product.label_version || null,
    approvedForPublicPage: product.approved_for_public_page === true,
    approvedForEstimatePacket: product.approved_for_estimate_packet === true,
    approvedForServiceReport: product.approved_for_service_report === true,
    customerPrecautionSummary: product.customer_precaution_summary || null,
    reentrySummary: product.reentry_summary || null,
    serviceReportSummary: product.service_report_summary || null,
    useConditions: product.use_conditions || null,
    heatRestrictions: product.heat_restrictions || null,
    irrigationNotes: product.irrigation_notes || null,
    localRuleSensitivity: product.local_rule_sensitivity === true,
  };
}

const LAWN_PROTOCOL_PRODUCT_DEFINITIONS = [
  { key: 'prodiamine_65_wdg', label: 'Prodiamine 65 WDG', aliases: ['Prodiamine 65 WDG', 'Prodiamine'], type: 'pesticide', category: 'pre-emergent herbicide' },
  { key: 'celsius_wg', label: 'Celsius WG', aliases: ['Celsius WG', 'Celsius'], type: 'pesticide', category: 'post-emergent herbicide' },
  { key: 'sedgehammer_plus', label: 'SedgeHammer Plus', aliases: ['Sedgehammer Plus', 'SedgeHammer Plus', 'Sedgehammer', 'SedgeHammer'], type: 'pesticide', category: 'sedge herbicide' },
  { key: 'headway', label: 'Headway', aliases: ['Headway G', 'Headway'], type: 'pesticide', category: 'fungicide' },
  { key: 'lesco_24_0_11', label: 'LESCO 24-0-11', aliases: ['LESCO 24-0-11', '24-0-11'], type: 'fertilizer', category: 'fertilizer' },
  { key: 'lesco_24_2_11', label: 'LESCO 24-2-11', aliases: ['LESCO 24-2-11', '24-2-11'], type: 'fertilizer', category: 'fertilizer' },
  { key: 'chelated_iron', label: 'Chelated Iron Plus', aliases: ['Chelated Iron Plus', 'Chelated Iron'], type: 'fertilizer', category: 'iron and micronutrient support' },
  { key: 'high_mn_combo', label: 'High Mn Combo', aliases: ['High Mn Combo', 'High Mn'], type: 'fertilizer', category: 'micronutrient support' },
  { key: 'medallion_sc', label: 'Medallion SC', aliases: ['Medallion SC', 'Medallion'], type: 'pesticide', category: 'fungicide' },
  { key: 'acelepryn_xtra', label: 'Acelepryn Xtra', aliases: ['Acelepryn Xtra', 'Acelepryn'], type: 'pesticide', category: 'insecticide' },
  { key: 'speedzone_southern', label: 'SpeedZone Southern', aliases: ['SpeedZone Southern', 'SpeedZone'], type: 'pesticide', category: 'post-emergent herbicide' },
  { key: 'k_flow', label: 'K-Flow 0-0-25', aliases: ['K-Flow 0-0-25', 'K-Flow'], type: 'fertilizer', category: 'potassium support' },
  { key: 'primo_maxx', label: 'Primo Maxx', aliases: ['Primo Maxx', 'Primo'], type: 'pesticide', category: 'plant growth regulator' },
  { key: 'dismiss', label: 'Dismiss', aliases: ['Dismiss NXT', 'Dismiss'], type: 'pesticide', category: 'sedge herbicide' },
  { key: 'carbonpro_l', label: 'CarbonPro-L', aliases: ['CarbonPro-L', 'CarbonPro', 'LESCO CarbonPro'], type: 'biostimulant', category: 'soil amendment / biostimulant' },
  { key: 'hydretain', label: 'Hydretain', aliases: ['Hydretain'], type: 'wetting_agent', category: 'moisture manager' },
  { key: 'talstar', label: 'Talstar', aliases: ['Talstar P', 'Talstar'], type: 'pesticide', category: 'insecticide' },
  { key: 'arena_50_wdg', label: 'Arena 50 WDG', aliases: ['Arena 50 WDG', 'Arena'], type: 'pesticide', category: 'insecticide' },
  { key: 'atrazine_4l', label: 'Atrazine 4L', aliases: ['Atrazine 4L', 'Atrazine'], type: 'pesticide', category: 'herbicide' },
  { key: 'three_way', label: 'Three-Way', aliases: ['Three-Way', 'Three Way'], type: 'pesticide', category: 'herbicide' },
  { key: 'bio_kmag', label: 'LESCO 0-0-18 Bio KMAG', aliases: ['LESCO 0-0-18 Bio KMAG', 'Bio KMAG', 'KMAG'], type: 'fertilizer', category: 'potassium and magnesium support' },
  { key: 'lesco_elite_0_0_28', label: 'LESCO Elite 0-0-28', aliases: ['LESCO Elite 0-0-28', 'Elite 0-0-28', '0-0-28'], type: 'fertilizer', category: 'potassium support' },
  { key: 'armada_50_wdg', label: 'Armada 50 WDG', aliases: ['Armada 50 WDG', 'Armada'], type: 'pesticide', category: 'fungicide' },
  { key: 'bifen_it', label: 'Bifen I/T', aliases: ['Bifen I/T', 'Bifen'], type: 'pesticide', category: 'insecticide' },
  { key: 'dylox_420_sl', label: 'Dylox 420 SL', aliases: ['Dylox 420 SL', 'Dylox'], type: 'pesticide', category: 'insecticide' },
  { key: 'topchoice', label: 'Topchoice Granular Insecticide', aliases: ['Topchoice Granular Insecticide', 'Topchoice'], type: 'pesticide', category: 'fire ant insecticide' },
  { key: 'drive_xlr8', label: 'Drive XLR8', aliases: ['Drive XLR8'], type: 'pesticide', category: 'post-emergent herbicide' },
  { key: 'torque_sc', label: 'Torque SC', aliases: ['Torque SC', 'Torque'], type: 'pesticide', category: 'fungicide' },
  { key: 'dispatch', label: 'Dispatch wetting agent', aliases: ['Dispatch wetting agent', 'Dispatch'], type: 'wetting_agent', category: 'wetting agent' },
  { key: 'anuew_ez', label: 'Anuew EZ', aliases: ['Anuew EZ', 'Anuew'], type: 'pesticide', category: 'plant growth regulator' },
  { key: 'green_flo_ca', label: 'Green Flo 6-0-0 Ca', aliases: ['Green Flo 6-0-0', 'Green Flo'], type: 'fertilizer', category: 'calcium support' },
  { key: 'green_flo_phyte', label: 'Green Flo Phyte Plus 0-0-26', aliases: ['Green Flo Phyte Plus', 'Phyte Plus'], type: 'fertilizer', category: 'phosphite and potassium support' },
  { key: 'moisture_manager', label: 'Moisture Manager', aliases: ['Moisture Manager'], type: 'wetting_agent', category: 'wetting agent' },
];

function normalizeProtocolText(value) {
  return String(value || '').toLowerCase();
}

function protocolProductReferences(definition) {
  const refs = [];
  for (const [trackKey, track] of Object.entries(protocols.lawn || {})) {
    for (const visit of track.visits || []) {
      const text = normalizeProtocolText([visit.primary, visit.secondary, visit.notes].filter(Boolean).join('\n'));
      if (definition.aliases.some((alias) => text.includes(normalizeProtocolText(alias)))) {
        refs.push({
          turf: trackKey,
          month: visit.month,
          visit: visit.visit,
        });
      }
    }
  }
  return refs;
}

function rowPriority(row) {
  const statusRank = {
    missing_product: 0,
    needs_facts: 1,
    ready_to_approve: 2,
    approved: 3,
  };
  return statusRank[row.readiness?.status] ?? 9;
}

function suggestedLawnFactCopy(definition, product) {
  const name = product?.name || definition.label;
  const category = definition.category || product?.category || 'lawn care product';
  const pesticideCopy = definition.type === 'pesticide'
    ? 'When this pesticide product is used, the technician follows the product label and service report instructions. People and pets should remain off treated areas until the application has dried, unless the label or technician instructions require a longer interval.'
    : 'When this product is used, follow the service report instructions for watering, access, or other customer action items.';
  return {
    productType: product?.product_type || definition.type,
    publicSummary: `${name} may be used as part of the ${category} portion of the lawn program when turf type, season, weather, site conditions, label directions, and local rules allow.`,
    customerPrecautionSummary: pesticideCopy,
    reentrySummary: definition.type === 'pesticide'
      ? 'Follow the product label and technician service report before re-entering treated areas.'
      : 'Follow the technician service report for any product-specific instructions.',
  };
}

function inferProductType(product = {}) {
  if (product.product_type) return product.product_type;
  const category = String(product.category || '').toLowerCase();
  if (/(herbicide|insecticide|fungicide|pgr|growth)/.test(category)) return 'pesticide';
  if (category.includes('fertilizer')) return 'fertilizer';
  if (category.includes('wetting')) return 'wetting_agent';
  return 'other';
}

function validEpaRegNumber(value) {
  const text = String(value || '').trim();
  return !!text && !/^(n\/a|not epa|not epa-registered fertilizer|none)$/i.test(text);
}

function lawnFactReadiness(product) {
  if (!product) return {
    status: 'missing_product',
    missing: ['Product not found in catalog'],
    warnings: [],
    eligible: false,
  };
  const missing = [];
  const warnings = [];
  const productType = inferProductType(product);
  const visibility = product.customer_visibility || 'internal_only';
  const contentStatus = product.content_status || 'draft';
  if (!['public', 'portal_only'].includes(visibility)) missing.push('Customer visibility must be public or portal-only');
  if (!['approved_for_public', 'approved_for_portal', 'approved'].includes(contentStatus)) missing.push('Content status must be approved');
  if (!product.label_verified_at) missing.push('Label verification date is required');
  if (!(product.public_summary || product.portal_summary)) missing.push('Public or portal summary is required');
  if (!(product.customer_safety_summary || product.customer_precaution_summary || product.pet_kid_guidance_text)) {
    missing.push('Customer safety or precaution copy is required');
  }
  if (productType === 'pesticide' && !validEpaRegNumber(product.epa_reg_number)) {
    missing.push('EPA registration number is required for pesticide products');
  }
  if (!product.product_type) warnings.push(`Product type inferred as ${productType}`);
  return {
    status: missing.length ? 'needs_facts' : product.approved_for_estimate_packet ? 'approved' : 'ready_to_approve',
    missing,
    warnings,
    eligible: missing.length === 0,
    productType,
  };
}

function serviceLineForType(serviceType) {
  const value = String(serviceType || '').toLowerCase();
  if (value.includes('termite') || value.includes('bora-care') || value.includes('bora care') || value.includes('termidor')) return 'termite';
  if (value.includes('mosquito')) return 'mosquito';
  if (value.includes('rodent') || value.includes('rat') || value.includes('mouse') || value.includes('mice')) return 'rodent';
  if (value.includes('lawn')) return 'lawn';
  if (value.includes('tree') || value.includes('shrub') || value.includes('palm')) return 'tree_shrub';
  return 'pest';
}

function protocolTemplateCounts() {
  return {
    pest: Math.max(0, (protocols.pest?.visits || []).length - 2),
    termite: (protocols.termite?.visits || []).length,
    lawn: Object.keys(protocols.lawn || {}).length,
    mosquito: (protocols.pest?.visits || []).filter((v) => String(v.primary || '').toLowerCase().includes('mosquito')).length,
    rodent: (protocols.pest?.visits || []).filter((v) => String(v.primary || '').toLowerCase().includes('rodent')).length,
    tree_shrub: (protocols.tree_shrub?.visits || []).length,
  };
}

async function syncLawnReadinessAfterRestock() {
  if (!(await db.schema.hasTable('admin_alerts'))) return null;

  const { buildReadinessQueue } = require('../services/lawn-protocol-readiness-cron');
  const queue = await buildReadinessQueue({ days: 14, limit: 100 });
  const blocked = Number(queue.statusCounts?.blocked || 0);
  const warning = Number(queue.statusCounts?.warning || 0);
  const appointmentCount = queue.appointments?.length || 0;
  const now = new Date();
  const metadata = {
    source: 'inventory_restock_receive_recheck',
    recheckedAt: now.toISOString(),
    scanStartDate: queue.startDate,
    scanEndDate: queue.endDate,
    days: queue.days,
    statusCounts: queue.statusCounts,
  };

  if (blocked === 0) {
    const resolvedAlerts = await db('admin_alerts')
      .where({ type: 'lawn_protocol_readiness', status: 'open' })
      .update({
        status: 'resolved',
        resolved_at: now,
        last_seen_at: now,
        description: 'Resolved after inventory restock readiness recheck.',
        metadata: JSON.stringify(metadata),
        updated_at: now,
      });
    return {
      alertStatus: 'resolved',
      blocked,
      warning,
      appointmentCount,
      resolvedAlerts,
      updatedAlerts: 0,
    };
  }

  const updatedAlerts = await db('admin_alerts')
    .where({ type: 'lawn_protocol_readiness', status: 'open' })
    .update({
      severity: blocked >= 5 ? 'critical' : 'high',
      title: `WaveGuard readiness: ${blocked} blocked appointment${blocked === 1 ? '' : 's'}`,
      description: `${blocked} of ${appointmentCount} upcoming WaveGuard lawn appointment${appointmentCount === 1 ? '' : 's'} remain blocked after inventory restock recheck. ${warning} appointment${warning === 1 ? '' : 's'} have warnings.`,
      href: '/admin/lawn-protocol?tab=readiness',
      last_seen_at: now,
      metadata: JSON.stringify(metadata),
      updated_at: now,
    });

  return {
    alertStatus: updatedAlerts > 0 ? 'still_blocked' : 'no_open_alert',
    blocked,
    warning,
    appointmentCount,
    resolvedAlerts: 0,
    updatedAlerts,
  };
}

function summarizeForecastStatus(row) {
  if (row.unitMismatchCount > 0) return 'unit_mismatch';
  if (row.onHand == null) return 'not_tracked';
  if (row.committedDemand <= 0) return 'ok';
  if (row.onHand < row.committedDemand) return 'short';
  if (row.lowStockThreshold != null && row.projectedRemaining <= row.lowStockThreshold) return 'warning';
  return 'ok';
}

function forecastPriority(status, firstShortDate) {
  if (status === 'short') return firstShortDate ? 'urgent' : 'high';
  if (status === 'warning') return 'high';
  if (status === 'unit_mismatch' || status === 'not_tracked') return 'normal';
  return 'low';
}

async function buildWaveGuardInventoryForecast({ days = 14, limit = 150 } = {}) {
  const safeDays = Math.max(1, Math.min(90, Number(days || 14)));
  const safeLimit = Math.max(1, Math.min(300, Number(limit || 150)));
  const startDate = etDateString();
  const endDate = etDateString(addETDays(new Date(), safeDays));
  const services = await db('scheduled_services as ss')
    .leftJoin('customers as c', 'ss.customer_id', 'c.id')
    .leftJoin('technicians as t', 'ss.technician_id', 't.id')
    .whereBetween('ss.scheduled_date', [startDate, endDate])
    .whereNotIn('ss.status', ['completed', 'cancelled', 'canceled', 'void'])
    .whereNotNull('c.waveguard_tier')
    .where(function lawnService() {
      this.whereILike('ss.service_type', '%lawn%')
        .orWhereILike('ss.service_type', '%fertiliz%')
        .orWhereILike('ss.service_type', '%turf%');
    })
    .select(
      'ss.id',
      'ss.customer_id',
      'ss.service_type',
      'ss.scheduled_date',
      'ss.window_start',
      'c.first_name',
      'c.last_name',
      'c.address_line1',
      'c.city',
      'c.waveguard_tier',
      't.name as technician_name',
    )
    .orderBy('ss.scheduled_date', 'asc')
    .orderBy('ss.window_start', 'asc')
    .limit(safeLimit);

  const productMap = new Map();
  const errors = [];

  function ensureRow(product, inventory, demandUnit) {
    const key = String(product.id);
    if (!productMap.has(key)) {
      productMap.set(key, {
        productId: product.id,
        productName: product.name,
        category: product.category || null,
        inventoryUnit: inventory?.unit || null,
        demandUnit: demandUnit || inventory?.unit || null,
        onHand: inventory?.onHand != null ? Number(inventory.onHand) : null,
        lowStockThreshold: inventory?.lowStockThreshold != null ? Number(inventory.lowStockThreshold) : null,
        committedDemand: 0,
        unconvertedDemand: 0,
        unitMismatchCount: 0,
        conversionConfidence: 'exact_unit',
        appointments: [],
        mismatchAppointments: [],
        firstShortDate: null,
      });
    }
    return productMap.get(key);
  }

  for (const service of services) {
    try {
      const plan = await buildPlanForService(service.id, { db });
      const customerName = `${service.first_name || ''} ${service.last_name || ''}`.trim() || 'Customer';
      for (const item of plan?.mixCalculator?.items || []) {
        if (!item?.product?.id) continue;
        const amount = numberOrNull(item.mix?.amount);
        if (!amount || amount <= 0) continue;
        const inventory = item.product.inventory || {};
        const amountUnit = item.mix?.amountUnit || item.mix?.rateUnit || inventory.unit || null;
        const row = ensureRow(item.product, inventory, amountUnit);
        const appointment = {
          serviceId: service.id,
          customerId: service.customer_id,
          customerName,
          serviceType: service.service_type,
          scheduledDate: service.scheduled_date,
          city: service.city,
          waveguardTier: service.waveguard_tier,
          protocolWindowTitle: plan?.protocol?.structured?.window?.title || plan?.closeout?.protocolWindowTitle || null,
          amount,
          unit: amountUnit,
          inventoryUnit: row.inventoryUnit || amountUnit,
          substitution: item.substitution || null,
        };
        const conversion = describeInventoryConversion(amount, amountUnit, row.inventoryUnit || amountUnit);
        appointment.inventoryAmount = conversion.amount;
        appointment.conversionConfidence = conversion.confidence;
        if (conversion.convertible && conversion.amount != null) {
          row.committedDemand = Number((row.committedDemand + conversion.amount).toFixed(4));
          if (conversion.confidence !== 'exact_unit') row.conversionConfidence = conversion.confidence;
          row.appointments.push(appointment);
        } else {
          row.unconvertedDemand = Number((row.unconvertedDemand + amount).toFixed(4));
          row.unitMismatchCount += 1;
          row.conversionConfidence = 'needs_review';
          row.mismatchAppointments.push(appointment);
        }
      }
    } catch (err) {
      errors.push({
        serviceId: service.id,
        scheduledDate: service.scheduled_date,
        customerName: `${service.first_name || ''} ${service.last_name || ''}`.trim() || 'Customer',
        message: err.message || 'Forecast plan failed',
      });
    }
  }

  const products = Array.from(productMap.values()).map((row) => {
    row.projectedRemaining = row.onHand != null
      ? Number((row.onHand - row.committedDemand).toFixed(4))
      : null;
    let runningDemand = 0;
    for (const appointment of row.appointments.slice().sort((a, b) => String(a.scheduledDate).localeCompare(String(b.scheduledDate)))) {
      runningDemand = Number((runningDemand + Number(appointment.inventoryAmount || appointment.amount || 0)).toFixed(4));
      if (row.onHand != null && runningDemand > row.onHand) {
        row.firstShortDate = appointment.scheduledDate;
        break;
      }
    }
    row.status = summarizeForecastStatus(row);
    row.shortfall = row.onHand != null
      ? Math.max(0, Number((row.committedDemand - row.onHand).toFixed(4)))
      : null;
    const targetBuffer = row.lowStockThreshold != null
      ? row.lowStockThreshold
      : Number((row.committedDemand * 0.25).toFixed(4));
    row.targetStock = Number((row.committedDemand + targetBuffer).toFixed(4));
    row.recommendedOrderQuantity = row.onHand != null
      ? Math.max(0, Number((row.targetStock - row.onHand).toFixed(4)))
      : Number((row.committedDemand || row.targetStock || 0).toFixed(4));
    row.priority = forecastPriority(row.status, row.firstShortDate);
    return row;
  }).sort((a, b) => {
    const rank = { short: 0, warning: 1, unit_mismatch: 2, not_tracked: 3, ok: 4 };
    return (rank[a.status] ?? 9) - (rank[b.status] ?? 9)
      || String(a.firstShortDate || a.appointments[0]?.scheduledDate || '').localeCompare(String(b.firstShortDate || b.appointments[0]?.scheduledDate || ''))
      || a.productName.localeCompare(b.productName);
  });

  const statusCounts = products.reduce((acc, product) => {
    acc[product.status] = (acc[product.status] || 0) + 1;
    return acc;
  }, { ok: 0, warning: 0, short: 0, unit_mismatch: 0, not_tracked: 0 });

  return {
    startDate,
    endDate,
    days: safeDays,
    serviceCount: services.length,
    productCount: products.length,
    statusCounts,
    products,
    errors,
    generatedAt: new Date().toISOString(),
  };
}

// =========================================================================
// GET / — Dashboard: all products with pricing
// =========================================================================
router.get('/', async (req, res, next) => {
  try {
    const { search, category, needsPricing, stock, sort = 'name', page = 1, limit = 50 } = req.query;

    let query = db('products_catalog').orderBy(sort === 'price' ? 'best_price' : 'name');
    if (search) query = query.where(function () {
      this.whereILike('name', `%${search}%`).orWhereILike('active_ingredient', `%${search}%`);
    });
    if (category) query = query.where('category', category);
    if (needsPricing === 'true') query = query.where('needs_pricing', true);
    if (needsPricing === 'false') query = query.where(function () { this.where('needs_pricing', false).orWhere('best_price', '>', 0); });
    if (stock === 'low') {
      query = query
        .whereNotNull('inventory_on_hand')
        .whereNotNull('low_stock_threshold')
        .whereRaw('inventory_on_hand <= low_stock_threshold');
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const countQuery = query.clone().clearOrder().clearSelect().count('* as count');
    const products = await query.limit(parseInt(limit)).offset(offset);
    const [{ count: totalCount }] = await countQuery;

    // Vendor pricing for these products
    const productIds = products.map(p => p.id);
    const pricing = productIds.length ? await db('vendor_pricing')
      .whereIn('product_id', productIds)
      .join('vendors', 'vendor_pricing.vendor_id', 'vendors.id')
      .select('vendor_pricing.*', 'vendors.name as vendor_name')
      .orderBy('vendor_pricing.price') : [];

    const pricingMap = {};
    pricing.forEach(p => {
      if (!pricingMap[p.product_id]) pricingMap[p.product_id] = [];
    pricingMap[p.product_id].push({
      id: p.id, vendorId: p.vendor_id, vendorName: p.vendor_name,
      price: parseFloat(p.price || 0), quantity: p.quantity,
      url: p.vendor_product_url, isBest: p.is_best_price,
      lastChecked: p.last_checked_at, shippingCost: p.shipping_cost,
      taxRate: p.tax_rate, landedCost: p.landed_cost,
      pricePerOz: p.price_per_oz, vendorSku: p.vendor_sku,
      sourceType: p.source_type || 'manual',
      confidenceScore: p.confidence_score != null ? parseFloat(p.confidence_score) : null,
      availability: p.availability || null,
      branchLocation: p.branch_location || null,
      expiresAt: p.expires_at || null,
      normalizedUnitPrice: p.normalized_unit_price != null ? parseFloat(p.normalized_unit_price) : null,
      normalizedUnit: p.normalized_unit || p.unit_normalized || p.unit || null,
    });
  });

    // Stats
    const stats = await db('products_catalog').select(
      db.raw('COUNT(*) as total'),
      db.raw("COUNT(*) FILTER (WHERE needs_pricing = false) as priced"),
      db.raw("COUNT(*) FILTER (WHERE needs_pricing = true) as needs_price"),
      db.raw("AVG(best_price) FILTER (WHERE best_price > 0) as avg_price"),
    ).first();

    const categories = await db('products_catalog').select('category')
      .count('* as count').groupBy('category').orderBy('count', 'desc');

    // Pending approvals count (table may not exist yet)
    let pendingApprovals = 0;
    try {
      const [r] = await db('price_approvals').where({ status: 'pending' }).count('* as count');
      pendingApprovals = parseInt(r.count);
    } catch { /* table not created yet */ }

    res.json({
      products: products.map(p => mapProduct(p, pricingMap[p.id] || [])),
      stats: {
        total: parseInt(stats?.total || 0),
        priced: parseInt(stats?.priced || 0),
        needsPrice: parseInt(stats?.needs_price || 0),
        avgPrice: stats?.avg_price ? parseFloat(stats.avg_price).toFixed(2) : null,
        pendingApprovals,
      },
      categories: categories.map(c => ({ name: c.category, count: parseInt(c.count) })),
      total: parseInt(totalCount),
    });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /lawn-outline-facts — protocol product fact readiness for estimate packets
// =========================================================================
router.get('/lawn-outline-facts', async (req, res, next) => {
  try {
    const rows = [];
    for (const definition of LAWN_PROTOCOL_PRODUCT_DEFINITIONS) {
      const references = protocolProductReferences(definition);
      if (!references.length) continue;
      let product = null;
      for (const alias of definition.aliases) {
        product = await db('products_catalog')
          .whereILike('name', `%${alias}%`)
          .select(
            'id',
            'name',
            'category',
            'product_type',
            'manufacturer',
            'active_ingredient',
            'epa_reg_number',
            'customer_visibility',
            'content_status',
            'public_summary',
            'portal_summary',
            'customer_safety_summary',
            'customer_precaution_summary',
            'pet_kid_guidance_text',
            'reentry_text',
            'reentry_summary',
            'label_url',
            'label_source_url',
            'label_verified_at',
            'label_version',
            'approved_for_public_page',
            'approved_for_estimate_packet',
            'approved_for_service_report',
            'review_due_at',
            'updated_at',
          )
          .first();
        if (product) break;
      }
      const readiness = lawnFactReadiness(product);
      rows.push({
        key: definition.key,
        needle: definition.label,
        expectedType: definition.type,
        expectedCategory: definition.category,
        aliases: definition.aliases,
        references,
        referenceCount: references.length,
        turfTracks: [...new Set(references.map((ref) => ref.turf))],
        months: [...new Set(references.map((ref) => ref.month))],
        product: product ? mapProduct(product) : null,
        readiness,
        suggestedCopy: suggestedLawnFactCopy(definition, product),
      });
    }
    rows.sort((a, b) => rowPriority(a) - rowPriority(b) || b.referenceCount - a.referenceCount || a.needle.localeCompare(b.needle));
    const missingFields = {};
    for (const row of rows) {
      for (const item of row.readiness.missing || []) {
        missingFields[item] = (missingFields[item] || 0) + 1;
      }
    }
    const summary = rows.reduce((acc, row) => {
      acc.total += 1;
      acc[row.readiness.status] = (acc[row.readiness.status] || 0) + 1;
      return acc;
    }, { total: 0, approved: 0, ready_to_approve: 0, needs_facts: 0, missing_product: 0 });
    summary.missingFields = missingFields;
    res.json({ facts: rows, summary });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// PATCH /lawn-outline-facts/:id — update public fact fields and optionally approve
// =========================================================================
router.patch('/lawn-outline-facts/:id', async (req, res, next) => {
  try {
    const product = await db('products_catalog').where({ id: req.params.id }).first();
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const allowed = {
      productType: 'product_type',
      manufacturer: 'manufacturer',
      activeIngredient: 'active_ingredient',
      epaRegNumber: 'epa_reg_number',
      customerVisibility: 'customer_visibility',
      contentStatus: 'content_status',
      publicSummary: 'public_summary',
      portalSummary: 'portal_summary',
      customerSafetySummary: 'customer_safety_summary',
      customerPrecautionSummary: 'customer_precaution_summary',
      petKidGuidanceText: 'pet_kid_guidance_text',
      reentryText: 'reentry_text',
      reentrySummary: 'reentry_summary',
      labelUrl: 'label_url',
      labelSourceUrl: 'label_source_url',
      labelVerifiedAt: 'label_verified_at',
      labelVersion: 'label_version',
      serviceReportSummary: 'service_report_summary',
      heatRestrictions: 'heat_restrictions',
      irrigationNotes: 'irrigation_notes',
      localRuleSensitivity: 'local_rule_sensitivity',
    };
    const update = { updated_at: new Date() };
    for (const [camel, snake] of Object.entries(allowed)) {
      if (req.body[camel] !== undefined) update[snake] = req.body[camel] === '' ? null : req.body[camel];
    }
    if (!update.product_type) update.product_type = inferProductType({ ...product, ...update });

    const candidate = { ...product, ...update };
    const readiness = lawnFactReadiness(candidate);
    if (req.body.approve === true) {
      if (!readiness.eligible) {
        return res.status(422).json({
          error: 'Product fact is not ready for estimate-packet approval',
          readiness,
        });
      }
      update.approved_for_estimate_packet = true;
      update.approved_for_public_page = true;
      update.approved_for_service_report = true;
      update.approved_by = req.technicianId || null;
      update.approved_at = new Date();
    }
    const [updated] = await db('products_catalog')
      .where({ id: product.id })
      .update(update)
      .returning('*');
    res.json({
      product: mapProduct(updated),
      readiness: lawnFactReadiness(updated),
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /vendors — all vendors with scrape status
// =========================================================================
router.get('/vendors', async (req, res, next) => {
  try {
    const vendors = await db('vendors')
      .select('vendors.*',
        db.raw('(SELECT COUNT(*) FROM vendor_pricing WHERE vendor_pricing.vendor_id = vendors.id) as product_count'),
        db.raw('(SELECT COUNT(*) FROM vendor_pricing WHERE vendor_pricing.vendor_id = vendors.id AND is_best_price = true) as best_price_count'),
      )
      .orderBy('name');

    res.json({
      vendors: vendors.map(v => ({
        id: v.id, name: v.name, type: v.type, website: v.website,
        notes: v.notes, active: v.active,
        scrapingEnabled: v.price_scraping_enabled, scrapingPriority: v.scraping_priority,
        scrapeSchedule: v.scrape_schedule, lastScrapeAt: v.last_scrape_at,
        lastScrapeStatus: v.last_scrape_status, scrapeProductCount: v.scrape_product_count,
        syncMethod: v.sync_method || null, credentialStatus: v.credential_status || null,
        syncMethodNotes: v.sync_method_notes || null, syncFrequencyMinutes: v.sync_frequency_minutes || null,
        manualRefreshEnabled: v.manual_refresh_enabled !== false,
        loginUsername: v.login_username, loginEmail: v.login_email,
        loginUrl: v.login_url, accountNumber: v.account_number,
        hasCredentials: !!(v.login_username || v.login_email),
        productCount: parseInt(v.product_count || 0),
        bestPriceCount: parseInt(v.best_price_count || 0),
      })),
    });
  } catch (err) { next(err); }
});

// =========================================================================
// PUT /vendors/:id — update vendor info + credentials
// =========================================================================
router.put('/vendors/:id', async (req, res, next) => {
  try {
    const allowed = ['login_username', 'login_email', 'login_password_encrypted', 'account_number',
      'login_url', 'notes', 'website', 'scrape_schedule', 'price_scraping_enabled', 'scraping_priority', 'active'];
    const upd = { updated_at: new Date() };
    const body = req.body;

    // Map camelCase to snake_case
    const keyMap = { loginUsername: 'login_username', loginEmail: 'login_email', loginPassword: 'login_password_encrypted',
      accountNumber: 'account_number', loginUrl: 'login_url', scrapingEnabled: 'price_scraping_enabled',
      scrapingPriority: 'scraping_priority', scrapeSchedule: 'scrape_schedule',
      syncMethod: 'sync_method', credentialStatus: 'credential_status',
      syncMethodNotes: 'sync_method_notes', syncFrequencyMinutes: 'sync_frequency_minutes',
      manualRefreshEnabled: 'manual_refresh_enabled' };

    for (const [camel, snake] of Object.entries(keyMap)) {
      if (body[camel] !== undefined) upd[snake] = body[camel];
    }
    for (const key of ['notes', 'website', 'active']) {
      if (body[key] !== undefined) upd[key] = body[key];
    }

    await db('vendors').where({ id: req.params.id }).update(upd);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// Price Sync control layer — no connector execution in these endpoints
// =========================================================================
router.get('/price-sync/vendors', async (req, res, next) => {
  try {
    const vendors = await db('vendors as v')
      .leftJoin('vendor_connections as vc', 'vc.vendor_id', 'v.id')
      .select(
        'v.id',
        'v.name',
        'v.type',
        'v.active',
        'v.website',
        'v.login_url',
        'v.login_username',
        'v.login_email',
        'v.account_number',
        'v.credential_status as vendor_credential_status',
        'v.sync_method',
        'v.sync_method_notes',
        'vc.id as connection_id',
        'vc.connection_type',
        'vc.display_name',
        'vc.approval_status',
        'vc.credential_status',
        'vc.config_json',
        'vc.is_active',
        'vc.supports_account_pricing',
        'vc.supports_public_pricing',
        'vc.supports_inventory',
        'vc.supports_branch_availability',
        'vc.supports_bulk_pricing',
        'vc.last_success_at',
        'vc.last_failure_at',
        'vc.failure_reason',
        db.raw(`(
          SELECT COUNT(*)
          FROM distributor_product_map dpm
          WHERE dpm.vendor_id = v.id
            AND dpm.active = true
        ) as mapped_products`),
        db.raw(`(
          SELECT COUNT(*)
          FROM distributor_product_map dpm
          WHERE dpm.vendor_id = v.id
            AND dpm.active = true
            AND dpm.mapping_status = 'verified'
        ) as verified_mappings`),
        db.raw(`(
          SELECT COUNT(*)
          FROM vendor_pricing vp
          WHERE vp.vendor_id = v.id
            AND vp.is_active = true
            AND vp.approval_status IN ('approved', 'auto_approved')
        ) as current_prices`),
        db.raw(`(
          SELECT COUNT(*)
          FROM products_catalog pc
          WHERE pc.best_price_vendor_id_cached = v.id
        ) as best_prices`),
        db.raw(`(
          SELECT COUNT(*)
          FROM price_approval_events pae
          WHERE pae.vendor_id = v.id
            AND pae.approval_status = 'pending'
        ) as pending_approvals`),
      )
      .orderBy('v.name')
      .orderBy('vc.connection_type');

    const grouped = new Map();
    for (const row of vendors) {
      if (!grouped.has(row.id)) {
        grouped.set(row.id, {
          id: row.id,
          name: row.name,
          type: row.type,
          active: row.active,
          website: row.website,
          loginUrl: row.login_url,
          hasCredentials: Boolean(row.login_username || row.login_email || row.account_number),
          credentialStatus: row.vendor_credential_status || null,
          syncMethod: row.sync_method || null,
          syncMethodNotes: row.sync_method_notes || null,
          mappedProducts: Number(row.mapped_products || 0),
          verifiedMappings: Number(row.verified_mappings || 0),
          currentPrices: Number(row.current_prices || 0),
          bestPrices: Number(row.best_prices || 0),
          pendingApprovals: Number(row.pending_approvals || 0),
          nextAction: 'Needs mapping',
          loginDiscoveryNeeded: false,
          loginDiscoveryStatus: null,
          loginDiscoveryResult: null,
          connections: [],
        });
      }
      const vendor = grouped.get(row.id);
      if (row.connection_id) {
        const config = parseJsonObject(row.config_json, {});
        const loginDiscovery = config.loginDiscovery || null;
        const connection = {
          id: row.connection_id,
          type: row.connection_type,
          displayName: row.display_name || row.connection_type,
          approvalStatus: row.approval_status,
          credentialStatus: row.credential_status,
          isActive: row.is_active !== false,
          loginDiscovery,
          supportsAccountPricing: row.supports_account_pricing,
          supportsPublicPricing: row.supports_public_pricing,
          supportsInventory: row.supports_inventory,
          supportsBranchAvailability: row.supports_branch_availability,
          supportsBulkPricing: row.supports_bulk_pricing,
          lastSuccessAt: row.last_success_at,
          lastFailureAt: row.last_failure_at,
          failureReason: row.failure_reason,
        };
        vendor.connections.push(connection);
        if (connection.isActive && loginDiscovery?.status) {
          vendor.loginDiscoveryStatus = loginDiscovery.status;
          vendor.loginDiscoveryResult = loginDiscovery.outcome || loginDiscovery.result || null;
        }
      }
      if (vendor.verifiedMappings > 0 && vendor.currentPrices > 0) vendor.nextAction = 'Ready for manual seed review';
      else if (vendor.mappedProducts > 0 && vendor.verifiedMappings === 0) vendor.nextAction = 'Verify mappings';
      if (vendor.connections.some((c) => c.credentialStatus === 'missing' && ['api', 'approved_feed', 'portal_connector', 'workwave_marketplace'].includes(c.type))) {
        vendor.nextAction = 'Needs credentials/feed approval';
      }
    }

    for (const vendor of grouped.values()) {
      const loginDiscoveryConnections = vendor.connections.map((connection) => ({
        is_active: connection.isActive,
        connection_type: connection.type,
        credential_status: connection.credentialStatus,
        loginDiscovery: connection.loginDiscovery,
      }));
      vendor.loginDiscoveryNeeded = vendorNeedsLoginDiscovery({
        id: vendor.id,
        type: vendor.type,
        active: vendor.active,
        login_url: vendor.loginUrl,
        login_username: vendor.hasCredentials ? 'configured' : null,
        credential_status: vendor.credentialStatus,
        sync_method: vendor.syncMethod,
      }, loginDiscoveryConnections);
    }

    res.json({ vendors: Array.from(grouped.values()) });
  } catch (err) { next(err); }
});

router.post('/price-sync/hermes-login-discovery', async (req, res, next) => {
  try {
    if (!(await db.schema.hasTable('vendor_connections'))) {
      return res.status(404).json({ error: 'Vendor connection table is not available. Run database migrations first.' });
    }

    const limit = parseBoundedInt(req.body?.limit, 50, 1, 200);
    const includePublic = req.body?.includePublic === true;
    const retryTerminal = req.body?.retryTerminal === true;
    const requestedBy = req.adminUser?.id || req.adminUser?.email || req.adminUser?.name || 'admin';

    const vendors = await db('vendors')
      .where(function activeVendors() {
        this.where('active', true).orWhereNull('active');
      })
      .where(function notCompetitorReference() {
        this.whereNull('type').orWhereNot('type', 'competitor_reference');
      })
      .orderByRaw(`
        CASE
          WHEN credential_status IN ('needs_login', 'needs_rep_setup', 'needs_api_key', 'missing', 'failed', 'expired') THEN 0
          WHEN login_url IS NULL THEN 1
          ELSE 2
        END
      `)
      .orderBy('name');

    const vendorIds = vendors.map((vendor) => vendor.id);
    const connectionRows = vendorIds.length
      ? await db('vendor_connections').whereIn('vendor_id', vendorIds)
      : [];
    const connectionsByVendor = new Map();
    for (const connection of connectionRows) {
      const key = String(connection.vendor_id);
      if (!connectionsByVendor.has(key)) connectionsByVendor.set(key, []);
      connectionsByVendor.get(key).push(connection);
    }

    let queued = 0;
    let duplicates = 0;
    const jobs = [];
    const candidates = [];
    for (const vendor of vendors) {
      const connections = connectionsByVendor.get(String(vendor.id)) || [];
      if (!vendorNeedsLoginDiscovery(vendor, connections, includePublic, { retryTerminal })) continue;
      const openConnection = findOpenLoginDiscoveryConnection(connections);
      if (openConnection) {
        const existing = loginDiscoveryFromConnection(openConnection) || {};
        duplicates += 1;
        jobs.push({
          vendorId: vendor.id,
          vendorName: vendor.name,
          connectionId: openConnection.id,
          status: existing.status,
          duplicate: true,
        });
        continue;
      }
      candidates.push(vendor);
      if (candidates.length >= limit) break;
    }

    await db.transaction(async (trx) => {
      for (const vendor of candidates) {
        const connection = await ensureLoginDiscoveryConnection(trx, vendor);
        const config = parseJsonObject(connection.config_json, {});
        const existing = config.loginDiscovery || {};
        if (isOpenLoginDiscoveryJob(existing)) {
          duplicates += 1;
          jobs.push({
            vendorId: vendor.id,
            vendorName: vendor.name,
            connectionId: connection.id,
            status: existing.status,
            duplicate: true,
          });
          continue;
        }

        const loginDiscovery = {
          status: 'queued',
          requestedAt: new Date().toISOString(),
          requestedBy,
          source: 'admin_inventory_price_sync',
        };
        await trx('vendor_connections').where({ id: connection.id }).update({
          approval_status: connection.approval_status === 'approved' ? 'approved' : 'requested',
          credential_status: connection.credential_status === 'configured' ? 'configured' : 'missing',
          config_json: JSON.stringify({
            ...config,
            loginDiscovery,
          }),
          failure_reason: null,
          updated_at: new Date(),
        });

        const nextCredentialStatus = vendorCredentialStatusWhileQueued(vendor.credential_status);
        await trx('vendors').where({ id: vendor.id }).update({
          credential_status: nextCredentialStatus,
          updated_at: new Date(),
        });

        queued += 1;
        jobs.push({
          vendorId: vendor.id,
          vendorName: vendor.name,
          connectionId: connection.id,
          connectionType: connection.connection_type,
          status: 'queued',
        });
      }
    });

    res.status(202).json({
      success: true,
      queued,
      duplicates,
      candidateCount: candidates.length,
      jobs,
      message: queued
        ? `Queued ${queued} vendor login discovery job${queued === 1 ? '' : 's'} for Hermes.`
        : 'No new vendor login discovery jobs needed.',
    });
  } catch (err) { next(err); }
});

router.get('/price-sync/needs-mapping', async (req, res, next) => {
  try {
    const rows = await db('products_catalog as pc')
      .leftJoin('distributor_product_map as dpm', function joinMaps() {
        this.on('dpm.product_id', '=', 'pc.id').andOn('dpm.active', '=', db.raw('true'));
      })
      .where(function activeProducts() {
        this.where('pc.active', true).orWhereNull('pc.active');
      })
      .groupBy('pc.id')
      .select(
        'pc.id',
        'pc.name',
        'pc.category',
        'pc.sku',
        'pc.container_size',
        'pc.epa_reg_number',
        'pc.best_price_status',
        'pc.best_price_updated_at',
        db.raw('COUNT(dpm.id) as mapped_vendors'),
        db.raw("COUNT(dpm.id) FILTER (WHERE dpm.mapping_status = 'verified') as verified_mappings"),
        db.raw("COUNT(dpm.id) FILTER (WHERE dpm.package_size_value IS NOT NULL AND dpm.package_size_unit IS NOT NULL AND dpm.purchase_uom IS NOT NULL) as complete_package_maps"),
      )
      .havingRaw("COUNT(dpm.id) FILTER (WHERE dpm.mapping_status = 'verified') = 0")
      .orderBy('pc.name');

    res.json({
      products: rows.map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category,
        sku: row.sku,
        containerSize: row.container_size,
        epaRegNumber: row.epa_reg_number,
        bestPriceStatus: row.best_price_status,
        bestPriceUpdatedAt: row.best_price_updated_at,
        mappedVendors: Number(row.mapped_vendors || 0),
        verifiedMappings: Number(row.verified_mappings || 0),
        completePackageMaps: Number(row.complete_package_maps || 0),
      })),
    });
  } catch (err) { next(err); }
});

router.get('/price-sync/mappings/export', async (req, res, next) => {
  try {
    const mode = String(req.query.mode || 'needs_mapping');
    const headers = [
      'internal_product_id',
      'internal_product_name',
      'vendor_id',
      'vendor_name',
      'vendor_connection_id',
      'connection_type',
      'vendor_sku',
      'product_url',
      'vendor_product_name',
      'manufacturer',
      'manufacturer_sku',
      'upc',
      'asin',
      'epa_registration_number',
      'package_size_value',
      'package_size_unit',
      'purchase_uom',
      'content_quantity',
      'content_uom',
      'case_quantity',
      'pack_count',
      'branch_id',
      'branch_name',
      'mapping_status',
      'mapping_confidence',
      'verified',
      'notes',
    ];

    let rows = [];
    if (mode === 'existing') {
      const mappings = await db('distributor_product_map as dpm')
        .join('products_catalog as pc', 'pc.id', 'dpm.product_id')
        .join('vendors as v', 'v.id', 'dpm.vendor_id')
        .leftJoin('vendor_connections as vc', 'vc.id', 'dpm.vendor_connection_id')
        .select('dpm.*', 'pc.name as product_name', 'v.name as vendor_name', 'vc.connection_type');
      rows = mappings.map((m) => ({
        internal_product_id: m.product_id,
        internal_product_name: m.product_name,
        vendor_id: m.vendor_id,
        vendor_name: m.vendor_name,
        vendor_connection_id: m.vendor_connection_id,
        connection_type: m.connection_type,
        vendor_sku: m.distributor_sku,
        product_url: m.product_url || m.source_url,
        vendor_product_name: m.vendor_product_name,
        manufacturer: '',
        manufacturer_sku: m.manufacturer_sku,
        upc: m.upc,
        asin: m.asin,
        epa_registration_number: m.epa_registration_number,
        package_size_value: m.package_size_value,
        package_size_unit: m.package_size_unit,
        purchase_uom: m.purchase_uom,
        content_quantity: m.content_quantity,
        content_uom: m.content_uom,
        case_quantity: m.case_quantity,
        pack_count: m.pack_count,
        branch_id: m.branch_id,
        branch_name: m.branch_name,
        mapping_status: m.mapping_status,
        mapping_confidence: m.mapping_confidence,
        verified: m.mapping_status === 'verified' ? 'true' : 'false',
        notes: m.notes,
      }));
    } else {
      const vendorId = cleanString(req.query.vendorId);
      const connectionType = cleanString(req.query.connectionType);
      let defaultVendor = null;
      if (vendorId) {
        defaultVendor = await db('vendors as v')
          .leftJoin('vendor_connections as vc', function joinConnection() {
            this.on('vc.vendor_id', '=', 'v.id');
            if (connectionType) this.andOn('vc.connection_type', '=', db.raw('?', [connectionType]));
          })
          .where('v.id', vendorId)
          .select('v.id as vendor_id', 'v.name as vendor_name', 'vc.id as connection_id', 'vc.connection_type')
          .first();
      }

      const products = await db('products_catalog as pc')
        .leftJoin('distributor_product_map as dpm', function joinMaps() {
          this.on('dpm.product_id', '=', 'pc.id')
            .andOn('dpm.active', '=', db.raw('true'))
            .andOn('dpm.mapping_status', '=', db.raw('?', ['verified']));
        })
        .where(function activeProducts() {
          this.where('pc.active', true).orWhereNull('pc.active');
        })
        .whereNull('dpm.id')
        .select('pc.id', 'pc.name', 'pc.category', 'pc.sku', 'pc.container_size', 'pc.epa_reg_number')
        .orderBy('pc.name');
      rows = products.map((p) => ({
        internal_product_id: p.id,
        internal_product_name: p.name,
        vendor_id: defaultVendor?.vendor_id || '',
        vendor_name: defaultVendor?.vendor_name || '',
        vendor_connection_id: defaultVendor?.connection_id || '',
        connection_type: defaultVendor?.connection_type || '',
        vendor_sku: '',
        product_url: '',
        vendor_product_name: '',
        manufacturer: '',
        manufacturer_sku: '',
        upc: '',
        asin: '',
        epa_registration_number: p.epa_reg_number || '',
        package_size_value: '',
        package_size_unit: '',
        purchase_uom: '',
        content_quantity: '',
        content_uom: '',
        case_quantity: 1,
        pack_count: 1,
        branch_id: '',
        branch_name: '',
        mapping_status: 'needs_mapping',
        mapping_confidence: 0,
        verified: 'false',
        notes: '',
      }));
    }

    res.json({ filename: `${mode}_mappings.csv`, csv: rowsToCsv(headers, rows) });
  } catch (err) { next(err); }
});

router.get('/price-sync/manual-seed-template', async (req, res) => {
  const headers = [
    'internal_product_id',
    'vendor_id',
    'vendor_connection_id',
    'distributor_product_map_id',
    'price_amount',
    'currency',
    'price_type',
    'source_type',
    'availability_status',
    'branch_id',
    'branch_name',
    'normalized_unit_price',
    'landed_unit_price',
    'expires_at',
    'confidence_score',
    'notes',
  ];
  res.json({ filename: 'manual_seed_price_template.csv', csv: rowsToCsv(headers, []) });
});

router.post('/price-sync/mappings/import', async (req, res, next) => {
  try {
    const rows = parseMappingRows(req.body);
    const rowErrors = [];
    const imported = [];
    const skipped = [];
    const adminId = req.adminUser?.id || req.adminUser?.email || req.adminUser?.name || 'admin';

    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 1;
      const productId = cleanString(row.internal_product_id || row.product_id);
      const vendorId = cleanString(row.vendor_id);
      const vendorConnectionId = cleanString(row.vendor_connection_id);
      const verified = truthy(row.verified) || cleanString(row.mapping_status) === 'verified';
      const requestedStatus = cleanString(row.mapping_status) || (verified ? 'verified' : 'mapped_unverified');
      const mappingStatus = verified ? 'verified' : requestedStatus;
      const errors = [];

      if (!productId) errors.push('internal_product_id is required');
      if (!vendorId) errors.push('vendor_id is required');
      if (verified && !vendorConnectionId) errors.push('vendor_connection_id is required for verified mappings');

      const identifiers = [
        cleanString(row.vendor_sku),
        cleanString(row.product_url),
        cleanString(row.manufacturer_sku),
        cleanString(row.upc),
        cleanString(row.asin),
      ].filter(Boolean);
      if (!identifiers.length) errors.push('At least one identifier is required: vendor_sku, product_url, manufacturer_sku, upc, or asin');

      const packageSize = parseDecimalOrNull(row.package_size_value);
      const packageSizeUnit = cleanString(row.package_size_unit);
      const purchaseUom = cleanString(row.purchase_uom);
      if (verified) {
        if (packageSize == null) errors.push('package_size_value is required for verified mappings');
        if (!packageSizeUnit) errors.push('package_size_unit is required for verified mappings');
        if (!purchaseUom) errors.push('purchase_uom is required for verified mappings');
      }

      const requestedConfidence = parseDecimalOrNull(row.mapping_confidence);
      const confidenceCap = calculateMappingConfidenceCap(row, verified);
      const mappingConfidence = Math.min(
        requestedConfidence == null ? (verified ? 0.90 : 0.50) : requestedConfidence,
        confidenceCap,
      );

      if (mappingConfidence < 0 || mappingConfidence > 1) errors.push('mapping_confidence must be between 0 and 1');
      if (verified && mappingConfidence < 0.80) errors.push('verified mappings require confidence >= 0.80 after server-side caps');
      if (!['needs_mapping', 'mapped_unverified', 'verified', 'rejected', 'inactive'].includes(mappingStatus)) {
        errors.push(`Invalid mapping_status: ${mappingStatus}`);
      }

      if (errors.length) {
        rowErrors.push({ row: rowNumber, productId, vendorId, errors });
        continue;
      }

      const [product, vendor, connection] = await Promise.all([
        db('products_catalog').where({ id: productId }).first(),
        db('vendors').where({ id: vendorId }).first(),
        vendorConnectionId ? db('vendor_connections').where({ id: vendorConnectionId, vendor_id: vendorId }).first() : null,
      ]);
      if (!product) errors.push('Product not found');
      if (!vendor) errors.push('Vendor not found');
      if (vendorConnectionId && !connection) errors.push('Vendor connection not found for vendor');
      if (verified && !connection) errors.push('Verified mapping requires a valid vendor connection');
      if (errors.length) {
        rowErrors.push({ row: rowNumber, productId, vendorId, errors });
        continue;
      }

      const data = {
        product_id: productId,
        vendor_id: vendorId,
        vendor_connection_id: vendorConnectionId || null,
        distributor_sku: cleanString(row.vendor_sku),
        product_url: cleanString(row.product_url),
        source_url: cleanString(row.product_url),
        vendor_product_name: cleanString(row.vendor_product_name),
        manufacturer_sku: cleanString(row.manufacturer_sku),
        upc: cleanString(row.upc),
        asin: cleanString(row.asin),
        epa_registration_number: cleanString(row.epa_registration_number),
        package_size_value: packageSize,
        package_size_unit: packageSizeUnit,
        purchase_uom: purchaseUom,
        content_quantity: parseDecimalOrNull(row.content_quantity),
        content_uom: cleanString(row.content_uom),
        case_quantity: parseDecimalOrNull(row.case_quantity) ?? 1,
        pack_count: parseDecimalOrNull(row.pack_count) ?? 1,
        branch_id: cleanString(row.branch_id),
        branch_name: cleanString(row.branch_name),
        mapping_status: mappingStatus,
        mapping_confidence: mappingConfidence,
        verified_by: verified ? adminId : null,
        verified_at: verified ? new Date() : null,
        notes: cleanString(row.notes),
        active: mappingStatus !== 'inactive',
        updated_at: new Date(),
      };

      const existingQuery = db('distributor_product_map')
        .where({ product_id: productId, vendor_id: vendorId })
        .modify((query) => {
          if (data.distributor_sku) query.where({ distributor_sku: data.distributor_sku });
          else if (data.product_url) query.where(function byUrl() {
            this.where({ product_url: data.product_url }).orWhere({ source_url: data.product_url });
          });
          else if (data.manufacturer_sku) query.where({ manufacturer_sku: data.manufacturer_sku });
          else if (data.upc) query.where({ upc: data.upc });
          else if (data.asin) query.where({ asin: data.asin });
        });
      const existing = await existingQuery.first();

      if (existing) {
        await db('distributor_product_map').where({ id: existing.id }).update(data);
        imported.push({ row: rowNumber, id: existing.id, action: 'updated', confidence: mappingConfidence });
      } else {
        const [inserted] = await db('distributor_product_map').insert({
          ...data,
          created_at: new Date(),
        }).returning('id');
        imported.push({ row: rowNumber, id: inserted?.id || inserted, action: 'created', confidence: mappingConfidence });
      }
    }

    res.json({
      accepted: rowErrors.length === 0,
      rowsReceived: rows.length,
      imported: imported.length,
      skipped: skipped.length,
      rowErrors,
      results: imported,
      message: `${imported.length} mapping row${imported.length === 1 ? '' : 's'} imported. ${rowErrors.length} row${rowErrors.length === 1 ? '' : 's'} rejected.`,
    });
  } catch (err) { next(err); }
});

router.post('/price-sync/manual-seed/import', async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  res.status(202).json({
    accepted: false,
    rowsReceived: rows.length,
    message: 'Manual seed import endpoint is reserved for the seed import worker. No prices were written in this control-layer build.',
    rowErrors: rows.map((_, index) => ({ row: index + 1, error: 'Import worker not enabled yet' })),
  });
});

router.get('/price-sync/review-queue', async (req, res, next) => {
  try {
    const rows = await db('price_approval_events as pae')
      .join('products_catalog as pc', 'pc.id', 'pae.product_id')
      .join('vendors as v', 'v.id', 'pae.vendor_id')
      .leftJoin('price_snapshots as ps', 'ps.id', 'pae.snapshot_id')
      .where('pae.approval_status', req.query.status || 'pending')
      .select(
        'pae.*',
        'pc.name as product_name',
        'v.name as vendor_name',
        'ps.source_type',
        'ps.price_confidence',
        'ps.captured_at',
      )
      .orderBy('pae.created_at', 'desc')
      .limit(Number(req.query.limit || 100));

    res.json({
      approvals: rows.map((row) => ({
        id: row.id,
        productId: row.product_id,
        productName: row.product_name,
        vendorId: row.vendor_id,
        vendorName: row.vendor_name,
        oldPrice: row.old_price_amount != null ? Number(row.old_price_amount) : null,
        newPrice: row.new_price_amount != null ? Number(row.new_price_amount) : null,
        changeAmount: row.change_amount != null ? Number(row.change_amount) : null,
        changePercent: row.change_percent != null ? Number(row.change_percent) : null,
        approvalStatus: row.approval_status,
        approvalReason: row.approval_reason,
        sourceType: row.source_type,
        confidence: row.price_confidence != null ? Number(row.price_confidence) : null,
        capturedAt: row.captured_at,
        createdAt: row.created_at,
      })),
    });
  } catch (err) { next(err); }
});

router.post('/price-sync/review-queue/:id/approve', async (req, res, next) => {
  try {
    const approval = await db('price_approval_events').where({ id: req.params.id }).first();
    if (!approval) return res.status(404).json({ error: 'Approval event not found' });
    await db.transaction(async (trx) => {
      const approvedBy = req.adminUser?.id || req.adminUser?.email || req.adminUser?.name || 'admin';
      const snapshot = approval.snapshot_id
        ? await trx('price_snapshots').where({ id: approval.snapshot_id }).first()
        : null;
      const vendorPricingId = approval.vendor_pricing_id || snapshot?.vendor_pricing_id || null;

      await trx('price_approval_events').where({ id: req.params.id }).update({
        approval_status: 'approved',
        approved_by: approvedBy,
        approved_at: new Date(),
      });

      if (approval.snapshot_id) {
        await trx('price_snapshots').where({ id: approval.snapshot_id }).update({
          requires_approval: false,
          approval_reason: null,
        }).catch(() => {});
      }

      if (vendorPricingId) {
        const pricingUpdate = {
          approval_status: 'approved',
          is_active: true,
          last_checked_at: snapshot?.captured_at || snapshot?.fetched_at || new Date(),
        };
        if (approval.snapshot_id) pricingUpdate.latest_snapshot_id = approval.snapshot_id;
        if (snapshot?.price_amount != null) pricingUpdate.price_amount = snapshot.price_amount;
        if (snapshot?.price != null) pricingUpdate.price = snapshot.price;
        if (snapshot?.normalized_unit_price != null) pricingUpdate.normalized_unit_price = snapshot.normalized_unit_price;
        if (snapshot?.landed_unit_price != null) pricingUpdate.landed_unit_price = snapshot.landed_unit_price;
        if (snapshot?.source_type) pricingUpdate.source_type = snapshot.source_type;
        if (snapshot?.price_type) pricingUpdate.price_type = snapshot.price_type;
        if (snapshot?.price_confidence != null) pricingUpdate.price_confidence = snapshot.price_confidence;
        if (snapshot?.source_confidence != null) pricingUpdate.source_confidence = snapshot.source_confidence;

        await trx('vendor_pricing').where({ id: vendorPricingId }).update(pricingUpdate);

        const best = await trx('vendor_pricing as vp')
          .join('vendors as v', 'v.id', 'vp.vendor_id')
          .where('vp.product_id', approval.product_id)
          .where('vp.is_active', true)
          .whereIn('vp.approval_status', ['approved', 'auto_approved'])
          .where(function pricedOnly() {
            this.whereNotNull('vp.price_amount').orWhereNotNull('vp.price');
          })
          .select('vp.*', 'v.name as vendor_name')
          .orderByRaw('COALESCE(vp.landed_unit_price, vp.normalized_unit_price, vp.price_amount, vp.price) ASC')
          .first();
        if (best) {
          await trx('vendor_pricing').where({ product_id: approval.product_id }).update({ is_best_price: false }).catch(() => {});
          await trx('vendor_pricing').where({ id: best.id }).update({ is_best_price: true }).catch(() => {});
          await trx('products_catalog').where({ id: approval.product_id }).update({
            best_vendor_pricing_id: best.id,
            best_price_amount_cached: best.price_amount || best.price,
            best_price_vendor_id_cached: best.vendor_id,
            best_price_updated_at: new Date(),
            best_price_status: 'current',
            best_price: best.price || best.price_amount,
            best_vendor: best.vendor_name,
            needs_pricing: false,
          });
        }
      }
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.post('/price-sync/review-queue/:id/reject', async (req, res, next) => {
  try {
    const approval = await db('price_approval_events').where({ id: req.params.id }).first();
    if (!approval) return res.status(404).json({ error: 'Approval event not found' });
    await db('price_approval_events').where({ id: req.params.id }).update({
      approval_status: 'rejected',
      rejected_by: req.adminUser?.id || req.adminUser?.email || req.adminUser?.name || 'admin',
      rejected_at: new Date(),
      approval_reason: req.body?.reason || approval.approval_reason,
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// PUT /:productId/pricing — add/update a vendor price (manual entry)
// =========================================================================
router.put('/:productId/pricing', async (req, res, next) => {
  try {
    const {
      vendorId,
      price,
      quantity,
      url,
      shippingCost,
      taxRate,
      sourceType = 'manual',
      confidenceScore,
      availability,
      branchLocation,
      expiresAt,
    } = req.body;
    const productId = req.params.productId;
    const sizeOz = normalizeQuantityToOz(quantity);
    const landed = calcLandedCost(price, shippingCost, taxRate);
    const perOz = sizeOz ? Math.round(parseFloat(price) / sizeOz * 10000) / 10000 : null;
    const landedPerOz = sizeOz && landed != null ? Math.round(landed / sizeOz * 10000) / 10000 : perOz;
    const confidence = numberOrNull(confidenceScore);
    const priceConfidence = confidence ?? 0.80;
    const availabilityStatus = normalizeAvailabilityStatus(availability);
    const controlLayerPriceFields = {
      price_amount: price,
      price_type: 'manual',
      approval_status: 'approved',
      currency: 'USD',
      source_type: sourceType,
      source_confidence: 0.75,
      price_confidence: priceConfidence,
      is_active: true,
      availability_status: availabilityStatus || 'unknown',
      branch_name: branchLocation || null,
      shipping_estimate: shippingCost || null,
      landed_unit_price: landedPerOz,
    };

    const existing = await db('vendor_pricing').where({ product_id: productId, vendor_id: vendorId }).first();

    if (existing) {
      // Record history (table may not exist yet)
      try { await db('price_history').insert({ product_id: productId, vendor_id: vendorId, price: existing.price, quantity: existing.quantity, source: 'manual' }); } catch { /* migration pending */ }

      // Update — use only columns that exist
      const upd = {
        previous_price: existing.price,
        price,
        quantity,
        vendor_product_url: url,
        last_checked_at: db.fn.now(),
      };
      try {
        await db('vendor_pricing').where({ id: existing.id }).update({
          ...upd,
          shipping_cost: shippingCost || null,
          tax_rate: taxRate || null,
          landed_cost: landed,
          unit_normalized: sizeOz ? 'oz' : null,
          price_per_oz: perOz,
          normalized_unit_price: perOz,
          ...controlLayerPriceFields,
          source_type: sourceType,
          confidence_score: confidence,
          availability: availability || null,
          branch_location: branchLocation || null,
          expires_at: expiresAt || null,
        });
      }
      catch { await db('vendor_pricing').where({ id: existing.id }).update(upd); }
    } else {
      const ins = { product_id: productId, vendor_id: vendorId, price, quantity, vendor_product_url: url, last_checked_at: db.fn.now() };
      try {
        await db('vendor_pricing').insert({
          ...ins,
          shipping_cost: shippingCost || null,
          tax_rate: taxRate || null,
          landed_cost: landed,
          unit_normalized: sizeOz ? 'oz' : null,
          price_per_oz: perOz,
          normalized_unit_price: perOz,
          ...controlLayerPriceFields,
          source_type: sourceType,
          confidence_score: confidence,
          availability: availability || null,
          branch_location: branchLocation || null,
          expires_at: expiresAt || null,
        });
      }
      catch { await db('vendor_pricing').insert(ins); }

      try { await db('price_history').insert({ product_id: productId, vendor_id: vendorId, price, quantity, source: 'manual' }); } catch { /* migration pending */ }
    }

    try {
      const current = await db('vendor_pricing').where({ product_id: productId, vendor_id: vendorId }).first();
      const [snapshot] = await db('price_snapshots').insert({
        product_id: productId,
        vendor_id: vendorId,
        vendor_pricing_id: current?.id || null,
        price,
        price_amount: price,
        quantity,
        uom: current?.unit || null,
        normalized_unit_price: perOz,
        normalized_unit: sizeOz ? 'oz' : null,
        availability: availability || null,
        availability_status: availabilityStatus || 'unknown',
        branch_location: branchLocation || null,
        branch_name: branchLocation || null,
        shipping_estimate: shippingCost || null,
        landed_unit_price: landedPerOz,
        fetched_at: db.fn.now(),
        captured_at: db.fn.now(),
        expires_at: expiresAt || null,
        source_type: sourceType,
        price_type: 'manual',
        confidence_score: confidence || 0.80,
        source_confidence: 0.75,
        price_confidence: priceConfidence,
        source_url: url || null,
        metadata: {
          source: 'admin_inventory_manual_price',
          enteredBy: req.adminUser?.id || req.adminUser?.email || req.adminUser?.name || null,
        },
      }).returning('id');
      const snapshotId = snapshot?.id || snapshot;
      if (current?.id && snapshotId) {
        await db('vendor_pricing').where({ id: current.id }).update({ latest_snapshot_id: snapshotId }).catch(() => {});
      }
    } catch { /* snapshot table may not exist on older installs */ }

    // Recalculate best price
    await recalcBestPrice(productId);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:productId/pricing/refresh — queue an on-demand price refresh request
router.post('/:productId/pricing/refresh', async (req, res, next) => {
  try {
    const { vendorId, notes } = req.body;
    if (!vendorId) return res.status(400).json({ error: 'vendorId required' });

    const [product, vendor] = await Promise.all([
      db('products_catalog').where({ id: req.params.productId }).first(),
      db('vendors').where({ id: vendorId }).first(),
    ]);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    const sourceType = vendor.sync_method || (vendor.price_scraping_enabled ? 'public_scraper' : 'manual');
    let request = null;
    try {
      [request] = await db('price_refresh_requests').insert({
        product_id: product.id,
        vendor_id: vendor.id,
        source_type: sourceType,
        notes: notes || null,
        requested_by: req.adminUser?.id || req.adminUser?.email || req.adminUser?.name || null,
        metadata: {
          productName: product.name,
          vendorName: vendor.name,
          syncMethod: vendor.sync_method || null,
          credentialStatus: vendor.credential_status || null,
        },
      }).returning('*');
    } catch {
      // Older installs may not have the queue table yet.
    }

    res.status(202).json({
      success: true,
      request,
      message: `${vendor.name} refresh queued for ${product.name}`,
      actionRequired: ['portal_connector', 'approved_feed', 'approved_integration', 'api'].includes(sourceType)
        ? 'Connector credentials/feed setup may be required before this can run automatically.'
        : null,
    });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /approvals — pending price approvals queue
// =========================================================================
router.get('/approvals', async (req, res, next) => {
  try {
    const { status = 'pending', limit = 50, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = db('price_approvals')
      .join('products_catalog', 'price_approvals.product_id', 'products_catalog.id')
      .join('vendors', 'price_approvals.vendor_id', 'vendors.id')
      .select('price_approvals.*', 'products_catalog.name as product_name',
        'products_catalog.category', 'vendors.name as vendor_name')
      .orderBy('price_approvals.created_at', 'desc');

    if (status !== 'all') query = query.where('price_approvals.status', status);

    const approvals = await query.limit(parseInt(limit)).offset(offset);
    const [{ count: total }] = await db('price_approvals')
      .where(status !== 'all' ? { status } : {}).count('* as count');

    res.json({ approvals, total: parseInt(total), page: parseInt(page) });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /approvals/:id/approve — approve a price change
// =========================================================================
router.post('/approvals/:id/approve', async (req, res, next) => {
  try {
    const approval = await db('price_approvals').where({ id: req.params.id }).first();
    if (!approval) return res.status(404).json({ error: 'Not found' });
    if (approval.status !== 'pending') return res.status(400).json({ error: `Already ${approval.status}` });

    // Apply the new price
    const existing = await db('vendor_pricing')
      .where({ product_id: approval.product_id, vendor_id: approval.vendor_id }).first();

    if (existing) {
      await db('vendor_pricing').where({ id: existing.id }).update({
        previous_price: existing.price, price: approval.new_price,
        quantity: approval.new_quantity || existing.quantity,
        last_checked_at: db.fn.now(),
      });
    } else {
      await db('vendor_pricing').insert({
        product_id: approval.product_id, vendor_id: approval.vendor_id,
        price: approval.new_price, quantity: approval.new_quantity,
        vendor_product_url: approval.source_url, last_checked_at: db.fn.now(),
      });
    }

    // Record history
    await db('price_history').insert({
      product_id: approval.product_id, vendor_id: approval.vendor_id,
      price: approval.new_price, quantity: approval.new_quantity, source: 'scrape_approved',
    });

    await db('price_approvals').where({ id: req.params.id }).update({
      status: 'approved', reviewed_by: req.adminUser?.name || 'admin', reviewed_at: new Date(),
    });

    await recalcBestPrice(approval.product_id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /approvals/:id/reject — reject a price change
// =========================================================================
router.post('/approvals/:id/reject', async (req, res, next) => {
  try {
    await db('price_approvals').where({ id: req.params.id }).update({
      status: 'rejected', reviewed_by: req.adminUser?.name || 'admin',
      reviewed_at: new Date(), notes: req.body.notes || null,
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /approvals/bulk — bulk approve or reject
// =========================================================================
router.post('/approvals/bulk', async (req, res, next) => {
  try {
    const { ids, action } = req.body; // action: 'approve' or 'reject'
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'action must be approve or reject' });

    let processed = 0;
    for (const id of ids) {
      try {
        if (action === 'approve') {
          const approval = await db('price_approvals').where({ id, status: 'pending' }).first();
          if (!approval) continue;
          const existing = await db('vendor_pricing')
            .where({ product_id: approval.product_id, vendor_id: approval.vendor_id }).first();
          if (existing) {
            await db('vendor_pricing').where({ id: existing.id }).update({
              previous_price: existing.price, price: approval.new_price, last_checked_at: db.fn.now(),
            });
          } else {
            await db('vendor_pricing').insert({
              product_id: approval.product_id, vendor_id: approval.vendor_id,
              price: approval.new_price, last_checked_at: db.fn.now(),
            });
          }
          await db('price_history').insert({
            product_id: approval.product_id, vendor_id: approval.vendor_id,
            price: approval.new_price, source: 'scrape_approved',
          });
          await recalcBestPrice(approval.product_id);
        }
        await db('price_approvals').where({ id }).update({
          status: action === 'approve' ? 'approved' : 'rejected',
          reviewed_by: req.adminUser?.name || 'admin', reviewed_at: new Date(),
        });
        processed++;
      } catch { /* skip individual failures */ }
    }
    res.json({ success: true, processed });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /price-history/:productId — price history for a product
// =========================================================================
router.get('/price-history/:productId', async (req, res, next) => {
  try {
    const history = await db('price_history')
      .where({ product_id: req.params.productId })
      .join('vendors', 'price_history.vendor_id', 'vendors.id')
      .select('price_history.*', 'vendors.name as vendor_name')
      .orderBy('recorded_at', 'desc')
      .limit(100);
    res.json({ history });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /:productId/movements — inventory movement history for a product
// =========================================================================
router.get('/:productId/movements', async (req, res, next) => {
  try {
    const product = await db('products_catalog').where({ id: req.params.productId }).first();
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const rows = await db('product_inventory_movements as pim')
      .leftJoin('service_records as sr', 'pim.service_record_id', 'sr.id')
      .leftJoin('scheduled_services as ss', 'pim.scheduled_service_id', 'ss.id')
      .leftJoin('customers as c', 'pim.customer_id', 'c.id')
      .leftJoin('technicians as t', 'pim.technician_id', 't.id')
      .where('pim.product_id', req.params.productId)
      .select(
        'pim.*',
        'sr.service_date',
        'sr.service_type',
        'ss.scheduled_date',
        'c.first_name',
        'c.last_name',
        't.name as technician_name'
      )
      .orderBy('pim.created_at', 'desc')
      .limit(Math.min(parseInt(req.query.limit || '100'), 250));

    res.json({
      movements: rows.map(r => ({
        id: r.id,
        productId: r.product_id,
        serviceRecordId: r.service_record_id,
        serviceProductId: r.service_product_id,
        scheduledServiceId: r.scheduled_service_id,
        customerId: r.customer_id,
        customerName: `${r.first_name || ''} ${r.last_name || ''}`.trim() || null,
        technicianId: r.technician_id,
        technicianName: r.technician_name || null,
        movementType: r.movement_type,
        quantity: numberOrNull(r.quantity),
        unit: r.unit,
        unitCost: numberOrNull(r.unit_cost),
        costUsed: numberOrNull(r.cost_used),
        stockBefore: numberOrNull(r.stock_before),
        stockAfter: numberOrNull(r.stock_after),
        lotNumber: r.lot_number || null,
        metadata: r.metadata || null,
        serviceDate: r.service_date || r.scheduled_date || null,
        serviceType: r.service_type || null,
        createdAt: r.created_at,
      })),
    });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /protocol-health — protocol template + COGS coverage by service line
// =========================================================================
router.get('/protocol-health', async (req, res, next) => {
  try {
    const templateCounts = protocolTemplateCounts();
    const lines = Object.keys(templateCounts);
    const summary = {};
    lines.forEach((line) => {
      summary[line] = {
        serviceLine: line,
        templateCount: templateCounts[line],
        serviceCount: 0,
        cogsRows: 0,
        missingCostRows: 0,
        warningRows: 0,
        totalCost: 0,
        warnings: [],
      };
    });

    const usage = await db('service_product_usage')
      .join('products_catalog', 'service_product_usage.product_id', 'products_catalog.id')
      .select('service_product_usage.*', 'products_catalog.name as product_name',
        'products_catalog.best_price', 'products_catalog.cost_per_unit',
        'products_catalog.cost_unit', 'products_catalog.unit_size_oz')
      .orderBy('service_type');

    const servicesByLine = {};
    usage.forEach((row) => {
      const line = serviceLineForType(row.service_type);
      if (!summary[line]) return;
      servicesByLine[line] = servicesByLine[line] || new Set();
      servicesByLine[line].add(row.service_type);
      const costLine = costLineFromUsage(row);
      summary[line].cogsRows += 1;
      summary[line].totalCost += costLine.cost || 0;
      if (costLine.warning) {
        summary[line].warningRows += 1;
        summary[line].warnings.push({
          serviceType: row.service_type,
          productName: row.product_name,
          warning: costLine.warning,
        });
      }
      if (!costLine.source || (costLine.cost || 0) <= 0) summary[line].missingCostRows += 1;
    });

    Object.entries(servicesByLine).forEach(([line, services]) => {
      summary[line].serviceCount = services.size;
    });

    res.json({
      generatedAt: new Date().toISOString(),
      lines: lines.map((line) => ({
        ...summary[line],
        totalCost: Math.round(summary[line].totalCost * 100) / 100,
        status: summary[line].templateCount === 0 || summary[line].cogsRows === 0
          ? 'missing'
          : summary[line].missingCostRows > 0
            ? 'warning'
            : 'healthy',
        warnings: summary[line].warnings.slice(0, 5),
      })),
    });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /:productId/adjust — manual inventory stock adjustment
// =========================================================================
router.post('/:productId/adjust', async (req, res, next) => {
  try {
    const { movementType = 'correction', quantity, unit, lotNumber, reason, note } = req.body || {};
    const allowedTypes = new Set(['restock', 'correction', 'damaged_lost']);
    if (!allowedTypes.has(movementType)) return res.status(400).json({ error: 'Invalid movementType' });

    const amount = numberOrNull(quantity);
    if (amount == null || amount === 0) return res.status(400).json({ error: 'quantity is required' });
    if ((movementType === 'restock' || movementType === 'damaged_lost') && amount <= 0) {
      return res.status(400).json({ error: 'quantity must be positive' });
    }

    const result = await db.transaction(async (trx) => {
      const product = await trx('products_catalog')
        .where({ id: req.params.productId })
        .forUpdate()
        .first();
      if (!product) {
        const err = new Error('Product not found');
        err.statusCode = 404;
        throw err;
      }

      const inventoryUnit = unit || product.inventory_unit;
      if (!inventoryUnit) {
        const err = new Error('Inventory unit is required');
        err.statusCode = 400;
        throw err;
      }
      assertSupportedInventoryUnit(inventoryUnit);

      if (
        product.inventory_unit
        && normalizeInventoryUnit(inventoryUnit) !== normalizeInventoryUnit(product.inventory_unit)
      ) {
        const err = new Error(`Adjustment unit must match current inventory unit (${product.inventory_unit})`);
        err.statusCode = 400;
        throw err;
      }

      const stockBefore = numberOrNull(product.inventory_on_hand) || 0;
      const delta = movementType === 'damaged_lost' ? -Math.abs(amount) : amount;
      const stockAfter = Number((stockBefore + delta).toFixed(4));

      await trx('products_catalog').where({ id: product.id }).update({
        inventory_on_hand: stockAfter,
        inventory_unit: inventoryUnit,
        updated_at: new Date(),
      });

      const [movement] = await trx('product_inventory_movements').insert({
        product_id: product.id,
        movement_type: movementType,
        quantity: amount,
        unit: inventoryUnit,
        stock_before: stockBefore,
        stock_after: stockAfter,
        lot_number: lotNumber || null,
        metadata: {
          source: 'admin_manual_adjustment',
          reason: reason || null,
          note: note || null,
          delta,
          adjustedBy: req.adminUser?.id || req.adminUser?.email || req.adminUser?.name || null,
        },
      }).returning('*');

      const updated = await trx('products_catalog').where({ id: product.id }).first();
      return { product: updated, movement };
    });

    res.json({
      success: true,
      product: mapProduct(result.product),
      movement: result.movement,
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// =========================================================================
// GET /service-usage — COGS mappings by service type
// =========================================================================
router.get('/service-usage', async (req, res, next) => {
  try {
    const usage = await db('service_product_usage')
      .join('products_catalog', 'service_product_usage.product_id', 'products_catalog.id')
      .select('service_product_usage.*', 'products_catalog.name as product_name',
        'products_catalog.best_price', 'products_catalog.best_vendor',
        'products_catalog.container_size', 'products_catalog.cost_per_unit',
        'products_catalog.cost_unit', 'products_catalog.unit_size_oz')
      .orderBy('service_type');

    // Group by service type
    const grouped = {};
    usage.forEach(u => {
      if (!grouped[u.service_type]) grouped[u.service_type] = { serviceType: u.service_type, products: [], totalCost: 0 };
      const costLine = costLineFromUsage(u);
      const cost = costLine.cost || 0;
      grouped[u.service_type].products.push({
        id: u.id, productId: u.product_id, productName: u.product_name,
        usageAmount: u.usage_amount, usageUnit: u.usage_unit,
        usagePer1000sf: u.usage_per_1000sf, isPrimary: u.is_primary,
        bestPrice: u.best_price, bestVendor: u.best_vendor,
        costSource: costLine.source || 'missing',
        costWarning: costLine.warning || null,
        costPerApp: cost > 0 ? Math.round(cost * 100) / 100 : null,
      });
      grouped[u.service_type].totalCost += cost;
    });

    res.json({ services: Object.values(grouped) });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /service-usage — add product to service COGS
// =========================================================================
router.post('/service-usage', async (req, res, next) => {
  try {
    const { serviceType, productId, usageAmount, usageUnit, usagePer1000sf, isPrimary } = req.body;
    if (!serviceType || !productId) return res.status(400).json({ error: 'serviceType and productId required' });
    await db('service_product_usage').insert({
      service_type: serviceType, product_id: productId,
      usage_amount: usageAmount, usage_unit: usageUnit,
      usage_per_1000sf: usagePer1000sf, is_primary: isPrimary || false,
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// DELETE /service-usage/:id — remove product from service COGS
// =========================================================================
router.delete('/service-usage/:id', async (req, res, next) => {
  try {
    await db('service_product_usage').where({ id: req.params.id }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /scrape-jobs — scrape job history
// =========================================================================
router.get('/scrape-jobs', async (req, res, next) => {
  try {
    const jobs = await db('price_scrape_jobs')
      .join('vendors', 'price_scrape_jobs.vendor_id', 'vendors.id')
      .select('price_scrape_jobs.*', 'vendors.name as vendor_name')
      .orderBy('created_at', 'desc').limit(50);
    res.json({ jobs });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /scrape-jobs/:vendorId/trigger — manually trigger a scrape
// =========================================================================
router.post('/scrape-jobs/:vendorId/trigger', async (req, res, next) => {
  try {
    const vendor = await db('vendors').where({ id: req.params.vendorId }).first();
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

    // Create a pending job
    const [job] = await db('price_scrape_jobs').insert({
      vendor_id: req.params.vendorId, status: 'pending',
    }).returning('*');

    // Mark vendor as being scraped
    await db('vendors').where({ id: req.params.vendorId }).update({
      last_scrape_at: new Date(), last_scrape_status: 'running',
    });

    // TODO: Trigger actual Playwright scrape service here
    // For now, mark as completed with 0 results
    await db('price_scrape_jobs').where({ id: job.id }).update({
      status: 'completed', started_at: new Date(), completed_at: new Date(),
      products_found: 0, prices_updated: 0, duration_ms: 0,
    });
    await db('vendors').where({ id: req.params.vendorId }).update({
      last_scrape_status: 'completed',
    });

    logger.info(`[inventory] Manual scrape triggered for ${vendor.name}`);
    res.json({ job, message: `Scrape job created for ${vendor.name}. Playwright service not yet connected.` });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /aliases — product name aliases
// =========================================================================
router.get('/aliases', async (req, res, next) => {
  try {
    const aliases = await db('product_aliases')
      .join('products_catalog', 'product_aliases.product_id', 'products_catalog.id')
      .leftJoin('vendors', 'product_aliases.vendor_id', 'vendors.id')
      .select('product_aliases.*', 'products_catalog.name as product_name', 'vendors.name as vendor_name')
      .orderBy('products_catalog.name');
    res.json({ aliases });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /aliases — create product alias
// =========================================================================
router.post('/aliases', async (req, res, next) => {
  try {
    const { productId, aliasName, vendorId } = req.body;
    if (!productId || !aliasName) return res.status(400).json({ error: 'productId and aliasName required' });
    await db('product_aliases').insert({
      product_id: productId, alias_name: aliasName, vendor_id: vendorId || null,
    }).onConflict(['alias_name', 'vendor_id']).ignore();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /stats — dashboard summary stats
// =========================================================================
router.get('/stats', async (req, res, next) => {
  try {
    const [productStats] = await db('products_catalog').select(
      db.raw('COUNT(*) as total_products'),
      db.raw("COUNT(*) FILTER (WHERE needs_pricing = false) as priced"),
      db.raw("COUNT(*) FILTER (WHERE needs_pricing = true) as needs_price"),
      db.raw('COUNT(*) FILTER (WHERE inventory_on_hand IS NOT NULL AND low_stock_threshold IS NOT NULL AND inventory_on_hand <= low_stock_threshold) as low_stock'),
      db.raw("AVG(best_price) FILTER (WHERE best_price > 0) as avg_price"),
    );
    const [vendorStats] = await db('vendors').select(
      db.raw('COUNT(*) as total_vendors'),
      db.raw("COUNT(*) FILTER (WHERE price_scraping_enabled = true) as scraping_enabled"),
    );

    // These tables may not exist yet (migration 061)
    let approvalStats = { pending: 0, approved: 0, rejected: 0 };
    let scrapeStats = { total_jobs: 0, completed: 0, failed: 0 };
    try {
      const [a] = await db('price_approvals').select(
        db.raw("COUNT(*) FILTER (WHERE status = 'pending') as pending"),
        db.raw("COUNT(*) FILTER (WHERE status = 'approved') as approved"),
        db.raw("COUNT(*) FILTER (WHERE status = 'rejected') as rejected"),
      );
      approvalStats = a;
    } catch { /* table not created yet */ }
    try {
      const [s] = await db('price_scrape_jobs').select(
        db.raw('COUNT(*) as total_jobs'),
        db.raw("COUNT(*) FILTER (WHERE status = 'completed') as completed"),
        db.raw("COUNT(*) FILTER (WHERE status = 'failed') as failed"),
      );
      scrapeStats = s;
    } catch { /* table not created yet */ }
    let restockOpen = 0;
    try {
      if (await db.schema.hasTable('product_restock_requests')) {
        const row = await db('product_restock_requests')
          .whereIn('status', ['open', 'ordered'])
          .count('* as count')
          .first();
        restockOpen = parseInt(row?.count || 0);
      }
    } catch { /* table not created yet */ }

    res.json({
      products: {
        total: parseInt(productStats.total_products),
        priced: parseInt(productStats.priced),
        needsPrice: parseInt(productStats.needs_price),
        lowStock: parseInt(productStats.low_stock || 0),
        avgPrice: productStats.avg_price,
      },
      vendors: { total: parseInt(vendorStats.total_vendors), scrapingEnabled: parseInt(vendorStats.scraping_enabled) },
      approvals: { pending: parseInt(approvalStats.pending || 0), approved: parseInt(approvalStats.approved || 0), rejected: parseInt(approvalStats.rejected || 0) },
      scrapeJobs: { total: parseInt(scrapeStats.total_jobs || 0), completed: parseInt(scrapeStats.completed || 0), failed: parseInt(scrapeStats.failed || 0) },
      restockRequests: { open: restockOpen },
    });
  } catch (err) { next(err); }
});

// GET /waveguard-forecast — projected WaveGuard product demand from upcoming lawn appointments.
router.get('/waveguard-forecast', async (req, res, next) => {
  try {
    const forecast = await buildWaveGuardInventoryForecast({
      days: req.query.days || 14,
      limit: req.query.limit || 150,
    });
    res.json({ forecast });
  } catch (err) { next(err); }
});

// POST /waveguard-forecast/:productId/restock-request — create a restock request from projected demand.
router.post('/waveguard-forecast/:productId/restock-request', async (req, res, next) => {
  try {
    if (!(await db.schema.hasTable('product_restock_requests'))) return res.status(404).json({ error: 'Restock requests are not available' });
    const product = await db('products_catalog').where({ id: req.params.productId }).first();
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const actor = req.technicianId || req.technician?.id || null;
    const actorName = req.technician?.name || req.technician?.email || null;
    const requestedQuantity = numberOrNull(req.body?.requestedQuantity);
    const unit = String(req.body?.unit || product.inventory_unit || product.rate_unit || '').trim();
    if (!requestedQuantity || requestedQuantity <= 0 || !unit) {
      return res.status(400).json({ error: 'Requested quantity and unit are required' });
    }
    assertSupportedInventoryUnit(unit);

    const existing = await db('product_restock_requests')
      .where({ product_id: product.id })
      .whereIn('status', ['open', 'ordered'])
      .where('source', 'waveguard_inventory_forecast')
      .first();
    if (existing && req.body?.allowDuplicate !== true) {
      return res.json({ success: true, existing: true, restockRequest: existing });
    }

    const now = new Date();
    const [restockRequest] = await db('product_restock_requests')
      .insert({
        product_id: product.id,
        status: 'open',
        priority: String(req.body?.priority || 'high').toLowerCase(),
        requested_quantity: requestedQuantity,
        unit,
        current_stock: numberOrNull(product.inventory_on_hand),
        target_stock: numberOrNull(req.body?.targetStock),
        vendor: product.best_vendor || null,
        needed_by: req.body?.neededBy || null,
        reason: String(req.body?.reason || '').trim() || `Forecasted WaveGuard inventory demand for ${product.name}`,
        source: 'waveguard_inventory_forecast',
        created_by: actor,
        created_by_name: actorName,
        metadata: {
          forecastDays: numberOrNull(req.body?.forecastDays),
          committedDemand: numberOrNull(req.body?.committedDemand),
          projectedRemaining: numberOrNull(req.body?.projectedRemaining),
          firstShortDate: req.body?.firstShortDate || null,
        },
        created_at: now,
        updated_at: now,
      })
      .returning('*');
    res.json({ success: true, existing: false, restockRequest });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    if (err.code === '23514') return res.status(400).json({ error: 'Invalid priority or request status' });
    next(err);
  }
});

// GET /unit-review — products and forecast rows with inventory unit issues.
router.get('/unit-review', async (req, res, next) => {
  try {
    const products = await db('products_catalog')
      .where(function unitIssue() {
        this.where(function missingUnit() {
          this.whereNull('inventory_unit')
            .where(function hasInventoryValue() {
              this.whereNotNull('inventory_on_hand').orWhereNotNull('low_stock_threshold');
            });
        })
          .orWhereRaw("lower(coalesce(inventory_unit, '')) = 'oz'")
          .orWhereRaw(`
            nullif(trim(coalesce(inventory_unit, '')), '') is not null
            AND regexp_replace(lower(replace(trim(inventory_unit), ' ', '_')), 's$', '') NOT IN ('fl_oz','floz','gal','gallon','qt','quart','pt','pint','ml','l','liter','oz','ounce','lb','pound','g','gram','kg')
          `);
      })
      .select(
        'id',
        'name',
        'category',
        'subcategory',
        'formulation',
        'inventory_on_hand',
        'inventory_unit',
        'low_stock_threshold',
        'rate_unit',
        'unit_size_oz',
      )
      .orderBy('name')
      .limit(250);

    const forecast = await buildWaveGuardInventoryForecast({
      days: req.query.days || 14,
      limit: req.query.limit || 150,
    }).catch((err) => ({ error: err.message, products: [] }));
    const forecastRows = (forecast.products || [])
      .filter((row) => row.status === 'unit_mismatch' || row.conversionConfidence === 'needs_review')
      .map((row) => ({
        productId: row.productId,
        productName: row.productName,
        inventoryUnit: row.inventoryUnit,
        demandUnit: row.demandUnit,
        unconvertedDemand: row.unconvertedDemand,
        unitMismatchCount: row.unitMismatchCount,
        appointments: row.mismatchAppointments || [],
      }));

    res.json({
      products: products.map(mapUnitReviewProduct),
      forecastRows,
      forecastError: forecast.error || null,
      counts: {
        products: products.length,
        forecastRows: forecastRows.length,
      },
    });
  } catch (err) { next(err); }
});

// POST /unit-review/:productId/fix — normalize a product inventory unit.
router.post('/unit-review/:productId/fix', async (req, res, next) => {
  try {
    const nextUnit = String(req.body?.inventoryUnit || '').trim();
    const convertExistingStock = req.body?.convertExistingStock !== false;
    assertSupportedInventoryUnit(nextUnit);

    const updated = await db.transaction(async (trx) => {
      const product = await trx('products_catalog')
        .where({ id: req.params.productId })
        .forUpdate()
        .first();
      if (!product) {
        const err = new Error('Product not found');
        err.statusCode = 404;
        throw err;
      }
      const currentUnit = product.inventory_unit || null;
      const stockBefore = numberOrNull(product.inventory_on_hand);
      const thresholdBefore = numberOrNull(product.low_stock_threshold);
      let stockAfter = stockBefore;
      let thresholdAfter = thresholdBefore;
      let conversion = null;

      if (convertExistingStock && currentUnit && normalizeInventoryUnit(currentUnit) !== normalizeInventoryUnit(nextUnit)) {
        stockAfter = stockBefore != null ? convertInventoryQuantity(stockBefore, currentUnit, nextUnit) : null;
        thresholdAfter = thresholdBefore != null ? convertInventoryQuantity(thresholdBefore, currentUnit, nextUnit) : null;
        if ((stockBefore != null && stockAfter == null) || (thresholdBefore != null && thresholdAfter == null)) {
          const err = new Error(`Cannot convert existing inventory from ${currentUnit} to ${nextUnit}`);
          err.statusCode = 400;
          throw err;
        }
        conversion = {
          fromUnit: currentUnit,
          toUnit: nextUnit,
          stockBefore,
          stockAfter,
          thresholdBefore,
          thresholdAfter,
        };
      }

      await trx('products_catalog').where({ id: product.id }).update({
        inventory_unit: nextUnit,
        inventory_on_hand: stockAfter,
        low_stock_threshold: thresholdAfter,
        updated_at: new Date(),
      });

      if (conversion && stockBefore != null) {
        const stockBeforeInNextUnit = convertInventoryQuantity(stockBefore, currentUnit, nextUnit);
        await trx('product_inventory_movements').insert({
          product_id: product.id,
          movement_type: 'correction',
          quantity: Number(((stockAfter || 0) - (stockBeforeInNextUnit || 0)).toFixed(4)),
          unit: nextUnit,
          stock_before: stockBeforeInNextUnit,
          stock_after: stockAfter || 0,
          metadata: {
            source: 'inventory_unit_review_fix',
            reason: 'Inventory unit normalization',
            conversion,
            adjustedBy: req.adminUser?.id || req.adminUser?.email || req.adminUser?.name || null,
          },
        });
      }

      return trx('products_catalog').where({ id: product.id }).first();
    });

    res.json({ success: true, product: mapProduct(updated) });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// GET /restock-requests — product restock request queue.
router.get('/restock-requests', async (req, res, next) => {
  try {
    if (!(await db.schema.hasTable('product_restock_requests'))) {
      return res.json({ requests: [] });
    }
    const status = String(req.query.status || 'open').toLowerCase();
    let query = db('product_restock_requests as prr')
      .leftJoin('products_catalog as pc', 'prr.product_id', 'pc.id')
      .leftJoin('scheduled_services as ss', 'prr.scheduled_service_id', 'ss.id')
      .leftJoin('customers as c', 'prr.customer_id', 'c.id')
      .select(
        'prr.*',
        'pc.name as product_name',
        'pc.category as product_category',
        'pc.inventory_on_hand',
        'pc.inventory_unit',
        'pc.best_vendor',
        'ss.scheduled_date',
        'ss.service_type',
        'c.first_name',
        'c.last_name',
        'c.address_line1',
        'c.city',
      )
      .orderByRaw("case prr.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end")
      .orderByRaw('prr.needed_by asc nulls last')
      .orderBy('prr.created_at', 'desc')
      .limit(Math.max(1, Math.min(200, Number(req.query.limit || 100))));
    if (status !== 'all') query = query.whereIn('prr.status', status === 'active' ? ['open', 'ordered'] : [status]);
    const rows = await query;
    res.json({
      requests: rows.map((row) => ({
        id: row.id,
        productId: row.product_id,
        productName: row.product_name,
        productCategory: row.product_category,
        status: row.status,
        priority: row.priority,
        requestedQuantity: row.requested_quantity != null ? Number(row.requested_quantity) : null,
        unit: row.unit,
        currentStock: row.current_stock != null ? Number(row.current_stock) : null,
        liveStock: row.inventory_on_hand != null ? Number(row.inventory_on_hand) : null,
        inventoryUnit: row.inventory_unit,
        targetStock: row.target_stock != null ? Number(row.target_stock) : null,
        vendor: row.vendor || row.best_vendor || null,
        neededBy: row.needed_by,
        reason: row.reason,
        source: row.source,
        scheduledServiceId: row.scheduled_service_id,
        scheduledDate: row.scheduled_date,
        serviceType: row.service_type,
        customerName: `${row.first_name || ''} ${row.last_name || ''}`.trim() || null,
        address: row.address_line1,
        city: row.city,
        createdByName: row.created_by_name,
        createdAt: row.created_at,
      })),
    });
  } catch (err) { next(err); }
});

// POST /restock-requests/:id/action — update request status and optionally receive stock.
router.post('/restock-requests/:id/action', async (req, res, next) => {
  try {
    if (!(await db.schema.hasTable('product_restock_requests'))) return res.status(404).json({ error: 'Restock requests are not available' });
    const action = String(req.body?.action || '').toLowerCase();
    if (!['mark_ordered', 'receive', 'cancel'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
    const request = await db('product_restock_requests').where({ id: req.params.id }).first();
    if (!request) return res.status(404).json({ error: 'Restock request not found' });
    const actor = req.technicianId || req.technician?.id || null;
    const result = await db.transaction(async (trx) => {
      if (action === 'mark_ordered') {
        const [updated] = await trx('product_restock_requests')
          .where({ id: request.id })
          .update({ status: 'ordered', updated_at: new Date() })
          .returning('*');
        return { request: updated };
      }
      if (action === 'cancel') {
        const [updated] = await trx('product_restock_requests')
          .where({ id: request.id })
          .update({ status: 'cancelled', closed_by: actor, closed_at: new Date(), updated_at: new Date() })
          .returning('*');
        return { request: updated };
      }
      const product = await trx('products_catalog').where({ id: request.product_id }).forUpdate().first();
      if (!product) {
        const err = new Error('Product not found');
        err.statusCode = 404;
        throw err;
      }
      const quantity = numberOrNull(req.body?.quantity) ?? numberOrNull(request.requested_quantity);
      const unit = String(req.body?.unit || request.unit || product.inventory_unit || '').trim();
      if (!quantity || quantity <= 0 || !unit) {
        const err = new Error('Receive quantity and unit are required');
        err.statusCode = 400;
        throw err;
      }
      const inventoryUnit = product.inventory_unit || unit;
      const received = describeInventoryConversion(quantity, unit, inventoryUnit);
      if (!received.convertible || received.amount == null) {
        const err = new Error(`Cannot convert receive unit ${unit} to inventory unit ${inventoryUnit}`);
        err.statusCode = 400;
        throw err;
      }
      const stockBefore = numberOrNull(product.inventory_on_hand) || 0;
      const stockAfter = Number((stockBefore + received.amount).toFixed(4));
      await trx('products_catalog').where({ id: product.id }).update({
        inventory_on_hand: stockAfter,
        inventory_unit: inventoryUnit,
        updated_at: new Date(),
      });
      const [movement] = await trx('product_inventory_movements').insert({
        product_id: product.id,
        movement_type: 'restock',
        quantity: received.amount,
        unit: inventoryUnit,
        stock_before: stockBefore,
        stock_after: stockAfter,
        metadata: {
          source: 'restock_request_receive',
          restockRequestId: request.id,
          note: req.body?.note || null,
          adjustedBy: actor,
          enteredQuantity: quantity,
          enteredUnit: unit,
          conversionConfidence: received.confidence,
        },
      }).returning('*');
      const [updated] = await trx('product_restock_requests')
        .where({ id: request.id })
        .update({ status: 'received', closed_by: actor, closed_at: new Date(), updated_at: new Date() })
        .returning('*');
      return { request: updated, movement };
    });
    let readinessRecheck = null;
    if (action === 'receive') {
      try {
        readinessRecheck = await syncLawnReadinessAfterRestock();
      } catch (recheckErr) {
        logger.warn(`[admin-inventory] restock readiness recheck failed: ${recheckErr.message}`);
        readinessRecheck = { error: recheckErr.message };
      }
    }
    res.json({ success: true, ...result, readinessRecheck });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// ── Helper: recalculate best price for a product ──
async function recalcBestPrice(productId) {
  const best = await db('vendor_pricing')
    .where({ product_id: productId }).whereNotNull('price').where('price', '>', 0)
    .join('vendors', 'vendor_pricing.vendor_id', 'vendors.id')
    .select('vendor_pricing.*', 'vendors.name as vendor_name')
    .orderBy('price').first();

  if (best) {
    await db('products_catalog').where({ id: productId }).update({
      best_price: best.price, best_vendor: best.vendor_name, needs_pricing: false,
    });
    await db('vendor_pricing').where({ product_id: productId }).update({ is_best_price: false });
    await db('vendor_pricing').where({ id: best.id }).update({ is_best_price: true });
  }
}

// POST / — create a new product
router.post('/', async (req, res, next) => {
  try {
    const {
      name,
      category,
      subcategory,
      activeIngredient,
      epaRegNumber,
      formulation,
      moaGroup,
      defaultUnit,
      unitSize,
      inventoryOnHand,
      inventoryUnit,
      lowStockThreshold,
    } = req.body;
    if (!name) return res.status(400).json({ error: 'Product name is required' });
    const initialStock = numberOrNull(inventoryOnHand);
    const lowStock = numberOrNull(lowStockThreshold);
    if ((initialStock != null || lowStock != null) && !inventoryUnit) {
      return res.status(400).json({ error: 'Inventory unit is required when stock values are set' });
    }
    assertSupportedInventoryUnit(inventoryUnit);

    const product = await db.transaction(async (trx) => {
      const [inserted] = await trx('products_catalog').insert({
        name, category: category || null, subcategory: subcategory || null,
        active_ingredient: activeIngredient || 'Unknown - pending SDS',
        epa_reg_number: epaRegNumber || 'N/A',
        moa_group: moaGroup || null,
        default_unit: defaultUnit || 'oz',
        container_size: unitSize || null,
        formulation: formulation || 'unspecified',
        inventory_on_hand: initialStock,
        inventory_unit: inventoryUnit || null,
        low_stock_threshold: lowStock,
      }).returning('*');

      if (initialStock != null) {
        await trx('product_inventory_movements').insert({
          product_id: inserted.id,
          movement_type: 'correction',
          quantity: initialStock,
          unit: inventoryUnit,
          stock_before: 0,
          stock_after: initialStock,
          metadata: {
            source: 'admin_product_create',
            reason: 'Initial stock',
            delta: initialStock,
            adjustedBy: req.adminUser?.id || req.adminUser?.email || req.adminUser?.name || null,
          },
        });
      }
      return inserted;
    });

    res.status(201).json(product);
  } catch (err) { next(err); }
});

// DELETE /:id — delete a product
router.delete('/:id', async (req, res, next) => {
  try {
    const product = await db('products_catalog').where({ id: req.params.id }).first();
    if (!product) return res.status(404).json({ error: 'Product not found' });

    await db('vendor_pricing').where({ product_id: req.params.id }).del().catch(() => {});
    await db('products_catalog').where({ id: req.params.id }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// PUT /service-usage/:id — update a service product usage mapping
// (MUST be before PUT /:id to avoid Express param catch)
// =========================================================================
router.put('/service-usage/:id', async (req, res, next) => {
  try {
    const { serviceType, productId, usageAmount, usageUnit, usagePer1000sf, isPrimary, notes } = req.body;
    const upd = { updated_at: new Date() };
    if (serviceType !== undefined) upd.service_type = serviceType;
    if (productId !== undefined) upd.product_id = productId;
    if (usageAmount !== undefined) upd.usage_amount = usageAmount;
    if (usageUnit !== undefined) upd.usage_unit = usageUnit;
    if (usagePer1000sf !== undefined) upd.usage_per_1000sf = usagePer1000sf;
    if (isPrimary !== undefined) upd.is_primary = isPrimary;
    if (notes !== undefined) upd.notes = notes;

    await db('service_product_usage').where({ id: req.params.id }).update(upd);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// PUT /:id — update product fields (inline editing)
// =========================================================================
router.put('/:id', async (req, res, next) => {
  try {
    const product = await db('products_catalog').where({ id: req.params.id }).first();
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const allowed = {
      name: 'name', category: 'category', subcategory: 'subcategory',
      activeIngredient: 'active_ingredient', moaGroup: 'moa_group',
      containerSize: 'container_size', formulation: 'formulation',
      defaultUnit: 'default_unit', defaultRate: 'default_rate', sku: 'sku',
      unitSizeOz: 'unit_size_oz', unitType: 'unit_type',
      signalWord: 'signal_word', reiHours: 'rei_hours',
      rainFreeHours: 'rain_free_hours', minTempF: 'min_temp_f', maxTempF: 'max_temp_f',
      maxWindMph: 'max_wind_mph', dilutionRate: 'dilution_rate',
      mixingInstructions: 'mixing_instructions', ppeRequired: 'ppe_required',
      restrictedUse: 'restricted_use', maximumAnnualRate: 'maximum_annual_rate',
      reapplicationIntervalDays: 'reapplication_interval_days',
      pollinatorPrecautions: 'pollinator_precautions', aquaticBufferFt: 'aquatic_buffer_ft',
      compatibilityNotes: 'compatibility_notes', epaRegNumber: 'epa_reg_number',
      monthlyUsageEstimate: 'monthly_usage_estimate',
      // Product Registry — customer-facing content + visibility
      customerVisibility: 'customer_visibility',
      contentStatus: 'content_status',
      commonName: 'common_name',
      publicSummary: 'public_summary',
      portalSummary: 'portal_summary',
      customerSafetySummary: 'customer_safety_summary',
      petKidGuidanceText: 'pet_kid_guidance_text',
      targetPests: 'target_pests',
      applicationZones: 'application_zones',
    };

    const upd = { updated_at: new Date() };
    for (const [camel, snake] of Object.entries(allowed)) {
      if (req.body[camel] !== undefined) upd[snake] = req.body[camel];
    }
    const nextStock = req.body.inventoryOnHand !== undefined
      ? numberOrNull(req.body.inventoryOnHand)
      : numberOrNull(product.inventory_on_hand);
    const nextThreshold = req.body.lowStockThreshold !== undefined
      ? numberOrNull(req.body.lowStockThreshold)
      : numberOrNull(product.low_stock_threshold);
    const nextUnit = req.body.inventoryUnit !== undefined
      ? req.body.inventoryUnit || null
      : product.inventory_unit || null;
    if ((nextStock != null || nextThreshold != null) && !nextUnit) {
      return res.status(400).json({ error: 'Inventory unit is required when stock values are set' });
    }
    assertSupportedInventoryUnit(nextUnit);

    if (req.body.inventoryUnit !== undefined) upd.inventory_unit = nextUnit;
    if (req.body.lowStockThreshold !== undefined) upd.low_stock_threshold = nextThreshold;

    const updated = await db.transaction(async (trx) => {
      const locked = await trx('products_catalog').where({ id: req.params.id }).forUpdate().first();
      if (!locked) {
        const err = new Error('Product not found');
        err.statusCode = 404;
        throw err;
      }
      const stockBefore = numberOrNull(locked.inventory_on_hand);
      const stockChanged = req.body.inventoryOnHand !== undefined && stockBefore !== nextStock;
      const currentUnit = locked.inventory_unit || null;
      if (nextStock != null && currentUnit && nextUnit && normalizeInventoryUnit(currentUnit) !== normalizeInventoryUnit(nextUnit)) {
        const err = new Error(`Inventory unit must stay ${currentUnit} when editing stock; use a manual adjustment after normalizing units`);
        err.statusCode = 400;
        throw err;
      }
      const movementUnit = nextUnit || currentUnit;
      if (stockChanged && !movementUnit) {
        const err = new Error('Inventory unit is required when stock changes');
        err.statusCode = 400;
        throw err;
      }

      if (stockChanged) {
        upd.inventory_on_hand = nextStock;
        upd.inventory_unit = nextUnit;
      }

      await trx('products_catalog').where({ id: req.params.id }).update(upd);
      if (stockChanged) {
        const before = stockBefore || 0;
        const after = nextStock || 0;
        await trx('product_inventory_movements').insert({
          product_id: req.params.id,
          movement_type: 'correction',
          quantity: Number((after - before).toFixed(4)),
          unit: movementUnit,
          stock_before: before,
          stock_after: after,
          metadata: {
            source: 'admin_inline_stock_edit',
            reason: 'Inline product stock edit',
            delta: Number((after - before).toFixed(4)),
            adjustedBy: req.adminUser?.id || req.adminUser?.email || req.adminUser?.name || null,
          },
        });
      }
      return trx('products_catalog').where({ id: req.params.id }).first();
    });
    res.json({ success: true, product: updated });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// =========================================================================
// POST /ai-price-lookup — AI agent: search vendor prices for a product
// =========================================================================
router.post('/ai-price-lookup', async (req, res, next) => {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'AI not configured — set ANTHROPIC_API_KEY' });

    const { productId, productName, containerSize, vendors: vendorFilter } = req.body;
    if (!productName) return res.status(400).json({ error: 'productName required' });

    // Get active vendors
    let vendors = await db('vendors').where({ active: true }).select('id', 'name', 'website', 'type');
    if (vendorFilter && vendorFilter.length) {
      vendors = vendors.filter(v => vendorFilter.includes(v.id));
    }

    const vendorList = vendors.map(v => `${v.name} (${v.website || 'no site'})`).join(', ');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = `You are a procurement research agent for a pest control and lawn care company. Your task is to find the current best prices for a specific product across multiple vendors.

PRODUCT: ${productName}
CONTAINER SIZE: ${containerSize || 'standard size'}
VENDORS TO CHECK: ${vendorList}

INSTRUCTIONS:
1. Search for the exact product name on vendor websites. Include the container size in your search.
2. For each vendor where you find a price, record: vendor name, price, container size/quantity, and source URL.
3. Normalize all prices to price-per-oz for liquid products or price-per-lb for granular/dry products.
4. If you can't find an exact match, note it but don't guess prices.

RESPOND WITH ONLY valid JSON (no markdown fences, no preamble):
{
  "product": "${productName}",
  "results": [
    {
      "vendor": "Vendor Name",
      "price": 99.99,
      "quantity": "32 oz",
      "url": "https://...",
      "pricePerOz": 3.12,
      "notes": "any relevant notes"
    }
  ],
  "cheapest": "Vendor Name",
  "summary": "Brief summary of findings"
}`;

    const msg = await anthropic.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    });

    // Extract text from response (may have multiple content blocks from tool use)
    let responseText = '';
    for (const block of msg.content) {
      if (block.type === 'text') responseText += block.text;
    }

    // Handle tool use loop — keep going until we get a final text response
    let currentMsg = msg;
    let loopCount = 0;
    while (currentMsg.stop_reason === 'tool_use' && loopCount < 10) {
      loopCount++;
      const toolUseBlocks = currentMsg.content.filter(b => b.type === 'tool_use');
      const toolResults = toolUseBlocks.map(tb => ({
        type: 'tool_result',
        tool_use_id: tb.id,
        content: 'Search completed. Continue analyzing results and provide your final JSON response.',
      }));

      currentMsg = await anthropic.messages.create({
        model: MODELS.FLAGSHIP,
        max_tokens: 2000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: currentMsg.content },
          { role: 'user', content: toolResults },
        ],
      });

      for (const block of currentMsg.content) {
        if (block.type === 'text') responseText += block.text;
      }
    }

    // Parse the JSON response
    let parsed;
    try {
      const clean = responseText.replace(/```json|```/g, '').trim();
      // Find the JSON object in the response
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : clean);
    } catch (parseErr) {
      logger.warn(`[AI Price Lookup] Failed to parse JSON: ${parseErr.message}`);
      return res.json({ success: true, raw: responseText, results: [], summary: 'AI returned non-JSON response. See raw field.' });
    }

    // If we have a productId, create approval queue entries for found prices
    if (productId && parsed.results && parsed.results.length > 0) {
      for (const result of parsed.results) {
        // Find vendor by name
        const vendor = vendors.find(v => v.name.toLowerCase() === result.vendor?.toLowerCase());
        if (!vendor || !result.price) continue;

        // Check existing price
        const existing = await db('vendor_pricing')
          .where({ product_id: productId, vendor_id: vendor.id }).first();

        // Create approval entry
        try {
          await db('price_approvals').insert({
            product_id: productId,
            vendor_id: vendor.id,
            old_price: existing?.price || null,
            new_price: result.price,
            new_quantity: result.quantity || null,
            source_url: result.url || null,
            price_change_pct: existing?.price
              ? Math.round(((result.price - existing.price) / existing.price) * 10000) / 100
              : null,
            status: 'pending',
            notes: `AI agent lookup — ${result.notes || ''}`,
          });
        } catch (e) {
          logger.warn(`[AI Price Lookup] Failed to create approval for ${result.vendor}: ${e.message}`);
        }
      }
    }

    res.json({
      success: true,
      product: productName,
      results: parsed.results || [],
      cheapest: parsed.cheapest || null,
      summary: parsed.summary || '',
      approvalsCreated: parsed.results?.length || 0,
    });
  } catch (err) {
    logger.error(`[AI Price Lookup] Error: ${err.message}`);
    next(err);
  }
});

// =========================================================================
// POST /ai-price-lookup/bulk — AI agent: bulk price check all unpriced products
// =========================================================================
router.post('/ai-price-lookup/bulk', async (req, res, next) => {
  try {
    const unpriced = await db('products_catalog').where({ needs_pricing: true }).select('id', 'name', 'container_size');
    if (unpriced.length === 0) return res.json({ success: true, message: 'All products are priced', queued: 0 });

    // We don't actually run them all synchronously — just queue them
    // In production this would be a background job queue
    res.json({
      success: true,
      message: `${unpriced.length} products queued for AI price lookup. Use the individual lookup endpoint for each.`,
      queued: unpriced.length,
      products: unpriced.map(p => ({ id: p.id, name: p.name, containerSize: p.container_size })),
    });
  } catch (err) { next(err); }
});

router._test = {
  findOpenLoginDiscoveryConnection,
  hasTerminalLoginDiscoveryResult,
  isOpenLoginDiscoveryJob,
  isTerminalLoginDiscoveryJob,
  loginDiscoveryFromConnection,
  vendorCredentialStatusWhileQueued,
  vendorNeedsLoginDiscovery,
};

module.exports = router;
