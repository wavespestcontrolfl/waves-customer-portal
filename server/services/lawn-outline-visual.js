// The new lawn outline layout (GATE_LAWN_OUTLINE_VISUAL, owner "build" 2026-10-31, scope page GfPfBfUu): a year bar, round
// cards (a 9-visit rounds plan) or today's month list (every other plan), an after-a-visit timeline, fact cards, a closed FAQ
// and a closed problem list. lawn-service-outline.js calls this module only while the gate is live (lazy require, so this file
// never loads with the gate off) and hands it the outline's own helpers in `kit`, so nothing here requires that file back.
//
// The shapes below are the page's contract (client/src/pages/ServiceOutlinePage.jsx): yearBar, rounds, timeline, facts and faq
// visuals. Every section also keeps text `bullets`, one line per block, round or item, because the stored HTML and the composer
// preview draw no visuals. The round main steps are DERIVED from the protocol (lawn-rounds.js ROUND_STEPS and the step's
// variant, through the outline's own step categories), never written by hand, so a recipe edit moves the page with it.
// Customer words: the reviewed copy of the scope page (two Fable rounds). Product names appear only in the product list.
const lawnRounds = require('./lawn-rounds');
const { visitForRound } = require('./lawn-program');
const { etDateString } = require('../utils/datetime-et');

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_INITIALS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const KEY_STEPS = Object.freeze(['feeding', 'barrier', 'micros', 'insects']);
const ROUND_SHORT = Object.freeze(['Barrier + color', 'Feed + barrier', 'Spring feed', 'Insects', 'Color + barrier', 'Color + potassium', 'Color + potassium', 'Feed + barrier', 'Potassium feed']);
const MONTH_SHORT = Object.freeze(['Barrier + color', 'Feed', 'Barrier + color', 'Feed', 'Insects', 'Color + barrier', 'Inspection', 'Color + potassium', 'Color + potassium', 'Feed + barrier', 'Feed', 'Potassium feed']);
const PLAN_LABELS = Object.freeze({ rounds: '9 visits a year, one per round', months12: '12 visits a year, one a month' });
// The month bar's words. A plan that is not known (a 6-visit plan, a 9-visit plan while GATE_LAWN_9X_ROUNDS is off, several lawn
// lines) gets no visit count: its words are the month list's own approved line plus the 12-visit body without "One visit a month".
const MONTH_BAR_WORDS = Object.freeze({
  months12: { title: 'Your Year In Twelve Visits', body: 'One visit a month. Each month has one main job. Tap a month to read about it.' },
  unknown: { title: 'Your Year, Month By Month', body: 'Each visit follows the step for the month it falls in. Each month has one main job. Tap a month to read about it.' },
});
const LIMIT_LABEL = 'No nitrogen or phosphorus (local summer rule)';
const ROUNDS_INTRO = Object.freeze({ from: 'The program follows the time of year.', to: 'Your plan is nine visits a year, one in each round.' });
const BLACKOUT_POSTS = Object.freeze({
  manatee_county_fl: { label: 'Fertilizer blackout: Manatee County', url: 'https://www.wavespestcontrol.com/lawn-care/fertilizer-blackout-manatee-county/', source: 'Waves blog' },
  sarasota_county_fl: { label: 'Fertilizer blackout: Sarasota County', url: 'https://www.wavespestcontrol.com/lawn-care/fertilizer-blackout-sarasota-county/', source: 'Waves blog' },
});

const ROUND_WORDS = Object.freeze([
  {
    title: "Winter weed barrier",
    why: "The coolest weeks of the year. Winter weeds sprout while the grass grows slowly, so the first weed barrier of the year goes down where it fits the property, with a micronutrient feeding for color that does not push growth the grass cannot use in the cold. We spot treat weeds and any active large patch where needed.",
    atHome: "Run your normal watering day: that waters in the weed barrier.",
    links: [
      {
        label: "How to help your lawn survive the chill",
        url: "https://gardeningsolutions.ifas.ufl.edu/lawns/maintenance-and-care/how-to-help-your-lawn-survive-the-chill/",
        source: "UF/IFAS"
      },
      {
        label: "Winter weed control",
        url: "https://www.wavespestcontrol.com/lawn-care/winter-weed-control-bradenton-fl/",
        source: "Waves blog"
      }
    ]
  },
  {
    title: "Spring weed barrier and feeding",
    why: "The grass starts to green up. A granular feeding with the spring weed barrier goes down where it fits the property, about six weeks after round 1's barrier and ahead of crabgrass and the other summer weeds. Weed spots stay light while the grass greens up, because heavy spraying slows green-up.",
    atHome: "Keep your normal mowing height; a low mow now sets back grass that is waking up.",
    links: []
  },
  {
    title: "Spring feeding",
    why: "The soil has warmed and the grass is growing hard, so this round carries the main spring feeding, a slow-release granular, where local fertilizer rules allow. Spring is when take-all root rot shows, so mapped take-all areas get a treatment. We spot treat what we find: weeds in March, chinch bugs in April.",
    atHome: "On your watering day, check that the sprinklers reach the strips by the driveway and sidewalk.",
    extra: "Starting your plan in this round? Your first visit can also get the spring weed barrier you missed, where it fits the property.",
    links: [
      {
        label: "Take-all root rot",
        url: "https://ask.ifas.ufl.edu/publication/LH079",
        source: "UF/IFAS"
      },
      {
        label: "Why is my St. Augustine turning brown?",
        url: "https://www.wavespestcontrol.com/lawn-care/st-augustine-lawn-turning-brown/",
        source: "Waves blog"
      }
    ]
  },
  {
    title: "Insect season",
    why: "Before the rains, chinch bugs and other lawn insects peak in hot, sunny turf. The sunny turf gets the program's one whole-lawn insect treatment where it fits the property, and we spot treat chinch bugs, weeds and dry spots elsewhere.",
    atHome: "Text us a photo the day a dry-looking patch shows on a watered lawn.",
    links: [
      {
        label: "Southern chinch bug",
        url: "https://ask.ifas.ufl.edu/publication/IN383",
        source: "UF/IFAS"
      },
      {
        label: "Chinch bugs: check the lawn before treating",
        url: "https://www.wavespestcontrol.com/lawn-care/get-rid-of-chinch-bugs-bradenton-fl/",
        source: "Waves blog"
      }
    ]
  },
  {
    title: "Summer color and summer weed barrier",
    why: "The rainy season starts, and local summer fertilizer rules limit nitrogen through September. The lawn gets iron and micronutrients for color instead, plus a weed barrier for summer weeds where it fits the property. In early summer we also bait mole cricket tunnels.",
    atHome: "When the daily rains start, turn the sprinklers off or down; the rain also waters in the weed barrier.",
    links: []
  },
  {
    title: "Midsummer color and potassium",
    why: "Peak heat and rain. A liquid feeding of iron, micronutrients and potassium keeps the color up through the summer limits, with no nitrogen. We treat caterpillars, leaf spot and chinch bugs where we find them.",
    atHome: "Moths flying up at dusk or chewed blades are worth a text.",
    links: [
      {
        label: "Tropical sod webworms",
        url: "https://www.wavespestcontrol.com/lawn-care/tropical-sod-webworms-sarasota-fl/",
        source: "Waves blog"
      },
      {
        label: "Gray leaf spot",
        url: "https://www.wavespestcontrol.com/lawn-care/gray-leaf-spot-bradenton-fl/",
        source: "Waves blog"
      }
    ]
  },
  {
    title: "Late-summer color and potassium",
    why: "The rainy season winds down. Another feeding of iron, micronutrients and potassium keeps the color up, still with no nitrogen. In September, mapped take-all areas get their first fall treatment, and we keep watching for caterpillars.",
    atHome: "After a storm or flooding, text us a photo before the next visit.",
    links: [
      {
        label: "Fall armyworms",
        url: "https://www.wavespestcontrol.com/lawn-care/fall-armyworms-parrish-fl/",
        source: "Waves blog"
      }
    ]
  },
  {
    title: "Fall feeding and winter weed barrier",
    why: "The summer limits end and the soil cools. The fall feeding goes down with a weed barrier where it fits the property, so it is in place before winter weeds come up. Cool, damp nights start large patch season, so mapped patch areas get a preventive treatment. Grubs or mole crickets found on an October visit get a granule, watered in the same day.",
    atHome: "When the rains stop, set the sprinklers back to your dry-season run and check every head.",
    links: [
      {
        label: "Large patch",
        url: "https://ask.ifas.ufl.edu/publication/LH044",
        source: "UF/IFAS"
      },
      {
        label: "Large patch: signs and lookalikes",
        url: "https://www.wavespestcontrol.com/lawn-care/large-patch-fungus-lakewood-ranch-fl/",
        source: "Waves blog"
      }
    ]
  },
  {
    title: "Cool-season feeding",
    why: "Cool, dry weather. This round's feeding is a light one with extra potassium for the cool, dry season, and we treat any large patch and weed spots.",
    atHome: "Water in your early-morning window only; this is large patch season.",
    links: [
      {
        label: "How to help your lawn survive the chill",
        url: "https://gardeningsolutions.ifas.ufl.edu/lawns/maintenance-and-care/how-to-help-your-lawn-survive-the-chill/",
        source: "UF/IFAS"
      }
    ]
  }
]);

const FAQ_ROWS = Object.freeze([
  {
    q: "How often do you come, and when is my next visit?",
    a: "Nine times a year, once in each round. Rounds have set dates, so visits fall about six weeks apart, usually on the same weekday. Your next visit date is in your customer portal, and we send a reminder before each visit.",
    links: [],
    aMonths: "Once a month. Each visit does the step for its month. Your next visit date is in your customer portal, and we send a reminder before each visit.",
    aUnknown: "Your plan sets how often we come, and each visit follows the step for the month it falls in. Your next visit date is in your customer portal, and we send a reminder before each visit."
  },
  {
    q: "Why are there still weeds after a visit?",
    a: "Sprayed weeds yellow and curl over one to three weeks, and some, like dollarweed and doveweed, often need a second spray. A weed barrier stops seeds, not weeds that are already up. Weed sprays also have yearly limits, so some weeds wait for the cooler months. Thick grass is the long-term fix.",
    links: [
      {
        label: "What dollarweed says about your water",
        url: "https://www.wavespestcontrol.com/lawn-care/dollarweed-control-venice-fl/",
        source: "Waves blog"
      },
      {
        label: "Weeds as clues to soil conditions",
        url: "https://ask.ifas.ufl.edu/publication/EP634",
        source: "UF/IFAS"
      }
    ]
  },
  {
    q: "How much should I water?",
    a: "If the grass shows folded blades, a blue-gray tint, or footprints that stay pressed in, run one full cycle on your next allowed watering day: about 1/2 to 3/4 inch, early in the morning. From the Monday after your plan is booked, most Mondays we email you the rain measured near your home last week and what it means for your sprinklers.",
    links: [
      {
        label: "Find your sprinkler timer",
        url: "https://www.wavespestcontrol.com/sprinkler-timers/",
        source: "Waves"
      },
      {
        label: "Overwatering vs. underwatering",
        url: "https://www.wavespestcontrol.com/lawn-care/overwatering-lawn-vs-underwatering/",
        source: "Waves blog"
      },
      {
        label: "Watering your Florida lawn",
        url: "https://ask.ifas.ufl.edu/publication/LH025",
        source: "UF/IFAS"
      }
    ]
  },
  {
    q: "Why is my grass brown or yellow?",
    a: "Brown patches in hot, sunny spots are often chinch bugs. Tan rings in the cooler months are often large patch. A spot by a sprinkler head or a downspout is often water. On our alkaline soil, yellow St. Augustine is often short on iron, not nitrogen. Text us a photo of the spot.",
    links: [
      {
        label: "Why is my St. Augustine turning brown?",
        url: "https://www.wavespestcontrol.com/lawn-care/st-augustine-lawn-turning-brown/",
        source: "Waves blog"
      },
      {
        label: "St. Augustinegrass for Florida lawns",
        url: "https://ask.ifas.ufl.edu/publication/LH010",
        source: "UF/IFAS"
      }
    ]
  },
  {
    q: "Do you take care of shrubs, palms and flower beds?",
    a: "Not on the lawn plan; it covers the grass. Shrubs, palms and beds are our Tree & Shrub plan, quoted on its own. Ask us for a quote.",
    links: []
  },
  {
    q: "When should my lawn be mowed?",
    a: "Mow high: St. Augustine at 3.5 to 4 inches, and never more than a third of the blade at once. Leave two days between a weed spray and a mow, before or after. Your next visit date is in your portal, so your crew can plan around it.",
    links: [
      {
        label: "Mowing height by grass type",
        url: "https://www.wavespestcontrol.com/lawn-care/mowing-height-by-grass-type/",
        source: "Waves blog"
      },
      {
        label: "A note for whoever mows your lawn",
        url: "https://www.wavespestcontrol.com/lawn-care/note-for-your-mowing-crew/",
        source: "Waves blog"
      },
      {
        label: "Mowing your Florida lawn",
        url: "https://gardeningsolutions.ifas.ufl.edu/lawns/maintenance-and-care/mowing-your-florida-lawn/",
        source: "UF/IFAS"
      }
    ]
  },
  {
    q: "Are chinch bugs and other lawn insects included?",
    a: "Yes. We confirm chinch bugs at the edge of the damage, then treat where we find them, and we rotate products to slow resistance. In round 4, the sunny turf gets a whole-lawn insect treatment where it fits the property. Caterpillars, mole crickets and grubs are covered too. Fire ant control is an add-on, on request.",
    links: [
      {
        label: "Southern chinch bug",
        url: "https://ask.ifas.ufl.edu/publication/IN383",
        source: "UF/IFAS"
      },
      {
        label: "Chinch bugs: check the lawn before treating",
        url: "https://www.wavespestcontrol.com/lawn-care/get-rid-of-chinch-bugs-bradenton-fl/",
        source: "Waves blog"
      }
    ],
    aMonths: "Yes. We confirm chinch bugs at the edge of the damage, then treat where we find them, and we rotate products to slow resistance. In May, the sunny turf gets a whole-lawn insect treatment where it fits the property. Caterpillars, mole crickets and grubs are covered too. Fire ant control is an add-on, on request.",
    aUnknown: "Yes. We confirm chinch bugs at the edge of the damage, then treat where we find them, and we rotate products to slow resistance. Caterpillars, mole crickets and grubs are covered too. Fire ant control is an add-on, on request."
  },
  {
    q: "What about fungus and mushrooms?",
    a: "Large patch (tan or orange rings, October through May) and take-all root rot come back to the same spots, so we map them and treat those areas each season. Gray leaf spot in a wet summer gets a spot treatment. Scattered mushrooms after rain grow on old roots and buried wood, and they fade as the soil dries. Mushrooms in a ring with dark green or thinning grass can be fairy ring, which we treat.",
    links: [
      {
        label: "Large patch",
        url: "https://ask.ifas.ufl.edu/publication/LH044",
        source: "UF/IFAS"
      },
      {
        label: "Large patch: signs and lookalikes",
        url: "https://www.wavespestcontrol.com/lawn-care/large-patch-fungus-lakewood-ranch-fl/",
        source: "Waves blog"
      }
    ]
  },
  {
    q: "Is it safe for my dog and kids?",
    a: "Keep pets and kids off treated areas until the spray has dried. After a granular visit, your service report says whether to water it in first; then let the grass dry.",
    links: []
  },
  {
    q: "How long until I see results?",
    a: "Sprayed weeds take one to three weeks to yellow and curl. Thin or brown grass fills back in by runners: a basketball-size patch can take about six weeks in the rainy season, and large thin spots usually wait for spring. A lawn changes over seasons, not days.",
    links: []
  },
  {
    q: "What if it rains?",
    a: "Rain after a granular feeding or a weed barrier helps: it waters them in. A weed spray works best without water on it afterward, which is why we ask for 24 hours with no sprinklers.",
    links: []
  },
  {
    q: "We are putting in new sod. When should you start?",
    a: "Tell us before it goes in. New sod gets no weed barrier in its first season, and it is where caterpillars show up first. Water it the way our new sod guide says.",
    links: [
      {
        label: "New sod care: the first 30 days",
        url: "https://www.wavespestcontrol.com/lawn-care/new-sod-care/",
        source: "Waves blog"
      },
      {
        label: "Establishing your Florida lawn",
        url: "https://ask.ifas.ufl.edu/publication/LH013",
        source: "UF/IFAS"
      }
    ]
  }
]);

const FAQ_MORE_ROWS = Object.freeze([
  {
    q: "Can you get rid of bermudagrass in my St. Augustine?",
    a: "We can knock it back with an add-on treatment on the mapped areas: up to two sprays a year, six weeks apart, while the St. Augustine fills in. It is not safe on every St. Augustine variety, so we check yours first.",
    links: [
      {
        label: "Removing bermudagrass from St. Augustine",
        url: "https://www.wavespestcontrol.com/lawn-care/remove-bermudagrass-from-st-augustine/",
        source: "Waves blog"
      }
    ]
  },
  {
    q: "Do you test my soil?",
    a: "Only when a lawn is not responding. Then we send one sample to the University of Florida soil lab. If the soil is too acidic or short on magnesium, we add lime or magnesium on a regular visit. Most results change nothing. Topsoil and topdressing are separate work, quoted on their own.",
    links: []
  },
  {
    q: "Do I need to be home?",
    a: "No. We need safe access to the lawn: an unlocked gate and pets inside.",
    links: []
  },
  {
    q: "Should I put down weed-and-feed between visits?",
    a: "Please skip it. The weed killer in it can reach shrub and tree roots, and extra products make it hard to tell what is working.",
    links: []
  },
  {
    q: "Can you get rid of torpedograss?",
    a: "Not without killing the St. Augustine around it. The fix is removing the patch and re-sodding, which is not part of the lawn program.",
    links: []
  },
  {
    q: "Why did a visit look like nothing happened?",
    a: "A winter weed barrier visit can look like nothing happened; that is the point. While the lawn greens up we spot treat lightly, because heavy spraying delays green-up.",
    links: []
  },
  {
    q: "Can every spot be fixed?",
    a: "Deep shade, packed new-build soil, buried debris or a blocked sprinkler head limit any lawn program. Grass that never grew under a tree will not start now; trimming limbs or a planting bed works better.",
    links: []
  }
]);

const EMAIL_TEXT = "From the Monday after your plan is booked, most Mondays we email you the rain measured near your home last week and what it means for your sprinklers. Add your watering days, minutes per zone and head type in your customer portal (My Property, then Irrigation), and the email tells you how long to run each turf zone.";

const TIMELINE_ITEMS = Object.freeze([
  { when: 'Visit day', icon: 'reentry', title: 'Stay off until it dries', text: 'People and pets stay off treated areas until the spray has dried. Your report lists anything else to do.' },
  { when: 'First 24 hours', icon: 'dry_spots', title: 'Sprinklers off after a weed spray', text: 'After a granular visit, your report may ask for one sprinkler cycle instead.' },
  { when: 'Within 2 weeks', icon: 'barrier', title: 'Water in a weed barrier', text: 'It needs about 1/2 inch of rain or watering within 14 days. Your regular watering day counts.' },
  { when: '1 to 3 weeks', icon: 'weeds', title: 'Sprayed weeds brown out', text: 'Leave them in place. Pulling them early stops the treatment.' },
].map((item) => Object.freeze(item)));
const TIMELINE_NOTE = 'No mowing two days before or after a weed spray. Mole cricket bait needs three days with the sprinklers off that spot; your report says when a visit had one.';

const AFTER_VISIT_ITEMS = Object.freeze([
  { icon: 'report', title: 'A service report after every visit', text: 'What we found, what we applied with EPA numbers where they apply, photos, and your next step.', image: '/outline/sample-lawn-report-thumb.jpg', imageAlt: 'A sample lawn service report', href: '/outline/sample-lawn-report.jpg', linkLabel: 'See a sample report' },
  { icon: 'portal', title: 'Your customer portal', text: 'Your next visit date, reports, invoices and messages in one place, and a reminder before each visit.', image: '/outline/sample-portal-home-thumb.jpg', imageAlt: 'The customer portal home screen', href: '/outline/sample-portal-home.jpg', linkLabel: 'See the customer portal' },
].map((item) => Object.freeze(item)));

const EMAIL_CARD = Object.freeze({
  wide: true,
  icon: 'reminders',
  title: 'Your Monday watering email',
  text: EMAIL_TEXT,
  pictures: Object.freeze([
    { image: '/outline/watering-email-sample-thumb.jpg', imageAlt: 'A sample Monday watering email', href: '/outline/watering-email-sample.jpg', linkLabel: 'See a sample email' },
    { image: '/outline/sample-irrigation-thumb.jpg', imageAlt: 'The Irrigation screen in the customer portal', href: '/outline/sample-irrigation.jpg', linkLabel: 'See the Irrigation screen' },
  ].map((picture) => Object.freeze(picture))),
});
const MOW_NOTE_LINK = Object.freeze({ href: 'https://www.wavespestcontrol.com/lawn-care/note-for-your-mowing-crew/', linkLabel: 'A note for whoever mows your lawn' });

// ── dates ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const dateParts = (dateStr) => dateStr.split('-').map(Number);
const dayNumber = (dateStr) => { const [y, m, d] = dateParts(dateStr); return Date.UTC(y, m - 1, d) / 86400000; };
const dayDiff = (from, to) => Math.round(dayNumber(to) - dayNumber(from));
// A leap year for the month windows' last day, so February runs to 02-29 and a leap day still falls in February.
const LEAP_YEAR = 2024;
const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const monthDay = (dateStr) => { const [, m, d] = dateParts(dateStr); return `${MONTH_ABBR[m - 1]} ${d}`; };
const windowText = (start, end) => `${monthDay(start)} – ${monthDay(end)}`;
const stepNames = (steps, labels) => steps.map((step) => labels[step] || step).join(', ');
const stepsLine = (label, steps, labels) => (steps.length ? `${label}: ${stepNames(steps, labels)}.` : `${label}.`);

// The months a date range touches, in order (a round can cross a year end: round 1 and round 9's neighbors).
function monthsInRange(start, end) {
  const out = [];
  let [y, m] = dateParts(start);
  const [endYear, endMonth] = dateParts(end);
  while (y < endYear || (y === endYear && m <= endMonth)) {
    out.push(m);
    y += m === 12 ? 1 : 0;
    m = m === 12 ? 1 : m + 1;
  }
  return out;
}

// ── the plan ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function lawnLineName(svc) {
  return svc.name || svc.serviceName || svc.service_name || 'Lawn Care';
}

// The estimate's lawn plan, by the decision the seeder makes when the estimate books: exactly one residential lawn line, its
// seeding cadence from the converter's own inference, then the seeder's lawnRoundsSeriesPattern (which needs
// GATE_LAWN_9X_ROUNDS). 'rounds' = it seeds as lawn_rounds_9; 'months12' = monthly; anything else (no lawn line, several,
// another cadence, or a failed read) = 'unknown', which draws the 12-month bar and names no plan.
function resolveLawnPlan(estimateData) {
  try {
    const converter = require('./estimate-converter');
    const lines = converter.recurringServicesFromEstimateData(estimateData || {}).filter((svc) => {
      const parent = { service_type: lawnLineName(svc) };
      return converter.seedingFamilyKey(svc, parent) === 'lawn_care' && !converter.isCommercialRecurringLine(svc, parent);
    });
    if (lines.length !== 1) return 'unknown';
    const pattern = converter.converterFollowUpSeedingPattern(lines[0], { service_type: lawnLineName(lines[0]) }, undefined);
    const seeded = require('./recurring-appointment-seeder').lawnRoundsSeriesPattern({ ...lines[0], pattern, intervalDays: null }).pattern;
    if (seeded === lawnRounds.LAWN_ROUNDS_9) return 'rounds';
    return seeded === 'monthly' ? 'months12' : 'unknown';
  } catch (err) {
    require('./logger').warn(`[lawn-outline-visual] lawn plan unreadable (12-month view, no plan label): ${err.message}`);
    return 'unknown';
  }
}

// ── protocol-derived steps ───────────────────────────────────────────────────────────────────────────────────────────────────
// The steps the round's own visit draws: ROUND_STEPS names the step month and its rounds-only variant, and the step's primary
// lines go through the same categories the month list uses, so the December potassium bag and the K-Acetate line land as the
// month list shows them.
function roundMainSteps(round, trackKey, kit) {
  const step = lawnRounds.ROUND_STEPS[round];
  const visit = kit.protocolVisitForMonth(trackKey, step.month);
  return kit.monthSteps(visitForRound(visit, { round, ...step }).visit).main;
}

// The as-needed steps: the spot rows (secondary lines) of every real month the window covers, read through roundSpotMonth (the
// St. Augustine green-up exception). The optional fire ant add-on line and the weed mix surfactant are not program steps.
function roundAsNeededSteps(round, months, trackKey, kit) {
  const steps = [];
  for (const realMonth of months) {
    const spotMonth = lawnRounds.roundSpotMonth({ round, realMonth, grassTrack: trackKey });
    const lines = kit.protocolLines(kit.protocolVisitForMonth(trackKey, spotMonth)?.secondary)
      .filter((line) => !kit.notProgramLine.test(line) && !/nonionic surfactant/i.test(line));
    for (const line of lines) steps.push(...(kit.outlineCategory(line)?.[2] || []));
  }
  return [...new Set(steps)];
}

// The nine rounds of the program year that holds `now`, with dates, day counts and derived steps.
function roundFacts(programYear, trackKey, kit) {
  return lawnRounds.LAWN_ROUND_TABLE.map(({ round }) => {
    const start = lawnRounds.roundStart(programYear, round);
    const end = lawnRounds.roundEnd(programYear, round);
    return {
      n: round,
      start,
      end,
      days: dayDiff(start, end) + 1,
      window: windowText(start, end),
      main: roundMainSteps(round, trackKey, kit),
      asNeeded: roundAsNeededSteps(round, monthsInRange(start, end), trackKey, kit),
    };
  });
}

// ── the local summer rule ────────────────────────────────────────────────────────────────────────────────────────────────────
// The restricted season as a band on the bar: offset and days from the bar start, plus the caption. A rule with no season, or one
// that wraps a year end, draws neither.
function limitBand(rule, barStart, year) {
  const startMonth = Number(rule?.restricted_start_month);
  const endMonth = Number(rule?.restricted_end_month);
  if (!startMonth || !endMonth || startMonth > endMonth) return null;
  const startDay = Number(rule.restricted_start_day) || 1;
  const endDay = Number(rule.restricted_end_day) || daysInMonth(year, endMonth);
  const start = ymd(year, startMonth, startDay);
  const end = ymd(year, endMonth, endDay);
  const area = rule.jurisdiction_name ? `Your rule area: ${rule.jurisdiction_name}. ` : '';
  return {
    limit: { offset: dayDiff(barStart, start), days: dayDiff(start, end) + 1, label: LIMIT_LABEL },
    caption: `${area}No nitrogen or phosphorus from ${MONTH_FULL[startMonth - 1]} ${startDay} to ${MONTH_FULL[endMonth - 1]} ${endDay}; micronutrients keep the color instead.`,
  };
}

// ── the year bar ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
function barSection(title, body, bullets, visual, kit) {
  return kit.makeSection('year_bar', title, body, bullets, { type: 'yearBar', ...visual });
}

function roundsBar({ rounds, programYear, rule, kit }) {
  const barStart = lawnRounds.roundStart(programYear, 1);
  const band = limitBand(rule, barStart, programYear);
  // from/to are MM-DD, so the page can mark today's block when it draws (the stored packet is read for 45 days).
  const blocks = rounds.map((r) => ({
    key: r.n,
    label: String(r.n),
    days: r.days,
    window: r.window,
    main: r.main,
    short: ROUND_SHORT[r.n - 1],
    from: r.start.slice(5),
    to: r.end.slice(5),
    now: `You are here: round ${r.n} (${r.window}).`,
    aside: `Round ${r.n} · ${r.window}`,
  }));
  const bullets = rounds.map((r) => stepsLine(`Round ${r.n} (${r.window})`, r.main, kit.stepLabels));
  if (band) bullets.push(band.caption);
  return barSection('Your Year In Nine Rounds', 'Nine visits a year, one in each round. Each round has set dates and one main job. Tap a round to jump to it.', bullets, {
    blocks,
    anchorPrefix: 'round',
    months: MONTH_INITIALS.map((label, index) => ({ label, offset: dayDiff(barStart, ymd(programYear, index + 1, 1)) })),
    anchors: ['Dec 25', 'Jul', 'Dec 24'],
    limit: band?.limit || null,
    labels: kit.stepLabels,
    keySteps: KEY_STEPS,
    caption: band?.caption || null,
  }, kit);
}

function monthsBar({ plan, trackKey, year, rule, kit }) {
  const words = MONTH_BAR_WORDS[plan] || MONTH_BAR_WORDS.unknown;
  const barStart = ymd(year, 1, 1);
  const band = limitBand(rule, barStart, year);
  const blocks = MONTH_ABBR.map((label, index) => ({
    key: index + 1,
    label,
    days: daysInMonth(year, index + 1),
    window: label,
    main: kit.monthSteps(kit.protocolVisitForMonth(trackKey, index + 1)).main,
    short: MONTH_SHORT[index],
    from: `${pad(index + 1)}-01`,
    to: `${pad(index + 1)}-${pad(daysInMonth(LEAP_YEAR, index + 1))}`,
    now: `You are here: ${MONTH_FULL[index]}.`,
    aside: MONTH_FULL[index],
  }));
  const bullets = blocks.map((b) => stepsLine(MONTH_FULL[b.key - 1], b.main, kit.stepLabels));
  if (band) bullets.push(band.caption);
  return barSection(words.title, words.body, bullets, {
    blocks,
    anchorPrefix: 'month',
    months: [],
    anchors: ['Jan', 'Jul', 'Dec'],
    limit: band?.limit || null,
    labels: kit.stepLabels,
    keySteps: KEY_STEPS,
    caption: band?.caption || null,
  }, kit);
}

// ── the round cards ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function roundLinks(n, words, jurisdictionId) {
  if (n !== 5) return words.links.map((link) => ({ ...link }));
  const post = BLACKOUT_POSTS[jurisdictionId];
  return post ? [{ ...post }] : [];
}

function roundsSection(rounds, jurisdictionId, kit) {
  const cards = rounds.map((r) => {
    const words = ROUND_WORDS[r.n - 1];
    return {
      n: r.n,
      window: r.window,
      title: words.title,
      main: r.main,
      asNeeded: r.asNeeded,
      why: words.why,
      ...(words.extra ? { extra: words.extra } : {}),
      atHome: words.atHome,
      links: roundLinks(r.n, words, jurisdictionId),
    };
  });
  const bullets = cards.map((c) => `Round ${c.n} (${c.window}), ${c.title}: ${c.why}${c.extra ? ` ${c.extra}` : ''} At home: ${c.atHome}`);
  return kit.makeSection('rounds', 'What Each Round Does', 'The round you are in is open. Tap any round to see what it does and one thing to do at home.', bullets, { type: 'rounds', rounds: cards, labels: kit.stepLabels });
}

// ── the other new sections ───────────────────────────────────────────────────────────────────────────────────────────────────
const itemLines = (items) => items.map((item) => `${item.title}: ${item.text}`);

function timelineSection(kit) {
  const items = TIMELINE_ITEMS.map((item) => ({ ...item }));
  const bullets = [...items.map((item) => `${item.when}, ${item.title}: ${item.text}`), TIMELINE_NOTE];
  return kit.makeSection('after_visit_timeline', 'After A Visit', '', bullets, { type: 'timeline', items, note: TIMELINE_NOTE });
}

function factsSection(key, title, body, items, kit) {
  return kit.makeSection(key, title, body, itemLines(items), { type: 'facts', items });
}

function afterVisitSection(kit) {
  return factsSection('after_visit', 'After Each Visit', '', AFTER_VISIT_ITEMS.map((item) => ({ ...item })), kit);
}

// The Monday email card, then the one-day-order tile (Manatee and Sarasota, with its `until`) when the outline's own watering
// tiles carry it. The other watering tiles live in the FAQ and the timeline.
function wateringSection(jurisdictionId, now, kit) {
  const orderTile = kit.wateringTiles(jurisdictionId, now).find((tile) => tile.until);
  return factsSection('your_watering', kit.detailCopy.wateringTitle, kit.detailCopy.wateringBody, [{ ...EMAIL_CARD }, ...(orderTile ? [{ ...orderTile }] : [])], kit);
}

function mowingSection(kit) {
  const tiles = kit.detailCopy.mowingTiles.map((tile) => ({ ...tile }));
  tiles[0] = { ...tiles[0], big: '3.5 to 4 in' };
  tiles[tiles.length - 1] = { ...tiles[tiles.length - 1], ...MOW_NOTE_LINK };
  return factsSection('your_mowing', kit.detailCopy.mowingTitle, kit.detailCopy.mowingBody, tiles, kit);
}

function faqLines(rows) {
  return rows.map((row) => `${row.q} ${row.a}`);
}

function problemsSection(kit) {
  const items = kit.detailCopy.problemTiles.map((tile) => ({ q: tile.title, a: tile.text, links: [] }));
  return kit.makeSection('problems', kit.detailCopy.problemsTitle, `${kit.detailCopy.problemsBody} Tap one to read more.`, itemLines(kit.detailCopy.problemTiles), { type: 'faq', items, more: [] });
}

// The 9-visit list drops the one bag only the 12-visit April step uses (LESCO 44-0-0); the body adds the label sentence.
function productsSection(plan, productList, kit) {
  const list = plan === 'rounds' ? productList.filter((product) => !/44-0-0/.test(product.text)) : productList;
  const section = kit.productsSection(list);
  return section && { ...section, body: 'Each visit uses only what the lawn needs, and every pesticide is applied according to its label. Your service report names every product applied, with its EPA number.' };
}

// Two answers name a cadence: a 12-visit plan reads its month wording, a plan that is not known reads one with no cadence.
function faqSection(plan, kit) {
  const reword = (row) => {
    const { aMonths, aUnknown, ...rest } = row;
    return { ...rest, a: { months12: aMonths, unknown: aUnknown }[plan] || row.a, links: row.links.map((link) => ({ ...link })) };
  };
  const items = FAQ_ROWS.map(reword);
  const more = FAQ_MORE_ROWS.map(reword);
  return kit.makeSection('faq', 'Common Questions', 'The questions customers ask us most, answered straight.', faqLines([...items, ...more]), { type: 'faq', items, more });
}

// ── entry points ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The program year holding `now` (ET) and its nine rounds.
function roundsContext(now, trackKey, kit) {
  const { programYear } = lawnRounds.roundOf(etDateString(now));
  return { programYear, rounds: roundFacts(programYear, trackKey, kit) };
}

// The outline's sections under the gate, in the approved order. `parts` carries what the outline builds itself: the visit steps,
// the exclusions and, for a monthly plan, today's month list (called only then).
function visualSections({ plan, trackKey, jurisdictionRule, productList, now, kit, parts }) {
  const jurisdictionId = jurisdictionRule?.jurisdiction_id;
  const rounding = plan === 'rounds' ? roundsContext(now, trackKey, kit) : null;
  const head = rounding
    ? [roundsBar({ ...rounding, rule: jurisdictionRule, kit }), roundsSection(rounding.rounds, jurisdictionId, kit)]
    : [monthsBar({ plan, trackKey, year: Number(etDateString(now).slice(0, 4)), rule: jurisdictionRule, kit }), parts.monthList()];
  return [
    ...head,
    parts.typicalVisit,
    timelineSection(kit),
    afterVisitSection(kit),
    wateringSection(jurisdictionId, now, kit),
    mowingSection(kit),
    problemsSection(kit),
    productsSection(plan, productList, kit),
    parts.notIncluded,
    faqSection(plan, kit),
  ].filter(Boolean);
}

// The words that sit outside the sections: the plan line on the property, and for a rounds plan the intro sentence. Mutates the packet content the outline just built.
function applyVisualContent(content, plan) {
  const label = PLAN_LABELS[plan];
  if (!label) return content;
  content.property = { ...content.property, planLabel: label };
  if (plan !== 'rounds') return content;
  content.intro = String(content.intro || '').replace(ROUNDS_INTRO.from, ROUNDS_INTRO.to);
  return content;
}

module.exports = { resolveLawnPlan, visualSections, applyVisualContent };
