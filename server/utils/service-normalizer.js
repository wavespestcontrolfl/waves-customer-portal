/**
 * Service Type Normalizer
 * server/utils/service-normalizer.js
 *
 * Normalizes raw service type labels to clean Waves service names.
 */

const { etDateString } = require('./datetime-et');

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
  { match: /cockroach|roach/i,                              type: 'Cockroach Treatment' },
  { match: /german\s*roach/i,                               type: 'German Roach Treatment' },
  { match: /bed\s*bug/i,                                    type: 'Bed Bug Treatment' },
  { match: /ant\s*(control|treatment|extermination)/i,      type: 'Ant Treatment' },
  { match: /flea.*tick|tick.*flea/i,                        type: 'Flea & Tick Treatment' },
  { match: /stinging|wasp|hornet|yellow\s*jacket/i,         type: 'Stinging Insect Removal' },

  // Rodent
  { match: /rodent.*exclusion/i,                            type: 'Rodent Exclusion' },
  { match: /rodent.*control|rat|mouse|mice/i,               type: 'Rodent Control' },

  // Termite
  { match: /wdo|wood\s*destroy|real\s*estate.*inspect/i,    type: 'WDO Inspection' },
  { match: /termite.*inspect/i,                             type: 'Termite Inspection' },
  { match: /termite.*treat|bora.?care|termidor/i,           type: 'Termite Treatment' },
  { match: /termite.*bait|advance|trelona/i,                type: 'Termite Bait Monitoring' },
  { match: /termite/i,                                      type: 'Termite Service' },

  // Lawn care
  { match: /lawn\s*care.*service|lawn.*treatment/i,         type: 'Lawn Care Visit' },
  { match: /lawn\s*care/i,                                  type: 'Lawn Care' },
  { match: /fertil/i,                                       type: 'Lawn Fertilization' },
  { match: /weed\s*control/i,                               type: 'Weed Control' },
  { match: /dethatch/i,                                     type: 'Dethatching Service' },
  { match: /top\s*dress/i,                                  type: 'Top Dressing' },
  { match: /aerat/i,                                        type: 'Lawn Aeration' },
  { match: /sod/i,                                          type: 'Sod Installation' },

  // Mosquito
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
  { match: /estimat|assessment|consultation/i,              type: 'Property Assessment' },
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
function normalizeServiceType(raw) {
  if (!raw) return 'General Service';

  // Strip duration/price suffixes: " - 1 hour", " - $117", " - 45 min"
  let cleaned = raw
    .replace(/\s*[-–]\s*\d+\s*(hour|hr|min|minute)s?\b/gi, '')
    .replace(/\s*[-–]\s*\$[\d,.]+/g, '')
    .replace(/\s*[-–]\s*$/g, '')
    .trim();

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
 * Detect the service category for color coding and icon assignment.
 */
function detectServiceCategory(serviceType) {
  const s = (serviceType || '').toLowerCase();
  if (s.includes('lawn') || s.includes('fertil') || s.includes('weed') || s.includes('dethatch') || s.includes('top dress') || s.includes('aerat') || s.includes('sod')) return 'lawn';
  if (s.includes('mosquito')) return 'mosquito';
  if (s.includes('termite') || s.includes('wdo') || s.includes('bora') || s.includes('trelona')) return 'termite';
  if (s.includes('tree') || s.includes('shrub') || s.includes('palm') || s.includes('arborjet')) return 'tree_shrub';
  if (s.includes('rodent') || s.includes('rat') || s.includes('mouse') || s.includes('mole')) return 'rodent';
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
  detectServiceCategory,
  serviceIcon,
  serviceColor,
  isNewCustomer,
  safeDate,
  safeDateLabel,
  SERVICE_TYPE_MAP,
};
