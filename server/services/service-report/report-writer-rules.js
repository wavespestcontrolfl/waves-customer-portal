/**
 * Owner rules for the AI report paragraph (GATE_REPORT_WRITER_RULES; owner
 * "go" 2026-09-30 on the combined report plan). One rules block for every
 * report writer, the rewrites that remove the older lines those rules
 * contradict, and the output screen that rejects what slips through.
 *
 * Lawn and tree/shrub/palm are OUT of this lane (owner 2026-09-30: another
 * lane owns them). Their prompts, inputs and screens must stay
 * byte-identical, so the selector only applies these rules to the recurring
 * pest writer and the remaining-service modules other than the two below.
 */
const { HUMAN_PROSE_RULES } = require('../llm/human-prose-rules');

const REPORT_WRITER_RULES_VERSION = 'report_writer_rules_v1';

// Remaining-service modules that belong to the lawn and tree/shrub/palm lanes.
const WRITER_RULES_EXCLUDED_MODULES = new Set(['physical_lawn', 'palm_care']);

const OWNER_RULES = `OWNER RULES — THE REPORT PARAGRAPH (these override every other instruction in this prompt)

The customer reads your two sections joined into ONE paragraph, with no headings. Write the second section so it continues the first without repeating it.

1. Shape. Exactly the two section titles, each followed by exactly ONE line of plain text: no line breaks inside a section, no bullets, no greeting, no sign-off, no customer-name header. About 80–140 words in all; write less when the record is thin.
2. Only what was recorded. Every statement must trace to the technician note, a recorded field, a structured finding line, or a technician-reviewed photo caption. Keep the technician's own words and hedges: never upgrade a general word to a species ("roaches" stays "roaches"), a suspicion to a diagnosis, or one room to the whole house. If a dictated word looks like a transcription error, leave it out rather than guess.
3. The customer's words. The booked reason, the customer's concern, and any calls, texts or emails are what the customer said, never a finding. Attribute them ("You mentioned…"). Never quote their messages, never say we read them, and never state that the technician confirmed something only the customer reported.
4. Every "none" stays local. State an absence only for the place and day the technician checked ("none were seen at the dishwasher today"). Never "all clear", "no problems", "nothing to worry about", or no activity for the whole property.
5. Products by job only. Never name a product, brand, trade name or active ingredient, and never use the word "chemical". Say what the product did: an insect-control treatment, bait, an insect growth regulator, a larvicide.
6. No amounts or measurements: no mL, cc, teaspoons, tablespoons, fluid ounces, ounces, gallons, pounds, grams, rates, mix strength, percentages, linear feet, square feet or acreage.
7. Never the word "safe" in any form ("safe once dry", "pet-safe", "safely"), and never "non-toxic" or "harmless". Give no re-entry, drying, rainfast or waiting time: the report's safety section covers re-entry.
8. Say nothing about EPA registration. If it ever must appear, only "EPA-registered" or "EPA-exempt", never "EPA-approved".
9. No prices, "free", "included", "covered", warranty, guarantee, bond, or "per visit". If a cadence must be named, say "per application".
10. The company is "Waves Pest Control", or "we". Never "Waves Pest Control & Lawn Care", "Waves Lawn Care" or "Waves Lawn & Pest".
11. No timeframes ("7–14 days", "a few days", "two weeks") and no next-visit date, day or arrival window.
12. Do not repeat what the report prints on its own: the product list, re-entry guidance, the next visit, the technician's tip, the "What to expect", rain and spider cards, the "What you flagged" card, and the activity gauge.
13. The report refuses these words, so never use them: infestation, infested, eliminated, eradicated, exterminated, resolved, solved, gone, cleared, "all clear", "is clear", "clear of pests", pest-free, any "-proof" word, guarantee, guaranteed, toxic, poison, poisonous, dangerous, deadly, unsafe.
14. Never mention a treatment map, a traced route or a treated outline.
15. Season, weather, prior visits and product labels are background. Never present them as something found today.

STYLE (the owner's prose rules; they never override the rules above)
${HUMAN_PROSE_RULES}
The technician's own hedges ("possible", "looks like") record how certain the technician was. They are facts, not style: keep them.`;

// Older prompt lines the owner rules contradict, rewritten in place so the
// model never sees both. Each [from, to] is an exact substring of a writer
// this lane covers (the shared v4 hard constraints, the recurring pest
// module, or the remaining-service core/adapter); report-writer-rules.test.js
// fails if any stops matching.
const PROMPT_REWRITES = Object.freeze([
  // v4 hard constraint 3: the coverage block it names is never built.
  ['A PRODUCT LABELED COVERAGE block may support a separate product-capability statement under the grounding rules below, but those label examples are never observations, visit targets, or proof that every listed species was treated. ', ''],
  // v4 hard constraint 4 invited active-ingredient names.
  [
    '4. **No brand names for products.** Use active ingredient names (fipronil, bifenthrin, imidacloprid, prodiamine, etc.) or functional descriptions (non-repellent residual, insect growth regulator, pre-emergent herbicide, systemic drench). If the active ingredient is not provided in the inputs, use the functional description only. When the copy tells the homeowner to DO something with a product, lead with the plain-language role, not a bare chemical name — "water in today\'s grub treatment", never "water in the clothianidin".',
    '4. **No product names of any kind.** Never name a product, brand, trade name, or active ingredient, and never use the word "chemical". Describe each product by its job in plain words (an insect-control treatment, bait, an insect growth regulator, a larvicide). When the copy tells the homeowner to DO something, lead with that plain-language role.',
  ],
  // v4 hard constraint 5: the parser accepts one line per section only.
  [
    '5. **Plain text only.** No markdown, no bold, no emojis, no bullet points, no headers in the output body. Just paragraphs under the two section titles.',
    '5. **Plain text only.** No markdown, no bold, no emojis, no bullet points, no headers in the output body. Under each of the two section titles write exactly ONE line of text, with no line breaks inside a section.',
  ],
  // v4 hard constraint 7: the dictated note holds work AND observations.
  [
    '   - **Completed work** (Service Notes, Actions completed, Areas serviced, Products applied, and the "Work recorded" lines of a STRUCTURED SERVICE FINDINGS block): what was actually done — safe to describe in WHAT WE DID.',
    '   - **Technician note** (the TECHNICIAN NOTE block): the technician\'s own words, often dictated. It can hold what was done, what was seen, what the customer said, and advice for later. Sort each sentence into the matching category below and never move a sentence into a different one.\n'
      + '   - **Completed work** (Actions completed, Areas serviced, Products applied, the "Work recorded" lines of a STRUCTURED SERVICE FINDINGS block, and technician-note sentences about work done): what was actually done — describe it in WHAT WE DID.',
  ],
  [
    '(Customer concern, and the "Customer communication" lines of a STRUCTURED SERVICE FINDINGS block)',
    '(Customer concern, the CUSTOMER\'S OWN WORDS block, technician-note sentences about what the customer said, and the "Customer communication" lines of a STRUCTURED SERVICE FINDINGS block)',
  ],
  [
    '(Observations, Pest activity rating, and ONLY the "Findings observed" lines',
    '(Observations, Pest activity rating, technician-note sentences about what was seen, and ONLY the "Findings observed" lines',
  ],
  [
    '(Recommendations, plus the "Recommendations recorded" lines',
    '(Recommendations, technician-note sentences of advice for later, plus the "Recommendations recorded" lines',
  ],
  // v4 hard constraint 9 assumed active-ingredient names were allowed.
  [
    '9. **Active ingredients come only from Products applied.** Never infer an active ingredient or product from an action label or area (e.g. "Exterior perimeter band" does not imply bifenthrin). If Products applied is empty, use functional descriptions only.',
    '9. **Never infer a product.** Never infer a product or what it does from an action label or area; describe only the recorded work.',
  ],
  // v4 hard constraint 11 still allowed a "justified" timeframe.
  [
    'Do not default to stock recovery windows like "7–14 days" or "10–14 days" — give a timeframe only when a specific product or the grounding context justifies one, and make it fit the situation.',
    'Never state a recovery or response timeframe of any kind (no "7–14 days", "a few days" or "two weeks").',
  ],
  // Recurring pest module: the next-step chip it names was retired, and the
  // coverage block it waits for is never built.
  [' Do not repeat the selected next-step line that the renderer appends after this copy.', ''],
  [
    '\n\nOnly when the separate PRODUCT LABELED COVERAGE block contains approved facts for products actually applied at the relevant site, add one concise capability sentence using this exact phrase: "also helps control other labeled crawling pests in the treated areas." Add at most a few supported examples. Keep them separate from organisms found and targets selected today. Never total overlapping lists or state a numeric coverage count. Never imply termite protection or a bond, rodent service, mosquito service, or another specialty service from a product label alone.',
    '',
  ],
  // Remaining-service core: actives and "explanatory contrasts" were allowed.
  [
    'Keep product brand names in the product table. In the main report, use a supplied active ingredient only when helpful; otherwise use an accurate functional description. More restrictive surface-specific naming rules take precedence.',
    'Keep product names in the product table. In the main report, never name an active ingredient; use an accurate functional description.',
  ],
  ['Necessary uncertainty, explanatory contrasts, and accurate repeated terms are allowed.', 'Necessary uncertainty and accurate repeated terms are allowed.'],
  // Remaining-service main adapter: one line per section, and the owner
  // rules now name what the report prints on its own.
  ['Return exactly these titles and plain-text paragraphs:', 'Return exactly these titles, each followed by exactly one line of plain text:'],
  [
    ' Preserve material limitations and required instructions rather than deleting them merely to meet a word target; the rendering layer must handle necessary length.',
    ' Preserve material limitations rather than deleting them merely to meet a word target.',
  ],
  [
    'A selected next step or mandatory aftercare appended by the renderer must not be repeated as another closing instruction. The caller must tell you which instruction is rendered separately.',
    'A next step or aftercare line the report prints on its own must not be repeated as another closing instruction; the OWNER RULES list what the report prints on its own.',
  ],
]);

// [header, ...parts] of a selected writer → the same writer with the owner
// rules first and every contradicted line rewritten.
function composeWriterRulesPrompt([header, ...parts]) {
  const joined = [header, `# ${REPORT_WRITER_RULES_VERSION}`, OWNER_RULES, ...parts].filter(Boolean).join('\n\n');
  return PROMPT_REWRITES.reduce((text, [from, to]) => text.split(from).join(to), joined);
}

// User-message labels the route uses while the rules apply.
const TECHNICIAN_NOTE_HEADER = "[TECHNICIAN NOTE — the technician's own words, often dictated; it may mix work done, what was seen, what the customer said, and advice for later: sort each sentence]";
const MAX_TECHNICIAN_NOTE_CHARS = 3000;
const CUSTOMER_WORDS_HEADER = "CUSTOMER'S OWN WORDS (recent messages and call summaries; context only, never a finding)";

function withheldProductsLine(count) {
  return count > 0
    ? `Products applied: ${count} recorded. Names, amounts and rates are withheld on purpose; APPLICATION DETAILS, when present, gives each product's job, method and area.`
    : 'Products applied: None recorded';
}

// Active ingredients the model might recall on its own. This visit's catalog
// actives are screened too (the route passes them); this list catches the
// common ones a product on another visit carries.
const COMMON_ACTIVE_INGREDIENTS = Object.freeze([
  'fipronil', 'bifenthrin', 'imidacloprid', 'indoxacarb', 'lambda-cyhalothrin', 'gamma-cyhalothrin',
  'cyhalothrin', 'deltamethrin', 'cyfluthrin', 'permethrin', 'cypermethrin', 'esfenvalerate',
  'etofenprox', 'prallethrin', 'tetramethrin', 'imiprothrin', 'cyphenothrin', 'phenothrin',
  'pyrethrin', 'pyrethrins', 'piperonyl butoxide', 'dinotefuran', 'thiamethoxam', 'clothianidin',
  'acetamiprid', 'chlorfenapyr', 'hydramethylnon', 'abamectin', 'avermectin', 'emamectin',
  'spinosad', 'spinetoram', 'pyriproxyfen', 'methoprene', 'hydroprene', 'novaluron',
  'noviflumuron', 'hexaflumuron', 'diflubenzuron', 'lufenuron', 'chlorantraniliprole',
  'cyantraniliprole', 'metaflumizone', 'sulfluramid', 'boric acid', 'orthoboric acid', 'octaborate',
  'bromadiolone', 'brodifacoum', 'difethialone', 'diphacinone', 'chlorophacinone', 'bromethalin',
  'cholecalciferol', 'bendiocarb', 'carbaryl', 'propoxur', 'chlorpyrifos', 'malathion', 'naled',
  'temephos',
]);

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function activeIngredientPattern(name) {
  const words = String(name || '').toLowerCase()
    .replace(/[^a-z\s-]+/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);
  if (!words.length || words.join('').length < 5) return null;
  return words.map(escapeRe).join('[\\s-]*');
}

// Catalog active_ingredient text ("Fipronil 9.1%, Pyriproxyfen") → names.
function activeIngredientNames(values) {
  return (Array.isArray(values) ? values : [])
    .flatMap((value) => String(value || '').split(/[,;/+&]|\band\b/i))
    .map((part) => part.replace(/[\d.]+\s*%?/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((part) => part.length >= 5);
}

const UNIT_WORD_RE = /\b(?:ml|mls|milliliters?|millilitres?|liters?|litres?|tsp|teaspoons?|tbsp|tablespoons?|fl\.?\s*oz|fluid\s+ounces?|oz|ounces?|pints?|quarts?|gal|gallons?|lbs?|pounds?|grams?|kilograms?|kg)\b|\b\d+(?:[.,]\d+)?\s*cc\b/i;
const FOOTAGE_RE = /\b(?:linear|square|sq\.?)\s*(?:feet|foot|ft)\b|\bsqft\b|\b\d[\d,.]*\s*(?:-|–)?\s*(?:ft|feet|foot|acres?)\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred)\s+(?:linear\s+|square\s+)?(?:feet|foot)\b/i;
const PERCENT_RE = /\b\d+(?:\.\d+)?\s*(?:%|percent\b)/i;
const PER_VISIT_RE = /\bper[\s-]+visit\b/i;
const COMPANY_NAME_RE = /\bWaves\s+(?:Pest\s+Control\s*(?:&|&amp;|and)\s*Lawn\b|Lawn\b)/i;
const SAFE_WORD_RE = /\b(?:safe|safer|safest|safely|unsafe|non-?toxic|harmless)\b/i;
const CHEMICAL_RE = /\bchemicals?\b/i;

// Returns a short rejection reason, or null when the copy passes. Runs on
// top of the report's existing screens (banned words, access codes, shape,
// this visit's trade names), only while the rules apply.
function writerRulesRejection(text, { activeIngredients = [] } = {}) {
  const copy = String(text || '');
  if (UNIT_WORD_RE.test(copy)) return 'amount';
  if (FOOTAGE_RE.test(copy)) return 'footage';
  if (PERCENT_RE.test(copy)) return 'percent';
  if (PER_VISIT_RE.test(copy)) return 'per_visit';
  if (COMPANY_NAME_RE.test(copy)) return 'company_name';
  if (SAFE_WORD_RE.test(copy)) return 'safe_word';
  if (CHEMICAL_RE.test(copy)) return 'chemical';
  const patterns = [...COMMON_ACTIVE_INGREDIENTS, ...activeIngredientNames(activeIngredients)]
    .map(activeIngredientPattern)
    .filter(Boolean);
  if (patterns.length && new RegExp(`\\b(?:${[...new Set(patterns)].join('|')})\\b`, 'i').test(copy)) {
    return 'active_ingredient';
  }
  return null;
}

module.exports = {
  REPORT_WRITER_RULES_VERSION,
  WRITER_RULES_EXCLUDED_MODULES,
  OWNER_RULES,
  PROMPT_REWRITES,
  composeWriterRulesPrompt,
  TECHNICIAN_NOTE_HEADER,
  MAX_TECHNICIAN_NOTE_CHARS,
  CUSTOMER_WORDS_HEADER,
  withheldProductsLine,
  COMMON_ACTIVE_INGREDIENTS,
  writerRulesRejection,
};
