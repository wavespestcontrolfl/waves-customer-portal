/**
 * comparison-table-gate.js — keeps the autonomous writer's <ComparisonTable>
 * "buyer's-guide listicle" honest.
 *
 * The writer may anchor a comparison / "how to choose" / "best [service] in
 * [city]" post on a <ComparisonTable> (see agents/writer-agent-config.js). This
 * is the constrained, honest version of the AI-citation "listicle play": it
 * earns that demand by HELPING the reader choose, never by faking a ranking or
 * trashing competitors.
 *
 * SCOPE: drafts that embed a <ComparisonTable> get the FULL regime — the
 * competitor / disparagement / ranking checks scan the whole body PLUS the
 * title/meta (the public legal surface), and the option-column classification
 * FAILS CLOSED on anything that is not a recognized provider CATEGORY, Waves,
 * or a curated allowlist competitor.
 *
 * Drafts WITHOUT a table are no longer waved through: they get the NAMED-
 * TARGET legal scan (evaluateProse below). Defamation needs a target, and a
 * table-less draft was previously never scanned at all — "Acme Pest Solutions
 * is dishonest" in ordinary prose passed every gate. Category negativity with
 * no named business ("store-bought sprays are useless", consumer-protection
 * prose like "avoid pest control scams") deliberately does NOT trip it.
 *
 * NAMED competitors are doubly guarded: the gate enforces allowlist + per-table
 * sourced attribution + only-curated-facts + no-disparagement/ranking, AND a
 * draft that names any competitor sets requiresHumanReview so the runner routes
 * it to the (approvable) human-review queue instead of auto-publishing.
 *
 *   P0 COMPARISON_DISPARAGEMENT          — derogatory language about a provider
 *   P0 COMPARISON_UNKNOWN_COMPETITOR     — recognized competitor not on allowlist
 *   P1 COMPARISON_UNCLASSIFIED_OPTION    — business-looking name, not category/Waves/allowlisted
 *   P1 COMPARISON_RIGGED_RANKING         — self-declared "winner" / superlative
 *   P1 COMPARISON_NEGATIVE_RELIABILITY   — negative service claim about a provider
 *   P1 COMPARISON_NAMED_COMPETITOR_DISABLED   — names a competitor while gated off
 *   P1 COMPARISON_COMPETITOR_UNSOURCED        — named competitor without its own
 *                                          attributed ("as of"+source) table caption
 *   P1 COMPARISON_UNSUPPORTED_COMPETITOR_FACT — a named competitor's row states a
 *                                          fact that is not a curated attribute
 *
 * Returns { pass, findings, requiresHumanReview }. P0/P1 block (route to review).
 */

const competitorFacts = require('./competitor-facts');

// Derogatory language about a provider — block outright. Limited to terms that
// are almost exclusively business-disparagement; pest/efficacy words ("garbage",
// "worst infestation") are excluded here. Evaluative negatives ("worst") are
// caught TABLE-SCOPED below where they are provider-directed.
const DISPARAGEMENT_RE = /\b(scams?|rip[\s-]?offs?|ripoffs?|overpriced|goug\w*|incompetent|shady|sketchy|dishonest|untrustworthy|crooks?|frauds?|fraudulent|hidden fees?|bait[\s-]and[\s-]switch|lousy|sloppy|clueless|second[\s-]?rate)\b/i;

// Evaluative negatives that are fine in prose ("worst infestation") but are
// provider-disparagement inside a comparison table cell ("Worst follow-up").
const TABLE_DISPARAGEMENT_RE = /\b(worst|terrible|awful|horrible|useless|inferior|sub[\s-]?par|pathetic|mediocre)\b/i;

// Provider-DIRECTED disparagement anywhere in the draft (incl. title/meta/prose),
// where an evaluative negative is tied to a provider noun — "worst pest control
// companies", "national chains are unreliable". Targeted (adj adjacent to a
// provider noun, either order) so "worst infestation" / "the best time" don't trip.
const NEG_ADJ = 'worst|terrible|awful|horrible|unreliable|useless|inferior|sub[\\s-]?par|pathetic|mediocre|lousy|sloppy|incompetent|shady|dishonest|untrustworthy';
// Hyphenated service phrases count everywhere — "pest-control companies"
// (Codex r21 on #2633).
const PROVIDER_NOUN = 'pest[\\s-]+control|exterminators?|lawn[\\s-]+(?:care|service)|compan(?:y|ies)|providers?|chains?|services?|businesses?|operators?|outfits?|competitors?|competition|rivals?';
const STRONG_PROVIDER_NOUN = 'pest[\\s-]+control|exterminators?|lawn[\\s-]+(?:care|service)|compan(?:y|ies)|providers?|chains?|businesses?|operators?|outfits?|competitors?|competition|rivals?';
// "service area(s)" is literal geography, not a provider — "our service
// area is shady and humid" is educational copy (Codex r17 guard on #2633).
// The optional "service" hop covers compound forms — "pest control service
// areas are shady" (Codex r19).
const NOT_SERVICE_AREA = '(?!\\s+(?:service\\s+)?areas?\\b)';
const PROVIDER_DISPARAGEMENT_RE = new RegExp([
  `\\b(?:${NEG_ADJ})\\b(?:\\s+\\w+){0,2}\\s+\\b(?:${PROVIDER_NOUN})\\b${NOT_SERVICE_AREA}`,
  `\\b(?:${PROVIDER_NOUN})\\b${NOT_SERVICE_AREA}(?:\\s+\\w+){0,3}\\s+(?:are|is|were|was|seem|seems|tend to be|can be|get|got)\\b(?:\\s+\\w+){0,2}\\s+\\b(?:${NEG_ADJ})\\b`,
].join('|'), 'i');

// Negative service-reliability claims about a provider. Flagged inside table
// blocks OR in prose/title/meta when within PROXIMITY of a named competitor.
// The negated-verb arm covers every common auxiliary, not just "never"/
// "won't call back": "does not answer the phone" / "doesn't call back" /
// "don't show up" are the ordinary prose forms of the same claim and
// previously produced no finding. The "call FOR" lookahead keeps the
// require-idiom clean — "light infestations do not call for fumigation"
// is treatment advice, not a reliability claim.
const PROVIDER_NEGATIVE_RE = /\b(unreliable|unresponsive|no[\s-]?shows?|(?:never|doesn'?t|does\s+not|don'?t|do\s+not|won'?t|will\s+not)\s+(?:answers?(?:\s+(?:the\s+)?(?:phone|calls?))?|calls?(?!\s+for\b)(?:\s+(?:you\s+)?back)?|shows?(?:\s+up)?|responds?|replies|reply|returns?\s+calls?)\b|hard to reach|leaves? you waiting|ghosts? you|won'?t call (?:you )?back)\b/i;

// ACTIVE disparaging predicates — verb-plus-victim shapes ("scams customers",
// "charges hidden fees") for the generic-name directed scan. The victim object
// (or the fee/bait idiom) is REQUIRED so title-case noun uses stay clean:
// "How to Avoid Pest Control Scams in Sarasota" captures the business-shaped
// "Avoid Pest Control" but "Scams in" has no victim, so it does not trip.
const DISPARAGEMENT_VICTIM = "(?:its\\s+|their\\s+)?(?:customers?|clients?|homeowners?|residents?|seniors?|people|folks|you\\b)";
const ACTIVE_DISPARAGEMENT_SRC = [
  `scams?\\s+${DISPARAGEMENT_VICTIM}`,
  `rips?\\s+${DISPARAGEMENT_VICTIM}\\s+off`,
  `rips?\\s+off\\s+${DISPARAGEMENT_VICTIM}`,
  `gouges?\\s+(?:${DISPARAGEMENT_VICTIM}|prices)`,
  `overcharges?(?:\\s+(?:${DISPARAGEMENT_VICTIM}|for\\b))?`,
  // Fee-adding verb variants — "adds (on) hidden fees", "tacks on hidden
  // fees" are the same accusation as "charges hidden fees" (Codex r17/r21
  // on #2633).
  '(?:charges?|charged|adds?(?:\\s+on)?|added(?:\\s+on)?|tacks?\\s+on|tacked\\s+on|sneaks?\\s+in|snuck\\s+in|slips?\\s+in|slipped\\s+in)\\s+(?:(?:a|an|the|its|their)\\s+)?hidden\\s+fees?',
  // Phrasal order with the fees BEFORE the particle — "sneaks hidden fees
  // into contracts" (Codex r21).
  '(?:sneaks?|snuck|slips?|slipped|builds?|built|bakes?|baked|rolls?|rolled|buries|buried)\\s+(?:(?:a|an|the|its|their)\\s+)?hidden\\s+fees?\\s+into\\b',
  `cheats?\\s+${DISPARAGEMENT_VICTIM}`,
  `deceives?\\s+${DISPARAGEMENT_VICTIM}`,
  `lies\\s+to\\s+${DISPARAGEMENT_VICTIM}`,
  `defrauds?\\s+${DISPARAGEMENT_VICTIM}`,
  'pulls?\\s+(?:a\\s+)?bait[\\s-]and[\\s-]switch',
  'uses?\\s+bait[\\s-]and[\\s-]switch',
  'runs?\\s+(?:a\\s+)?bait[\\s-]and[\\s-]switch',
  // Verb form with a victim object — "companies bait-and-switch homeowners
  // with teaser prices" (Codex r17 on #2633) — or with an instrumental
  // tail and no victim: "bait-and-switch with teaser prices" (Codex r21).
  `bait[\\s-]and[\\s-]switch(?:es|ed|ing)?\\s+(?:${DISPARAGEMENT_VICTIM}|(?:with|on|via|through)\\b)`,
].join('|');
const PROVIDER_NEGATIVE_PROXIMITY = 90; // chars between a reliability term and a competitor name

// Common intervening adverbs for active-predicate shapes ("<subject> routinely
// rips off homeowners"), with an optional leading modal ("may charge hidden
// fees" is a hedged accusation, Codex r10 on #2633). "never" is deliberately
// absent: it NEGATES the accusation — "Waves never overcharges" is marketing
// copy, not disparagement (Codex r6 surfaced the collision).
const ACTIVE_ADVERBS = '(?:(?:may|might|could|can|will|would)\\s+)?(?:(?:also|often|always|routinely|repeatedly|regularly|frequently|just|really|constantly|sometimes|occasionally|reportedly|allegedly|apparently)\\s+){0,2}';

// The full disparagement vocabulary DIRECTED at a provider noun — the
// PROVIDER_DISPARAGEMENT_RE shapes (adjacent / linking-verb) but with every
// DISPARAGEMENT_RE term, not just NEG_ADJ: "overpriced pest control services",
// "pest control companies that are scams". The third arm covers ACTIVE
// predicates with the provider noun as subject ("pest control companies scam
// customers", "providers charge hidden fees") — the linking-verb shape misses
// transitive verbs (Codex on #2633). Used by the table path's PROSE scan,
// where a bare disparagement token is no longer enough (see evaluate).
// Possession/usage accusations name their OBJECT: "hidden fees", "shady
// billing". The object is REQUIRED — a bare disparagement token after
// has/use recreates the literal-shade false positive ("companies use shady
// foliage to locate mosquitoes" is field advice, not an accusation).
// scam/ripoff qualify as practice modifiers too — "scam pricing", "ripoff
// billing" (Codex r17 on #2633).
const POSSESSION_ACCUSATION_SRC = '(?:hidden\\s+fees?|bait[\\s-]and[\\s-]switch(?:\\s+(?:tactics?|pricing))?|(?:shady|sketchy|dishonest|deceptive|predatory|scam|rip[\\s-]?off|overpriced|inflated)\\s+(?:billing|pricing|fees?|tactics?|practices?|contracts?|sales|quotes?|estimates?|invoices?))';
// Association-object vocabulary: the possession objects plus UNAMBIGUOUS
// standalone tokens — "Customers report scams after choosing Bug Busters"
// (Codex r22 on #2633). Ambiguous tokens (shady/lousy) stay out: their
// literal senses are the original false-positive class.
const ASSOC_ACCUSATION_SRC = `(?:${POSSESSION_ACCUSATION_SRC}|scams?\\b|rip[\\s-]?offs?\\b|frauds?\\b)`;
// Disparagement tokens with NO literal/benign sense in pest content — safe
// for separator headings on lower-confidence name captures ("acme pest
// solutions: dishonest"), unlike shady/sloppy/lousy which read literally
// ("… — shady corners of the lanai"). (Codex r12 on #2633.)
const UNAMBIGUOUS_DISPARAGEMENT_SRC = '(?:dishonest|untrustworthy|incompetent|overpriced|second[\\s-]?rate|crooks?|frauds?|fraudulent|clueless|goug\\w+|rip[\\s-]?offs?|ripoffs?|scams?|bait[\\s-]and[\\s-]switch)';
// A word gap that tolerates comma/parenthetical adverbs within the sentence
// ("companies, frankly, are dishonest") — whitespace-only gaps let ordinary
// punctuation defeat the directed arms (Codex r3 on #2633). Gap words must
// not be NEGATORS: "We never charge hidden fees" / "Waves never overcharges"
// are the accusation's denial, not the accusation.
// without/zero are negators here too — "Waves: zero hidden fees" is a denial
// (Codex r18 on #2633).
// Emphatic idioms pass through the gap — "Waves not only charges hidden
// fees" / "no doubt charges" assert the accusation (Codex r28 on #2633).
const NON_NEGATED_WORD = "(?!(?:never|not(?!\\s+(?:only|just)\\b)|no(?!\\s+doubt\\b)|without(?!\\s+(?:a\\s+)?(?:doubt|question)\\b)|zero|don'?t|doesn'?t|didn'?t|won'?t|wouldn'?t|can'?t|cannot|hardly|rarely|seldom)\\b)[\\w'’]+";
const NOUN_VERB_GAP = `(?:\\s*,?\\s+${NON_NEGATED_WORD}){0,3}\\s*,?\\s+`;
const DIRECTED_DISPARAGEMENT_RE = new RegExp([
  // Gap words exclude category-scoping prepositions: "hidden fees IN pest
  // control" is consumer-protection education about the industry, not an
  // accusation at a provider (Codex r20 on #2633); "hidden fees from pest
  // control companies" stays directed.
  // The pre-noun shape requires a STRONG provider noun: bare "services?"
  // matched buyer guidance like "hidden fees when comparing service plans"
  // (Codex r31). Subject-verb/possession arms keep the full noun set.
  `(?:${DISPARAGEMENT_RE.source})(?:\\s+(?!(?:in|within|across|throughout|among|around)\\b)\\w+){0,2}\\s+\\b(?:${STRONG_PROVIDER_NOUN})\\b${NOT_SERVICE_AREA}`,
  // Linking verbs incl. modal/hedged and sensory forms ("companies may be
  // dishonest", "providers sound shady" — Codex r10/r11 on #2633; same set
  // as the own-brand arm). Standalone appear counts as a copula too —
  // "companies appear dishonest" (Codex r16). Post-verb gap words are
  // negator-excluded too ("are never dishonest" is a denial).
  `\\b(?:${PROVIDER_NOUN})\\b${NOT_SERVICE_AREA}${NOUN_VERB_GAP}(?:are|is|were|was|seems?|seemed|looks?|sounds?|remains?|remained|stays?|stayed|tend to be|can be|get|got|(?:may|might|could)\\s+be|appear(?:s|ed)?(?:\\s+to\\s+be)?)\\b(?:\\s+${NON_NEGATED_WORD}){0,2}\\s+(?:${DISPARAGEMENT_RE.source})`,
  // Possession/usage with a required accusation object: "companies have
  // hidden fees", "chains use shady billing" (Codex r2/r3 on #2633).
  // Reputation forms count — "providers known for hidden fees", "accused
  // of hidden fees"; NOUN_VERB_GAP absorbs the copula ("are known for")
  // and stays negator-excluded ("not known for hidden fees" is a denial)
  // (Codex r21).
  // Prepositional form takes the noun directly — "companies with hidden
  // fees should be avoided" (Codex r16); the negator-free article gap keeps
  // "providers with no hidden fees" a denial.
  `\\b(?:${PROVIDER_NOUN})\\b${NOT_SERVICE_AREA}(?:${NOUN_VERB_GAP}(?:has|have|had|uses?|used|includes?|included|comes?\\s+with|(?:known|notorious|infamous)\\s+for|accused\\s+of|blamed\\s+for|cited\\s+for)|\\s+with)\\s+(?:(?:a|an|the|really|very)\\s+){0,2}${POSSESSION_ACCUSATION_SRC}`,
  // Appositive-tolerant gap here too — "companies, frankly, charge hidden
  // fees" (Codex r7 on #2633).
  `\\b(?:${PROVIDER_NOUN})\\b${NOT_SERVICE_AREA}${NOUN_VERB_GAP}${ACTIVE_ADVERBS}(?:${ACTIVE_DISPARAGEMENT_SRC})`,
  // Pronoun-subject possession with a provider-noun antecedent in the same
  // sentence — "pest control companies are not cheap because THEY have
  // hidden fees" (Codex r34). The object requirement keeps "they have no
  // hidden fees" a denial.
  `\\b(?:${PROVIDER_NOUN})\\b${NOT_SERVICE_AREA}[^.!?\\n]{0,80}?\\bthey\\s+(?:also\\s+)?(?:ha(?:s|ve|d)|uses?|used|includes?|included|comes?\\s+with|charges?|charged|adds?|added)\\s+(?:(?:a|an|the|really|very)\\s+){0,2}${POSSESSION_ACCUSATION_SRC}`,
  // Separator/heading and possessive association at a provider noun —
  // "Pest control companies: hidden fees are common", "Providers' scams
  // are common" (Codex r24 on #2633). Separator prefix words are
  // negator-excluded ("companies: no hidden fees" is a denial); the
  // possessive apostrophe is REQUIRED, so the "pest control scams to
  // avoid" consumer-education idiom does not match the possessive arm.
  `\\b(?:${PROVIDER_NOUN})\\b${NOT_SERVICE_AREA}\\s*[:—–-]\\s*(?:${NON_NEGATED_WORD}\\s+){0,2}(?:${POSSESSION_ACCUSATION_SRC}|(?:${UNAMBIGUOUS_DISPARAGEMENT_SRC})\\b(?!\\s+to\\s+(?:avoid|watch|spot|dodge)\\b))`,
  `\\b(?:${PROVIDER_NOUN})['’]s?\\s+(?:${ASSOC_ACCUSATION_SRC})`,
].join('|'), 'i');

// Disparagement DIRECTED at the own brand ("Waves is dishonest", "Waves
// charges hidden fees") — deliberately TIGHTER than the generic-name shapes:
// our own writer legitimately puts pest vocabulary near "Waves" ("Waves keeps
// shady, damp corners treated"), so the linking-verb arm allows only a short
// determiner/adverb gap instead of a 60-char window (Codex P2 on #2633).
// The own-brand SUBJECT: "Waves", first-person "we", or a first-person
// possessive phrase ("our team", "our billing") — in a Waves-authored
// comparison draft, "We charge hidden fees" / "Our team overcharges"
// target the own brand exactly like "Waves charges hidden fees" (Codex
// r6/r14 on #2633). Safe in the active/possession arms because those
// require an accusation object.
const OWN_BRAND_SUBJECT = "(?:\\bwaves\\b(?:['’]s?)?|\\bwe\\b|\\bour\\s+[\\w'’]+)";
const OWN_BRAND_DISPARAGEMENT_RE = new RegExp([
  // DISPARAGEMENT_RE vocabulary only (parity with the old whole-text scan):
  // adding NEG_ADJ here would newly block prose like "waves of termites are
  // terrible" — "waves" the noun is unavoidable in pest copy.
  // Comma/appositive-tolerant gap ("Waves, frankly, is dishonest") and the
  // full linking-verb set ("Waves stays dishonest") — Codex r5 on #2633.
  // The DISP token must still sit right after the verb (short determiner
  // gap only): that adjacency is what keeps "Waves keeps shady corners
  // treated" clean.
  // (The Waves-subject linking arm lives outside this joined regex: it needs
  // a case-SENSITIVE brand anchor — lowercase "waves" is the common noun
  // ("summer heat waves can be lousy for turf") — so it runs as an
  // anchor+tail pair like the separator arms; Codex r18 on #2633.)
  // First-person possessive claims with a linking verb ("Our billing is
  // shady", "Our pricing is dishonest") — business-practice and people/org
  // nouns ONLY ("Our team is dishonest" — Codex r17), so literal shade
  // stays clean ("our lanais are shady and humid") (Codex r14 on #2633).
  // "service" is deliberately absent: "our service area is shady" is
  // educational geography, and NOUN_VERB_GAP would bridge "area".
  `\\bour\\s+(?:billing|pricing|prices?|rates?|fees?|contracts?|quotes?|invoices?|invoicing|sales|tactics?|practices?|teams?|staff|crews?|technicians?|techs?|company|owners?)\\b${NOUN_VERB_GAP}(?:is|are|was|were|seems?|seemed|remains?|remained|stays?|stayed|looks?|sounds?|appear(?:s|ed)?(?:\\s+to\\s+be)?|(?:may|might|could)\\s+be|can\\s+be|tends?\\s+to\\s+be|has\\s+been|have\\s+been)\\s+(?:(?:really|pretty|very|just|a|an|the)\\s+){0,2}(?:${DISPARAGEMENT_RE.source}|\\b(?:${NEG_ADJ})\\b(?!-))`,
  // First-person linking form requires the verb DIRECTLY after "we" — the
  // appositive gap would match relative clauses like "the zones we treat
  // are shady, damp corners".
  // NEG_ADJ counts for first-person subjects too — "We are unreliable",
  // "We seem sketchy" (Codex r27); hyphen-guarded so "we are the
  // worst-kept secret" marketing idiom stays clean.
  `\\bwe\\b(?:['’]re)?\\s+(?:are|is|were|was|remains?|stays?|seems?|seemed|looks?|sounds?|appear(?:s|ed)?(?:\\s+to\\s+be)?|(?:may|might|could)\\s+be|can\\s+be|tends?\\s+to\\s+be)?\\s*(?:(?:really|pretty|very|just|a|an|the)\\s+){0,2}(?:${DISPARAGEMENT_RE.source}|\\b(?:${NEG_ADJ})\\b(?!-))`,
  // (The reverse "…dishonest Waves" arm lives outside this joined regex —
  // it needs a case-VERIFIED brand token so "Lousy heat waves stress St.
  // Augustinegrass" stays clean; see OWN_BRAND_REVERSE_RE / Codex r19.)
  // Object-position insult idiom against the own brand ("homeowners call
  // Waves a scam", "customers describe us as dishonest") — verb-anchored,
  // DISPARAGEMENT_RE vocabulary only: NEG_ADJ here would collide with the
  // common noun ("experts call heat waves a serious lawn stressor")
  // (Codex r14 on #2633).
  // Negator immediately before the verb is a denial — "Customers do not
  // call Waves a scam" (Codex r22 on #2633).
  `(?<!\\b(?:not|never|don'?t|doesn'?t|didn'?t|won'?t|wouldn'?t|rarely|hardly|seldom)\\s)\\b(?:calls?|called|describes?|described|labels?|labell?ed|considers?|considered)\\s+(?:waves|us)\\b\\s+(?:as\\s+)?(?:(?:a|an|the)\\s+)?(?:${DISPARAGEMENT_RE.source})`,
  // Appositive-tolerant gaps ("Waves, frankly, charges hidden fees") —
  // Codex r7 on #2633.
  `${OWN_BRAND_SUBJECT}${NOUN_VERB_GAP}${ACTIVE_ADVERBS}(?:${ACTIVE_DISPARAGEMENT_SRC})`,
  // Possession/usage with a required accusation object ("Waves has hidden
  // fees", "Waves uses shady billing") — object required so "Waves has
  // shady spots covered" stays clean (Codex r3/r6 on #2633).
  `${OWN_BRAND_SUBJECT}${NOUN_VERB_GAP}(?:has|have|had|uses?|used|includes?|included|comes?\\s+with|(?:known|notorious|infamous)\\s+for|accused\\s+of|blamed\\s+for|cited\\s+for)\\s+(?:(?:a|an|the|really|very)\\s+){0,2}${POSSESSION_ACCUSATION_SRC}`,
].join('|'), 'i');

// Numeric-one that is self-ranking ON ITS FACE, needing no nearby target: a
// declared place-winner ("#1 in Venice"), a first-person subject ("We are
// #1"), or ranked/rated framing ("rated #1"). Everything here declares a
// winner regardless of context, so it scans whole-text like SELF_RANKING_RE
// (Codex on #2633: "We are #1 in Venice" must not need a nearby brand token).
// Digit boundary is load-bearing: without it "#10" / "No. 10" match the
// "#1" prefix and a clean "We are #10 on the callback list" parks as a
// rigged ranking (Codex r8 on #2633).
const NUMERIC_ONE_ALT = '(?:#\\s?1\\b|no\\.?\\s?1\\b|number one\\b)';
const NUMERIC_SELF_RANKING_RE = new RegExp([
  // Place-winner form ("#1 in Venice"). A following copula marks LIST
  // framing instead — "The #1 in every mosquito checklist IS standing
  // water" names the list's top item, not a winner (Codex r22 on #2633).
  `${NUMERIC_ONE_ALT}\\s+(?:in|around|near)\\b(?!-)(?![^.!?\\n]{0,40}?\\b(?:is|are|was|were)\\b)`,
  // Typographic apostrophe accepted; optional determiner after the verb and
  // after ranked/rated/voted (Codex r3 on #2633). The adverb slot takes any
  // negator-free words, not a curated list — "We're currently #1" (Codex
  // r16); negator exclusion keeps "We are not #1" a denial.
  // Gap words must not be gerunds: "Below, we are LISTING the #1 breeding
  // site" is instructional structure, not market position (Codex r26).
  `\\bwe(?:['’]re|['’]ve\\s+been|\\s+(?:are|were|remains?|remained|stays?|stayed|have\\s+been(?:\\s+(?:ranked|rated|voted))?))\\s+(?:(?![\\w'’]+ing\\b)${NON_NEGATED_WORD}\\s+){0,2}?(?:(?:the|your|a|an)\\s+)?${NUMERIC_ONE_ALT}`,
  // Transitive "we rank #1" gets NO determiner tail: "below, we rank the
  // #1 breeding sites" is educational list framing, not self-ranking
  // (Codex r14 on #2633).
  `\\bwe\\s+rank(?:s|ed)?\\s+(?:(?:still|now|proudly)\\s+)?${NUMERIC_ONE_ALT}`,
  // "our <team/company/...>" subjects are own-brand for #1 claims too —
  // "Our technicians are the #1 choice" (Codex r27 on #2633).
  `\\bour\\s+(?:teams?|company|technicians?|techs?|staff|crews?|services?|business)\\b${NOUN_VERB_GAP}(?:is|are|was|were|remains?|ranks?)\\s+(?:(?![\\w'’]+ing\\b)${NON_NEGATED_WORD}\\s+){0,2}?(?:(?:the|your|a|an)\\s+)?${NUMERIC_ONE_ALT}`,
  // Achievement verbs — "We earned the #1 spot in Venice", "we've won #1"
  // (Codex r21 on #2633).
  `\\bwe(?:['’]ve)?\\s+(?:have\\s+|just\\s+|finally\\s+)?(?:earns?|earned|wins?|won|claims?|claimed|secures?|secured|clinch(?:es)?|clinched|grabs?|grabbed|takes?|took|holds?|held)\\s+(?:(?:the|your|a|an)\\s+)?${NUMERIC_ONE_ALT}`,
  // Marketing verbs with a reflexive object — "we market ourselves as the
  // #1 choice" (Codex r17 on #2633). The reflexive is REQUIRED: "we
  // advertise the #1-rated mosquito trap" is a product mention, not
  // self-ranking. (The Waves-subject variants — linking "Waves is #1" and
  // marketing "Waves advertises itself as #1" — live outside this joined
  // regex behind the case-sensitive brand anchor; lowercase "waves" is the
  // common noun ("summer heat waves are #1 on the list of turf stressors")
  // — Codex r19.)
  `\\bwe\\s+(?:advertise|market|promote|position|tout|brand|bill|present|describe|call|name)(?:s|d|ed)?\\s+ourselves\\s+(?:as\\s+)?(?:(?:the|your|a|an)\\s+){0,2}${NUMERIC_ONE_ALT}`,
  // Own brand in OBJECT position ("customers rated us #1", "voted us the
  // #1 choice") — "us" makes it own-brand by construction, so the verb
  // list can be broad without educational collisions (Codex r14 on #2633).
  // Customer-choice verbs and "their" ride along — "homeowners choose us
  // as #1", "customers make us their #1 choice" (Codex r16).
  `\\b(?:rate[sd]?|rank(?:s|ed)?|vote[sd]?|name[sd]?|calls?|called|makes?|made|chooses?|chose|selects?|selected|picks?|picked|prefers?|preferred)\\s+us\\s+(?:(?:as|the|your|a|an|their)\\s+){0,2}${NUMERIC_ONE_ALT}`,
  // Subjectless "Rated #1" heading forms. The lookbehind drops "X is ranked
  // #1" statistical statements ("Florida is ranked #1 for termite pressure"
  // — Codex r18); subject-anchored is-ranked forms are covered by the
  // we/waves/provider-noun arms, whose word gaps absorb "ranked".
  `(?<!\\b(?:is|are|was|were|been|remains?|remained|stays?|stayed)\\s)\\b(?:ranked|rated|voted|awarded|chosen|selected|named|crowned)\\s+(?:(?:as|the)\\s+){0,2}${NUMERIC_ONE_ALT}`,
  // (The own-brand-subject ranking arm — "Waves, after years of serving …,
  // is #1", Codex r5 — lives outside this joined regex behind the
  // case-sensitive anchor; see OWN_BRAND_NUMERIC_SUBJECT_TAIL_RE.)
  // Provider-noun subject: "pest control companies are #1", "providers
  // rank #1" (Codex r11 on #2633). Negator-free adverb slot, same as the
  // we-arm ("companies are currently #1" — Codex r16 parity).
  `\\b(?:${PROVIDER_NOUN})\\b${NOUN_VERB_GAP}(?:are|is|was|were|ranks?|ranked|remains?)\\s+(?:${NON_NEGATED_WORD}\\s+){0,2}?(?:(?:the|your|a|an)\\s+)?${NUMERIC_ONE_ALT}`,
].join('|'), 'i');

// Own-brand SEPARATOR and appositive-#1 forms keep a case-SENSITIVE brand
// ANCHOR ("Waves"/"WAVES", never lowercase) — lowercase would collide with
// the common noun ("in summer heat waves — shady, damp corners", "in summer
// heat waves, the #1 hidden breeding site"). The accusation/number TAIL is
// case-insensitive ("Waves: Hidden fees", "Choose WAVES, The #1 choice" are
// heading-cased, Codex r9/r10 on #2633) and stays OBJECT/number-anchored:
// full disparagement vocabulary here would re-block heading shapes like
// "Waves — Shady Foliage Treatment Guide" (literal shade).
// The "Pest Control" suffix is case-INSENSITIVE (inline classes — these
// regexes carry no flags): "Waves pest control: hidden fees" is sentence
// case, and only the leading W disambiguates the brand from the common
// noun (Codex r14 on #2633). Bare/typographic possessives accepted.
// "(?!\\s+of\\b)": sentence-initial common-noun openings — "Waves of summer
// heat…" — are weather/pest copy, never the brand (Codex r25 on #2633).
// The lookbehind drops weather/physics compounds in ANY case — "Heat
// Waves Are the #1 Stressor" is title-cased educational copy (Codex r26
// on #2633).
const OWN_BRAND_ANCHOR = "(?<!\\b(?:[Hh][Ee][Aa][Tt]|[Cc][Oo][Ll][Dd]|[Tt][Ii][Dd][Aa][Ll]|[Oo][Cc][Ee][Aa][Nn]|[Ss][Oo][Uu][Nn][Dd]|[Ss][Hh][Oo][Cc][Kk]|[Tt][Rr][Oo][Pp][Ii][Cc][Aa][Ll]|[Ss][Tt][Oo][Rr][Mm]|[Rr][Oo][Gg][Uu][Ee]|[Rr][Aa][Dd][Ii][Oo]|[Ee][Aa][Ss][Tt][Ee][Rr][Ll][Yy]|[Ww][Ee][Ss][Tt][Ee][Rr][Ll][Yy]|[Rr][Oo][Ss][Ss][Bb][Yy]|[Kk][Ee][Ll][Vv][Ii][Nn]|[Gg][Rr][Aa][Vv][Ii][Tt][Yy]|[Pp][Ll][Aa][Nn][Ee][Tt][Aa][Rr][Yy]|[Mm][Oo][Nn][Ss][Oo][Oo][Nn]|[Ss][Ee][Ii][Ss][Mm][Ii][Cc]|[Pp][Rr][Ee][Ss][Ss][Uu][Rr][Ee]|[Rr][Aa][Ii][Nn]|[Ww][Ii][Nn][Dd])\\s)\\bW(?:aves|AVES)\\b(?!\\s+of\\b)(?:\\s+[Pp][Ee][Ss][Tt]\\s+[Cc][Oo][Nn][Tt][Rr][Oo][Ll])?(?:['’]s?)?";
// Curated heading descriptors may sit between the brand and the separator —
// "Waves Review: Hidden fees", "Waves billing: hidden fees" (Codex r21 on
// #2633). Curated, not free words: arbitrary hops would re-create the
// common-noun collision ("heat Waves crash — shady…" is impossible, but
// keep the surface tight anyway).
const OWN_BRAND_DESCRIPTOR_HOP = "(?:\\s+(?:[Rr]eviews?|[Bb]illing|[Pp]ricing|[Rr]atings?|[Cc]omplaints?|[Cc]ontracts?|[Qq]uotes?|[Ii]nvoic(?:es?|ing)|[Ff]ees?|[Ee]xperience)){0,2}";
const OWN_BRAND_SEP_ANCHOR_RE = new RegExp(`${OWN_BRAND_ANCHOR}${OWN_BRAND_DESCRIPTOR_HOP}\\s*[:—–-]\\s*`);
// Prefix words are negator-excluded: "Waves: no hidden fees" is a denial,
// not an accusation (Codex r12 on #2633).
// Plain unambiguous insults count after the separator — "Waves: dishonest."
// (Codex r30); the to-avoid lookahead keeps "scams to avoid" consumer
// education clean.
const OWN_BRAND_SEP_TAIL_RE = new RegExp(
  `^(?:${NON_NEGATED_WORD}\\s+){0,2}(?:${POSSESSION_ACCUSATION_SRC}|(?:${UNAMBIGUOUS_DISPARAGEMENT_SRC})\\b(?!\\s+to\\s+(?:avoid|watch|spot|dodge)\\b))`, 'i',
);
// Separator anchors count for #1 too — "Waves — the #1 choice" (Codex r12).
const OWN_BRAND_NUMERIC_ANCHOR_RE = new RegExp(`${OWN_BRAND_ANCHOR}${OWN_BRAND_DESCRIPTOR_HOP}(?:\\s*[,:—–-]\\s*|\\s+)`);
// The #1 must DECLARE the brand a winner: a winner-noun tail or sentence
// end — "Waves Pest Control: #1 entry point for ants" ranks the tip, not
// the company (Codex r29 on #2633).
const OWN_BRAND_NUMERIC_TAIL_RE = new RegExp(
  `^(?:(?:the|your|a|an)\\s+)?(?:[\\w'’]+['’]s\\s+)?${NUMERIC_ONE_ALT}(?:(?:[-\\s]+[\\w'’]+){0,2}?[-\\s]+(?:choices?|picks?|options?|compan(?:y|ies)|providers?|teams?|services?|programs?|contractors?|exterminators?|overall|rank(?:ing)?s?|positions?)\\b|\\s*(?:[.!?]|$))`, 'i',
);
// Waves-subject linking-verb disparagement, case-sensitive anchor + case-
// insensitive tail ("Waves is dishonest", "Waves may be dishonest") — pulled
// out of OWN_BRAND_DISPARAGEMENT_RE because that regex's 'i' flag made
// lowercase common-noun "waves" a subject ("summer heat waves can be lousy
// for turf" hard-blocked; Codex r18 on #2633).
const OWN_BRAND_LINKING_TAIL_RE = new RegExp(
  `^${NOUN_VERB_GAP}(?:is|are|was|were|seems?|seemed|remains?|remained|stays?|stayed|looks?|sounds?|appear(?:s|ed)?(?:\\s+to\\s+be)?|(?:may|might|could)\\s+be|can\\s+be|tends?\\s+to\\s+be|has\\s+been|have\\s+been)\\s+(?:(?:really|pretty|very|just|a|an|the)\\s+){0,2}(?:${DISPARAGEMENT_RE.source}|\\b(?:${NEG_ADJ})\\b)`, 'i',
);
// Reverse form ("…dishonest Waves"): the vocabulary needs 'i' but the brand
// token must be case-VERIFIED in code (capture group checked against
// Waves/WAVES) — "Lousy heat waves stress St. Augustinegrass" is lawn copy
// (Codex r19 on #2633).
// Named group: DISPARAGEMENT_RE.source carries its own capture group, so a
// positional index would grab the vocabulary token instead of the brand.
// The compound lookbehind and (at the call sites) the sentence-negation
// guard apply here too — "Lousy Heat Waves stress turf" is weather copy
// and "No hidden fees from Waves" is a denial (Codex r31).
const OWN_BRAND_REVERSE_SRC = `(?:${DISPARAGEMENT_RE.source})\\s+(?:(?!(?:[Hh][Ee][Aa][Tt]|[Cc][Oo][Ll][Dd]|[Tt][Ii][Dd][Aa][Ll]|[Oo][Cc][Ee][Aa][Nn]|[Ss][Oo][Uu][Nn][Dd]|[Ss][Hh][Oo][Cc][Kk]|[Tt][Rr][Oo][Pp][Ii][Cc][Aa][Ll]|[Ss][Tt][Oo][Rr][Mm]|[Rr][Oo][Gg][Uu][Ee]|[Rr][Aa][Dd][Ii][Oo])\\s)\\w+\\s+)?\\b(?<brandTok>waves)\\b`;
const OWN_BRAND_CASE_RE = /^W(?:aves|AVES)$/;
// Accusation-object ASSOCIATION with Waves in object position — "Customers
// report hidden fees after choosing Waves" (Codex r21 on #2633). Brand token
// case-verified in code; sentence-level denial-guarded at the call site.
const OWN_BRAND_OBJ_ASSOC_SRC = `(?:${ASSOC_ACCUSATION_SRC})[^.!?\\n]{0,80}?\\b(?<brandTok>waves)\\b`;
// Anchor-tail association forms: possessive accusation ("Waves' hidden fees
// are common") and complaint attribution ("Waves gets complaints about
// hidden fees") — Codex r21.
const OWN_BRAND_ASSOC_TAIL_RE = new RegExp([
  `^\\s*(?:${ASSOC_ACCUSATION_SRC})`,
  `^[^.!?\\n]{0,60}?\\b(?:gets?|got|receives?|received|draws?|drew|faces?|faced|racks?\\s+up|racked\\s+up)\\s+complaints?\\s+(?:about|over|regarding)\\s+(?:(?:its|their|the|a|an)\\s+)?(?:${ASSOC_ACCUSATION_SRC})`,
].join('|'), 'i');
// #1-BEFORE-the-brand winner framing — "The #1 overall is Waves" (Codex
// r21); brand token case-verified in code.
const OWN_BRAND_NUM_BEFORE_SRC = `${NUMERIC_ONE_ALT}(?:\\s+(?:spot|overall|choice|pick|compan(?:y|ies)|providers?|options?|rank(?:ing)?|position|team|services?))?\\s+(?:belongs\\s+to|goes\\s+to|is|was|remains)\\s+(?:(?:the|your|a|an)\\s+)?\\b(?<brandTok>waves)\\b`;
// Waves-subject #1 arms, case-sensitive anchor + 'i' tails, same split as
// the linking/separator arms (Codex r5/r17/r19 on #2633). The verb must be
// adjacent to the number so "in heat waves, the #1 breeding site is …"
// stays clean; the marketing form requires the reflexive.
// Achievement verbs included — "Waves earned the #1 spot" (Codex r21).
const OWN_BRAND_NUMERIC_SUBJECT_TAIL_RE = new RegExp(
  // The window must not cross that/why clauses — "Waves teaches that the
  // garage threshold is the #1 entry point" ranks the tip (Codex r32).
  `^(?:(?!\\b(?:that|which|why|how|because|where|when|whether|if)\\b)[^.!?\\n]){0,120}?\\b(?:is|are|was|were|remains?|ranks?|earn(?:s|ed)?|w(?:ins?|on)|claim(?:s|ed)?|secur(?:es?|ed)|h(?:olds?|eld)|t(?:akes?|ook)|ha(?:s|ve)\\s+been(?:\\s+(?:ranked|rated|voted))?)\\s+(?:${NON_NEGATED_WORD}\\s+){0,2}?(?:(?:the|your|a|an)\\s+)?${NUMERIC_ONE_ALT}`, 'i',
);
const OWN_BRAND_MARKETING_TAIL_RE = new RegExp(
  `^[^.!?\\n]{0,120}?\\b(?:advertises?|advertised|markets?|marketed|promotes?|promoted|positions?|positioned|touts?|touted|brands?|branded|bills?|billed|presents?|presented|describes?|described|calls?|called|names?|named)\\s+itself\\s+(?:as\\s+)?(?:(?:the|your|a|an)\\s+){0,2}${NUMERIC_ONE_ALT}`, 'i',
);

// Linking/behavioral verbs that tie a subject name to a following negative
// term (shared by the table-less directed scans). Includes the hedged/linking
// forms the provider-noun arms accept — "may be dishonest" / "appears to be
// dishonest" is still the accusation (Codex r15 on #2633); past-tense linking
// forms ride along for the same parity.
// Bare behavioral modals (will/would/can/keeps) are OUT: with the 60-char
// window they turned service copy into accusations — "X will treat shady
// corners around the lanai" (Codex r25 on #2633). Their be-forms stay, and
// modal+active accusations are ACTIVE_ADVERBS' job.
const SUBJECT_VERBS = 'is|are|was|were|isn\'?t|aren\'?t|seem(?:s|ed)?|looks?|sounds?|remain(?:s|ed)?|stay(?:s|ed)?|has(?:\\s+been)?|have(?:\\s+been)?|(?:will|would)\\s+be|can(?:not)?\\s+be|can\'?t\\s+be|won\'?t\\s+be|tends?(?:\\s+to\\s+be)?|tend|(?:may|might|could)\\s+be|appear(?:s|ed)?(?:\\s+to\\s+be)?';

// Numeric self-ranking ("#1", "No. 1", "number one") split out of the
// context-free ranking set: in educational pest prose these are overwhelmingly
// the "#1 entry point / #1 hidden breeding site" idiom, not a declared winner.
// PROD 2026-07-11: three educational drafts hard-blocked on exactly that idiom
// (and on "shady" meaning literal shade — see the prose disparagement scan).
// Numeric-one now needs comparison context: a <ComparisonTable> block, the
// title/meta, or a provider/brand near it in prose (evaluate()).
const NUMERIC_ONE_SRC = [
  '#\\s?1\\b',
  '\\bno\\.?\\s?1\\b',
  '\\bnumber one\\b',
];
const NUMERIC_ONE_RE = new RegExp(NUMERIC_ONE_SRC.join('|'), 'i');

// Self-declared ranking / superlative framing. Scanned over body + title/meta,
// so prose-safe: "best/top" only fire with a ranking context, never "the best
// time to treat" or "best pest control method".
const SELF_RANKING_SRC = [
  '\\btop[\\s-]?rated\\b',
  '\\bunbeatable\\b',
  '\\bbest[\\s-]in[\\s-]class\\b',
  '\\bhands[\\s-]down\\b',
  '\\bclear winner\\b',
  '\\bthe winner\\b',
  '\\bsuperior to\\b',
  '\\bbetter than (?:everyone|the rest|all others|the competition|any other)\\b',
  '\\bcrush\\w* the competition\\b',
  '\\bbest in (?:town|the area|swfl|southwest florida|florida|venice|sarasota|bradenton|manatee|charlotte|parrish|palmetto|north port)\\b',
  // "(the) best/top [adj] pest control/exterminator/lawn care" + ranking tail
  '\\b(?:the\\s+)?(?:best|top)\\s+(?:\\w+\\s+){0,2}(?:pest control|exterminators?|lawn (?:care|service))\\s+(?:company|companies|provider|service|choice|in|around|near)\\b',
  // "(the) best/top (pest control) company/provider/choice in/around/near"
  '\\b(?:the\\s+)?(?:best|top)\\s+(?:pest[\\s-]control\\s+)?(?:company|provider|choice)\\s+(?:in|around|near)\\b',
  // standalone self-ranking: "the best." / "the top choice" / "the best option"
  '\\bthe best\\b(?=\\s*(?:[.!?,;:)\\]"\\u2019\']|$))',
  '\\bthe (?:best|top) (?:choice|option|pick)\\b',
];
const SELF_RANKING_RE = new RegExp(SELF_RANKING_SRC.join('|'), 'i');
// Full set, kept for the module export (compat) — evaluate() scans the two
// halves separately so numeric-one can be context-scoped.
const RANKING_RE = new RegExp([...NUMERIC_ONE_SRC, ...SELF_RANKING_SRC].join('|'), 'i');

// Generic descriptors / methodologies that may precede a pest-industry suffix in
// PROSE but are not a business name.
// Generic descriptors / methodologies only. Geographic terms (Florida,
// Sarasota, Manatee, Venice, …) are deliberately NOT excluded: "Sarasota Pest
// Control" is a business-name pattern, not a generic phrase, so a location lead
// + industry suffix in prose/title must still be flagged for review.
const GENERIC_LEAD_EXCLUSIONS = 'Professional|Local|Quality|Affordable|Best|Reliable|Trusted|Expert|Licensed|Insured|Residential|Commercial|Pest|Lawn|Green|Safe|Eco|Modern|Premier|Quarterly|Monthly|Annual|Seasonal|Same|Top|Your|Our|The|This|That|These|Those|A|An|Integrated|Sustainable|Comprehensive|Targeted|Routine|Ongoing|Effective|Proper|Smart|Organic|Natural|General|Basic|Standard|Custom|Year|DIY';
// Broad pest-industry suffix set so business names with less-common suffixes
// (e.g. "HomeTeam Pest Defense", "Gulf Coast Termite Specialists") are still
// recognized — a proper-noun lead + any of these.
//
// "Care" is deliberately NOT in this shared set, and seasons/months are NOT
// in GENERIC_LEAD_EXCLUSIONS: both feed the PROSE scans, where "<geo/season>
// lawn care" is overwhelmingly education ("Sarasota lawn care is unreliable
// without irrigation", "May lawn care checklist") and geo/temporal leads are
// unbounded — while "May Pest Control is dishonest" must STAY a detectable
// disparagement target (Codex rounds 2–4). Lawn-care COMPANY columns are
// still caught by the HEADER-ONLY classifier regex below, which adds the
// Care suffix and the season/month lead exclusions in that scope only.
const INDUSTRY_SUFFIX_SRC = '(?:Pest|Termite|Bug|Lawn|Mosquito|Wildlife)\\s+(?:Control|Management|Solutions?|Services?|Defen[sc]e|Prevention|Elimination|Experts?|Pros?|Patrol|Squad|Busters?|Brigade|Specialists?|Defenders?)|Exterminators?|Exterminating|Termite (?:&|and) Pest|Environmental(?: Pest)?|Lawn (?:&|and) Pest';
const PROVIDER_NAME_SRC = `\\b((?!(?:${GENERIC_LEAD_EXCLUSIONS})\\b)[A-Z][A-Za-z0-9&'.\\-]*(?:\\s+(?:[A-Z][A-Za-z0-9&'.\\-]*|of|and|&)){0,3}\\s+(?:${INDUSTRY_SUFFIX_SRC}))\\b`;
function providerNameRe(flags) { return new RegExp(PROVIDER_NAME_SRC, flags); }

// A legal-entity-marked business name ("Bob's Bugs LLC", "Acme Exterminators Inc")
// anywhere in the draft — used to fail closed on business-looking names that
// carry no pest-industry suffix but a company marker. Possessive-only names are
// NOT scanned in prose (too noisy: "Florida's climate"); they are caught in
// option headers by classifyOption().
const LEGAL_ENTITY_NAME_SRC = `\\b([A-Z][A-Za-z0-9&'.\\-]*(?:\\s+[A-Za-z0-9&'.\\-]+){0,3}\\s+(?:LLC|L\\.L\\.C\\.|Inc\\.?|Incorporated|Corp\\.?|Co\\.|Bros\\.?|Brothers|& Sons?))\\b`;
function legalEntityRe(flags) { return new RegExp(LEGAL_ENTITY_NAME_SRC, flags); }

const BUSINESS_MARKER_RE = /\b[A-Z][a-z]+'s\b|\b(?:LLC|L\.L\.C\.|Inc\.?|Incorporated|Corp\.?|Co\.|Bros\.?|Brothers|& Sons?)\b/;
const OWN_BRAND_RE = /\bwaves\b/i;

// Case-insensitive provider-name detection for PROSE (see the comment block
// in evaluateProse for the exclusion rationale) — module scope so the table
// path's target-scoped tone scans use the SAME name inventory as the
// table-less directed scans (Codex on #2633: lowercase "acme pest solutions
// is dishonest" must stay a detectable target on both paths).
const CI_PROSE_EXCLUSIONS = `${GENERIC_LEAD_EXCLUSIONS}|How|What|When|Where|Why|Who|Which|To|With|For|From|About|Against|Compare|Compared|Comparing|Versus|Vs|Choose|Choosing|Avoid|Avoiding|Hire|Hiring|Find|Finding|Get|Getting|Use|Using|Than|Like|Say|Says|Said|Call|Calling|Called|Calls|Need|Needs|Want|Wants|Consider|Considering|Considers|Considered|Between|Before|After|Most|Many|Some|Any|Every|Other|Another|Good|Great|Better|Describe|Describes|Described|Label|Labels|Labeled|Labelled|Rate|Rates|Rated|Rank|Ranks|Ranked|Vote|Votes|Voted|Name|Names|Named|Make|Makes|Made|Making|Chose|Chooses|Select|Selects|Selecting|Selected|Pick|Picks|Picking|Picked|Prefer|Prefers|Preferring|Preferred|In|Into|No|None|Zero|Not|All|Few|Both`;
// Leads may be digit-led or carry a plus ("360 Pest Control", "A+ Pest
// Control") — an alphabetic-only lead let those names escape the
// target-scoped tone scans entirely (Codex r6 on #2633). The exclusion
// yields when the token continues with +/& ("A+" is a grade, not the
// article "A" — \b alone sits between them).
const CI_TOKEN = `(?!(?:${CI_PROSE_EXCLUSIONS})\\b(?![+&]))[a-z0-9][a-z0-9&+'.\\-]*`;
const CI_PROVIDER_NAME_RE = new RegExp(`\\b(${CI_TOKEN}(?:\\s+(?:${CI_TOKEN}|of|and|&)){0,3}\\s+(?:${INDUSTRY_SUFFIX_SRC}))\\b`, 'gi');
const NEG_INSIDE_RE_SRC = `(?:${DISPARAGEMENT_RE.source}|\\b(?:${NEG_ADJ})\\b)\\s+`;
const splitAtNegativity = (name) => {
  const inner = new RegExp(NEG_INSIDE_RE_SRC, 'gi');
  const nm = String(name).trim();
  let cut = -1;
  let mm;
  while ((mm = inner.exec(nm)) !== null) cut = mm.index + mm[0].length;
  return cut >= 0 ? nm.slice(cut).trim() : nm;
};

// ── HEADER-ONLY business-shape detectors (classifyOption) ──────────────────
// A table option header is a short label, not prose. Rule (Codex rounds 2–6
// converged here): any header CONTAINING a provider-suffix phrase ("Pest
// Control", "Lawn Care", "Mosquito Squad", "Exterminators", …) fails closed —
// no lead-shape guessing, so punctuated ("A+ Pest Control"), digit-led
// ("360 Pest Control"), bare-suffix ("Bug Busters"), and excluded-word-led
// ("Spring Green Lawn Care") provider names are all caught, case-
// insensitively — UNLESS the ENTIRE header is a strict category form:
// zero or more category modifiers followed by a generic service phrase
// ("DIY lawn care", "Professional pest control", "Spring lawn care",
// "quarterly pest control"). Headers with no provider-suffix phrase at all
// (species, attributes, methods) classify as category/educational.
// Legal-entity markers are checked case-insensitively ("bob's bugs llc");
// possessives stay case-sensitive (BUSINESS_MARKER_RE) — "season's" etc.
// Superset of the prose suffix set: adds the Rodent noun and the
// Care/Removal/Treatment service verbs so "Acme Rodent Removal" /
// "Acme Pest Treatment" are business-shaped here (Codex round-8).
const HEADER_BUSINESS_SUFFIX_RE = new RegExp(
  `\\b(?:${INDUSTRY_SUFFIX_SRC}|(?:Pest|Termite|Bug|Lawn|Mosquito|Wildlife|Rodent)\\s+(?:Care|Control|Management|Solutions?|Services?|Defen[sc]e|Prevention|Elimination|Experts?|Pros?|Patrol|Squad|Busters?|Brigade|Specialists?|Defenders?|Removal|Treatments?))\\b`,
  'i',
);
// Only UNAMBIGUOUS category modifiers — method (DIY/professional/basic),
// structure (national/franchise/…), cadence (quarterly/…), audience
// (residential/commercial), and temporal (seasons/months) words. Quality
// adjectives (Quality/Affordable/Eco/Budget/Premium/Standard/Organic/…) and
// "Local"/"Pro" are deliberately ABSENT: real companies are named that way
// ("Quality Pest Control", "Eco Pest Control"), so those headers fail closed
// and route to review, matching the gate's original behavior (Codex round-7).
const HEADER_CATEGORY_MODS = '(?:diy|do[\\s-]it[\\s-]yourself|professional|basic|store[\\s-]bought|over[\\s-]the[\\s-]counter|national|regional|independent|corporate|franchise|big[\\s-]box|quarterly|monthly|annual|seasonal|recurring|one[\\s-]time|preventive|preventative|reactive|on[\\s-]demand|residential|commercial|weekly|bi[\\s-]weekly|year[\\s-]round|early|late|spring|summer|fall|autumn|winter|january|february|march|april|may|june|july|august|september|october|november|december)';
const HEADER_GENERIC_SERVICE_PHRASE = '(?:(?:pest|lawn|mosquito|termite|bug|wildlife|rodent)\\s+(?:control|care|service|services|management|treatment|treatments|removal)(?:\\s+(?:service|services|plan|plans|program|programs))?|exterminators?|extermination)';
const HEADER_CATEGORY_FORM_RE = new RegExp(
  `^(?:${HEADER_CATEGORY_MODS}\\s+)*${HEADER_GENERIC_SERVICE_PHRASE}\\??$`,
  'i',
);
// A fully Title-Cased multi-word phrase reads as a NAME ("National Pest
// Control", "May Pest Control"), not a category — the category-form
// exemption additionally requires sentence/lower casing ("National pest
// control", "quarterly pest control"). Leading acronyms like "DIY" are why
// only words AFTER the first must be lowercase-led for the exemption.
function isTitleCasedPhrase(header) {
  const words = String(header).split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  if (words.length < 2) return false;
  return words.slice(1).every((w) => /^[A-Z0-9]/.test(w));
}
const HEADER_LEGAL_MARKER_RE = /\b(?:LLC|L\.L\.C\.|Inc\.?|Incorporated|Corp\.?|Co\.|Bros\.?|Brothers|& Sons?)\b/i;

// Business-shaped PROSE mentions that only the header detectors recognize —
// bare or less-common suffixes the prose name regex misses ("Bug Busters",
// "Acme Rodent Removal"), in ANY casing ("bug busters scams customers" must
// stay a target — Codex r2 on #2633). Target collection only, so it must not
// turn section headings into "businesses":
//  - lead tokens use the CI token discipline (common prose words excluded at
//    every position);
//  - a generic category phrase in ANY casing is skipped (unlike
//    classifyOption, no Title-Case tightening — "Professional Mosquito
//    Control" in prose is a heading, not a name);
//  - with no non-generic lead token, only PERSONIFIED suffixes count
//    ("Bug Busters", "Mosquito Squad" read as names; bare "Termite
//    Prevention"/"Rodent Removal" read as headings).
const PROSE_HEADER_SHAPE_RE = new RegExp(
  `\\b((?:${CI_TOKEN}\\s+){0,3})(${HEADER_BUSINESS_SUFFIX_RE.source})`, 'gi',
);
const PERSONIFIED_SUFFIX_RE = /\b(?:Busters?|Squad|Patrol|Brigade|Pros?|Experts?|Specialists?|Defenders?|Exterminators?)\s*$/i;
const GENERIC_LEAD_SET = new Set(GENERIC_LEAD_EXCLUSIONS.split('|').map((w) => w.toLowerCase()));
// Service-area geography: a capture whose every lead token is a place name
// reads as "<category> in <place>" ("Sarasota lawn care"), not a company.
// Used by the TABLE-LESS collection only (Codex r19 vs the locked r4 geo
// guard) — the table path keeps its broader capture, where comparison
// context raises the provider prior.
const GEO_LEAD_SET = new Set(('sarasota|bradenton|venice|parrish|palmetto|north|south|west|east|port|charlotte|punta|gorda|englewood|nokomis|osprey|ellenton|myakka|lakewood|ranch|manatee|florida|fl|swfl|tampa|naples|fort|myers|greater|central|downtown|coastal|metro|historic|old|new|upper|lower').split('|'));
function collectHeaderShapedProseTargets(text, { excludeGeoLeads = false } = {}) {
  const out = new Set();
  for (const m of String(text || '').matchAll(PROSE_HEADER_SHAPE_RE)) {
    const nm = splitAtNegativity(`${m[1]}${m[2]}`);
    if (!nm || OWN_BRAND_RE.test(nm)) continue;
    if (HEADER_CATEGORY_FORM_RE.test(nm)) continue;
    const leadTokens = String(m[1]).split(/\s+/).filter(Boolean);
    const hasNonGenericLead = leadTokens.some((t) => !GENERIC_LEAD_SET.has(t.toLowerCase()));
    if (!hasNonGenericLead && !PERSONIFIED_SUFFIX_RE.test(m[2])) continue;
    if (excludeGeoLeads && leadTokens.length
      && leadTokens.every((t) => GEO_LEAD_SET.has(t.toLowerCase()))
      && !PERSONIFIED_SUFFIX_RE.test(m[2])) continue;
    out.add(nm);
  }
  return out;
}

// Cell value affirms the row criterion → the CLAIM is the row label (so an
// uncurated row label like "Free termite inspections | Free" is validated, not
// waved through as a neutral mark).
const AFFIRMATIVE_CELL_RE = /^(yes|y|✓|✔|included|standard|available|offered|both|always|free|✅)$/i;
// Cell value is a truly NEUTRAL / non-asserting mark → no factual claim.
const NEUTRAL_CELL_RE = /^(n\/?a|none|n\.a\.|—|–|-|\*|varies|varies?\.?|quote[\s-]?based|optional|sometimes|limited|tbd|maybe|\$+)$/i;
// Cell value is a NEGATIVE mark — asserts the option LACKS the row's criterion.
// Harmless on a neutral feature row, but on a service-reliability/quality row
// it becomes a negative-reliability claim about a NAMED competitor (e.g.
// "Orkin — Answers the phone: Never"), which must route to human review rather
// than be silently waved through.
const NEGATIVE_CELL_RE = /^(no|n|never|✗|✘|x|❌)$/i;
// Row labels whose NEGATION reads as a provider service-reliability / quality
// claim. A negative cell under a named competitor on one of these is flagged.
const RELIABILITY_LABEL_RE = /\b(answers?|responds?|responsive|response|reachable|shows?\s?up|on[\s-]?time|punctual|reliab\w*|guarantee\w*|warrant\w*|call[\s-]?backs?|callbacks?|honors?|keeps?\s+appointments?|same[\s-]?day|emergency|24\/?7|availab\w*)\b/i;

function finding(severity, code, message) {
  return { severity, code, message };
}

// Sentence-level denial check shared by the proximity/object/sourced arms
// (Codex r12/r17/r18 on #2633): a negator anywhere earlier in the same
// sentence makes the match a denial ("There are no reports of hidden fees
// from Acme"), not an accusation.
// Contrastive "not only/just/to mention" is emphasis, not negation — "Not
// only that, hidden fees from Acme are common" / "Not just a rumor, hidden
// fees after choosing Waves are common" stay accusations (Codex r19/r22 on
// #2633). A negated RECOMMENDATION isn't a denial either: "Do not choose
// Bug Busters because of hidden fees" denies the choice, not the fees
// (Codex r20).
// Up to two words may sit between the negator and the recommendation verb —
// "No one should choose X because of hidden fees" negates the choice, not
// the fee claim (Codex r23 on #2633).
// Warning verbs join the recommendation exception — "No one should IGNORE
// hidden fees after choosing X" asserts the fees (Codex r24 on #2633).
// Emphatic idioms are not denials — "Without a doubt, hidden fees from X
// are common" asserts the claim (Codex r27 on #2633). "no(?!\.)": the
// "No. 1" ordinal abbreviation is never a negator.
const SENTENCE_NEGATOR_RE = /\b(?:no(?!\.)(?!\s+(?:doubt|question|wonder|surprise)\b)|not(?!\s+(?:only|just|to\s+mention)\b)|never|without(?!\s+(?:a\s+|any\s+)?(?:doubt|question)\b)|zero|don'?t|doesn'?t|do\s+not|does\s+not|aren'?t|isn'?t)\b(?!\s+(?:[\w'’]+\s+){0,2}(?:choos(?:e|ing)|pick(?:ing)?|hir(?:e|ing)|book(?:ing)?|select(?:ing)?|recommend(?:ing)?|us(?:e|ing)(?!\s+(?:shady|sketchy|dishonest|deceptive|predatory|scam|rip|overpriced|inflated|hidden|bait))|go(?:ing)?\s+with|ignor(?:e|es|ing)|overlook(?:s|ing)?|forget(?:s|ting)?|dismiss(?:es|ing)?|underestimat(?:e|es|ing)|miss(?:es|ing)?)\b)/i;
function sentenceHasNegator(text, index, length) {
  // Clause boundaries count: "No hidden fees here; Waves charges hidden
  // fees." must not let the first clause deny the second (Codex r31).
  const sentStart = Math.max(
    text.lastIndexOf('.', index),
    text.lastIndexOf('!', index),
    text.lastIndexOf('?', index),
    text.lastIndexOf(';', index),
    text.lastIndexOf(':', index),
    text.lastIndexOf('\n', index),
  ) + 1;
  let clause = text.slice(sentStart, index + length);
  // Coordinating conjunctions reset the negation scope — "X is not cheap
  // because it has hidden fees" asserts the fees (Codex r34). The reset
  // uses the LAST conjunction before the accusation match, so a negator in
  // an earlier coordinate clause cannot deny a later one.
  const conjRe = /\b(?:and|but|because|yet|so)\b/gi;
  let lastConj = -1;
  let cm;
  while ((cm = conjRe.exec(clause)) !== null) lastConj = cm.index + cm[0].length;
  if (lastConj !== -1) clause = clause.slice(lastConj);
  return SENTENCE_NEGATOR_RE.test(clause);
}

// Tail-scoped denial check for subject-verb arms whose verb list includes
// negative auxiliaries ("X isn't dishonest", "X never scams customers" are
// denials — Codex r19 on #2633). Only the post-name TAIL (named group
// "dtail") is checked: the name itself can carry a negator ("No Bugs Pest
// Control is dishonest" is an accusation — Codex r20), and contrastive
// lead-ins ("Not only that, X is dishonest") sit before the match entirely.
function spanUnnegated(m) {
  return m && !SENTENCE_NEGATOR_RE.test((m.groups && m.groups.dtail) || m[0]) ? m : null;
}

// Trailing denial after a separator accusation — "Bug Busters: hidden fees
// are not present" (Codex r32 on #2633). Narrow verb-anchored forms only:
// a bare trailing "no" can itself be an accusation ("…: hidden fees, no
// transparency").
const TRAILING_DENIAL_RE = /\b(?:(?:is|are|was|were|has|have)\s+)?(?:not|never)\s+(?:present|true|real|accurate|charged|applied|added|involved|included|found|happening|the\s+case|an?\s+(?:issue|problem|thing))\b/i;
function trailingDenial(text, index, length) {
  const end = index + length;
  let sentEnd = text.length;
  for (const ch of ['.', '!', '?', ';', ':', '\n']) {
    const i = text.indexOf(ch, end);
    if (i !== -1 && i < sentEnd) sentEnd = i;
  }
  return TRAILING_DENIAL_RE.test(text.slice(end, sentEnd));
}

// First unnegated match of `re` in `text` — a denied early sentence must
// not shadow a later live accusation (Codex r28/r29 on #2633).
function firstUnnegatedMatch(text, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m;
  while ((m = g.exec(text)) !== null) {
    if (!sentenceHasNegator(text, m.index, m[0].length)) return m;
    if (m.index === g.lastIndex) g.lastIndex += 1;
  }
  return null;
}

// ── Own-brand scans, shared by the table and table-less paths ──
// "Waves Pest Control charges hidden fees" must block in a plain no-table
// draft exactly as it does beside a comparison table (Codex r25 on #2633).
function scanOwnBrandDisparagementArms(scanText) {
  // Sentence-guarded and iterated — "No one calls Waves a scam" is a
  // denial, and a denied early match must not shadow a later live one
  // (Codex r28 on #2633).
  const joinedRe = new RegExp(OWN_BRAND_DISPARAGEMENT_RE.source, 'gi');
  let joined;
  while ((joined = joinedRe.exec(scanText)) !== null) {
    if (!sentenceHasNegator(scanText, joined.index, joined[0].length)) return joined;
  }
  // Case-sensitive brand anchor + case-insensitive object-anchored tail
  // ("Waves: Hidden fees"). EVERY anchor is checked: a benign earlier
  // heading must not shadow a later accusation (Codex r11).
  const sepAnchorRe = new RegExp(OWN_BRAND_SEP_ANCHOR_RE.source, 'g');
  let sa;
  while ((sa = sepAnchorRe.exec(scanText)) !== null) {
    const st = OWN_BRAND_SEP_TAIL_RE.exec(scanText.slice(sa.index + sa[0].length));
    if (st && !trailingDenial(scanText, sa.index + sa[0].length, st.index + st[0].length)) {
      return [scanText.slice(sa.index, sa.index + sa[0].length + 40)];
    }
  }
  // Linking/association tails behind the case-sensitive anchor (Codex
  // r18/r21). The linking tail's gap is negator-excluded; the assoc tail's
  // free window is not, so it takes the span negation guard — "Waves does
  // not get complaints about hidden fees" is a denial (Codex r22).
  const linkAnchorRe = new RegExp(OWN_BRAND_ANCHOR, 'g');
  let la;
  while ((la = linkAnchorRe.exec(scanText)) !== null) {
    const tailText = scanText.slice(la.index + la[0].length);
    let tm = OWN_BRAND_LINKING_TAIL_RE.exec(tailText);
    if (!tm) {
      const am2 = OWN_BRAND_ASSOC_TAIL_RE.exec(tailText);
      if (am2 && !SENTENCE_NEGATOR_RE.test(am2[0])) tm = am2;
    }
    if (tm) return [scanText.slice(la.index, la.index + la[0].length + tm[0].length)];
  }
  // Reverse arm with the case-verified brand token (Codex r19).
  const revRe = new RegExp(OWN_BRAND_REVERSE_SRC, 'gi');
  let rv;
  while ((rv = revRe.exec(scanText)) !== null) {
    if (!OWN_BRAND_CASE_RE.test(rv.groups.brandTok)) continue;
    if (sentenceHasNegator(scanText, rv.index, rv[0].length)) continue;
    return [rv[0]];
  }
  // Object association ("Customers report hidden fees after choosing
  // Waves") — case-verified + sentence-level denial guard (Codex r21).
  const assocRe = new RegExp(OWN_BRAND_OBJ_ASSOC_SRC, 'gi');
  let av;
  while ((av = assocRe.exec(scanText)) !== null) {
    if (!OWN_BRAND_CASE_RE.test(av.groups.brandTok)) continue;
    if (sentenceHasNegator(scanText, av.index, av[0].length)) continue;
    return [av[0]];
  }
  return null;
}

function scanOwnBrandRankingArms(scanText) {
  // Separator/appositive #1 ("Waves — the #1 choice", Codex r12) — every
  // anchor checked (Codex r11).
  const numAnchorRe = new RegExp(OWN_BRAND_NUMERIC_ANCHOR_RE.source, 'g');
  let na;
  while ((na = numAnchorRe.exec(scanText)) !== null) {
    if (OWN_BRAND_NUMERIC_TAIL_RE.test(scanText.slice(na.index + na[0].length))) {
      return [scanText.slice(na.index, na.index + na[0].length + 20)];
    }
  }
  // Waves-subject linking/marketing #1 arms behind the case-sensitive
  // anchor (Codex r19).
  const subjAnchorRe = new RegExp(OWN_BRAND_ANCHOR, 'g');
  let sa2;
  while ((sa2 = subjAnchorRe.exec(scanText)) !== null) {
    const tail = scanText.slice(sa2.index + sa2[0].length);
    const tm = OWN_BRAND_NUMERIC_SUBJECT_TAIL_RE.exec(tail) || OWN_BRAND_MARKETING_TAIL_RE.exec(tail);
    // Span-guarded: the free prefix window can hop a negator — "Waves does
    // not rank #1" is honest anti-ranking copy (Codex r31).
    if (tm && !SENTENCE_NEGATOR_RE.test(tm[0])) {
      return [scanText.slice(sa2.index, sa2.index + sa2[0].length + tm[0].length)];
    }
  }
  // #1-before-the-brand framing ("The #1 overall is Waves") — case-verified
  // brand token (Codex r21).
  const nbRe = new RegExp(OWN_BRAND_NUM_BEFORE_SRC, 'gi');
  let nb;
  while ((nb = nbRe.exec(scanText)) !== null) {
    if (!OWN_BRAND_CASE_RE.test(nb.groups.brandTok)) continue;
    if (sentenceHasNegator(scanText, nb.index, nb[0].length)) continue;
    return [nb[0]];
  }
  return null;
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function extractComparisonBlocks(body) {
  const text = String(body || '');
  const blocks = [];
  const re = /<ComparisonTable\b[\s\S]*?(?:\/>|<\/ComparisonTable>)/gi;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[0]);
  return blocks;
}

// A quoted string LITERAL that tolerates escaped quotes: the (?:\\.|…)
// alternation consumes an escaped char so `'Keller\'s Pest Control'` is read in
// full rather than truncated at the \'. Group 1 = quote char, group 2 = body.
const QUOTED_STR = "(['\"])((?:\\\\.|(?!\\1)[\\s\\S])*?)\\1";
function unescapeStr(s) { return String(s).replace(/\\(.)/g, '$1'); }
// Pull all quoted-string literals (unescaped) out of an array/fragment.
function quotedStrings(fragment) {
  const out = [];
  const re = new RegExp(QUOTED_STR, 'g');
  let m;
  while ((m = re.exec(String(fragment || ''))) !== null) out.push(unescapeStr(m[2]));
  return out;
}

function extractCaption(block) {
  const m = String(block || '').match(new RegExp(`caption\\s*=\\s*\\{?\\s*${QUOTED_STR}`, 'i'));
  return m ? unescapeStr(m[2]) : '';
}

function extractColumns(block) {
  const m = String(block || '').match(/columns\s*=\s*\{?\s*\[([\s\S]*?)\]/i);
  return m ? quotedStrings(m[1]) : [];
}

// Parse row objects ORDER-INSENSITIVELY and regardless of QUOTED keys: match
// each { … } that contains a values:[…] array (row objects carry no nested
// braces), then pull label + values independently of their order, any extra
// props, or whether the keys are bare (values:) or quoted ("values":).
function extractRows(block) {
  const rows = [];
  const objRe = /\{[^{}]*["']?values["']?\s*:\s*\[[^\]]*\][^{}]*\}/g;
  let m;
  while ((m = objRe.exec(String(block || ''))) !== null) {
    const obj = m[0];
    const labelM = obj.match(new RegExp(`["']?label["']?\\s*:\\s*${QUOTED_STR}`));
    const valsM = obj.match(/["']?values["']?\s*:\s*\[([\s\S]*?)\]/);
    rows.push({ label: labelM ? unescapeStr(labelM[2]) : '', values: valsM ? quotedStrings(valsM[1]) : [] });
  }
  return rows;
}

function hasAttribution(caption) {
  const c = String(caption || '');
  if (!c) return false;
  const hasAsOf = /\bas of\b|\b(?:current|accurate|verified|updated)\s+as of\b|\bas published\b/i.test(c);
  const hasDate = /\b20\d{2}\b/.test(c)
    || /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(c);
  const hasSource = /\b(source|per |according to|website|public(?:ly)?|state license|sunbiz|bbb|\.com\b|\.org\b|\.gov\b)\b/i.test(c);
  return hasAsOf && hasDate && hasSource;
}

function classifyOption(header) {
  const h = String(header || '').trim();
  if (!h) return 'category';
  // Competitor detection runs BEFORE the own-brand check: a column header that
  // names a competitor must be validated as a competitor column even when it
  // ALSO mentions Waves (e.g. "Waves vs Orkin"). Returning 'own' early there
  // would skip the competitor cells' curated-fact validation entirely. (Waves
  // is deliberately absent from the competitor detector, so a pure "Waves" /
  // "Waves Pest Control" header still falls through to 'own' below.)
  const mentions = competitorFacts.findBusinessMentions(h);
  if (mentions.some((m) => !m.inAllowlist)) return 'unknown_competitor';
  if (mentions.some((m) => m.inAllowlist)) return 'known_competitor';
  if (OWN_BRAND_RE.test(h)) return 'own';
  // Business-shape check via the HEADER-ONLY detectors (see their comment
  // block): company markers, or a provider-suffix phrase anywhere in the
  // header — fail closed unless the WHOLE header is a strict category form.
  if (BUSINESS_MARKER_RE.test(h) || HEADER_LEGAL_MARKER_RE.test(h)) return 'unclassified';
  if (HEADER_BUSINESS_SUFFIX_RE.test(h)) {
    return HEADER_CATEGORY_FORM_RE.test(h) && !isTitleCasedPhrase(h) ? 'category' : 'unclassified';
  }
  // Not business-SHAPED (no proper-name + industry suffix, no company
  // marker, no recognized competitor): a generic option header.
  // The writer legitimately uses <ComparisonTable> for educational content —
  // species lookalikes ("Real Brown Recluse"), attribute columns ("Type",
  // "Kid-safe?"), DIY methods ("Bleach + Google") — and the old
  // everything-fails-closed default routed 2–3 of those drafts to human
  // review per day as phantom "businesses" (COMPARISON_UNCLASSIFIED_OPTION).
  // Defamation needs a target; a header with no business shape has none, so
  // it classifies as a category/educational option. Provider-category
  // headers ("National chain", "DIY", "Local companies") land here too, as
  // they always did.
  return 'category';
}

// Negation markers — a NEGATED claim ("Not national", "No recurring plans")
// must NOT be treated as supported just because its non-negated words appear in
// a curated attribute; it asserts the OPPOSITE of the curated source.
const NEGATOR_RE = /\b(no|not|never|without|lacks?|cannot|can'?t|does\s?n'?t|do\s?n'?t|is\s?n'?t|are\s?n'?t|wo\s?n'?t|non)\b|n['’]t\b/i;

/**
 * claimSupported(text, attrValues) → true iff EVERY significant word of `text`
 * appears in a single curated attribute value (subset match). Stricter than a
 * loose substring/overlap so a curated phrase with appended uncurated text
 * ("National (US); free termite inspections") is NOT treated as supported. A
 * negated claim is supported ONLY by an explicit (near-exact) curated value.
 */
function claimSupported(text, attrValues) {
  const nt = normalize(text);
  if (!nt) return true;
  if (NEGATOR_RE.test(String(text))) {
    // Only an explicitly-curated value that itself matches the (negated) claim
    // supports it — otherwise a negation of a curated fact would slip through.
    return attrValues.some((av) => normalize(av) === nt);
  }
  const words = nt.split(' ').filter((w) => w.length > 3);
  if (!words.length) {
    // A value made only of short / numeric tokens ("24/7", "A+ rating" → "a
    // rating") is still a factual CLAIM (trivial yes/no marks are filtered by
    // the caller). Require EVERY claim token to appear as a whole token of a
    // curated value — NOT a substring, so "A+" → "a" is not "supported" by an
    // unrelated curated value like "National (US)" → "national us" via the
    // stray "a" inside "national".
    const claimTokens = nt.split(' ').filter(Boolean);
    if (!claimTokens.length) return true;
    return attrValues.some((av) => {
      const naTokens = normalize(av).split(' ').filter(Boolean);
      return claimTokens.every((t) => naTokens.includes(t));
    });
  }
  for (const av of attrValues) {
    const na = normalize(av);
    if (!na) continue;
    if (words.every((w) => na.includes(w))) return true;
  }
  return false;
}

// Title/meta live at the draft TOP LEVEL in some producer shapes and in
// frontmatter in others (the runner and sibling gates accept both) — every
// scan that includes metadata must collect from BOTH places, or a
// disparaging title on a metadata-only draft escapes entirely. Single
// collector so the table-path prose scan and the table-less scan can never
// drift apart on which shape they see.
function draftMetaText(draft) {
  const fm = draft?.frontmatter || {};
  return ['title', 'meta_description', 'metaTitle', 'metaDescription']
    .flatMap((k) => [draft?.[k], fm[k]])
    .filter(Boolean).map(String).join('\n');
}

function draftScanTexts(draft, body) {
  const metaText = draftMetaText(draft);
  return metaText ? `${body}\n${metaText}` : body;
}

/**
 * evaluateProse(draft, body, { operatorBriefText }) — the table-less legal
 * scan. Flags:
 *   P0 COMPARISON_DISPARAGEMENT   — a disparaging/negative term within
 *      proximity of ANY business-looking name (curated competitor, provider-
 *      suffix name, or legal-entity name)
 *   P1 COMPARISON_NEGATIVE_RELIABILITY — a service-reliability negative near
 *      a business-looking name
 *   P0 COMPARISON_UNKNOWN_COMPETITOR   — a recognized competitor NOT on the
 *      curated allowlist named anywhere (its claims can't be verified)
 *   P1 COMPARISON_COMPETITOR_IN_PROSE  — an allowlisted competitor named
 *      outside a comparison table (existing policy: table cells only, where
 *      every claim is validated)
 * A business-shaped name with NO nearby negativity is fine here (unlike the
 * table path's fail-closed UNCLASSIFIED_OPTION) — "Sarasota Pest Control
 * Guide" as a title must not block a normal post.
 *
 * operatorBriefText — the OPERATOR-authored intercept-brief text (title/
 * keywords/thesis/outline). A recognized competitor the operator personally
 * named there (e.g. the Aptive cancellation brief) is authorized content:
 * instead of the hard UNKNOWN_COMPETITOR / COMPETITOR_IN_PROSE block, the
 * draft sets requiresHumanReview so the runner parks it on the APPROVABLE
 * named-competitor review path — a human still signs off every one, and
 * the disparagement/reliability scans above still apply at full curated
 * strictness. Names the operator did NOT write stay hard-blocked; mined
 * briefs pass no text, so nothing changes for them.
 */
function evaluateProse(draft, body, { operatorBriefText = '' } = {}) {
  const findings = [];
  const scanText = draftScanTexts(draft, body);
  const stripQuotesForNames = (s) => String(s).replace(/[\\"“”]/g, ' ');
  const nameScanText = stripQuotesForNames(scanText);
  // Authorized names come from running the SAME mention detector over the
  // operator's brief text — both sides canonicalize identically, so a brief
  // that says "Massey" authorizes a draft that writes the canonical "Massey
  // Services" (a raw substring compare missed every alias↔canonical pair).
  // Matching is word-boundary CONTAINMENT in either direction, not exact
  // string: detection-only tokens canonicalize by surface form, so a brief
  // that says "Aptive" and a draft that writes "Aptive Environmental"
  // produce different unknown names for the same business — the operator's
  // shorter token must still authorize the fuller one (and vice versa).
  // Names on both sides come from findBusinessMentions' recognition corpus,
  // so containment can't be gamed with arbitrary prose.
  const authorizedNames = new Set();
  if (operatorBriefText) {
    for (const m of competitorFacts.findBusinessMentions(stripQuotesForNames(String(operatorBriefText)))) {
      authorizedNames.add(String(m.name).toLowerCase());
    }
  }
  const wordBoundaryContains = (haystack, needle) =>
    new RegExp(`(?:^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?:\\s|$)`, 'i').test(haystack);
  const operatorAuthorized = (name) => {
    const nm = String(name).toLowerCase();
    if (authorizedNames.has(nm)) return true;
    for (const auth of authorizedNames) {
      if (wordBoundaryContains(nm, auth) || wordBoundaryContains(auth, nm)) return true;
    }
    return false;
  };

  const known = new Set();
  const unknown = new Set();
  const genericNames = new Set();
  for (const m of competitorFacts.findBusinessMentions(nameScanText)) {
    (m.inAllowlist ? known : unknown).add(m.name);
  }
  // Case-INSENSITIVE provider/legal-entity passes: a disparaged target
  // written lowercase or all-caps ("acme pest solutions is dishonest")
  // otherwise never enters genericNames and the negativity scan passes.
  // In the Title Case pass, capitalization is what stops ordinary prose
  // from bridging into a "name"; the CI variant recreates that anchor by
  // excluding common prose words (interrogatives, prepositions, comparison
  // verbs) from EVERY token position, not just the lead — otherwise
  // fragments like "compared with professional pest control" become
  // genericNames and any nearby negativity ("useless compared with…")
  // blocks a normal article. And because lowercase adjectives are valid
  // CI tokens, a capture can still swallow its own preceding negativity
  // ("dishonest acme pest solutions") — captures are SPLIT at their last
  // interior negativity token so the adjective sits back OUTSIDE the name
  // where the neg-before-name directed check sees it.
  // CI/legal captures are NAME-CONFIDENT and qualify for the association
  // arm, mirroring the table path (Codex r20/r23 on #2633).
  const confidentGenericNames = new Set();
  for (const m of nameScanText.matchAll(CI_PROVIDER_NAME_RE)) {
    const nm = splitAtNegativity(m[1]);
    if (nm && !OWN_BRAND_RE.test(nm)) { genericNames.add(nm); confidentGenericNames.add(nm); }
  }
  for (const m of nameScanText.matchAll(legalEntityRe('gi'))) {
    const nm = splitAtNegativity(m[1]);
    if (nm && !OWN_BRAND_RE.test(nm)) { genericNames.add(nm); confidentGenericNames.add(nm); }
  }
  // Header-shaped names too ("Bug Busters", "Acme Rodent Removal") — the
  // table path treats them as business-shaped targets, so the table-less
  // path must as well ("Bug Busters scams customers" in plain prose —
  // Codex r19 on #2633). Geo-led captures are skipped here: "Sarasota lawn
  // care is unreliable without irrigation" is educational (locked r4 guard).
  for (const nm of collectHeaderShapedProseTargets(nameScanText, { excludeGeoLeads: true })) genericNames.add(nm);
  const curatedNames = [...known, ...unknown];
  for (const nm of curatedNames) genericNames.delete(nm);

  // Own-brand scans run here too — a no-table draft saying "Waves Pest
  // Control charges hidden fees" or "We are #1" carries the same legal
  // risk as one beside a comparison table (Codex r25 on #2633).
  const ownDisp = scanOwnBrandDisparagementArms(scanText);
  if (ownDisp) {
    findings.push(finding('P0', 'COMPARISON_DISPARAGEMENT',
      `Draft contains disparaging language about Waves itself ("${ownDisp[0].trim()}"). State attributes, never insults — in prose, the title, and the meta.`));
  }
  // Non-numeric superlatives ("We are the best choice in Venice", "Waves
  // is the clear winner") enforce the same anti-ranking rule table-less
  // (Codex r33) — plain whole-text match, matching the table path.
  let ownRank = scanText.match(SELF_RANKING_RE);
  if (!ownRank) {
    // Sentence-guarded and iterated, same as the table path (Codex r28).
    const numSelfRe = new RegExp(NUMERIC_SELF_RANKING_RE.source, 'gi');
    let nsm;
    while ((nsm = numSelfRe.exec(scanText)) !== null) {
      if (!sentenceHasNegator(scanText, nsm.index, nsm[0].length)) { ownRank = nsm; break; }
    }
  }
  if (!ownRank) ownRank = scanOwnBrandRankingArms(scanText);
  if (ownRank) {
    findings.push(finding('P1', 'COMPARISON_RIGGED_RANKING',
      `Draft uses self-ranking framing ("${ownRank[0].trim()}"). Present neutral trade-offs — do not declare a winner, in prose, the title, or the meta.`));
  }

  // Curated competitor names: bare PROXIMITY is enough (a real brand plus
  // negativity nearby is legal surface even without tidy grammar — mirrors
  // the comparison path's prose scan). Generic business-SHAPED phrases need
  // the negativity DIRECTED at the name — name-as-subject before a negative
  // predicate, or the negative term immediately modifying the name. Bare
  // proximity false-positives on titles like "Sarasota Pest Control Guide:
  // Worst Roach Problems", where the negative describes the pest problem.
  if (curatedNames.length) {
    const nearCurated = (idx, len) => {
      const window = nameScanText
        .slice(Math.max(0, idx - PROVIDER_NEGATIVE_PROXIMITY), idx + len + PROVIDER_NEGATIVE_PROXIMITY)
        .toLowerCase()
        .replace(/\s+/g, ' ');
      return curatedNames.some((n) => window.includes(n.toLowerCase().replace(/\s+/g, ' ')));
    };
    const p0Re = new RegExp(`${DISPARAGEMENT_RE.source}|\\b(?:${NEG_ADJ})\\b`, 'gi');
    let am;
    while ((am = p0Re.exec(scanText)) !== null) {
      if (nearCurated(am.index, am[0].length)) {
        findings.push(finding('P0', 'COMPARISON_DISPARAGEMENT',
          `Draft disparages a named competitor ("${am[0].trim()}" near a competitor name). State neutral attributes only — in prose, the title, and the meta.`));
        break;
      }
    }
    const negRe = new RegExp(PROVIDER_NEGATIVE_RE.source, 'gi');
    let nm;
    while ((nm = negRe.exec(scanText)) !== null) {
      if (nearCurated(nm.index, nm[0].length)) {
        findings.push(finding('P1', 'COMPARISON_NEGATIVE_RELIABILITY',
          `Draft makes a negative service-reliability claim near a named competitor ("${nm[0].trim()}"). Routed to human review — state neutral, verifiable attributes only.`));
        break;
      }
    }
  }

  for (const name of genericNames) {
    const escaped = escapeForNameRe(name);
    // Name-as-subject: "<Name> [word word] is/never/keeps … <negative>" —
    // within the same sentence, a linking/behavioral verb between the name
    // and the negative term ties the negativity to the business.
    const directedP0 = new RegExp(
      `${escaped}\\b(?:['’]s?)?(?<dtail>(?:\\s+\\w+){0,2}\\s+(?:${SUBJECT_VERBS})\\b[^.!?\\n]{0,60}(?:${DISPARAGEMENT_RE.source}|\\b(?:${NEG_ADJ})\\b))`, 'i',
    );
    // Negative adjective immediately modifying the name ("the dishonest
    // Acme Pest Solutions"). Denial-guarded like the table path ("No hidden
    // fees from Acme" — Codex r18).
    const negBeforeName = new RegExp(`(?<!\\bno\\s)(?<!\\bwithout\\s)(?<!\\bzero\\s)(?:${DISPARAGEMENT_RE.source}|\\b(?:${NEG_ADJ})\\b)\\s+(?:\\w+\\s+)?${escaped}\\b`, 'i');
    // ACTIVE disparaging predicate right after the name ("<Name> scams
    // customers", "<Name> charges hidden fees") — the linking-verb shape
    // above misses transitive verbs, and these victim-anchored idioms only
    // read with the name as subject. Same appositive-tolerant gap and
    // modal-capable adverbs as the table path ("<Name> may charge hidden
    // fees" — Codex r18); the negator-excluded gap keeps "<Name> never
    // charges hidden fees" a denial.
    const activeP0 = new RegExp(
      `${escaped}\\b(?:['’]s?)?${NOUN_VERB_GAP}${ACTIVE_ADVERBS}(?:${ACTIVE_DISPARAGEMENT_SRC})`, 'i',
    );
    // Possession/usage and sourced-at-name accusations, mirroring the table
    // path ("<Name> uses scam pricing", "dishonest pricing from <Name>" —
    // Codex r18); the sourced form is sentence-level denial-guarded.
    const possessionP0 = new RegExp(
      `${escaped}\\b(?:['’]s?)?(?:${NOUN_VERB_GAP}(?:has|have|had|uses?|used|includes?|included|comes?\\s+with|(?:known|notorious|infamous)\\s+for|accused\\s+of|blamed\\s+for|cited\\s+for)|\\s+with)\\s+(?:(?:a|an|the|really|very)\\s+){0,2}${POSSESSION_ACCUSATION_SRC}`, 'i',
    );
    const fromP0 = new RegExp(`(?:${ASSOC_ACCUSATION_SRC})\\s+(?:from|at|by)\\s+${escaped}\\b`, 'i');
    // Span-guarded like the table path: "Acme Pest Solutions isn't
    // dishonest" is a denial (Codex r19).
    let disparaged = Boolean(spanUnnegated(nameScanText.match(directedP0)))
      || activeP0.test(nameScanText) || possessionP0.test(nameScanText);
    if (!disparaged) {
      // Association shapes take the sentence-level denial guard, same as
      // the table path (Codex r18). Name-confident names also get the
      // object-association arm — "Customers report hidden fees after
      // choosing Bug Busters" in plain prose (Codex r23).
      const objAssocP0 = (PERSONIFIED_SUFFIX_RE.test(name) || confidentGenericNames.has(name))
        ? new RegExp([
          `${escaped}[^.!?\\n]{0,80}?(?<!\\bno\\s)(?<!\\bwithout\\s)(?<!\\bzero\\s)(?:${ASSOC_ACCUSATION_SRC})`,
          `(?<!\\bno\\s)(?<!\\bwithout\\s)(?<!\\bzero\\s)(?:${ASSOC_ACCUSATION_SRC})[^.!?\\n]{0,80}?${escaped}`,
        ].join('|'), 'i')
        : null;
      const am = firstUnnegatedMatch(nameScanText, negBeforeName)
        || firstUnnegatedMatch(nameScanText, fromP0)
        || (objAssocP0 && firstUnnegatedMatch(nameScanText, objAssocP0));
      // Trailing verb-anchored denials clear these too — "Bug Busters:
      // hidden fees are not present." (Codex r32/r33).
      disparaged = Boolean(am && !trailingDenial(nameScanText, am.index, am[0].length));
    }
    if (disparaged) {
      findings.push(finding('P0', 'COMPARISON_DISPARAGEMENT',
        `Draft directs disparaging language at "${name}". State neutral attributes only — in prose, the title, and the meta.`));
      break;
    }
    // Service-reliability negative predicated on the name — either as the
    // DIRECT predicate ("<Name> never answers the phone", "<Name> no-shows")
    // or linked through a subject verb ("<Name> is unreliable"). A bare
    // reliability term merely NEAR the name is not enough: "Sarasota Pest
    // Control Guide: Why DIY Sprays Are Unreliable" aims the negative at DIY
    // sprays, not the business-shaped phrase, and must pass.
    const directedReliability = new RegExp(
      `${escaped}\\b(?:['’]s?)?(?<rtail>(?:\\s+(?!(?:not|never|no)\\b)\\w+){0,2}\\s+(?:(?:${SUBJECT_VERBS})\\b[^.!?\\n]{0,60})?)(?:${PROVIDER_NEGATIVE_RE.source})`, 'i',
    );
    const relMatch = nameScanText.match(directedReliability);
    if (relMatch && !SENTENCE_NEGATOR_RE.test(relMatch.groups.rtail)) {
      findings.push(finding('P1', 'COMPARISON_NEGATIVE_RELIABILITY',
        `Draft makes a negative service-reliability claim about "${name}". Routed to human review — state neutral, verifiable attributes only.`));
      break;
    }
  }

  let requiresHumanReview = false;
  for (const nm of unknown) {
    if (operatorAuthorized(nm)) {
      // The operator named this competitor in the intercept brief — route
      // to the approvable named-competitor review instead of hard-blocking.
      requiresHumanReview = true;
      continue;
    }
    findings.push(finding('P0', 'COMPARISON_UNKNOWN_COMPETITOR',
      `Names "${nm}", a recognized competitor not on the curated competitor-facts allowlist — its claims cannot be verified. Remove the mention or add "${nm}" to competitor-facts.js with sourced, dated facts.`));
  }
  for (const nm of known) {
    if (operatorAuthorized(nm)) {
      requiresHumanReview = true;
      continue;
    }
    findings.push(finding('P1', 'COMPARISON_COMPETITOR_IN_PROSE',
      `Names competitor "${nm}" in prose/title/meta with no comparison table — claims there are not validated against competitor-facts.js. Name a competitor ONLY inside a <ComparisonTable> (every cell is checked).`));
  }

  const pass = !findings.some((f) => f.severity === 'P0' || f.severity === 'P1');
  return { pass, findings, requiresHumanReview };
}

// Escape a detected business name for use inside a regex, tolerating the
// collapsed whitespace stripQuotesForNames leaves behind.
function escapeForNameRe(name) {
  return String(name || '')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
}

/**
 * evaluate(draft, { namedCompetitorEnabled, operatorBriefText })
 *   → { pass, findings, requiresHumanReview }
 * operatorBriefText applies to the TABLE-LESS path only (see evaluateProse):
 * table cells always validate against curated competitor-facts — operator
 * authorship can't make an unverifiable table claim verifiable.
 */
function evaluate(draft, { namedCompetitorEnabled = false, operatorBriefText = '' } = {}) {
  const body = String(draft?.body || draft?.content || '');
  const findings = [];
  const blocks = extractComparisonBlocks(body);
  // Empty body alone doesn't skip the scan — a metadata-only draft can
  // still carry a disparaging title/meta (draftScanTexts covers both the
  // top-level and frontmatter shapes).
  if (!body && !draftScanTexts(draft, '').trim()) return { pass: true, findings, requiresHumanReview: false };
  if (blocks.length === 0) return evaluateProse(draft, body, { operatorBriefText });

  // Same collector as draftScanTexts: the prose-only competitor check below
  // appends metaText to proseText, so a frontmatter-only rebuild here would
  // let a TOP-LEVEL title like "Orkin vs Waves in Sarasota" ride alongside a
  // sourced table with only requiresHumanReview instead of a prose finding.
  const metaText = draftMetaText(draft);
  const scanText = draftScanTexts(draft, body);
  // For NAME detection only, drop double quotes AND backslashes (so an embedded-
  // quote brand like All "U" Need Pest Control — or its escaped \"U\" form — is
  // read as one name, not a "Need Pest Control" fragment). Apostrophes are kept
  // (Keller's). Disparagement/ranking scans keep the original scanText. Each
  // stripped char becomes a space, so this is length-preserving (scanText and
  // nameScanText share character indices) but can leave multiple spaces between
  // words — name lookups must stay whitespace-tolerant.
  const stripQuotesForNames = (s) => String(s).replace(/[\\"“”]/g, ' ');
  const nameScanText = stripQuotesForNames(scanText);

  const known = new Set();
  const unknown = new Set();
  const unclassified = new Set();
  const unsourcedKnown = new Set();
  const blockNamedKnown = new Set();
  const unsupportedFacts = new Set();
  const negativeReliability = new Set();

  // Business names are collected BEFORE the tone scans: the prose-scoped
  // disparagement/ranking checks below need the full name inventory as
  // proximity targets.
  for (const m of competitorFacts.findBusinessMentions(nameScanText)) {
    (m.inAllowlist ? known : unknown).add(m.name);
  }
  for (const m of nameScanText.matchAll(providerNameRe('g'))) {
    const nm = m[1].trim();
    if (OWN_BRAND_RE.test(nm)) continue;
    if (competitorFacts.isKnownCompetitor(nm)) known.add(competitorFacts.findCompetitor(nm).name);
    else unclassified.add(nm);
  }
  // Legal-entity-marked business names ("Bob's Bugs LLC") anywhere in the draft.
  for (const m of nameScanText.matchAll(legalEntityRe('g'))) {
    const nm = m[1].trim();
    if (OWN_BRAND_RE.test(nm)) continue;
    if (competitorFacts.isKnownCompetitor(nm)) known.add(competitorFacts.findCompetitor(nm).name);
    else unclassified.add(nm);
  }

  // proseText = body with the <ComparisonTable> blocks removed, plus
  // title/meta. Used by the prose-scoped tone scans here and by the
  // competitor-in-prose check further down.
  let proseText = body;
  for (const b of blocks) proseText = proseText.split(b).join(' ');
  if (metaText) proseText = `${proseText}\n${metaText}`;
  const proseNameText = stripQuotesForNames(proseText); // length-preserving; indices align

  // A detected business name within PROVIDER_NEGATIVE_PROXIMITY of a prose
  // match — same window idiom as the competitor scans below.
  const targetNames = [...known, ...unknown, ...unclassified];
  // Names only the looser detectors see — case-insensitive provider names
  // ("acme pest solutions") and header-shaped names ("Bug Busters") — stayed
  // disparageable under the old whole-text scan and must remain so (Codex on
  // #2633). They get the DIRECTED grammar (same shapes as the table-less
  // path), NOT bare proximity: the CI pass picks up incidental mid-sentence
  // service mentions ("… meals, and Termite Prevention starts at the slab")
  // that proximity would turn into phantom disparagement targets. They do
  // NOT feed the unclassified-option findings.
  const extraProseNames = new Set();
  // CI/legal-entity captures are NAME-CONFIDENT (industry-suffix or legal
  // marker with the full token discipline) — they qualify for the looser
  // object-association arm, which header-shaped non-personified captures
  // do not ("and Termite Prevention" noise — Codex r11/r20 on #2633).
  const confidentProseNames = new Set();
  for (const m of proseNameText.matchAll(CI_PROVIDER_NAME_RE)) {
    const nm = splitAtNegativity(m[1]);
    if (nm && !OWN_BRAND_RE.test(nm)) { extraProseNames.add(nm); confidentProseNames.add(nm); }
  }
  // Lowercase legal-entity names ("acme holdings llc") — same CI pass the
  // table-less path runs (Codex r3 on #2633).
  for (const m of proseNameText.matchAll(legalEntityRe('gi'))) {
    const nm = splitAtNegativity(m[1]);
    if (nm && !OWN_BRAND_RE.test(nm)) { extraProseNames.add(nm); confidentProseNames.add(nm); }
  }
  for (const nm of collectHeaderShapedProseTargets(proseNameText)) extraProseNames.add(nm);
  for (const nm of targetNames) extraProseNames.delete(nm);
  const nearBusinessName = (idx, len) => {
    const window = proseNameText
      .slice(Math.max(0, idx - PROVIDER_NEGATIVE_PROXIMITY), idx + len + PROVIDER_NEGATIVE_PROXIMITY)
      .toLowerCase()
      .replace(/\s+/g, ' ');
    return targetNames.some((n) => window.includes(n.toLowerCase().replace(/\s+/g, ' ')));
  };

  // ── Whole-text + prose tone scans (body + title/meta) ──
  // PROD 2026-07-11: bare disparagement tokens used to block ANYWHERE in the
  // draft — "shady corners of the lanai" / "shady, humid microclimates"
  // (literal shade, the dominant sense in pest content) hard-blocked
  // educational drafts. The finding claims language "about a provider", so
  // the PROSE scan now requires one: the term must be DIRECTED at a provider
  // noun (PROVIDER_DISPARAGEMENT_RE / DIRECTED_DISPARAGEMENT_RE) or sit
  // within proximity of a detected business name. Inside a <ComparisonTable>
  // block the bare vocabulary still blocks unconditionally (per-table scan
  // below) — table cells are provider/option context by construction, and
  // category-table strictness is asserted by existing tests.
  // Provider/directed whole-text matches take the sentence-level denial
  // guard — "Not all pest control companies charge hidden fees" is consumer
  // protection beside a table too (Codex r27); the contrastive/warning/
  // recommendation exclusions in SENTENCE_NEGATOR_RE keep real accusations
  // ("Not only that, companies scam customers" still blocks).
  // A denied early match must not shadow a later live accusation — "No
  // chains are shady. Providers are incompetent." (Codex r28): iterate
  // every match, skipping negated sentences.
  let disp = null;
  for (const re of [PROVIDER_DISPARAGEMENT_RE, DIRECTED_DISPARAGEMENT_RE, OWN_BRAND_DISPARAGEMENT_RE]) {
    const g = new RegExp(re.source, 'gi');
    let m;
    while ((m = g.exec(scanText)) !== null) {
      if (!sentenceHasNegator(scanText, m.index, m[0].length)) { disp = m; break; }
    }
    if (disp) break;
  }
  if (!disp) {
    const bareDispRe = new RegExp(DISPARAGEMENT_RE.source, 'gi');
    let dm;
    while ((dm = bareDispRe.exec(proseText)) !== null) {
      if (!nearBusinessName(dm.index, dm[0].length)) continue;
      // "No hidden fees from Acme Pest Solutions" is a denial even though
      // the token sits near a business name (Codex r17 guard on #2633).
      if (sentenceHasNegator(proseText, dm.index, dm[0].length)) continue;
      disp = dm;
      break;
    }
  }
  if (!disp) {
    // Anchored own-brand arms (linking/assoc/reverse/object-association) —
    // shared helper with the table-less path (Codex r25).
    disp = scanOwnBrandDisparagementArms(scanText);
  }
  if (!disp) {
    // Directed grammar for the looser name classes (see extraProseNames):
    // name-as-subject before a negative, negative immediately modifying the
    // name, or an active disparaging predicate — the same three shapes the
    // table-less path uses for generic business names.
    for (const name of extraProseNames) {
      const escaped = escapeForNameRe(name);
      // NOUN_VERB_GAP tolerates appositives — "bug busters, a local
      // option, is dishonest" (Codex r5 on #2633). Possessives accept the
      // bare and typographic forms — "Bug Busters' billing is dishonest"
      // has no trailing s (Codex r14 on #2633).
      const directedP0 = new RegExp(
        `${escaped}\\b(?:['’]s?)?(?<dtail>${NOUN_VERB_GAP}(?:${SUBJECT_VERBS})\\b[^.!?\\n]{0,60}(?:${DISPARAGEMENT_RE.source}|\\b(?:${NEG_ADJ})\\b))`, 'i',
      );
      // Denial-guarded: "No hidden fees from Acme" is marketing-clean, not
      // an accusation (Codex r17 guard on #2633).
      const negBeforeName = new RegExp(`(?<!\\bno\\s)(?<!\\bwithout\\s)(?<!\\bzero\\s)(?:${DISPARAGEMENT_RE.source}|\\b(?:${NEG_ADJ})\\b)\\s+(?:\\w+\\s+)?${escaped}\\b`, 'i');
      // Active predicates take the same appositive-tolerant gap as the
      // provider-noun active arm — "Bug Busters, frankly, scams customers"
      // (Codex r15 on #2633). NOUN_VERB_GAP's words are negator-excluded, so
      // "X never scams customers" stays a denial.
      const activeP0 = new RegExp(`${escaped}\\b(?:['’]s?)?${NOUN_VERB_GAP}${ACTIVE_ADVERBS}(?:${ACTIVE_DISPARAGEMENT_SRC})`, 'i');
      // Punctuation-separated claims ("Bug Busters: shady billing",
      // "Mosquito Squad — shady billing") carry no verb for the shapes
      // above (Codex r2 on #2633). Only PERSONIFIED suffixes get this arm:
      // they read as names on their face, while noisy CI captures ("and
      // termite prevention") would turn "… — shady corners" back into the
      // original false positive.
      // Non-personified names get an OBJECT/UNAMBIGUOUS-anchored separator
      // instead ("acme pest solutions: dishonest", "bob bugs llc: hidden
      // fees") — the full vocabulary on noisy CI captures would turn "…
      // and termite prevention — shady corners" back into the original
      // false positive (Codex r6/r12 on #2633). The vocabulary restriction
      // is the guard, not the separator set, so comma qualifies here too —
      // "A+ Pest Control, dishonest." (Codex r15). Prefix words are
      // negator-excluded on both arms ("X: not overpriced" is a denial).
      const sepP0 = PERSONIFIED_SUFFIX_RE.test(name)
        ? new RegExp(`${escaped}\\b(?:['’]s?)?\\s*[:,—–-]\\s*(?:${NON_NEGATED_WORD}\\s+){0,2}(?:${DISPARAGEMENT_RE.source}|\\b(?:${NEG_ADJ})\\b)`, 'i')
        : new RegExp(`${escaped}\\b(?:['’]s?)?\\s*[:,—–-]\\s*(?:${NON_NEGATED_WORD}\\s+){0,2}(?:${POSSESSION_ACCUSATION_SRC}|${UNAMBIGUOUS_DISPARAGEMENT_SRC})`, 'i');
      // Possession/usage accusations with the required object ("Bug Busters
      // uses shady billing", "Acme Rodent Removal comes with hidden fees")
      // — Codex r4 on #2633. Appositive-tolerant gap and the prepositional
      // form, same as the provider-noun arm ("Acme Rodent Removal, frankly,
      // comes with hidden fees" / "… with hidden fees should be avoided" —
      // Codex r16).
      const possessionP0 = new RegExp(
        `${escaped}\\b(?:['’]s?)?(?:${NOUN_VERB_GAP}(?:has|have|had|uses?|used|includes?|included|comes?\\s+with|(?:known|notorious|infamous)\\s+for|accused\\s+of|blamed\\s+for|cited\\s+for)|\\s+with)\\s+(?:(?:a|an|the|really|very)\\s+){0,2}${POSSESSION_ACCUSATION_SRC}`, 'i',
      );
      // Accusation-phrase SOURCED at the name — "dishonest pricing from
      // acme pest solutions" (Codex r17 on #2633). Sentence-level denial
      // guard at the match site: "There are no reports of hidden fees from
      // Acme" is marketing-clean (Codex r18).
      const fromP0 = new RegExp(
        `(?:${ASSOC_ACCUSATION_SRC})\\s+(?:from|at|by)\\s+${escaped}\\b`, 'i',
      );
      // Name-confident names — PERSONIFIED suffixes and CI/legal-entity
      // captures ("acme pest solutions") — get a same-sentence
      // accusation-object association ("Customers report hidden fees after
      // choosing Bug Busters" — Codex r11/r20), denial-guarded so "with no
      // hidden fees" stays clean. Header-shaped non-personified captures
      // are excluded — object proximity on them re-creates the educational
      // false positives.
      const objAssocP0 = (PERSONIFIED_SUFFIX_RE.test(name) || confidentProseNames.has(name))
        ? new RegExp([
          `${escaped}[^.!?\\n]{0,80}?(?<!\\bno\\s)(?<!\\bwithout\\s)(?<!\\bzero\\s)(?:${ASSOC_ACCUSATION_SRC})`,
          `(?<!\\bno\\s)(?<!\\bwithout\\s)(?<!\\bzero\\s)(?:${ASSOC_ACCUSATION_SRC})[^.!?\\n]{0,80}?${escaped}`,
        ].join('|'), 'i')
        : null;
      // Object-position insult idiom, verb-anchored ("homeowners call Bug
      // Busters a scam", "customers describe X as dishonest") — Codex r13.
      const objInsultP0 = new RegExp(
        `(?<!\\b(?:not|never|don'?t|doesn'?t|didn'?t|won'?t|wouldn'?t|rarely|hardly|seldom)\\s)\\b(?:calls?|called|describes?|described|labels?|labell?ed|considers?|considered)\\s+${escaped}\\s+(?:as\\s+)?(?:(?:a|an|the)\\s+)?(?:${DISPARAGEMENT_RE.source}|\\b(?:${NEG_ADJ})\\b)`, 'i',
      );
      // directedP0's SUBJECT_VERBS include negative auxiliaries (isn't/
      // never), so its match SPAN is negation-checked — "Bug Busters isn't
      // dishonest" is a denial. Span-scoped, not sentence-scoped: "Not only
      // that, X is dishonest" keeps text before the name out of the check
      // (Codex r19 on #2633).
      let dm = spanUnnegated(proseNameText.match(directedP0))
        || proseNameText.match(activeP0)
        || proseNameText.match(possessionP0);
      if (!dm && sepP0) {
        const sm = proseNameText.match(sepP0);
        if (sm && !trailingDenial(proseNameText, sm.index, sm[0].length)) dm = sm;
      }
      if (!dm) {
        // Association and object-position shapes take the sentence-level
        // denial guard ("There are no reports of hidden fees from Acme",
        // "No one calls Bug Busters a scam" — Codex r18/r29) and ITERATE
        // past denied sentences so a denial can't shadow a later live
        // accusation (Codex r29). The subject-verb arms above keep their
        // negator-excluded gaps instead: a blanket sentence guard would
        // clear real accusations ("Not only that, X scams customers").
        dm = firstUnnegatedMatch(proseNameText, negBeforeName)
          || firstUnnegatedMatch(proseNameText, fromP0)
          || firstUnnegatedMatch(proseNameText, objInsultP0)
          || (objAssocP0 && firstUnnegatedMatch(proseNameText, objAssocP0));
        // Trailing verb-anchored denials clear association matches too —
        // "Bug Busters: hidden fees are not present" (Codex r32).
        if (dm && trailingDenial(proseNameText, dm.index, dm[0].length)) dm = null;
      }
      if (dm) { disp = dm; break; }
    }
  }
  if (disp) {
    findings.push(finding('P0', 'COMPARISON_DISPARAGEMENT',
      `Comparison draft contains disparaging language about a provider ("${disp[0].trim()}"). State attributes, never insults — in the table, the prose, or the title/meta.`));
  }
  // Reliability claims against name-confident/personified prose targets —
  // "Bug Busters never answers the phone" beside a table routes to review
  // exactly like the table-less path (Codex r29 on #2633).
  if (!disp) {
    for (const name of extraProseNames) {
      if (!PERSONIFIED_SUFFIX_RE.test(name) && !confidentProseNames.has(name)) continue;
      const escaped = escapeForNameRe(name);
      const directedReliability = new RegExp(
        `${escaped}\\b(?:['’]s?)?(?<rtail>(?:\\s+(?!(?:not|never|no)\\b)\\w+){0,2}\\s+(?:(?:${SUBJECT_VERBS})\\b[^.!?\\n]{0,60})?)(?:${PROVIDER_NEGATIVE_RE.source})`, 'i',
      );
      // The pre-negative tail (named group) is negator-guarded: "is not
      // unreliable" is a denial, while "never answers the phone" keeps its
      // negator INSIDE PROVIDER_NEGATIVE where it IS the accusation
      // (Codex r30 on #2633).
      const relMatch = proseNameText.match(directedReliability);
      if (relMatch && !SENTENCE_NEGATOR_RE.test(relMatch.groups.rtail)) {
        findings.push(finding('P1', 'COMPARISON_NEGATIVE_RELIABILITY',
          `Comparison draft makes a negative service-reliability claim about "${name}". Routed to human review — state neutral, verifiable attributes only.`));
        break;
      }
    }
  }

  // Non-numeric self-ranking ("clear winner", "the best choice in …") stays a
  // whole-text scan — those phrases declare a winner in any context. Numeric
  // "#1" / "number one" needs comparison context: a table block, the
  // title/meta, or a provider/brand near it in prose — "the #1 entry point" /
  // "#1 hidden breeding site" is educational idiom, not a declared winner
  // (PROD 2026-07-11 false positives).
  let rank = scanText.match(SELF_RANKING_RE)
    || (metaText ? metaText.match(NUMERIC_ONE_RE) : null)
    || blocks.map((b) => b.match(NUMERIC_ONE_RE)).find(Boolean);
  if (!rank) {
    // Sentence-guarded and iterated — "No one rated us #1" is a denial
    // (Codex r28 on #2633).
    const numSelfRe = new RegExp(NUMERIC_SELF_RANKING_RE.source, 'gi');
    let nsm;
    while ((nsm = numSelfRe.exec(scanText)) !== null) {
      if (!sentenceHasNegator(scanText, nsm.index, nsm[0].length)) { rank = nsm; break; }
    }
  }
  if (!rank) {
    // Case-sensitive brand anchor + case-insensitive number tail ("Choose
    // WAVES, The #1 choice") — see the OWN_BRAND_ANCHOR comment block.
    // EVERY anchor is checked (Codex r11): an earlier benign "Waves —
    // seasonal guide" must not shadow a later self-ranking.
    // Anchored own-brand #1 arms — shared helper with the table-less path
    // (Codex r25).
    rank = scanOwnBrandRankingArms(scanText);
  }
  if (!rank) {
    // "#1" needs SYNTAX tying it to a provider — "#1 (rated) pest control
    // company" — or a detected brand/business name in the window. A bare
    // provider noun within 90 chars is NOT context: PROVIDER_NOUN includes
    // generic "service(s)", so "During your next service, check the #1
    // hidden breeding site" re-blocked as rigged ranking (Codex r3 on
    // #2633 — the exact educational-idiom false positive again).
    const numRe = new RegExp(NUMERIC_ONE_SRC.join('|'), 'gi');
    // Hyphen joins count as adjacency — "The #1-rated pest control
    // company" (Codex r7 on #2633). Service-line winner claims count too
    // ("#1 mosquito control choice", Codex r9) — but a winner-noun tail is
    // REQUIRED on service-line nouns, and choice/pick alone need a
    // geographic tail, so "the #1 option for standing water is a Bti dunk"
    // stays educational.
    // Hyphenated service phrases count too — "#1-rated pest-control
    // company" (Codex r20 on #2633).
    const numAdjacentProviderRe = new RegExp(
      `^${NUMERIC_ONE_ALT}(?:[-\\s]+[\\w'’]+){0,2}?[-\\s]+(?:pest[\\s-]+control|lawn[\\s-]+care|exterminators?|compan(?:y|ies)|providers?|(?:pest|mosquito|termite|rodent|bug|wildlife|lawn)[\\s-]+(?:control|care|removal)[\\s-]+(?:choice|option|pick|company|provider|team|service|program)|(?:choice|pick|option)\\s+(?:in|around|near))\\b`, 'i',
    );
    let nm1;
    while ((nm1 = numRe.exec(proseText)) !== null) {
      // "We are not the #1 pest control company in Venice" is honest
      // anti-ranking copy (Codex r29).
      if (sentenceHasNegator(proseText, nm1.index, nm1[0].length)) continue;
      const tail = proseText.slice(nm1.index, nm1.index + 60);
      // No own-brand PROXIMITY here: "waves" the common noun collides
      // ("in summer heat waves, the #1 hidden breeding site …"). Own-brand
      // self-ranking is covered by NUMERIC_SELF_RANKING_RE's directed arms.
      if (numAdjacentProviderRe.test(tail) || nearBusinessName(nm1.index, nm1[0].length)) {
        rank = nm1;
        break;
      }
    }
    // Names only the looser detectors see ("Bug Busters is #1") need a
    // DIRECTED subject-verb tie, not proximity — noisy CI captures ("in
    // termite prevention") would turn "the #1 mistake in termite
    // prevention" into a rigged ranking (Codex r4 on #2633).
    if (!rank) {
      for (const name of extraProseNames) {
        const escaped = escapeForNameRe(name);
        // Appositive-tolerant, like the disparagement path ("Bug Busters,
        // frankly, is #1" — Codex r10 on #2633). Negator-free adverb slot
        // ("Bug Busters is currently #1" — Codex r16 parity).
        const selfRank = new RegExp(
          `${escaped}\\b(?:['’]s?)?${NOUN_VERB_GAP}(?:is|are|was|were|remains?|ranks?|earn(?:s|ed)?|w(?:ins?|on)|claim(?:s|ed)?|secur(?:es?|ed)|h(?:olds?|eld)|t(?:akes?|ook))\\s+(?:${NON_NEGATED_WORD}\\s+){0,2}?(?:(?:the|your|a|an)\\s+)?${NUMERIC_ONE_ALT}`, 'i',
        );
        // Object-position idiom: "reviews call Bug Busters the #1 choice",
        // "rated Bug Busters as #1" (Codex r11/r14) — verb-anchored, not
        // proximity. Customer-choice verbs and "their", same as the
        // us-object arm ("customers make Bug Busters their #1 choice" —
        // Codex r16 parity).
        const calledRank = new RegExp(
          `\\b(?:calls?|called|names?|named|rates?|rated|ranks?|ranked|votes?|voted|makes?|made|chooses?|chose|selects?|selected|picks?|picked|prefers?|preferred)\\s+${escaped}\\s+(?:as\\s+)?(?:(?:the|your|a|an|their)\\s+)?${NUMERIC_ONE_ALT}`, 'i',
        );
        // Separator/appositive #1: PERSONIFIED names take any following #1
        // ("Bug Busters, the #1 choice" — Codex r12). Non-personified names
        // ("A+ Pest Control — the #1 choice.") need a WINNER-NOUN tail after
        // the #1 (Codex r15): the tail is what separates a declared winner
        // from educational idiom on a noisy capture ("… and termite
        // prevention, the #1 defense is …" has no winner noun and stays
        // clean).
        const sepRank = PERSONIFIED_SUFFIX_RE.test(name)
          ? new RegExp(`${escaped}\\b(?:['’]s?)?\\s*[,:—–-]\\s*(?:(?:the|your|a|an)\\s+)?${NUMERIC_ONE_ALT}`, 'i')
          : new RegExp(`${escaped}\\b(?:['’]s?)?\\s*[,:—–-]\\s*(?:(?:the|your|a|an)\\s+)?${NUMERIC_ONE_ALT}(?:[-\\s]+[\\w'’]+){0,2}?[-\\s]+(?:choices?|picks?|options?|compan(?:y|ies)|providers?|teams?|services?|programs?|contractors?|exterminators?)\\b`, 'i');
        // Marketing verbs with a reflexive object, same as the own-brand
        // arm — "Bug Busters advertises itself as #1" (Codex r17 parity).
        const marketingRank = new RegExp(
          `${escaped}\\b(?:['’]s?)?${NOUN_VERB_GAP}(?:advertises?|advertised|markets?|marketed|promotes?|promoted|positions?|positioned|touts?|touted|brands?|branded|bills?|billed|presents?|presented|describes?|described|calls?|called|names?|named)\\s+(?:itself|themselves)\\s+(?:as\\s+)?(?:(?:the|your|a|an)\\s+){0,2}${NUMERIC_ONE_ALT}`, 'i',
        );
        // #1-before-the-name framing — "The #1 spot belongs to Bug Busters"
        // (Codex r21). Winner-noun hop is curated so "the #1 threat is …"
        // educational framing needs the name to be the declared winner.
        const rankBeforeName = new RegExp(
          `${NUMERIC_ONE_ALT}(?:\\s+(?:spot|overall|choice|pick|compan(?:y|ies)|providers?|options?|rank(?:ing)?|position|team|services?))?\\s+(?:belongs\\s+to|goes\\s+to|is|was|remains)\\s+(?:(?:the|your|a|an)\\s+)?${escaped}\\b`, 'i',
        );
        const rm = proseNameText.match(selfRank)
          || proseNameText.match(calledRank)
          || proseNameText.match(marketingRank)
          || firstUnnegatedMatch(proseNameText, rankBeforeName)
          || (sepRank && proseNameText.match(sepRank));
        if (rm) { rank = rm; break; }
      }
    }
  }
  if (rank) {
    findings.push(finding('P1', 'COMPARISON_RIGGED_RANKING',
      `Comparison draft uses ranking/superlative framing ("${rank[0].trim()}"). Present neutral trade-offs — do not declare a winner, in the table, the prose, or the title/meta.`));
  }
  // Prose/title/meta negatives within proximity of a NAMED competitor — these
  // tie an insult/reliability claim to the brand even without a provider noun
  // ("Orkin is the worst", "Orkin never answers the phone"), which the
  // noun-based PROVIDER_DISPARAGEMENT_RE misses.
  const competitorNames = [...known, ...unknown];
  if (competitorNames.length) {
    // These proximity scans run on the block-STRIPPED prose (proseText /
    // proseNameText): a competitor named only inside a <ComparisonTable>
    // must not lend "competitor context" to adjacent educational prose —
    // "rest in shady foliage" right before a sourced Orkin table was still
    // hard-blocking (Codex r3 P2 on #2633). In-table negativity is fully
    // covered by the per-block scans below.
    const nearCompetitor = (idx, len) => {
      // Slice the quote/backslash-stripped text (indices align with proseText)
      // and collapse runs of whitespace so an escaped/embedded-quote brand —
      // left as "All   U   Need" by the strip — still matches its canonical
      // single-spaced name. NEG_ADJ/PROVIDER_NEGATIVE matches are quote-free,
      // so their indices are identical in proseText and proseNameText.
      const window = proseNameText
        .slice(Math.max(0, idx - PROVIDER_NEGATIVE_PROXIMITY), idx + len + PROVIDER_NEGATIVE_PROXIMITY)
        .toLowerCase()
        .replace(/\s+/g, ' ');
      return competitorNames.some((n) => window.includes(n.toLowerCase().replace(/\s+/g, ' ')));
    };
    // Disparaging adjective near a competitor name → P0. Denial-guarded:
    // "No shady billing from Orkin" keeps at most the competitor-in-prose
    // review finding, never a hard block (Codex r18 on #2633).
    const adjRe = new RegExp(`\\b(?:${NEG_ADJ})\\b`, 'ig');
    let am;
    while ((am = adjRe.exec(proseText)) !== null) {
      if (!nearCompetitor(am.index, am[0].length)) continue;
      if (sentenceHasNegator(proseText, am.index, am[0].length)) continue;
      findings.push(finding('P0', 'COMPARISON_DISPARAGEMENT',
        `Comparison draft disparages a named competitor ("${am[0].trim()}" near a competitor name). State neutral attributes only.`));
      break;
    }
    // Negative service-reliability claim near a competitor name → P1 review.
    const negRe = new RegExp(PROVIDER_NEGATIVE_RE.source, 'ig');
    let nm;
    while ((nm = negRe.exec(proseText)) !== null) {
      // "Orkin is not unreliable" is a denial (Codex r32) — PRE-match text
      // only: the negator inside PROVIDER_NEGATIVE ("never answers") IS
      // the accusation.
      if (sentenceHasNegator(proseText, nm.index, 0)) continue;
      if (nearCompetitor(nm.index, nm[0].length)) {
        findings.push(finding('P1', 'COMPARISON_NEGATIVE_RELIABILITY',
          `Comparison draft makes a negative service-reliability claim about a named provider ("${nm[0].trim()}"). Routed to human review — state neutral, verifiable attributes only.`));
        break;
      }
    }
  }

  // ── Per-table checks ──
  for (const block of blocks) {
    const attributed = hasAttribution(extractCaption(block));
    const options = extractColumns(block).slice(1);
    const rows = extractRows(block);
    const blockKnown = new Set();

    options.forEach((opt, j) => {
      const cls = classifyOption(opt);
      if (cls === 'known_competitor') {
        const allowlisted = competitorFacts.findBusinessMentions(opt).filter((x) => x.inAllowlist);
        const distinctNames = [...new Set(allowlisted.map((x) => x.name))];
        // A single comparison column must represent ONE provider. If a header
        // names multiple allowlisted competitors ("Orkin / Massey Services"),
        // only one would ever be validated — fail closed and route to review.
        if (distinctNames.length > 1) {
          distinctNames.forEach((n) => { known.add(n); blockKnown.add(n); });
          unsupportedFacts.add(`${distinctNames.join(' / ')} — one comparison column names multiple competitors; give each its own column so every cell is validated against that competitor's curated facts`);
          return;
        }
        const name = distinctNames[0] || opt.trim();
        known.add(name);
        blockKnown.add(name);
        const attrVals = competitorFacts.attributeValues(name);
        // Fail closed: a comparison table that names a competitor must have
        // parseable rows to validate; if we got none, its cells could claim
        // anything, so route to review rather than pass unvalidated.
        if (rows.length === 0) {
          unsupportedFacts.add(`${name} — (table rows could not be parsed for validation)`);
        }
        for (const row of rows) {
          const cell = String(row.values[j] ?? '').trim();
          if (!cell || NEUTRAL_CELL_RE.test(cell)) continue;
          // A NEGATIVE mark ("No"/"Never"/"✗") asserts the competitor LACKS the
          // row's criterion. Harmless for a neutral feature, but on a service-
          // reliability/quality row it is a negative-reliability claim about a
          // named competitor → route to human review (never wave it through).
          if (NEGATIVE_CELL_RE.test(cell)) {
            if (RELIABILITY_LABEL_RE.test(String(row.label || ''))) {
              negativeReliability.add(`${name} — "${String(row.label).trim()}: ${cell}"`);
            }
            continue;
          }
          // Affirmative cell → the claim is the ROW LABEL; substantive cell → the value.
          const claim = AFFIRMATIVE_CELL_RE.test(cell) ? row.label : cell;
          if (!claimSupported(claim, attrVals)) {
            unsupportedFacts.add(`${name} — "${String(claim).trim()}"`);
          }
        }
      } else if (cls === 'unknown_competitor') {
        unknown.add(opt.trim());
      } else if (cls === 'unclassified') {
        unclassified.add(opt.trim());
      }
    });
    // An allowlisted competitor named inside a row LABEL or CELL (not as an
    // option header) carries an unvalidated claim ("Orkin offers same-day
    // service") the per-column validator never checks — flag it. Only the
    // column header may name a competitor.
    const cellText = rows.flatMap((r) => [r.label, ...(r.values || [])]).filter(Boolean).join(' \n ');
    for (const m of competitorFacts.findBusinessMentions(cellText)) {
      if (m.inAllowlist) unsupportedFacts.add(`${m.name} — named in a table cell/row (only the column header may name a competitor)`);
    }
    // Known competitors named in the block text (not just headers).
    for (const m of competitorFacts.findBusinessMentions(block)) {
      if (m.inAllowlist) blockKnown.add(m.name);
    }
    blockKnown.forEach((n) => {
      blockNamedKnown.add(n);
      if (!attributed) unsourcedKnown.add(n); // per-occurrence: any unsourced naming flags
    });

    // The bare disparagement vocabulary blocks unconditionally INSIDE a
    // table block (options are providers/categories by construction) — the
    // prose scan above is target-scoped, so this keeps table strictness.
    if (DISPARAGEMENT_RE.test(block)) {
      const m = block.match(DISPARAGEMENT_RE);
      findings.push(finding('P0', 'COMPARISON_DISPARAGEMENT',
        `Comparison table contains disparaging language about an option ("${m[0].trim()}"). State attributes, never insults.`));
    }
    if (TABLE_DISPARAGEMENT_RE.test(block)) {
      const m = block.match(TABLE_DISPARAGEMENT_RE);
      findings.push(finding('P0', 'COMPARISON_DISPARAGEMENT',
        `Comparison table contains disparaging language about an option ("${m[0]}"). State attributes, never insults.`));
    }
    if (PROVIDER_NEGATIVE_RE.test(block)) {
      const m = block.match(PROVIDER_NEGATIVE_RE);
      findings.push(finding('P1', 'COMPARISON_NEGATIVE_RELIABILITY',
        `Comparison table makes a negative service-reliability claim about an option ("${m[0].trim()}"). Routed to human review — phrase it as a neutral, verifiable attribute or remove it.`));
    }
  }

  // Known competitors named only in prose (never in a table) have no caption → unsourced.
  for (const n of known) if (!blockNamedKnown.has(n)) unsourcedKnown.add(n);

  // A competitor may be named ONLY inside the comparison table, where every cell
  // is validated against curated facts. A mention in the surrounding prose /
  // title / meta carries unvalidatable claims ("Orkin offers free same-day
  // service in Sarasota"), so flag it — the writer must move the competitor into
  // the table. proseText (body minus blocks, plus title/meta) was built above;
  // proseNameText is its quote/backslash-stripped copy so an escaped/embedded-
  // quote brand named in prose ("All \"U\" Need Pest Control offers …") is
  // detected, not just the straight/smart-quote spellings findBusinessMentions
  // normalizes on its own.
  const competitorInProse = new Set();
  for (const m of competitorFacts.findBusinessMentions(proseNameText)) {
    if (m.inAllowlist) competitorInProse.add(m.name);
  }

  // Reconcile overlaps.
  for (const nm of known) unknown.delete(nm);
  for (const nm of [...unclassified]) {
    if (known.has(nm) || unknown.has(nm)) unclassified.delete(nm);
  }

  // ── Resolve findings ──
  for (const nm of unknown) {
    findings.push(finding('P0', 'COMPARISON_UNKNOWN_COMPETITOR',
      `Names "${nm}", a recognized competitor not on the curated competitor-facts allowlist — its attributes cannot be verified. Use a provider CATEGORY instead, or add "${nm}" to competitor-facts.js with sourced, dated facts.`));
  }
  for (const nm of unclassified) {
    findings.push(finding('P1', 'COMPARISON_UNCLASSIFIED_OPTION',
      `References "${nm}", which looks like a business but is neither a recognized provider category, Waves, nor an allowlisted competitor — routed to human review (fail-closed).`));
  }
  for (const f of unsupportedFacts) {
    findings.push(finding('P1', 'COMPARISON_UNSUPPORTED_COMPETITOR_FACT',
      `Comparison states a fact about ${f} that is not a curated attribute in competitor-facts.js — only sourced, curated attributes may be claimed about a named competitor.`));
  }
  for (const f of negativeReliability) {
    findings.push(finding('P1', 'COMPARISON_NEGATIVE_RELIABILITY',
      `Comparison marks a named competitor as lacking a service/reliability criterion (${f}) — a negative reliability claim about a named provider. Routed to human review; state neutral, verifiable attributes only.`));
  }
  for (const nm of competitorInProse) {
    findings.push(finding('P1', 'COMPARISON_COMPETITOR_IN_PROSE',
      `Names competitor "${nm}" in prose/title/meta, outside the comparison table — claims there are not validated against competitor-facts.js. Name a competitor ONLY inside the <ComparisonTable> (every cell is checked), not in the surrounding copy.`));
  }
  if (known.size && !namedCompetitorEnabled) {
    findings.push(finding('P1', 'COMPARISON_NAMED_COMPETITOR_DISABLED',
      `Names a competitor (${[...known].join(', ')}) but named-competitor comparisons are disabled (GATE_NAMED_COMPETITOR_COMPARISON). Use a category comparison, or enable the flag.`));
  } else if (known.size && unsourcedKnown.size) {
    findings.push(finding('P1', 'COMPARISON_COMPETITOR_UNSOURCED',
      `Names a competitor (${[...unsourcedKnown].join(', ')}) without an "as of <date>" + source caption on the table that names it. Add e.g. caption="Attributes as of June 2026, per each company's public website."`));
  }

  const pass = !findings.some((f) => f.severity === 'P0' || f.severity === 'P1');
  // A clean, enabled named-competitor draft still must NOT auto-publish: the
  // runner routes requiresHumanReview drafts to the approvable review queue.
  const requiresHumanReview = pass && namedCompetitorEnabled && known.size > 0;
  return { pass, findings, requiresHumanReview };
}

module.exports = {
  evaluate,
  evaluateProse,
  extractComparisonBlocks,
  extractCaption,
  extractColumns,
  extractRows,
  classifyOption,
  claimSupported,
  hasAttribution,
  DISPARAGEMENT_RE,
  TABLE_DISPARAGEMENT_RE,
  RANKING_RE,
  PROVIDER_NEGATIVE_RE,
};
