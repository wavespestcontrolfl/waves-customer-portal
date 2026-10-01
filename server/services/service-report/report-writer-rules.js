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

const REPORT_WRITER_RULES_VERSION = 'report_writer_rules_v2';

// Remaining-service modules that belong to the lawn and tree/shrub/palm lanes.
const WRITER_RULES_EXCLUDED_MODULES = new Set(['physical_lawn', 'palm_care']);

const OWNER_RULES = `OWNER RULES — THE SERVICE REPORT (these override every other instruction in this prompt)

The customer reads four sections, in this order, each under its own title:
WHAT WE FOUND: what the customer told us and what the technician saw today, with earlier visits when they show a pattern.
WHAT WE DID AND WHY: each piece of work, where it went, and why it fits what was found.
WHAT TO EXPECT: how today's work should change what the customer sees, from the EXPECTATIONS lines only.
WHAT'S NEXT: what we will check or do next, what the customer can do, and when to contact us.

1. Shape. Exactly the four titles above, in that order, each on its own line and followed by one to three short plain-text paragraphs (one to three sentences each). No bullets, no greeting, no sign-off, no customer-name header. Length follows the record: a visit with history, several treatments or open questions gets more; a thin record gets a sentence or two per section. Never pad, and never make the same point in two sections. If a section has nothing grounded to say, write one honest sentence (with no EXPECTATIONS lines, say what the technician will look for next time).
2. Only what was recorded. Every statement must trace to the technician note, a recorded field, a structured finding line, a technician-reviewed photo caption, or a supplied record (EXPECTATIONS, HOW IT WORKS, NEXT VISIT, SERVICE TYPE, REACH-OUT DATE, prior visits). Keep the technician's own words and hedges: never upgrade a general word to a species ("roaches" stays "roaches"), a suspicion to a diagnosis, or one room to the whole house. Keep conditions the technician recorded ("dry and calm") when they bear on the work. If a dictated word looks like a transcription error, leave it out rather than guess.
3. The customer's words. The booked reason, the customer's concern, and any calls, texts or emails are what the customer said, never a finding. Attribute them ("You mentioned…") and keep each remark with its own place and time: never merge two remarks into one. Never quote their messages, never say we read them, and never state that the technician confirmed something only the customer reported.
4. Every "none" stays local. State an absence only for the place and day the technician checked ("none were seen at the dishwasher today"). Never "all clear", "no problems", "nothing to worry about", or no activity for the whole property.
5. Products by job, and why. Never name a product, brand, trade name or active ingredient, and never use the word "chemical". Describe each product by its job (bait, an insect-control treatment, an insect growth regulator, a larvicide). For each piece of work, give one plain clause on why it fits what was found, taken from HOW IT WORKS or EXPECTATIONS; when neither covers it, describe the work without a reason. Those lines explain how a product works, never where or how it was applied today: the place and method come only from the record. Never add a mechanism, pest, residual period or effect they do not state.
6. No amounts or measurements: no mL, cc, teaspoons, tablespoons, fluid ounces, ounces, gallons, pounds, grams, rates, mix strength, percentages, linear feet, square feet or acreage.
7. Never the word "safe" in any form ("safe once dry", "pet-safe", "safely"), and never "non-toxic" or "harmless". Give no re-entry, drying, rainfast or waiting time and no aftercare or safety instructions: the report's own sections cover them.
8. Say nothing about EPA registration. If it ever must appear, only "EPA-registered" or "EPA-exempt", never "EPA-approved".
9. No prices, "free", "included", "covered", warranty, guarantee, bond, or "per visit". If a cadence must be named, say "per application".
10. The company is "Waves Pest Control", or "we". Never "Waves Pest Control & Lawn Care", "Waves Lawn Care" or "Waves Lawn & Pest".
11. Timeframes and dates. A timeframe ("a few days", "about 1–2 weeks") may appear only in WHAT TO EXPECT and WHAT'S NEXT, and only in the words of an EXPECTATIONS line: never invent, stretch, convert or combine one. Never write a calendar date, weekday or arrival window, except an earlier visit's date and the REACH-OUT DATE when one is supplied, written exactly as supplied. The report prints the next visit's date and arrival window at the top of WHAT'S NEXT: call it "your next visit" and never restate its date.
12. Do not repeat what the report prints on its own: the product list, each product's "How it works" line word for word, re-entry and aftercare guidance, the next visit's date and window, the technician's tip, the rain and spider cards, the "What you flagged" card, and the activity gauge's number or scale. A short clause on why a treatment fits this problem is not repetition. The activity level in words ("light activity along the fence") is what the technician saw and belongs in WHAT WE FOUND.
13. The report refuses these words, so never use them: infestation, infested, eliminated, eradicated, exterminated, resolved, solved, gone, cleared, "all clear", "is clear", "clear of pests", pest-free, any "-proof" word, guarantee, guaranteed, toxic, poison, poisonous, dangerous, deadly, unsafe.
14. Never mention a treatment map, a traced route or a treated outline.
15. History. Prior visits, season, weather and labels are background. Mention an earlier visit only when it bears on today's problem (the same pest or the same spot), always marked as past with its date, and skip visits with nothing to add. Absences in history stay local too. Never present history as something found today, and never say things are better or worse unless the records show both sides.
16. Next time. Say what we will check or do at the next visit only when the technician note or a recorded recommendation says so; otherwise just point to the next visit. Never promise a visit, a return trip, a result, or more checks than the record shows.
17. When to reach out. End WHAT'S NEXT with when to contact us: tie it to the REACH-OUT DATE when one is supplied, otherwise to an EXPECTATIONS timeframe or a sign the customer can notice. Never ask the customer to watch something only the technician tracks.

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
    '5. **Plain text only.** No markdown, no bold, no emojis, no bullet points. Use only the four section titles in the OWNER RULES, each followed by short plain-text paragraphs.',
  ],
  // v4 hard constraint 6: length follows the record.
  [
    '6. **Length.** Each section should be 2–4 sentences. Together, both sections should total roughly 80–140 words. This is a report block, not an essay.',
    '6. **Length.** Let the record decide: more when the visit, its history or the customer\'s questions call for it, less for a thin record. Never pad.',
  ],
  // v4 hard constraint 7: the dictated note holds work AND observations.
  [
    '   - **Completed work** (Service Notes, Actions completed, Areas serviced, Products applied, and the "Work recorded" lines of a STRUCTURED SERVICE FINDINGS block): what was actually done — safe to describe in WHAT WE DID.',
    '   - **Technician note** (the TECHNICIAN NOTE block): the technician\'s own words, often dictated. It can hold what was done, what was seen, what the customer said, and advice for later. Sort each sentence into the matching category below and never move a sentence into a different one.\n'
      + '   - **Completed work** (Actions completed, Areas serviced, Products applied, the "Work recorded" lines of a STRUCTURED SERVICE FINDINGS block, and technician-note sentences about work done): what was actually done — describe it in WHAT WE DID AND WHY.',
  ],
  [
    '(Customer concern, and the "Customer communication" lines of a STRUCTURED SERVICE FINDINGS block)',
    '(Customer concern, the WHAT THE CUSTOMER TOLD US block, technician-note sentences about what the customer said, and the "Customer communication" lines of a STRUCTURED SERVICE FINDINGS block)',
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
  // v4 hard constraint 11: timeframes only in the approved wording, and
  // earlier visits cited by their supplied dates.
  [
    'Never state how long someone has been a customer, how many visits they\'ve had, or "X years/seasons" unless that number is explicitly provided.',
    'Never state how long someone has been a customer or "X years/seasons" unless that number is explicitly provided; cite an earlier visit only by its supplied date.',
  ],
  [
    'Do not default to stock recovery windows like "7–14 days" or "10–14 days" — give a timeframe only when a specific product or the grounding context justifies one, and make it fit the situation.',
    'Give a recovery or response timeframe only in the words of an EXPECTATIONS line.',
  ],
  // Recurring pest module: the four-section shape, length by the record.
  [
    'Return exactly the existing WHAT WE DID / WHAT WE FOUND plain-text structure. Usually write 2–3 sentences for completed work and 2–4 sentences for findings, expectations, and supported nonduplicative follow-up. Target about 80–140 words, but write less for thin records.',
    'Return the four-section plain-text structure in the OWNER RULES. Length follows the record; write less for thin records.',
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
  // Remaining-service core and modules: aftercare, precautions and next
  // visits belong to the report's own sections under the owner rules.
  [
    'Preserve validated safety and aftercare instructions and their conditions. Do not create',
    'Leave safety, re-entry and aftercare instructions to the report\'s own sections. Do not create',
  ],
  [
    'State the recorded next program check or approved review plan without inventing a date. Use the existing approved device-handling instructions; do not encourage',
    'Name the next program check without its date, day or window (the report prints them at the top of WHAT\'S NEXT). Leave device-handling instructions to the report\'s own sections; do not encourage',
  ],
  ['Relay only the approved site-specific precautions or referral.', 'Name a recorded referral; leave site precautions to the report\'s own sections.'],
  [
    'Keep validated aftercare and any site constraints intact, without adding rates, dilution, re-entry periods, or homeowner digging/drilling instructions.',
    'Leave aftercare and site precautions to the report\'s own sections, and never add rates, dilution, re-entry periods, or homeowner digging/drilling instructions.',
  ],
  [
    'Protect the actual product aftercare and do not add homeowner drill, foam, or wood-removal directions.',
    'Leave product aftercare to the report\'s own sections and do not add homeowner drill, foam, or wood-removal directions.',
  ],
  [
    'Preserve approved cleaning and aftercare details, including any conditions about treated surfaces or re-entry.',
    'Leave cleaning, aftercare and re-entry details to the report\'s own sections.',
  ],
  [
    'Use the approved next step and aftercare, without creating veterinary instructions,',
    'Name a recorded next step without a date and leave aftercare to the report\'s own sections; never create veterinary instructions,',
  ],
  [
    'Use the approved preparation and aftercare instructions and keep them consistent with the recorded method.',
    'Leave preparation and aftercare instructions to the report\'s own sections.',
  ],
  ['Relay approved site precautions and next steps.', 'Leave site precautions to the report\'s own sections; name a recorded next step without a date.'],
  // Recurring pest module: aftercare belongs to the report's own sections.
  [
    'Explain a response, limitation, aftercare instruction, or conducive condition only from supplied approved context.',
    'Explain a response, limitation, or conducive condition only from supplied approved context; leave aftercare instructions to the report\'s own sections.',
  ],
  // Remaining-service main adapter: the four sections, length by the
  // record, and the owner rules name what the report prints on its own.
  ['OUTPUT ADAPTER — MAIN TWO-SECTION REPORT', 'OUTPUT ADAPTER — MAIN REPORT'],
  [
    'Return exactly these titles and plain-text paragraphs:\n\nWHAT WE DID\n\nUsually 2–3 sentences describing the relevant work actually completed, where or how it occurred, and its supported purpose. Inspection-only and monitoring visits describe their actual work without implying an application.\n\nWHAT WE FOUND\n\nUsually 2–4 sentences describing the observed condition or attributed concern, its supported meaning, any verified progress or remaining limitation, and a relevant approved next step when it is not rendered elsewhere.\n\nTarget approximately 80–140 words across both sections. Write less with thin inputs.',
    'Return exactly these titles, in this order, each followed by short plain-text paragraphs:\n\nWHAT WE FOUND\n\nWhat the customer told us and what was observed today, with supported history.\n\nWHAT WE DID AND WHY\n\nThe work actually completed, where it went, and why it fits what was found. Inspection-only and monitoring visits describe their actual work without implying an application.\n\nWHAT TO EXPECT\n\nHow today\'s work should change what the customer sees, from the EXPECTATIONS lines only.\n\nWHAT\'S NEXT\n\nThe next check or step, the customer\'s own task, and when to contact us.\n\nLength follows the record. Write less with thin inputs.',
  ],
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
const CUSTOMER_WORDS_HEADER = 'WHAT THE CUSTOMER TOLD US (their own texts and emails, and AI summaries of calls; context only, never a finding)';

// scheduled_services.customer_request* (why the customer booked; filled by
// the re-service page, self-booking and AI call bookings).
const BOOKED_REASON_SOURCES = Object.freeze({
  picker: 'typed on the re-service page',
  text: 'sent by text',
  call: 'from a phone call; an AI summary of what they said, not their exact words',
  office: 'taken down by the office',
});
// The customer typed this, so it gets the customer-words scrub (pest talk
// only, access details dropped); without a scrub it is left out, never
// passed on raw.
function bookedReasonBlock(row, scrub) {
  if (typeof scrub !== 'function') return '';
  let pests = row?.customer_request_pests;
  if (typeof pests === 'string') {
    try { pests = JSON.parse(pests); } catch { pests = []; }
  }
  const pestWords = (Array.isArray(pests) ? pests : [])
    .map((pest) => String(pest || '').replace(/[_-]+/g, ' ').trim())
    .filter(Boolean);
  const text = scrub(String(row?.customer_request || '').trim()).trim();
  if (!text && !pestWords.length) return '';
  const source = Object.hasOwn(BOOKED_REASON_SOURCES, row?.customer_request_source)
    ? BOOKED_REASON_SOURCES[row.customer_request_source]
    : 'recorded at booking';
  return [
    `BOOKED REASON (why the customer booked this visit, ${source}; attribute it with "You asked us…" or "You mentioned…", never a finding)`,
    text ? `Reason: ${text}` : null,
    pestWords.length ? `Pests picked: ${pestWords.join(', ')}` : null,
  ].filter(Boolean).join('\n');
}

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
  'temephos', 'bacillus thuringiensis', 'bti', 'bacillus sphaericus', 'lysinibacillus sphaericus',
]);

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function activeIngredientPattern(name) {
  // A name that carries digits ("2,4-D") is matched as written, spacing
  // loose.
  if (/\d/.test(String(name || ''))) {
    return escapeRe(String(name).toLowerCase().trim()).replace(/\s+|(?<=[,-])|(?=[,-])/g, '\\s*');
  }
  const words = String(name || '').toLowerCase()
    .replace(/[^a-z\s-]+/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);
  // Three letters is the shortest real active in the catalog (Bti).
  if (!words.length || words.join('').length < 3) return null;
  return words.map(escapeRe).join('[\\s-]*');
}

// Catalog active_ingredient text ("Fipronil 9.1%, Pyriproxyfen",
// "Bacillus thuringiensis israelensis (Bti)") → names, aliases included.
// Devices carry a descriptive placeholder there ("Mechanical snap trap"),
// which is not a chemical and must never make its own words forbidden.
const NON_CHEMICAL_ACTIVE_RE = /\b(?:mechanical|traps?|glue|devices?|stations?|monitors?|equipment|none|n\/?a|not\s+applicable|no\s+active|unknown|test\s+product)\b/i;
// A lone nutrient, material or label word left by the split ("Iron + N
// (foliar)", "Prodiamine (preemergent)") is not a name to screen: "the
// wrought iron fence" and "copper mesh" are ordinary copy.
const GENERIC_ACTIVE_WORD_RE = /^(?:iron|nitrogen|potash|potassium|phosphate|phosphorus|sulfur|sulphur|manganese|magnesium|zinc|calcium|copper|boron|micronutrients?|foliar|pre-?emergent|post-?emergent|surfactant|fertilizer|water|oil|soap|clay|sand|kelp|mesh)$/i;
function activeIngredientNames(values) {
  return (Array.isArray(values) ? values : [])
    .filter((value) => !NON_CHEMICAL_ACTIVE_RE.test(String(value || '')))
    // A comma between digits belongs to a name ("2,4-D"), not a list.
    .flatMap((value) => String(value || '').split(/(?<!\d),|,(?!\d)|[;/+&()]|\band\b/i))
    // Concentrations go ("Fipronil 9.1%"); a digit inside a name stays.
    .map((part) => part.replace(/\b\d+(?:[.,]\d+)?\s*%/g, ' ').replace(/(?:^|\s)\d+(?:\.\d+)?(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((part) => part.length >= 3 && !GENERIC_ACTIVE_WORD_RE.test(part));
}

// Whether text names any active in a catalog active_ingredient value (a
// note that says "azoxystrobin" with no product name beside it).
function activeIngredientsMentioned(text, value) {
  const patterns = activeIngredientNames([value]).map(activeIngredientPattern).filter(Boolean);
  return patterns.length > 0 && new RegExp(`\\b(?:${patterns.join('|')})\\b`, 'i').test(String(text || ''));
}

const UNIT_WORD_RE = /\b(?:ml|mls|milliliters?|millilitres?|liters?|litres?|cc|ccs|cubic\s+centimet(?:er|re)s?|tsp|teaspoons?|tbsp|tablespoons?|fl\.?\s*oz|fluid\s+ounces?|oz|ounces?|pints?|quarts?|gals?|gallons?|qts?|ozs|pts?|tsps|tbsps|lbs?|pounds?|grams?|kilograms?|kgs?)\b|\b\d+(?:[.,]\d+)?\s*(?:cc|gals?|qts?|ozs?|pts?|tsps?|tbsps?|kgs?|g)\b/i;
const FOOTAGE_RE = /\b(?:linear|square|sq\.?)\s*(?:feet|foot|ft|yards?|yds?)\b|\bsqft\b|\b\d[\d,.]*\s*(?:-|–)?\s*(?:ft|feet|foot)\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\s+(?:linear\s+|square\s+)?(?:feet|foot|lf|sf|lin\.?\s*ft|sq\.?\s*yds?)\b|\b\d[\d,.]*\s*(?:-|–)?\s*(?:lf|sf|lin\.?\s*ft|sq\.?\s*yds?)\b|\bacres?\b|\bacreage\b/i;
// Any percentage, spelled or not ("50%", "five percent").
const PERCENT_RE = /\d\s*%|\bpercent(?:age)?s?\b/i;
const PER_VISIT_RE = /\bper[\s-]+visit\b/i;
// Every "Waves …" name but exactly "Waves Pest Control". Case-sensitive:
// "Waves" followed by any capitalized word but "Pest Control" ("Waves Home
// Services", "Waves Lawn"), or "Waves Pest Control" followed by a
// capitalized word, "&" or "and Lawn" ("… Services", "… LLC", "… & Lawn
// Care"). Lowercase business suffixes are caught too.
const COMPANY_NAME_RE = /\bWaves\s+(?!Pest\s+Control\b)[A-Z&]|\bWaves\s+Pest\s+Control\s+(?:[A-Z&]|and\s+[Ll]awn\b)|\bWaves\s+Pest\s+Control(?:\s*,\s*|\s+)(?:of\s+[A-Z]|L\.?L\.?C\b|Inc\b|Co\b|Corp\b|Company\b)|\b[Ww]aves\s+(?:pest\s+control\s+)?(?:services?|llc|inc|company|lawn|home|exterminat\w*)\b/;
// Rates and mix strength in words ("at the label rate", "the recorded mix
// strength", "diluted").
const RATE_RE = /\brates?\b|\bmix(?:ing)?\s+(?:strength|ratio)\b|\bdilut(?:e|ed|ion)\b|\bconcentrat(?:e|ed|ion)\b|\bper\s+(?:gallon|1,?000)\b/i;
const SAFE_WORD_RE = /\b(?:safe|safer|safest|safely|unsafe|non-?toxic|harmless)\b/i;
const CHEMICAL_RE = /\bchemicals?\b/i;
// Forward-looking timeframes (rule 11): "7–14 days", "over the next two
// weeks", "within 24 hours", "for a few days". A past window ("in the seven
// days before the visit", "two weeks ago") is a fact and passes.
// "A"/"an" count ("continue for a week") but not in a frequency ("twice a
// day", "three times a week").
const DURATION_NUMBER = '(?:\\d+|a\\s+few|a\\s+couple(?:\\s+of)?|several|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|twenty|thirty|sixty|ninety|(?<!\\b(?:times|once|twice)\\s)an?)';
const DURATION_UNIT = '(?:days?|weeks?|months?|hours?|hrs?|minutes?|mins?)';
// Forward context only: "within", "in/over/for/during the next", "in two
// weeks", "up to", a range ("7–14 days"), or a future/expectation word
// earlier in the clause ("activity may continue for a few days"). A past
// duration ("you saw ants for two weeks", "during the last two weeks",
// "two weeks ago") passes.
const TIMEFRAME_RE = new RegExp(
  `\\b\\d+\\s*(?:-|–|to)\\s*\\d+\\s*${DURATION_UNIT}\\b(?!\\s+(?:before|ago|earlier|prior))`
  + `|\\b(?:within|up\\s+to|(?:in|over|for|during)\\s+the\\s+(?:next|coming|first))\\s+(?:\\w+\\s+)?${DURATION_NUMBER}\\s+${DURATION_UNIT}\\b`
  + `|\\bin\\s+${DURATION_NUMBER}\\s+${DURATION_UNIT}\\b(?!\\s+(?:before|ago|earlier|prior))`
  + `|\\bnext\\s+${DURATION_NUMBER}\\s+${DURATION_UNIT}\\b`
  // "takes"/"lasts" only: "the last two weeks" is history.
  + `|\\b(?:will|should|may|might|can|could|expect(?:ed)?|takes|lasts|continues?|keeps?\\s+working)\\b[^.!?]{0,40}?\\b${DURATION_NUMBER}\\s+${DURATION_UNIT}\\b(?!\\s+(?:before|ago|earlier|prior))`
  // With no number at all: "over the coming days", "in the days ahead",
  // "in the weeks to come", "over the next few weeks".
  + `|\\b(?:in|over|during|for|within)\\s+the\\s+(?:coming|next|upcoming)\\s+(?:few\\s+|several\\s+|couple\\s+(?:of\\s+)?)?${DURATION_UNIT}`
  + `|\\bin\\s+the\\s+${DURATION_UNIT}\\s+ahead\\b|\\b${DURATION_UNIT}\\s+to\\s+come\\b`
  // "Next month" is always ahead ("the next day" can be history).
  + '|\\bnext\\s+(?:month|year|season|quarter)\\b',
  'i',
);
// The duration phrases inside supplied EXPECTATIONS lines ("a few days",
// "1–2 weeks", "a week"): the only timeframes the writer may use (rule 11).
const DURATION_PHRASE_RE = new RegExp(`\\b(?:\\d+\\s*(?:-|–|to)\\s*\\d+\\s*${DURATION_UNIT}|${DURATION_NUMBER}\\s+${DURATION_UNIT})\\b`, 'gi');
function groundedTimeframePhrases(lines) {
  return [...new Set((Array.isArray(lines) ? lines : [])
    .flatMap((line) => String(line || '').match(DURATION_PHRASE_RE) || [])
    .map((phrase) => phrase.replace(/\s+/g, ' ').trim())
    .filter(Boolean))];
}
// An allowed phrase matches with loose spacing and either dash.
function allowedPhrasePattern(phrase) {
  return String(phrase || '').trim().split(/\s+/)
    .map((word) => escapeRe(word).replace(/[-–]/g, '[-–]'))
    .join('\\s+');
}

// Customer messages are never quoted (rule 3): an attributed quotation
// ("You said, “ants are everywhere”", "you texted 'roaches again'") or any
// double-quoted run of three or more words. An apostrophe ("the customer's
// kitchen") opens no quote, and a paraphrase ("You mentioned ants near the
// dishwasher") passes. Each quoted span is found once and its words counted
// in code, so a long unclosed quote costs one linear scan.
const ATTRIBUTED_QUOTE_RE = /\b(?:you|they|the\s+(?:customer|homeowner|owner|tenant))\s+(?:said|wrote|texted|emailed|mentioned|told|reported|asked|noted)\b[^.!?]{0,30}?(?:[:,]\s*|\s+)["“‘']\w/i;
// The same attribution after a quotation ("‘Roaches again by the sink,’ you
// said"), however long; an apostrophe between letters ("it's") stays inside
// the quote, any other quote mark ends the scan, and a quote mark right
// after a letter never opens one, so it stays linear.
const REVERSE_ATTRIBUTED_QUOTE_RE = /(?<!\w)[‘'"“]\w(?:[^"“”‘’'\n]|(?<=\w)['’](?=\w)){2,}?[’'"”]\s*,?\s*(?:you|they|the\s+(?:customer|homeowner|owner|tenant))\s+(?:said|wrote|texted|emailed|mentioned|told|reported|asked|noted)\b/i;
// A span ends at the next opening quote too, so many unclosed quotes still
// cost one linear pass.
const QUOTED_SPAN_RE = /["“]([^"“”\n]*)["”]/g;
// Single-quoted runs too ("According to you, 'ants are back by the sink'"),
// opened and closed only away from letters so "the customer's kitchen" is
// no quote; an apostrophe between letters stays inside, any other quote mark
// ends the span.
const SINGLE_QUOTED_SPAN_RE = /(?<!\w)['‘]((?:[^'‘’\n]|(?<=\w)['’](?=\w))*)['’](?!\w)/g;
const wordCount = (text) => text.trim().split(/\s+/).filter(Boolean).length;
function quotesCustomer(copy) {
  if (ATTRIBUTED_QUOTE_RE.test(copy) || REVERSE_ATTRIBUTED_QUOTE_RE.test(copy)) return true;
  return [...copy.matchAll(QUOTED_SPAN_RE), ...copy.matchAll(SINGLE_QUOTED_SPAN_RE)].some((match) => wordCount(match[1]) >= 3);
}
// The activity gauge's number or scale (rule 12) in any form: "the rating
// was 2", "rated two out of five", "2 on the five-point scale". The level in
// words ("activity was light") and a count of a set ("2 of 5 stations",
// "two out of five stations") pass.
const GAUGE_RE = /\b(?:rat(?:ed|ing)|scored?|gauge|level)\s+(?:(?:was|is|of|at|read|a|an)\s+)*(?:[0-5]|zero|one|two|three|four|five)\b|\b(?:[0-5]|zero|one|two|three|four|five)\s+out\s+of\s+(?:5|five)\b(?!\s+[a-z]{2,}s\b)|\b(?:five|5)[\s-]*point\s+scale\b|\bscale\s+of\s+(?:0|1|zero|one)\b/i;
// Money and entitlement (rule 9). ENTITLEMENT_RE catches the predicate
// forms ("the next check is free", "the follow-up is included") but not a
// physical state ("covered by mulch", "free of standing water").
const ENTITLEMENT_RE = /\b(?:is|are|was|were|be|comes?)\s+(?:(?:completely|totally|also|fully)\s+)?(?:free|included|covered)\b(?!\s+(?:by|with|in|under|of|from|on)\b)/i;
const PRICE_RE = /\$\s?\d|\b(?:dollars?|bucks|cents|usd|costs?|costing|price[ds]?|pricing|fees?|invoice[ds]?|billing|payments?|complimentary)\b|\b(?:(?:visit|follow-?up|recheck|re-?treatment|treatment|application|re-?service|service|inspection|call-?back|check|trip)s?|it|this|that|these|those|they)(?:['’]s|\s+(?:is|are|was|were|will\s+be|comes?|came))\s+on\s+the\s+house\b|(?<!\bin\s)\bcharg(?:e|es|ed|ing)\b|\b(?:free\s+(?:of\s+charge|re-?treatments?|re-?services?|service|visits?|follow-?ups?|call-?backs?|inspections?)|at\s+no\s+(?:extra\s+|additional\s+)?(?:cost|charge)|no\s+(?:extra\s+|additional\s+)?charge|warrant(?:y|ies|ied)|included\s+(?:in|with)\s+(?:your|the)\s+(?:plan|program|membership|service|agreement)|covered\s+(?:by|under)\s+(?:your|the)\s+(?:plan|program|membership|warranty|agreement|bond))\b/i;
// Next-visit dates, days and times (rule 11): the report prints the
// appointment itself. "October 7", "next Tuesday", "10 AM".
// "May" only capitalized, so "activity may 2…" is not a date. A date is
// refused only with a forward cue: "On September 15, we noted…" is history
// the grounding supplies; "your next visit is October 7" is the appointment.
// Numeric dates ("10/7", "10/07/2026", "2026-10-07"); a fraction of a set
// ("4/5 stations", "3/4 of the yard") is not a date.
const NUMERIC_DATE_RE = /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?!\s+(?:of\b|[a-z]{2,}s\b)))\b/g;
const MONTH_DAY_RE = /\b(?:[Jj]an(?:uary)?|[Ff]eb(?:ruary)?|[Mm]ar(?:ch)?|[Aa]pr(?:il)?|May|[Jj]une?|[Jj]uly?|[Aa]ug(?:ust)?|[Ss]ept?(?:ember)?|[Oo]ct(?:ober)?|[Nn]ov(?:ember)?|[Dd]ec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/g;
// "Came back on Tuesday" is history; "we'll be back Tuesday" is not.
const FUTURE_CUE_BEFORE_RE = /\b(?:next|upcoming|scheduled|appointment|return(?:ing)?|be\s+back|come\s+back|see\s+you|will|shall|(?:we|you|i)['’]ll|going\s+to|plan(?:s|ned)?\s+to|until|by|coming)\b/i;
const FUTURE_CUE_AFTER_RE = /^[^.!?]{0,30}\b(?:next|upcoming)\s+(?:visit|appointment|service|check)\b/i;
// A clock time is refused on the same terms, plus an arrival cue ("we'll
// arrive between 8 and 10 AM", "your window is 10 AM"); an observation
// ("strongest after 8 PM") or a past arrival ("we arrived at 10 AM") passes.
const CLOCK_RE = /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])|\b(?:noon|midnight|midday)\b/gi;
const ARRIVAL_CUE_RE = /\b(?:arriv(?:e|al|ing)|window)\b/i;
// A part of the day is an arrival window only beside the visit itself
// ("your next visit is in the morning", "we will arrive this afternoon");
// "mosquitoes will be most active in the evening" is behavior, so a bare
// "will" is no cue here.
const DAY_PART_RE = /\b(?:morning|afternoon|evening)s?\b/gi;
const VISIT_CUE_RE = /\b(?:next|upcoming|scheduled|appointment|arriv(?:e|al|ing)|window|return(?:ing)?|be\s+back|come\s+back|see\s+you)\b/i;
function forwardMention(copy, pattern, extraCue = null, beforeCue = FUTURE_CUE_BEFORE_RE) {
  for (const match of copy.matchAll(pattern)) {
    const before = copy.slice(Math.max(0, match.index - 40), match.index).split(/[.!?]/).pop();
    const after = copy.slice(match.index + match[0].length);
    if (beforeCue.test(before) || extraCue?.test(before) || FUTURE_CUE_AFTER_RE.test(after)) return true;
  }
  return false;
}
// Forward words only: "you texted us on Monday" is a past fact.
// "Tomorrow" and "next week" are always ahead; a bare weekday ("we will
// return Tuesday") takes the date cues.
const WEEKDAY_RE = /\b(?:(?:next|this|coming|by|until)\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|next\s+week(?:end)?|later\s+this\s+week)\b/i;
const BARE_WEEKDAY_RE = /\b(?:mon|tues|wednes|thurs|fri|satur|sun)days?\b/gi;
// A property-wide absence (rule 4): "no pest activity was observed today",
// "found no active pests during the visit", "none were observed", "no
// activity of any kind", "none seen by the technician". An absence passes
// only when its sentence names a place or set that was checked ("no
// activity at the lanai", "the other 10 stations showed no termite
// activity", "within the assessed areas"), or points back at one with
// "there" ("You mentioned ants near the dishwasher; none were seen there
// today"). "Your home", "the property", "inside", an existential "there
// was" and "on this visit" name no place checked.
// Also with a negated verb: "we did not observe any pest activity", "the
// technician didn't see ants", "activity was not observed".
const ABSENT_THING = String.raw`(?:activity|pests?|insects?|bugs?|termites?|rodents?|mosquito(?:e?s)?|ants?|roach(?:es)?|spiders?|fleas?|ticks?|wasps?|bees?|feeding|captures?|droppings|evidence|signs?|mud\s+tubes?|damage)`;
const ABSENCE_RE = new RegExp([
  String.raw`\bno\s+(?:[\w-]+\s+){0,2}?${ABSENT_THING}\b`,
  String.raw`\b(?:zero|not\s+(?:a\s+single|one|any))\s+(?:[\w-]+\s+){0,2}?${ABSENT_THING}\b`,
  String.raw`\bnone\b`,
  String.raw`\bnothing\b`,
  String.raw`\b(?:did\s+not|didn['’]t|could\s+not|couldn['’]t|do\s+not|don['’]t)\s+(?:\w+\s+)?(?:see|find|observe|notice|detect|spot)\s+(?:any\s+)?(?:[\w-]+\s+){0,2}?${ABSENT_THING}\b`,
  String.raw`\b${ABSENT_THING}\s+(?:was|were|is|are)(?:\s+not|n['’]t)\s+(?:\w+\s+)?(?:seen|found|observed|noticed|detected|spotted|present)\b`,
].join('|'), 'gi');
const PLACE_NOUNS = [
  'kitchens?', 'bath(?:room)?s?', 'bedrooms?', 'closets?', 'pantr(?:y|ies)', 'laundry', 'garages?', 'attics?',
  'crawl\\s*spaces?', 'basements?', 'hallways?', 'stair(?:s|wells?)', 'offices?', 'rooms?',
  'lanais?', 'patios?', 'porch(?:es)?', 'decks?', 'pools?', 'cages?', 'enclosures?', 'carports?', 'docks?', 'seawalls?',
  'ponds?', 'yards?', 'lawns?', 'beds?', 'mulch', 'shrubs?', 'hedges?', 'trees?', 'palms?', 'plants?', 'pots?', 'planters?',
  'saucers?', 'buckets?', 'containers?', 'birdbaths?', 'tires?', 'gardens?', 'fences?', 'fence\\s*lines?', 'gates?', 'sheds?',
  'foundations?', 'perimeter', 'walls?', 'baseboards?', 'floors?', 'ceilings?', 'windows?', 'sills?', 'doors?', 'doorways?',
  'thresholds?', 'entr(?:y|ies)', 'entryways?', 'sliders?', 'tracks?', 'screens?', 'eaves?', 'soffits?', 'fascia',
  'roof(?:line)?s?', 'gutters?', 'downspouts?', 'vents?', 'siding', 'stucco', 'trim', 'cracks?', 'crevices?', 'voids?',
  'outlets?', 'sinks?', 'cabinets?', 'counter(?:top)?s?', 'dishwashers?', 'stoves?', 'ovens?', 'fridges?',
  'refrigerators?', 'appliances?', 'drains?', 'pipes?', 'plumbing', 'water\\s+heaters?', 'a\\/c', 'ac\\s+units?',
  'air\\s+handlers?', 'driveways?', 'sidewalks?', 'walkways?', 'pavers?', 'slabs?', 'stations?', 'traps?', 'monitors?',
  'devices?', 'corners?', 'edges?', 'the\\s+(?:front|back|side|rear)',
  '(?:treated|assessed|inspected|checked|baited|monitored|listed|problem|target(?:ed)?|nesting|feeding)\\s+(?:areas?|spots?|places?|locations?|zones?|sites?)',
  'there(?!\\s+(?:is|was|were|are|has|have|had|seems?|seemed|appears?|appeared|remains?|remained)\\b)',
];
const PLACE_RE = new RegExp(`\\b(?:${PLACE_NOUNS.join('|')})\\b`, 'i');
// Judged per clause: a place in another clause ("We treated the kitchen,
// and no pest activity was observed across the property") scopes nothing.
// A fronted place stays in its clause ("In the kitchen, no activity was
// found").
const CLAUSE_SPLIT_RE = /(?<=[.!?])\s+|;\s*|,\s*(?:and|but|while|though|although|yet|so|whereas)\s+/i;
function unscopedAbsence(copy) {
  return copy.split(CLAUSE_SPLIT_RE).some((clause) => {
    const rest = clause.replace(ABSENCE_RE, ' ');
    return rest !== clause && !PLACE_RE.test(rest);
  });
}
// Aftercare told to the customer (rule 7): an instruction, at the start of
// a sentence or line or after "please", "you should", "be sure to"…, to
// leave the work alone or not clean or water it ("Do not disturb the bait
// placements", "Please avoid cleaning the treated areas", "Water the
// treated area this evening", "Leave the stations undisturbed"). The same
// words in work copy ("we moved a station to keep the bait dry", "standing
// water in the yard") give no instruction and pass.
const CARE_VERB = String.raw`(?:disturb|mov(?:e|ing)|touch|clean|wash|mop(?:ping)?|vacuum|water|irrigat(?:e|ing)|mow(?:ing)?|sweep|wip(?:e|ing)|scrub(?:bing)?|spray|remov(?:e|ing)|walk|step(?:ping)?|play|sit(?:ting)?|let)(?:ing)?`;
const INSTRUCTION_START = String.raw`(?:^|[.!?;:]\s+|\b(?:please|you\s+(?:should|can|may|must|need\s+to|will\s+want\s+to)|you['’]ll\s+want\s+to|we\s+(?:recommend|suggest|ask)(?:\s+that\s+you)?|be\s+sure\s+to|make\s+sure\s+to|remember\s+to|try\s+to)\s+)["'“‘(]*(?:please\s+)?`;
const AFTERCARE_RE = new RegExp(`${INSTRUCTION_START}(?:`
  + String.raw`(?:do\s+not|don['’]t|not|never|avoid(?:ing)?|refrain\s+from|try\s+not\s+to)\s+(?:\w+\s+)?${CARE_VERB}\b`
  + String.raw`|(?:leav(?:e|ing)|keep(?:ing)?)\s+(?:the\s+|your\s+|all\s+|any\s+)?(?:bait\w*|stations?|traps?|placements?|devices?|treated\s+\w+)\b[^.!?]{0,30}?\b(?:undisturbed|untouched|alone|in\s+place|clear|dry)\b`
  + String.raw`|(?:water|irrigat(?:e|ing)|wash|mop(?:ping)?|clean|vacuum)(?:ing)?\s+(?:the\s+|your\s+|any\s+)?(?:treated|lawn|yard|grass|turf|beds?|plants?|floors?|baseboards?|areas?)\b`
  + String.raw`|avoid(?:ing)?\s+(?:the\s+|your\s+|any\s+)?treated\b`
  + ')', 'im');
// Phrases the owner rules name that no older screen covers (rules 4, 9,
// 13, 14).
const OWNER_PHRASE_RE = /\binfested\b|\bno\s+(?:problems?|issues?)\b|\bnothing\s+to\s+worry\s+about\b|\bmap(?:s|ped|ping)?\b|\btrac(?:e|ed|ing)\s+(?:route|outline|path|area|perimeter|line)s?\b|\btreated\s+outlines?\b|\bbond(?:ed|s)?\b|\b\w+-proof\b|\b(?:termite|ant|roach|pest|bug|rodent|mouse|rat|mosquito|flea|tick|spider|critter|animal|wildlife|squirrel|bird|snake)proof\b/i;
// Re-entry and aftercare wording without a number ("stay off until dry").
const REENTRY_RE = /\b(?:allow|let|give)\s+(?:the\s+)?(?:treated\s+\w+|treatment|product|spray|application|areas?|surfaces?)\b[^.!?]{0,30}?\bto\s+dry\b|\bwait\s+(?:for|until)\b[^.!?]{0,40}?\bdr(?:y|ied|ies)\b|\bavoid\s+(?:\w+\s+){0,2}?contact\b|\bcontact\s+with\s+(?:the\s+|any\s+)?treated\b|\bre-?ent(?:ry|er|ering)\b|\b(?:until|once|after)\s+(?:the\s+(?:area|product|treatment|spray|application)\s+(?:is|has)\s+|it(?:'s|’s|\s+is|\s+has)\s+)?(?:fully\s+|completely\s+)?dr(?:y|ied|ies)\b|\b(?:stay|keep)\s+(?:off|out\s+of)\b|\bkeep\s+(?:your\s+)?(?:kids|children|pets|people|family)\b[^.]{0,40}?\b(?:off|out|away)\b/i;

// Checked in order; the first hit names the rejection. Active ingredients
// (a common list plus the caller's catalog actives) are checked last.
const WRITER_RULE_SCREENS = Object.freeze([
  [UNIT_WORD_RE, 'amount'],
  [FOOTAGE_RE, 'footage'],
  [PERCENT_RE, 'percent'],
  [RATE_RE, 'rate'],
  [PER_VISIT_RE, 'per_visit'],
  [COMPANY_NAME_RE, 'company_name'],
  [SAFE_WORD_RE, 'safe_word'],
  [CHEMICAL_RE, 'chemical'],
  [OWNER_PHRASE_RE, 'owner_phrase'],
  [unscopedAbsence, 'unscoped_absence'],
  [AFTERCARE_RE, 'aftercare'],
  [REENTRY_RE, 'reentry'],
  [TIMEFRAME_RE, 'timeframe'],
  [GAUGE_RE, 'gauge'],
  [quotesCustomer, 'quote'],
  [PRICE_RE, 'price'],
  [ENTITLEMENT_RE, 'price'],
  [(copy) => forwardMention(copy, MONTH_DAY_RE), 'date'],
  [(copy) => forwardMention(copy, NUMERIC_DATE_RE), 'date'],
  [WEEKDAY_RE, 'date'],
  [(copy) => forwardMention(copy, BARE_WEEKDAY_RE), 'date'],
  [(copy) => forwardMention(copy, CLOCK_RE, ARRIVAL_CUE_RE), 'time'],
  [(copy) => forwardMention(copy, DAY_PART_RE, null, VISIT_CUE_RE), 'time'],
]);

// Returns a short rejection reason, or null when the copy passes. Runs on
// top of the report's existing screens (banned words, access codes, shape,
// this visit's trade names), only while the rules apply.
function writerRulesRejection(text, { activeIngredients = [], allowedPhrases = [] } = {}) {
  // Supplied timeframes and dates (an EXPECTATIONS line's own words, the
  // reach-out date) pass exactly as supplied; anything else still trips the
  // timeframe and date screens.
  let copy = String(text || '');
  for (const phrase of Array.isArray(allowedPhrases) ? allowedPhrases : []) {
    const pattern = allowedPhrasePattern(phrase);
    if (String(phrase || '').trim().length < 3 || !pattern) continue;
    copy = copy.replace(new RegExp(`(?<![\\w-])${pattern}(?![\\w-])`, 'gi'), 'X');
  }
  const hit = WRITER_RULE_SCREENS.find(([check]) => (typeof check === 'function' ? check(copy) : check.test(copy)));
  if (hit) return hit[1];
  const patterns = [...new Set([...COMMON_ACTIVE_INGREDIENTS, ...activeIngredientNames(activeIngredients)]
    .map(activeIngredientPattern)
    .filter(Boolean))];
  return new RegExp(`\\b(?:${patterns.join('|')})\\b`, 'i').test(copy) ? 'active_ingredient' : null;
}

module.exports = {
  REPORT_WRITER_RULES_VERSION,
  WRITER_RULES_EXCLUDED_MODULES,
  OWNER_RULES,
  PROMPT_REWRITES,
  composeWriterRulesPrompt,
  TECHNICIAN_NOTE_HEADER,
  CUSTOMER_WORDS_HEADER,
  withheldProductsLine,
  bookedReasonBlock,
  COMMON_ACTIVE_INGREDIENTS,
  activeIngredientsMentioned,
  groundedTimeframePhrases,
  writerRulesRejection,
};
