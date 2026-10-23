'use strict';

// ============================================================
// estimate-before-you-book.js — the "Before you book" page on the estimate PDF
// (GATE_ESTIMATE_PDF_BEFORE_YOU_BOOK, owner answer book 2026-10-21/23).
//
// ONE plain page, appended after the last page of the pdfkit estimate PDF.
// It holds only the answers that apply to THIS estimate: "Scheduling and
// paying" always, then "Pest visits", "Lawn", "Termite" and "Rodents" only when
// the estimate quotes that service. Copy is the owner's answer book, nothing
// else: no prices, no product brand names, no fixed dry or re-entry times.
//
// Pure copy + selection. The PDF measures the lines and draws them; when the
// page would overflow it drops lines by RANK (see trimToFit in estimate-pdf.js).
// Rank 1 is kept longest, rank 5 is dropped first; inside a rank the later
// line goes first.
// ============================================================

const TITLE = 'Before you book';

// Service signals. Keys come from the estimate's own recurring rows
// (estimate-public recurringServiceKey); the text pattern also reads the
// quoted line descriptions, so one-time work and synthesized proposals count.
const PEST_TEXT = /\bpest\b|cockroach|\broach|\bwasp|\bant\b|\bants\b|\bflea|\bspider|silverfish/i;
const LAWN_TEXT = /\blawn\b|\bturf\b/i;
const TERMITE_TEXT = /termite|\bwdo\b|wood[ -]destroying|pre[ -]?slab|drywood/i;
const WDO_TEXT = /\bwdo\b|wood[ -]destroying|termite inspection/i;
const RODENT_TEXT = /rodent|\brats?\b|\bmouse\b|\bmice\b/i;
const TRAPPING_TEXT = /trap|exclusion/i;
const ROACH_TEXT = /cockroach|\broach/i;
const NOT_PEST_TEXT = /\blawn\b|\bturf\b|tree|shrub|ornamental|mosquito|termite|rodent/i;
const COMMERCIAL_TEXT = /commercial/i;

// What the estimate quotes. `rows` = recurring rows (with `.key` already
// resolved by the caller), `items` = the description / name of every quoted
// line (one string each), `commercial` = a multi-building or commercial
// proposal. Text matching is per line, so a lawn line that mentions "pest" in
// passing does not turn on the pest section.
function detectServices({ rows = [], items = [], commercial = false } = {}) {
  const keys = new Set(rows.map((r) => String(r.key || '')));
  const hasKey = (test) => [...keys].some(test);
  const anyItem = (test) => items.some((t) => test.test(String(t || '')));
  const all = items.join(' | ');
  const isCommercial = commercial === true || COMMERCIAL_TEXT.test(all) || hasKey((k) => k.startsWith('commercial'));
  const recurringPest = keys.has('pest_control');
  const recurringLawn = keys.has('lawn_care');
  const termiteRecurring = hasKey((k) => k.startsWith('termite'));
  const rodentBait = keys.has('rodent_bait');
  const rodent = keys.has('rodent') || rodentBait || anyItem(RODENT_TEXT);
  return {
    commercial: isCommercial,
    recurring: rows.length > 0,
    recurringPest,
    recurringLawn,
    pest: recurringPest || items.some((t) => PEST_TEXT.test(t) && !NOT_PEST_TEXT.test(t)),
    lawn: recurringLawn || anyItem(LAWN_TEXT),
    termite: termiteRecurring || keys.has('pre_slab_termiticide') || anyItem(TERMITE_TEXT),
    termiteRecurring,
    wdo: anyItem(WDO_TEXT),
    rodent,
    // Trapping is a different job from a bait-station program: the trap-check line is only true of trapping.
    rodentTrapping: rodent && (!rodentBait || anyItem(TRAPPING_TEXT)),
    roach: anyItem(ROACH_TEXT),
  };
}

// Sections in print order. Each line: { rank, text }. `when(s, opts)` decides
// whether the line applies to this estimate. Rank 1 = keep longest.
const SECTIONS = [
  {
    key: 'scheduling',
    heading: 'Scheduling and paying',
    always: true,
    lines: [
      { rank: 1, text: 'Your technician arrives during a two-hour window that starts on the hour.' },
      { rank: 1, text: 'There is no deposit.' },
      { rank: 2, when: (s) => s.recurring, text: 'If you are a new recurring customer paying by card, you save your card when you book and we charge it after your first visit.' },
      { rank: 2, text: 'At the visit, your technician can take a card, a check or cash. You can also pay with the card or bank account we have on file, or send a check or cash through our office.' },
      { rank: 2, when: (s) => !s.commercial && (s.recurringPest || s.recurringLawn), text: 'Residential pest and lawn plans have no long-term contract. You can cancel any time.' },
      { rank: 3, when: (s) => s.termiteRecurring || s.commercial, text: 'Termite plans and commercial accounts follow the agreement you sign.' },
      { rank: 2, when: (s, o) => o.prepayRefundOffered === true && (s.recurringPest || s.recurringLawn), text: 'If you prepay for the year and cancel within 90 days, we refund the visits we have not done yet. After 90 days there is no refund, and your paid visits stay on your schedule through the end of the prepaid term.' },
      { rank: 4, text: 'Mail checks to Waves Pest Control, 13649 Luxe Ave #110, Bradenton, FL 34211.' },
    ],
  },
  {
    key: 'pest',
    heading: 'Pest visits',
    when: (s) => s.pest,
    lines: [
      { rank: 1, text: 'You do not need to be home for the outside treatment. For the inside, someone needs to be home or leave us access.' },
      { rank: 1, text: 'It is normal to see some activity for up to two weeks after a treatment, as pests are flushed out. It fades as the products keep working. If it has not slowed after two weeks, tell us.' },
      { rank: 2, when: (s) => !s.commercial && s.recurringPest, text: 'If your plan includes inside service, your first visit includes an inside spray. After that, the inside is up to you: we treat it whenever you ask.' },
      { rank: 2, when: (s) => s.recurringPest, text: 'Regular pest visits include the lanai and the pool cage, and wasp, mud dauber and hornet nests on the house.' },
      { rank: 2, text: 'Please keep people and pets off treated areas until they are dry.' },
      { rank: 3, text: 'A treatment needs to dry and bond to surfaces. After that, it holds up to weather.' },
      { rank: 4, when: (s) => s.roach && !s.recurringPest, text: 'A standalone cockroach treatment is two visits for one price. A German roach cleanout can take more visits, depending on how heavy it is.' },
      { rank: 5, text: 'We treat honeybees too, and we book the soonest available time.' },
    ],
  },
  {
    key: 'lawn',
    heading: 'Lawn',
    when: (s) => s.lawn,
    lines: [
      { rank: 1, text: 'Your lawn program covers fertilizer, weed control and insect control, on a seasonal rotation. It does not include mowing. Check your visit card for when to mow.' },
      { rank: 2, text: 'Weed control takes about 10 to 14 days to show, and some weeds need a second round.' },
      { rank: 2, text: "Please water on your county's watering days, early in the morning, deeply and less often." },
      { rank: 3, text: 'Lawn insects such as chinch bugs are part of the program. Your technician checks at the next visit and treats where we confirm them and the label allows.' },
    ],
  },
  {
    key: 'termite',
    heading: 'Termite',
    when: (s) => s.termite,
    lines: [
      { rank: 1, text: 'We do not tent. For drywood termites in wood we can reach, we treat the infested wood directly. If the activity is widespread or the wood is out of reach, we refer you to a fumigation company.' },
      { rank: 2, when: (s) => s.wdo, text: 'We email your WDO (termite) inspection report after the licensed inspector signs it, normally the same business day.' },
    ],
  },
  {
    key: 'rodent',
    heading: 'Rodents',
    when: (s) => s.rodent,
    lines: [
      { rank: 1, when: (s) => s.rodentTrapping, text: 'Rodent trapping includes the setup visit and at least one trap check. If you want more trap checks, our office will confirm what your job includes.' },
      { rank: 2, text: 'For wildlife, we do rodent trapping only. Snakes, raccoons, squirrels and other wildlife go to a wildlife company.' },
    ],
  },
];

const CLOSING = { rank: 3, text: (phone) => `Questions before you book? Call us at ${phone} and we will help.` };

// The page for one estimate: { title, sections: [{ key, heading, lines: [{ rank, text }] }] }.
// `signals` = detectServices() output; `opts.prepayRefundOffered` = the estimate
// offers an annual prepay AND the 90-day refund rule is live; `opts.phone` = the
// support number the document already prints.
function buildBeforeYouBook(signals, opts = {}) {
  const sections = [];
  for (const section of SECTIONS) {
    if (!section.always && !(section.when && section.when(signals, opts))) continue;
    const lines = section.lines
      .filter((line) => !line.when || line.when(signals, opts))
      .map(({ rank, text }) => ({ rank, text }));
    if (lines.length) sections.push({ key: section.key, heading: section.heading, lines });
  }
  const closing = opts.phone ? { rank: CLOSING.rank, text: CLOSING.text(opts.phone), closing: true } : null;
  return { title: TITLE, sections, closing };
}

module.exports = { TITLE, SECTIONS, detectServices, buildBeforeYouBook };
