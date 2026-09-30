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
7. Never the word "safe" in any form ("safe once dry", "pet-safe", "safely"), and never "non-toxic" or "harmless". Give no re-entry, drying, rainfast or waiting time and no aftercare or safety instructions: the report's own sections cover them.
8. Say nothing about EPA registration. If it ever must appear, only "EPA-registered" or "EPA-exempt", never "EPA-approved".
9. No prices, "free", "included", "covered", warranty, guarantee, bond, or "per visit". If a cadence must be named, say "per application".
10. The company is "Waves Pest Control", or "we". Never "Waves Pest Control & Lawn Care", "Waves Lawn Care" or "Waves Lawn & Pest".
11. No timeframes ("7–14 days", "a few days", "two weeks") and no next-visit date, day or arrival window. A recorded next step may be named without one ("at your next visit").
12. Do not repeat what the report prints on its own: the product list, re-entry and aftercare guidance, the next visit's date and time, the technician's tip, the "What to expect", rain and spider cards, the "What you flagged" card, and the activity gauge's number or scale. The activity level in words ("light activity along the fence") is what the technician saw and belongs in the paragraph.
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
  // Remaining-service core and modules: aftercare, precautions and next
  // visits belong to the report's own sections under the owner rules.
  [
    'Preserve validated safety and aftercare instructions and their conditions. Do not create',
    'Leave safety, re-entry and aftercare instructions to the report\'s own sections. Do not create',
  ],
  [
    'State the recorded next program check or approved review plan without inventing a date. Use the existing approved device-handling instructions; do not encourage',
    'Name a recorded next program check without a date, day or window. Leave device-handling instructions to the report\'s own sections; do not encourage',
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
const CUSTOMER_WORDS_HEADER = 'WHAT THE CUSTOMER TOLD US (their own texts and emails, and AI summaries of calls; context only, never a finding)';

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
  // Three letters is the shortest real active in the catalog (Bti).
  if (!words.length || words.join('').length < 3) return null;
  return words.map(escapeRe).join('[\\s-]*');
}

// Catalog active_ingredient text ("Fipronil 9.1%, Pyriproxyfen",
// "Bacillus thuringiensis israelensis (Bti)") → names, aliases included.
function activeIngredientNames(values) {
  return (Array.isArray(values) ? values : [])
    .flatMap((value) => String(value || '').split(/[,;/+&()]|\band\b/i))
    .map((part) => part.replace(/[\d.]+\s*%?/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((part) => part.length >= 3);
}

const UNIT_WORD_RE = /\b(?:ml|mls|milliliters?|millilitres?|liters?|litres?|tsp|teaspoons?|tbsp|tablespoons?|fl\.?\s*oz|fluid\s+ounces?|oz|ounces?|pints?|quarts?|gal|gallons?|lbs?|pounds?|grams?|kilograms?|kg)\b|\b\d+(?:[.,]\d+)?\s*(?:cc|gals?|qts?|ozs?|pts?|tsps?|tbsps?|kgs?|g)\b/i;
const FOOTAGE_RE = /\b(?:linear|square|sq\.?)\s*(?:feet|foot|ft)\b|\bsqft\b|\b\d[\d,.]*\s*(?:-|–)?\s*(?:ft|feet|foot)\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred)\s+(?:linear\s+|square\s+)?(?:feet|foot)\b|\bacres?\b|\bacreage\b/i;
// Any percentage, spelled or not ("50%", "five percent").
const PERCENT_RE = /\d\s*%|\bpercent(?:age)?s?\b/i;
const PER_VISIT_RE = /\bper[\s-]+visit\b/i;
// Every "Waves …" name but exactly "Waves Pest Control". Case-sensitive:
// "Waves" followed by any capitalized word but "Pest Control" ("Waves Home
// Services", "Waves Lawn"), or "Waves Pest Control" followed by a
// capitalized word, "&" or "and Lawn" ("… Services", "… LLC", "… & Lawn
// Care"). Lowercase business suffixes are caught too.
const COMPANY_NAME_RE = /\bWaves\s+(?!Pest\s+Control\b)[A-Z&]|\bWaves\s+Pest\s+Control\s+(?:[A-Z&]|and\s+[Ll]awn\b)|\b[Ww]aves\s+(?:pest\s+control\s+)?(?:services?|llc|inc|company|lawn|home|exterminat\w*)\b/;
// Rates and mix strength in words ("at the label rate", "the recorded mix
// strength", "diluted").
const RATE_RE = /\brates?\b|\bmix(?:ing)?\s+(?:strength|ratio)\b|\bdilut(?:e|ed|ion)\b|\bconcentrat(?:e|ed|ion)\b|\bper\s+(?:gallon|1,?000)\b/i;
const SAFE_WORD_RE = /\b(?:safe|safer|safest|safely|unsafe|non-?toxic|harmless)\b/i;
const CHEMICAL_RE = /\bchemicals?\b/i;
// Forward-looking timeframes (rule 11): "7–14 days", "over the next two
// weeks", "within 24 hours", "for a few days". A past window ("in the seven
// days before the visit", "two weeks ago") is a fact and passes.
const DURATION_NUMBER = '(?:\\d+|a\\s+few|a\\s+couple(?:\\s+of)?|several|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|twenty|thirty|sixty|ninety)';
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
  + `|\\b(?:will|should|may|might|can|could|expect(?:ed)?|takes|lasts|continues?|keeps?\\s+working)\\b[^.!?]{0,40}?\\b${DURATION_NUMBER}\\s+${DURATION_UNIT}\\b(?!\\s+(?:before|ago|earlier|prior))`,
  'i',
);
// Money and entitlement (rule 9). ENTITLEMENT_RE catches the predicate
// forms ("the next check is free", "the follow-up is included") but not a
// physical state ("covered by mulch", "free of standing water").
const ENTITLEMENT_RE = /\b(?:is|are|was|were|be|comes?)\s+(?:(?:completely|totally|also|fully)\s+)?(?:free|included|covered)\b(?!\s+(?:by|with|in|under|of|from|on)\b)/i;
const PRICE_RE = /\$\s?\d|\b(?:free\s+(?:of\s+charge|re-?treatments?|re-?services?|service|visits?|follow-?ups?|call-?backs?|inspections?)|at\s+no\s+(?:extra\s+|additional\s+)?(?:cost|charge)|no\s+(?:extra\s+|additional\s+)?charge|warrant(?:y|ies|ied)|included\s+(?:in|with)\s+(?:your|the)\s+(?:plan|program|membership|service|agreement)|covered\s+(?:by|under)\s+(?:your|the)\s+(?:plan|program|membership|warranty|agreement|bond))\b/i;
// Next-visit dates, days and times (rule 11): the report prints the
// appointment itself. "October 7", "next Tuesday", "10 AM".
// "May" only capitalized, so "activity may 2…" is not a date. A date is
// refused only with a forward cue: "On September 15, we noted…" is history
// the grounding supplies; "your next visit is October 7" is the appointment.
const MONTH_DAY_RE = /\b(?:[Jj]an(?:uary)?|[Ff]eb(?:ruary)?|[Mm]ar(?:ch)?|[Aa]pr(?:il)?|May|[Jj]une?|[Jj]uly?|[Aa]ug(?:ust)?|[Ss]ept?(?:ember)?|[Oo]ct(?:ober)?|[Nn]ov(?:ember)?|[Dd]ec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/g;
const FUTURE_CUE_BEFORE_RE = /\b(?:next|upcoming|scheduled|appointment|return(?:ing)?|back|see\s+you|will|until|by|coming)\b/i;
const FUTURE_CUE_AFTER_RE = /^[^.!?]{0,30}\b(?:next|upcoming)\s+(?:visit|appointment|service|check)\b/i;
// A clock time is refused on the same terms, plus an arrival cue ("we'll
// arrive between 8 and 10 AM", "your window is 10 AM"); an observation
// ("strongest after 8 PM") or a past arrival ("we arrived at 10 AM") passes.
const CLOCK_RE = /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])/gi;
const ARRIVAL_CUE_RE = /\b(?:arriv(?:e|al|ing)|window)\b/i;
function forwardMention(copy, pattern, extraCue = null) {
  for (const match of copy.matchAll(pattern)) {
    const before = copy.slice(Math.max(0, match.index - 40), match.index).split(/[.!?]/).pop();
    const after = copy.slice(match.index + match[0].length);
    if (FUTURE_CUE_BEFORE_RE.test(before) || extraCue?.test(before) || FUTURE_CUE_AFTER_RE.test(after)) return true;
  }
  return false;
}
// Forward words only: "you texted us on Monday" is a past fact.
const WEEKDAY_RE = /\b(?:next|this|coming|by|until)\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/i;
// A property-wide absence (rule 4): "no pest activity was observed today",
// "found no active pests during the visit", "none were observed", "nothing
// was found". An absence tied to a place or set ("no activity at the lanai",
// "within the assessed areas", "none of the stations") passes.
// Judged per sentence: the place can come before or after ("You mentioned
// ants near the dishwasher; none were seen there today").
const ABSENCE_RE = /\b(?:no\s+(?:(?:visible|active|live|signs?\s+of)\s+)?(?:pest\s+)?(?:activity|pests|insects|bugs|termites|rodents|mosquitoes|ants|roaches)|none|nothing)\b/gi;
const PLACE_RE = /\b(?:at|in|on|of|near|along|around|under|inside|outside|by|within|behind|across|there|here)\b/i;
function unscopedAbsence(copy) {
  return copy.split(/(?<=[.!?])\s+/).some((sentence) => {
    const rest = sentence.replace(ABSENCE_RE, ' ');
    return rest !== sentence && !PLACE_RE.test(rest);
  });
}
// Phrases the owner rules name that no older screen covers (rules 4, 9,
// 13, 14).
const OWNER_PHRASE_RE = /\binfested\b|\bno\s+(?:problems?|issues?)\b|\bnothing\s+to\s+worry\s+about\b|\bmaps?\b|\bbond(?:ed|s)?\b|\b\w+-proof\b|\b(?:termite|ant|roach|pest|bug|rodent|mouse|rat|mosquito|flea|tick|spider|critter|animal|wildlife|squirrel|bird|snake)proof\b/i;
// Re-entry and aftercare wording without a number ("stay off until dry").
const REENTRY_RE = /\bre-?ent(?:ry|er|ering)\b|\b(?:until|once|after)\s+(?:the\s+(?:area|product|treatment|spray|application)\s+(?:is|has)\s+|it(?:'s|’s|\s+is|\s+has)\s+)?(?:fully\s+|completely\s+)?dr(?:y|ied|ies)\b|\bstay\s+(?:off|out\s+of)\b|\bkeep\s+(?:your\s+)?(?:kids|children|pets|people|family)\b[^.]{0,40}?\b(?:off|out|away)\b/i;

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
  [REENTRY_RE, 'reentry'],
  [TIMEFRAME_RE, 'timeframe'],
  [PRICE_RE, 'price'],
  [ENTITLEMENT_RE, 'price'],
  [(copy) => forwardMention(copy, MONTH_DAY_RE), 'date'],
  [WEEKDAY_RE, 'date'],
  [(copy) => forwardMention(copy, CLOCK_RE, ARRIVAL_CUE_RE), 'time'],
]);

// Returns a short rejection reason, or null when the copy passes. Runs on
// top of the report's existing screens (banned words, access codes, shape,
// this visit's trade names), only while the rules apply.
function writerRulesRejection(text, { activeIngredients = [] } = {}) {
  const copy = String(text || '');
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
  MAX_TECHNICIAN_NOTE_CHARS,
  CUSTOMER_WORDS_HEADER,
  withheldProductsLine,
  COMMON_ACTIVE_INGREDIENTS,
  writerRulesRejection,
};
