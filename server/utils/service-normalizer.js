/**
 * Service Type Normalizer
 * server/utils/service-normalizer.js
 *
 * Normalizes raw service type labels to clean Waves service names.
 */

const { etDateString } = require('./datetime-et');
const { canonicalCatalogName } = require('../services/service-catalog-names');

// ─── SERVICE TYPE NORMALIZATION ──────────────────────────────────

/**
 * Maps raw service names (e.g. "Pest Control Service - 1 hour - $117")
 * to clean Waves service type labels.
 */
const SERVICE_TYPE_MAP = [
  // Pest control
  { match: /pest\s*control.*quarterly/i,                   type: 'Quarterly Pest Control' },
  { match: /general\s*pest/i,                               type: 'General Pest Control' },
  { match: /pest\s*control.*service/i,                      type: 'Pest Control Service' },
  { match: /pest\s*control/i,                               type: 'Pest Control' },
  // German roach must precede the generic roach pattern or it never matches.
  { match: /german\s*roach/i,                               type: 'German Roach Treatment' },
  { match: /cockroach|roach/i,                              type: 'Cockroach Treatment Service' },
  { match: /bed\s*bug/i,                                    type: 'Bed Bug Treatment Service' },
  { match: /ant\s*(control|treatment|extermination)/i,      type: 'Ant Treatment' },
  { match: /flea.*tick|tick.*flea/i,                        type: 'Flea & Tick Treatment' },
  { match: /stinging|wasp|hornet|yellow\s*jacket/i,         type: 'Stinging Insect Removal' },

  // Rodent
  // Wire mesh must precede the generic exclusion pattern or the renamed
  // catalog identity collapses to 'Rodent Exclusion' (codex #3484 P2).
  { match: /wire\s*mesh/i,                                  type: 'Rodent Wire Mesh Exclusion Service' },
  { match: /rodent.*exclusion/i,                            type: 'Rodent Exclusion' },
  // Word-bounded: a bare /rat/ matched "Core AeRATion Service" → Rodent Control.
  { match: /rodent.*control|\brats?\b|\bmouse\b|\bmice\b/i, type: 'Rodent Control' },

  // Termite
  { match: /wdo|wood\s*destroy|real\s*estate.*inspect/i,    type: 'WDO Inspection' },
  { match: /termite.*inspect/i,                             type: 'Termite Inspection' },
  // Renamed catalog identities must survive normalization (codex #3484 P2)
  // — without their own entries the generic termite/rodent patterns
  // collapsed them to family labels on /api/schedule and reschedule texts.
  { match: /bora.?care/i,                                   type: 'Bora-Care Wood Treatment Service' },
  { match: /termite.*treat|termidor/i,                      type: 'Termite Treatment' },
  { match: /termite.*bait|advance|trelona/i,                type: 'Termite Bait Monitoring' },
  { match: /termite/i,                                      type: 'Termite Service' },

  // Lawn care
  { match: /lawn\s*care.*service|lawn.*treatment/i,         type: 'Lawn Care Visit' },
  { match: /lawn\s*care/i,                                  type: 'Lawn Care' },
  { match: /fertil/i,                                       type: 'Lawn Fertilization' },
  { match: /weed\s*control/i,                               type: 'Weed Control' },
  { match: /dethatch/i,                                     type: 'Lawn Dethatching Service' },
  { match: /top\s*dress/i,                                  type: 'Lawn Top Dressing Service' },
  { match: /aerat/i,                                        type: 'Lawn Aeration' },
  { match: /sod/i,                                          type: 'Sod Installation' },

  // Mosquito — cadence identities are catalog services (mosquito_seasonal /
  // mosquito_monthly) and must survive; the bare pattern is the legacy fallback.
  { match: /seasonal.*mosquito|mosquito.*seasonal/i,        type: 'Seasonal Mosquito Control Service' },
  { match: /monthly.*mosquito|mosquito.*monthly/i,          type: 'Monthly Mosquito Control Service' },
  { match: /mosquito/i,                                     type: 'Mosquito Barrier Treatment' },

  // Tree & shrub
  { match: /tree.*shrub|shrub.*tree/i,                      type: 'Tree & Shrub Care' },
  { match: /palm.*inject/i,                                 type: 'Palm Injection' },
  { match: /arborjet/i,                                     type: 'Arborjet Treatment' },

  // Mole
  { match: /mole\s*(control|trap)/i,                        type: 'Mole Control' },

  // Fumigation
  { match: /fumigat|tent/i,                                 type: 'Tent Fumigation' },

  // Inspections/Estimates
  // "Waves Assessment" is the real admin-catalog service (owner rule: call
  // bookings use catalog services; unsure → Waves Assessment). The old
  // normalized label "Property Assessment" was NOT a catalog service and
  // confused the schedule views — normalize to the catalog name instead.
  { match: /estimat|assessment|consultation/i,              type: 'Waves Assessment' },
  { match: /inspect/i,                                      type: 'Inspection' },

  // Callbacks
  { match: /callback|re-?treat|follow.?up.*treat/i,        type: 'Service Callback' },
];

/**
 * Normalize a raw service type string into a clean Waves label.
 * Strips pricing, duration, and common suffix formatting.
 *
 * Examples:
 *   "Pest Control Service - 1 hour - $117" → "Pest Control Service"
 *   "Lawn Care" → "Lawn Care"
 *   null → "General Service"
 */
// Strip duration/price suffixes only (" - 1 hour", " - $117", " - 45
// min"), preserving the service identity itself. Unlike
// normalizeServiceType, this never collapses distinct services onto one
// label ("Tree & Shrub Fertilization" stays itself instead of mapping to
// "Lawn Fertilization") — use it where the SPECIFIC service matters and
// only cosmetic suffixes should be ignored.
function stripServiceSuffixes(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\s*[-–]\s*\d+\s*(hour|hr|min|minute)s?\b/gi, '')
    .replace(/\s*[-–]\s*\$[\d,.]+/g, '')
    .replace(/\s*[-–]\s*$/g, '')
    .trim();
}

// Foam labels pass through UNMODIFIED — deliberately no SERVICE_TYPE_MAP
// entry: collapsing them would drop the cadence the schedule shows
// ("Recurring Termite Foam Service (Quarterly)"), and the 2026-08-25
// renamed forms carry a termite token that would otherwise collapse to
// the generic "Termite Service" (codex #3484 P2). Same token family as
// detectServiceCategory's foamTermiteToken, plus the renamed forms.
const FOAM_LABEL_RE = /foam[\s_-]*drill|drill[\s_&-]*(?:and[\s_-]*)?foam|recurring[\s_-]*(?:termite[\s_-]*)?foam|foam[\s_-]*recurring|termite[\s_-]*foam|termidor[\s_-]*foam/i;

function normalizeServiceType(raw) {
  if (!raw) return 'General Service';

  const cleaned = stripServiceSuffixes(raw);

  if (FOAM_LABEL_RE.test(cleaned)) return cleaned;

  // A real catalog identity passes through verbatim (case-normalized). The
  // regex map below exists for legacy/raw imports and free-text labels; on a
  // catalog name it only ever loses information (cadence, term, family).
  const catalogName = canonicalCatalogName(cleaned);
  if (catalogName) return catalogName;

  // Match against known patterns
  for (const mapping of SERVICE_TYPE_MAP) {
    if (mapping.match.test(cleaned)) {
      return mapping.type;
    }
  }

  // If nothing matched, return the cleaned string (capitalized)
  return cleaned || 'General Service';
}

/**
 * The FIXED public label a raw service_type maps to under SERVICE_TYPE_MAP,
 * or null when nothing matched. Deliberately narrower than
 * normalizeServiceType: NO catalog branch and NO foam passthrough, because
 * both of those can return arbitrary text a display surface must never show
 * (2026-09-25 round-5 P1 fix). canonicalCatalogName is populated from
 * historical scheduled_services labels — a hand-edited free-text label like
 * "Dog In Home Call Before Arrival" can enter that cache and would then pass
 * through verbatim; the foam branch returns any larger string merely
 * CONTAINING a foam token ("Foam Drill Customer Complained Reservice"). A
 * display surface that must only ever show one of a finite set of known
 * public names (server/services/review-reply/grounding.js's
 * servicesPerformed) calls this instead of normalizeServiceType.
 */
function mappedServiceLabel(raw) {
  if (!raw) return null;
  const cleaned = stripServiceSuffixes(raw);
  if (!cleaned) return null;
  // Tree & shrub labels that also carry a lawn-program word ("Tree & Shrub
  // Fertilization", "Palm Weed & Feed") would otherwise hit the generic
  // /fertil/ lawn mapping first and be published as "Lawn Fertilization" —
  // a service the customer never had (2026-09-24 round-6 P1). Same family
  // rule as detectServiceCategory: only the tree & shrub mappings apply, and
  // the family label is the fallback.
  //
  // Inspection-only labels ("Bee / Yellowjacket Inspection", "Tree & Shrub
  // Inspection") are checked first the same way: only inspection/assessment
  // mappings apply, so an inspection never publishes as a removal or
  // treatment (round-8 P1).
  const family = matchesAtWordStart(INSPECTION_LABEL_RE, cleaned) ? INSPECTION_FAMILY
    : detectServiceCategory(cleaned) === 'tree_shrub' ? TREE_SHRUB_FAMILY : null;
  for (const mapping of SERVICE_TYPE_MAP) {
    if (family && !family.types.has(mapping.type)) continue;
    if (matchesAtWordStart(mapping.match, cleaned)) return mapping.type;
  }
  return family ? family.fallback : null;
}
const INSPECTION_LABEL_RE = /inspect|assessment|estimat|consultation/i;
const INSPECTION_FAMILY = { types: new Set(['WDO Inspection', 'Termite Inspection', 'Waves Assessment', 'Inspection']), fallback: 'Inspection' };
const TREE_SHRUB_FAMILY = { types: new Set(['Tree & Shrub Care', 'Palm Injection', 'Arborjet Treatment']), fallback: 'Tree & Shrub Care' };
// The legacy map patterns are prefix stems ("fertil", "aerat"), not
// word-bounded, so /ant\s*treatment/ also matches inside "Plant Treatment"
// and /tent/ inside "Content". For a public label only a match that begins
// a word counts (2026-09-24 round-7 P1) — stems may still run past the end
// of a word ("Fertilization", "Ants").
function matchesAtWordStart(re, text) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of text.matchAll(g)) {
    if (m.index === 0 || !/[a-z0-9]/i.test(text[m.index - 1])) return true;
  }
  return false;
}

/**
 * Detect the service category for color coding and icon assignment.
 */
function detectServiceCategory(serviceType) {
  const s = (serviceType || '').toLowerCase();
  // Tree & shrub names that also mention fertilization/weeds ("Tree & Shrub
  // Fertilization", "Tree & Shrub Weed & Feed") are still tree & shrub —
  // the program includes fertilization and bed-weed work by definition.
  // Lawn wins only on an actual lawn-surface token, and mosquito/termite
  // combined names keep their own categories (audit 2026-07-18 P2: a
  // 'Tree & Shrub Fertilization' visit completed as a LAWN record and
  // skipped the typed tree & shrub report flow entirely).
  const treeShrubToken = s.includes('tree') || s.includes('shrub') || s.includes('ornamental') || s.includes('palm') || s.includes('arborjet');
  const lawnSurfaceToken = s.includes('lawn') || s.includes('turf') || s.includes('sod') || s.includes('dethatch') || s.includes('top dress') || s.includes('aerat');
  if (treeShrubToken && !lawnSurfaceToken && !s.includes('mosquito') && !s.includes('termite') && !s.includes('wdo')) return 'tree_shrub';
  if (s.includes('lawn') || s.includes('turf') || s.includes('fertil') || s.includes('weed') || s.includes('dethatch') || s.includes('top dress') || s.includes('aerat') || s.includes('sod')) return 'lawn';
  if (s.includes('mosquito')) return 'mosquito';
  // Drill-and-foam termite forms only ("Foam Drill", "Drill-and-Foam",
  // "Recurring Foam Treatment (Quarterly)", foam_drill / foam_recurring,
  // Termidor Foam) — these carry no "termite" token of their own and fell
  // through to 'pest'. Deliberately NOT a bare 'foam' substring: foam
  // sealant is rodent-exclusion material, and "Rodent Exclusion — Foam
  // Sealing" must reach the rodent branch below (codex 2026-08-08 P1).
  const foamTermiteToken = /foam[\s_-]*drill|drill[\s_&-]*(?:and[\s_-]*)?foam|recurring[\s_-]*foam|foam[\s_-]*recurring|termidor[\s_-]*foam/.test(s);
  if (s.includes('termite') || s.includes('wdo') || s.includes('bora') || s.includes('trelona') || foamTermiteToken) return 'termite';
  if (s.includes('tree') || s.includes('shrub') || s.includes('palm') || s.includes('arborjet') || s.includes('ornamental')) return 'tree_shrub';
  // 'bird box' / 'roof-entry' are rodent-exclusion hardware: the catalog
  // row "Roof-entry cover / bird box" (rodent_bird_box) carries no rodent
  // token of its own.
  // 'trap-only' is the retainer product family ('Standard Trap-Only
  // Retainer' carries no rodent token). Deliberately NOT bare 'trap' —
  // that would steal Wildlife Trapping from specialty.
  if (s.includes('rodent') || s.includes('rat') || s.includes('mouse') || s.includes('mole') || s.includes('bird box') || s.includes('roof-entry') || /trap[\s_-]*only/.test(s)) return 'rodent';
  if (s.includes('callback') || s.includes('re-treat')) return 'callback';
  return 'pest';
}

/**
 * Get the emoji icon for a service category.
 */
function serviceIcon(category) {
  const icons = {
    pest: '🐜', lawn: '🌿', mosquito: '🦟', termite: '🪵',
    tree_shrub: '🌳', rodent: '🐀', callback: '🔄',
  };
  return icons[category] || '🔧';
}

/**
 * Get the color for a service category (uses the admin theme).
 */
function serviceColor(category) {
  const colors = {
    pest: '#0ea5e9',     // teal
    lawn: '#10b981',     // green
    mosquito: '#a855f7', // purple
    termite: '#f59e0b',  // amber
    tree_shrub: '#22c55e', // emerald
    rodent: '#ef4444',   // red
    callback: '#64748b', // gray
  };
  return colors[category] || '#0ea5e9';
}


// ─── NEW CUSTOMER DETECTION ─────────────────────────────────────

/**
 * Determine if a customer is actually new (no completed service records).
 *
 * @param {Object} db - Knex database instance
 * @param {string} customerId - Customer UUID
 * @returns {boolean} true if this is genuinely their first service
 */
async function isNewCustomer(db, customerId) {
  if (!customerId) return true;
  const result = await db('service_records')
    .where({ customer_id: customerId, status: 'completed' })
    .count('id as cnt')
    .first();
  return parseInt(result?.cnt || 0) === 0;
}


// ─── DATE SAFETY ────────────────────────────────────────────────

/**
 * Safely format a date field, returning null if the date is invalid.
 * Prevents "Invalid Date" from reaching the client.
 */
function safeDate(d) {
  if (!d) return null;
  const date = new Date(d);
  if (isNaN(date.getTime())) return null;
  // Return ET calendar date (YYYY-MM-DD) — server runs UTC so naive toISOString
  // shifts late-evening ET timestamps to the next day.
  return etDateString(date);
}

/**
 * Safely get a relative date label.
 */
function safeDateLabel(d) {
  const safe = safeDate(d);
  if (!safe) return null;
  const date = new Date(safe + 'T12:00:00');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}


module.exports = {
  normalizeServiceType,
  mappedServiceLabel,
  stripServiceSuffixes,
  detectServiceCategory,
  serviceIcon,
  serviceColor,
  isNewCustomer,
  safeDate,
  safeDateLabel,
  SERVICE_TYPE_MAP,
};
