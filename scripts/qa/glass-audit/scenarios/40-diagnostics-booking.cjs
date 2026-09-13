'use strict';
// Diagnostics (lawn / pest report), the public /book funnel, the real
// /estimate/:token SPA route, and the cross-family 404 / load-error cards.
//
// SYNTHETIC. Every payload below is fictional (Jordan Rivera / 1200 Sample
// Lane); tokens are generated hex that only satisfies each page's format
// gate. Shapes come from the page's fetch usage + the server route's
// response builder:
//   server/routes/public-lawn-diagnostic.js  (buildPublicLawnReport)
//   server/services/pest-identification.js   (buildPublicPestReport)
//   server/routes/booking.js                  (/config, /availability, /customer-lookup, /find-slots, /capture-intent, /confirm)
//   client/src/dev-preview/estimate-preview-main.jsx (pest /data payload, SLOTS, REVIEWS)
/* global document */

// ── helpers ─────────────────────────────────────────────────────────────

// Deterministic hex "token" of a given length (never a real token).
const hexToken = (len, seed) => {
  let out = '';
  let x = seed >>> 0;
  while (out.length < len) {
    x = (x * 1103515245 + 12345) >>> 0;
    out += (x >>> 8).toString(16).padStart(6, '0');
  }
  return out.slice(0, len);
};

// ET calendar dates relative to now — offered slots must stay in the
// booking window, so nothing here is a literal date. Days are advanced on the
// ET CALENDAR (server/utils/datetime-et.js addETDays), not by 86 400 000 ms:
// across the fall DST fold a fixed duration lands on the same ET date.
const { addETDays, etDateString } = require('../../../../server/utils/datetime-et');
const etYmd = (daysOut) => etDateString(addETDays(new Date(), daysOut)); // YYYY-MM-DD
const etFullDate = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
const label12 = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const plusMinutes = (hhmm, mins) => {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + mins;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

// 1×1 PNG data URI — a placeholder "photo" that never leaves the fixture.
// NOTE: neither diagnostic page renders photos today (see `notes`), the
// field is carried so the payload stays representative of a funnel row.
const PHOTO_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const json = (body, status = 200) => ({ status, body });
const notFound = () => json({ error: 'Not found' }, 404);
const serverError = () => json({ error: 'temporary failure' }, 500);

// ── 1. /lawn-report/:token ──────────────────────────────────────────────

const LAWN_TOKEN = hexToken(32, 41); // FULL_TOKEN_RE = /^[a-f0-9]{32}$/
const LAWN_REPORT = {
  first_name: 'Jordan',
  city: 'Venice',
  overall_status: 'Needs attention',
  summary: 'Your St. Augustine lawn is mostly healthy, but two areas along the driveway are showing early chinch bug damage and there is some dollar-weed pressure in the shadier back corner. Both respond well when we treat them now, before the summer heat sets in.',
  primary_finding: 'Chinch bugs',
  confidence: 'high',
  photos: [
    { url: PHOTO_DATA_URI, caption: 'Driveway edge — yellowing patches' },
    { url: PHOTO_DATA_URI, caption: 'Back corner — dollar weed' },
  ],
  findings: [
    { name: 'Chinch bugs', severity: 'moderate', confidence: 'high', customer_note: 'We saw the classic yellow-to-brown patches that start near hot, sunny edges like the driveway. Chinch bugs feed at the base of the blades and spread outward.' },
    { name: 'Dollar weed', severity: 'mild', confidence: 'high', customer_note: 'The round, coin-shaped leaves in the back corner point to an area that stays damp — usually a watering or drainage adjustment plus a targeted treatment.' },
    { name: 'Thin turf', severity: 'mild', confidence: 'medium', customer_note: 'The strip along the fence is a little thin from shade. It fills in with the right fertilization and mowing height.' },
  ],
  watering: {
    customer_sequence: 'Water twice a week before 8 AM for about 45 minutes per zone, then let the lawn dry out between waterings. Skip a cycle after a heavy rain.',
    restriction_summary: 'Sarasota County allows watering on your assigned days only — we will line the schedule up with your address.',
  },
  expectations: {
    weeds: 'Dollar weed starts to yellow within 10–14 days of the first treatment and thins out over the following month.',
    fungus: null,
    insects: 'Chinch bug activity stops within a few days of treatment; the damaged patches recover over 4–6 weeks as new growth fills in.',
    turf_recovery: 'Expect visible green-up within two to three weeks, with the thinner areas filling in over the season.',
  },
  watch_items: [
    "We'll keep an eye on chinch bugs and how it responds.",
    "We'll keep an eye on dollar weed and how it responds.",
    "We'll keep an eye on thin turf and how it responds.",
  ],
  seasonal_context: 'Late summer in Southwest Florida brings daily rain and heat, so lawns are growing fast and pests like chinch bugs are most active — a good time to get ahead of them.',
  pricing: {
    service_label: 'Your lawn program',
    tiers: [
      { label: '9 Applications', monthly: 85, annual: 1020, visits: 9, recommended: true },
      { label: '6 Applications', monthly: 68, annual: 816, visits: 6, recommended: false },
    ],
    basis_note: 'Pricing shown for a typical Southwest Florida lawn. Your exact quote takes about a minute and reflects your actual property.',
  },
};

const lawnHandle = ({ method, path }) => {
  if (method === 'GET' && path === `/api/public/lawn-diagnostic/${LAWN_TOKEN}`) return json({ success: true, report: LAWN_REPORT, glassDefault: true });
  if (method === 'POST' && path === `/api/public/lawn-diagnostic/${LAWN_TOKEN}/quote-request`) return json({ success: true }, 201);
  return null;
};

const lawnInteractions = [
  {
    name: 'quote-request', fullPage: true,
    run: async (page) => {
      const phone = page.getByLabel('Phone', { exact: true });
      await phone.scrollIntoViewIfNeeded();
      await phone.fill('(941) 555-0142');
      await page.getByLabel('Email', { exact: true }).fill('jordan.rivera@example.com');
      await page.getByRole('button', { name: /Get my free lawn plan/ }).click();
      await page.getByText(/reach out shortly/).waitFor();
    },
  },
];

// ── 2. /pest-report/:token ──────────────────────────────────────────────

const PEST_TOKEN = hexToken(32, 42); // TOKEN_RE = /^[a-f0-9]{32}$/
const PEST_REPORT = {
  first_name: 'Jordan',
  city: 'Venice',
  identified: { label: 'Ghost Ants', hedged: false, category: 'ant', confidence: 'high' },
  not_a_pest: false,
  urgency: 'moderate',
  safety: { stinging: false, venomous: false, disease_vector: false, structural_threat: false },
  about: 'Ghost ants are tiny, pale ants that nest indoors near moisture — kitchens and bathrooms especially — and trail to sweets. They are harmless but persistent, and a single colony can have several satellite nests, so spot treatments rarely clear them.',
  next_step: 'Book a visit this week and we will treat the trails and the nests behind them, then keep the perimeter protected so they do not come back.',
  recommendation: { service_label: 'Quarterly Pest Control', inspection_required: false, note: null },
  photos: [{ url: PHOTO_DATA_URI, caption: 'Kitchen counter trail' }],
  pricing: {
    service_label: 'Quarterly Pest Control',
    tiers: [
      { label: 'Quarterly', monthly: 31.33, annual: 375.96, visits: 4, recommended: true },
      { label: 'Bi-monthly', monthly: 47, annual: 564, visits: 6, recommended: false },
    ],
    basis_note: 'Pricing shown for a typical Southwest Florida home. Your exact quote takes about a minute and reflects your actual property.',
  },
};

const pestHandle = ({ method, path }) => {
  if (method === 'GET' && path === `/api/public/pest-identifier/${PEST_TOKEN}`) return json({ success: true, report: PEST_REPORT });
  return null;
};

// ── 3. /book ────────────────────────────────────────────────────────────

const BOOKING_CONFIG = {
  enabled: true,
  customers_only: false,
  ai_search: false,
  multi_service: true,
  van_scene: true,
  advance_days_min: 1,
  advance_days_max: 14,
  slot_duration_minutes: 60,
  day_start: '08:00',
  day_end: '17:00',
};

// days[].slots[] mirrors buildBookingAvailability's public slot shape:
// start_time/end_time (24h), labels, technician_id, slot_sig, nearby, rank.
function bookingDays() {
  const spec = [
    { daysOut: 2, nearby: true, starts: ['09:00', '11:00', '13:00'] },
    { daysOut: 3, nearby: false, starts: ['10:00', '14:00'] },
    { daysOut: 5, nearby: true, starts: ['09:00', '15:00'], rainChance: 55 },
    { daysOut: 7, nearby: false, starts: ['08:00', '12:00', '16:00'] },
    { daysOut: 9, nearby: false, starts: ['09:00'] },
  ];
  return spec.map((d, di) => {
    const date = etYmd(d.daysOut);
    return {
      date,
      fullDate: etFullDate(date),
      nearby: d.nearby,
      ...(d.rainChance ? { rainChance: d.rainChance } : {}),
      slots: d.starts.map((start, si) => ({
        slotId: `slot-${di}-${si}`,
        start_time: start,
        end_time: plusMinutes(start, 60),
        start_label: label12(start),
        end_label: label12(plusMinutes(start, 60)),
        technician_id: 7,
        slot_sig: hexToken(40, 100 + di * 10 + si),
        nearby: d.nearby && si === 0,
        rank: di * 10 + si,
        reason: d.nearby && si === 0 ? 'A technician is already routed nearby that morning.' : null,
      })),
    };
  });
}

function bookingAvailability({ query, body }) {
  const days = bookingDays();
  const from = (query && query.date_from) || (body && body.date_from) || null;
  const scoped = from ? days.filter((d) => d.date === from) : days;
  // Ranked picks reference the day-panel rows by slotId + date.
  const ranked = scoped.flatMap((d) => d.slots.filter((s) => s.nearby).map((s) => ({ slotId: s.slotId, date: d.date, start_time: s.start_time, rank: s.rank })))
    .concat(scoped.slice(0, 1).flatMap((d) => d.slots.slice(1, 2).map((s) => ({ slotId: s.slotId, date: d.date, start_time: s.start_time, rank: s.rank }))))
    .slice(0, 3);
  return {
    slots: ranked,
    days: scoped,
    nearby: scoped.some((d) => d.nearby),
    lat: 27.1,
    lng: -82.44,
    duration_minutes: 60,
    service_type: (query && query.service_type) || (body && body.service_type) || 'pest_control',
    total_feasible: scoped.reduce((n, d) => n + d.slots.length, 0),
    capture_token: `${Date.now() + 1800000}.synthetic-capture-token`,
  };
}

const bookingHandle = ({ method, path, query, body }) => {
  if (method === 'GET' && path === '/api/booking/config') return json(BOOKING_CONFIG);
  if (method === 'GET' && path === '/api/booking/availability') return json(bookingAvailability({ query }));
  if (method === 'GET' && path === '/api/booking/customer-lookup') return json({ customer: null, possible_match: false });
  if (method === 'POST' && path === '/api/booking/find-slots') return json({ summary: 'Here is what is open around then:', ...bookingAvailability({ body }) });
  if (method === 'POST' && path === '/api/booking/capture-intent') return json({ ok: true });
  if (method === 'POST' && path === '/api/booking/confirm') {
    return json({
      ok: true,
      confirmationCode: 'WPC-4F2K9Q',
      booking: { id: 'booking-synthetic-1', scheduled_date: body && body.slot_date, start_time: body && body.slot_start, service_type: body && body.service_type, status: 'pending' },
      secureCard: { url: `/secure/${hexToken(64, 77)}` },
    });
  }
  return null;
};

const BOOKING_ADDRESS = '1200 Sample Lane, Venice, FL 34285';

// Address autocomplete is Google Places (external origin → blocked by the
// harness), so the street is typed as plain text: the input forwards
// onChange, and the blur geocoder is a no-op without window.google. City /
// zip therefore stay blank in the fixture — the server-side echo would
// normally fill lat/lng, and the availability mock does that here.
const bookingInteractions = [
  {
    name: 'step-2', fullPage: true,
    run: async (page) => {
      const input = page.getByPlaceholder('Start typing your address');
      await input.fill(BOOKING_ADDRESS);
      await page.getByRole('button', { name: /Find my best times/ }).click();
      await page.getByText(/Tap a time/).first().waitFor();
    },
  },
  {
    name: 'step-3', fullPage: true,
    run: async (page) => {
      const slot = page.getByRole('button', { name: /^Choose 9:00 AM/ }).first();
      await slot.scrollIntoViewIfNeeded();
      await slot.click();
      const next = page.getByRole('button', { name: /^Continue/ });
      await next.scrollIntoViewIfNeeded();
      await next.click();
      await page.getByText('Your info', { exact: true }).waitFor();
    },
  },
  {
    name: 'step-4', fullPage: true,
    run: async (page) => {
      await page.locator('#book-phone').fill('(941) 555-0142');
      await page.locator('#book-first-name').fill('Jordan');
      await page.locator('#book-last-name').fill('Rivera');
      await page.locator('#book-email').fill('jordan.rivera@example.com');
      await page.locator('#book-notes').fill('Gate code 1234 — friendly dog in the back yard.');
      const confirm = page.getByRole('button', { name: /^Confirm booking/ });
      await confirm.scrollIntoViewIfNeeded();
      await confirm.click();
      await page.getByText("You're booked!", { exact: true }).waitFor();
    },
  },
];

// ── 5. /estimate/:token (real SPA route) ────────────────────────────────

const ESTIMATE_TOKEN = hexToken(64, 51); // ESTIMATE_TOKEN_RE = /^[A-Za-z0-9_-]{15,64}$/
const isoDaysOut = (d) => new Date(Date.now() + d * 86400000).toISOString();

// Minimal pest payload — mirrors pestScenario() in estimate-preview-main.jsx
// (fictional contact swapped in) plus the /data extras the preview adds.
function estimatePestPayload() {
  const addOns = [
    { key: 'interior_spray', label: 'Interior spraying', preChecked: true, detail: 'Save $10/visit if removed. No interior treatment — tech sprays and inspects the perimeter only.' },
    { key: 'exterior_sweep', label: 'Exterior eave sweep', preChecked: true, detail: 'Save $10/visit if removed. No eave/cobweb sweep on the exterior — tech still performs the perimeter treatment.' },
  ];
  const visits = { quarterly: 4, bi_monthly: 6, monthly: 12 };
  const freq = (key, label, monthly, perVisit, annual) => ({
    key, label, monthly, annual, perVisit, visitsPerYear: visits[key],
    included: [{ key: 'pest_control', label: 'Pest Control', detail: null }],
    addOns,
  });
  return {
    estimate: {
      id: 1,
      token: ESTIMATE_TOKEN,
      slug: 'WPC-2026-0512',
      createdAt: isoDaysOut(0),
      expiresAt: isoDaysOut(7),
      customerFirstName: 'Jordan',
      customerName: 'Jordan Rivera',
      customerEmail: 'jordan.rivera@example.com',
      customerPhone: '9415550142',
      address: '1200 Sample Lane, Venice, FL 34285',
      askToken: 'synthetic-ask-token',
      category: 'RESIDENTIAL',
      status: 'sent',
      satelliteUrl: null,
      intelligence: {
        eyebrow: 'Waves AI',
        title: 'Waves AI reviewed your property before pricing this estimate',
        body: 'We reviewed your home, lot, and pest-risk factors before pricing this plan.',
        metrics: [
          { label: 'Home size', value: '2,340 sq ft' },
          { label: 'Lot size', value: '0.21 acres' },
          { label: 'Year built', value: '2024' },
        ],
        signals: [],
      },
      notes: null,
      licenseNumber: 'JB000000',
      showOneTimeOption: false,
      isOneTimeOnly: false,
      defaultServiceMode: 'recurring',
      acceptedServiceMode: null,
      acceptedFrequencyKey: null,
      billByInvoice: false,
      siteConfirmationHold: false,
      acceptance: { mode: 'standard_slot_pick' },
      membership: null,
      serviceCategory: 'pest_control',
    },
    pricing: {
      services: [{
        key: 'pest_control',
        label: 'Pest Control',
        isRecurring: true,
        isPest: true,
        waveGuardTierEligible: true,
        defaultFrequencyKey: 'quarterly',
        frequencies: [
          freq('quarterly', 'Quarterly', 31.33, 94, 375.96),
          freq('bi_monthly', 'Bi-monthly', 47, 94, 564),
          freq('monthly', 'Monthly', 55, 55, 660),
        ],
        setupFee: null,
        quoteRequired: false,
        copy: { priceWording: {} },
      }],
      renderFlags: { showRecurringSummary: false, showWaveGuardSetupFee: false, showPestRecurringAddOns: true, showServiceDetailsRequest: true },
      waveGuardTier: 'Bronze',
      askChips: ['How do you handle ants?', 'Can you treat inside?', 'When am I charged?', 'What happens after approval?'],
      anchorOneTimePrice: 0,
      oneTimeBreakdown: { total: 0, items: [] },
      setupFee: null,
      annualPrepayEligible: true,
      defaultServiceMode: 'recurring',
    },
    cta: { canAccept: true, terminalState: null, quoteRequired: false, quoteRequiredReason: null, reviewBeforeBooking: false },
    glassDefault: true,
    returnVisit: { visitNumber: 3, lastVisitAt: isoDaysOut(-3), changes: [] },
    lawnCalendar: { programs: { standard: { visitsPerYear: 9 } } },
    softExit: true,
    softExitChange: true,
  };
}

const ESTIMATE_SLOTS = {
  nearby: true,
  primary: [
    { slotId: 's1', date: etYmd(1), windowStart: '09:00', windowEnd: '10:00', routeOptimal: true, techFirstName: 'Alex' },
    { slotId: 's2', date: etYmd(2), windowStart: '11:00', windowEnd: '12:00' },
    { slotId: 's3', date: etYmd(4), windowStart: '09:00', windowEnd: '10:00' },
    { slotId: 's4', date: etYmd(5), windowStart: '13:00', windowEnd: '14:00' },
    { slotId: 's5', date: etYmd(6), windowStart: '09:00', windowEnd: '10:00', routeOptimal: true, techFirstName: 'Alex' },
    { slotId: 's6', date: etYmd(7), windowStart: '15:00', windowEnd: '16:00' },
  ],
  expander: [
    { slotId: 's7', date: etYmd(8), windowStart: '09:00', windowEnd: '10:00' },
    { slotId: 's8', date: etYmd(9), windowStart: '10:00', windowEnd: '11:00' },
  ],
};

const ESTIMATE_REVIEWS = {
  reviews: [
    { reviewerName: 'Dana R.', starRating: 5, location: 'Venice', text: 'Always on time, thorough, and the ants on our lanai are completely gone.' },
    { reviewerName: 'Mike T.', starRating: 5, location: 'Sarasota', text: 'Great communication from booking to service day. The tech walked me through everything he treated.' },
    { reviewerName: 'Karen L.', starRating: 5, location: 'North Port', text: 'We switched from a national chain and the difference is night and day.' },
    { reviewerName: 'Josh P.', starRating: 5, location: 'Nokomis', text: 'Booked online in two minutes and the tech showed up in the promised window.' },
  ],
  aggregate: { averageRating: '5.0', totalCount: 4 },
};

const estimateHandle = ({ method, path }) => {
  if (method === 'GET' && path === `/api/estimates/${ESTIMATE_TOKEN}/data`) return json(estimatePestPayload());
  if (method === 'GET' && path === `/api/public/estimates/${ESTIMATE_TOKEN}/available-slots`) return json(ESTIMATE_SLOTS);
  if (method === 'GET' && path === '/api/reviews/featured') return json(ESTIMATE_REVIEWS);
  return null;
};

// ── 4. error states across families ─────────────────────────────────────
// `default` = the data endpoint 404s (each page's own not-found card);
// `load-error` = it 500s (the shared PublicLoadError / retry card).

const errorScenario = ({ id, route, url, notFoundText, loadErrorText }) => ({
  id, family: 'error-states', surface: 'customer', role: 'public token', route, url,
  handle: notFound, ready: notFoundText, settle: 600,
  states: [
    { name: 'default' },
    { name: 'load-error', handle: serverError, ready: loadErrorText },
  ],
});

module.exports = [
  {
    id: 'lawn-report', family: 'document-diagnostic', surface: 'customer', role: 'public token', route: '/lawn-report/:token',
    url: `/lawn-report/${LAWN_TOKEN}`, ready: 'Here\'s what we saw at your Venice lawn', handle: lawnHandle, settle: 900,
    notes: 'LawnReportViewPage renders no photos (the public egress builder emits none); the fixture carries a data: URI `photos` field for shape parity only. The 32-hex token satisfies FULL_TOKEN_RE server-side; the page has no client gate.',
    states: [
      // Interactions are scoped to the populated state: the error card has no
      // quote form, so a scenario-level interaction would time out there.
      { name: 'default', interactions: lawnInteractions },
      { name: 'error', handle: serverError, ready: 'load that lawn report' },
    ],
  },
  {
    id: 'pest-report', family: 'document-diagnostic', surface: 'customer', role: 'public token', route: '/pest-report/:token',
    url: `/pest-report/${PEST_TOKEN}`, ready: 'Jordan, here\'s what we identified', handle: pestHandle, settle: 900,
    notes: 'PestReportViewPage renders no photos either; `photos` is carried for shape parity. Book-now CTA is an external marketing URL (no fetch).',
    states: [
      { name: 'default' },
      { name: 'error', handle: serverError, ready: 'load that pest report' },
    ],
  },
  {
    id: 'booking', family: 'booking', surface: 'customer', role: 'public', route: '/book',
    url: '/book?service=pest_control', ready: 'Find a date & time that works for you', handle: bookingHandle, extraWidths: true, settle: 900,
    notes: 'Google Places autocomplete is an external origin (blocked); the street is typed as plain text, so city/zip stay blank and only the availability echo supplies lat/lng. Interactions run in order on one page: step-2 (times), step-3 (contact), step-4 (confirmation with van scene + secure-card block).',
    states: [{ name: 'step-1' }],
    interactions: bookingInteractions,
  },
  errorScenario({ id: 'estimate-404', route: '/estimate/:token', url: `/estimate/${hexToken(64, 61)}`, notFoundText: 'Estimate unavailable', loadErrorText: 'load that estimate' }),
  errorScenario({ id: 'report-404', route: '/report/:token', url: `/report/${hexToken(32, 62)}`, notFoundText: 'Report unavailable', loadErrorText: 'load that service report' }),
  errorScenario({ id: 'track-404', route: '/track/:token', url: `/track/${hexToken(64, 63)}`, notFoundText: 'Tracking link unavailable', loadErrorText: 'load your tracker' }),
  errorScenario({ id: 'reschedule-404', route: '/reschedule/:token', url: `/reschedule/${hexToken(64, 64)}`, notFoundText: 'find that appointment', loadErrorText: 'load that appointment' }),
  errorScenario({ id: 'secure-404', route: '/secure/:token', url: `/secure/${hexToken(64, 65)}`, notFoundText: 'find that link', loadErrorText: 'css:[data-glass="card"], h1' }),
  errorScenario({ id: 'pay-404', route: '/pay/:token', url: `/pay/${hexToken(64, 66)}`, notFoundText: 'find that invoice', loadErrorText: 'load that invoice' }),
  {
    id: 'estimate-spa-route', family: 'estimate', surface: 'customer', role: 'public token', route: '/estimate/:token (real SPA route under WavesShell)',
    url: `/estimate/${ESTIMATE_TOKEN}`, ready: 'Jordan', handle: estimateHandle, settle: 1200,
    notes: 'Same pest payload as preview-estimate.html?scenario=pest, served through the real /api/estimates/:token/data route mock so the WavesShell-wrapped SPA route can be diffed against the preview harness.',
  },
];
