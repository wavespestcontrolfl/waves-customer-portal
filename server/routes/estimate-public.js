const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const smsTemplatesRouter = require('./admin-sms-templates');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');
const { shortenOrPassthrough } = require('../services/short-url');
const slotReservation = require('../services/slot-reservation');
const rateLimit = require('express-rate-limit');
const { generateEstimate } = require('../services/pricing-engine');
const { PEST, ONE_TIME } = require('../services/pricing-engine/constants');
const addonDefaults = require('../config/addon-defaults-by-frequency');

const WAVES_OFFICE_PHONE = '+19413187612';

// Map a one-time service name to the booking page's service id (matches PublicBookingPage SERVICES)
function bookingServiceFor(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('lawn') || n.includes('turf') || n.includes('aeration') || n.includes('seed') || n.includes('weed')) return { id: 'lawn_care', label: 'Lawn Care' };
  if (n.includes('mosquito')) return { id: 'mosquito', label: 'Mosquito Control' };
  if (n.includes('tree') || n.includes('shrub') || n.includes('palm') || n.includes('ornamental')) return { id: 'tree_shrub', label: 'Tree & Shrub Service' };
  if (n.includes('termite') || n.includes('wdo')) return { id: 'termite', label: 'Termite Inspection' };
  if (n.includes('rodent') || n.includes('rat') || n.includes('mouse')) return { id: 'rodent', label: 'Rodent Control' };
  return { id: 'pest_control', label: 'Pest Control' };
}

async function renderTemplate(templateKey, vars, fallback) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars);
      if (body) return body;
    }
  } catch { /* fall through */ }
  return fallback;
}

// ──────────────────────────────────────────────────────────────────
// Server-rendered customer estimate page
// ──────────────────────────────────────────────────────────────────

const BRAND = {
  blue: '#009CDE', blueDark: '#065A8C', blueDeeper: '#1B2C5B', blueLight: '#E3F5FD',
  yellow: '#FFD700', navy: '#0F172A', green: '#16A34A', red: '#C8102E',
  sand: '#FDF6EC', sandDark: '#F5EBD7',
};

// SSR top bar — phone on the LEFT, full Waves logo on the RIGHT. The
// logo is /waves-logo.png served from client/public so the static and
// React surfaces share the exact same artwork (and cache line).
function shellTopBar() {
  return `<header class="top-bar">
    <div class="top-bar-inner">
      <img src="/waves-logo.png" alt="Waves" class="top-logo"/>
      <a href="tel:+19412975749" class="top-phone">(941) 297-5749</a>
    </div>
  </header>`;
}

const TIER_DISCOUNTS = { Bronze: 0, Silver: 0.10, Gold: 0.15, Platinum: 0.18 };

// ── Service-preference pricing modifiers ──────────────────────
// Customers can opt out of interior spraying or exterior (eave/cobweb)
// sweeping. Each opt-out saves $10/visit on recurring pest control and
// $50 on a one-time pest treatment. Applied only when the estimate
// contains a recurring or one-time pest-control line.
const SERVICE_PREFS = {
  interior_spray:  { perVisit: 10, oneTime: 50, label: 'Interior spraying',  offDesc: 'No interior treatment — tech sprays and inspects the perimeter only.' },
  exterior_sweep:  { perVisit: 10, oneTime: 50, label: 'Exterior eave sweep', offDesc: 'No eave/cobweb sweep on the exterior. Tech still performs the perimeter treatment.' },
};
const SERVICE_PREF_KEYS = Object.keys(SERVICE_PREFS);
const DEFAULT_PREFS = SERVICE_PREF_KEYS.reduce((a, k) => (a[k] = true, a), {});

// Map a recurring frequency label → visits per year. Used to convert
// per-visit discount into the monthly-displayed discount so the
// estimator math stays honest (quarterly customers see $3.33/mo per
// toggle, monthly customers see $10/mo per toggle, etc.).
function visitsPerYearFromFrequency(freq) {
  const f = String(freq || '').toLowerCase().replace(/[-_\s]/g, '');
  if (f === 'monthly') return 12;
  if (f === 'bimonthly' || f === 'everyotherweek' || f === 'everyothermonth') return 6;
  if (f === 'quarterly' || f === '') return 4;
  if (f === 'semiannual' || f === 'biannual') return 2;
  if (f === 'annual' || f === 'yearly') return 1;
  return 4;
}

// How many pest-control recurring services are in this estimate + the
// lowest visit frequency among them. Returns null if there's no pest
// line at all (in which case we hide the prefs toggles entirely).
// `monthlyBase` is the sum of the pest line(s) monthly total before the
// preference toggles are applied — used together with the engine's
// PEST.floor to cap how much the toggles can discount.
function detectPestRecurring(recurring) {
  const pest = (recurring || []).filter((s) => /pest/i.test(String(s.name || '')));
  if (!pest.length) return null;
  const vpy = pest.reduce((acc, s) => Math.max(acc, visitsPerYearFromFrequency(s.frequency || s.billing || s.cadence)), 0) || 4;
  const monthlyBase = pest.reduce((acc, s) => acc + Number(s.mo || s.monthly || 0), 0);
  return { count: pest.length, visitsPerYear: vpy, monthlyBase };
}

function detectPestOneTime(oneTimeItems) {
  return (oneTimeItems || []).some((it) => /pest|ant|roach|wasp|stinging|exclusion/i.test(String(it.name || '')));
}

// Sum of one-time pest item prices on this estimate (matches the regex
// in detectPestOneTime). Used to clamp the one-time toggle discount
// above ONE_TIME.pest.floor.
function pestOneTimeBase(oneTimeItems) {
  return (oneTimeItems || [])
    .filter((it) => /pest|ant|roach|wasp|stinging|exclusion/i.test(String(it.name || '')))
    .reduce((acc, it) => acc + Number(it.price || 0), 0);
}

// Minimum monthly price for a recurring pest plan at the given cadence,
// derived from the engine's own floor rather than a chosen fraction.
// Mirrors service-pricing.js `pricePestControl`: basePrice is floored
// at PEST.floor, then multiplied by the cadence's frequency multiplier
// before being turned into a monthly. Defaults to v1 rates (the live
// shape for admin-created estimates); v2 multipliers are slightly
// gentler so falling back to v1 just makes the floor a touch lower,
// which is the safer direction.
function pestMonthlyFloor(visitsPerYear) {
  const freqKey = visitsPerYear >= 12 ? 'monthly'
                : visitsPerYear >= 6  ? 'bimonthly'
                : 'quarterly';
  const freqMult = PEST.frequencyDiscounts.v1?.[freqKey] ?? 1.0;
  return PEST.floor * freqMult * visitsPerYear / 12;
}

function normalizePrefs(raw) {
  const out = { ...DEFAULT_PREFS };
  if (raw && typeof raw === 'object') {
    for (const k of SERVICE_PREF_KEYS) {
      if (k in raw) out[k] = raw[k] !== false;
    }
  }
  return out;
}

// Compute the monthly + one-time discount for a given set of prefs.
// Returns { monthlyOff, oneTimeOff } in dollars (positive numbers).
// Clamps so the remaining pest price never drops below the engine's
// own floors (PEST.floor for recurring per-visit, ONE_TIME.pest.floor
// for one-time). Without the clamp, a small pest estimate could be
// dragged to $0 via the toggles.
function computePrefDiscount(prefs, pestRecurring, hasPestOneTime, pestOneTimeTotal = 0) {
  let monthlyOff = 0;
  let oneTimeOff = 0;
  const p = normalizePrefs(prefs);
  for (const k of SERVICE_PREF_KEYS) {
    if (p[k] === false) {
      if (pestRecurring) {
        // $perVisit × visits/yr ÷ 12 = monthly-equivalent discount
        monthlyOff += (SERVICE_PREFS[k].perVisit * pestRecurring.visitsPerYear) / 12;
      }
      if (hasPestOneTime) {
        oneTimeOff += SERVICE_PREFS[k].oneTime;
      }
    }
  }
  if (pestRecurring) {
    const floor = pestMonthlyFloor(pestRecurring.visitsPerYear);
    const pestMonthlyBase = Number(pestRecurring.monthlyBase || 0);
    const maxMonthlyOff = Math.max(0, pestMonthlyBase - floor);
    monthlyOff = Math.min(monthlyOff, maxMonthlyOff);
  }
  if (pestOneTimeTotal > 0) {
    const maxOneTimeOff = Math.max(0, pestOneTimeTotal - ONE_TIME.pest.floor);
    oneTimeOff = Math.min(oneTimeOff, maxOneTimeOff);
  }
  return {
    monthlyOff: Math.round(monthlyOff * 100) / 100,
    oneTimeOff: Math.round(oneTimeOff * 100) / 100,
  };
}

const PERKS = [
  'Priority scheduling — you jump the queue',
  'Re-service between visits at no charge',
  'Locked-in pricing for 24 months',
  'Free annual termite inspection',
  '15% off any one-time treatment',
  'Senior / military / first-responder discount stacking',
  'One point of contact — no call-center runaround',
  'Text your tech directly for quick questions',
  'Owner-operator accountability on every visit',
];

// Canonical SWFL stores — name, physical address, ZIPs, spoke page slug
// on wavespestcontrol.com, and Google Place ID for map links. Mirrors
// server/config/locations.js but kept inline so the SSR estimate page
// stays self-contained (no require cycle at render time).
const LOCATIONS = [
  { name: 'Lakewood Ranch', address: '13649 Luxe Ave #110, Bradenton, FL 34211', phone: '(941) 318-7612', phoneRaw: '+19413187612', slug: 'pest-control-bradenton-fl', placeId: 'ChIJVbBOKGYyTCgRVFz8_lu61Mw' },
  { name: 'Parrish',        address: '5155 115th Dr E, Parrish, FL 34219',       phone: '(941) 297-2817', phoneRaw: '+19412972817', slug: 'pest-control-parrish-fl',   placeId: 'ChIJM32aQRIlw4gRr7goqhbAVpw' },
  { name: 'Sarasota',       address: '1450 Pine Warbler Pl, Sarasota, FL 34240', phone: '(941) 297-2606', phoneRaw: '+19412972606', slug: 'pest-control-sarasota-fl',  placeId: 'ChIJeT_63_Y5w4gRGTNLozgSmdw' },
  { name: 'Venice',         address: '1978 S Tamiami Trl #10, Venice, FL 34293', phone: '(941) 297-3337', phoneRaw: '+19412973337', slug: 'pest-control-venice-fl',    placeId: 'ChIJ81vmrblZw4gRREDmlDUpq0E' },
];

// Footer — company contact + social profiles. Kept in one place so the
// estimate footer and (future) other SSR customer surfaces share exactly
// one source.
const COMPANY = {
  legalName: 'Waves Pest Control, LLC',
  phone: '(941) 297-5749',
  phoneRaw: '+19412975749',
  email: 'contact@wavespestcontrol.com',
};

const SOCIAL_LINKS = [
  { name: 'Facebook',  url: 'https://facebook.com/wavespestcontrol',  path: 'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z' },
  { name: 'Instagram', url: 'https://instagram.com/wavespestcontrol', path: 'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12s.014 3.668.072 4.948c.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24s3.668-.014 4.948-.072c4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948s-.014-3.667-.072-4.947c-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z' },
  { name: 'YouTube',   url: 'https://youtube.com/@wavespestcontrol',  path: 'M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z' },
  { name: 'TikTok',    url: 'https://tiktok.com/@wavespestcontrol',   path: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z' },
  { name: 'X',         url: 'https://x.com/wavespest',                path: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z' },
];

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtMoney(n) {
  const v = Math.round(Number(n || 0) * 100) / 100;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function renderExpiredPage(estimate) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Estimate Expired — Waves</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:Inter,system-ui,sans-serif;background:#FAF8F3;color:#1B2C5B;min-height:100vh;display:flex;flex-direction:column}
  .top-bar{background:#fff;border-bottom:1px solid #E7E2D7}
  .top-bar-inner{max-width:960px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:16px 24px}
  .top-phone{color:#1B2C5B;font-size:15px;font-weight:500;text-decoration:none}
  .top-logo{height:28px;display:block}
  .wrap{flex:1;display:flex;align-items:center;justify-content:center;padding:40px 24px}
  .box{max-width:560px;background:#fff;border-radius:14px;padding:40px;text-align:center;border:1px solid #E7E2D7}
  h1{font-family:'Source Serif 4','Source Serif Pro',Georgia,serif;font-weight:500;letter-spacing:-0.01em;font-size:32px;margin:0 0 12px;color:#1B2C5B}
  p{line-height:1.6;color:#3F4A65}
  a.btn{display:inline-block;margin-top:16px;padding:12px 22px;background:#1B2C5B;color:#fff;text-decoration:none;border-radius:8px;font-weight:500}
</style>
</head><body>
${shellTopBar()}
<div class="wrap"><div class="box">
  <h1>This estimate has expired</h1>
  <p>Hi ${escapeHtml((estimate.customerName || '').split(' ')[0] || 'there')} — the estimate for <strong>${escapeHtml(estimate.address || 'your property')}</strong> is no longer active. Give us a call and we'll put together a fresh one.</p>
  <a class="btn" href="tel:+19412975749">Call (941) 297-5749</a>
</div></div>
</body></html>`;
}


function renderPage(token, estimate, estData) {
  const est = estimate;
  const tier = est.tier || 'Bronze';
  const firstName = escapeHtml((est.customerName || '').split(' ')[0] || 'there');
  const fullName = escapeHtml(est.customerName || '');
  const address = escapeHtml(est.address || '');

  const estResult = estData?.result || estData || {};
  const recurring = estResult?.recurring?.services || [];
  const oneTimeItems = [...(estResult?.oneTime?.items || []), ...(estResult?.oneTime?.specItems || [])];
  const baseMonthly = Number(estData?.baseMonthly || estData?.preDiscountMonthly || (recurring.reduce((s, x) => s + Number(x.mo || x.monthly || 0), 0)) || est.monthlyTotal || 0);

  const pestRecurring = detectPestRecurring(recurring);
  const hasPestOneTime = detectPestOneTime(oneTimeItems);
  const pestOneTimeTotal = hasPestOneTime ? pestOneTimeBase(oneTimeItems) : 0;
  const showPrefs = !!(pestRecurring || hasPestOneTime);
  const prefs = normalizePrefs(estData?.preferences);
  const { monthlyOff: prefMonthlyOff, oneTimeOff: prefOneTimeOff } = computePrefDiscount(prefs, pestRecurring, hasPestOneTime, pestOneTimeTotal);

  const tierPrices = {};
  ['Bronze', 'Silver', 'Gold', 'Platinum'].forEach((t) => {
    tierPrices[t] = Math.max(0, Math.round((baseMonthly * (1 - TIER_DISCOUNTS[t]) - prefMonthlyOff) * 100) / 100);
  });

  const monthlyTotal = Math.max(0, Number(est.monthlyTotal || 0) - prefMonthlyOff);
  const annualTotal = Math.max(0, Number(est.annualTotal || monthlyTotal * 12) - prefMonthlyOff * 12);
  const onetimeTotal = Math.max(0, Number(est.onetimeTotal || 0) - prefOneTimeOff);
  const locked = est.status === 'accepted';

  const savingsPerMo = Math.max(0, Math.round((baseMonthly - monthlyTotal) * 100) / 100);
  const dayPrice = Math.round((monthlyTotal / 30) * 100) / 100;

  const inputs = estData?.inputs || {};
  const homeSqFt = Number(inputs.homeSqFt) || Number(estResult?.property?.footprint * (Number(inputs.stories) || 1)) || null;
  const lotSqFt = Number(inputs.lotSqFt) || Number(estResult?.property?.lotSqFt) || null;
  const hasLawn = recurring.some((s) => String(s.name || '').toLowerCase().includes('lawn'));
  const lawnSqFt = hasLawn ? (Number(inputs.lawnSqFt) || Number(estResult?.property?.lawnSqFt) || null) : null;
  const propertyLine = [
    homeSqFt ? `${Math.round(homeSqFt).toLocaleString()} sq ft home` : null,
    lotSqFt ? `${Math.round(lotSqFt).toLocaleString()} sq ft lot` : null,
    lawnSqFt ? `${Math.round(lawnSqFt).toLocaleString()} sq ft treatable lawn` : null,
  ].filter(Boolean).join(' \u00B7 ');

  // Bundle upsell ladder:
  //   1 svc  → offer the complementary one  → Silver (10%)
  //   2 svc  → offer Mosquito if missing    → Gold   (15%)
  //   3+ svc → no upsell                    → already Gold+/Platinum
  // Future-proof: the "next tier" copy comes from the service count
  // after adding, not a hardcoded string.
  const recurringNames = recurring.map((s) => String(s.name || '').toLowerCase());
  const hasName = (needle) => recurringNames.some((n) => n.includes(needle));

  let upsellService = null;
  if (recurring.length === 1) {
    upsellService = recurring[0].name === 'Pest Control' ? 'Lawn Care' : 'Pest Control';
  } else if (recurring.length === 2 && !hasName('mosquito')) {
    upsellService = 'WaveGuard Mosquito';
  }
  const showUpsell = !!upsellService;

  const nextTierCount = recurring.length + 1;
  const nextTierName = nextTierCount >= 4 ? 'Platinum' : nextTierCount === 3 ? 'Gold' : 'Silver';
  const nextTierPct = nextTierCount >= 4 ? 20 : nextTierCount === 3 ? 15 : 10;

  const recurringRows = recurring.map((s) => {
    const mo = Number(s.mo || s.monthly || 0);
    const discounted = Math.round(mo * (1 - TIER_DISCOUNTS[tier]) * 100) / 100;
    return `<tr><td>${escapeHtml(s.name)}</td><td style="text-align:right">${fmtMoney(discounted)}/mo</td></tr>`;
  }).join('');

  // WaveGuard Membership — $99 initial fee rolled into oneTimeTotal by the
  // pricing engine but not into oneTime.items[]. Surface it as its own
  // line so the customer sees what the fee is and the "waived with annual
  // prepayment" note explains how to skip it.
  const membershipFee = Number(estResult?.oneTime?.membershipFee || 0);
  const membershipRow = membershipFee > 0
    ? `<tr><td>WaveGuard Membership<div class="sub">Waived if you prepay 12 months up front</div></td><td style="text-align:right">${fmtMoney(membershipFee)}</td></tr>`
    : '';

  const oneTimeRows = membershipRow + oneTimeItems.map((it) => {
    const price = Number(it.price || 0);
    if (price <= 0) return '';
    return `<tr><td>${escapeHtml(it.name)}${it.detail ? `<div class="sub">${escapeHtml(it.detail)}</div>` : ''}</td><td style="text-align:right">${fmtMoney(price)}</td></tr>`;
  }).filter(Boolean).join('');

  const perksHtml = PERKS.map((p) => `<li>${escapeHtml(p)}</li>`).join('');
  const locationsHtml = LOCATIONS.map((l) => {
    const sitePage = `https://www.wavespestcontrol.com/${l.slug}/`;
    const mapsUrl = `https://www.google.com/maps/place/?q=place_id:${l.placeId}`;
    return `<div class="loc">
      <a class="loc-name" href="${sitePage}" target="_blank" rel="noopener">Waves Pest Control ${escapeHtml(l.name)}</a>
      <a class="loc-addr" href="${mapsUrl}" target="_blank" rel="noopener">${escapeHtml(l.address)}</a>
      <a class="loc-phone" href="tel:${l.phoneRaw}">${escapeHtml(l.phone)}</a>
      <div class="loc-hours">Open 24 hours</div>
    </div>`;
  }).join('');
  const socialsHtml = SOCIAL_LINKS.map((s) => `<a class="soc" href="${s.url}" target="_blank" rel="noopener" aria-label="${escapeHtml(s.name)}"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="${s.path}"/></svg></a>`).join('');

  // ── Waves AI analysis block ────────────────────────────────────
  // Shows satellite image of the home plus four property measurements:
  // home sq ft, lot sq ft, treatable lawn area (lawn only), and landscape
  // complexity. The complexity signal comes from the AI vision analyzer
  // (SIMPLE / MODERATE / COMPLEX) and falls back to property inputs.
  const satelliteUrl = est.satelliteUrl || null;
  const aiAnalysis = estData?.aiAnalysis || estResult?.aiAnalysis || {};
  const complexityRaw = aiAnalysis.landscape_complexity || estResult?.property?.landscapeComplexity || inputs.landscapeComplexity || null;
  const complexityPretty = complexityRaw
    ? String(complexityRaw).charAt(0).toUpperCase() + String(complexityRaw).slice(1).toLowerCase()
    : null;
  const aiMetricsArr = [
    homeSqFt ? { label: 'Home', val: `${Math.round(homeSqFt).toLocaleString()} sq ft` } : null,
    lotSqFt ? { label: 'Lot', val: `${Math.round(lotSqFt).toLocaleString()} sq ft` } : null,
    lawnSqFt ? { label: 'Treatable lawn', val: `${Math.round(lawnSqFt).toLocaleString()} sq ft` } : null,
    complexityPretty ? { label: 'Complexity', val: complexityPretty } : null,
  ].filter(Boolean);
  const hasAiBlock = !!(satelliteUrl || aiMetricsArr.length);
  const aiEngineBlurb = "Our estimator reads your property from satellite, cross-checks it against public records, and tunes your quote to the exact footprint we see — so what you pay matches what we actually treat.";
  const aiBlockHtml = hasAiBlock ? `
  <section class="card ai-card">
    <div class="eyebrow">Waves AI analysis</div>
    <h2>Here's what we found at your property</h2>
    <p class="ai-blurb">${escapeHtml(aiEngineBlurb)}</p>
    ${satelliteUrl ? `<img class="ai-satellite" src="${escapeHtml(satelliteUrl)}" alt="Satellite view of ${address}" loading="lazy"/>` : ''}
    ${aiMetricsArr.length ? `<div class="ai-grid">
      ${aiMetricsArr.map((m) => `<div class="ai-metric"><div class="ai-metric-label">${escapeHtml(m.label)}</div><div class="ai-metric-val">${escapeHtml(m.val)}</div></div>`).join('')}
    </div>` : ''}
  </section>` : '';

  // ── Service-prefs toggle card (only when estimate has a pest line) ────
  function renderPrefRow(key) {
    const cfg = SERVICE_PREFS[key];
    const on = prefs[key] !== false;
    // Per-row "if you toggle this off, you save …" label
    let savingsLabel = '';
    if (pestRecurring && hasPestOneTime) {
      const rec = (cfg.perVisit * pestRecurring.visitsPerYear) / 12;
      savingsLabel = `Save ${fmtMoney(Math.round(rec * 100) / 100)}/mo + ${fmtMoney(cfg.oneTime)} on one-time`;
    } else if (pestRecurring) {
      const rec = (cfg.perVisit * pestRecurring.visitsPerYear) / 12;
      savingsLabel = `Save ${fmtMoney(Math.round(rec * 100) / 100)}/mo`;
    } else if (hasPestOneTime) {
      savingsLabel = `Save ${fmtMoney(cfg.oneTime)}`;
    }
    return `
    <div class="pref-row${on ? '' : ' off'}" data-pref-row="${key}">
      <div class="pref-label">
        <div class="pref-title">${escapeHtml(cfg.label)} included</div>
        <div class="pref-desc" data-pref-desc>${on ? 'Toggle off if you want to skip this.' : escapeHtml(cfg.offDesc)}</div>
        <div class="pref-savings${on ? '' : ' none'}" data-pref-savings>${on ? escapeHtml(savingsLabel) : 'Applied to your estimate'}</div>
      </div>
      <label class="switch" title="${escapeHtml(cfg.label)}">
        <input type="checkbox" ${on ? 'checked' : ''} ${locked ? 'disabled' : ''} data-pref-key="${key}"/>
        <span class="slider"></span>
      </label>
    </div>`;
  }
  const prefsBlockHtml = showPrefs ? `
  <section class="card prefs-card">
    <div class="eyebrow">Customize your visit</div>
    <h2>Skip parts you don't need</h2>
    <p class="card-sub">Both are on by default. Toggle off whatever you don't want and the price adjusts instantly.</p>
    <div class="prefs-list">
      ${SERVICE_PREF_KEYS.map(renderPrefRow).join('')}
    </div>
  </section>` : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Your Waves Estimate</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:Inter,system-ui,sans-serif;background:#FAF8F3;color:#1B2C5B;line-height:1.55;min-height:100vh;display:flex;flex-direction:column}
  h1,h2,h3{font-family:'Source Serif 4','Source Serif Pro',Georgia,serif;font-weight:500;letter-spacing:-0.01em;margin:0 0 12px;color:#1B2C5B}
  h1{font-size:clamp(32px,5vw,44px);line-height:1.1}
  h2{font-size:clamp(22px,3vw,28px);line-height:1.2}
  h3{font-size:18px;font-weight:600}
  p{margin:0 0 12px}
  .eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:11px;color:#6B7280;font-weight:600;margin-bottom:6px;font-family:Inter,system-ui,sans-serif}
  .top-bar{background:#fff;border-bottom:1px solid #E7E2D7}
  .top-bar-inner{max-width:960px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:16px 24px}
  .top-phone{color:#1B2C5B;font-size:15px;font-weight:500;text-decoration:none}
  .top-phone:hover{color:${BRAND.blueDark}}
  .top-logo{height:28px;display:block}
  .wrap{flex:1;max-width:720px;width:100%;margin:0 auto;padding:32px 20px 64px}
  .hero{padding:8px 0 24px}
  .hero .addr{color:#3F4A65;font-size:15px;margin-top:4px}
  .hero .prop-meta{color:#6B7280;font-size:13px;margin-top:2px}
  .big-price{display:flex;align-items:baseline;gap:10px;margin-top:20px;flex-wrap:wrap}
  .big-price .anchor{font-family:'Source Serif 4',Georgia,serif;font-size:22px;color:#9CA3AF;text-decoration:line-through}
  .big-price .num{font-family:'Source Serif 4',Georgia,serif;font-weight:500;font-size:52px;line-height:1;color:#1B2C5B}
  .big-price .per{font-size:18px;color:#6B7280}
  .big-price .tier-lbl{display:inline-block;padding:4px 10px;border-radius:6px;background:#EEF2FF;color:#1B2C5B;font-weight:600;font-size:12px;letter-spacing:.04em}
  .save-row{margin-top:10px}
  .save-pill{display:inline-block;color:${BRAND.green};font-size:13px;font-weight:600}
  .day-price{margin-top:8px;font-size:14px;color:#6B7280}
  .mini-guarantee{margin-top:10px;font-size:13px;color:#1B2C5B}
  .card{background:#fff;border-radius:14px;padding:24px;margin-bottom:16px;border:1px solid #E7E2D7}
  .card h2{margin:0 0 6px}
  .card h3{margin:0 0 10px}
  .card-sub{color:#6B7280;font-size:14px;margin:0 0 14px}
  .ai-card{background:linear-gradient(180deg,#F5F1E6 0%,#fff 100%)}
  .ai-blurb{margin:0 0 14px;color:#3F4A65;font-size:14px;line-height:1.55}
  .ai-satellite{display:block;width:100%;max-height:320px;object-fit:cover;border-radius:10px;border:1px solid #E7E2D7;margin-top:0;background:#F7F5EE}
  .ai-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:14px}
  @media(max-width:720px){.ai-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  .ai-metric{background:#fff;border:1px solid #E7E2D7;border-radius:10px;padding:10px 12px}
  .ai-metric-label{font-size:11px;color:#6B7280;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
  .ai-metric-val{font-family:'Source Serif 4',Georgia,serif;font-size:18px;font-weight:500;color:#1B2C5B}
  .prefs-card h2{margin-bottom:4px}
  .prefs-list{margin-top:14px;display:flex;flex-direction:column;gap:10px}
  .pref-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:14px;background:#fff;border:1px solid #E7E2D7;border-radius:10px;transition:all .15s}
  .pref-row.off{background:#F7F5EE;border-color:#D4CBB8}
  .pref-row .pref-label{flex:1;min-width:0}
  .pref-row .pref-title{font-weight:600;font-size:14px;color:#1B2C5B}
  .pref-row .pref-desc{font-size:12px;color:#6B7280;margin-top:2px;line-height:1.5}
  .pref-row .pref-savings{font-size:12px;color:${BRAND.green};font-weight:600;margin-top:4px}
  .pref-row .pref-savings.none{color:#9CA3AF;font-weight:500}
  .switch{position:relative;display:inline-block;width:42px;height:24px;flex-shrink:0;margin-top:2px}
  .switch input{opacity:0;width:0;height:0}
  .switch .slider{position:absolute;cursor:pointer;inset:0;background:#D4CBB8;border-radius:24px;transition:.2s}
  .switch .slider::before{content:'';position:absolute;height:18px;width:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 1px 2px rgba(0,0,0,.15)}
  .switch input:checked+.slider{background:#1B2C5B}
  .switch input:checked+.slider::before{transform:translateX(18px)}
  .switch input:disabled+.slider{opacity:.5;cursor:not-allowed}
  .booking-card h2{margin-bottom:4px}
  .booking-state{padding:14px;border:1px dashed #E7E2D7;border-radius:10px;background:#F7F5EE;font-size:13px;color:#6B7280;text-align:center}
  .slot-list{display:flex;flex-direction:column;gap:8px;margin-top:12px}
  .slot-btn{background:#fff;border:2px solid #E7E2D7;border-radius:10px;padding:12px 14px;text-align:left;cursor:pointer;font:inherit;color:inherit;transition:border-color .15s,background .15s;display:flex;flex-direction:column;gap:2px;width:100%}
  .slot-btn:hover:not([disabled]){border-color:${BRAND.blueDark}}
  .slot-btn.selected{border-color:#1B2C5B;background:#F7F5EE}
  .slot-btn .slot-day{font-size:14px;font-weight:600;color:#1B2C5B}
  .slot-btn .slot-window{font-size:13px;color:#3F4A65}
  .slot-btn .slot-tag{display:inline-block;margin-top:4px;padding:2px 8px;border-radius:999px;background:rgba(22,163,74,0.1);color:${BRAND.green};font-size:11px;font-weight:600;align-self:flex-start}
  .slot-more{background:transparent;border:none;color:#1B2C5B;font:inherit;font-size:13px;font-weight:500;text-decoration:underline;cursor:pointer;padding:8px 0;align-self:flex-start}
  .pay-pref-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:14px}
  @media(max-width:560px){.pay-pref-grid{grid-template-columns:1fr}}
  .pay-pref-btn{background:#fff;border:2px solid #E7E2D7;border-radius:10px;padding:14px;text-align:left;cursor:pointer;font:inherit;color:inherit;transition:border-color .15s,background .15s;display:flex;flex-direction:column;gap:4px}
  .pay-pref-btn:hover:not([disabled]){border-color:${BRAND.blueDark}}
  .pay-pref-btn[disabled]{opacity:.5;cursor:not-allowed}
  .pay-pref-btn .pay-pref-title{font-size:14px;font-weight:600;color:#1B2C5B}
  .pay-pref-btn .pay-pref-sub{font-size:12px;color:#6B7280;line-height:1.45}
  .pay-pref-btn.primary{background:#1B2C5B;color:#fff;border-color:#1B2C5B}
  .pay-pref-btn.primary .pay-pref-title{color:#fff}
  .pay-pref-btn.primary .pay-pref-sub{color:rgba(255,255,255,.8)}
  .reservation-banner{background:#ECFDF5;border:1px solid ${BRAND.green};color:#065F46;border-radius:10px;padding:12px 14px;font-size:13px;margin-top:12px;display:flex;align-items:center;justify-content:space-between;gap:10px}
  .reservation-banner .countdown{font-family:'Source Serif 4',Georgia,serif;font-weight:500;color:#065F46;font-size:15px}
  table{width:100%;border-collapse:collapse}
  td{padding:10px 0;border-bottom:1px solid #E7E2D7;vertical-align:top;font-size:14px}
  tr:last-child td{border-bottom:0}
  td.val{text-align:right;font-weight:500;color:#1B2C5B}
  .sub{font-size:12px;color:#6B7280;margin-top:2px}
  .cta{display:block;width:100%;padding:14px 22px;background:#1B2C5B;color:#fff;border:none;border-radius:10px;font-family:Inter,system-ui,sans-serif;font-weight:500;font-size:16px;cursor:pointer;transition:all .15s;text-align:center;text-decoration:none}
  .cta:hover:not([disabled]){background:#121E3D}
  .cta.secondary{background:transparent;color:#1B2C5B;border:1px solid #1B2C5B}
  .cta[disabled]{opacity:.6;cursor:not-allowed}
  .upsell{background:#F7F5EE;border:1px solid #E7E2D7;border-radius:12px;padding:18px;margin-bottom:16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;cursor:pointer;transition:background .15s,border-color .15s;width:100%;text-align:left;font:inherit;color:inherit;-webkit-tap-highlight-color:rgba(27,44,91,.12)}
  .upsell:hover{background:#F2EEE0;border-color:#D9D3C4}
  .upsell:active{background:#EDE8D8}
  .upsell:disabled{opacity:.7;cursor:wait}
  .upsell .txt{flex:1;min-width:200px}
  .upsell h3{color:#1B2C5B;margin:0 0 4px}
  .upsell-btn{background:#1B2C5B;color:#fff;padding:12px 20px;border-radius:8px;border:none;font-weight:500;cursor:pointer;font-size:14px;min-height:44px;pointer-events:none}
  @media(max-width:520px){.upsell-btn{width:100%}}
  .perks-list{list-style:none;padding:0;margin:0;columns:2;column-gap:20px}
  @media(max-width:640px){.perks-list{columns:1}}
  .perks-list li{padding:6px 0 6px 24px;position:relative;break-inside:avoid;font-size:14px;color:#3F4A65}
  .perks-list li::before{content:'✓';position:absolute;left:0;color:${BRAND.green};font-weight:600}
  .review-carousel{background:#F7F5EE;border-radius:10px;padding:22px;min-height:170px;position:relative;border:1px solid #E7E2D7}
  .review-slide .stars{color:${BRAND.yellow};font-size:16px;margin-bottom:10px;letter-spacing:1px}
  .review-slide p{font-size:14px;margin:0 0 12px;font-style:italic;line-height:1.55;color:#3F4A65}
  .rev-meta{font-size:12px;color:#6B7280}
  .review-dots{display:flex;justify-content:center;gap:6px;margin-top:14px}
  .review-dots button{width:7px;height:7px;border-radius:50%;border:none;background:#D4CBB8;cursor:pointer;padding:0;transition:all .2s}
  .review-dots button.active{background:#1B2C5B;width:18px;border-radius:4px}
  .review-slide{transition:opacity .3s}
  .review-slide.fade{opacity:0}
  .reviews-header{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:13px;color:#1B2C5B;font-weight:600}
  .reviews-header .stars{color:${BRAND.yellow};letter-spacing:1px;font-size:14px}
  .locs{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:14px}
  @media(max-width:560px){.locs{grid-template-columns:1fr}}
  .loc{background:#F7F5EE;border:1px solid #E7E2D7;border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:4px}
  .loc .loc-name{color:#1B2C5B;font-size:14px;font-weight:600;text-decoration:none}
  .loc .loc-name:hover{text-decoration:underline}
  .loc .loc-addr{color:#3F4A65;font-size:12px;text-decoration:none;line-height:1.4}
  .loc .loc-addr:hover{text-decoration:underline}
  .loc .loc-phone{color:#1B2C5B;font-size:13px;font-weight:500;text-decoration:none}
  .loc .loc-phone:hover{text-decoration:underline}
  .loc .loc-hours{color:${BRAND.green};font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em}
  .final{background:#1B2C5B;color:#fff;text-align:center;padding:32px 24px;border-radius:14px;border:1px solid #1B2C5B}
  .final h2{color:#fff;margin:0 0 8px}
  .final p{color:rgba(255,255,255,.8);font-size:14px}
  .accepted-banner{background:#ECFDF5;border:1px solid ${BRAND.green};color:${BRAND.green};text-align:center;padding:12px 16px;border-radius:10px;margin-bottom:16px;font-weight:500;font-size:14px}
  .site-footer{text-align:center;padding:40px 20px 32px;color:#6B7280;font-size:12px;border-top:1px solid #E7E2D7;background:#FAF8F3;margin:32px -20px -64px}
  .site-footer-socials{display:flex;justify-content:center;gap:12px;margin-bottom:16px}
  .site-footer-socials .soc{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;background:#F7F5EE;border:1px solid #E7E2D7;color:#1B2C5B;transition:all .15s}
  .site-footer-socials .soc:hover{background:#1B2C5B;color:#fff;border-color:#1B2C5B}
  .site-footer-contact{margin-bottom:10px;font-size:13px;color:#3F4A65}
  .site-footer-contact a{color:#1B2C5B;text-decoration:none;font-weight:500}
  .site-footer-contact a:hover{text-decoration:underline}
  .site-footer-contact .dot{margin:0 8px;color:#9CA3AF}
  .site-footer-legal{font-size:11px;color:#6B7280}
  #toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1B2C5B;color:#fff;padding:12px 20px;border-radius:8px;font-size:14px;opacity:0;pointer-events:none;transition:opacity .2s;z-index:100}
  #toast.show{opacity:1}
</style>
</head><body>

${shellTopBar()}

<div class="wrap">

  ${locked ? `<div class="accepted-banner">✓ You\u2019ve accepted this estimate — we\u2019ll be in touch shortly.</div>` : ''}

  <div class="hero">
    <div class="eyebrow">Your estimate · WaveGuard ${escapeHtml(tier)}</div>
    <h1>Hey ${firstName}, here\u2019s your custom plan.</h1>
    <div class="addr">${address}</div>
    ${propertyLine ? `<div class="prop-meta">${escapeHtml(propertyLine)}</div>` : ''}
    <div class="big-price">
      ${savingsPerMo > 0 ? `<span class="anchor" id="anchor-display">${fmtMoney(baseMonthly)}/mo</span>` : ''}
      <span class="num" id="monthly-display">${fmtMoney(monthlyTotal)}</span>
      <span class="per">/mo</span>
      <span class="tier-lbl" id="tier-display">WaveGuard ${escapeHtml(tier)}</span>
    </div>
    <div class="save-row"${savingsPerMo > 0 ? '' : ' style="display:none"'}>
      <span class="save-pill">You save <span id="savings-display">${fmtMoney(savingsPerMo)}</span>/mo with WaveGuard <span id="savings-tier">${escapeHtml(tier)}</span></span>
    </div>
    <div class="day-price">That\u2019s just <span id="day-price">${fmtMoney(dayPrice)}</span>/day for complete home protection.</div>
    <div class="mini-guarantee">Try us risk-free \u2014 90-day money-back guarantee.</div>
  </div>

  ${aiBlockHtml}

  ${prefsBlockHtml}

  ${showUpsell ? `
  <button type="button" class="upsell" onclick="inquireBundle('${escapeHtml(upsellService)}')" aria-label="Get a bundle quote for ${escapeHtml(upsellService)}">
    <span class="txt">
      <h3>Add ${escapeHtml(upsellService)} and save more</h3>
      <div style="font-size:14px">Bundling unlocks ${escapeHtml(nextTierName)} tier pricing (${nextTierPct}% off everything). Curious what that looks like?</div>
    </span>
    <span class="upsell-btn">Get a bundle quote</span>
  </button>` : ''}

  ${locked ? '' : `
  <section class="card booking-card" id="booking-card">
    <div class="eyebrow">Pick a time</div>
    <h2>Reserve your first visit</h2>
    <p class="card-sub">The 3 times below fit the tech route closest to you. We will hold your pick for 15 minutes while you confirm.</p>
    <div id="slot-area" class="booking-state">Loading available times...</div>
    <div id="pay-pref-area" style="display:none">
      <h3 style="margin:20px 0 4px">How would you like to pay?</h3>
      <p class="card-sub" style="margin:0">Both options reserve your slot. You will not be charged until you confirm on the next screen.</p>
      <div class="pay-pref-grid">
        <button type="button" class="pay-pref-btn primary" data-pay-pref="deposit_now"><span class="pay-pref-title">Deposit now with card</span><span class="pay-pref-sub">Secure your slot with a small card-on-file deposit. Pay the rest at the visit.</span></button>
        <button type="button" class="pay-pref-btn" data-pay-pref="pay_at_visit"><span class="pay-pref-title">Pay at the visit</span><span class="pay-pref-sub">We will collect payment with the tech on-site. No card needed now.</span></button>
      </div>
    </div>
    <div id="review-area" style="display:none">
      <div class="reservation-banner"><span>Slot held for you</span><span class="countdown" id="reservation-countdown">15:00</span></div>
      <div class="pay-pref-grid">
        <button type="button" class="pay-pref-btn primary" id="confirm-book-btn" onclick="confirmBooking()"><span class="pay-pref-title" id="confirm-book-title">Confirm and pay deposit</span><span class="pay-pref-sub" id="confirm-book-sub">You will be taken to a secure Stripe page to complete the deposit.</span></button>
        <button type="button" class="pay-pref-btn" onclick="cancelReservation()"><span class="pay-pref-title">Change my pick</span><span class="pay-pref-sub">Release this slot and choose a different time or payment option.</span></button>
      </div>
    </div>
  </section>
  `}

  ${oneTimeRows ? `
  <div class="card" style="margin-top:24px">
    <h3>One-time items (billed separately)</h3>
    <table>${oneTimeRows}
      <tr><td><strong>One-time total</strong></td><td style="text-align:right"><strong>${fmtMoney(onetimeTotal)}</strong></td></tr>
    </table>
    <p style="font-size:13px;opacity:.65;margin:12px 0 0">These are scheduled after your recurring service starts. The WaveGuard member rate includes 15% off any one-time treatment.</p>
  </div>` : ''}

  <div class="card">
    <h2>What WaveGuard members get</h2>
    <ul class="perks-list">${perksHtml}</ul>
  </div>

  <div class="card">
    <h2>What your neighbors are saying</h2>
    <div class="review-carousel" id="review-carousel">
      <div class="review-slide" id="review-slide">
        <div class="stars">\u2605\u2605\u2605\u2605\u2605</div>
        <p id="review-body" style="min-height:80px">Loading reviews from our customers\u2026</p>
        <div class="rev-meta" id="review-meta"></div>
      </div>
      <div class="review-dots" id="review-dots"></div>
    </div>
  </div>

  <div class="card">
    <div class="reviews-header">
      <span class="stars">&#9733;&#9733;&#9733;&#9733;&#9733;</span>
      <span>5-star rated across every local Google profile</span>
    </div>
    <div class="locs">${locationsHtml}</div>
  </div>

  <div class="final">
    <h2>Ready to lock in <span data-monthly-echo>${fmtMoney(monthlyTotal)}</span>/mo?</h2>
    <p>No surprise increases, no hidden fees.</p>
    ${locked ? '' : `<button class="cta" style="max-width:360px;margin:16px auto 0;background:#fff;color:#1B2C5B" onclick="document.getElementById('booking-card')?.scrollIntoView({behavior:'smooth',block:'start'})">Pick a time and book</button>`}
    <div style="margin-top:20px;font-size:14px">
      Questions? Call <a href="tel:+19412975749" style="color:#fff;font-weight:700">(941) 297-5749</a>
    </div>
  </div>

  <footer class="site-footer">
    <div class="site-footer-socials">${socialsHtml}</div>
    <div class="site-footer-contact">
      <a href="mailto:${COMPANY.email}">${COMPANY.email}</a>
      <span class="dot">&middot;</span>
      <a href="tel:${COMPANY.phoneRaw}">${COMPANY.phone}</a>
    </div>
    <div class="site-footer-legal">&copy; ${new Date().getFullYear()} ${COMPANY.legalName}. All rights reserved.</div>
  </footer>
</div>

<div id="toast"></div>

<script>
  const TOKEN = ${JSON.stringify(token)};
  const API = '/api/estimates/' + TOKEN;
  const fmt = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const toast = (msg) => { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2800); };

  // Service-preferences toggles — PUT /:token/preferences and refresh totals.
  document.querySelectorAll('[data-pref-key]').forEach((input) => {
    input.addEventListener('change', async (ev) => {
      const key = ev.target.dataset.prefKey;
      const next = !!ev.target.checked;
      ev.target.disabled = true;
      try {
        const r = await fetch(API + '/preferences', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [key]: next }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Failed');
        document.getElementById('monthly-display').textContent = fmt(data.monthlyTotal);
        document.querySelectorAll('[data-monthly-echo]').forEach(el => el.textContent = fmt(data.monthlyTotal));
        const dayEl = document.getElementById('day-price'); if (dayEl) dayEl.textContent = fmt(Math.round((data.monthlyTotal / 30) * 100) / 100);
        if (data.tierPrices) {
          document.querySelectorAll('[data-price-for]').forEach((pel) => {
            const t = pel.dataset.priceFor;
            if (data.tierPrices[t] != null) pel.innerHTML = fmt(data.tierPrices[t]) + '<span class="per">/mo</span>';
          });
        }
        const anchor = document.getElementById('anchor-display');
        const saveRow = document.querySelector('.save-row');
        const savingsEl = document.getElementById('savings-display');
        if (data.savingsPerMo > 0) {
          if (saveRow) saveRow.style.display = '';
          if (savingsEl) savingsEl.textContent = fmt(data.savingsPerMo);
          if (anchor) anchor.textContent = fmt(data.baseMonthly) + '/mo';
        } else if (saveRow) {
          saveRow.style.display = 'none';
        }
        const row = ev.target.closest('[data-pref-row]');
        if (row) {
          row.classList.toggle('off', !next);
          const desc = row.querySelector('[data-pref-desc]');
          const sav = row.querySelector('[data-pref-savings]');
          if (desc && data.prefMeta && data.prefMeta[key]) {
            desc.textContent = next ? 'Toggle off if you want to skip this.' : data.prefMeta[key].offDesc;
          }
          if (sav && data.prefMeta && data.prefMeta[key]) {
            sav.classList.toggle('none', !next);
            sav.textContent = next ? data.prefMeta[key].savingsLabel : 'Applied to your estimate';
          }
        }
        toast(next ? 'Added back to your plan' : 'Removed — price updated');
      } catch (e) {
        ev.target.checked = !next;
        toast('Could not update. Try again.');
      } finally {
        ev.target.disabled = false;
      }
    });
  });

  // ── Booking flow: slots → reserve → confirm+accept ───────────
  // Shared state for the booking card. Each step transitions the visible
  // sub-section. Reservation auto-expires server-side after 15 min; the
  // client countdown is cosmetic but matches the backend hold.
  const bookingState = {
    selectedSlotId: null,
    selectedSlotLabel: null,
    pickedPref: null,
    reservation: null,
    countdownTimer: null,
  };

  function fmtSlotDay(dateStr) {
    try {
      const d = new Date(dateStr + 'T12:00:00');
      return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    } catch { return dateStr; }
  }
  function fmtSlotWindow(start, end) {
    const fmt = (t) => {
      if (!t) return '';
      const [h, m] = String(t).split(':').map(Number);
      const d = new Date(); d.setHours(h, m, 0, 0);
      return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    };
    return fmt(start) + ' – ' + fmt(end);
  }

  function renderSlot(s, isExpander) {
    const day = fmtSlotDay(s.date);
    const win = fmtSlotWindow(s.windowStart, s.windowEnd);
    const tech = s.techFirstName ? 'with ' + s.techFirstName : 'tech TBD';
    const tag = s.routeOptimal ? '<span class="slot-tag">Nearby day — good for you</span>' : '';
    return '<button type="button" class="slot-btn" data-slot-id="' + s.slotId + '" data-slot-label="' + day + ' at ' + win + '">'
      + '<span class="slot-day">' + day + '</span>'
      + '<span class="slot-window">' + win + ' · ' + tech + '</span>'
      + tag + '</button>';
  }

  async function loadSlots() {
    const area = document.getElementById('slot-area');
    if (!area) return;
    try {
      const r = await fetch('/api/public/estimates/' + TOKEN + '/available-slots');
      if (!r.ok) throw new Error('slot fetch failed');
      const body = await r.json();
      const primary = body.primary || [];
      const expander = body.expander || [];
      if (!primary.length && !expander.length) {
        area.className = 'booking-state';
        area.innerHTML = 'No open times in the next 2 weeks. <a href="tel:${COMPANY.phoneRaw}" style="color:#1B2C5B;font-weight:600">Call ${COMPANY.phone}</a> and we will fit you in.';
        return;
      }
      area.className = '';
      const html = [];
      html.push('<div class="slot-list">');
      primary.forEach((s) => html.push(renderSlot(s, false)));
      if (expander.length) {
        html.push('<button type="button" class="slot-more" id="slot-more-btn">See more times</button>');
        html.push('<div class="slot-list" id="slot-expander" style="display:none">');
        expander.forEach((s) => html.push(renderSlot(s, true)));
        html.push('</div>');
      }
      html.push('</div>');
      area.innerHTML = html.join('');
      area.querySelectorAll('.slot-btn').forEach((btn) => btn.addEventListener('click', () => selectSlot(btn)));
      const more = document.getElementById('slot-more-btn');
      if (more) more.addEventListener('click', () => {
        const expanderEl = document.getElementById('slot-expander');
        if (expanderEl) expanderEl.style.display = '';
        more.style.display = 'none';
      });
    } catch (e) {
      area.className = 'booking-state';
      area.innerHTML = 'Could not load times right now. <a href="tel:${COMPANY.phoneRaw}" style="color:#1B2C5B;font-weight:600">Call ${COMPANY.phone}</a> and we will get you scheduled.';
    }
  }

  function selectSlot(btn) {
    document.querySelectorAll('.slot-btn').forEach((el) => el.classList.remove('selected'));
    btn.classList.add('selected');
    bookingState.selectedSlotId = btn.dataset.slotId;
    bookingState.selectedSlotLabel = btn.dataset.slotLabel;
    const payArea = document.getElementById('pay-pref-area');
    if (payArea) {
      payArea.style.display = '';
      payArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  async function pickPaymentPref(pref) {
    if (!bookingState.selectedSlotId) {
      toast('Pick a time first.');
      return;
    }
    const buttons = document.querySelectorAll('[data-pay-pref]');
    buttons.forEach((b) => { b.disabled = true; });
    bookingState.pickedPref = pref;
    try {
      const r = await fetch('/api/public/estimates/' + TOKEN + '/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slotId: bookingState.selectedSlotId }),
      });
      if (r.status === 409) {
        toast('That slot was just taken. Pick another.');
        buttons.forEach((b) => { b.disabled = false; });
        bookingState.pickedPref = null;
        loadSlots();
        return;
      }
      if (!r.ok) throw new Error('reserve failed');
      const body = await r.json();
      bookingState.reservation = { scheduledServiceId: body.scheduledServiceId, expiresAt: body.expiresAt };
      // Swap UI: hide slot list + pay pref, show review
      document.getElementById('slot-area').style.display = 'none';
      document.getElementById('pay-pref-area').style.display = 'none';
      const reviewArea = document.getElementById('review-area');
      reviewArea.style.display = '';
      const title = document.getElementById('confirm-book-title');
      const sub = document.getElementById('confirm-book-sub');
      if (pref === 'deposit_now') {
        if (title) title.textContent = 'Confirm and enter payment';
        if (sub) sub.textContent = (bookingState.selectedSlotLabel || 'Your slot') + ' · next step collects your card securely via Stripe.';
      } else {
        if (title) title.textContent = 'Confirm and book';
        if (sub) sub.textContent = (bookingState.selectedSlotLabel || 'Your slot') + ' · pay at the visit, no card needed now.';
      }
      startReservationCountdown(body.expiresAt);
      reviewArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      toast('Could not reserve. Try again or call ${COMPANY.phone}.');
      buttons.forEach((b) => { b.disabled = false; });
      bookingState.pickedPref = null;
    }
  }

  function startReservationCountdown(expiresAt) {
    if (bookingState.countdownTimer) clearInterval(bookingState.countdownTimer);
    const tick = () => {
      const el = document.getElementById('reservation-countdown');
      if (!el) return;
      const msLeft = new Date(expiresAt).getTime() - Date.now();
      if (msLeft <= 0) {
        el.textContent = 'expired';
        clearInterval(bookingState.countdownTimer);
        toast('Reservation expired — pick another time.');
        cancelReservation();
        return;
      }
      const total = Math.floor(msLeft / 1000);
      const m = Math.floor(total / 60);
      const s = total % 60;
      el.textContent = m + ':' + (s < 10 ? '0' + s : s);
    };
    tick();
    bookingState.countdownTimer = setInterval(tick, 1000);
  }

  function cancelReservation() {
    if (bookingState.countdownTimer) { clearInterval(bookingState.countdownTimer); bookingState.countdownTimer = null; }
    // Fire-and-forget DELETE to release the server-side hold. If the
    // request fails (offline, etc.) the 15-min expiry will reclaim the
    // row anyway, so we don't await or block the UI.
    const res = bookingState.reservation;
    if (res && res.scheduledServiceId) {
      fetch('/api/public/estimates/' + TOKEN + '/reserve/' + encodeURIComponent(res.scheduledServiceId), { method: 'DELETE' }).catch(function () {});
    }
    bookingState.reservation = null;
    bookingState.pickedPref = null;
    document.getElementById('review-area').style.display = 'none';
    document.getElementById('slot-area').style.display = '';
    const payArea = document.getElementById('pay-pref-area');
    if (payArea) {
      payArea.style.display = 'none';
      document.querySelectorAll('[data-pay-pref]').forEach((b) => { b.disabled = false; });
    }
    // Reload slots to reflect any changes since the first fetch
    loadSlots();
  }

  async function confirmBooking() {
    const btn = document.getElementById('confirm-book-btn');
    if (btn) btn.disabled = true;
    try {
      const r = await fetch(API + '/accept', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slotId: bookingState.selectedSlotId,
          paymentMethodPreference: bookingState.pickedPref,
        }),
      });
      const data = await r.json();
      if (r.status === 409) {
        toast('Slot conflict — pick another time.');
        cancelReservation();
        return;
      }
      if (!r.ok) throw new Error(data.error || 'accept failed');
      if (bookingState.countdownTimer) clearInterval(bookingState.countdownTimer);
      // Everything continues in /onboard/:token — the payment preference
      // we submitted on accept is persisted on the customer row, and
      // onboarding handles the Stripe step for deposit_now and the
      // scheduling confirmation for pay_at_visit.
      if (data.onboardingToken) {
        window.location.href = '/onboard/' + data.onboardingToken;
      } else {
        toast('Booked! We will be in touch shortly.');
        setTimeout(() => location.reload(), 1200);
      }
    } catch (e) {
      toast('Could not confirm. Call ${COMPANY.phone} if this keeps happening.');
      if (btn) btn.disabled = false;
    }
  }

  // Wire pay-pref buttons once DOM is ready (script runs after the card
  // is emitted inline so the nodes already exist).
  document.querySelectorAll('[data-pay-pref]').forEach((b) => {
    b.addEventListener('click', () => pickPaymentPref(b.dataset.payPref));
  });

  // Kick off the slot fetch if the booking card is on the page (i.e.,
  // estimate is not yet accepted/expired).
  if (document.getElementById('booking-card')) {
    loadSlots();
  }



  // Rotating Google reviews from /api/reviews/featured (same pool as wavespestcontrol.com)
  (async function initReviews() {
    let reviews = [];
    try {
      const r = await fetch('/api/reviews/featured?limit=8');
      const data = await r.json();
      reviews = (data.reviews || []).filter(x => x.text && x.text.length > 40);
    } catch (e) { /* silent */ }
    if (!reviews.length) {
      document.getElementById('review-carousel').style.display = 'none';
      return;
    }
    const slide = document.getElementById('review-slide');
    const body = document.getElementById('review-body');
    const meta = document.getElementById('review-meta');
    const dots = document.getElementById('review-dots');
    reviews.forEach((_, i) => {
      const b = document.createElement('button');
      b.setAttribute('aria-label', 'Review ' + (i + 1));
      b.addEventListener('click', () => show(i, true));
      dots.appendChild(b);
    });
    let idx = 0;
    let timer = null;
    function show(i, manual) {
      idx = (i + reviews.length) % reviews.length;
      slide.classList.add('fade');
      setTimeout(() => {
        const r = reviews[idx];
        body.textContent = '\u201C' + r.text + '\u201D';
        meta.innerHTML = '<strong>' + r.reviewerName + '</strong>' + (r.location ? ' \u00B7 ' + r.location : '');
        dots.querySelectorAll('button').forEach((b, n) => b.classList.toggle('active', n === idx));
        slide.classList.remove('fade');
      }, 250);
      if (manual && timer) { clearInterval(timer); timer = setInterval(() => show(idx + 1), 6000); }
    }
    show(0);
    timer = setInterval(() => show(idx + 1), 6000);
  })();

  // Bundle-applied banner. When the page loads with ?bundle_applied=1,
  // show a one-time dismissible banner above the hero so the customer
  // sees "we just auto-applied your bundle" before they start reading.
  (function () {
    if (!/[?&]bundle_applied=1/.test(location.search)) return;
    var div = document.createElement('div');
    div.setAttribute('role', 'status');
    div.style.cssText = 'background:#ECFDF5;border:1px solid #10B981;color:#064E3B;padding:12px 16px;border-radius:8px;margin:0 auto 16px;max-width:820px;display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:14px;';
    div.innerHTML = '<span><strong>Bundle applied.</strong> Silver tier pricing is now reflected below. We also sent a heads-up to our office.</span><button type="button" aria-label="Dismiss" style="background:none;border:none;color:#064E3B;cursor:pointer;font-size:18px;line-height:1;padding:4px 8px;">\u00D7</button>';
    div.querySelector('button').addEventListener('click', function () { div.remove(); });
    var wrap = document.querySelector('.wrap') || document.body;
    wrap.insertBefore(div, wrap.firstChild);
  })();

  async function inquireBundle(svc) {
    var card = document.querySelector('.upsell');
    var pill = document.querySelector('.upsell-btn');
    try {
      if (card) card.disabled = true;
      if (pill) pill.textContent = 'Applying bundle\u2026';
      var r = await fetch(API + '/bundle-inquiry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestedService: svc })
      });
      var data = await r.json().catch(function () { return {}; });
      if (data && data.bundled) {
        toast('Bundle applied \u2014 ' + data.bundled.tier + ' tier pricing');
        var sep = location.search ? '&' : '?';
        setTimeout(function () { location.href = location.pathname + location.search + sep + 'bundle_applied=1'; }, 700);
      } else {
        toast('Got it \u2014 we\u2019ll text you a bundle quote shortly.');
        if (card) card.disabled = false;
        if (pill) pill.textContent = 'Get a bundle quote';
      }
    } catch (e) {
      toast('Could not send. Call (941) 297-5749.');
      if (card) card.disabled = false;
      if (pill) pill.textContent = 'Get a bundle quote';
    }
  }
</script>
</body></html>`;
}

function sendEstimatePage(res, token, estimate, estData) {
  res.set('Content-Type', 'text/html; charset=utf-8').send(renderPage(token, estimate, estData));
}

async function handleEstimateView(req, res, next) {
  try {
    const estimate = await db('estimates').where({ token: req.params.token }).first();
    if (!estimate) {
      return res.status(404).set('Content-Type', 'text/html').send(
        `<!doctype html><html><head><meta charset="utf-8"><title>Not Found</title></head><body style="font-family:system-ui;padding:40px;text-align:center"><h1>Estimate Not Found</h1><p>This link may have expired. Call <a href="tel:+19412975749">(941) 297-5749</a>.</p></body></html>`
      );
    }

    // V2 gate — when this estimate's row has use_v2_view=true, skip the
    // server-HTML pipeline entirely and let the request fall through to
    // the SPA static-index fallback at server/index.js's app.get('*',...).
    // The React page owns view tracking + first-view side effects via
    // GET /:token/data; do NOT double-count them here.
    if (estimate.use_v2_view === true) {
      return next();
    }

    if (new Date(estimate.expires_at) < new Date() && estimate.status !== 'accepted') {
      return res.set('Content-Type', 'text/html').send(
        renderExpiredPage({ address: estimate.address, customerName: estimate.customer_name })
      );
    }

    // Track every view (count + last_viewed_at)
    try {
      await db('estimates').where({ id: estimate.id }).update({
        view_count: db.raw('COALESCE(view_count, 0) + 1'),
        last_viewed_at: db.fn.now(),
      });
    } catch (e) { logger.error(`[estimate-view] view tracking failed: ${e.message}`); }

    // Per-open log (Estimates v2 spec §4) — one row per open with ip + UA.
    // Wrapped so a schema drift can't break the public estimate page.
    try {
      const ip = (req.headers['x-forwarded-for'] || req.ip || req.socket?.remoteAddress || '')
        .toString().split(',')[0].trim().slice(0, 64);
      const ua = (req.get('user-agent') || '').slice(0, 1000);
      await db('estimate_views').insert({
        estimate_id: estimate.id,
        viewed_at: db.fn.now(),
        ip: ip || null,
        user_agent: ua || null,
      });
    } catch (e) { logger.warn(`[estimate-view] estimate_views insert skipped: ${e.message}`); }

    // First-view actions: set viewed_at/status, notify admin + SMS office
    if (!estimate.viewed_at) {
      await db('estimates').where({ id: estimate.id }).update({ viewed_at: db.fn.now(), status: 'viewed' });

      try {
        const NotificationService = require('../services/notification-service');
        await NotificationService.notifyAdmin('estimate', `Estimate viewed: ${estimate.customer_name}`, `${estimate.address || 'no address'} \u2014 $${estimate.monthly_total || 0}/mo`, { icon: '\u{1F4CB}', link: '/admin/estimates', metadata: { estimateId: estimate.id, customerId: estimate.customer_id } });
      } catch (e) { logger.error(`[notifications] Estimate viewed notification failed: ${e.message}`); }

      try {
        await TwilioService.sendSMS(WAVES_OFFICE_PHONE,
          `\u{1F440} ${estimate.customer_name} just opened their estimate ($${estimate.monthly_total || 0}/mo ${estimate.waveguard_tier || ''}). Great time to follow up! ${estimate.customer_phone || ''}`
        );
      } catch (e) { logger.error(`[estimate-view] office SMS failed: ${e.message}`); }
    }

    const estData = typeof estimate.estimate_data === 'string' ? JSON.parse(estimate.estimate_data) : estimate.estimate_data;

    sendEstimatePage(res, req.params.token, {
      id: estimate.id,
      status: estimate.status,
      customerName: estimate.customer_name,
      address: estimate.address,
      monthlyTotal: parseFloat(estimate.monthly_total || 0),
      annualTotal: parseFloat(estimate.annual_total || 0),
      onetimeTotal: parseFloat(estimate.onetime_total || 0),
      tier: estimate.waveguard_tier,
      createdAt: estimate.created_at,
      expiresAt: estimate.expires_at,
      satelliteUrl: estimate.satellite_url || null,
    }, estData);
  } catch (err) { next(err); }
}

// GET /api/estimates/:token — customer views estimate (no auth) — server-rendered HTML
router.get('/:token', handleEstimateView);

// PUT /api/estimates/:token/accept — customer accepts
// Body (backward compatible — both optional):
//   { slotId?: string, paymentMethodPreference?: 'deposit_now' | 'pay_at_visit' }
// When slotId is present, a prior POST /:token/reserve call must have
// created a scheduled_services reservation row for the same estimate.
// The accept handler commits that reservation inside the existing
// transaction — customer_id gets linked, reservation_expires_at cleared.
// Paths without slotId behave exactly as pre-PR-B.1 (EstimateConverter
// creates scheduled_services post-transaction).
router.put('/:token/accept', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ token: req.params.token }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (estimate.status === 'accepted') return res.json({ success: true, alreadyAccepted: true });

    const firstName = (estimate.customer_name || '').split(' ')[0] || 'there';

    // Slot commit inputs. Validate early so we can reject before opening
    // a transaction if the payload is malformed.
    const slotId = req.body && typeof req.body.slotId === 'string' ? req.body.slotId.trim() : '';
    const paymentMethodPreference = (() => {
      const raw = req.body?.paymentMethodPreference;
      if (raw === 'deposit_now' || raw === 'pay_at_visit' || raw === 'prepay_annual') return raw;
      return null;
    })();
    // Billing term is a separate concept from payment method. "prepay_annual"
    // means the customer is paying for 12 months upfront, which waives the
    // $99 WaveGuard setup fee. The converter reads this to decide what kind
    // of draft invoice to create at accept time.
    const billingTerm = paymentMethodPreference === 'prepay_annual' ? 'prepay_annual' : 'standard';
    // serviceMode — 'recurring' (default) | 'one_time'. When one_time, the
    // customer picked the inline toggle on the v2 estimate view and
    // explicitly asked for a single visit instead of a recurring plan.
    // Gates post-commit behavior: no onboarding session, no customer tier
    // upgrade, no EstimateConverter recurring schedule creation.
    const serviceMode = req.body?.serviceMode === 'one_time' ? 'one_time' : 'recurring';

    let reservationRow = null;
    if (slotId) {
      const parsed = slotReservation._internals.parseSlotId(slotId);
      if (!parsed) return res.status(400).json({ error: 'invalid slotId format' });

      // Find the reservation row for THIS estimate matching the requested
      // slot. Prevents a malicious client from passing a slotId reserved
      // for someone else's estimate.
      reservationRow = await db('scheduled_services')
        .where({
          source_estimate_id: estimate.id,
          scheduled_date: parsed.date,
          window_start: parsed.windowStart,
        })
        .modify((q) => { if (parsed.techId) q.where('technician_id', parsed.techId); })
        .whereNotNull('reservation_expires_at')
        .first();

      if (!reservationRow) {
        return res.status(409).json({ error: 'no active reservation for this slot — re-pick and try again' });
      }
      if (new Date(reservationRow.reservation_expires_at) < new Date()) {
        return res.status(409).json({ error: 'reservation expired — re-pick a slot' });
      }
    }

    // Parse estimate data + detect one-time-only vs recurring (read-only — safe outside txn)
    const estData = typeof estimate.estimate_data === 'string' ? JSON.parse(estimate.estimate_data) : estimate.estimate_data;
    const estResult = estData?.result || estData || {};
    const recurringSvcList = estResult?.recurring?.services || [];
    const oneTimeList = [...(estResult?.oneTime?.items || []), ...(estResult?.oneTime?.specItems || [])];
    // Structural "one-time only" — the estimate was built with no
    // recurring services, only one-time items. Older concept.
    const isOneTimeOnly = recurringSvcList.length === 0 && oneTimeList.length > 0;
    // Customer-choice "treat as one-time" — either the estimate is
    // structurally one-time-only, OR the customer picked the one-time
    // toggle on the v2 view (serviceMode='one_time'). Gates the same
    // post-commit branches (no onboarding session, no tier upgrade,
    // no recurring schedule via EstimateConverter).
    const treatAsOneTime = isOneTimeOnly || serviceMode === 'one_time';

    // All DB mutations run atomically so a mid-flight failure can't leave a
    // half-created customer without an onboarding session (or vice versa).
    // SMS / notifications / auto-conversion are fired AFTER the commit below.
    const txResult = await db.transaction(async (trx) => {
      await trx('estimates').where({ id: estimate.id }).update({ status: 'accepted', accepted_at: trx.fn.now() });

      let customerId = estimate.customer_id;
      if (!customerId && estimate.customer_phone) {
        const existing = await trx('customers').where({ phone: estimate.customer_phone }).first();
        if (existing) {
          customerId = existing.id;
        } else {
          const nameParts = (estimate.customer_name || 'New Customer').split(' ');
          const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
          const [newCust] = await trx('customers').insert({
            first_name: nameParts[0] || 'New',
            last_name: nameParts.slice(1).join(' ') || 'Customer',
            phone: estimate.customer_phone,
            email: estimate.customer_email || null,
            address_line1: estimate.address || '',
            city: '', state: 'FL', zip: '',
            waveguard_tier: estimate.waveguard_tier || 'Bronze',
            monthly_rate: estimate.monthly_total || 0,
            member_since: etDateString(),
            referral_code: code,
          }).returning('*');
          customerId = newCust.id;
          await trx('property_preferences').insert({ customer_id: customerId });
          await trx('notification_prefs').insert({ customer_id: customerId });
        }
        await trx('estimates').where({ id: estimate.id }).update({ customer_id: customerId });
      }

      // Copy the estimate's service-preference selections onto the customer
      // row so tech routes + the customer portal see the same source of truth.
      // Defensive: skip if the column hasn't been migrated yet (older envs).
      if (customerId) {
        try {
          let parsedData = {};
          try { parsedData = typeof estimate.estimate_data === 'string' ? JSON.parse(estimate.estimate_data) : (estimate.estimate_data || {}); }
          catch { parsedData = {}; }
          const prefs = normalizePrefs(parsedData.preferences);
          if (await trx.schema.hasColumn('customers', 'service_preferences')) {
            await trx('customers').where({ id: customerId }).update({
              service_preferences: JSON.stringify(prefs),
            });
          }
        } catch (e) { logger.warn(`[estimate-accept] service_preferences copy skipped: ${e.message}`); }
      }

      // Commit the slot reservation (if one) now that we have customerId.
      // Runs inside the same trx so either everything lands or nothing
      // does — a mid-flight failure here won't leave a committed customer
      // paired with an un-committed reservation (or vice versa).
      if (reservationRow && customerId) {
        try {
          await slotReservation.commitReservation({
            scheduledServiceId: reservationRow.id,
            customerId,
            paymentMethodPreference,
            trx,
          });
        } catch (commitErr) {
          // Only RESERVATION_EXPIRED is interesting here — race between
          // our 15-min window and the final tap. Let the outer catch
          // translate it into a user-facing 409.
          if (commitErr.code === 'RESERVATION_EXPIRED') {
            const err = new Error('reservation expired during commit');
            err.status = 409;
            throw err;
          }
          throw commitErr;
        }
      }

      let onboardingToken = null;
      if (customerId && !treatAsOneTime) {
        const obToken = crypto.randomUUID();
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7);

        const svcType = recurringSvcList.map(s => s.name).join(' + ') || 'Pest Control';

        const [ob] = await trx('onboarding_sessions').insert({
          customer_id: customerId,
          token: obToken,
          service_type: `WaveGuard ${estimate.waveguard_tier || 'Bronze'} — ${svcType}`,
          waveguard_tier: estimate.waveguard_tier,
          monthly_rate: estimate.monthly_total,
          status: 'started',
          expires_at: expiresAt,
        }).returning('*');

        await trx('estimates').where({ id: estimate.id }).update({ onboarding_session_id: ob.id });
        onboardingToken = obToken;
      }

      return { customerId, onboardingToken };
    });

    const { customerId, onboardingToken } = txResult;

    // Notify office
    if (customerId) {
      try {
        const officeVars = {
          customer_name: estimate.customer_name || '',
          address: estimate.address || '',
          waveguard_tier: estimate.waveguard_tier || 'Bronze',
          monthly_total: estimate.monthly_total || 0,
        };
        const officeFallback = treatAsOneTime
          ? `🎉 One-time booking! ${officeVars.customer_name} at ${officeVars.address} — ${oneTimeList[0]?.name || 'service'}. Booking link sent.`
          : `🎉 Estimate accepted! ${officeVars.customer_name} at ${officeVars.address} — ${officeVars.waveguard_tier} WaveGuard $${officeVars.monthly_total}/mo. Onboarding link sent.`;
        const officeBody = await renderTemplate('estimate_accepted_office', officeVars, officeFallback);
        await TwilioService.sendSMS(WAVES_OFFICE_PHONE, officeBody);
      } catch (e) { logger.error(`Estimate accept SMS failed: ${e.message}`); }
    }

    // Send acceptance SMS to customer
    let bookingUrl = null;
    if (estimate.customer_phone) {
      try {
        if (treatAsOneTime) {
          const primarySvc = bookingServiceFor(oneTimeList[0]?.name || '');
          const longBookingUrl = `https://portal.wavespestcontrol.com/book?service=${primarySvc.id}&source=estimate-accept`;
          bookingUrl = await shortenOrPassthrough(longBookingUrl, {
            kind: 'booking',
            entityType: 'estimates',
            entityId: estimate.id,
            customerId,
          });
          const customerBody = await renderTemplate(
            'estimate_accepted_onetime',
            { first_name: firstName, service_label: primarySvc.label, booking_url: bookingUrl },
            `Hey ${firstName}! Thanks for booking your ${primarySvc.label} with Waves. Pick your time here — we'll show you slots when a tech will already be in your neighborhood: ${bookingUrl}`
          );
          await TwilioService.sendSMS(estimate.customer_phone, customerBody,
            { mediaUrl: 'https://www.wavespestcontrol.com/wp-content/uploads/2026/01/waves-pest-and-lawn-logo.png' }
          );
          logger.info(`[estimate-accept] One-time booking SMS sent to ${firstName} (${estimate.customer_phone}) — ${primarySvc.label}`);
        } else {
          const longObUrl = onboardingToken ? `https://portal.wavespestcontrol.com/onboard/${onboardingToken}` : '';
          const obUrl = longObUrl
            ? await shortenOrPassthrough(longObUrl, {
                kind: 'onboarding',
                entityType: 'estimates',
                entityId: estimate.id,
                customerId,
              })
            : '';
          const customerBody = await renderTemplate(
            'estimate_accepted_customer',
            { first_name: firstName, onboarding_url: obUrl },
            `Hello ${firstName}! Thanks for approving your estimate. Complete your setup here so we can get you on the schedule: ${obUrl}`
          );
          await TwilioService.sendSMS(estimate.customer_phone, customerBody,
            { mediaUrl: 'https://www.wavespestcontrol.com/wp-content/uploads/2026/01/waves-pest-and-lawn-logo.png' }
          );
          logger.info(`[estimate-accept] Acceptance SMS sent to ${firstName} (${estimate.customer_phone})`);
        }
      } catch (e) { logger.error(`[estimate-accept] Acceptance SMS failed: ${e.message}`); }
    }

    // In-app notifications for estimate accepted
    try {
      const NotificationService = require('../services/notification-service');
      await NotificationService.notifyAdmin('estimate', `Estimate accepted: ${estimate.customer_name}`, `${estimate.waveguard_tier || 'Bronze'} WaveGuard $${estimate.monthly_total}/mo`, { icon: '\u2705', link: '/admin/estimates', metadata: { estimateId: estimate.id, customerId } });
      if (customerId) {
        await NotificationService.notifyCustomer(customerId, 'account', 'Estimate accepted', `Your ${estimate.waveguard_tier || 'Bronze'} WaveGuard plan is confirmed. Complete onboarding to get started.`, { icon: '\u2705', link: '/onboarding' });
      }
    } catch (e) { logger.error(`[notifications] Estimate accepted notification failed: ${e.message}`); }

    // Auto-convert estimate to active customer (Feature #5). Skip entirely
    // when this is a one-time booking — EstimateConverter creates recurring
    // scheduled_services rows + upgrades the customer's WaveGuard tier +
    // marks them active_customer. None of that applies for a single-visit
    // one-time booking. Reservation row (if any) already holds the slot.
    if (customerId && !treatAsOneTime) {
      try {
        const EstimateConverter = require('../services/estimate-converter');
        await EstimateConverter.convertEstimate(estimate.id, { billingTerm });
        logger.info(`[estimate-accept] Auto-conversion completed for estimate ${estimate.id} (billingTerm=${billingTerm})`);
      } catch (e) { logger.error(`[estimate-accept] Auto-conversion failed: ${e.message}`); }
    } else if (customerId && treatAsOneTime) {
      logger.info(`[estimate-accept] Skipped EstimateConverter for estimate ${estimate.id} (one-time booking)`);
    }

    res.json({ success: true, onboardingToken });
  } catch (err) {
    // Translate user-visible 4xx errors thrown from inside the transaction
    // (e.g. reservation expiring between the pre-tx check and the commit).
    if (err && err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

// PUT /api/estimates/:token/select-tier — customer selects a WaveGuard tier
router.put('/:token/select-tier', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ token: req.params.token }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (estimate.status === 'accepted') return res.status(400).json({ error: 'Estimate already accepted' });

    const { selectedTier } = req.body;
    const ALLOWED_TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum'];
    if (!selectedTier || !ALLOWED_TIERS.includes(selectedTier)) {
      return res.status(400).json({ error: 'selectedTier must be one of: ' + ALLOWED_TIERS.join(', ') });
    }

    const previousTier = estimate.waveguard_tier || 'Bronze';

    // Server-side pricing — never trust client totals
    let parsedData = {};
    try { parsedData = typeof estimate.estimate_data === 'string' ? JSON.parse(estimate.estimate_data) : (estimate.estimate_data || {}); }
    catch { parsedData = {}; }

    const baseMonthly = Number(parsedData.baseMonthly || parsedData.preDiscountMonthly || estimate.monthly_total || 0);
    const discount = TIER_DISCOUNTS[selectedTier] || 0;
    const monthlyTotal = Math.round(baseMonthly * (1 - discount) * 100) / 100;
    const annualTotal = Math.round(monthlyTotal * 12 * 100) / 100;

    await db('estimates').where({ id: estimate.id }).update({
      waveguard_tier: selectedTier,
      monthly_total: monthlyTotal,
      annual_total: annualTotal,
      updated_at: db.fn.now(),
    });

    // Notify admin of tier selection
    try {
      const NotificationService = require('../services/notification-service');
      await NotificationService.notifyAdmin('estimate',
        `Tier upgrade: ${estimate.customer_name}`,
        `Selected ${selectedTier} (was ${previousTier}) \u2014 $${monthlyTotal}/mo`,
        { icon: '\u2B06\uFE0F', link: '/admin/estimates', metadata: { estimateId: estimate.id } }
      );
    } catch (e) { logger.error(`[estimate] Tier selection notification failed: ${e.message}`); }

    logger.info(`[estimate] ${estimate.customer_name} selected ${selectedTier} tier (was ${previousTier}) — $${monthlyTotal}/mo`);
    res.json({ success: true, tier: selectedTier, monthlyTotal, annualTotal });
  } catch (err) { next(err); }
});

// PUT /api/estimates/:token/preferences — customer toggles a service preference
// (interior_spray / exterior_sweep) on the public estimate page. Persists the
// new preference to estimate_data.preferences, recomputes monthly / annual /
// one-time totals, updates the row, and returns a fresh price payload for
// client-side re-render.
router.put('/:token/preferences', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ token: req.params.token }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (estimate.status === 'accepted') return res.status(400).json({ error: 'Estimate already accepted' });

    // Only accept known pref keys; coerce to boolean.
    const patch = {};
    for (const k of SERVICE_PREF_KEYS) {
      if (k in (req.body || {})) patch[k] = req.body[k] !== false;
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'No valid preference fields provided' });
    }

    let parsedData = {};
    try { parsedData = typeof estimate.estimate_data === 'string' ? JSON.parse(estimate.estimate_data) : (estimate.estimate_data || {}); }
    catch { parsedData = {}; }

    const nextPrefs = normalizePrefs({ ...(parsedData.preferences || {}), ...patch });

    const estResult = parsedData.result || parsedData || {};
    const recurring = estResult?.recurring?.services || [];
    const oneTimeItems = [...(estResult?.oneTime?.items || []), ...(estResult?.oneTime?.specItems || [])];
    const pestRecurring = detectPestRecurring(recurring);
    const hasPestOneTime = detectPestOneTime(oneTimeItems);
    const pestOneTimeTotal = hasPestOneTime ? pestOneTimeBase(oneTimeItems) : 0;

    // baseMonthly resolution, ordered so legacy rows self-heal:
    //   1. explicit estData.baseMonthly / preDiscountMonthly
    //   2. derive from engine result: annualBeforeDiscount / 12
    //   3. sum of recurring.services[].mo (pre-discount per-service monthlies)
    //   4. estimate.monthly_total (DISCOUNTED — last-resort; stale if tier has changed)
    // The derived value is persisted back to estimate_data.baseMonthly below
    // so subsequent toggles on this row don't need to re-derive.
    const explicitBase = Number(parsedData.baseMonthly || parsedData.preDiscountMonthly || 0);
    const engineDerivedBase = Number(estResult?.recurring?.annualBeforeDiscount || 0) / 12;
    const summedBase = recurring.reduce((s, x) => s + Number(x.mo || x.monthly || 0), 0);
    const baseMonthly = explicitBase > 0 ? explicitBase
      : engineDerivedBase > 0 ? Math.round(engineDerivedBase * 100) / 100
      : summedBase > 0 ? Math.round(summedBase * 100) / 100
      : Number(estimate.monthly_total || 0);

    const currentTier = estimate.waveguard_tier || 'Bronze';
    const tierDiscount = TIER_DISCOUNTS[currentTier] || 0;

    const { monthlyOff, oneTimeOff } = computePrefDiscount(nextPrefs, pestRecurring, hasPestOneTime, pestOneTimeTotal);
    const monthlyTotal = Math.max(0, Math.round((baseMonthly * (1 - tierDiscount) - monthlyOff) * 100) / 100);
    const annualTotal  = Math.max(0, Math.round(monthlyTotal * 12 * 100) / 100);
    const onetimeBase = Number(parsedData.onetimeTotalBase || estimate.onetime_total || 0);
    const onetimeTotal = Math.max(0, Math.round((onetimeBase - oneTimeOff) * 100) / 100);
    const tierPrices = {};
    ['Bronze', 'Silver', 'Gold', 'Platinum'].forEach((t) => {
      tierPrices[t] = Math.max(0, Math.round((baseMonthly * (1 - TIER_DISCOUNTS[t]) - monthlyOff) * 100) / 100);
    });

    // Persist — merge new prefs + self-healed baseMonthly back onto the blob.
    parsedData.preferences = nextPrefs;
    if (baseMonthly > 0) parsedData.baseMonthly = baseMonthly;
    await db('estimates').where({ id: estimate.id }).update({
      estimate_data: JSON.stringify(parsedData),
      monthly_total: monthlyTotal,
      annual_total: annualTotal,
      onetime_total: onetimeTotal,
      updated_at: db.fn.now(),
    });

    // Per-row metadata for client re-render (off-desc + savings label)
    const prefMeta = {};
    for (const k of SERVICE_PREF_KEYS) {
      const cfg = SERVICE_PREFS[k];
      let savingsLabel = '';
      if (pestRecurring && hasPestOneTime) {
        const rec = Math.round(((cfg.perVisit * pestRecurring.visitsPerYear) / 12) * 100) / 100;
        savingsLabel = `Save $${rec.toFixed(rec % 1 ? 2 : 0)}/mo + $${cfg.oneTime} on one-time`;
      } else if (pestRecurring) {
        const rec = Math.round(((cfg.perVisit * pestRecurring.visitsPerYear) / 12) * 100) / 100;
        savingsLabel = `Save $${rec.toFixed(rec % 1 ? 2 : 0)}/mo`;
      } else if (hasPestOneTime) {
        savingsLabel = `Save $${cfg.oneTime}`;
      }
      prefMeta[k] = { offDesc: cfg.offDesc, savingsLabel };
    }

    const savingsPerMo = Math.max(0, Math.round((baseMonthly - monthlyTotal) * 100) / 100);

    logger.info(`[estimate] ${estimate.customer_name} toggled ${Object.keys(patch).join(', ')} -> ${JSON.stringify(patch)} ($${monthlyTotal}/mo)`);
    res.json({
      success: true,
      preferences: nextPrefs,
      baseMonthly,
      monthlyTotal,
      annualTotal,
      onetimeTotal,
      tierPrices,
      savingsPerMo,
      prefMeta,
    });
  } catch (err) { next(err); }
});

// POST /api/estimates/:token/bundle-inquiry — customer taps "Get a bundle quote"
// Re-runs the pricing engine with the suggested service added, writes the new
// bundled pricing back to the estimate, and tells the client to reload. Falls
// back to the inquiry-only SMS path if re-pricing fails (missing lawn_sqft,
// unsupported service combo, engine error, etc.).
router.post('/:token/bundle-inquiry', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ token: req.params.token }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (estimate.status === 'accepted') return res.status(400).json({ error: 'Estimate already accepted — bundle must be manually requoted' });

    const { suggestedService } = req.body;

    // Attempt auto re-price with the added service.
    let bundled = null;
    try {
      const estData = typeof estimate.estimate_data === 'string'
        ? JSON.parse(estimate.estimate_data)
        : estimate.estimate_data;
      const engineInputs = extractEngineInputs(estData);

      if (engineInputs && suggestedService) {
        const updatedInputs = JSON.parse(JSON.stringify(engineInputs));
        updatedInputs.services = updatedInputs.services || {};

        const addLawn = /lawn/i.test(suggestedService);
        const addPest = /pest/i.test(suggestedService);
        const addMosquito = /mosquito/i.test(suggestedService);

        if (addLawn && !updatedInputs.services.lawn) {
          // Lawn area: prefer explicit input → engine-derived result →
          // property-calculator will auto-derive from lotSqFt if neither
          // is present. Only bail if we have no lot info to work with.
          const existingLawn = Number(updatedInputs.lawnSqFt || estData?.result?.property?.lawnSqFt || 0);
          if (existingLawn > 0) updatedInputs.lawnSqFt = existingLawn;
          const hasLot = Number(updatedInputs.lotSqFt || estData?.result?.property?.lotSqFt || 0) > 0;
          if (existingLawn > 0 || hasLot) {
            if (!updatedInputs.lotSqFt && hasLot) {
              updatedInputs.lotSqFt = Number(estData?.result?.property?.lotSqFt || 0);
            }
            updatedInputs.services.lawn = {
              track: 'st_augustine',
              tier: 'enhanced',
              shadeClassification: 'FULL_SUN',
            };
          }
        } else if (addPest && !updatedInputs.services.pest) {
          updatedInputs.services.pest = { frequency: 'quarterly', version: 'v1', roachType: 'none' };
        } else if (addMosquito && !updatedInputs.services.mosquito) {
          updatedInputs.services.mosquito = { tier: 'silver' };
        }

        // Only re-price if we actually added a service this round.
        const didAdd =
          (addLawn && updatedInputs.services.lawn)
          || (addPest && updatedInputs.services.pest)
          || (addMosquito && updatedInputs.services.mosquito);
        if (didAdd) {
          const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
          const v1Result = generateEstimate(updatedInputs);
          const legacyResult = mapV1ToLegacyShape(v1Result);

          const newMonthly = Number(legacyResult?.recurring?.monthlyTotal || 0);
          const newAnnual = Number(legacyResult?.recurring?.annualAfterDiscount || newMonthly * 12);
          const newOneTime = Number(legacyResult?.oneTime?.total || estimate.onetime_total || 0);
          const newTier = String(legacyResult?.recurring?.tier || 'silver').replace(/^./, (c) => c.toUpperCase());
          // Pre-discount monthly for the new bundle. Required so downstream
          // pref toggles apply WaveGuard tier math against a fresh anchor
          // instead of a stale (pre-bundle, single-service) baseMonthly.
          const newBaseMonthly = Math.round((Number(legacyResult?.recurring?.annualBeforeDiscount || 0) / 12) * 100) / 100;

          const newEstimateData = {
            ...(estData || {}),
            inputs: updatedInputs,
            result: legacyResult,
            baseMonthly: newBaseMonthly > 0 ? newBaseMonthly : (estData?.baseMonthly || 0),
            onetimeTotalBase: newOneTime,
            bundleAutoApplied: {
              addedService: suggestedService,
              previousMonthly: Number(estimate.monthly_total || 0),
              previousTier: estimate.waveguard_tier || 'Bronze',
              newMonthly,
              newBaseMonthly,
              newTier,
              appliedAt: new Date().toISOString(),
            },
          };

          await db('estimates').where({ id: estimate.id }).update({
            estimate_data: JSON.stringify(newEstimateData),
            monthly_total: newMonthly,
            annual_total: newAnnual,
            onetime_total: newOneTime,
            waveguard_tier: newTier,
            updated_at: db.fn.now(),
          });

          // Bust the per-estimate pricing cache so the next GET re-reads from DB.
          pricingCache.delete(estimate.id);

          bundled = {
            addedService: suggestedService,
            previousMonthly: Number(estimate.monthly_total || 0),
            newMonthly,
            tier: newTier,
            savingsPerMonth: Math.max(0, Math.round((Number(estimate.monthly_total || 0) + newMonthly - newMonthly) * 100) / 100),
          };
          logger.info(`[estimate] Bundle auto-applied for ${estimate.customer_name}: ${estimate.waveguard_tier} $${estimate.monthly_total}/mo → ${newTier} $${newMonthly}/mo`);
        }
      }
    } catch (err) {
      logger.error(`[estimate] Bundle re-price failed, falling back to inquiry: ${err.message}`);
    }

    // Always fire the office SMS / admin notification so the team has a
    // heads-up — either the customer wants a bundle we couldn't auto-apply,
    // or they've just self-served a tier upgrade and we should follow up.
    try {
      const preMonthly = Number(estimate.monthly_total || 0);
      const smsBody = bundled
        ? `\u{1F4E6} Bundle SELF-APPLIED by ${estimate.customer_name}:\nAdded: ${bundled.addedService}\nWas: ${estimate.waveguard_tier || 'Bronze'} @ $${preMonthly}/mo\nNow: ${bundled.tier} @ $${bundled.newMonthly}/mo\nProperty: ${estimate.address || 'N/A'}\nPhone: ${estimate.customer_phone || 'N/A'}`
        : `\u{1F4E6} Bundle inquiry from ${estimate.customer_name}:\nCurrently quoted: ${estimate.waveguard_tier || 'Bronze'} at $${preMonthly}/mo\nInterested in adding: ${suggestedService || 'another service'}\nProperty: ${estimate.address || 'N/A'}\nPhone: ${estimate.customer_phone || 'N/A'}`;
      await TwilioService.sendSMS(WAVES_OFFICE_PHONE, smsBody);
    } catch (e) { logger.error(`[estimate] Bundle inquiry SMS failed: ${e.message}`); }

    try {
      const NotificationService = require('../services/notification-service');
      await NotificationService.notifyAdmin('estimate',
        bundled ? `Bundle self-applied: ${estimate.customer_name}` : `Bundle inquiry: ${estimate.customer_name}`,
        bundled
          ? `Added ${bundled.addedService} → ${bundled.tier} @ $${bundled.newMonthly}/mo`
          : `Interested in adding ${suggestedService || 'a service'} to ${estimate.waveguard_tier || 'Bronze'} plan`,
        { icon: '\u{1F4E6}', link: '/admin/estimates', metadata: { estimateId: estimate.id } }
      );
    } catch (e) { logger.error(`[estimate] Bundle inquiry notification failed: ${e.message}`); }

    res.json({ success: true, bundled });
  } catch (err) { next(err); }
});

// PUT /api/estimates/:token/decline
router.put('/:token/decline', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ token: req.params.token }).first();
    await db('estimates').where({ token: req.params.token }).update({ status: 'declined', declined_at: db.fn.now() });

    // Notify admin of declined estimate
    if (estimate) {
      try {
        const NotificationService = require('../services/notification-service');
        await NotificationService.notifyAdmin('estimate', `Estimate declined: ${estimate.customer_name}`, `${estimate.address || 'no address'} \u2014 $${estimate.monthly_total || 0}/mo`, { icon: '\u274C', link: '/admin/estimates', metadata: { estimateId: estimate.id, customerId: estimate.customer_id } });
      } catch (e) { logger.error(`[notifications] Estimate declined notification failed: ${e.message}`); }
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /api/estimates/:token/data — JSON shape for the React v2 view
// =========================================================================
// Same-origin auth model as the HTML handler: token is the only gate.
// Ported view-side-effects:
//   - view_count++ + last_viewed_at + estimate_views row: ALWAYS on every
//     200 (React refetches count as views; rate limit + per-open log
//     together make this noisy-but-safe)
//   - First-view transition (status='draft' → 'viewed', viewed_at stamp,
//     office SMS, admin notification): fires only when viewed_at IS NULL
//     AND request IP isn't in the admin allowlist. Keeps Virginia's
//     preview clicks from triggering "customer just opened" alerts.
//
// Admin allowlist: WAVES_ADMIN_IPS env var, comma-separated. Unset =
// fire-for-everyone (fail open — matches current HTML behavior).
//
// Pricing recompute: runs the engine once per active pest-capable frequency
// (quarterly / bi_monthly / monthly — engine supports 3 today; 5-stop
// slider waits on Waves deciding an every_6_weeks discount). Cached per
// estimateId 10 min.

const ADMIN_IP_ALLOWLIST = (process.env.WAVES_ADMIN_IPS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const FREQUENCY_LADDER = [
  { key: 'quarterly',  label: 'Quarterly',   engineFrequency: 'quarterly' },
  { key: 'bi_monthly', label: 'Bi-monthly',  engineFrequency: 'bimonthly' },
  { key: 'monthly',    label: 'Monthly',     engineFrequency: 'monthly' },
];

// In-memory cache keyed on estimateId, 10-min TTL. One JSON endpoint hit
// produces one cache entry; subsequent hits within 10 min skip the
// engine recompute entirely.
const pricingCache = new Map();
const PRICING_TTL_MS = 10 * 60 * 1000;

function pricingCacheCleanup() {
  const now = Date.now();
  for (const [k, v] of pricingCache.entries()) {
    if (v.expiresAt < now) pricingCache.delete(k);
  }
}

function extractRequestIp(req) {
  const raw = (req.headers['x-forwarded-for'] || req.ip || req.socket?.remoteAddress || '')
    .toString().split(',')[0].trim();
  return raw.slice(0, 64);
}

function isAdminIp(ip) {
  if (!ip || !ADMIN_IP_ALLOWLIST.length) return false;
  return ADMIN_IP_ALLOWLIST.includes(ip);
}

// Derive engine inputs from stored estimate_data. Admin-UI estimates
// carry { inputs, result, ... } (v1 client-engine shape). IB-sourced
// estimates carry { engineInputs, engineResult }. Either works.
function extractEngineInputs(estData) {
  if (!estData || typeof estData !== 'object') return null;
  if (estData.engineInputs && typeof estData.engineInputs === 'object') {
    return estData.engineInputs;
  }
  if (estData.inputs && typeof estData.inputs === 'object') {
    return estData.inputs;
  }
  return null;
}

function canVaryPestFrequency(engineInputs) {
  return !!engineInputs?.services?.pest;
}

// Convert one generateEstimate result into the frequency ladder entry
// shape the React view consumes.
function shapeFrequencyEntry(ladder, engineResult, engineInputs) {
  const summary = engineResult?.summary || {};
  const lineItems = Array.isArray(engineResult?.lineItems) ? engineResult.lineItems : [];

  // "included" checklist: every service on the line-item list counts as
  // included AT this frequency. For v1 we treat it as a flat boolean
  // ladder — each frequency's checklist is the line items emitted by
  // running the engine at that frequency. If a service disappears at
  // a lower frequency (engine drops it), it simply doesn't appear.
  const included = lineItems
    .filter((li) => li && (li.service || li.name))
    .map((li) => ({
      key: li.service || li.name,
      label: li.displayName || li.service || li.name,
      detail: li.note || li.frequency || null,
      includedAtThisFrequency: true,
    }));

  // Add-ons: treat line items as add-ons ONLY if the defaults config
  // explicitly marks any for pre-check. If nothing's pre-checked for this
  // frequency, return an empty list so the customer-facing AddOnsBlock
  // hides entirely (avoids surfacing already-included services as fake
  // "toggles"). True add-on catalog for v1 estimates is a follow-up.
  const preCheckedKeys = new Set(addonDefaults[ladder.key] || []);
  const hasPreChecked = included.some((item) => preCheckedKeys.has(item.key));
  const addOns = hasPreChecked
    ? included.map((item) => ({
        ...item,
        preChecked: preCheckedKeys.has(item.key),
      }))
    : [];

  const monthly = summary.recurringMonthlyAfterDiscount ?? null;
  const annual = summary.recurringAnnualAfterDiscount ?? null;
  const onetime = summary.oneTimeTotal ?? null;

  return {
    key: ladder.key,
    label: ladder.label,
    monthly: monthly != null ? Number(monthly) : null,
    annual: annual != null ? Number(annual) : null,
    perVisit: lineItems.find((li) => li?.service === 'pest_control')?.perApp ?? null,
    oneTimeTotal: onetime != null ? Number(onetime) : null,
    included,
    addOns,
  };
}

// v1 client-engine shape — the admin UI's deprecated estimateEngine.js
// stores results under estimate_data.result with pre-computed pestTiers
// for all three frequencies. When present, use those directly instead of
// trying to re-run the modular server engine (whose input shape is
// incompatible with v1's flat `svcPest:true, pestFreq:"4"` flags).
//
// Returns null if this isn't a v1-shape estimate. Caller falls back to
// engine-invocation path (modular engine / IB path / etc).
const V1_LABEL_TO_LADDER = {
  'Quarterly':  { key: 'quarterly',  label: 'Quarterly' },
  'Bi-Monthly': { key: 'bi_monthly', label: 'Bi-monthly' },
  'Monthly':    { key: 'monthly',    label: 'Monthly' },
};

function readV1Shape(estData) {
  if (!estData || typeof estData !== 'object') return null;
  const result = estData.result;
  if (!result || typeof result !== 'object') return null;

  // pestTiers lives at result.results.pestTiers in the v1 shape (nested
  // inside `results` plural, alongside `lawn`, `pest`, `lawnMeta`). Fall
  // back to result.pestTiers for any IB-path or edge shape that puts it
  // at the top of `result`.
  const innerResults = result.results && typeof result.results === 'object' ? result.results : null;
  const pestTiers = Array.isArray(innerResults?.pestTiers)
    ? innerResults.pestTiers
    : (Array.isArray(result.pestTiers) ? result.pestTiers : []);

  const recurring = result.recurring || {};
  const services = Array.isArray(recurring.services) ? recurring.services : [];
  if (pestTiers.length === 0 && services.length === 0) return null;
  return {
    pestTiers,
    services,
    discount: Number(recurring.discount) || 0,
    waveGuardTier: recurring.waveGuardTier || recurring.tier || null,
    oneTimeTotal: Number(result.oneTime?.total) || 0,
    recurringMonthlyTotal: Number(recurring.monthlyTotal) || 0,
    recurringAnnualAfter: Number(recurring.annualAfterDiscount) || 0,
  };
}

function shapeFromV1(v1, ladder, pestTier) {
  // pestTier may be null if pest isn't in this estimate. In that case
  // the frequency entry shows the recurring total regardless of freq key
  // (lawn-only / mosquito-only estimates — slider position doesn't
  // actually matter).
  const pestMoBefore = pestTier ? Number(pestTier.mo || 0) : 0;
  const pestAnnBefore = pestTier ? Number(pestTier.ann || 0) : 0;
  const nonPestMoBefore = v1.services.reduce((sum, svc) => {
    if (svc?.name === 'Pest Control') return sum;
    return sum + (Number(svc?.mo || svc?.monthly || 0));
  }, 0);

  const totalMoBefore = pestMoBefore + nonPestMoBefore;
  // v1 applies the tier discount on the summed monthly (verified against
  // the recurring.monthlyTotal = (pest + lawn) * (1 - discount) relation).
  const totalMoAfter = Math.round(totalMoBefore * (1 - v1.discount) * 100) / 100;
  const totalAnnAfter = Math.round(totalMoAfter * 12 * 100) / 100;

  // Included items: full recurring services list. These don't change with
  // pest frequency (changing quarterly → monthly doesn't add or remove
  // lawn care; only pest's visit cadence changes).
  const included = v1.services.map((svc) => ({
    key: (svc?.name || '').toLowerCase().replace(/\s+/g, '_') || 'service',
    label: svc?.name || 'Service',
    detail: null,
    includedAtThisFrequency: true,
  }));

  // Same logic as engine-invocation path — only surface add-ons when the
  // defaults config pre-checks at least one. Hides the "Customize your
  // plan" block entirely for v1 estimates with no real add-on catalog.
  const preCheckedKeys = new Set(addonDefaults[ladder.key] || []);
  const hasPreChecked = included.some((item) => preCheckedKeys.has(item.key));
  const addOns = hasPreChecked
    ? included.map((item) => ({
        ...item,
        preChecked: preCheckedKeys.has(item.key),
      }))
    : [];

  return {
    key: ladder.key,
    label: ladder.label,
    monthly: totalMoAfter,
    annual: totalAnnAfter,
    perVisit: pestTier ? (Number(pestTier.pa) || null) : null,
    oneTimeTotal: v1.oneTimeTotal || null,
    included,
    addOns,
  };
}

async function buildPricingBundle(estimate) {
  pricingCacheCleanup();
  const cached = pricingCache.get(estimate.id);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.payload, cacheHit: true };
  }

  const estData = typeof estimate.estimate_data === 'string'
    ? JSON.parse(estimate.estimate_data)
    : estimate.estimate_data;

  // v1 shape (admin UI estimates) — read pre-computed pestTiers directly.
  // This is the dominant path until Session 11 retires the client engine.
  const v1 = readV1Shape(estData);
  if (v1) {
    const frequencies = [];
    for (const [v1Label, ladder] of Object.entries(V1_LABEL_TO_LADDER)) {
      const pestTier = v1.pestTiers.find((t) => t?.label === v1Label) || null;
      frequencies.push(shapeFromV1(v1, ladder, pestTier));
    }

    // If no pest at all, drop the extra two entries — slider is meaningless
    // without a pest cadence to vary. Keep Quarterly as the single surface.
    const hasPest = v1.pestTiers.length > 0;
    const finalFreqs = hasPest ? frequencies : frequencies.slice(0, 1);

    const payload = {
      frequencies: finalFreqs,
      waveGuardTier: v1.waveGuardTier || estimate.waveguard_tier || 'Bronze',
      anchorOneTimePrice: v1.oneTimeTotal || Number(estimate.onetime_total || 0) || null,
      // WaveGuard $99 initial fee — recurring pest only. Spec says waived with
      // annual prepay; we surface it as an informational line for now so the
      // customer sees it on their estimate. A prepay toggle that actually
      // applies the waiver is a separate follow-up (accept payload +
      // estimate-converter + invoice line item changes).
      setupFee: hasPest ? { amount: 99, label: 'WaveGuard setup', waivedWithPrepay: true } : null,
      source: 'v1_engine_shape',
    };
    pricingCache.set(estimate.id, { payload, expiresAt: Date.now() + PRICING_TTL_MS });
    return payload;
  }

  // Otherwise: engine-invocation path (modular-engine inputs / IB-sourced
  // estimates with engineInputs.services.pest shape). Runs generateEstimate
  // 3x with varied pest frequency.
  const engineInputs = extractEngineInputs(estData);

  // No engine inputs saved → fall back to the single-frequency view using
  // stored totals. Not ideal but safer than fabricating a multi-frequency
  // ladder from nothing. React renders a simplified PriceCard.
  if (!engineInputs) {
    const payload = {
      frequencies: [{
        key: 'quarterly',
        label: 'Quarterly',
        monthly: Number(estimate.monthly_total || 0) || null,
        annual: Number(estimate.annual_total || 0) || null,
        perVisit: null,
        oneTimeTotal: Number(estimate.onetime_total || 0) || null,
        included: [],
        addOns: [],
      }],
      waveGuardTier: estimate.waveguard_tier || 'Bronze',
      anchorOneTimePrice: Number(estimate.onetime_total || 0) || null,
      fallback: 'no_engine_inputs',
    };
    pricingCache.set(estimate.id, { payload, expiresAt: Date.now() + PRICING_TTL_MS });
    return payload;
  }

  const frequencies = [];
  if (canVaryPestFrequency(engineInputs)) {
    // Run the engine 3x with different pest frequencies. Each call is
    // pure JS; no external I/O beyond the engine's own DB constants
    // sync which is cached internally.
    for (const ladder of FREQUENCY_LADDER) {
      const inputsForFrequency = JSON.parse(JSON.stringify(engineInputs));
      inputsForFrequency.services = inputsForFrequency.services || {};
      inputsForFrequency.services.pest = {
        ...(inputsForFrequency.services.pest || {}),
        frequency: ladder.engineFrequency,
      };
      try {
        const engineResult = generateEstimate(inputsForFrequency);
        frequencies.push(shapeFrequencyEntry(ladder, engineResult, engineInputs));
      } catch (err) {
        logger.error(`[estimate-data] engine failed at ${ladder.key}: ${err.message}`);
      }
    }
  } else {
    // No pest in the estimate — slider is meaningless. Single entry
    // using the single engine call at whatever was stored.
    try {
      const engineResult = generateEstimate(engineInputs);
      frequencies.push(shapeFrequencyEntry(FREQUENCY_LADDER[0], engineResult, engineInputs));
    } catch (err) {
      logger.error(`[estimate-data] engine failed (no-pest path): ${err.message}`);
    }
  }

  const anchorOneTimePrice = frequencies[0]?.oneTimeTotal
    ?? (Number(estimate.onetime_total || 0) || null);

  const payload = {
    frequencies,
    waveGuardTier: estimate.waveguard_tier || 'Bronze',
    anchorOneTimePrice,
    source: 'engine_invocation',
  };
  pricingCache.set(estimate.id, { payload, expiresAt: Date.now() + PRICING_TTL_MS });
  return payload;
}

const dataLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
});

router.get('/:token/data', dataLimiter, async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ token: req.params.token }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

    // Always-safe view signals — fire on every 200. Defensive try/catch
    // because schema drift on estimate_views or a locked row shouldn't
    // break the customer-facing endpoint.
    try {
      await db('estimates').where({ id: estimate.id }).update({
        view_count: db.raw('COALESCE(view_count, 0) + 1'),
        last_viewed_at: db.fn.now(),
      });
    } catch (e) { logger.error(`[estimate-data] view tracking failed: ${e.message}`); }

    const ip = extractRequestIp(req);
    try {
      const ua = (req.get('user-agent') || '').slice(0, 1000);
      await db('estimate_views').insert({
        estimate_id: estimate.id,
        viewed_at: db.fn.now(),
        ip: ip || null,
        user_agent: ua || null,
      });
    } catch (e) { logger.warn(`[estimate-data] estimate_views insert skipped: ${e.message}`); }

    // First-view transition — gate on viewed_at IS NULL AND !adminIP.
    // Admin allowlist keeps Virginia's preview clicks from firing the
    // "customer just opened their estimate" office SMS.
    if (!estimate.viewed_at && !isAdminIp(ip)) {
      await db('estimates').where({ id: estimate.id }).update({
        viewed_at: db.fn.now(),
        status: 'viewed',
      }).catch((e) => logger.error(`[estimate-data] first-view flip failed: ${e.message}`));

      try {
        const NotificationService = require('../services/notification-service');
        await NotificationService.notifyAdmin(
          'estimate',
          `Estimate viewed: ${estimate.customer_name}`,
          `${estimate.address || 'no address'} — $${estimate.monthly_total || 0}/mo`,
          { icon: '\u{1F4CB}', link: '/admin/estimates', metadata: { estimateId: estimate.id, customerId: estimate.customer_id } }
        );
      } catch (e) { logger.error(`[notifications] Estimate viewed notification failed: ${e.message}`); }

      try {
        await TwilioService.sendSMS(
          WAVES_OFFICE_PHONE,
          `\u{1F440} ${estimate.customer_name} just opened their estimate ($${estimate.monthly_total || 0}/mo ${estimate.waveguard_tier || ''}). Great time to follow up! ${estimate.customer_phone || ''}`
        );
      } catch (e) { logger.error(`[estimate-data] office SMS failed: ${e.message}`); }
    }

    const pricingBundle = await buildPricingBundle(estimate);

    const terminalState = (() => {
      if (['accepted', 'declined', 'expired'].includes(estimate.status)) return estimate.status;
      if (estimate.expires_at && new Date(estimate.expires_at) < new Date()) return 'expired';
      return null;
    })();

    res.json({
      estimate: {
        id: estimate.id,
        token: estimate.token,
        slug: estimate.estimate_slug || null,
        customerFirstName: (estimate.customer_name || '').split(' ')[0] || null,
        customerName: estimate.customer_name || null,
        customerPhone: estimate.customer_phone || null,
        customerEmail: estimate.customer_email || null,
        address: estimate.address || null,
        category: estimate.category || 'RESIDENTIAL',
        createdAt: estimate.created_at,
        expiresAt: estimate.expires_at,
        status: estimate.status,
        satelliteUrl: estimate.satellite_url || null,
        notes: estimate.notes || null,
        licenseNumber: process.env.WAVES_FDACS_LICENSE || null,
        showOneTimeOption: !!estimate.show_one_time_option,
      },
      pricing: pricingBundle,
      cta: {
        canAccept: terminalState === null,
        terminalState,
      },
      meta: {
        generatedAt: new Date().toISOString(),
        engineVersion: estimate.pricing_version || null,
        cacheHit: !!pricingBundle.cacheHit,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.handleEstimateView = handleEstimateView;
