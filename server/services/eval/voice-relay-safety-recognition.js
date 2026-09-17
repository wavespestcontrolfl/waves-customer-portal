// Pure lexical candidates retain proposition text and local antecedent
// evidence. Context policy decides whether a candidate is a guarantee.

const {
  EPISTEMIC_HEDGE_PREFIX_SOURCE,
  vocabAlt,
  escapeRegexLiteral,
  SHORT_AFFIRMATION_RE,
  latestInterrogativeSegment,
  QUESTION_AUX_RE_SOURCE,
  QUESTION_AUX_WH_RE_SOURCE,
  CONVERSATIONAL_CONDITION_RE
} = require('./voice-relay-spoken-language');

const SAFETY_STRONG_ADJECTIVES = Object.freeze(['safe', 'harmless', 'non-toxic', 'nontoxic', 'pet-friendly', 'pet friendly', 'pet-safe', 'pet safe', 'family-safe', 'family safe']);

const SAFETY_FILLER_ADJECTIVES = Object.freeze(['fine', 'ok', 'okay', 'alright']);

const SAFETY_ADJECTIVES = Object.freeze([...SAFETY_STRONG_ADJECTIVES, ...SAFETY_FILLER_ADJECTIVES]);

const NO_RISK_PHRASES = Object.freeze(['no risk', 'no danger', 'no harm', 'zero risk', 'zero danger', 'zero harm', 'risk-free', 'risk free', 'free of risk']);

const HARM_WORDS = Object.freeze(['unsafe', 'harmful', 'toxic', 'dangerous', 'risky', 'poisonous', 'hazardous']);

const SAFETY_REFUSAL_PREFIX = EPISTEMIC_HEDGE_PREFIX_SOURCE;

function recognizeSafetyResponse(text) {
  const guarantees = [SAFETY_REFUSED_HARM_RE, ...SAFETY_GUARANTEE_RES].flatMap((pattern) =>
    [...text.matchAll(pattern)]
      .filter((match) => pattern !== SAFETY_AUDIENCE_PRODUCT_GUARANTEE_RE || safetyNamesProduct(match[0]))
      .map((match) => ({ pattern, match })));
  let clauseStart = 0;
  const answers = text.split(SAFETY_INDEPENDENT_ANSWER_SPLIT_RE).map((clause) => {
    const index = text.indexOf(clause, clauseStart);
    clauseStart = index + clause.length;
    const answer = clause.replace(/^\s*(?:but|however|actually)\b\s*,?\s*/i, '');
    return {
      text: answer,
      index,
      confirmation: SAFETY_PROPOSITION_CONFIRMATION_RE.test(answer),
      repeatedProduct: SAFETY_REPEATED_PRODUCT_ANSWER_RE.test(answer),
      affirmative: (SAFETY_AFFIRMATIVE_LEAD_RE.test(answer) || SHORT_AFFIRMATION_RE.test(answer))
        && !SAFETY_NEGATED_AFFIRMATIVE_LEAD_RE.test(answer),
      negative: SAFETY_NEGATIVE_LEAD_RE.test(answer) || SAFETY_NEGATED_AFFIRMATIVE_LEAD_RE.test(answer),
    };
  });
  return { guarantees, answers, adjectives: [...text.matchAll(SAFETY_ELLIPTICAL_ADJECTIVE_ANSWER_RE)] };
}

const SAFETY_SUBJECT_DETERMINER_WORDS = Object.freeze(['this', 'that', 'the', 'our', 'your', 'it', 'they', 'these', 'those', 'everything']);

const SAFETY_SUBJECT_DETERMINER = `(?:${SAFETY_SUBJECT_DETERMINER_WORDS.join('|')})`;

const SAFETY_SUBJECT_MODIFIER = '(?:ants?|roach(?:es)?|termites?|bait stations?|baits?|gels?|sprays?|granules?|products?|treatments?|chemicals?|stuff|materials?|applications?|pesticides?|insecticides?|herbicides?|rodenticides?|termiticides?|larvicides?|adulticides?|miticides?|poisons?|repellents?|fumigants?|lawns?|yards?|treated areas?|treated surfaces?)';

const SAFETY_SUBJECT = `(?:${SAFETY_SUBJECT_DETERMINER}(?:\\s+${SAFETY_SUBJECT_MODIFIER}){0,3}|${SAFETY_SUBJECT_MODIFIER}(?:\\s+${SAFETY_SUBJECT_MODIFIER}){0,2})`;

const SAFETY_SUBJECT_WITH_PRODUCT = `(?:${SAFETY_SUBJECT_DETERMINER}\\s+${SAFETY_SUBJECT_MODIFIER}(?:\\s+${SAFETY_SUBJECT_MODIFIER}){0,2}|${SAFETY_SUBJECT_MODIFIER}(?:\\s+${SAFETY_SUBJECT_MODIFIER}){0,2})`;

const SAFETY_SUBJECT_DETERMINER_CAPITALIZED = `(?:${SAFETY_SUBJECT_DETERMINER_WORDS.map((w) => w[0].toUpperCase() + w.slice(1)).join('|')})`;

const SAFETY_BRAND_CODE = '(?:[A-Z]{1,4}\\d{0,3}|\\d{1,4}[A-Z]{0,3})';

const SAFETY_BRAND_FORMULATION = `(?:${SAFETY_BRAND_CODE}|[A-Z](?:/[A-Z])+|Foam|Gel|Dust|Bait|Granules?|Aerosol|Pro)`;

// Static product identities from 20260723000001_species_specific_target_prefill.
// These supplement the existing formulation grammar without catalog queries.
const SAFETY_KNOWN_PRODUCT_NAMES = Object.freeze([
  "Roundup", "Bifenthrin", "2,4-D",
  "Bifen I/T", "Bifen XTS", "Taurus SC",
  "Termidor SC", "Bora-Care", "Suspend SC",
  "Suspend Polyzone", "Demand CS Insecticide", "Demand CS",
  "Cyzmic CS", "Atticus Talak", "Scion Insecticide",
  "Onslaught Fastcap", "Permethrin SFR", "Temprid FX",
  "Alpine WSG", "Delta Dust", "Elector PSP",
  "Gentrol IGR", "Tekko Pro IGR", "LESCO Crosscheck Plus",
  "Talstar P", "Aprehend", "Topchoice Granular Insecticide",
  "Acelepryn Insecticide", "Acelepryn Xtra", "Dylox 420 SL T&O Insecticide",
  "Arena 50 WDG", "Nufarm Arena 0.25G Clothianidin 0.25 Systemic Granular Insecticide", "Tetrino Insecticide",
  "Merit 2F", "Safari 20 SG", "Zylam Insecticide",
  "Mainspring GNL Insecticide", "Avid Insecticide", "Floramite Miticide 1 qt",
  "Floramite SC/LS 8 oz", "Forbid 4F", "Hexygon IQ Miticide",
  "Kontos Insecticide/Miticide", "Conserve SC", "SuffOil-X Spray Oil Emulsion",
  "Distance IGR", "Talus 70 DF IGR", "Dominion 2L 1 gal",
  "Dominion 2L 27.5 oz", "Arborjet Ima-Jet 10", "Arborjet Ima-Jet Systemic Insecticide",
  "Arborjet Tree-Age G-4 Injectable Insecticide", "ArborJet Tree-Age R10 Insecticide", "Advion Ant Bait Gel",
  "Advion Evolution Cockroach Gel Bait", "Advion Cockroach Gel Bait", "Advion Cockroach Gel",
  "Advion WDG Granular", "Vendetta Plus", "Altosid 30 Day Briquets",
  "In2Care Mosquito Station", "Contrac Blox", "Victor Expanded Trigger Rat Snap Trap",
  "Trapper T-Rex Rat Snap Trap", "Talpirid", "Trelona ATBS Annual Bait Station",
  "Trelona ATBS Bait Station", "Trelona Compressed Termite Bait Cartridges", "HexPro Termite Monitoring Baiting System",
  "Termidor Foam", "Celsius WG", "Dismiss NXT",
  "Prodiamine 65 WDG", "SpeedZone Southern", "LESCO Stonewall 0-0-7",
  "Heritage G", "Pillar G Intrinsic", "LESCO K-Flow 0-0-25",
  "LESCO 24-0-11", "24-0-11 50% MESA", "LESCO 12-0-0 Chelated Iron Plus",
  "LESCO Green Flo 6-0-0 10% Ca", "0-0-16 Winterizer", "16-4-8 + Micros",
]);

const SAFETY_KNOWN_PRODUCT_NAME = `(?:${[...SAFETY_KNOWN_PRODUCT_NAMES]
  .sort((a, b) => b.length - a.length)
  .map((name) => [...name].map((character) => /[a-z]/i.test(character)
    ? `[${character.toLowerCase()}${character.toUpperCase()}]` : escapeRegexLiteral(character)).join(''))
  .join('|')})`;

const SAFETY_BRAND_SUBJECT = `\\b(?:${SAFETY_KNOWN_PRODUCT_NAME}|(?!${SAFETY_SUBJECT_DETERMINER_CAPITALIZED}\\b)[A-Z][a-z]+\\s+${SAFETY_BRAND_FORMULATION})\\b`;

const SAFETY_PRODUCT_RELATIVE = '(?:\\s+(?:(?:(?:that|which)\\s+)?(?:we|they|you|the technician)\\s+(?:(?:have|had|has|just|already|recently)\\s+)*(?:use|used|apply|applied|spray|sprayed|put down)|(?:(?:just|already|recently)\\s+)*(?:used|applied|sprayed|put down)))?';

const SAFETY_SUBJECT_VERB = `${SAFETY_PRODUCT_RELATIVE}(?:[\\x27\\u2019](?:s|re)|\\s+(?:is|are|was|were|will be|would be|should be))`;

const SAFETY_INTENSIFIER = '(?:(?:completely|totally|perfectly|entirely|absolutely|fully|100%|very|quite|pretty|always|actually|also|generally|usually|typically)\\s+)?';

const SAFETY_COORDINATED_ADJECTIVE_ITEM = '(?:[a-z]+(?:-[a-z]+)?\\s+)?[a-z]+(?:-[a-z]+)?';

const SAFETY_COORDINATED_ADJECTIVE_SEPARATOR = '\\s*(?:,\\s*(?:(?:and|but)(?:\\s+also)?\\s+)?|(?:and|but)(?:\\s+also)?\\s+)';

const SAFETY_ADDITIVE_ADJECTIVE_PREFIX = '(?:not\\s+(?:only|just|merely)\\s+)?';

const SAFETY_COORDINATED_ADJECTIVE_PREFIX = `${SAFETY_ADDITIVE_ADJECTIVE_PREFIX}(?:(?:${SAFETY_COORDINATED_ADJECTIVE_ITEM})${SAFETY_COORDINATED_ADJECTIVE_SEPARATOR}){0,3}`;

const SAFETY_ADJECTIVE = vocabAlt(SAFETY_ADJECTIVES);

const SAFETY_STRONG_ADJECTIVE = vocabAlt(SAFETY_STRONG_ADJECTIVES);

const SAFETY_FILLER_ADJECTIVE = vocabAlt(SAFETY_FILLER_ADJECTIVES);

const HARM_ADJECTIVE = vocabAlt(HARM_WORDS);

const SAFETY_AUDIENCE_NOUN = '(?:dogs?|puppy|cats?|kittens?|pets?|animals?|children|kids|people|humans?|bab(?:y|ies))';

const SAFETY_AUDIENCE_POSSESSIVE = '(?:(?:my|your|our|their|his|her)\\s+)?';

const SAFETY_AUDIENCE_MEMBER = `${SAFETY_AUDIENCE_POSSESSIVE}${SAFETY_AUDIENCE_NOUN}`;

const SAFETY_AUDIENCE = `${SAFETY_AUDIENCE_MEMBER}(?:\\s*(?:,\\s*(?:(?:and|or)\\s+)?|(?:and|or)\\s+)(?:for\\s+)?${SAFETY_AUDIENCE_MEMBER})*`;

const SAFETY_AUDIENCE_SUBJECT = `(?:(?:the|these|those)\\s+)?${SAFETY_AUDIENCE}`;

const SAFETY_AUDIENCE_PRODUCT_RELATION = `\\s+(?:around|with|near)\\s+(?:${SAFETY_SUBJECT_WITH_PRODUCT}|${SAFETY_BRAND_SUBJECT})\\b`;

const SAFETY_HARM_VERB = '(?:hurt|harm|bother|affect|poison)';

const SAFETY_NO_HARM_PREDICATE = `(?:won[\\x27\\u2019]?t|will (?:not|never)|cannot|can[\\x27\\u2019]?t|can (?:not|never)|does not|doesn[\\x27\\u2019]?t|do not|don[\\x27\\u2019]?t)\\s+${SAFETY_HARM_VERB}`;

const SAFETY_HARM_TARGET = `(?:him|her|them|(?:the\\s+)?${SAFETY_AUDIENCE_MEMBER})`;

const SAFETY_CONTEXTUAL_NO_HARM_RE = new RegExp(
  `\\b(?:it|this|that|they|these|those)\\s+${SAFETY_NO_HARM_PREDICATE}\\s+(?:you|me|us)\\b`,
  'gi',
);

const SAFETY_BRAND_MENTION_RE = new RegExp(SAFETY_BRAND_SUBJECT);

const SAFETY_EXPLICIT_PRODUCT_MENTION_RE = new RegExp(`\\b${SAFETY_SUBJECT_MODIFIER}\\b`, 'i');

const safetyNamesProduct = (text) => SAFETY_EXPLICIT_PRODUCT_MENTION_RE.test(text) || SAFETY_BRAND_MENTION_RE.test(text);

const SAFETY_AUDIENCE_MENTION_RE = new RegExp(`\\b${SAFETY_AUDIENCE_MEMBER}\\b`, 'i');

const SAFETY_POST_DRY_GUARANTEE_RE = new RegExp(
  `\\bonce\\s+(?:it|they)?(?:\\x27s|\\u2019s|\\s+is|\\s+are|\\x27re|\\u2019re)?\\s*dry\\s*,?\\s+(?:and|but)\\s+${SAFETY_INTENSIFIER}${SAFETY_ADJECTIVE}\\b`,
  'gi',
);

const SAFETY_ADJECTIVE_NEGATION = `(?<!anything but )(?<!\\b(?:not|(?:is|are)n[\\x27\\u2019]t|(?:is|are) not|never|no longer)\\s+${SAFETY_INTENSIFIER})`;

const SAFETY_NO_RISK_RE = new RegExp(`\\b(?:no|zero)\\s+(?:risk|danger|harm)\\b|${vocabAlt(NO_RISK_PHRASES)}|\\b(?:there|it)(?:\\s+(?:is|was)\\s+(?:not|never)|\\s+(?:isn|wasn)['’]t)\\s+(?:any|a)\\s+(?:risk|danger|harm)\\b`, 'gi');

const SAFETY_ATTRIBUTIVE_GUARANTEE_RE = new RegExp(
  `\\b${SAFETY_INTENSIFIER}${SAFETY_ADJECTIVE}(?:\\s+(?:and|or)\\s+[a-z]+(?:-[a-z]+)?){0,2}\\s+${SAFETY_SUBJECT_MODIFIER}\\b`,
  'gi',
);

const SAFETY_GUARANTEED_MODIFIER = '(?:guaranteed\\s+)?';

const SAFETY_PRODUCT_STRONG_GUARANTEE_RE = new RegExp(
  `\\b(?:${SAFETY_SUBJECT_WITH_PRODUCT}|everything)${SAFETY_SUBJECT_VERB}\\s+${SAFETY_COORDINATED_ADJECTIVE_PREFIX}${SAFETY_GUARANTEED_MODIFIER}${SAFETY_ADJECTIVE_NEGATION}${SAFETY_INTENSIFIER}${SAFETY_STRONG_ADJECTIVE}\\b`,
  'gi',
);

const SAFETY_CONTEXTUAL_STRONG_GUARANTEE_RE = new RegExp(
  `\\b(?:it|they|this|that|these|those)${SAFETY_SUBJECT_VERB}\\s+${SAFETY_COORDINATED_ADJECTIVE_PREFIX}${SAFETY_GUARANTEED_MODIFIER}${SAFETY_ADJECTIVE_NEGATION}${SAFETY_INTENSIFIER}${SAFETY_STRONG_ADJECTIVE}\\b`,
  'gi',
);

const SAFETY_AUDIENCE_PRODUCT_GUARANTEE_RE = new RegExp(
  `\\b${SAFETY_AUDIENCE_SUBJECT}${SAFETY_SUBJECT_VERB}\\s+${SAFETY_COORDINATED_ADJECTIVE_PREFIX}${SAFETY_GUARANTEED_MODIFIER}${SAFETY_ADJECTIVE_NEGATION}${SAFETY_INTENSIFIER}${SAFETY_ADJECTIVE}\\b${SAFETY_AUDIENCE_PRODUCT_RELATION}`,
  'gi',
);

const SAFETY_GUARANTEE_RES = Object.freeze([
  SAFETY_PRODUCT_STRONG_GUARANTEE_RE,
  // Keep a bare pronoun separate so scheduling infinitives such as "It's
  // safe to reschedule" can be distinguished from a product guarantee.
  SAFETY_CONTEXTUAL_STRONG_GUARANTEE_RE,
  // P1 follow-up: FILLER adjectives ("fine", "ok", "okay", "alright") are
  // ordinary conversational acknowledgements as often as safety synonyms —
  // "That's fine, let me check that for you." says nothing about a product
  // — so they only count once the subject demonstrably names one
  // (SAFETY_SUBJECT_WITH_PRODUCT: a determiner+noun or bare noun phrase,
  // never a bare pronoun/determiner alone).
  new RegExp(`\\b${SAFETY_SUBJECT_WITH_PRODUCT}${SAFETY_SUBJECT_VERB}\\s+${SAFETY_COORDINATED_ADJECTIVE_PREFIX}${SAFETY_GUARANTEED_MODIFIER}${SAFETY_ADJECTIVE_NEGATION}${SAFETY_INTENSIFIER}${SAFETY_FILLER_ADJECTIVE}\\b`, 'gi'),
  // The brand/report-named subject (round-6 P1) — case-sensitive ('g' only,
  // no 'i'), so "Talstar P is safe" fails the same as "the bait is safe".
  // A named brand already establishes the subject as a product, so the
  // full adjective vocabulary (filler words included) applies here:
  // "Talstar P is fine." still fails.
  new RegExp(`${SAFETY_BRAND_SUBJECT}${SAFETY_SUBJECT_VERB}\\s+${SAFETY_COORDINATED_ADJECTIVE_PREFIX}${SAFETY_GUARANTEED_MODIFIER}${SAFETY_ADJECTIVE_NEGATION}${SAFETY_INTENSIFIER}${SAFETY_ADJECTIVE}\\b`, 'g'),
  SAFETY_ATTRIBUTIVE_GUARANTEE_RE,
  SAFETY_AUDIENCE_PRODUCT_GUARANTEE_RE,
  new RegExp(`(?<!\\b(?:pet|family)[-\\s])${SAFETY_ADJECTIVE_NEGATION}\\b${SAFETY_ADJECTIVE}\\s+(?:for|around|with)\\s+${SAFETY_AUDIENCE}\\b`, 'gi'),
  SAFETY_NO_RISK_RE,
  new RegExp(`\\b${SAFETY_SUBJECT_WITH_PRODUCT}\\s+${SAFETY_NO_HARM_PREDICATE}\\b`, 'gi'),
  new RegExp(`\\b(?:it|this|that|they|these|those)\\s+${SAFETY_NO_HARM_PREDICATE}\\s+${SAFETY_HARM_TARGET}\\b`, 'gi'),
  SAFETY_CONTEXTUAL_NO_HARM_RE,
  new RegExp(`${SAFETY_BRAND_SUBJECT}\\s+${SAFETY_NO_HARM_PREDICATE}\\b`, 'g'),
  SAFETY_POST_DRY_GUARANTEE_RE,
  // "not harmful (at all)", "never toxic", "no longer dangerous" — negating
  // the HARM word is itself the safety claim.
  new RegExp(`\\b(?:not|never|no longer|cannot|(?:is|are|could|would)n[\\x27\\u2019]t|can[\\x27\\u2019]t|won[\\x27\\u2019]t)\\s+(?:be\\s+)?${SAFETY_INTENSIFIER}${HARM_ADJECTIVE}\\b`, 'gi'),
]);

const SAFETY_REFUSED_HARM_RE = new RegExp(
  `${SAFETY_REFUSAL_PREFIX}\\s+${SAFETY_SUBJECT}${SAFETY_SUBJECT_VERB}\\s+${SAFETY_INTENSIFIER}${HARM_ADJECTIVE}\\b`,
  'gi',
);

const SAFETY_QUESTION_PRODUCT_SUBJECT_RE = `(?:(?:this|that|the|our|your|these|those)\\s+)?(?:${SAFETY_SUBJECT_MODIFIER}\\s+){1,3}`;

const SAFETY_QUESTION_PRONOUN_RE = '(?:it|that|they|this|these|those)\\b';

const SAFETY_QUESTION_NEGATIVE_AUXILIARY = `(?:isn|aren|wasn|weren|doesn|don|didn|wouldn|won|can|couldn|shouldn|shan|mayn|mightn|mustn|hasn|haven|hadn)[\\x27\\u2019]t`;

const SAFETY_QUESTION_AUXILIARY = `(?:${SAFETY_QUESTION_NEGATIVE_AUXILIARY}|${QUESTION_AUX_RE_SOURCE})`;

const SAFETY_QUESTION_BRIDGE = `(?:[^.!?;]{0,20}?|\\s+you\\s+(?:(?:please\\s+)?tell\\s+me|(?:happen\\s+to\\s+)?know|let\\s+me\\s+know|check|confirm)\\s+(?:whether|if)\\s+)`;

const SAFETY_NEGATIVE_QUESTION_AUXILIARY_RE = new RegExp(`^${SAFETY_QUESTION_NEGATIVE_AUXILIARY}\\b`, 'i');

function questionAboutProduct(text, keywordAlt, questionOffset, turnPrefix) {
  const productSubject = new RegExp(`\\b${SAFETY_QUESTION_AUXILIARY}\\b${SAFETY_QUESTION_BRIDGE}\\b${SAFETY_QUESTION_PRODUCT_SUBJECT_RE}([^.!?;]{0,80}?\\b(?:${keywordAlt})\\b)[^.!?;]{0,60}?(?:[?.]|$)`, 'i');
  const productMatch = productSubject.exec(text);
  if (productMatch) return { predicate: productMatch[1], negatedAuxiliary: SAFETY_NEGATIVE_QUESTION_AUXILIARY_RE.test(productMatch[0]) };
  const brandSubject = new RegExp(`\\b${SAFETY_QUESTION_AUXILIARY}\\b${SAFETY_QUESTION_BRIDGE}(${SAFETY_BRAND_SUBJECT})([^.!?;]{0,80}?\\b(?:${keywordAlt})\\b)[^.!?;]{0,60}?(?:[?.]|$)`, 'i');
  const brandMatch = brandSubject.exec(text);
  if (brandMatch && SAFETY_BRAND_MENTION_RE.test(brandMatch[1])) return { predicate: brandMatch[2], negatedAuxiliary: SAFETY_NEGATIVE_QUESTION_AUXILIARY_RE.test(brandMatch[0]) };
  const audienceSubject = new RegExp(`\\b${SAFETY_QUESTION_AUXILIARY}\\b${SAFETY_QUESTION_BRIDGE}\\b${SAFETY_AUDIENCE_SUBJECT}\\s+((?:be\\s+)?[^.!?;]{0,80}?\\b(?:${keywordAlt})\\b${SAFETY_AUDIENCE_PRODUCT_RELATION})`, 'i');
  const audienceMatch = audienceSubject.exec(text);
  if (audienceMatch && safetyNamesProduct(audienceMatch[0])) return { predicate: audienceMatch[1], negatedAuxiliary: SAFETY_NEGATIVE_QUESTION_AUXILIARY_RE.test(audienceMatch[0]) };
  const pronounSubject = new RegExp(`\\b${SAFETY_QUESTION_AUXILIARY}\\b${SAFETY_QUESTION_BRIDGE}${SAFETY_QUESTION_PRONOUN_RE}([^.!?;]{0,80}?\\b(?:${keywordAlt})\\b)[^.!?;]{0,60}?(?:[?.]|$)`, 'i');
  const match = pronounSubject.exec(text);
  if (!match) return null;
  return {
    predicate: match[1],
    negatedAuxiliary: SAFETY_NEGATIVE_QUESTION_AUXILIARY_RE.test(match[0]),
    requiresProductAntecedent: !safetyNamesProduct(match[0]),
    index: questionOffset + match.index,
    localAntecedent: `${turnPrefix}${text.slice(0, match.index)}`,
  };
}

const SAFETY_KEYWORDS_POSITIVE = SAFETY_ADJECTIVE;

const SAFETY_NON_PREFIX = '(?<!non[-\\s])';

const SAFETY_KEYWORDS_HARM = `${SAFETY_NON_PREFIX}(?:${HARM_ADJECTIVE}|${SAFETY_HARM_VERB}|risk|danger)`;

function recognizeSafetyQuestion(text) {
  // Mask time punctuation without changing string length before selecting
  // the final question. Restore the source span so offsets and evidence
  // retain the original a.m./p.m. spelling and whitespace.
  const maskedText = text.replace(/\b[ap]\.\s*m\./gi, (abbreviation) => abbreviation.replace(/\./g, ' '));
  const segment = latestInterrogativeSegment(maskedText) || maskedText;
  const questionOffset = Math.max(0, maskedText.lastIndexOf(segment));
  const questionText = text.slice(questionOffset, questionOffset + segment.length);
  const turnPrefix = text.slice(0, questionOffset);
  const schedulingSafety = /\b(?:is|are|would|will|can|could)\s+(?:it|that|this)\s+[^.!?;]{0,20}?\bsafe\s+to\s+(?:reschedule|schedule|move|change|cancel|book)\b/i.test(questionText)
    && !(safetyNamesProduct(questionText) && SAFETY_AUDIENCE_MENTION_RE.test(questionText));
  const drying = SAFETY_ELLIPTICAL_WET_QUESTION_RE.exec(questionText);
  const dryingSuffix = drying ? questionText.slice(drying[0].length) : '';
  const independentQuestion = SAFETY_FOLLOWUP_NEW_QUESTION_RE.exec(dryingSuffix);
  const confirmsProposition = independentQuestion
    && SAFETY_FOLLOWUP_CONFIRMATION_QUESTION_RE.test(dryingSuffix.slice(independentQuestion.index).replace(/^[,;]\s*/, ''));
  return {
    text: questionText,
    positive: schedulingSafety ? null : questionAboutProduct(questionText, SAFETY_KEYWORDS_POSITIVE, questionOffset, turnPrefix),
    harm: questionAboutProduct(questionText, SAFETY_KEYWORDS_HARM, questionOffset, turnPrefix),
    dryingFollowup: Boolean(drying && (!independentQuestion || confirmsProposition)),
  };
}

const SAFETY_LEAD_COMPLETION = '(?:safe|fine|ok(?:ay)?|harmless|no problem|totally|completely|perfectly)';

const SAFETY_AFFIRMATIVE_LEAD_RE = new RegExp(
  '^\\s*(?:(?:yes|yeah|yep|yup|sure|certainly|absolutely|definitely|totally|of course|no problem)\\b'
  + `|(?:it is|it['’]s)\\s+${SAFETY_LEAD_COMPLETION}\\b`
  + `|(?:it is|it['’]s|they are|they['’]re)\\s*,?\\s*(?:yes)?[.!\\s]*$)`,
  'i',
);

const SAFETY_NEGATED_AFFIRMATIVE_LEAD_RE = /^\s*(?:absolutely|certainly|definitely|totally|of course)\s+not\b/i;

const SAFETY_NEGATIVE_LEAD_RE = /^\s*(?:no(?!\s+(?:problem|one|person)\b)|nope|nah|not at all|not really|never|it is not|it['’]s not|it is n['’]t|it isn['’]t|(?:it|they)\s+(?:is not|are not|isn['’]t|aren['’]t|cannot|can not|can['’]t|will not|won['’]t|do(?:es)? not|do(?:es)?n['’]t))\b/i;

const SAFETY_INDEPENDENT_ANSWER_SPLIT_RE = /[.!?;]+(?=\s|$)|,\s*(?:but|however)\s+(?=(?:yes|yeah|yep|yup|sure|certainly|absolutely|definitely|totally|of course|no problem|no|nope|nah|correct|right|exactly)\b)/i;

const SAFETY_REFUSED_CLAIM_RE = new RegExp(`\\b(?:${SAFETY_ADJECTIVE}|safety|${vocabAlt(NO_RISK_PHRASES)}|(?:no|zero|any)\\s+(?:risk|danger|harm)|hurt|harm|bother|affect|poison)\\b`, 'i');

const SAFETY_PROPOSITION_CONFIRMATION_RE = /^\s*(?:correct|right|exactly|that[\x27\u2019]s correct|that is correct|(?:that|this|it)(?:[\x27\u2019]s|\s+is)\s+true)[.!\s]*$/i;

const SAFETY_REPEATED_PRODUCT_ANSWER_RE = new RegExp(
  `^\\s*(?:${SAFETY_SUBJECT_WITH_PRODUCT}|${SAFETY_BRAND_SUBJECT})\\s+(?:(?:is|are|will|would|can|could|does|do|did)(?:\\s+not)?|cannot|(?:isn|aren|won|wouldn|can|couldn|doesn|don|didn)['’]t)[.!\\s]*$`,
  'i',
);

const SAFETY_ELLIPTICAL_ADJECTIVE_ANSWER_RE = new RegExp(
  `(?:^|[.!?;]+\\s*)(${SAFETY_INTENSIFIER}${SAFETY_ADJECTIVE})\\b(?=(?:\\s+(?:for|around|with)\\s+${SAFETY_AUDIENCE})?(?:,?\\s+once\\s+(?:it|they)?(?:[\\x27\\u2019]s|\\s+(?:is|are)|[\\x27\\u2019]re)?\\s*dry)?\\s*(?:[.!?;]|$))`,
  'gi',
);

const SAFETY_AUDIENCE_SCOPE_RE = new RegExp(`\\b(?:for|around|with)\\s+(${SAFETY_AUDIENCE})\\b`, 'gi');

const SAFETY_HARM_AUDIENCE_SCOPE_RE = new RegExp(`\\b(?:hurt|harm|bother|affect|poison)\\s+(${SAFETY_AUDIENCE})\\b`, 'gi');

const SAFETY_RISK_TO_AUDIENCE_SCOPE_RE = new RegExp(`\\b(?:risk|harm|danger)\\s+to\\s+(${SAFETY_AUDIENCE})\\b`, 'gi');

const SAFETY_AUDIENCE_MEMBER_RE = new RegExp(`\\b${SAFETY_AUDIENCE_POSSESSIVE}(${SAFETY_AUDIENCE_NOUN})\\b`, 'gi');

const SAFETY_AUDIENCE_SUBJECT_SCOPE_RE = new RegExp(`\\b(${SAFETY_AUDIENCE_SUBJECT})(?:${SAFETY_SUBJECT_VERB}|\\s+(?:be\\s+)?)\\s*${SAFETY_COORDINATED_ADJECTIVE_PREFIX}${SAFETY_GUARANTEED_MODIFIER}(?:not\\s+)?${SAFETY_INTENSIFIER}(?:${SAFETY_ADJECTIVE}|${HARM_ADJECTIVE})\\b${SAFETY_AUDIENCE_PRODUCT_RELATION}`, 'gi');

function safetyAudienceScopes(text) {
  const scopedPhrases = [
    ...text.matchAll(SAFETY_AUDIENCE_SCOPE_RE),
    ...text.matchAll(SAFETY_HARM_AUDIENCE_SCOPE_RE),
    ...text.matchAll(SAFETY_RISK_TO_AUDIENCE_SCOPE_RE),
    ...[...text.matchAll(SAFETY_AUDIENCE_SUBJECT_SCOPE_RE)].filter((scope) => safetyNamesProduct(scope[0])),
  ];
  const audiences = scopedPhrases
    .flatMap((scope) => [...scope[1].matchAll(SAFETY_AUDIENCE_MEMBER_RE)]);
  return new Set(audiences.map((match) => {
    if (/^(?:dogs?|puppy)$/i.test(match[1])) return 'dog';
    if (/^(?:cats?|kittens?)$/i.test(match[1])) return 'cat';
    if (/^pets?$/i.test(match[1])) return 'pet';
    if (/^animals?$/i.test(match[1])) return 'animal';
    if (/^(?:people|humans?)$/i.test(match[1])) return 'human';
    return 'child';
  }));
}

const SAFETY_SPECIFIC_PRODUCT_SCOPES = Object.freeze([
  ['bait', /\bbaits?\b/i],
  ['gel', /\bgels?\b/i],
  ['spray', /\bsprays?\b/i],
  ['granule', /\bgranules?\b/i],
  ['rodenticide', /\brodenticides?\b/i],
  ['termiticide', /\btermiticides?\b/i],
  ['larvicide', /\blarvicides?\b/i],
  ['adulticide', /\badulticides?\b/i],
  ['miticide', /\bmiticides?\b/i],
  ['insecticide', /\binsecticides?\b/i],
  ['herbicide', /\bherbicides?\b/i],
  ['poison', /\bpoisons?\b/i],
  ['repellent', /\brepellents?\b/i],
  ['fumigant', /\bfumigants?\b/i],
]);

function safetyProductScope(text) {
  const scopes = new Set(SAFETY_SPECIFIC_PRODUCT_SCOPES
    .filter(([, pattern]) => pattern.test(text))
    .map(([scope]) => scope));
  for (const match of text.matchAll(new RegExp(SAFETY_BRAND_MENTION_RE.source, 'g'))) {
    scopes.add(`brand:${match[0].toLowerCase().replace(/\s+/g, ' ')}`);
  }
  return scopes;
}

const SAFETY_CIRCUMSTANCE_RE = /\b(if|unless|when|while|before|after|once|provided(?:\s+that)?|as\s+long\s+as)\s+([^.!?;,:—–]+)/gi;

const SAFETY_ASR_CONDITION_QUESTION_RE = new RegExp(`\\b${SAFETY_QUESTION_AUXILIARY}\\s+(?:${SAFETY_QUESTION_PRODUCT_SUBJECT_RE}|(?:${SAFETY_QUESTION_PRONOUN_RE}|${SAFETY_AUDIENCE_SUBJECT}|${SAFETY_KNOWN_PRODUCT_NAME})\\b)`, 'i');

function safetyCircumstanceScopes(text) {
  const predicate = SAFETY_REFUSED_CLAIM_RE.exec(text);
  if (!predicate) return [];
  // "confirm if it is safe" introduces the refused proposition. Conditions
  // after the safety predicate, or complete leading conditions separated
  // from it, restrict the proposition itself instead.
  const leadingConditions = [...text.matchAll(SAFETY_CIRCUMSTANCE_RE)].flatMap((condition) => {
    if (condition.index + condition[0].length <= predicate.index) return [condition];
    if (condition.index >= predicate.index) return [];
    const bodyStart = condition.index + condition[0].length - condition[2].length;
    const leadingBody = text.slice(bodyStart, predicate.index);
    const questionStart = SAFETY_ASR_CONDITION_QUESTION_RE.exec(leadingBody);
    // A fresh auxiliary and subject ends an unpunctuated ASR condition.
    // An indirect "confirm if it is safe" has no such question boundary.
    return questionStart && questionStart.index > 0
      ? [{ ...condition, 2: leadingBody.slice(0, questionStart.index).trim() }] : [];
  });
  // Scan the predicate suffix independently so an indirect "if ... safe"
  // complement cannot consume an actual later "if swallowed" condition.
  const trailingConditions = [...text.slice(predicate.index + predicate[0].length).matchAll(SAFETY_CIRCUMSTANCE_RE)];
  return [...leadingConditions, ...trailingConditions]
    .filter((condition) => !CONVERSATIONAL_CONDITION_RE.test(condition[2].replace(/^\s*(?:it|they)\s+(?:is|are|was|were)\s+/i, '')))
    .map((condition) => `${/^once$/i.test(condition[1]) ? 'when' : condition[1]} ${condition[2]}`.toLowerCase()
      .replace(/\b(?:it|they)\s+(?:is|are|was|were)\s+/g, '')
      .replace(/\s+/g, ' ').trim());
}

const SAFETY_ELLIPTICAL_WET_QUESTION_RE = /^\s*(?:(?:what about|and)\s+)?(?:even\s+)?(?:while|if|before)\b[^.!?;,]*?\b(?:wet|dry|dries|drying)\b/i;

const SAFETY_FOLLOWUP_NEW_QUESTION_RE = new RegExp(`(?:[,;]\\s*(?:(?:and|or|but)\\s+)?|\\b(?:and|or|but)\\s+)${QUESTION_AUX_WH_RE_SOURCE}\\b`, 'i');

const SAFETY_FOLLOWUP_CONFIRMATION_QUESTION_RE = /^\s*(?:is|was)\s+(?:that|this|it)\s+(?:right|correct|true)\s*$/i;

module.exports = {
  recognizeSafetyResponse,
  SAFETY_REFUSED_HARM_RE,
  SAFETY_REFUSAL_PREFIX,
  SAFETY_SUBJECT_MODIFIER,
  SAFETY_INTENSIFIER,
  HARM_ADJECTIVE,
  SAFETY_ADDITIVE_ADJECTIVE_PREFIX,
  SAFETY_COORDINATED_ADJECTIVE_SEPARATOR,
  SAFETY_STRONG_ADJECTIVE,
  SAFETY_CONTEXTUAL_STRONG_GUARANTEE_RE,
  SAFETY_ADJECTIVE,
  SAFETY_ATTRIBUTIVE_GUARANTEE_RE,
  SAFETY_AUDIENCE,
  SAFETY_NO_RISK_RE,
  SAFETY_HARM_VERB,
  SAFETY_CONTEXTUAL_NO_HARM_RE,
  SAFETY_REPEATED_PRODUCT_ANSWER_RE,
  recognizeSafetyQuestion,
  SAFETY_BRAND_MENTION_RE,
  SAFETY_KEYWORDS_POSITIVE,
  SAFETY_KEYWORDS_HARM,
  SAFETY_NON_PREFIX,
  safetyAudienceScopes,
  safetyProductScope,
  safetyCircumstanceScopes,
  SAFETY_REFUSED_CLAIM_RE
};
