const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const smsTemplatesRouter = require('./admin-sms-templates');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');
const { shortenOrPassthrough } = require('../services/short-url');

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

// Palette mirrors wavespestcontrol.com (van-wrap spec). `sand` keys retained
// as semantic names (soft background / subtle border) but re-valued off the
// warm tan to the cool neutral ramp so the page reads as the marketing brand.
const BRAND = {
  blue: '#009CDE', blueDark: '#065A8C', blueDeeper: '#1B2C5B', blueLight: '#E3F5FD',
  sky: '#4DC9F6',
  yellow: '#FFD700', yellowHover: '#FFF176',
  navy: '#1B2C5B', green: '#16A34A', red: '#C8102E',
  sand: '#F8FAFC', sandDark: '#E2E8F0',
  buttonInfo: '#2E7DB3', buttonInfoHover: '#256BA0',
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
  {
    name: 'Waves Pest Control Lakewood Ranch',
    phone: '(941) 318-7612',
    mapUrl: 'https://www.google.com/maps?cid=14759626783082699860',
    embedSrc: 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3541.151807037953!2d-82.4055316!3d27.4333793!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x284c3266284eb055%3A0xccd4ba5bfefc5c54!2sWaves%20Pest%20Control%20Lakewood%20Ranch!5e0!3m2!1sen!2sus!4v1776317197674!5m2!1sen!2sus',
  },
  {
    name: 'Waves Pest Control Parrish',
    phone: '(941) 297-2817',
    mapUrl: 'https://www.google.com/maps?cid=11265402721490483375',
    embedSrc: 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3537.1305708768577!2d-82.4408101!3d27.5584579!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x88c32512419a7d33%3A0x9c56c016aa28b8af!2sWaves%20Pest%20Control%20Parrish!5e0!3m2!1sen!2sus!4v1776310825150!5m2!1sen!2sus',
  },
  {
    name: 'Waves Pest Control Sarasota',
    phone: '(941) 297-2606',
    mapUrl: 'https://www.google.com/maps?cid=15895756394247959321',
    embedSrc: 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3543.340049662871!2d-82.4190074!3d27.3650936!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x88c339f6dffa3f79%3A0xdc991238a34b3319!2sWaves%20Pest%20Control%20Sarasota!5e0!3m2!1sen!2sus!4v1776317172363!5m2!1sen!2sus',
  },
  {
    name: 'Waves Pest Control Venice',
    phone: '(941) 297-3337',
    mapUrl: 'https://www.google.com/maps/place/Waves+Pest+Control+Venice/data=!4m2!3m1!1s0x0:0x41ab293594e64044',
    embedSrc: 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3553.079697131089!2d-82.4149843!3d27.0592322!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x88c359b9ade65bf3%3A0x41ab293594e64044!2sWaves%20Pest%20Control%20Venice!5e0!3m2!1sen!2sus!4v1776310871391!5m2!1sen!2sus',
  },
];

// Curated Google reviews — mirrors wavespestcontrol-astro/src/components/ReviewSection.astro
const REVIEWS = [
  { name: 'Kevin Ritter', location: 'Lakewood Ranch, FL', text: "We recently engaged Waves for our pest control needs. Adam provided an extensive overview of his services and quoted a vastly more competitive rate. After two service calls we're not only impressed by Adam's expertise but the level of service provided by Waves is absolutely astonishing (we're from New York and that's not easily done). Waves deserves 10 stars and should be everyone's choice for pest care." },
  { name: 'Stan Tusinski', location: 'Parrish, FL', text: "My fianc\u00e9 and I live in Parrish \u2014 she, I, and our two dogs were attacked by Africanized killer bees. We almost lost one of our dogs and needed to remediate the situation immediately. I contacted Adam at Waves and he was quick to respond. The Waves team came out within 24 hours, assessed the situation and executed a successful plan to eliminate the entire hive. Thank you Adam and the entire Waves team!" },
  { name: 'Angie Fedele', location: 'Sarasota, FL', text: "Adam was amazing. He came out the same day for a very last minute call. Not only did he spend time understanding our problem and explaining everything in detail, he also came back twice to make sure we caught the mice. We appreciated his attention so much we had him come back out to spray for ants too. Excellent service \u2014 we'll definitely continue to use this company for all of our pest needs." },
  { name: 'Madison Moburg', location: 'Bradenton, FL', text: "Currently renting and have been using Adam with Waves throughout our lease. Adam is very responsive and thorough. He has come out to inspect the status of things before deciding what's best for our house. Appreciate his quick response and coming out when I reach out. We'd use Adam for future pest control needs when we move out of our lease! Highly recommend." },
  { name: 'Daniel Stenham', location: 'Sarasota, FL', text: "Absolutely shocked at the service Waves provides! Called on a Sunday morning and an actual person answered and scheduled our appointment for the next day. Came on time, took care of the issue, recommended simple care we can do on our own, and never tried to sell me a monthly service. Even went to a neighbor's house to analyze their situation without an appointment. The kind of service we've all forgotten about. Highly Recommend!!!" },
  { name: 'The Drip Chick', location: 'Bradenton, FL', text: "I can't say enough good things about Waves Pest Control! The technician showed up right on time, was incredibly professional, and took the time to explain everything. He didn't just treat the obvious spots \u2014 he inspected every corner of my home and pointed out small issues I never would have noticed. Adam gave honest, clear answers, no upselling. After the treatment I noticed results almost immediately." },
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
  const customerPhone = est.customerPhone || '';
  const phoneDigits = String(customerPhone).replace(/\D/g, '');
  const phoneFormatted = phoneDigits.length === 10
    ? `(${phoneDigits.slice(0, 3)}) ${phoneDigits.slice(3, 6)}-${phoneDigits.slice(6)}`
    : (phoneDigits.length === 11 && phoneDigits.startsWith('1')
        ? `(${phoneDigits.slice(1, 4)}) ${phoneDigits.slice(4, 7)}-${phoneDigits.slice(7)}`
        : customerPhone);
  const customerEmail = est.customerEmail || '';

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
  const propertyStats = [
    homeSqFt ? { label: 'Home', value: `${Math.round(homeSqFt).toLocaleString()} sq ft` } : null,
    lotSqFt ? { label: 'Lot', value: `${Math.round(lotSqFt).toLocaleString()} sq ft` } : null,
    lawnSqFt ? { label: 'Treatable lawn', value: `${Math.round(lawnSqFt).toLocaleString()} sq ft` } : null,
  ].filter(Boolean);

  const contactLine = [
    phoneFormatted ? `<a href="tel:+${phoneDigits}" style="color:inherit;text-decoration:none">${escapeHtml(phoneFormatted)}</a>` : null,
    customerEmail ? `<a href="mailto:${escapeHtml(customerEmail)}" style="color:inherit;text-decoration:none">${escapeHtml(customerEmail)}</a>` : null,
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
  const locationsHtml = LOCATIONS.map((l) => `
    <a class="loc-card" href="${escapeHtml(l.mapUrl)}" target="_blank" rel="noopener noreferrer">
      <div class="loc-map">
        <iframe src="${escapeHtml(l.embedSrc)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="${escapeHtml(l.name)}"></iframe>
      </div>
      <div class="loc-body">
        <div class="loc-row">
          <h3>${escapeHtml(l.name)}</h3>
          <div class="loc-phone">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z"/></svg>
            ${escapeHtml(l.phone)}
          </div>
        </div>
        <div class="loc-foot">
          <span class="rc-stars" aria-hidden="true">\u2605\u2605\u2605\u2605\u2605</span>
          <span class="on-google">5.0 on Google</span>
          <span class="dir">Get Directions \u2192</span>
        </div>
      </div>
    </a>`).join('');
  const googleG = `<svg class="rc-google" viewBox="0 0 48 48" aria-label="Google review">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>`;
  const reviewCard = (r, i) => `<article class="review-card"${i >= REVIEWS.length ? ' aria-hidden="true"' : ''}>
      ${googleG}
      <div class="meta">
        <div class="name">${escapeHtml(r.name)}</div>
        <div class="loc">${escapeHtml(r.location)}</div>
      </div>
      <div class="rc-stars" aria-label="5 star rating">\u2605\u2605\u2605\u2605\u2605</div>
      <p class="body">${escapeHtml(r.text)}</p>
    </article>`;
  const reviewsHtml = [...REVIEWS, ...REVIEWS].map(reviewCard).join('');

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
  body{margin:0;font-family:Inter,system-ui,sans-serif;background:${BRAND.sand};color:${BRAND.navy};line-height:1.55;padding-top:56px}
  h1,h2,h3{font-family:Montserrat,sans-serif;letter-spacing:-.01em;margin:0 0 8px;color:${BRAND.navy}}
  h1{font-weight:700;font-size:26px;line-height:1.2}
  .hero h1{margin-top:18px}
  h2{font-weight:700;font-size:22px;line-height:1.2}
  h3{font-size:16px;font-weight:700}
  .wrap{max-width:960px;margin:0 auto;padding:40px 24px}
  .video-hero{position:relative;overflow:hidden;background:${BRAND.blueDeeper};min-height:200px}
  .video-hero video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.45;pointer-events:none}
  .hero{background:#fff;border-radius:12px;padding:40px 24px;margin-bottom:24px;border:1px solid #e2e8f0}
  .hero .eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:11px;color:${BRAND.blue};font-weight:600;margin-bottom:6px;opacity:.8}
  .hero .addr{color:${BRAND.navy};opacity:.7;margin-top:4px;font-size:14px}
  .hero .contact{color:${BRAND.navy};opacity:.7;margin-top:2px;font-size:14px}
  .hero .contact a:hover{color:${BRAND.blue};text-decoration:underline}
  .hero .quote-note{color:${BRAND.navy};opacity:.7;font-size:13px;line-height:1.55;margin:10px 0 4px;max-width:640px}
  .hero .prop-stats{list-style:none;padding:0;margin:10px 0 0;display:flex;flex-wrap:wrap;gap:6px}
  .hero .prop-stats li{display:inline-flex;align-items:baseline;gap:6px;padding:5px 10px;border:1px solid #e2e8f0;border-radius:8px;background:${BRAND.sand};font-size:12px}
  .hero .prop-stats .k{color:${BRAND.navy};opacity:.55;text-transform:uppercase;letter-spacing:.08em;font-size:10px;font-weight:600}
  .hero .prop-stats .v{color:${BRAND.navy};font-weight:600;font-family:'JetBrains Mono',monospace}
  .hero .anchor{font-family:Montserrat,sans-serif;font-weight:600;font-size:18px;color:${BRAND.navy};opacity:.4;text-decoration:line-through;margin-right:4px;align-self:flex-end;margin-bottom:6px}
  .save-row{margin-top:10px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  .save-pill{display:inline-block;background:rgba(16,185,129,.12);color:#047857;padding:4px 10px;border-radius:999px;font-size:14px;font-weight:700;letter-spacing:.02em}
  .day-pill{display:inline-block;background:${BRAND.blueLight};color:${BRAND.blueDark};padding:4px 10px;border-radius:999px;font-size:14px;font-weight:700;letter-spacing:.02em}
  .hero-cta{margin-top:20px;padding-top:18px;border-top:1px solid #e2e8f0}
  .big-price{display:flex;align-items:baseline;gap:10px;margin-top:18px;flex-wrap:wrap}
  .big-price .num{font-family:Montserrat,sans-serif;font-weight:800;font-size:clamp(52px,8vw,64px);line-height:1;color:${BRAND.navy};letter-spacing:-.03em}
  .big-price .per{font-size:18px;color:${BRAND.navy};opacity:.5}
  .big-price .tier-lbl{display:inline-block;padding:4px 10px;border-radius:999px;background:${BRAND.blueLight};color:${BRAND.blueDark};font-weight:700;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
  .card{background:#fff;border-radius:12px;padding:28px 24px;margin-bottom:24px;border:1px solid #e2e8f0;box-shadow:0 1px 2px rgba(15,23,42,.03)}
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
  /* CTA mirrors .btn-primary from wavespestcontrol.com: gold pill, navy border, navy 4x4 offset shadow. */
  .cta{display:block;width:100%;max-width:360px;margin:0 auto;padding:12px 20px;background:${BRAND.yellow};color:${BRAND.navy};border:2px solid ${BRAND.navy};border-radius:10px;font-family:Inter,system-ui,sans-serif;font-weight:800;font-size:14px;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;transition:background-color .15s,transform .15s,box-shadow .15s;text-align:center;text-decoration:none;box-shadow:3px 3px 0 ${BRAND.navy};-webkit-tap-highlight-color:transparent;touch-action:manipulation}
  .cta:hover:not([disabled]){background:${BRAND.yellowHover};transform:translate(-2px,-2px);box-shadow:5px 5px 0 ${BRAND.navy}}
  .cta:active:not([disabled]){transform:translate(1px,1px);box-shadow:1px 1px 0 ${BRAND.navy}}
  .cta:focus-visible{outline:3px solid ${BRAND.yellow};outline-offset:3px}
  .cta.secondary{background:${BRAND.navy};color:${BRAND.yellow};border:2px solid ${BRAND.yellow};box-shadow:3px 3px 0 ${BRAND.yellow}}
  .cta.secondary:hover:not([disabled]){background:${BRAND.blueDeeper};transform:translate(-2px,-2px);box-shadow:5px 5px 0 ${BRAND.yellow}}
  .cta.secondary:active:not([disabled]){transform:translate(1px,1px);box-shadow:1px 1px 0 ${BRAND.yellow}}
  .cta[disabled]{opacity:.55;cursor:not-allowed;transform:none;box-shadow:3px 3px 0 ${BRAND.navy}}
  /* on-dark: used when the button sits on a dark band (.final). Frame + shadow swap from navy → gold so the pill is still visible. */
  .cta.on-dark{border-color:${BRAND.yellow};box-shadow:4px 4px 0 ${BRAND.yellow}}
  .cta.on-dark:hover:not([disabled]){box-shadow:6px 6px 0 ${BRAND.yellow}}
  .cta.on-dark:active:not([disabled]){box-shadow:1px 1px 0 ${BRAND.yellow}}
  .cta.on-dark[disabled]{box-shadow:4px 4px 0 ${BRAND.yellow}}
  @media (prefers-reduced-motion:reduce){.cta,.cta:hover,.cta:active{transform:none}}
  .upsell{background:#fff;border:1px solid ${BRAND.yellow};border-radius:12px;padding:16px;margin-bottom:16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .upsell .txt{flex:1;min-width:200px}
  .upsell h3{color:${BRAND.navy};margin:0 0 2px;font-size:15px}
  .upsell-btn{background:${BRAND.navy};color:#fff;padding:8px 14px;border-radius:8px;border:none;font-weight:700;cursor:pointer;font-size:13px}
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
  .review-section{background:${BRAND.sand};color:${BRAND.navy};padding:48px 0;margin:24px 20px;overflow:hidden;position:relative;border:1px solid #e2e8f0;border-radius:16px}
  @media(min-width:1000px){.review-section{margin:28px auto;max-width:960px}}
  .review-section .header{text-align:center;max-width:640px;margin:0 auto 22px;padding:0 20px}
  .review-section .header h2{font-family:Montserrat,sans-serif;font-weight:700;letter-spacing:-.01em;color:${BRAND.navy};font-size:22px;line-height:1.2;margin:0 0 6px}
  .review-section .header p{font-size:14px;color:${BRAND.navy};opacity:.7;margin:0 auto;max-width:440px;line-height:1.5}
  .review-slider{position:relative;overflow:hidden}
  .review-track{display:flex;align-items:stretch;gap:16px;padding:4px 20px;width:max-content;animation:review-scroll 90s linear infinite}
  .review-slider:hover .review-track{animation-play-state:paused}
  @keyframes review-scroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}
  @media(prefers-reduced-motion:reduce){.review-track{animation:none}}
  .review-card{position:relative;flex-shrink:0;width:min(80vw,280px);background:#fff;border-radius:12px;border:1px solid #e2e8f0;box-shadow:0 1px 2px rgba(15,23,42,.04);padding:14px 16px;display:flex;flex-direction:column;font-family:inherit}
  .review-card .rc-google{position:absolute;top:12px;right:12px;width:16px;height:16px}
  .review-card .meta{min-width:0;margin-bottom:8px;padding-right:24px}
  .review-card .name{font-size:13px;font-weight:600;color:${BRAND.navy};line-height:1.1}
  .review-card .loc{font-size:11px;color:${BRAND.navy};opacity:.55;margin-top:2px}
  .review-card .rc-stars{color:${BRAND.yellow};font-size:12px;letter-spacing:1px;line-height:1;margin-bottom:6px}
  .review-card .body{font-size:12.5px;line-height:1.5;color:${BRAND.navy};opacity:.78;flex:1;margin:0;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
  .locations-section{background:${BRAND.blue};color:#fff;padding:72px 24px;margin:40px 0}
  .locations-section .loc-header{text-align:center;max-width:640px;margin:0 auto 40px}
  .locations-section .loc-header h2{font-family:Anton,sans-serif;font-weight:400;letter-spacing:.02em;color:#fff;font-size:clamp(30px,4vw,54px);line-height:1.1;margin:0 0 12px}
  .locations-section .loc-header p{font-size:18px;color:#fff;opacity:.95;margin:0;line-height:1.55;font-weight:500}
  .loc-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:24px;max-width:1080px;margin:0 auto}
  @media(max-width:720px){.loc-grid{grid-template-columns:1fr}}
  .loc-card{display:block;background:#fff;border-radius:16px;border:2px solid #e2e8f0;overflow:hidden;text-decoration:none;color:inherit;transition:border-color .2s,box-shadow .2s,transform .2s}
  .loc-card:hover{border-color:${BRAND.blue};box-shadow:0 20px 40px -20px rgba(0,0,0,.35);transform:translateY(-2px)}
  .loc-map{aspect-ratio:16/9;background:${BRAND.blueLight};position:relative}
  .loc-map iframe{width:100%;height:100%;border:0;display:block}
  .loc-body{padding:18px 20px}
  .loc-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
  .loc-body h3{font-family:Montserrat,sans-serif;font-size:17px;font-weight:700;color:${BRAND.blue};margin:0;line-height:1.25}
  .loc-phone{flex-shrink:0;display:inline-flex;align-items:center;gap:6px;background:${BRAND.blueLight};color:${BRAND.blue};font-size:12px;font-weight:700;padding:6px 12px;border-radius:999px;white-space:nowrap}
  .loc-phone svg{width:14px;height:14px}
  .loc-foot{display:flex;align-items:center;gap:10px;margin-top:12px}
  .loc-foot .rc-stars{color:${BRAND.yellow};font-size:14px;letter-spacing:1px;line-height:1}
  .loc-foot .on-google{font-size:12px;font-weight:600;color:#64748b}
  .loc-foot .dir{margin-left:auto;font-size:12px;font-weight:700;color:${BRAND.blue}}
  .loc-card:hover .dir{text-decoration:underline}
  .final{background:#fff;color:${BRAND.navy};text-align:center;padding:48px 24px;border-radius:12px;border:1px solid #e2e8f0}
  .final h2{color:${BRAND.navy};font-size:20px;margin-bottom:6px}
  .final p{opacity:.7;font-size:14px;margin:0}
  .final a{color:${BRAND.blue} !important}
  .decline{text-align:center;margin-top:14px}
  .decline a{color:${BRAND.navy};opacity:.5;font-size:13px;text-decoration:underline}
  .accepted-banner{background:${BRAND.green};color:#fff;text-align:center;padding:16px;border-radius:12px;margin-bottom:20px;font-weight:700}
  .brand-footer{text-align:center;margin-top:24px;padding-top:20px;border-top:1px solid #e2e8f0}
  .brand-footer .loop{font-size:12px;font-weight:600;color:${BRAND.navy};opacity:.7;font-family:Montserrat,sans-serif;margin-bottom:10px}
  .brand-footer .socials{display:flex;gap:8px;justify-content:center;margin-bottom:12px}
  .brand-footer .socials a{width:28px;height:28px;border-radius:50%;background:transparent;border:1px solid #e2e8f0;color:${BRAND.navy};opacity:.7;display:flex;align-items:center;justify-content:center;text-decoration:none;transition:opacity .15s,border-color .15s,color .15s}
  .brand-footer .socials a:hover{opacity:1;border-color:${BRAND.blue};color:${BRAND.blue}}
  .brand-footer .socials svg{width:12px;height:12px;fill:currentColor}
  .brand-footer .tag{font-size:12px;color:${BRAND.navy};opacity:.7;font-weight:600;font-family:Montserrat,sans-serif;margin-bottom:8px}
  .brand-footer .logo{height:20px;opacity:.45;margin-bottom:6px}
  .brand-footer .name{font-size:12px;font-weight:700;color:${BRAND.navy};font-family:Montserrat,sans-serif}
  .brand-footer .desc{font-size:11px;color:${BRAND.navy};opacity:.6;margin-top:3px;line-height:1.5}
  .brand-footer .cities{font-size:11px;color:${BRAND.navy};opacity:.55;margin-top:4px;line-height:1.5}
  .brand-footer .cities a{color:inherit;text-decoration:none;transition:color .15s,opacity .15s}
  .brand-footer .cities a:hover{color:${BRAND.blue};text-decoration:underline}
  .brand-footer .copy{font-size:10px;color:${BRAND.navy};opacity:.4;margin-top:10px}
  #toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:${BRAND.navy};color:#fff;padding:12px 20px;border-radius:8px;font-size:14px;opacity:0;pointer-events:none;transition:opacity .2s;z-index:100}
  #toast.show{opacity:1}
  .ai-bar{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin-bottom:16px;box-shadow:0 1px 2px rgba(15,23,42,.03)}
  .ai-head{display:flex;align-items:center;gap:10px;font-size:12px;color:${BRAND.navy};opacity:.75;margin-bottom:10px}
  .ai-dot{width:8px;height:8px;border-radius:50%;background:${BRAND.blue};box-shadow:0 0 0 4px rgba(0,156,222,.18);flex-shrink:0;animation:ai-pulse 2s ease-in-out infinite}
  @keyframes ai-pulse{0%,100%{box-shadow:0 0 0 4px rgba(0,156,222,.18)}50%{box-shadow:0 0 0 7px rgba(0,156,222,.08)}}
  .ai-form{display:flex;gap:8px}
  .ai-form input{flex:1;padding:12px 14px;border:1px solid ${BRAND.sandDark};border-radius:10px;font-family:inherit;font-size:15px;background:${BRAND.sand};color:${BRAND.navy};outline:none;transition:border-color .15s}
  .ai-form input:focus{border-color:${BRAND.blue};background:#fff}
  .ai-form button{padding:12px 20px;background:${BRAND.buttonInfo};color:#fff;border:2px solid ${BRAND.navy};border-radius:10px;font-family:Inter,system-ui,sans-serif;font-weight:800;letter-spacing:.04em;text-transform:uppercase;font-size:14px;cursor:pointer;box-shadow:3px 3px 0 ${BRAND.navy};transition:background-color .15s,transform .15s,box-shadow .15s;white-space:nowrap;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
  .ai-form button:hover:not(:disabled){background:${BRAND.buttonInfoHover};transform:translate(-2px,-2px);box-shadow:5px 5px 0 ${BRAND.navy}}
  .ai-form button:active:not(:disabled){transform:translate(1px,1px);box-shadow:1px 1px 0 ${BRAND.navy}}
  .ai-form button:disabled{opacity:.5;cursor:wait;transform:none;box-shadow:3px 3px 0 ${BRAND.navy}}
  .ai-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
  .ai-chip{background:${BRAND.blueLight};color:${BRAND.blueDark};border:none;padding:6px 12px;border-radius:999px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .15s}
  .ai-chip:hover{background:${BRAND.blue};color:#fff}
  .ai-thread{margin-top:14px;display:flex;flex-direction:column;gap:10px}
  .ai-msg{padding:12px 14px;border-radius:12px;font-size:14px;line-height:1.55;max-width:92%;white-space:pre-wrap}
  .ai-msg.user{align-self:flex-end;background:${BRAND.blueDeeper};color:#fff}
  .ai-msg.bot{align-self:flex-start;background:${BRAND.sand};color:${BRAND.navy};border:1px solid ${BRAND.sandDark}}
  .ai-msg.bot.thinking{opacity:.6;font-style:italic}
  .ai-msg.bot.error{background:#fef2f2;border-color:#fecaca;color:${BRAND.red}}
  /* Top nav (fixed, hamburger on mobile) */
  .nav-bar{position:fixed;top:0;left:0;right:0;z-index:60;background:rgba(255,255,255,.94);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid #e2e8f0;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;min-height:56px}
  .nav-bar .brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:${BRAND.navy}}
  .nav-bar .brand img{height:28px;width:auto}
  .nav-bar .brand-text{font-family:Montserrat,sans-serif;font-weight:700;font-size:15px;color:${BRAND.navy}}
  .nav-bar .hamburger{width:48px;height:48px;background:transparent;border:none;cursor:pointer;padding:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;border-radius:8px;transition:background .15s;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
  .nav-bar .hamburger:hover{background:rgba(15,23,42,.04)}
  .nav-bar .hamburger span{display:block;width:22px;height:2px;background:${BRAND.navy};border-radius:2px;transition:transform .22s,opacity .22s}
  .nav-bar .hamburger.open span:nth-child(1){transform:translateY(7px) rotate(45deg)}
  .nav-bar .hamburger.open span:nth-child(2){opacity:0}
  .nav-bar .hamburger.open span:nth-child(3){transform:translateY(-7px) rotate(-45deg)}
  .nav-menu{position:fixed;top:56px;left:0;right:0;z-index:55;background:#fff;border-bottom:1px solid #e2e8f0;box-shadow:0 8px 20px rgba(15,23,42,.08);transform:translateY(-110%);transition:transform .22s ease-out;padding:8px 16px 16px;max-height:calc(100vh - 56px);overflow-y:auto}
  .nav-menu.open{transform:translateY(0)}
  .nav-menu a{display:flex;align-items:center;gap:12px;padding:14px 8px;color:${BRAND.navy};text-decoration:none;font-weight:600;font-size:15px;border-bottom:1px solid #e2e8f0;min-height:48px}
  .nav-menu a:last-child{border-bottom:none}
  .nav-menu a:hover{color:${BRAND.blue}}
  .nav-menu svg{width:18px;height:18px;opacity:.6}

  /* Trust strip 2×2 */
  .trust-strip{list-style:none;padding:0;margin:20px 0 0;display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .trust-strip li{display:flex;align-items:center;gap:8px;padding:12px 10px;background:${BRAND.sand};border:1px solid #e2e8f0;border-radius:10px;font-size:13px;font-weight:600;color:${BRAND.navy};line-height:1.25}
  .trust-strip svg{width:16px;height:16px;flex-shrink:0;color:${BRAND.green}}

  /* Stacked hero CTAs */
  .hero-cta .cta{margin-bottom:10px}
  .hero-cta .cta:last-of-type{margin-bottom:0}
  .cta.white{background:#fff;color:${BRAND.navy};border:2px solid ${BRAND.navy};box-shadow:3px 3px 0 ${BRAND.navy}}
  .cta.white:hover:not([disabled]){background:#f8fafc;transform:translate(-2px,-2px);box-shadow:5px 5px 0 ${BRAND.navy}}
  .cta.white:active:not([disabled]){transform:translate(1px,1px);box-shadow:1px 1px 0 ${BRAND.navy}}
  .cta.white svg{width:15px;height:15px;margin-right:6px;vertical-align:-2px}

  /* Sticky bottom bar: gold ACCEPT + white CALL (48px touch targets, safe-area-aware) */
  .sticky-cta{position:fixed;left:0;right:0;bottom:0;z-index:50;background:rgba(255,255,255,.96);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-top:1px solid #e2e8f0;padding:10px 16px calc(12px + env(safe-area-inset-bottom));display:flex;align-items:center;gap:10px;transform:translateY(100%);transition:transform .22s ease-out;box-shadow:0 -4px 12px rgba(15,23,42,.06)}
  .sticky-cta.show{transform:translateY(0)}
  .sticky-cta .cta{margin:0;max-width:none;flex:1 1 50%;padding:14px 8px;font-size:13px;min-height:48px;box-shadow:2px 2px 0 ${BRAND.navy}}
  .sticky-cta .cta.white{box-shadow:2px 2px 0 ${BRAND.navy}}
  .sticky-cta .cta:hover:not([disabled]),.sticky-cta .cta:active:not([disabled]){transform:none;box-shadow:2px 2px 0 ${BRAND.navy}}
  @media(min-width:768px){.sticky-cta{display:none}}
  body.has-sticky-cta{padding-bottom:calc(88px + env(safe-area-inset-bottom))}
</style>
</head><body>

<header class="nav-bar">
  <a class="brand" href="https://wavespestcontrol.com" aria-label="Waves Pest Control">
    <img src="/waves-logo.png" alt=""><span class="brand-text">Waves</span>
  </a>
  <button class="hamburger" id="hamburger" aria-label="Menu" aria-expanded="false" aria-controls="nav-menu">
    <span></span><span></span><span></span>
  </button>
</header>
<nav class="nav-menu" id="nav-menu" aria-hidden="true">
  <a href="tel:${WAVES_OFFICE_PHONE}"><svg viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z"/></svg>Call (941) 318-7612</a>
  <a href="mailto:contact@wavespestcontrol.com"><svg viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M3 4h14a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1zm.5 2l6.5 4.5L16.5 6v-.5H3.5V6z"/></svg>Email us</a>
  <a href="#ai-bar"><svg viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M10 2a8 8 0 100 16 8 8 0 000-16zm-.5 3h1a.5.5 0 01.5.5v5a.5.5 0 01-.5.5h-1a.5.5 0 01-.5-.5v-5a.5.5 0 01.5-.5zm.5 8.5a1 1 0 110 2 1 1 0 010-2z"/></svg>Ask a question</a>
  <a href="https://wavespestcontrol.com" target="_blank" rel="noopener"><svg viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 2c1.3 0 2.8 1.8 3.4 4.5H6.6C7.2 5.8 8.7 4 10 4zm-5.9 5.5h2.3c-.1.8-.2 1.6-.2 2.5s.1 1.7.2 2.5H4.1a6 6 0 010-5zm1.5 6.5h2.3c.2 1 .5 1.9.9 2.7A6 6 0 015.6 14zm3.9 0h4.9c-.6 2.7-2.1 4.5-3.4 4.5s-2.8-1.8-3.4-4.5zm4.9-1.5H6.6c-.1-.8-.2-1.6-.2-2.5s.1-1.7.2-2.5h8.8c.1.8.2 1.6.2 2.5s-.1 1.7-.2 2.5zm.5 1.5h-2.3c-.2 1-.5 1.9-.9 2.7a6 6 0 003.2-2.7zm-2.3-6h2.3a6 6 0 00-3.2-2.7c.4.8.7 1.7.9 2.7z"/></svg>About Waves</a>
</nav>

<div class="video-hero" aria-hidden="true">
  <video autoplay muted loop playsinline preload="none" poster="/brand/waves-hero-service.webp">
    <source src="/brand/waves-hero-service.mp4" type="video/mp4">
  </video>
</div>

<div class="wrap">

  ${locked ? `<div class="accepted-banner">✓ You\u2019ve accepted this estimate — we\u2019ll be in touch shortly.</div>` : ''}

  <div class="hero">
    <div class="eyebrow">Your Waves Estimate</div>
    <div class="addr">${address}</div>
    ${contactLine ? `<div class="contact">${contactLine}</div>` : ''}
    ${propertyStats.length ? `<ul class="prop-stats">${propertyStats.map((s) => `<li><span class="k">${escapeHtml(s.label)}</span><span class="v">${escapeHtml(s.value)}</span></li>`).join('')}</ul>` : ''}
    <h1>Hey ${firstName}, here\u2019s your custom plan!</h1>
    <div class="quote-note">This price is <strong>built for your home</strong> \u2014 not the one down the street. We pulled your exact footprint, lot, and treatable lawn, mapped it to the time and materials it actually takes, and stopped there. No inflated markups. No upsell scripts. No call center. Just an honest number from the family that\u2019ll show up to treat it.</div>
    <div class="big-price">
      ${savingsPerMo > 0 ? `<span class="anchor" id="anchor-display">${fmtMoney(baseMonthly)}/mo</span>` : ''}
      <span class="num" id="monthly-display">${fmtMoney(monthlyTotal)}</span>
      <span class="per">/mo</span>
      <span class="tier-lbl" id="tier-display">WaveGuard ${escapeHtml(tier)}</span>
    </div>
    <div class="save-row">
      <span class="save-pill"${savingsPerMo > 0 ? '' : ' style="display:none"'}>You save <span id="savings-display">${fmtMoney(savingsPerMo)}</span>/mo with <span id="savings-tier">${escapeHtml(tier)}</span></span>
      <span class="day-pill">Just <span id="day-price">${fmtMoney(dayPrice)}</span>/day for complete home protection</span>
    </div>
    ${locked ? '' : `
    <div class="hero-cta">
      <button class="cta" id="accept-btn" onclick="acceptEstimate()">Accept this estimate</button>
      <a class="cta white" href="tel:${WAVES_OFFICE_PHONE}">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z"/></svg>
        Call (941) 318-7612
      </a>
      <ul class="trust-strip" aria-label="Why Waves">
        <li><svg viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M7.5 13.6 4.2 10.3l-1.4 1.4 4.7 4.7 10-10-1.4-1.4z"/></svg>Family-owned, local</li>
        <li><svg viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M7.5 13.6 4.2 10.3l-1.4 1.4 4.7 4.7 10-10-1.4-1.4z"/></svg>No contracts, ever</li>
        <li><svg viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M7.5 13.6 4.2 10.3l-1.4 1.4 4.7 4.7 10-10-1.4-1.4z"/></svg>Pet &amp; kid safe</li>
        <li><svg viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M7.5 13.6 4.2 10.3l-1.4 1.4 4.7 4.7 10-10-1.4-1.4z"/></svg>100% guarantee</li>
      </ul>
      <div class="decline"><a href="#" onclick="declineEstimate();return false">No thanks, decline this estimate</a></div>
    </div>`}
  </div>

  <div class="ai-bar" id="ai-bar">
    <div class="ai-head">
      <span class="ai-dot"></span>
      <span><strong>Ask Waves AI</strong></span>
    </div>
    <form class="ai-form" id="ai-form" autocomplete="off">
      <input type="text" id="ai-input" maxlength="1000" placeholder="Is this safe for my pets and kids? Can I cancel anytime?"/>
      <button type="submit" id="ai-submit">Ask Waves AI</button>
    </form>
    <div class="ai-thread" id="ai-thread"></div>
    <div class="ai-chips" id="ai-chips">
      <button class="ai-chip" data-q="Are your treatments safe for my pets and kids?">Safe for pets &amp; kids?</button>
      <button class="ai-chip" data-q="Am I locked into a contract, or can I cancel anytime?">Any contracts?</button>
      <button class="ai-chip" data-q="What happens if pests come back between scheduled visits?">Pests between visits?</button>
      <button class="ai-chip" data-q="When would my first service happen if I accept today?">How soon can you start?</button>
      <button class="ai-chip" data-q="What makes Waves different from the big pest control companies?">Why Waves vs. Orkin?</button>
      <button class="ai-chip" data-q="Can I talk to someone on the phone before I decide?">Call me back</button>
    </div>
  </div>

  ${showUpsell ? `
  <div class="upsell">
    <div class="txt">
      <h3>Add ${escapeHtml(upsellService)} and save more</h3>
      <div style="font-size:14px">Bundling unlocks Silver tier pricing (10% off everything). Curious what that looks like?</div>
    </div>
    <button class="upsell-btn" onclick="inquireBundle('${escapeHtml(upsellService)}')">Get a bundle quote</button>
  </div>` : ''}

  ${oneTimeRows ? `
  <div class="card" style="margin-top:24px">
    <h3>One-time items (billed separately)</h3>
    <table>${oneTimeRows}
      <tr><td><strong>One-time total</strong></td><td style="text-align:right"><strong>${fmtMoney(onetimeTotal)}</strong></td></tr>
    </table>
    <p style="font-size:13px;opacity:.65;margin:12px 0 0">These are scheduled after your recurring service starts. The WaveGuard member rate includes 15% off any one-time treatment.</p>
  </div>` : ''}

  </div>

  <section class="review-section" aria-label="Customer reviews">
    <div class="header">
      <h2>Trusted Across Southwest Florida</h2>
      <p>Real reviews from real neighbors in Bradenton, Sarasota, Parrish, Venice, and beyond.</p>
    </div>
    <div class="review-slider">
      <div class="review-track">${reviewsHtml}</div>
    </div>
  </section>

  <div class="wrap">

  <div class="final">
    <h2>Ready to lock in <span data-monthly-echo>${fmtMoney(monthlyTotal)}</span>/mo?</h2>
    <p>This rate is yours for the next 12 months. No surprise increases, no hidden fees.</p>
    ${locked ? '' : `<button class="cta" style="max-width:360px;margin:16px auto 0" onclick="acceptEstimate()">Accept &amp; Get Started</button>`}
  </div>

  ${locked ? '' : `<div class="decline"><a href="#" onclick="declineEstimate();return false">No thanks, decline this estimate</a></div>`}

  <div class="brand-footer">
    <div class="loop">\u{1F30A} Stay in the loop</div>
    <div class="socials">
      <a href="https://facebook.com/wavespestcontrol" target="_blank" rel="noopener noreferrer" aria-label="Facebook"><svg viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg></a>
      <a href="https://instagram.com/wavespestcontrol" target="_blank" rel="noopener noreferrer" aria-label="Instagram"><svg viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12s.014 3.668.072 4.948c.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24s3.668-.014 4.948-.072c4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948s-.014-3.667-.072-4.947c-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg></a>
      <a href="https://youtube.com/@wavespestcontrol" target="_blank" rel="noopener noreferrer" aria-label="YouTube"><svg viewBox="0 0 24 24"><path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></a>
      <a href="https://tiktok.com/@wavespestcontrol" target="_blank" rel="noopener noreferrer" aria-label="TikTok"><svg viewBox="0 0 24 24"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg></a>
      <a href="https://x.com/wavespest" target="_blank" rel="noopener noreferrer" aria-label="X"><svg viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></a>
    </div>
    <div class="tag">Wave Goodbye to Pests!</div>
    <img class="logo" src="/waves-logo.png" alt="">
    <div class="name">Waves Pest Control, LLC</div>
    <div class="desc">Family-owned pest control &amp; lawn care \u00b7 Southwest Florida</div>
    <div class="cities">
      <a href="https://www.google.com/maps?cid=14759626783082699860" target="_blank" rel="noopener noreferrer">Lakewood Ranch</a> \u00b7
      <a href="https://www.google.com/maps?cid=11265402721490483375" target="_blank" rel="noopener noreferrer">Parrish</a> \u00b7
      <a href="https://www.google.com/maps?cid=15895756394247959321" target="_blank" rel="noopener noreferrer">Sarasota</a> \u00b7
      <a href="https://www.google.com/maps/place/Waves+Pest+Control+Venice/data=!4m2!3m1!1s0x0:0x41ab293594e64044" target="_blank" rel="noopener noreferrer">Venice</a>
    </div>
    <div class="copy">\u00a9 ${new Date().getFullYear()} Waves Pest Control, LLC \u00b7 All rights reserved</div>
  </div>
</div>

<div id="toast"></div>

${locked ? '' : `<div class="sticky-cta" id="sticky-cta" aria-hidden="true">
  <button class="cta" onclick="acceptEstimate()">Accept</button>
  <a class="cta white" href="tel:${WAVES_OFFICE_PHONE}" aria-label="Call Waves Pest Control">
    <svg viewBox="0 0 20 20" aria-hidden="true"><path fill="currentColor" d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z"/></svg>
    Call
  </a>
</div>`}

<script>
  // Hamburger toggle
  (function initNav() {
    const btn = document.getElementById('hamburger');
    const menu = document.getElementById('nav-menu');
    if (!btn || !menu) return;
    function close() { btn.classList.remove('open'); menu.classList.remove('open'); btn.setAttribute('aria-expanded','false'); menu.setAttribute('aria-hidden','true'); }
    btn.addEventListener('click', () => {
      const open = !btn.classList.contains('open');
      btn.classList.toggle('open', open);
      menu.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      menu.setAttribute('aria-hidden', open ? 'false' : 'true');
    });
    menu.addEventListener('click', (e) => { if (e.target.tagName === 'A') close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  })();

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
      document.getElementById('tier-display').textContent = 'WaveGuard ' + newTier;
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
      if (btn) { btn.disabled = false; btn.textContent = 'Accept this estimate'; }
    }
  }

  async function declineEstimate() {
    if (!confirm('Are you sure you want to decline this estimate?')) return;
    try {
      await fetch(API + '/decline', { method: 'PUT' });
      toast('Got it \u2014 no worries. Call us if anything changes.');
    } catch (e) { toast('Something went wrong.'); }
  }

  async function inquireBundle(svc) {
    try {
      await fetch(API + '/bundle-inquiry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestedService: svc })
      });
      toast('Got it \u2014 we\u2019ll text you a bundle quote shortly.');
    } catch (e) { toast('Could not send. Call (941) 318-7612.'); }
  }

  // Sticky mobile accept bar — reveal once the main Accept button scrolls off-screen
  (function initStickyCTA() {
    const bar = document.getElementById('sticky-cta');
    const trigger = document.getElementById('accept-btn');
    if (!bar || !trigger) return;
    document.body.classList.add('has-sticky-cta');
    const io = new IntersectionObserver(([e]) => {
      const show = !e.isIntersecting;
      bar.classList.toggle('show', show);
      bar.setAttribute('aria-hidden', show ? 'false' : 'true');
    }, { rootMargin: '-40px 0px 0px 0px', threshold: 0 });
    io.observe(trigger);
  })();

  // Waves AI assistant (estimate-scoped)
  (function initAI() {
    const form = document.getElementById('ai-form');
    const input = document.getElementById('ai-input');
    const submit = document.getElementById('ai-submit');
    const thread = document.getElementById('ai-thread');
    const chips = document.getElementById('ai-chips');
    if (!form || !input || !thread) return;

    const history = [];

    function addMsg(role, text, variant) {
      const el = document.createElement('div');
      el.className = 'ai-msg ' + (role === 'user' ? 'user' : 'bot') + (variant ? ' ' + variant : '');
      el.textContent = text;
      thread.appendChild(el);
      thread.scrollTop = thread.scrollHeight;
      return el;
    }

    async function ask(message) {
      if (!message || !message.trim()) return;
      const trimmed = message.trim().slice(0, 1000);
      addMsg('user', trimmed);
      history.push({ role: 'user', content: trimmed });
      input.value = '';
      input.disabled = true; submit.disabled = true;
      const thinking = addMsg('bot', 'Thinking\u2026', 'thinking');
      try {
        const r = await fetch(API + '/ai/query', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: trimmed, history: history.slice(-10) }),
        });
        const data = await r.json();
        thinking.remove();
        if (!r.ok) {
          addMsg('bot', data.error || 'Something went wrong. Call (941) 318-7612.', 'error');
        } else {
          addMsg('bot', data.reply || '\u2026');
          history.push({ role: 'assistant', content: data.reply || '' });
          if (chips && chips.style.display !== 'none') chips.style.display = 'none';
        }
      } catch (e) {
        thinking.remove();
        addMsg('bot', 'Connection hiccup. Try again in a moment.', 'error');
      } finally {
        input.disabled = false; submit.disabled = false; input.focus();
      }
    }

    form.addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });
    if (chips) {
      chips.addEventListener('click', (e) => {
        const btn = e.target.closest('.ai-chip');
        if (!btn) return;
        e.preventDefault();
        ask(btn.dataset.q || btn.textContent);
      });
    }
  })();
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
      customerPhone: estimate.customer_phone,
      customerEmail: estimate.customer_email,
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
router.put('/:token/accept', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ token: req.params.token }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (estimate.status === 'accepted') return res.json({ success: true, alreadyAccepted: true });

    const firstName = (estimate.customer_name || '').split(' ')[0] || 'there';

    // Parse estimate data + detect one-time-only vs recurring (read-only — safe outside txn)
    const estData = typeof estimate.estimate_data === 'string' ? JSON.parse(estimate.estimate_data) : estimate.estimate_data;
    const estResult = estData?.result || estData || {};
    const recurringSvcList = estResult?.recurring?.services || [];
    const oneTimeList = [...(estResult?.oneTime?.items || []), ...(estResult?.oneTime?.specItems || [])];
    const isOneTimeOnly = recurringSvcList.length === 0 && oneTimeList.length > 0;

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

      let onboardingToken = null;
      if (customerId && !isOneTimeOnly) {
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
        const officeFallback = isOneTimeOnly
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
        if (isOneTimeOnly) {
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

    // Auto-convert estimate to active customer (Feature #5)
    if (customerId) {
      try {
        const EstimateConverter = require('../services/estimate-converter');
        await EstimateConverter.convertEstimate(estimate.id);
        logger.info(`[estimate-accept] Auto-conversion completed for estimate ${estimate.id}`);
      } catch (e) { logger.error(`[estimate-accept] Auto-conversion failed: ${e.message}`); }
    }

    res.json({ success: true, onboardingToken });
  } catch (err) { next(err); }
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

module.exports = router;
module.exports.handleEstimateView = handleEstimateView;
