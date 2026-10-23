'use strict';

// ============================================================
// estimate-before-you-book.js — the "Before you book" page on the estimate PDF
// (GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK, owner answer book 2026-10-21/23).
//
// ONE plain page, appended after the last page of the estimate PDF. Every
// section prints; each service section is worded for "if your estimate
// includes ..." so the page never has to guess what an estimate quotes from
// its many stored shapes (Codex #6504 r1-r3 kept finding shapes a local reader
// missed). Only two lines depend on THIS estimate, and both read the canonical
// verdicts: the no-contract line (known residential + proposalCarriesPlanTerms)
// and the 90-day prepay refund line (the /data payload's own prepay verdict).
// Copy is the owner's answer book: no prices, no product brand names, no fixed
// dry or re-entry times.
//
// Pure copy + selection. The PDF measures the lines and draws them; when the
// page would overflow it drops lines by RANK (see trimToFit in estimate-pdf.js).
// Rank 1 is kept longest, rank 5 is dropped first; inside a rank the later
// line goes first.
// ============================================================

const featureGates = require('../config/feature-gates');
const logger = require('./logger');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

const TITLE = 'Before you book';

// Sections in print order. Each line: { rank, text }. `when(s, opts)` decides
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
      { rank: 2, when: (s, o) => o.prepayRefundOffered === true, text: 'If you prepay for the year and cancel within 90 days, we refund the visits we have not done yet. After 90 days there is no refund, and your paid visits stay on your schedule through the end of the prepaid term.' },
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
      { rank: 1, text: 'Your lawn plan covers fertilizer, weed control and insect control, on a seasonal rotation. It does not include mowing. Check your visit card for when to mow.' },
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
      { rank: 1, text: 'Rodent trapping includes the setup visit and one trap check. Any trap checks after that are billed separately.' },
    ],
  },
];

const CLOSING = { rank: 3, text: (phone) => `Questions before you book? Call us at ${phone} and we will help.` };

// The page: { title, sections: [{ key, heading, lines: [{ rank, text }] }], closing }.
// `signals.planTerms` = the estimate-wide plan terms apply; `opts.prepayRefundOffered` = the estimate
// offers an annual prepay AND the 90-day refund rule is live; `opts.phone` = the support number.
function buildBeforeYouBook(signals = {}, opts = {}) {
  const sections = SECTIONS
    .map((section) => ({ key: section.key, heading: section.heading, lines: section.lines
      .filter((line) => !line.when || line.when(signals, opts))
      .map(({ rank, text }) => ({ rank, text })) }))
    .filter((section) => section.lines.length);
  const closing = opts.phone ? { rank: CLOSING.rank, text: CLOSING.text(opts.phone), closing: true } : null;
  return { title: TITLE, sections, closing };
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

// The two estimate-dependent verdicts. `annualPrepayOffered`: the /data payload's own verdict (top-level or
// any selectable frequency) when the caller has it; otherwise the same two checks that verdict is made from.
// A failed read is "no": never a guess.
function estimateSignals(estimate, proposal, { annualPrepayOffered } = {}) {
  let prepayOffered = annualPrepayOffered;
  if (prepayOffered === undefined) {
    try {
      const pub = require('../routes/estimate-public');
      const estData = pub.parseEstimateDataSafe(estimate);
      prepayOffered = pub.annualPrepayEligibleForEstimateData(estData) && pub.annualPrepayHasSellableIncentive(estimate, estData, {});
    } catch (err) {
      logger.warn?.(`[estimate-before-you-book] prepay read failed: ${err.message}`);
      prepayOffered = false;
    }
  }
  return {
    signals: { planTerms: planTermsApply(estimate, proposal) },
    prepayOffered: featureGates.prepayRefund90DayLive?.() === true && prepayOffered === true,
  };
}

// The page for one estimate, untrimmed. `proposal` = normalizeProposal(estimate).
function beforeYouBookForEstimate(estimate, proposal, opts = {}) {
  const { signals, prepayOffered } = estimateSignals(estimate, proposal || {}, opts);
  return buildBeforeYouBook(signals, { prepayRefundOffered: prepayOffered, phone: WAVES_SUPPORT_PHONE_DISPLAY });
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

// Browser document (estimate-doc-pdf.js renders the client document at 11.5px type on a 7.5 x 10 in
// page). The server cannot measure text, so it estimates, measured on a rendered sample: about 115
// characters a line (a bullet's width), 17px a line, 4px between bullets, 30px for a section heading,
// 40px for the page's own title row. 820px of the 960px page keeps the footer line and a safety margin.
const DOC_CHARS_PER_LINE = 115;
const DOC_LINE_PX = 17;
const DOC_BULLET_GAP_PX = 4;
const DOC_HEADING_PX = 30;
const DOC_TITLE_PX = 40;
const DOC_PAGE_PX = 820;

// The `/data` payload fragment: `{ beforeYouBook: { title, sections: [{ key, heading, lines: [text] }],
// closing } }`, already chosen and trimmed for this estimate, or nothing (gate off, or the estimate is
// accepted, declined or expired), so a gate-off response is byte-identical to before. Copy only: no prices. Never throws: a failure is "no page".
function beforeYouBookBlock(estimate, { open = estimateIsOpen(estimate), annualPrepayOffered } = {}) {
  if (featureGates.estimateBeforeYouBookLive?.() !== true || open !== true) return {};
  try {
    const { normalizeProposal } = require('./estimate-proposal');
    const page = trimByRank(beforeYouBookForEstimate(estimate, normalizeProposal(estimate), { annualPrepayOffered }), {
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

module.exports = { TITLE, SECTIONS, estimateIsOpen, isKnownResidential, buildBeforeYouBook, beforeYouBookForEstimate, trimByRank, beforeYouBookBlock };
