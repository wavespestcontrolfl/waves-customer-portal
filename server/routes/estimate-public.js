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

const TIER_DISCOUNTS = { Bronze: 0, Silver: 0.10, Gold: 0.15, Platinum: 0.18 };

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
<style>body{margin:0;font-family:Inter,system-ui,sans-serif;background:${BRAND.sand};color:${BRAND.navy};display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.box{max-width:520px;background:#fff;border-radius:16px;padding:40px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.06)}h1{font-family:Anton,sans-serif;letter-spacing:.02em;font-size:32px;margin:0 0 12px;color:${BRAND.blueDeeper}}p{line-height:1.6}a.btn{display:inline-block;margin-top:16px;padding:14px 24px;background:${BRAND.blue};color:#fff;text-decoration:none;border-radius:8px;font-weight:600}</style>
</head><body><div class="box"><h1>This Estimate Has Expired</h1>
<p>Hi ${escapeHtml((estimate.customerName || '').split(' ')[0] || 'there')} — the estimate for <strong>${escapeHtml(estimate.address || 'your property')}</strong> is no longer active. Give us a call and we'll put together a fresh one.</p>
<a class="btn" href="tel:+19413187612">Call (941) 318-7612</a></div></body></html>`;
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

  const tierPrices = {};
  ['Bronze', 'Silver', 'Gold', 'Platinum'].forEach((t) => {
    tierPrices[t] = Math.round(baseMonthly * (1 - TIER_DISCOUNTS[t]) * 100) / 100;
  });

  const monthlyTotal = Number(est.monthlyTotal || 0);
  const annualTotal = Number(est.annualTotal || monthlyTotal * 12);
  const onetimeTotal = Number(est.onetimeTotal || 0);
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

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Your Waves Estimate</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Montserrat:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:Inter,system-ui,sans-serif;background:${BRAND.sand};color:${BRAND.navy};line-height:1.55}
  h1,h2,h3{font-family:Montserrat,sans-serif;letter-spacing:-.01em;margin:0 0 12px}
  h1{font-family:Anton,sans-serif;font-weight:400;letter-spacing:.02em;font-size:clamp(32px,6vw,56px);line-height:1.05;color:${BRAND.blueDeeper}}
  h2{font-size:clamp(24px,4vw,36px);color:${BRAND.blueDeeper}}
  h3{font-size:20px;color:${BRAND.blueDark}}
  .wrap{max-width:960px;margin:0 auto;padding:24px}
  .hero{background:linear-gradient(135deg,${BRAND.blueLight} 0%,#fff 100%);border-radius:20px;padding:40px 32px;margin-bottom:24px;border:1px solid rgba(6,90,140,.08)}
  .hero .eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:12px;color:${BRAND.blueDark};font-weight:600;margin-bottom:8px}
  .hero .addr{color:${BRAND.navy};opacity:.72;margin-top:4px;font-size:15px}
  .hero .prop-meta{color:${BRAND.navy};opacity:.55;font-size:13px;font-family:'JetBrains Mono',monospace;margin-top:2px}
  .hero .anchor{font-family:Anton,sans-serif;font-size:clamp(24px,4vw,36px);color:${BRAND.navy};opacity:.4;text-decoration:line-through;margin-right:4px;align-self:flex-end;margin-bottom:10px}
  .save-row{margin-top:12px}
  .save-pill{display:inline-block;background:${BRAND.green};color:#fff;padding:6px 14px;border-radius:999px;font-size:13px;font-weight:700;letter-spacing:.02em}
  .day-price{margin-top:8px;font-size:14px;color:${BRAND.navy};opacity:.75}
  .mini-guarantee{margin-top:10px;font-size:13px;color:${BRAND.blueDark};font-weight:600}
  .big-price{display:flex;align-items:baseline;gap:12px;margin-top:24px;flex-wrap:wrap}
  .big-price .num{font-family:Anton,sans-serif;font-size:clamp(56px,10vw,96px);line-height:1;color:${BRAND.blueDeeper}}
  .big-price .per{font-size:20px;color:${BRAND.navy};opacity:.6}
  .big-price .tier-lbl{display:inline-block;padding:6px 14px;border-radius:999px;background:${BRAND.yellow};color:${BRAND.navy};font-weight:700;font-size:13px;letter-spacing:.08em;text-transform:uppercase}
  .card{background:#fff;border-radius:16px;padding:28px;margin-bottom:20px;border:1px solid rgba(0,0,0,.05);box-shadow:0 2px 8px rgba(0,0,0,.02)}
  .tier-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:18px}
  @media(max-width:640px){.tier-grid{grid-template-columns:repeat(2,1fr)}}
  .tier-card{background:#fff;border:2px solid ${BRAND.sandDark};border-radius:12px;padding:16px 12px;text-align:center;font:inherit;color:inherit;position:relative;transition:all .15s}
  .tier-card:not([disabled]):hover{border-color:${BRAND.blue};transform:translateY(-1px)}
  .tier-card.selected{border-color:${BRAND.blueDeeper};background:${BRAND.blueLight}}
  .tier-name{font-family:Montserrat,sans-serif;font-weight:700;letter-spacing:.04em;font-size:14px;text-transform:uppercase;margin-bottom:6px}
  .tier-disc{font-size:11px;color:${BRAND.navy};opacity:.6;margin-bottom:10px}
  .tier-price{font-family:Anton,sans-serif;font-size:26px;color:${BRAND.blueDeeper}}
  .tier-price .per{font-size:12px;opacity:.5}
  .tier-badge{position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:${BRAND.blueDeeper};color:#fff;font-size:10px;padding:3px 10px;border-radius:999px;letter-spacing:.08em;text-transform:uppercase;font-weight:700}
  table{width:100%;border-collapse:collapse}
  td{padding:10px 0;border-bottom:1px solid ${BRAND.sandDark};vertical-align:top}
  td.val{text-align:right;font-family:'JetBrains Mono',monospace;font-weight:600;color:${BRAND.blueDark}}
  .sub{font-size:12px;color:${BRAND.navy};opacity:.55;margin-top:2px}
  .stack-total{display:flex;justify-content:space-between;align-items:center;margin-top:14px;padding-top:14px;border-top:2px solid ${BRAND.blueDeeper}}
  .stack-total .label{font-family:Montserrat,sans-serif;font-weight:700;font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:${BRAND.navy}}
  .stack-total .v{font-family:Anton,sans-serif;font-size:28px;color:${BRAND.green};text-decoration:line-through;opacity:.75}
  .your-price{background:${BRAND.blueDeeper};color:#fff;padding:24px;border-radius:12px;margin-top:16px;text-align:center}
  .your-price .amt{font-family:Anton,sans-serif;font-size:52px;line-height:1}
  .your-price .per{opacity:.7;font-size:18px}
  .guarantee{background:${BRAND.green};color:#fff;border-radius:12px;padding:24px;margin-bottom:20px}
  .guarantee h3{color:#fff;margin-bottom:8px}
  .cta{display:block;width:100%;padding:18px 24px;background:${BRAND.blue};color:#fff;border:none;border-radius:12px;font-family:Montserrat,sans-serif;font-weight:800;font-size:18px;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;transition:all .15s;text-align:center;text-decoration:none}
  .cta:hover:not([disabled]){background:${BRAND.blueDark};transform:translateY(-1px);box-shadow:0 8px 20px rgba(0,156,222,.3)}
  .cta.secondary{background:transparent;color:${BRAND.blueDark};border:2px solid ${BRAND.blueDark}}
  .cta[disabled]{opacity:.6;cursor:not-allowed}
  .upsell{background:${BRAND.yellow};border-radius:12px;padding:20px;margin-bottom:20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
  .upsell .txt{flex:1;min-width:200px}
  .upsell h3{color:${BRAND.navy};margin:0 0 4px}
  .upsell-btn{background:${BRAND.navy};color:#fff;padding:10px 18px;border-radius:8px;border:none;font-weight:700;cursor:pointer;font-size:14px}
  .steps{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
  @media(max-width:640px){.steps{grid-template-columns:1fr}}
  .step{background:${BRAND.sand};border-radius:12px;padding:20px;text-align:center}
  .step .num{font-family:Anton,sans-serif;font-size:36px;color:${BRAND.blue};line-height:1}
  .step h4{font-family:Montserrat,sans-serif;margin:8px 0 4px;font-size:16px}
  .step p{font-size:14px;margin:0;opacity:.75}
  .perks-list{list-style:none;padding:0;margin:0;columns:2;column-gap:24px}
  @media(max-width:640px){.perks-list{columns:1}}
  .perks-list li{padding:8px 0 8px 28px;position:relative;break-inside:avoid;font-size:14px}
  .perks-list li::before{content:'✓';position:absolute;left:0;color:${BRAND.green};font-weight:700}
  .review-carousel{background:${BRAND.sand};border-radius:12px;padding:28px;min-height:180px;position:relative}
  .review-slide .stars{color:${BRAND.yellow};font-size:20px;margin-bottom:12px;letter-spacing:2px}
  .review-slide p{font-size:15px;margin:0 0 14px;font-style:italic;line-height:1.55}
  .rev-meta{font-size:13px;color:${BRAND.navy};opacity:.7}
  .review-dots{display:flex;justify-content:center;gap:6px;margin-top:16px}
  .review-dots button{width:8px;height:8px;border-radius:50%;border:none;background:${BRAND.sandDark};cursor:pointer;padding:0;transition:all .2s}
  .review-dots button.active{background:${BRAND.blueDeeper};width:20px;border-radius:4px}
  .review-slide{transition:opacity .3s}
  .review-slide.fade{opacity:0}
  .locs{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
  @media(max-width:640px){.locs{grid-template-columns:repeat(2,1fr)}}
  .loc{background:${BRAND.sand};border-radius:10px;padding:14px;text-align:center}
  .loc strong{color:${BRAND.blueDeeper};font-size:14px;display:block}
  .zips{font-family:'JetBrains Mono',monospace;font-size:11px;opacity:.65;margin-top:4px}
  .final{background:${BRAND.blueDeeper};color:#fff;text-align:center;padding:40px 28px;border-radius:20px}
  .final h2{color:#fff}
  .final p{opacity:.85}
  .decline{text-align:center;margin-top:14px}
  .decline a{color:${BRAND.navy};opacity:.5;font-size:13px;text-decoration:underline}
  .accepted-banner{background:${BRAND.green};color:#fff;text-align:center;padding:16px;border-radius:12px;margin-bottom:20px;font-weight:700}
  .footer{text-align:center;padding:40px 20px;opacity:.6;font-size:13px}
  #toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:${BRAND.navy};color:#fff;padding:12px 20px;border-radius:8px;font-size:14px;opacity:0;pointer-events:none;transition:opacity .2s;z-index:100}
  #toast.show{opacity:1}
</style>
</head><body>

<div class="wrap">

  ${locked ? `<div class="accepted-banner">✓ You\u2019ve accepted this estimate — we\u2019ll be in touch shortly.</div>` : ''}

  <div class="hero">
    <div class="eyebrow">Your Waves Estimate</div>
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
    <div class="day-price">That\u2019s just <span id="day-price">${fmtMoney(dayPrice)}</span>/day for complete home protection</div>
    <div class="mini-guarantee">\u{1F6E1}\uFE0F Try us risk-free \u2014 90-day money-back guarantee</div>
    ${annualTotal ? `<div style="margin-top:12px;opacity:.6;font-size:13px">Locked in for 24 months \u2014 <span id="annual-display">${fmtMoney(annualTotal)}</span>/yr</div>` : ''}
  </div>

  <div class="card">
    <h2>Choose your WaveGuard tier</h2>
    <p style="margin:0 0 4px;opacity:.7">Every qualifying service you bundle unlocks a bigger discount. Click a tier to re-price.</p>
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
    ${locked ? '' : `<button class="cta" style="max-width:360px;margin:16px auto 0;background:${BRAND.yellow};color:${BRAND.navy}" onclick="acceptEstimate()">Accept &amp; Get Started</button>`}
    <div style="margin-top:20px;font-size:14px">
      Questions? Call <a href="tel:+19413187612" style="color:#fff;font-weight:700">(941) 318-7612</a>
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
      toast('Could not accept. Call (941) 318-7612 if this keeps happening.');
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
    } catch (e) { toast('Could not send. Call (941) 318-7612.'); }
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
        `<!doctype html><html><head><meta charset="utf-8"><title>Not Found</title></head><body style="font-family:system-ui;padding:40px;text-align:center"><h1>Estimate Not Found</h1><p>This link may have expired. Call <a href="tel:+19413187612">(941) 318-7612</a>.</p></body></html>`
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
      if (raw === 'deposit_now' || raw === 'pay_at_visit') return raw;
      return null;
    })();
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
        await EstimateConverter.convertEstimate(estimate.id);
        logger.info(`[estimate-accept] Auto-conversion completed for estimate ${estimate.id}`);
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
