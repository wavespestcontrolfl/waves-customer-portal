/**
 * DEV HARNESS — the lawn Fast Complete sheet (the one-screen fast lane), the
 * REAL component full-screen over synthetic data and a fake `request` (no
 * network, no API, no database). Served by `npx vite` at
 * /preview-lawn-fast-lane.html?state=<start|photos|analyzed|confirmed|empty-products>.
 * NOT part of the app build (no rollup input) — never a public route.
 *
 *   start           nothing entered: the note, the shot list, Analyze lawn
 *   photos          three photos in their slots, not analyzed
 *   analyzed        the four scores shown and editable, not yet confirmed
 *   confirmed       assessment confirmed, a note typed, a tip and a blog post
 *                   picked, products on: Complete is on
 *   empty-products  a visit whose plan lists no products
 *
 * The page loads the same global stylesheets the admin app entry loads
 * (index.css, brand-tokens.css; the sheet imports tech-workflow.css itself) and
 * marks <html> as the admin app does, so type and colors match Dispatch.
 *
 * Preview-only behavior: "Add" on a photo shot adds a placeholder picture
 * instead of opening the file picker, and the fake Confirm saves the scores
 * the tech typed (the intended behavior once PR #5878's server change lands;
 * on today's server a score the AI read keeps the AI value).
 */
import '../index.css';
import '../styles/brand-tokens.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import FastCompleteLawnSheet from '../components/tech/FastCompleteLawnSheet';

document.documentElement.classList.add('admin-app');
document.body.style.margin = '0';
document.body.style.background = '#fafafa';

const STATES = ['start', 'photos', 'analyzed', 'confirmed', 'empty-products'];
const requested = new URLSearchParams(window.location.search).get('state');
const STATE = STATES.includes(requested) ? requested : 'start';

// ── synthetic data ──────────────────────────────────────────────────────────
const IDS = {
  celsius: 'bbbbbbbb-0000-4000-8000-000000000001',
  headway: 'bbbbbbbb-0000-4000-8000-000000000002',
  primo: 'bbbbbbbb-0000-4000-8000-000000000003',
  prodiamine: 'bbbbbbbb-0000-4000-8000-000000000004',
  dismiss: 'bbbbbbbb-0000-4000-8000-000000000005',
};
const CATALOG = [
  { id: IDS.celsius, name: 'Celsius WG', category: 'herbicide', formulation: 'WG', inventory_on_hand: '120.0000', inventory_unit: 'oz' },
  { id: IDS.headway, name: 'Headway G', category: 'fungicide', formulation: 'granular', inventory_on_hand: '300.0000', inventory_unit: 'lb' },
  { id: IDS.primo, name: 'Primo Maxx', category: 'pgr', formulation: 'SC', inventory_on_hand: '90.0000', inventory_unit: 'fl_oz' },
  { id: IDS.prodiamine, name: 'Prodiamine 65 WDG', category: 'pre-emergent', formulation: 'WDG', inventory_on_hand: '200.0000', inventory_unit: 'oz' },
  { id: IDS.dismiss, name: 'Dismiss NXT', category: 'herbicide', formulation: 'SC', inventory_on_hand: '60.0000', inventory_unit: 'fl_oz' },
];
const LAWN_SQFT = 5750;
const PLANNED = [
  { productId: IDS.celsius, name: 'Celsius WG', applicationMethod: 'broadcast_spray', amount: 3.4, amountUnit: 'oz', treatedSqft: LAWN_SQFT, areaUnit: 'sqft', ratePer1000: 0.59, rateUnit: 'oz' },
  { productId: IDS.headway, name: 'Headway G', applicationMethod: 'granular_broadcast', amount: 17.3, amountUnit: 'lb', treatedSqft: LAWN_SQFT, areaUnit: 'sqft', ratePer1000: 3, rateUnit: 'lb' },
  { productId: IDS.primo, name: 'Primo Maxx', applicationMethod: 'broadcast_spray', amount: 1.4, amountUnit: 'fl_oz', treatedSqft: LAWN_SQFT, areaUnit: 'sqft', ratePer1000: 0.25, rateUnit: 'fl_oz' },
];
const VISIT = {
  id: 'svc-preview',
  customerId: 'cust-preview',
  customerName: 'Jordan Sample',
  serviceType: 'Every 6 Weeks Lawn Care Service',
  status: 'confirmed',
  scheduledDate: '2026-10-05T13:00:00.000Z',
  propertyId: 'prop-preview',
  catalogServiceId: null,
  address: { line1: '100 Sample Street', line2: null, city: 'Bradenton', state: 'FL', zip: '34205' },
  hasPhone: true,
  category: 'lawn_care',
  serviceKey: 'lawn_care_recurring',
  isCallback: false,
  technicianId: null,
};
const SERVICE = {
  id: 'svc-preview',
  customerName: 'Jordan Sample',
  serviceType: 'Every 6 Weeks Lawn Care Service',
  address: '100 Sample Street, Bradenton',
  timeLabel: '9:00 AM',
  routedCustomerId: 'cust-preview',
  routedScheduledDate: '2026-10-05',
  routedPropertyId: 'prop-preview',
  routedAddress: '100 Sample Street, Bradenton',
};

const SCORES = { turf_density: 78, weed_suppression: 64, color_health: 71, stress_damage: 58, fungus_control: 90, thatch_level: 85 };
const REVIEW = { status: 'complete', findings: [], addedDetails: [], photoQuality: [], aiScores: SCORES };
const ASSESSMENT = { id: 'assessment-preview', confirmed_by_tech: false, observations: 'Thin turf along the sunny edge.', ...SCORES };

const TIPS = {
  available: true,
  groups: [{
    id: 'lawn',
    tips: [
      { id: 'tip-mow-high', label: 'Mow high', copy: 'Keep the grass 3.5 to 4 inches tall so the canopy shades out weeds.', keywords: ['mow', 'height'] },
      { id: 'tip-water-morning', label: 'Water early', copy: 'Water in the early morning so the blades dry before evening.', keywords: ['water', 'morning'] },
      { id: 'tip-sharp-blades', label: 'Sharpen the mower blade', copy: 'A dull blade tears the grass and invites disease.', keywords: ['mower', 'blade'] },
      { id: 'tip-edge-shade', label: 'Thin turf in shade', copy: 'Shaded turf thins out; trimming back branches lets in light.', keywords: ['shade'] },
    ],
  }],
};
const POSTS = [
  { id: '99999999-9999-4999-8999-000000000001', title: 'Why St. Augustine Thins Out Every Summer', url: 'https://www.wavespestcontrol.com/lawn-care/st-augustine-summer-thinning/' },
  { id: '99999999-9999-4999-8999-000000000002', title: 'Chinch Bugs in Bradenton Lawns: What to Look For', url: 'https://www.wavespestcontrol.com/lawn-care/chinch-bugs-bradenton/' },
];

const context = () => ({
  enabled: true,
  eligible: true,
  reason: null,
  visitType: 'recurring',
  findingsType: null,
  service: VISIT,
  visitDate: '2026-10-05',
  turfHeightCapture: false,
  plannedProducts: { source: 'plan', items: STATE === 'empty-products' ? [] : PLANNED },
  plannedProductsUnavailable: null,
  assessment: STATE === 'confirmed'
    ? { exists: true, id: ASSESSMENT.id, confirmed: true, unusableReason: null }
    : { exists: STATE === 'analyzed', id: STATE === 'analyzed' ? ASSESSMENT.id : null, confirmed: false },
  photoStatus: null,
  previousFrontPhoto: null,
  readFailures: [],
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The fake admin API: no network, ever.
async function request(path, options = {}) {
  const body = options.body ? JSON.parse(options.body) : null;
  if (path.endsWith('/lawn-fast/context')) return context();
  if (path.includes('/lawn-assessment/service/')) {
    if (STATE === 'analyzed') return { shotListEnabled: true, assessment: ASSESSMENT, visitAssessment: REVIEW, aiScores: SCORES };
    if (STATE === 'confirmed') return { shotListEnabled: true, assessment: { ...ASSESSMENT, confirmed_by_tech: true }, visitAssessment: REVIEW, aiScores: SCORES };
    return { shotListEnabled: true, assessment: null };
  }
  if (path.endsWith('/lawn-assessment/assess')) {
    await wait(900);
    return { success: true, assessment: ASSESSMENT, visitAssessment: REVIEW, adjustedScores: SCORES, observations: ASSESSMENT.observations };
  }
  if (path.endsWith('/lawn-assessment/confirm')) {
    await wait(400);
    // Intended behavior once #5878's server change lands: a posted number wins.
    const typed = Object.fromEntries(Object.entries(body?.adjustedScores || {}).filter(([, value]) => value != null));
    return { success: true, confirmed: true, assessment: { ...ASSESSMENT, ...typed, confirmed_by_tech: true }, visitAssessment: REVIEW };
  }
  if (path.endsWith('/tech-tips')) return TIPS;
  if (path.includes('/blog-posts')) return path.includes('?q=') ? { available: true, posts: POSTS } : { available: true, posts: [] };
  if (path.includes('/turf-profile')) return { profile: { lawn_sqft: LAWN_SQFT } };
  if (path === '/admin/dispatch/products/catalog') return { products: CATALOG };
  if (path.endsWith('/complete')) {
    await wait(700);
    return { success: true, invoiceId: null };
  }
  return {};
}

// ── photos: placeholder pictures instead of the file picker ─────────────────
const SHOT_COLORS = ['#a3b18a', '#8fa876', '#b7c9a0', '#7f9c68', '#a9bd93'];
let photoCount = 0;
function placeholderFile() {
  const color = SHOT_COLORS[photoCount % SHOT_COLORS.length];
  photoCount += 1;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="${color}"/><path d="M0 330 Q160 290 320 330 T640 320 V480 H0Z" fill="#6b8f4e"/><text x="320" y="170" font-family="sans-serif" font-size="34" fill="#fff" text-anchor="middle">Sample photo ${photoCount}</text></svg>`;
  return new File([svg], `sample-${photoCount}.svg`, { type: 'image/svg+xml' });
}
const nativeClick = HTMLInputElement.prototype.click;
HTMLInputElement.prototype.click = function click() {
  if (this.type === 'file' && this.getAttribute('aria-label') === 'Add turf photos') {
    const transfer = new DataTransfer();
    transfer.items.add(placeholderFile());
    this.files = transfer.files;
    this.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  nativeClick.call(this);
};

// ── set the state up by tapping the real controls ──────────────────────────
async function until(find, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const found = find();
    if (found) return found;
    await wait(60);
  }
  return null;
}
const buttonLabeled = (text) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === text || b.getAttribute('aria-label') === text);
function typeInto(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function arrange() {
  if (STATE === 'start' || STATE === 'empty-products') return;
  if (STATE === 'photos') {
    for (const shot of ['Front overview', 'Back overview', 'Canopy close-up']) {
      const add = await until(() => { const b = buttonLabeled(`Add photo for ${shot}`); return b && !b.disabled ? b : null; });
      if (!add) return;
      add.click();
      await until(() => Array.from(document.querySelectorAll('li')).some((li) => li.textContent.includes(`${shot} (added)`)));
    }
    return;
  }
  const note = await until(() => document.querySelector('textarea'));
  if (note) typeInto(note, 'Treated the whole lawn. Thin turf along the sunny east edge, no chinch bugs found. Customer asked about the shaded corner by the oak.');
  if (STATE !== 'confirmed') return;
  const tip = await until(() => buttonLabeled('Mow high') || Array.from(document.querySelectorAll('button')).find((b) => b.textContent.startsWith('Mow high')));
  tip?.click();
  const search = await until(() => document.querySelector('input[type="search"]'));
  if (search) {
    typeInto(search, 'augustine');
    const post = await until(() => Array.from(document.querySelectorAll('button')).find((b) => b.textContent.startsWith('Why St. Augustine')), 4000);
    post?.click();
  }
}

function Preview() {
  const [closed, setClosed] = React.useState(null);
  React.useEffect(() => { arrange(); }, []);
  if (closed) {
    return (
      <main style={{ maxWidth: 480, margin: '0 auto', padding: '48px 16px', fontSize: 16 }}>
        <p>{closed}</p>
        <p><a href={window.location.href}>Open the sheet again</a></p>
      </main>
    );
  }
  return (
    <FastCompleteLawnSheet
      service={SERVICE}
      request={request}
      catalog={CATALOG}
      onClose={() => setClosed('Closed without completing.')}
      onCompleted={() => setClosed('Visit completed (preview: nothing was saved).')}
      onFullForm={() => setClosed('The server would open the full form for this visit.')}
    />
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Preview />);
