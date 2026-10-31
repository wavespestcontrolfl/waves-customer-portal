'use strict';

// ============================================================
// estimate-before-you-book.js — the "Before you book" page on the estimate PDF
// (owner answer book 2026-10-21/23).
//
// ONE plain page, appended after the last page of the estimate PDF. Every
// section prints; each service section is worded for "if your estimate
// includes ..." so the page never has to guess what an estimate quotes from
// its many stored shapes (Codex #6504 r1-r3 kept finding shapes a local reader
// missed). Only the no-contract line depends on THIS estimate, and it reads the
// canonical verdict (known residential + proposalCarriesPlanTerms). The 90-day
// prepay refund line always prints.
// An authored (enabled) commercial proposal reads the commercial page (COMMERCIAL_SECTIONS below); everything else reads this one.
// Copy is the owner's answer book: no prices, no product brand names, no fixed
// dry or re-entry times.
//
// Pure copy + selection. The PDF measures the lines and draws them; when the
// page would overflow it drops lines by RANK (see trimToFit in estimate-pdf.js).
// Rank 1 is kept longest, rank 5 is dropped first; inside a rank the later
// line goes first.
// ============================================================

const logger = require('./logger');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

const TITLE = 'Before you book';

// Sections in print order. Each line: { rank, text }. `when(s)` decides
// whether the line applies to this estimate. Rank 1 = keep longest.
const SECTIONS = [
  {
    key: 'scheduling',
    heading: 'Scheduling and paying',
    lines: [
      { rank: 1, text: 'Your technician arrives during a two-hour window that starts on the hour.' },
      { rank: 1, text: 'There is no deposit.' },
      { rank: 2, text: 'If you are a new recurring customer paying by card for each visit, you save your card when you book and we charge it after your first visit.' },
      { rank: 2, text: 'At the visit, your technician can take a card, a check or cash. You can also pay with the card or bank account we have on file, or send a check or cash through our office.' },
      { rank: 2, when: (s) => s.planTerms, text: 'Residential pest and lawn plans have no long-term contract. You can cancel any time.' },
      // The neutral line whenever the plan terms do not apply, so such an estimate never reads as month-to-month.
      { rank: 3, when: (s) => !s.planTerms, text: 'Termite plans and commercial accounts follow the agreement you sign.' },
      { rank: 2, text: 'If your estimate offers a prepaid year and you prepay, you can cancel within 90 days and we refund the visits we have not done yet. After 90 days there is no refund, and your paid visits stay on your schedule through the end of the prepaid term.' },
      { rank: 4, text: 'Mail checks to Waves Pest Control, 13649 Luxe Ave #110, Bradenton, FL 34211.' },
    ],
  },
  {
    key: 'pest',
    heading: 'If your estimate includes pest control',
    lines: [
      { rank: 1, text: 'You do not need to be home for the outside treatment. For the inside, someone needs to be home or leave us access.' },
      { rank: 1, text: 'It is normal to see some activity for up to two weeks after a treatment, as pests are flushed out. It fades as the products keep working. If it has not slowed after two weeks, tell us.' },
      { rank: 2, when: (s) => s.planTerms, text: 'On a residential plan with inside service, your first visit includes an inside spray. After that, the inside is up to you: we treat it whenever you ask.' },
      { rank: 2, text: 'Regular pest visits include the lanai and the pool cage, and small paper wasp and mud dauber nests on the house. Larger or hard-to-reach nests are quoted separately.' },
      { rank: 2, text: 'Please keep people and pets off treated areas until they are dry.' },
      { rank: 3, text: 'A treatment needs to dry and bond to surfaces. After that, it holds up to weather.' },
    ],
  },
  {
    key: 'lawn',
    heading: 'If your estimate includes a lawn plan',
    lines: [
      { rank: 1, text: 'Your lawn plan covers fertilizer, weed control and insect control, on a seasonal rotation. It does not include mowing.' },
      { rank: 2, text: 'Weed control takes about 10 to 14 days to show, and some weeds need a second round.' },
      { rank: 2, text: "Please water on your county's watering days, early in the morning, deeply and less often." },
      { rank: 3, text: 'Lawn insects such as chinch bugs are part of the plan. Your technician checks at the next visit and treats where we confirm them and the label allows.' },
    ],
  },
  {
    key: 'termite',
    heading: 'If your estimate includes termite work',
    lines: [
      { rank: 1, text: 'We do not tent. For drywood termites in wood we can reach, we treat the infested wood directly. If the activity is widespread or the wood is out of reach, we refer you to a fumigation company.' },
      { rank: 2, text: 'A WDO (termite) inspection report is emailed after the licensed inspector signs it, normally the same business day.' },
    ],
  },
  {
    key: 'rodent',
    heading: 'If your estimate includes rodent trapping',
    lines: [
      { rank: 1, text: 'Rodent trapping includes the setup visit and the trap checks listed on your estimate. Extra trap checks beyond those are quoted separately.' },
    ],
  },
  // The misting system (owner 2026-10-30, item F). Unlike the sections above, it prints ONLY when the estimate includes the
  // misting system (`signals.misting`), so every other estimate's page is unchanged.
  {
    key: 'misting',
    heading: 'If your estimate includes a misting system',
    lines: [
      { rank: 1, text: 'The date you pick is your first monthly service visit.' },
      { rank: 1, text: 'We call you to book the install day.' },
      { rank: 1, text: 'The install charge is on your first invoice.' },
    ].map((line) => ({ ...line, when: (s) => s.misting === true })),
  },
];

// The commercial page (owner 2026-10-24): an authored commercial proposal reads this page instead of the residential
// one. Scheduling and pest are commercial copy; lawn, termite and rodent reuse the residential sections above, but print
// only when the proposal includes that service (`signals.families`); pest prints when named or when no family is detected. It has no closing line and never prints the
// two-hour window, card saving, or the lanai and pool cage lines.
const COMMERCIAL_TITLE = 'Before you start service';
const COMMERCIAL_SECTIONS = [
  {
    key: 'scheduling',
    heading: 'Scheduling and paying',
    lines: [
      { rank: 1, text: 'We set your service day and time with you, around your business hours.' },
      { rank: 1, text: 'There is no deposit.' },
      // Only for a proposal with a recurring service (a one-time-only proposal has no agreement term), and only while
      // the proposal's own term, renewal and cancellation agree with the agreement (or are blank): a proposal with
      // authored custom terms (24 months, month-to-month) must not contradict itself, so the line drops.
      { rank: 2, when: (s) => s.termsMatchAgreement === true && s.recurring === true, text: "Your service agreement runs 12 months and renews each year. Either side can cancel with 30 days' written notice." },
      { rank: 3, text: 'We can send a certificate of insurance and name your business as an additional insured on request.' },
    ],
  },
  {
    key: 'pest',
    heading: 'If your service includes pest control',
    // Pest is the commercial default: named pest work, or no family detected at all.
    lines: [
      { rank: 1, text: 'For inside service, someone needs to let us in, or set up access with us ahead of time.' },
      { rank: 1, text: 'Some activity for up to two weeks after a treatment is normal, as pests are flushed out. If it has not slowed after two weeks, tell us.' },
      { rank: 2, text: 'Please keep people off treated areas until they are dry.' },
      { rank: 2, text: 'Before the first visit, tell us about sensitive areas: food handling, equipment, or staff with sensitivities.' },
    ].map((line) => ({ ...line, when: (s) => s.families?.has('pest') === true || (s.families?.size || 0) === 0 })),
  },
  ...['lawn', 'termite', 'rodent'].map((key) => {
    const section = SECTIONS.find((candidate) => candidate.key === key);
    return { ...section, lines: section.lines.map((line) => ({ ...line, when: (s) => s.families?.has(key) === true })) };
  }),
];

const CLOSING = { rank: 3, text: (phone) => `Questions before you book? Call us at ${phone} and we will help.` };

// The page: { title, sections: [{ key, heading, lines: [{ rank, text }] }], closing }.
// `signals.planTerms` = the estimate-wide plan terms apply; `signals.commercial` = a KNOWN commercial proposal
// (commercial copy; `signals.families` = the service families it includes); `opts.phone` = the support number.
function buildBeforeYouBook(signals = {}, opts = {}) {
  const commercial = signals.commercial === true;
  const sections = (commercial ? COMMERCIAL_SECTIONS : SECTIONS)
    .map((section) => ({ key: section.key, heading: section.heading, lines: section.lines
      .filter((line) => !line.when || line.when(signals))
      .map(({ rank, text }) => ({ rank, text })) }))
    .filter((section) => section.lines.length);
  const closing = !commercial && opts.phone ? { rank: CLOSING.rank, text: CLOSING.text(opts.phone), closing: true } : null;
  return { title: commercial ? COMMERCIAL_TITLE : TITLE, sections, closing };
}

// Residential is KNOWN only from the same authoritative signals the rest of the estimate code uses
// (estimate-public's plan-terms check): category RESIDENTIAL, not a commercial auto-priced estimate, and
// not an authored (enabled) commercial proposal. Anything else, including a missing category, is unknown
// and fails closed.
function isKnownResidential(estimate, proposal) {
  try {
    const { isCommercialAutoAcceptEstimate } = require('./estimate-commercial-identity');
    return String(estimate?.category || '').toUpperCase() === 'RESIDENTIAL'
      && !isCommercialAutoAcceptEstimate(estimate)
      && proposal?.enabled !== true;
  } catch {
    return false;
  }
}

// The commercial page is KNOWN only for an authored (enabled) proposal: it states the 12-month agreement, which an
// auto-priced COMMERCIAL-category estimate may not carry (owner 2026-10-24). Everything else, including a
// COMMERCIAL category with no authored proposal, fails closed to the current page.
function isKnownCommercial(proposal) {
  return proposal?.enabled === true;
}

// The service families a commercial proposal includes, read from the rows its document prints: building lines,
// service programs and corrective work. Whole-word matches only ("rate" is not rodent work, "tenant" is not
// pest work). A row that names no family adds none, so an undeterminable proposal omits the lawn, termite and
// rodent sections; the pest section is the commercial default and prints when pest work is named or no family
// is detected at all (mosquito and tree & shrub count as detected, so those proposals do not get it).
const FAMILY_PATTERNS = [
  ['pest', /\b(pests?|roach\w*|cockroach\w*|ants?|spiders?|silverfish|earwigs?|fleas?|wasps?|bed\s?bugs?|bedbugs?)\b/],
  ['mosquito', /\b(mosquito\w*)\b/],
  ['tree_shrub', /\b(trees?|shrubs?|ornamentals?)\b/],
  ['lawn', /\b(lawn|turf|fertili[sz]\w*|weed control|top\s?dress\w*|dethatch\w*|overseed\w*)\b/],
  ['termite', /\b(termites?|wdo|bora\s?care|termidor|trelona|trench\w*)\b/],
  ['rodent', /\b(rodents?|rats?|mouse|mice)\b/],
];

function proposalServiceFamilies(proposal) {
  const list = (value) => (Array.isArray(value) ? value : []);
  const rows = [
    ...list(proposal?.buildings).flatMap((building) => list(building?.lineItems)),
    ...list(proposal?.programs),
    ...list(proposal?.correctiveWork),
  ];
  const families = new Set();
  for (const row of rows) {
    const text = [row?.service, row?.serviceKey, row?.label, row?.name, row?.description]
      .filter((part) => typeof part === 'string').join(' ').toLowerCase().replace(/[_-]+/g, ' ');
    for (const [family, pattern] of FAMILY_PATTERNS) if (pattern.test(text)) families.add(family);
    if (FAMILY_PATTERNS.some(([family]) => family === row?.service)) families.add(row.service);
  }
  return families;
}

// The page is for an estimate still being decided: not accepted, declined or expired (a "Before you
// book" page on a booked estimate reads wrong). /data passes its own terminal state; the pdfkit PDF
// reads the row.
function estimateIsOpen(estimate) {
  if (['accepted', 'declined', 'expired'].includes(String(estimate?.status || '').toLowerCase())) return false;
  const expiry = estimate?.expires_at ? new Date(estimate.expires_at) : null;
  return !(expiry && !Number.isNaN(expiry.getTime()) && expiry < new Date());
}

// The estimate-wide plan terms apply (no long-term contract): KNOWN residential and the proposal's OWN
// terms-scope verdict (estimate-proposal-billing proposalCarriesPlanTerms, the one the PDF, page and
// accept read), which keeps termite, rodent and mixed-with-neutral documents terms-neutral.
function planTermsApply(estimate, proposal) {
  try {
    return isKnownResidential(estimate, proposal)
      && require('./estimate-proposal-billing').proposalCarriesPlanTerms(proposal, estimate?.id) === true;
  } catch {
    return false;
  }
}

// The one estimate-dependent verdict (the no-contract line). The 90-day refund line is worded "if your
// estimate offers a prepaid year", so it needs no prepay verdict (Codex #6504 r1/r4 kept finding prepay
// shapes a local verdict missed).
// The agreement's term, renewal, cancellation and price-adjustment terms agree with the proposal's authored ones (blank
// counts as agreeing): the signing chokepoint's own rule, with the payment term set aside (that line is about the term,
// not billing). Fails closed: an unreadable answer drops the line.
function termsMatchAgreement(proposal) {
  try {
    return require('./commercial-proposal-agreement').fixedTermsConflict(proposal?.commercialTerms || {}) === null;
  } catch {
    return false;
  }
}

// The proposal prices a recurring service (the figure online signing keys on). Fails closed: an unreadable answer is false.
function proposalIsRecurring(proposal) {
  try {
    return Number(require('./estimate-proposal').computeProposalTotals(proposal).annualRecurring) > 0;
  } catch {
    return false;
  }
}

function estimateSignals(estimate, proposal) {
  if (isKnownCommercial(proposal)) {
    return {
      planTerms: false, commercial: true, families: proposalServiceFamilies(proposal),
      termsMatchAgreement: termsMatchAgreement(proposal), recurring: proposalIsRecurring(proposal),
    };
  }
  // `misting` is set only when the estimate carries the misting system, so the signals of every other estimate are unchanged.
  return { planTerms: planTermsApply(estimate, proposal), ...(estimateIncludesMisting(estimate) ? { misting: true } : {}) };
}

// Does the estimate include the mosquito misting system (the plan or its install)? The mapper's own stored-shape reader, so the
// page agrees with the gate and acceptance refusals about what a misting estimate is. Fails closed: an unreadable answer is false.
function estimateIncludesMisting(estimate) {
  try {
    return require('./pricing-engine/v1-legacy-mapper').estimateDataCarriesMosquitoMisting(
      estimate?.estimate_data,
      { pricingAuthority: estimate?.pricing_authority || null },
    ) === true;
  } catch {
    return false;
  }
}

// The page for one estimate, untrimmed. `proposal` = normalizeProposal(estimate).
function beforeYouBookForEstimate(estimate, proposal) {
  return buildBeforeYouBook(estimateSignals(estimate, proposal || {}), { phone: WAVES_SUPPORT_PHONE_DISPLAY });
}

// Keep the page to ONE page. Priority order: while the page is taller than `available`, drop the
// highest-rank line (rank 5 first), and inside a rank the one printed last; the closing line prints
// last, so it goes before a same-rank line above it. A section left with no lines loses its heading.
// `lineHeight(text)` and the heading / closing heights are the renderer's own measure.
function trimByRank(page, { lineHeight, headingH, closingGap, available }) {
  const sections = page.sections.map((section) => ({ ...section, lines: section.lines.slice() }));
  let closing = page.closing ? { ...page.closing } : null;
  const total = () => sections.reduce((sum, section) => (section.lines.length
    ? sum + headingH + section.lines.reduce((h, line) => h + lineHeight(line.text), 0) : sum), 0)
    + (closing ? closingGap + lineHeight(closing.text) : 0);
  while (total() > available) {
    let worst = null;
    sections.forEach((section, si) => section.lines.forEach((line, li) => {
      if (!worst || line.rank >= worst.rank) worst = { rank: line.rank, si, li };
    }));
    if (closing && (!worst || closing.rank >= worst.rank)) { closing = null; continue; }
    if (!worst) break;
    sections[worst.si].lines.splice(worst.li, 1);
  }
  return { ...page, sections: sections.filter((section) => section.lines.length), closing };
}

// Browser document (estimate-doc-pdf.js renders this page at 14px type, the customer readability floor on a 7.5 x 10 in
// page). The server cannot measure text, so it estimates, measured on a rendered sample: about 115
// characters a line (a bullet's width), 21px a line, 4px between bullets, 34px for a section heading,
// 40px for the page's own title row. 820px of the 960px page keeps the footer line and a safety margin.
const DOC_CHARS_PER_LINE = 92;
const DOC_LINE_PX = 21;
const DOC_BULLET_GAP_PX = 4;
const DOC_HEADING_PX = 34;
const DOC_TITLE_PX = 40;
const DOC_PAGE_PX = 820;

// The `/data` payload fragment: `{ beforeYouBook: { title, sections: [{ key, heading, lines: [text] }],
// closing } }`, already chosen and trimmed for this estimate, or nothing when the estimate is accepted,
// declined or expired. Copy only: no prices. Never throws: a failure is "no page".
function beforeYouBookBlock(estimate, { open = estimateIsOpen(estimate) } = {}) {
  if (open !== true) return {};
  try {
    const { normalizeProposal } = require('./estimate-proposal');
    const page = trimByRank(beforeYouBookForEstimate(estimate, normalizeProposal(estimate)), {
      lineHeight: (text) => Math.ceil(text.length / DOC_CHARS_PER_LINE) * DOC_LINE_PX + DOC_BULLET_GAP_PX,
      headingH: DOC_HEADING_PX,
      closingGap: DOC_BULLET_GAP_PX,
      available: DOC_PAGE_PX - DOC_TITLE_PX,
    });
    return {
      beforeYouBook: {
        title: page.title,
        sections: page.sections.map((section) => ({ key: section.key, heading: section.heading, lines: section.lines.map((line) => line.text) })),
        closing: page.closing ? page.closing.text : null,
      },
    };
  } catch (err) {
    logger.warn?.(`[estimate-before-you-book] payload failed: ${err.message}`);
    return {};
  }
}

module.exports = { TITLE, COMMERCIAL_TITLE, SECTIONS, COMMERCIAL_SECTIONS, isKnownCommercial, proposalServiceFamilies, estimateIsOpen, isKnownResidential, buildBeforeYouBook, beforeYouBookForEstimate, trimByRank, beforeYouBookBlock };
