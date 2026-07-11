/**
 * Apple Wallet pass for the digital business card (PR 2 of the card lane).
 *
 * Generates a signed .pkpass for a customer_cards row: navy generic pass
 * fronted by the tech on record, the same tracked /l review QR the card page
 * carries (Wallet draws the barcode itself — no branded QR here), the
 * customer's coordinates for lock-screen relevance, and contact/portal/
 * referral links on the back of the pass.
 *
 * Self-gating by config: signing needs PASS_SIGNER_CERT_B64 /
 * PASS_SIGNER_KEY_B64 / PASS_WWDR_CERT_B64 (base64 PEMs, Railway env). When
 * any are unset, walletConfigured() is false, the .pkpass route 404s, and
 * the card page hides its Add-to-Wallet button — kill switch = unset the
 * vars. Cert bundle + renewal date (2027-08-10) live in
 * ~/waves-wallet-certs/README.md on the owner's machine.
 */

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const logger = require('./logger');
const { WAVES_LOCATIONS } = require('../config/locations');
const { publicPortalUrl } = require('../utils/portal-url');
const {
  WAVES_FL_LICENSE_LINE,
  WAVES_WEBSITE_URL,
} = require('../constants/business');

const PASS_TYPE_ID_DEFAULT = 'pass.com.wavespestcontrol.card';
const TEAM_ID_DEFAULT = 'BMNXJ4Q89M';
const ASSET_DIR = path.join(__dirname, '..', 'assets', 'wallet');
const ASSET_FILES = ['icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png', 'logo@3x.png'];

function walletConfigured() {
  return Boolean(
    process.env.PASS_SIGNER_CERT_B64
    && process.env.PASS_SIGNER_KEY_B64
    && process.env.PASS_WWDR_CERT_B64,
  );
}

function loadCerts() {
  return {
    wwdr: Buffer.from(process.env.PASS_WWDR_CERT_B64, 'base64'),
    signerCert: Buffer.from(process.env.PASS_SIGNER_CERT_B64, 'base64'),
    signerKey: Buffer.from(process.env.PASS_SIGNER_KEY_B64, 'base64'),
  };
}

function firstNameOf(fullName) {
  return String(fullName || '').trim().split(/\s+/)[0] || '';
}

/**
 * Complete pass.json for the card — pure, unit-testable. Wallet renders the
 * QR itself from `barcodes`; colors carry the glass theme (passes are flat
 * by Apple's spec — no translucency).
 */
function buildPassJson({
  card,
  customerFirstName,
  memberSinceYear,
  techName,
  location,
  reviewUrl,
  referralUrl,
  portalUrl,
  cardUrl = null,
  hasLeftGoogleReview = false,
}) {
  const techFirst = firstNameOf(techName);
  // No NEXT VISIT on the static pass (Codex P2 #2592): without PassKit
  // update plumbing (webServiceURL/authenticationToken) the date would sit
  // stale in Wallet forever. Returns with the pass-update follow-up.
  const secondaryFields = [
    { key: 'customer', label: 'CUSTOMER', value: customerFirstName || 'Waves customer' },
  ];

  const passJson = {
    formatVersion: 1,
    passTypeIdentifier: process.env.PASS_TYPE_ID || PASS_TYPE_ID_DEFAULT,
    teamIdentifier: process.env.PASS_TEAM_ID || TEAM_ID_DEFAULT,
    serialNumber: String(card.id),
    organizationName: 'Waves Pest Control',
    // Not "Waves … business card": Messages' pkpass preview stacks the
    // description above organizationName, so the company name would read
    // twice in the bubble (owner feedback 07-11).
    description: 'Digital business card',
    backgroundColor: 'rgb(4,57,94)',
    foregroundColor: 'rgb(255,255,255)',
    labelColor: 'rgb(155,212,234)',
    // Native App Store banner on the pass back — the pass advertises the
    // Waves app without burning a field (numeric Apple ID of the iOS app).
    associatedStoreIdentifiers: [6782775654],
    // Customers flagged has_left_google_review keep a useful QR — it opens
    // their full card instead of re-asking for a review (mirrors the card
    // page's suppression; Codex P2 #2592).
    barcodes: [hasLeftGoogleReview && cardUrl
      ? {
        format: 'PKBarcodeFormatQR',
        message: cardUrl,
        messageEncoding: 'iso-8859-1',
        altText: 'Open your Waves card',
      }
      : {
        format: 'PKBarcodeFormatQR',
        message: reviewUrl,
        messageEncoding: 'iso-8859-1',
        altText: 'Review Waves on Google',
      }],
    generic: {
      headerFields: memberSinceYear
        ? [{ key: 'since', label: 'CUSTOMER SINCE', value: String(memberSinceYear) }]
        : [],
      primaryFields: [
        { key: 'technician', label: 'YOUR TECHNICIAN', value: techName || 'Waves Pest Control' },
      ],
      secondaryFields,
      // Front-of-pass contact line — a business card should show how to
      // reach us without flipping to the back (owner feedback 07-11).
      auxiliaryFields: [{
        key: 'contact',
        label: techFirst ? `TEXT OR CALL ${techFirst.toUpperCase()}` : 'TEXT OR CALL',
        value: location.phone,
      }],
      backFields: [
        // The pass is the pocket shortcut; the DESIGNED experience (glass,
        // socials, app badges, branded QR) is the card page — link it first.
        ...(cardUrl ? [{
          key: 'card',
          label: 'YOUR FULL WAVES CARD',
          value: cardUrl,
          attributedValue: `<a href="${cardUrl}">Open your Waves card</a>`,
        }] : []),
        {
          key: 'text',
          label: techFirst ? `TEXT ${techFirst.toUpperCase()}` : 'TEXT US',
          value: location.phone,
          attributedValue: `<a href="sms:${location.phoneRaw}">${location.phone}</a>`,
        },
        {
          key: 'call',
          label: techFirst ? `CALL ${techFirst.toUpperCase()}` : 'CALL US',
          value: location.phone,
          attributedValue: `<a href="tel:${location.phoneRaw}">${location.phone}</a>`,
        },
        {
          key: 'portal',
          label: 'CUSTOMER PORTAL',
          value: portalUrl,
          attributedValue: `<a href="${portalUrl}">${portalUrl.replace(/^https?:\/\//, '')}</a>`,
        },
        {
          key: 'referral',
          label: 'SHARE WAVES WITH A FRIEND',
          value: referralUrl,
          attributedValue: `<a href="${referralUrl}">${referralUrl.replace(/^https?:\/\//, '')}</a>`,
        },
        {
          key: 'website',
          label: 'WEBSITE',
          value: WAVES_WEBSITE_URL,
          attributedValue: `<a href="${WAVES_WEBSITE_URL}">wavespestcontrol.com</a>`,
        },
        // Socials — back fields are the only place the pass format allows
        // links. Two primaries here; the full row lives on the card page.
        // URLs mirror the canonical list in client BrandFooter.jsx.
        {
          key: 'instagram',
          label: 'INSTAGRAM',
          value: 'https://instagram.com/wavespestcontrol',
          attributedValue: '<a href="https://instagram.com/wavespestcontrol">@wavespestcontrol</a>',
        },
        {
          key: 'facebook',
          label: 'FACEBOOK',
          value: 'https://facebook.com/wavespestcontrol',
          attributedValue: '<a href="https://facebook.com/wavespestcontrol">facebook.com/wavespestcontrol</a>',
        },
        {
          key: 'license',
          label: 'LICENSED & INSURED',
          value: WAVES_FL_LICENSE_LINE,
        },
      ],
    },
  };

  // NO pass locations: embedding the customer's home coordinates in a
  // downloadable .pkpass leaks them to anyone holding the file (Codex P1
  // #2592). Lock-screen relevance can return later with coarse/rounded
  // coords alongside the pass-update plumbing.

  return passJson;
}

/**
 * Signed .pkpass buffer for a card share token, or null when the token is
 * unknown / customer archived. Throws only on signing/config errors (the
 * route maps those to 500 via next()).
 */
async function generateForToken(token) {
  if (!walletConfigured()) return null;
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;

  const card = await db('customer_cards').where({ share_token: token }).first();
  if (!card) return null;

  const customer = await db('customers')
    .where({ id: card.customer_id })
    .first('id', 'first_name', 'member_since', 'created_at', 'deleted_at', 'referral_code', 'has_left_google_review');
  if (!customer || customer.deleted_at) return null;

  let techName = null;
  let techPhotoUrl = null;
  if (card.technician_id) {
    const tech = await db('technicians')
      .where({ id: card.technician_id })
      .first('name', 'photo_url', 'photo_s3_key');
    techName = tech?.name || null;
    if (tech) {
      const { resolveTechPhotoUrl } = require('./tech-photo');
      techPhotoUrl = await resolveTechPhotoUrl(tech.photo_s3_key, tech.photo_url);
    }
  }

  const location = WAVES_LOCATIONS.find((l) => l.id === card.location_id) || WAVES_LOCATIONS[0];

  let referralUrl = `${publicPortalUrl()}/?tab=refer`;
  try {
    const promoter = await db('referral_promoters')
      .where({ customer_id: customer.id })
      .first('referral_link');
    if (promoter?.referral_link) referralUrl = promoter.referral_link;
  } catch { /* table optional in older envs */ }

  const memberSince = customer.member_since || customer.created_at;
  const passJson = buildPassJson({
    card,
    customerFirstName: customer.first_name,
    memberSinceYear: memberSince ? new Date(memberSince).getFullYear() : null,
    techName,
    location,
    reviewUrl: card.review_short_url || card.review_target_url || location.googleReviewUrl,
    referralUrl,
    portalUrl: publicPortalUrl(),
    cardUrl: `${publicPortalUrl()}/card/${card.share_token}`,
    hasLeftGoogleReview: !!customer.has_left_google_review,
  });

  const files = { 'pass.json': Buffer.from(JSON.stringify(passJson)) };
  for (const name of ASSET_FILES) {
    try {
      files[name] = fs.readFileSync(path.join(ASSET_DIR, name));
    } catch (err) {
      // icon.png is REQUIRED by Wallet; the rest degrade gracefully.
      if (name === 'icon.png') throw err;
      logger.warn(`[wallet-pass] asset missing: ${name}`);
    }
  }

  // Tech headshot as the pass thumbnail (renders beside the primary field and
  // fills the generic layout's empty middle — owner feedback 07-11). Wallet
  // requires PNG, so any JPEG source is converted; best-effort with a short
  // timeout so a slow photo host can never stall a pass download.
  if (techPhotoUrl) {
    try {
      const resp = await fetch(techPhotoUrl, { signal: AbortSignal.timeout(4000) });
      if (resp.ok) {
        const raw = Buffer.from(await resp.arrayBuffer());
        const sharp = require('sharp');
        for (const [name, px] of [['thumbnail.png', 90], ['thumbnail@2x.png', 180], ['thumbnail@3x.png', 270]]) {
          files[name] = await sharp(raw)
            .resize(px, px, { fit: 'cover', position: 'attention' })
            .png()
            .toBuffer();
        }
      }
    } catch (err) {
      logger.warn(`[wallet-pass] thumbnail skipped (errType=${err?.name || 'Error'})`);
    }
  }

  const { PKPass } = require('passkit-generator');
  const pass = new PKPass(files, loadCerts());
  return pass.getAsBuffer();
}

module.exports = {
  walletConfigured,
  generateForToken,
  buildPassJson,
  __private: { firstNameOf },
};
