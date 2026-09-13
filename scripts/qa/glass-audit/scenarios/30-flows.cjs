'use strict';
// Token-gated customer flows + auth shell states rendered against the REAL
// SPA routes (no preview html). Every /api call is answered by the fixture
// handler below; fictional data only (Jordan Rivera / 1200 Sample Lane).
//
// Token format gates (docs/public-route-contracts.md + server/routes):
//   /appointment/:token  64 hex  (appointment-public.js TOKEN_RE)
//   /prep/:token         32 hex  (prep-public.js TOKEN_RE)
//   /rate/:token         none    (review-gate.js looks the token up as-is)
//   /card/:token         64 hex  (card-public.js TOKEN_RE)
//   /service-outlines/:t 43 url-safe base64 chars (service-outlines-public.js)
//   /newsletter/archive/:id  uuid (public-newsletter.js posts/:id)

const HEX64_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const HEX64_B = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';
const HEX64_C = 'deadbeef00112233445566778899aabbccddeeff00112233445566778899aabb';
const HEX32 = '5f6e7d8c9b0a1f2e3d4c5b6a79880011';
const OUTLINE_TOKEN = 'Qx7Lm2Np9Rt4Vw6Yz8Ab1Cd3Ef5Gh7Jk9Mn2Pq4Rs6T'; // 43 chars [A-Za-z0-9_-] (service-outlines-public.js gate)
const NEWS_ID = '3f2a9c1e-7b4d-4e8f-9a6c-1d2e3f4a5b6c';

const ok = (body) => ({ status: 200, body });
// appointment-public.js classifies a visit as `past` once its arrival window has ended, so an
// `upcoming` / `confirmable` payload must carry a FUTURE date: eight ET calendar days out (never tomorrow,
// which flips `isTomorrow` copy), computed with the same helpers the booking scenarios use.
const { addETDays, etDateString } = require('../../../../server/utils/datetime-et');
const { formatDisplayDate } = require('../../../../server/utils/date-only');
const APPT_DATE = etDateString(addETDays(new Date(), 8));
const serverError = () => ({ status: 500, body: { error: 'glass-audit: simulated outage' } });

// ---------------------------------------------------------------------------
// /appointment/:token  (AppointmentPage.jsx ← server/routes/appointment-public.js)
// ---------------------------------------------------------------------------
const APPT_BASE = {
  state: 'upcoming',
  phase: null,
  service: { type: 'Quarterly Pest Control' },
  appointment: { date: APPT_DATE, windowStart: '09:00', arrivalWindow: '9:00–11:00 AM' },
  calendarEligible: true,
  vanScene: false,
  isTomorrow: false,
  confirmed: false,
  confirmable: true,
  tech: { firstName: 'Alex', photoUrl: null, sameAsLastVisit: true },
  plan: { isRecurring: true, collectiveAnchor: false },
  weather: { rainChance: 45, stormy: true },
  rescheduleToken: HEX64_B,
};
const apptHandle = (payload, confirmRes) => ({ method, path }) => {
  if (method === 'GET' && path === `/api/public/appointment/${HEX64_A}`) return ok(payload);
  if (method === 'POST' && path === `/api/public/appointment/${HEX64_A}/confirm`) return confirmRes || ok({ success: true, confirmed: true });
  return null;
};

const appointment = {
  id: 'appointment', family: 'flow', surface: 'customer', role: 'public token', route: '/appointment/:token',
  url: `/appointment/${HEX64_A}`, ready: 'Confirm this appointment', extraWidths: true, settle: 900,
  handle: apptHandle(APPT_BASE),
  states: [
    {
      name: 'upcoming',
      interactions: [
        {
          name: 'confirm', fullPage: true,
          run: async (page) => {
            const b = page.getByRole('button', { name: /Confirm this appointment/ });
            await b.scrollIntoViewIfNeeded();
            await b.click();
            await page.getByTestId('appointment-confirmed').waitFor();
          },
        },
      ],
    },
    { name: 'confirmed', ready: "Confirmed. We'll see you then", handle: apptHandle({ ...APPT_BASE, confirmed: true, confirmable: false }) },
    { name: 'cancelled', ready: 'This appointment was cancelled', handle: apptHandle({ ...APPT_BASE, state: 'cancelled', tech: null, plan: null, weather: null, confirmable: false, rescheduleToken: null }) },
    { name: 'error', ready: "We couldn't load that appointment", handle: () => serverError() },
  ],
};

// ---------------------------------------------------------------------------
// /prep/:token  (PrepGuidePage.jsx ← server/routes/prep-public.js)
// ---------------------------------------------------------------------------
// `fetchUpcomingFamilyVisits` (prep-public.js) filters `scheduled_date >= etDateString()`, so a
// literal band stops being a state the route can emit the day it passes: after the first date the
// route drops that row, and after the second it returns no band at all while this scenario kept
// rendering both. Both visits are generated from the run date instead. The labels go through the
// route's own formatters too -- `formatDisplayDate` with no overrides ("September 18, 2026", no
// weekday) and `formatArrivalWindow`'s H:MM shape -- which the hand-written 'Friday, September 18'
// and '9-11 AM' strings never matched.
const PREP_VISIT_1 = etDateString(addETDays(new Date(), 7));
const PREP_VISIT_2 = etDateString(addETDays(new Date(), 21));
const prepDateLabel = (ymd) => formatDisplayDate(ymd, { fallback: '' });
const PREP_PAYLOAD = {
  customerFirstName: 'Jordan',
  customerName: 'Jordan Rivera',
  serviceContactNames: ['Casey Rivera'],
  projectTypeLabel: 'German Cockroach',
  serviceDate: prepDateLabel(PREP_VISIT_1),
  propertyAddress: '1200 Sample Lane, Venice, FL 34285',
  technicianName: 'Alex',
  supportPhone: '(941) 555-0100',
  upcomingVisits: [
    { dateLabel: prepDateLabel(PREP_VISIT_1), serviceLabel: 'German Cockroach Treatment · Visit 1 of 2', windowLabel: '9:00–11:00 AM' },
    { dateLabel: prepDateLabel(PREP_VISIT_2), serviceLabel: 'German Cockroach Follow-up', windowLabel: '1:00–3:00 PM' },
  ],
  blocks: [
    { type: 'paragraph', content: 'A little preparation goes a long way. The steps below give the treatment full access to the places roaches hide and keep your family and pets clear while the products go down.' },
    { type: 'details', rows: [
      { label: 'Service', value: 'German Cockroach Treatment' },
      { label: 'Time on site', value: 'About 60–90 minutes' },
      { label: 'Re-entry', value: 'Once treated surfaces are dry — your technician confirms timing' },
      { label: 'Pets', value: 'Out of treated rooms until surfaces are dry, as your technician advises' },
    ] },
    { type: 'heading', content: 'Before we arrive' },
    { type: 'paragraph', content: 'Empty the cabinets under the kitchen and bathroom sinks and wipe the shelves. Pull the stove and refrigerator a few inches from the wall if you can do so safely.' },
    { type: 'paragraph', content: 'Clear countertops of small appliances, dish racks and food. Anything that stays out should be covered or moved to another room.' },
    { type: 'callout', content: 'Skip the bug bombs and sprays before the visit — they scatter the population into walls and make the treatment less effective.' },
    { type: 'heading', content: 'Kitchen checklist' },
    { type: 'paragraph', content: 'Run the dishwasher and put dishes away. Take out the trash and wipe down the inside of the trash can. Store pet food in a sealed container.' },
    { type: 'details', rows: [
      { label: 'Cabinets', value: 'Emptied and wiped' },
      { label: 'Counters', value: 'Clear of food and appliances' },
      { label: 'Trash', value: 'Emptied, can rinsed' },
      { label: 'Pet bowls', value: 'Picked up and washed' },
    ] },
    { type: 'heading', content: 'Bathrooms and laundry' },
    { type: 'paragraph', content: 'Clear the floor and the cabinet under the sink. Move towels and toiletries into a drawer or another room for the day.' },
    { type: 'heading', content: 'During and after the visit' },
    { type: 'paragraph', content: 'Plan to stay out of the treated rooms until surfaces are dry — your technician will confirm timing before leaving. Leave the gel bait and stations in place — they keep working for weeks after we leave.' },
    { type: 'details', variant: 'faq', rows: [
      { label: 'Will I still see roaches after treatment?', value: 'Yes, for a week or two. Bait works by being carried back to the nest, so activity climbs briefly before it drops off. The follow-up visit finishes the job.' },
      { label: 'Can I clean after the visit?', value: 'Light cleaning is fine after 24 hours. Avoid scrubbing the cabinet edges and hinges where the gel bait was placed.' },
      { label: 'What if I have a newborn or someone with asthma at home?', value: 'Tell your technician when they arrive. The plan can lean on baits and stations instead of any residual spray.' },
    ] },
  ],
};
const prepGuide = {
  id: 'prep-guide', family: 'flow', surface: 'customer', role: 'public token', route: '/prep/:token',
  url: `/prep/${HEX32}`, ready: 'German Cockroach Prep Guide', settle: 900,
  handle: ({ method, path }) => (method === 'GET' && path === `/api/public/prep/${HEX32}` ? ok(PREP_PAYLOAD) : null),
  states: [
    { name: 'default' },
    { name: 'error', ready: 'load that prep guide', handle: () => serverError() },
  ],
};

// ---------------------------------------------------------------------------
// /rate/:token  (RatePage.jsx ← server/routes/review-gate.js)
// The page is a 1–10 scale, not stars: the "five-stars" interaction taps 10
// (the top of the scale), which reveals the standout chips + review CTA.
// ---------------------------------------------------------------------------
const RATE_PAYLOAD = {
  firstName: 'Jordan',
  techName: 'Alex Morgan',
  techPhotoUrl: null,
  serviceType: 'Pest Control',
  hasServiceType: true,
  serviceDate: '2026-09-08',
  locationName: 'Waves Pest Control – Venice',
  googleReviewUrl: 'https://example.invalid/google-review',
};
const rate = {
  id: 'rate', family: 'flow', surface: 'customer', role: 'public token', route: '/rate/:token',
  url: `/rate/${HEX64_C}`, ready: "how'd we do", settle: 900,
  handle: ({ method, path }) => {
    if (method === 'GET' && path === `/api/rate/${HEX64_C}`) return ok(RATE_PAYLOAD);
    if (method === 'POST' && path === `/api/rate/${HEX64_C}/score`) return ok({ saved: true, category: 'promoter' });
    return null;
  },
  states: [
    {
      name: 'default',
      interactions: [
        {
          name: 'five-stars', fullPage: true,
          run: async (page) => {
            await page.getByRole('button', { name: '10', exact: true }).click();
            await page.getByText('What stood out?').waitFor();
          },
        },
      ],
    },
    { name: 'error', ready: 'load that feedback request', handle: () => serverError() },
  ],
};

// ---------------------------------------------------------------------------
// /card/:token  (CardPage.jsx ← server/routes/card-public.js → services/customer-card.js)
// ---------------------------------------------------------------------------
const CARD_PAYLOAD = {
  customer: { firstName: 'Jordan', memberSinceYear: 2024, hasLeftGoogleReview: false },
  tech: { name: 'Alex Morgan', firstName: 'Alex', photoUrl: null },
  phone: { display: '(941) 555-0100', e164: '+19415550100' },
  reviewUrl: 'https://example.invalid/l/review',
  referralUrl: 'https://example.invalid/?tab=refer',
  firstVisitCompletedAt: '2024-03-14T19:30:00.000Z',
  walletAvailable: false,
};
const digitalCard = {
  id: 'digital-card', family: 'card', surface: 'customer', role: 'public token', route: '/card/:token',
  url: `/card/${HEX64_A}`, ready: 'Your Waves technician', settle: 900,
  handle: ({ method, path }) => (method === 'GET' && path === `/api/card/${HEX64_A}` ? ok(CARD_PAYLOAD) : null),
  states: [
    { name: 'default' },
    { name: 'error', ready: 'load that card', handle: () => serverError() },
  ],
};

// ---------------------------------------------------------------------------
// /service-outlines/:token  (ServiceOutlinePage.jsx ← server/routes/service-outlines-public.js)
// ---------------------------------------------------------------------------
const OUTLINE_PACKET = {
  id: 4201,
  title: 'Lawn Care Program Overview',
  status: 'sent',
  noindex: true,
  expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), // service-outlines-public.js expires the token; stay 30 days past the run
  summary: {},
  content: {
    title: 'Your Lawn Care Program',
    intro: 'A season-by-season look at what we do on your St. Augustine lawn, why each visit matters, and the products that may be used along the way.',
    property: { addressSummary: '1200 Sample Lane, Venice', turfType: 'St. Augustine (Floratam)' },
    season: { monthName: 'September' },
    cta: { estimatePath: `/estimate/${HEX64_B}` },
    sections: [
      { key: 'overview', title: 'How the program works', body: 'Eight visits a year, roughly six weeks apart. Each visit pairs a fertilizer step with the insect and weed work the season calls for.', bullets: ['Slow-release fertilizer matched to the month', 'Chinch bug and sod webworm monitoring every visit', 'Broadleaf weed control when temperatures allow', 'Soil and irrigation notes left after each visit'] },
      { key: 'fall', title: 'Fall focus (September – November)', body: 'Fall is recovery season. We rebuild root mass after summer stress and get ahead of winter weeds before they germinate.', bullets: ['Potassium-forward feeding for root strength', 'Pre-emergent for winter annual weeds', 'Fungicide only if leaf spot or brown patch shows'] },
      { key: 'watering', title: 'Watering and mowing', body: 'The program only works with the right water. Deep, infrequent watering and a 3.5–4 inch mowing height keep Floratam dense enough to crowd out weeds.', bullets: ['Two deep waterings a week in season', 'Mow high, never more than a third of the blade', 'Keep blades sharp to avoid tip dieback'] },
      { key: 'expectations', title: 'What to expect', body: 'Visible improvement takes two to three visits. Weed pressure drops first, then color and density follow as the root system rebuilds.' },
    ],
    productCards: [
      { id: 'p1', name: 'Slow-release 24-0-11', category: 'Fertilizer', summary: 'Balanced feed with iron for color between visits.', epaRegistrationNumber: null },
      { id: 'p2', name: 'Bifenthrin granular', category: 'Insect control', summary: 'Targets chinch bugs and sod webworm when activity is confirmed.', epaRegistrationNumber: '00000-000' },
      { id: 'p3', name: 'Prodiamine pre-emergent', category: 'Weed control', summary: 'Prevents winter annual weeds when applied before soil temperatures drop.', epaRegistrationNumber: '00000-001' },
    ],
  },
};
const serviceOutline = {
  id: 'service-outline', family: 'document-outline', surface: 'customer', role: 'public token', route: '/service-outlines/:token',
  url: `/service-outlines/${OUTLINE_TOKEN}`, ready: 'Program Snapshot', settle: 900,
  handle: ({ method, path }) => (method === 'GET' && path === `/api/service-outlines/${OUTLINE_TOKEN}` ? ok({ packet: OUTLINE_PACKET }) : null),
  states: [
    { name: 'default' },
    { name: 'error', ready: "We couldn't load your program overview", handle: () => serverError() },
  ],
};

// ---------------------------------------------------------------------------
// /newsletter/archive/:id  (NewsletterArchivePage.jsx ← server/routes/public-newsletter.js posts/:id)
// The body renders inside a sandboxed srcdoc iframe; the image is a data: URI
// so nothing leaves the app origin.
// ---------------------------------------------------------------------------
const NEWS_IMG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="280" viewBox="0 0 640 280">'
  + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0A5480"/><stop offset="1" stop-color="#9BD4EA"/></linearGradient></defs>'
  + '<rect width="640" height="280" rx="16" fill="url(#g)"/>'
  + '<text x="320" y="150" font-family="Georgia, serif" font-size="34" fill="#fff" text-anchor="middle">Sample newsletter image</text></svg>',
);
const NEWS_POST = {
  id: NEWS_ID,
  slug: 'fall-lawn-reset',
  subject: 'Your fall lawn reset: three things to do this month',
  newsletterType: 'seasonal',
  previewText: 'Cooler nights are coming. Here is how to help your lawn recover from summer and get ahead of winter weeds.',
  htmlBody: [
    `<img src="${NEWS_IMG}" alt="Fall lawn" style="width:100%;border-radius:12px;">`,
    '<h2>Why September matters</h2>',
    '<p>Summer heat leaves Floratam thin and hungry. The next six weeks are when the root system rebuilds, so what you do now shows up as color and density in November.</p>',
    '<h3>Three things to do this month</h3>',
    '<ul><li><strong>Water deep, not often.</strong> Two long waterings a week beat daily sprinkles.</li>'
    + '<li><strong>Raise the mower.</strong> Cut at 3.5–4 inches so the canopy shades out weed seed.</li>'
    + '<li><strong>Watch for chinch bugs.</strong> Yellow patches along the driveway edge are the first sign — text us a photo.</li></ul>',
    '<h2>What our team is doing</h2>',
    '<p>Your fall visits shift to a potassium-forward feed and a pre-emergent for winter annuals. Read the visit note after each stop for the specifics on your lawn.</p>',
    '<p><a href="https://www.wavespestcontrol.com/">See the full seasonal guide</a></p>',
  ].join('\n'),
  textBody: null,
  sentAt: '2026-09-03T14:00:00.000Z',
  indexability: 'index',
};
const newsletterArchive = {
  id: 'newsletter-archive', family: 'document-newsletter', surface: 'customer', role: 'public', route: '/newsletter/archive/:id',
  url: `/newsletter/archive/${NEWS_ID}`, ready: 'Your fall lawn reset', settle: 1800,
  handle: ({ method, path }) => (method === 'GET' && path === `/api/public/newsletter/posts/${NEWS_ID}` ? ok(NEWS_POST) : null),
  states: [
    { name: 'default' },
    { name: 'error', ready: 'load that newsletter issue', handle: () => serverError() },
  ],
};

// ---------------------------------------------------------------------------
// /login  (LoginPage.jsx + hooks/useAuth.jsx)
// No waves_token seeded → AuthProvider skips /auth/me and the page mounts on
// the phone step. Only POST /auth/send-code is exercised.
// ---------------------------------------------------------------------------
const sendCodeHandle = (res) => ({ method, path }) => (method === 'POST' && path === '/api/auth/send-code' ? res : null);
async function submitPhone(page) {
  await page.locator('#waves-login-phone').fill('9415550147');
  await page.getByRole('button', { name: 'Send code' }).click();
}
const login = {
  id: 'login', family: 'auth', surface: 'customer', role: 'public', route: '/login',
  url: '/login', ready: 'Sign in to Waves', extraWidths: true, settle: 800,
  handle: sendCodeHandle(ok({ success: true })),
  states: [
    { name: 'phone-step' },
    {
      name: 'code-step',
      setup: async (page) => { await submitPhone(page); await page.getByText('Enter your code').waitFor(); },
    },
    {
      name: 'error',
      // Empty JSON error body → api.request() throws "Request failed (429)",
      // which authErrorCopy maps to the curated "Too many attempts" line.
      handle: sendCodeHandle({ status: 429, body: {} }),
      setup: async (page) => { await submitPhone(page); await page.getByRole('alert').waitFor(); },
    },
  ],
};

// ---------------------------------------------------------------------------
// App shell states (client/src/App.jsx ProtectedRoute)
// ---------------------------------------------------------------------------
const FAKE_TOKEN = 'glass-audit-fake-session-token';

// /auth/me never answers → useAuth stays `loading` → "Loading your portal" card.
// The promise deliberately never settles: the runner awaits handle() inside
// its route callback, and a late fulfill against a closed context would
// reject after the capture is done.
const appAuthLoading = {
  id: 'app-auth-loading', family: 'auth', surface: 'customer', role: 'customer (session check)', route: '/ (auth pending)',
  url: '/', ready: 'Loading your portal', settle: 900,
  localStorage: { waves_token: FAKE_TOKEN },
  handle: ({ method, path }) => (method === 'GET' && path === '/api/auth/me' ? new Promise(() => {}) : null),
  notes: 'GET /api/auth/me is intentionally left pending (never resolves) so the session-check card stays on screen.',
};

// CustomerFailureScreen via the notification-target guard: the session loads
// (customer 101) but the saved-property list 500s, and the deep link names a
// DIFFERENT profile (?notificationProperty=999) → the guard cannot verify the
// switch and fails closed with "Property unavailable".
const appFailureScreen = {
  id: 'app-failure-screen', family: 'auth', surface: 'customer', role: 'customer (notification deep link)', route: '/ (?notificationProperty= property switch failure)',
  url: '/?notificationProperty=999', ready: 'Property unavailable', settle: 900,
  localStorage: { waves_token: FAKE_TOKEN },
  handle: ({ method, path }) => {
    if (method === 'GET' && path === '/api/auth/me') {
      return ok({ id: 101, firstName: 'Jordan', lastName: 'Rivera', cancelled: false, propertyScope: { enabled: false } });
    }
    if (method === 'GET' && path === '/api/auth/properties') return serverError();
    return null;
  },
};

module.exports = [
  appointment,
  prepGuide,
  rate,
  digitalCard,
  serviceOutline,
  newsletterArchive,
  login,
  appAuthLoading,
  appFailureScreen,
];
