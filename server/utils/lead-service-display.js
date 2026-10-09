/**
 * leadServiceDisplay — one way to NAME the service on a lead.
 *
 * leads.service_interest is written by five paths in five vocabularies
 * (call extraction, the website forms, the quote wizard, the email reader,
 * lead triage), and ~60 readers key off its words, so the stored text is
 * left alone. This turns it into the name staff read on the Leads screen:
 *
 * - a service reads the way the booking catalog names it
 *   ("Recurring Pest Control" → "Quarterly Pest Control Service");
 * - a lead is recurring OR one-time, never both — recurring wins;
 * - no stated frequency means the visit is a Waves Assessment, named with
 *   what it covers: "Waves Assessment (Pest + Lawn)";
 * - a one-time request is never an assessment (assessments are only for
 *   recurring service).
 *
 * Pure and deterministic; the caller passes the live catalog names
 * (catalogNameIndex) so an exact catalog pick, which is what call
 * extraction writes, passes through untouched.
 */

const ASSESSMENT = 'Waves Assessment';

// What a part is ABOUT. First match wins, so the specific topics sit above
// the family words they contain ("lawn pest control" is lawn, not pest).
// `short` is the name inside the assessment brackets; `fixed` is a catalog
// service that is one job by nature and takes no frequency.
const TOPICS = [
  { key: 'wdo', short: 'WDO', fixed: 'WDO Inspection Service', re: /\bwdo\b|\bwood[\s-]?destroying\b/i },
  { key: 'pre_slab', short: 'Termite', fixed: 'Slab Pre-Treat Termite Service', re: /\bpre[-\s]?(?:slab|pour|construction)\b|\bpreslab\b|\bsoil\s+treatment\b/i },
  { key: 'termite_inspection', short: 'Termite', oneTime: 'Termite Inspection Service', re: /\btermite\s+inspection\b/i },
  { key: 'wood_treatment', short: 'Termite', fixed: 'Bora-Care Wood Treatment Service', re: /\bbora[-\s]?care\b|\bborate\b|\bwood\s+treatment\b/i },
  { key: 'termite', short: 'Termite', recurring: 'Termite Bait Station Service', oneTime: 'Termite Liquid Treatment Service', re: /\btermit/i },
  { key: 'bed_bug', short: 'Bed Bug', fixed: 'Bed Bug Treatment Service', re: /\bbed[\s-]*bugs?\b|\bbedbugs?\b/i },
  { key: 'stinging', short: 'Bee / Wasp', fixed: 'Bee / Wasp Nest Removal Service', re: /\b(?:bee|wasp|hornet)s?\b|\byellow\s?jackets?\b/i, not: /\bspiders?\b/i },
  { key: 'wildlife', short: 'Wildlife', fixed: 'Wildlife Trapping Service', re: /\bwildlife\b|\braccoons?\b|\bsquirrels?\b|\bo?possums?\b|\barmadillos?\b/i },
  { key: 'rodent_exclusion', short: 'Rodent', fixed: 'Rodent Exclusion Service', re: /\brodent\s+exclusion\b/i },
  { key: 'rodent', short: 'Rodent', recurring: 'Quarterly Rodent Bait Station Service', oneTime: 'Rodent Trapping Service', re: /\brodents?\b|\brats?\b|\bmouse\b|\bmice\b|\bbait\s+stations?\b/i },
  { key: 'mosquito', short: 'Mosquito', recurring: 'Monthly Mosquito Control Service', oneTime: 'One-Time Mosquito Control Service', re: /\bmosquito|\bno[-\s]?see[-\s]?ums?\b|\bmidges?\b/i },
  { key: 'flea', short: 'Pest', fixed: 'Flea Control Service', re: /\bfleas?\b|\bticks?\b/i },
  { key: 'palm', short: 'Tree & Shrub', recurring: 'Semiannual Palm Injection Service', oneTime: 'Palm Injection Service', re: /\bpalm\b.*\binjections?\b|\btrunk\s+injections?\b/i },
  { key: 'tree_shrub', short: 'Tree & Shrub', recurring: 'Bi-Monthly Tree & Shrub Care Service', oneTime: 'One-Time Tree & Shrub Care Service', re: /\btrees?\b|\bshrubs?\b|\bornamentals?\b|\bpalms?\b/i },
  { key: 'plugging', short: 'Lawn', fixed: 'Lawn Plugging Service', re: /\baeration\b|\bplugging\b|\bplugs\b/i },
  { key: 'lawn_pest', short: 'Lawn', recurring: 'Monthly Lawn Care Service', oneTime: 'Lawn Pest Knockdown Service', re: /\blawn\s+(?:pest|insect)\b|\bchinch\b|\bmole\s+crickets?\b/i },
  { key: 'lawn', short: 'Lawn', recurring: 'Monthly Lawn Care Service', oneTime: 'One-Time Lawn Care Service', re: /\blawns?\b|\bturf\b|\bgrass\b|\bfertili[sz]|\bweeds?\b|\bsod\b|\bfungus\b|\bfungal\b|\bfungicide\b/i },
  { key: 'cockroach', short: 'Pest', recurring: 'Quarterly Pest Control Service', oneTime: 'Cockroach Treatment Service', re: /\broach(?:es)?\b|\bcockroach(?:es)?\b|\bpalmetto\s+bugs?\b/i },
  { key: 'pest', short: 'Pest', recurring: 'Quarterly Pest Control Service', oneTime: 'One-Time Pest Control Service', re: /\bpests?\b|\bbugs?\b|\binsects?\b|\bants?\b|\bspiders?\b|\bwasps?\b|\bsilverfish\b|\bearwigs?\b|\bscorpions?\b|\bcentipedes?\b|\bmillipedes?\b/i },
];

// Names the call label composer and the quote wizard write that are not
// catalog rows. Checked before the "looks like a catalog name" fallback.
const NOT_CATALOG = new Set([
  'pest control service', 'lawn care service', 'termite service', 'mosquito control service',
  'tree & shrub care service', 'rodent control service', 'wildlife control service',
]);

const SHORT_ORDER = ['Pest', 'Lawn', 'Termite', 'Rodent', 'Mosquito', 'Tree & Shrub', 'Bed Bug', 'Bee / Wasp', 'Wildlife', 'WDO'];

const RECURRING_RE = /\b(?:recurring|ongoing|quarterly|monthly|bi[-\s]?monthly|every\s+\d+\s+weeks?|every\s+(?:other\s+)?(?:month|quarter)|semi[-\s]?annual(?:ly)?|annual(?:ly)?|seasonal|year[-\s]round|bait\s+stations?|monitoring|per\s+(?:quarter|month|year)|times?\s+(?:a|per)\s+year)\b/i;
const ONE_TIME_RE = /\bone[-\s]?time\b|\bsingle\s+(?:visit|treatment|service)\b/i;

function clean(value) {
  return value === null || value === undefined ? '' : String(value).replace(/\s+/g, ' ').trim();
}

// A topic that is only a detail of another one in the same text: the
// broader word is dropped so one request does not read as two services.
const COVERED_BY = {
  termite: ['wdo', 'pre_slab', 'termite_inspection', 'wood_treatment'],
  rodent: ['rodent_exclusion'],
  tree_shrub: ['palm'],
  lawn: ['lawn_pest', 'plugging'],
  pest: ['lawn_pest', 'cockroach'],
};
const RODENT_NAMED_RE = /\brodents?\b|\brats?\b|\bmouse\b|\bmice\b/i;
const ASSESS_WORD_RE = /\bconsultation\b|\bassessment\b|\bnot\s+sure\b/i;

function topicsFor(text) {
  const hits = TOPICS.filter((topic) => topic.re.test(text) && !(topic.not && topic.not.test(text)));
  const keys = new Set(hits.map((topic) => topic.key));
  const namesPestControl = /\bpest\s+control\b/i.test(text);
  return hits.filter((topic) => {
    if ((COVERED_BY[topic.key] || []).some((key) => keys.has(key))) return false;
    // "lawn treatment for weeds, pests and disease" is a lawn request.
    if (topic.key === 'pest' && !namesPestControl && (keys.has('lawn') || keys.has('bed_bug'))) return false;
    // "termite bait stations" is termite work; bait stations are rodent
    // wording only when a rodent is named or no termite is.
    if (topic.key === 'rodent' && keys.has('termite') && !RODENT_NAMED_RE.test(text)) return false;
    return true;
  });
}

function catalogMatch(part, catalogNames) {
  const lower = part.toLowerCase();
  if (NOT_CATALOG.has(lower)) return null;
  if (catalogNames) {
    // The quote wizard names the priced line without the catalog's ending.
    return catalogNames.get(lower) || catalogNames.get(`${lower} service`) || null;
  }
  return /\bService(?: \([^)]*\))?$/.test(part) ? part : null;
}

// Lower-cased name → the catalog's own spelling.
function catalogNameIndex(names) {
  return new Map([...(names || [])].map(clean).filter(Boolean).map((name) => [name.toLowerCase(), name]));
}

function classify(part, catalogNames) {
  if (/^waves assessment$/i.test(part) || /^inspection$/i.test(part)) return { kind: 'assessment' };
  const frequency = statesRecurring(part) ? 'recurring' : ONE_TIME_RE.test(part) ? 'one_time' : null;
  const catalogName = catalogMatch(part, catalogNames);
  const topics = topicsFor(part);
  if (catalogName) return { kind: 'catalog', name: catalogName, frequency, topic: topics[0] || null };
  if (!topics.length) return { kind: 'other', name: part, frequency };
  return { kind: 'topic', text: part, topics, frequency, assess: ASSESS_WORD_RE.test(part) };
}

function assessmentLabel(shorts) {
  const unique = [...new Set(shorts)].sort((a, b) => SHORT_ORDER.indexOf(a) - SHORT_ORDER.indexOf(b));
  return unique.length ? `${ASSESSMENT} (${unique.join(' + ')})` : ASSESSMENT;
}

// The cadence the person stated, in the catalog's spelling. Bi-monthly is
// tested before monthly.
const CADENCES = [
  ['Bi-Monthly', /\bbi[-\s]?monthly\b|\bevery\s+(?:other|two|2)\s+months?\b/i],
  ['Every 6 Weeks', /\bevery\s+(?:6|six)\s+weeks?\b/i],
  ['Monthly', /\bmonthly\b|\bevery\s+month\b|\bper\s+month\b/i],
  ['Quarterly', /\bquarterly\b|\bevery\s+quarter\b|\bper\s+quarter\b/i],
  ['Semiannual', /\bsemi[-\s]?annual(?:ly)?\b|\btwice\s+a\s+year\b/i],
];
const CADENCE_PREFIX_RE = new RegExp(`^(?:${CADENCES.map(([word]) => word).join('|')}) `);

// Every cadence the naming step understands also counts as a recurring
// request, so the two can never disagree.
function statesRecurring(text) {
  return RECURRING_RE.test(text) || CADENCES.some(([, re]) => re.test(text));
}

// The topic's recurring service at the stated cadence when the catalog has
// that row ("Monthly pest control" → Monthly Pest Control Service); the
// topic's default cadence when none is stated or no such row exists.
function recurringName(topic, text, catalogNames) {
  const stated = CADENCES.find(([, re]) => re.test(text));
  if (!stated || !catalogNames || !CADENCE_PREFIX_RE.test(topic.recurring)) return topic.recurring;
  const wanted = topic.recurring.replace(CADENCE_PREFIX_RE, `${stated[0]} `);
  return catalogNames.get(wanted.toLowerCase()) || topic.recurring;
}

// Where one part of the text goes: a name of its own, or into the
// assessment's brackets.
function placePart(part, plan, name, toAssessment) {
  if (part.kind === 'assessment') {
    if (plan.assess) toAssessment(null);
  } else if (part.kind === 'other') {
    name(part.name);
  } else if (part.kind === 'catalog') {
    if (plan.assessmentBooked && part.topic && !part.topic.fixed) toAssessment(part.topic.short);
    // Recurring wins for the whole lead: a one-time catalog row beside a
    // recurring request reads as that topic's recurring service.
    else if (plan.recurring && part.frequency === 'one_time' && part.topic?.recurring) name(part.topic.recurring);
    else name(part.name);
  } else {
    for (const topic of part.topics) {
      if (part.assess && !plan.oneTime) toAssessment(topic.short);
      else if (topic.fixed) name(topic.fixed);
      // The one-time branch never reaches toAssessment: a one-time request
      // is never an assessment.
      else if (plan.oneTime) name(topic.oneTime || part.text);
      else if (plan.assess || !topic.recurring) toAssessment(topic.short);
      else name(recurringName(topic, part.text, plan.catalogNames));
    }
  }
}

function leadServiceDisplay(serviceInterest, { catalogNames = null } = {}) {
  const text = clean(serviceInterest);
  if (!text) return null;

  const parts = text.split(/\s+\+\s+/).map(clean).filter(Boolean).map((part) => classify(part, catalogNames));
  const recurring = parts.some((part) => part.frequency === 'recurring');
  const oneTime = !recurring && parts.some((part) => part.frequency === 'one_time');
  // An assessment visit covers the recurring work it was booked to look at.
  // A one-time request is never an assessment.
  const assessmentBooked = !oneTime && parts.some((part) => part.kind === 'assessment');
  const plan = { recurring, oneTime, assessmentBooked, assess: assessmentBooked || (!recurring && !oneTime), catalogNames };

  const out = [];
  const shorts = [];
  let assessmentAt = -1;
  const toAssessment = (short) => {
    if (assessmentAt < 0) { assessmentAt = out.length; out.push(null); }
    if (short) shorts.push(short);
  };
  for (const part of parts) placePart(part, plan, (label) => out.push(label), toAssessment);
  if (assessmentAt >= 0) out[assessmentAt] = assessmentLabel(shorts);

  return [...new Set(out.filter(Boolean))].join(' + ') || null;
}

module.exports = { leadServiceDisplay, catalogNameIndex };
