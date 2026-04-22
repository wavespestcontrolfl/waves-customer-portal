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
      <a href="tel:+19412975749" class="top-phone">(941) 297-5749</a>
      <img src="/waves-logo.png" alt="Waves" class="top-logo"/>
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
  interior_spray:  { perVisit: 10, oneTime: 50, label: 'Interior spraying',  offLabel: 'Exterior service only', offDesc: 'No interior treatment — tech sprays and inspects the perimeter only.' },
  exterior_sweep:  { perVisit: 10, oneTime: 50, label: 'Exterior eave sweep', offLabel: 'Skip eave sweep',       offDesc: 'No eave/cobweb sweep on the exterior. Tech still performs the perimeter treatment.' },
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
function detectPestRecurring(recurring) {
  const pest = (recurring || []).filter((s) => /pest/i.test(String(s.name || '')));
  if (!pest.length) return null;
  const vpy = pest.reduce((acc, s) => Math.max(acc, visitsPerYearFromFrequency(s.frequency || s.billing || s.cadence)), 0) || 4;
  return { count: pest.length, visitsPerYear: vpy };
}

function detectPestOneTime(oneTimeItems) {
  return (oneTimeItems || []).some((it) => /pest|ant|roach|wasp|stinging|exclusion/i.test(String(it.name || '')));
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
function computePrefDiscount(prefs, pestRecurring, hasPestOneTime) {
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

const LOCATIONS = [
  { name: 'Lakewood Ranch', zips: '34202 · 34211 · 34212' },
  { name: 'Parrish / Palmetto', zips: '34219 · 34221' },
  { name: 'Sarasota', zips: '34231 · 34233 · 34238 · 34240 · 34241' },
  { name: 'Venice / North Port', zips: '34285 · 34287 · 34288 · 34293' },
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

function renderTierCard(tier, isSelected, monthlyForTier, locked) {
  const color = tier === 'Platinum' ? BRAND.blueDeeper : tier === 'Gold' ? BRAND.yellow : tier === 'Silver' ? '#94a3b8' : '#c8926c';
  const disc = Math.round((TIER_DISCOUNTS[tier] || 0) * 100);
  const cursor = locked ? 'default' : 'pointer';
  return `<button data-tier="${tier}" class="tier-card${isSelected ? ' selected' : ''}" ${locked ? 'disabled' : ''} style="cursor:${cursor}">
    <div class="tier-name" style="color:${color}">${tier}</div>
    <div class="tier-disc">${disc === 0 ? 'Base pricing' : disc + '% off'}</div>
    <div class="tier-price" data-price-for="${tier}">${fmtMoney(monthlyForTier)}<span class="per">/mo</span></div>
    ${isSelected ? '<div class="tier-badge">Selected</div>' : ''}
  </button>`;
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
  const showPrefs = !!(pestRecurring || hasPestOneTime);
  const prefs = normalizePrefs(estData?.preferences);
  const { monthlyOff: prefMonthlyOff, oneTimeOff: prefOneTimeOff } = computePrefDiscount(prefs, pestRecurring, hasPestOneTime);

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

  const showUpsell = recurring.length === 1;
  const upsellService = showUpsell ? (recurring[0].name === 'Pest Control' ? 'Lawn Care' : 'Pest Control') : null;

  const recurringRows = recurring.map((s) => {
    const mo = Number(s.mo || s.monthly || 0);
    const discounted = Math.round(mo * (1 - TIER_DISCOUNTS[tier]) * 100) / 100;
    return `<tr><td>${escapeHtml(s.name)}</td><td style="text-align:right">${fmtMoney(discounted)}/mo</td></tr>`;
  }).join('');

  const oneTimeRows = oneTimeItems.map((it) => {
    const price = Number(it.price || 0);
    if (price <= 0) return '';
    return `<tr><td>${escapeHtml(it.name)}${it.detail ? `<div class="sub">${escapeHtml(it.detail)}</div>` : ''}</td><td style="text-align:right">${fmtMoney(price)}</td></tr>`;
  }).filter(Boolean).join('');

  const tierCardsHtml = ['Bronze', 'Silver', 'Gold', 'Platinum']
    .map((t) => renderTierCard(t, t === tier, tierPrices[t], locked)).join('');

  const perksHtml = PERKS.map((p) => `<li>${escapeHtml(p)}</li>`).join('');
  const locationsHtml = LOCATIONS.map((l) => `<div class="loc"><strong>${escapeHtml(l.name)}</strong><div class="zips">${escapeHtml(l.zips)}</div></div>`).join('');

  // ── Waves AI analysis block (optional — only renders if we have data) ──
  const ai = estData?.aiAnalysis || estResult?.aiAnalysis || {};
  const aiPalmCount = Number(ai.palm_count) || Number(inputs.palmCount) || null;
  const aiTreeCount = Number(ai.tree_count) || Number(inputs.treeCount) || null;
  const aiShrubDensity = ai.shrub_density || null;
  const aiNotes = (ai.notes || '').trim() || null;
  const aiSources = Array.isArray(ai._sources) ? ai._sources : (Array.isArray(ai.sources) ? ai.sources : null);
  const hasAiBlock = !!(homeSqFt || lotSqFt || lawnSqFt || aiPalmCount || aiTreeCount || aiShrubDensity || aiNotes);
  const aiMetricsArr = [
    homeSqFt ? { label: 'Home', val: `${Math.round(homeSqFt).toLocaleString()} sq ft` } : null,
    lotSqFt ? { label: 'Lot', val: `${Math.round(lotSqFt).toLocaleString()} sq ft` } : null,
    lawnSqFt ? { label: 'Treatable lawn', val: `${Math.round(lawnSqFt).toLocaleString()} sq ft` } : null,
    aiPalmCount != null ? { label: 'Palms', val: String(aiPalmCount) } : null,
    aiTreeCount != null ? { label: 'Trees', val: String(aiTreeCount) } : null,
    aiShrubDensity ? { label: 'Shrub density', val: String(aiShrubDensity).toLowerCase() } : null,
  ].filter(Boolean);
  const aiSourcesLabel = aiSources && aiSources.length
    ? `Analyzed with Waves AI · ${aiSources.join(' + ')}${aiSources.length > 1 ? ' (dual-vision)' : ''}`
    : 'Analyzed with Waves AI · satellite + property records';
  const aiBlockHtml = hasAiBlock ? `
  <section class="card ai-card">
    <div class="eyebrow">Waves AI analysis</div>
    <h2>Here's what we found at your property</h2>
    <div class="ai-grid">
      ${aiMetricsArr.map((m) => `<div class="ai-metric"><div class="ai-metric-label">${escapeHtml(m.label)}</div><div class="ai-metric-val">${escapeHtml(m.val)}</div></div>`).join('')}
    </div>
    ${aiNotes ? `<p class="ai-notes">${escapeHtml(aiNotes)}</p>` : ''}
    <div class="ai-attribution">${escapeHtml(aiSourcesLabel)}</div>
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
  .logo-wrap{display:inline-flex;align-items:center}
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
  .lock-note{margin-top:10px;color:#6B7280;font-size:13px}
  .card{background:#fff;border-radius:14px;padding:24px;margin-bottom:16px;border:1px solid #E7E2D7}
  .card h2{margin:0 0 6px}
  .card h3{margin:0 0 10px}
  .card-sub{color:#6B7280;font-size:14px;margin:0 0 14px}
  .ai-card{background:linear-gradient(180deg,#F5F1E6 0%,#fff 100%)}
  .ai-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:14px}
  @media(max-width:560px){.ai-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  .ai-metric{background:#fff;border:1px solid #E7E2D7;border-radius:10px;padding:10px 12px}
  .ai-metric-label{font-size:11px;color:#6B7280;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
  .ai-metric-val{font-family:'Source Serif 4',Georgia,serif;font-size:18px;font-weight:500;color:#1B2C5B}
  .ai-notes{margin-top:14px;color:#3F4A65;font-size:14px;line-height:1.6;font-style:italic}
  .ai-attribution{margin-top:12px;font-size:11px;color:#6B7280;text-transform:uppercase;letter-spacing:.08em;font-weight:600}
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
  .tier-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:14px}
  @media(max-width:640px){.tier-grid{grid-template-columns:repeat(2,1fr)}}
  .tier-card{background:#fff;border:1px solid #E7E2D7;border-radius:10px;padding:14px 10px;text-align:center;font:inherit;color:inherit;position:relative;transition:all .15s;cursor:pointer}
  .tier-card:not([disabled]):hover{border-color:${BRAND.blueDark}}
  .tier-card.selected{border-color:#1B2C5B;background:#F7F5EE}
  .tier-name{font-weight:600;letter-spacing:.04em;font-size:13px;text-transform:uppercase;margin-bottom:4px;color:#1B2C5B}
  .tier-disc{font-size:11px;color:#6B7280;margin-bottom:8px}
  .tier-price{font-family:'Source Serif 4',Georgia,serif;font-size:22px;font-weight:500;color:#1B2C5B}
  .tier-price .per{font-size:11px;color:#6B7280}
  .tier-badge{position:absolute;top:-8px;left:50%;transform:translateX(-50%);background:#1B2C5B;color:#fff;font-size:9px;padding:3px 8px;border-radius:6px;letter-spacing:.08em;text-transform:uppercase;font-weight:700}
  table{width:100%;border-collapse:collapse}
  td{padding:10px 0;border-bottom:1px solid #E7E2D7;vertical-align:top;font-size:14px}
  tr:last-child td{border-bottom:0}
  td.val{text-align:right;font-weight:500;color:#1B2C5B}
  .sub{font-size:12px;color:#6B7280;margin-top:2px}
  .cta{display:block;width:100%;padding:14px 22px;background:#1B2C5B;color:#fff;border:none;border-radius:10px;font-family:Inter,system-ui,sans-serif;font-weight:500;font-size:16px;cursor:pointer;transition:all .15s;text-align:center;text-decoration:none}
  .cta:hover:not([disabled]){background:#121E3D}
  .cta.secondary{background:transparent;color:#1B2C5B;border:1px solid #1B2C5B}
  .cta[disabled]{opacity:.6;cursor:not-allowed}
  .upsell{background:#F7F5EE;border:1px solid #E7E2D7;border-radius:12px;padding:18px;margin-bottom:16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .upsell .txt{flex:1;min-width:200px}
  .upsell h3{color:#1B2C5B;margin:0 0 4px}
  .upsell-btn{background:#1B2C5B;color:#fff;padding:10px 16px;border-radius:8px;border:none;font-weight:500;cursor:pointer;font-size:14px}
  .steps{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  @media(max-width:640px){.steps{grid-template-columns:1fr}}
  .step{background:#F7F5EE;border-radius:10px;padding:16px;text-align:center;border:1px solid #E7E2D7}
  .step .num{font-family:'Source Serif 4',Georgia,serif;font-size:28px;color:#1B2C5B;line-height:1;font-weight:500}
  .step h4{margin:6px 0 4px;font-size:14px;font-weight:600;color:#1B2C5B}
  .step p{font-size:13px;margin:0;color:#6B7280}
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
  .locs{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
  @media(max-width:640px){.locs{grid-template-columns:repeat(2,1fr)}}
  .loc{background:#F7F5EE;border:1px solid #E7E2D7;border-radius:8px;padding:12px;text-align:center}
  .loc strong{color:#1B2C5B;font-size:13px;display:block}
  .zips{font-size:11px;color:#6B7280;margin-top:4px}
  .final{background:#1B2C5B;color:#fff;text-align:center;padding:32px 24px;border-radius:14px;border:1px solid #1B2C5B}
  .final h2{color:#fff;margin:0 0 8px}
  .final p{color:rgba(255,255,255,.8);font-size:14px}
  .decline{text-align:center;margin-top:12px}
  .decline a{color:#6B7280;font-size:13px;text-decoration:underline}
  .accepted-banner{background:#ECFDF5;border:1px solid ${BRAND.green};color:${BRAND.green};text-align:center;padding:12px 16px;border-radius:10px;margin-bottom:16px;font-weight:500;font-size:14px}
  .footer{text-align:center;padding:32px 20px;color:#6B7280;font-size:12px}
  #toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1B2C5B;color:#fff;padding:12px 20px;border-radius:8px;font-size:14px;opacity:0;pointer-events:none;transition:opacity .2s;z-index:100}
  #toast.show{opacity:1}
</style>
</head><body>

${shellTopBar()}

<div class="wrap">

  ${locked ? `<div class="accepted-banner">✓ You\u2019ve accepted this estimate — we\u2019ll be in touch shortly.</div>` : ''}

  <div class="hero">
    <div class="eyebrow">Your estimate · ${escapeHtml(tier)} WaveGuard</div>
    <h1>Hey ${firstName}, here\u2019s your custom plan.</h1>
    <div class="addr">${address}</div>
    ${propertyLine ? `<div class="prop-meta">${escapeHtml(propertyLine)}</div>` : ''}
    <div class="big-price">
      ${savingsPerMo > 0 ? `<span class="anchor" id="anchor-display">${fmtMoney(baseMonthly)}/mo</span>` : ''}
      <span class="num" id="monthly-display">${fmtMoney(monthlyTotal)}</span>
      <span class="per">/mo</span>
      <span class="tier-lbl" id="tier-display">${escapeHtml(tier)} WaveGuard</span>
    </div>
    <div class="save-row"${savingsPerMo > 0 ? '' : ' style="display:none"'}>
      <span class="save-pill">You save <span id="savings-display">${fmtMoney(savingsPerMo)}</span>/mo with <span id="savings-tier">${escapeHtml(tier)}</span></span>
    </div>
    <div class="day-price">That\u2019s just <span id="day-price">${fmtMoney(dayPrice)}</span>/day for complete home protection.</div>
    <div class="mini-guarantee">Try us risk-free \u2014 90-day money-back guarantee.</div>
    ${annualTotal ? `<div class="lock-note">Locked in for 24 months \u2014 <span id="annual-display">${fmtMoney(annualTotal)}</span>/yr</div>` : ''}
  </div>

  ${aiBlockHtml}

  ${prefsBlockHtml}

  <div class="card">
    <h2>Choose your WaveGuard tier</h2>
    <p class="card-sub">Every qualifying service you bundle unlocks a bigger discount. Tap a tier to re-price.</p>
    <div class="tier-grid">${tierCardsHtml}</div>
  </div>

  ${showUpsell ? `
  <div class="upsell">
    <div class="txt">
      <h3>Add ${escapeHtml(upsellService)} and save more</h3>
      <div style="font-size:14px">Bundling unlocks Silver tier pricing (10% off everything). Curious what that looks like?</div>
    </div>
    <button class="upsell-btn" onclick="inquireBundle('${escapeHtml(upsellService)}')">Get a bundle quote</button>
  </div>` : ''}

  ${locked ? '' : `
  <button class="cta" id="accept-btn" onclick="acceptEstimate()">Accept this estimate \u2192</button>
  <div class="decline"><a href="#" onclick="declineEstimate();return false">No thanks, decline this estimate</a></div>
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
    <h2>How it works</h2>
    <div class="steps">
      <div class="step"><div class="num">1</div><h4>Accept</h4><p>Tap Accept above. We lock in your tier and rate.</p></div>
      <div class="step"><div class="num">2</div><h4>Schedule</h4><p>We call within 24 hours to pick your first visit.</p></div>
      <div class="step"><div class="num">3</div><h4>Relax</h4><p>Recurring service runs on autopilot \u2014 you never lift a finger.</p></div>
    </div>
  </div>

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
    <h3>We serve the whole Suncoast</h3>
    <div class="locs">${locationsHtml}</div>
  </div>

  <div class="final">
    <h2>Ready to lock in <span data-monthly-echo>${fmtMoney(monthlyTotal)}</span>/mo?</h2>
    <p>This rate is yours for the next 24 months. No surprise increases, no hidden fees.</p>
    ${locked ? '' : `<button class="cta" style="max-width:360px;margin:16px auto 0;background:#fff;color:#1B2C5B" onclick="acceptEstimate()">Accept &amp; get started</button>`}
    <div style="margin-top:20px;font-size:14px">
      Questions? Call <a href="tel:+19412975749" style="color:#fff;font-weight:700">(941) 297-5749</a>
    </div>
  </div>

  <div class="footer">
    Waves Pest Control &amp; Lawn Care \u2014 Family-owned, SW Florida<br>
    Licensed &amp; insured \u2022 JE Certified \u2022 Manatee / Sarasota / Charlotte counties
  </div>
</div>

<div id="toast"></div>

<script>
  const TOKEN = ${JSON.stringify(token)};
  const API = '/api/estimates/' + TOKEN;
  const fmt = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const toast = (msg) => { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2800); };

  document.querySelectorAll('.tier-card').forEach((el) => {
    if (el.disabled) return;
    el.addEventListener('click', () => selectTier(el.dataset.tier));
  });

  async function selectTier(newTier) {
    document.querySelectorAll('.tier-card').forEach(el => el.style.opacity = '.5');
    try {
      const r = await fetch(API + '/select-tier', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedTier: newTier })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed');
      document.getElementById('monthly-display').textContent = fmt(data.monthlyTotal);
      document.getElementById('tier-display').textContent = newTier + ' WaveGuard';
      const annualEl = document.getElementById('annual-display'); if (annualEl) annualEl.textContent = fmt(data.annualTotal);
      document.querySelectorAll('[data-monthly-echo]').forEach(el => el.textContent = fmt(data.monthlyTotal));
      const dayEl = document.getElementById('day-price'); if (dayEl) dayEl.textContent = fmt(Math.round((data.monthlyTotal / 30) * 100) / 100);
      const savings = Math.max(0, Math.round((${baseMonthly} - data.monthlyTotal) * 100) / 100);
      const saveRow = document.querySelector('.save-row');
      const savingsEl = document.getElementById('savings-display');
      const savingsTierEl = document.getElementById('savings-tier');
      if (savings > 0) {
        if (savingsEl) savingsEl.textContent = fmt(savings);
        if (savingsTierEl) savingsTierEl.textContent = newTier;
        if (saveRow) saveRow.style.display = '';
        let anchor = document.getElementById('anchor-display');
        if (!anchor) {
          anchor = document.createElement('span');
          anchor.id = 'anchor-display'; anchor.className = 'anchor';
          document.querySelector('.big-price').prepend(anchor);
        }
        anchor.textContent = fmt(${baseMonthly}) + '/mo';
      } else {
        if (saveRow) saveRow.style.display = 'none';
        const anchor = document.getElementById('anchor-display'); if (anchor) anchor.remove();
      }
      document.querySelectorAll('.tier-card').forEach((el) => {
        el.classList.toggle('selected', el.dataset.tier === newTier);
        const badge = el.querySelector('.tier-badge'); if (badge) badge.remove();
        if (el.dataset.tier === newTier) { const b = document.createElement('div'); b.className='tier-badge'; b.textContent='Selected'; el.appendChild(b); }
      });
      toast('Updated to ' + newTier + ' \u2014 ' + fmt(data.monthlyTotal) + '/mo');
    } catch (e) {
      toast('Could not update tier. Try again.');
    } finally {
      document.querySelectorAll('.tier-card').forEach(el => el.style.opacity = '');
    }
  }

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
        const annualEl = document.getElementById('annual-display'); if (annualEl) annualEl.textContent = fmt(data.annualTotal);
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

  async function acceptEstimate() {
    const btn = document.getElementById('accept-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Accepting\u2026'; }
    try {
      const r = await fetch(API + '/accept', { method: 'PUT' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed');
      if (data.onboardingToken) window.location.href = '/onboard/' + data.onboardingToken;
      else { toast('Accepted! We\u2019ll be in touch shortly.'); setTimeout(() => location.reload(), 1200); }
    } catch (e) {
      toast('Could not accept. Call (941) 297-5749 if this keeps happening.');
      if (btn) { btn.disabled = false; btn.textContent = 'Accept this estimate \u2192'; }
    }
  }

  async function declineEstimate() {
    if (!confirm('Are you sure you want to decline this estimate?')) return;
    try {
      await fetch(API + '/decline', { method: 'PUT' });
      toast('Got it \u2014 no worries. Call us if anything changes.');
    } catch (e) { toast('Something went wrong.'); }
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

  async function inquireBundle(svc) {
    try {
      await fetch(API + '/bundle-inquiry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestedService: svc })
      });
      toast('Got it \u2014 we\u2019ll text you a bundle quote shortly.');
    } catch (e) { toast('Could not send. Call (941) 297-5749.'); }
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
    const baseMonthly = Number(parsedData.baseMonthly || parsedData.preDiscountMonthly || estimate.monthly_total || 0);
    const currentTier = estimate.waveguard_tier || 'Bronze';
    const tierDiscount = TIER_DISCOUNTS[currentTier] || 0;

    const { monthlyOff, oneTimeOff } = computePrefDiscount(nextPrefs, pestRecurring, hasPestOneTime);
    const monthlyTotal = Math.max(0, Math.round((baseMonthly * (1 - tierDiscount) - monthlyOff) * 100) / 100);
    const annualTotal  = Math.max(0, Math.round(monthlyTotal * 12 * 100) / 100);
    const onetimeBase = Number(parsedData.onetimeTotalBase || estimate.onetime_total || 0);
    const onetimeTotal = Math.max(0, Math.round((onetimeBase - oneTimeOff) * 100) / 100);
    const tierPrices = {};
    ['Bronze', 'Silver', 'Gold', 'Platinum'].forEach((t) => {
      tierPrices[t] = Math.max(0, Math.round((baseMonthly * (1 - TIER_DISCOUNTS[t]) - monthlyOff) * 100) / 100);
    });

    // Persist — merge new prefs back onto the JSON blob, update totals.
    parsedData.preferences = nextPrefs;
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

// POST /api/estimates/:token/bundle-inquiry — customer interested in bundling
router.post('/:token/bundle-inquiry', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ token: req.params.token }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

    const { suggestedService } = req.body;

    // SMS to office
    try {
      await TwilioService.sendSMS(WAVES_OFFICE_PHONE,
        `\u{1F4E6} Bundle inquiry from ${estimate.customer_name}:\nCurrently quoted: ${estimate.waveguard_tier || 'Bronze'} at $${estimate.monthly_total}/mo\nInterested in adding: ${suggestedService || 'another service'}\nProperty: ${estimate.address || 'N/A'}\nPhone: ${estimate.customer_phone || 'N/A'}`
      );
    } catch (e) { logger.error(`[estimate] Bundle inquiry SMS failed: ${e.message}`); }

    // In-app notification
    try {
      const NotificationService = require('../services/notification-service');
      await NotificationService.notifyAdmin('estimate',
        `Bundle inquiry: ${estimate.customer_name}`,
        `Interested in adding ${suggestedService || 'a service'} to ${estimate.waveguard_tier || 'Bronze'} plan`,
        { icon: '\u{1F4E6}', link: '/admin/estimates', metadata: { estimateId: estimate.id } }
      );
    } catch (e) { logger.error(`[estimate] Bundle inquiry notification failed: ${e.message}`); }

    logger.info(`[estimate] Bundle inquiry from ${estimate.customer_name} — wants ${suggestedService}`);
    res.json({ success: true });
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
