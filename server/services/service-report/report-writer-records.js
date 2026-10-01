/**
 * Records for the report writer under GATE_REPORT_WRITER_RULES (owner "ok
 * go" 2026-10-01 on the four-section writer): the approved wording and visit
 * facts the writer may use to say why the work fits, what the customer may
 * see, and what comes next, plus the phrases and dates the output screen
 * then allows. The route builds these only for writers in scope, never lawn
 * or tree/shrub/palm (another lane owns those, owner 2026-09-30).
 *
 * No booking state: whether a visit is booked changes after the report is
 * written, so the next visit renders live on the report itself
 * (nextSameServiceAppointment) and never enters this text (Codex #5500).
 */
const { buildWhatToExpect, toExpectationProduct, whatToExpectClasses } = require('./pest-report-expectations');
const { findReportProductCopyEntry } = require('../../config/report-product-copy');
const { validateCustomerCopy } = require('./premium-experience');
const { groundedTimeframePhrases } = require('./report-writer-rules');
const { writerPromiseLines } = require('./visit-promises');

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// What to expect for services whose work has no product class (owner "ok
// go" 2026-10-01 on the samples page; revised after the outside review so
// no line promises a visit, a check, or a result). Keyed by findings type,
// then by service line.
const SERVICE_EXPECTATIONS = Object.freeze({
  rodent_trapping: Object.freeze([
    'Trapping removes the rodents already inside, so captures usually slow down from one check to the next.',
    'Sealing the entry points works best after captures stop and fresh droppings stop turning up, so new rodents can\'t move into the space the trapped ones left.',
    'Scratching and other noise usually ease as captures slow; if the noise keeps up or gets worse, that\'s worth telling us.',
  ]),
  termite_bait_station: Object.freeze([
    'Termite bait works slowly on purpose: termites feeding at a station carry the bait back and share it through the colony, which takes weeks to months.',
    'Mud tubes on walls or winged termites indoors are worth telling us about right away.',
  ]),
  mosquito: Object.freeze([
    'Mosquitoes rest on shady leaves during the day, and the treatment on those leaves works on the ones that land there, so bites usually ease within a few days.',
    'Water that stands for about a week can hatch new mosquitoes, so emptying saucers, buckets and other containers after rain keeps new ones from replacing them.',
  ]),
});

// A line that describes today's work holds only with that work on the
// record: the leaf line needs a recorded foliar application (a larvicide-
// or station-only visit treated no leaves). Lines with no entry here are
// the customer's own task or how a service works, and always apply.
const LINE_REQUIRES = new Map([
  [SERVICE_EXPECTATIONS.mosquito[0], (applications) => applications.some((application) => application?.method === 'foliar_spray')],
]);

// Days to the far end of each pest class's stated window (EXPECTATION_TEXT
// in pest-report-expectations.js: "about 1–2 weeks", "a week or two",
// "about 10–14 days"). The longest one dates the reach-out line on one-time
// services and re-services (owner 2026-10-01). Classes with no closing
// window ("a few days", "several weeks") set no date.
const EXPECTATION_WINDOW_DAYS = Object.freeze({
  non_repellent: 14,
  roach_gel_bait: 14,
  pyrethroid: 14,
});

const SERVICE_KIND_LABELS = Object.freeze({
  one_time: 'one-time service',
  re_service: 're-service (a return visit for a problem from an earlier visit)',
  recurring: 'part of a recurring plan or program',
});

function expectationProducts(applications) {
  return (Array.isArray(applications) ? applications : []).map((application) => toExpectationProduct({
    product: { name: application?.name || null },
    method: application?.method || null,
    // The technician picked the method; no default fills it in.
    methodInferred: application?.method ? false : null,
    applicationArea: application?.applicationArea || null,
    targets: Array.isArray(application?.targets) ? application.targets : null,
  }));
}

function writerExpectations({ line = null, findingsType = null, applications = [] } = {}) {
  const products = line === 'pest' ? expectationProducts(applications) : [];
  const pestLines = products.length ? (buildWhatToExpect({ products })?.lines || []) : [];
  const classes = products.length ? whatToExpectClasses({ products }) : [];
  const recorded = Array.isArray(applications) ? applications : [];
  const serviceLines = (SERVICE_EXPECTATIONS[findingsType] || SERVICE_EXPECTATIONS[line] || [])
    .filter((text) => !LINE_REQUIRES.has(text) || LINE_REQUIRES.get(text)(recorded))
    .filter((text) => validateCustomerCopy(text));
  const windowDays = Math.max(0, ...classes.map((cls) => EXPECTATION_WINDOW_DAYS[cls] || 0));
  return {
    lines: [...pestLines, ...serviceLines],
    windowDays: windowDays > 0 ? windowDays : null,
  };
}

// The "How it works" line the report already prints for each product
// (config/report-product-copy.js, owner-approved 2026-09-28; owner "ok go"
// 2026-10-01 lets the writer use it too), labeled with the recorded job,
// method and area so the writer ties each line to the right piece of work.
function howItWorksLines(applications) {
  const seen = new Set();
  return (Array.isArray(applications) ? applications : []).flatMap((application) => {
    const entry = findReportProductCopyEntry({ epaReg: application?.epaReg, name: application?.name });
    if (!entry?.howItWorks) return [];
    const label = [application.role, application.methodLabel, application.applicationArea]
      .map(cleanText).filter(Boolean).join(', ');
    const lineText = `- ${label ? `${label}: ` : ''}${entry.howItWorks}`;
    if (seen.has(lineText)) return [];
    seen.add(lineText);
    return [lineText];
  });
}

// "Wednesday, October 14": the service date plus the window, as a calendar
// day (noon UTC, so no zone shifts the day).
function reachOutDate(serviceYmd, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(serviceYmd || '')) || !Number.isInteger(days) || days <= 0) return null;
  const date = new Date(`${serviceYmd}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  const weekday = date.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' });
  const monthDay = date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
  return { full: `${weekday}, ${monthDay}`, monthDay };
}

function buildWriterRecords({
  serviceYmd, line = null, findingsType = null, serviceKind = null, applications = [], promises = [],
} = {}) {
  const sections = [];
  const expectations = writerExpectations({ line, findingsType, applications });
  if (expectations.lines.length) {
    sections.push(`EXPECTATIONS (approved wording on what the customer may see after today's work; the only source for any timeframe, used in its own words):\n${expectations.lines.map((text) => `- ${text}`).join('\n')}`);
  }
  const howItWorks = howItWorksLines(applications);
  if (howItWorks.length) {
    sections.push(`HOW IT WORKS (approved product wording for the work recorded today; use it only to say why the work fits what was found, never for where or how anything was applied):\n${howItWorks.join('\n')}`);
  }
  if (SERVICE_KIND_LABELS[serviceKind]) sections.push(`SERVICE TYPE: ${SERVICE_KIND_LABELS[serviceKind]}.`);
  const reach = (serviceKind === 'one_time' || serviceKind === 're_service')
    ? reachOutDate(serviceYmd, expectations.windowDays)
    : null;
  if (reach) {
    sections.push(`REACH-OUT DATE: ${reach.full} (the service date plus the longest window in EXPECTATIONS). When you tell the customer when to contact us, use this date exactly.`);
  }
  // The technician's promise marks (visit-promises.js): only marked
  // promises, each with its mark.
  const promiseLines = writerPromiseLines(promises);
  if (promiseLines.length) {
    sections.push(`PROMISES (what we promised this customer before today, and how the technician marked each one today; mention only these, only as marked):\n${promiseLines.join('\n')}`);
  }
  return {
    sections,
    allowedPhrases: groundedTimeframePhrases(expectations.lines),
    allowedDates: reach ? [reach.full, reach.monthDay] : [],
  };
}

module.exports = {
  SERVICE_EXPECTATIONS,
  EXPECTATION_WINDOW_DAYS,
  writerExpectations,
  howItWorksLines,
  reachOutDate,
  buildWriterRecords,
};
