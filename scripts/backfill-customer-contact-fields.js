#!/usr/bin/env node
/**
 * Backfill low-risk customer contact gaps:
 *   - trim city names and normalize state names/codes to USPS abbreviations
 *   - derive missing city/state/zip from Google Geocoding when street address exists
 *   - infer missing last_name from high-confidence email patterns
 *
 * Usage:
 *   node scripts/backfill-customer-contact-fields.js           # dry run
 *   node scripts/backfill-customer-contact-fields.js --apply   # write changes
 *   node scripts/backfill-customer-contact-fields.js --limit 25
 */
require('dotenv').config();

const db = require('../server/models/db');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1], 10) : null;
const DELAY_MS = 50;

const GOOGLE_KEY = process.env.GOOGLE_API_KEY || process.env.GOOGLE_MAPS_API_KEY;

const STATE_ALIASES = new Map([
  ['ALABAMA', 'AL'], ['ALASKA', 'AK'], ['ARIZONA', 'AZ'], ['ARKANSAS', 'AR'],
  ['CALIFORNIA', 'CA'], ['COLORADO', 'CO'], ['CONNECTICUT', 'CT'], ['DELAWARE', 'DE'],
  ['FLORIDA', 'FL'], ['GEORGIA', 'GA'], ['HAWAII', 'HI'], ['IDAHO', 'ID'],
  ['ILLINOIS', 'IL'], ['INDIANA', 'IN'], ['IOWA', 'IA'], ['KANSAS', 'KS'],
  ['KENTUCKY', 'KY'], ['LOUISIANA', 'LA'], ['MAINE', 'ME'], ['MARYLAND', 'MD'],
  ['MASSACHUSETTS', 'MA'], ['MICHIGAN', 'MI'], ['MINNESOTA', 'MN'], ['MISSISSIPPI', 'MS'],
  ['MISSOURI', 'MO'], ['MONTANA', 'MT'], ['NEBRASKA', 'NE'], ['NEVADA', 'NV'],
  ['NEW HAMPSHIRE', 'NH'], ['NEW JERSEY', 'NJ'], ['NEW MEXICO', 'NM'], ['NEW YORK', 'NY'],
  ['NORTH CAROLINA', 'NC'], ['NORTH DAKOTA', 'ND'], ['OHIO', 'OH'], ['OKLAHOMA', 'OK'],
  ['OREGON', 'OR'], ['PENNSYLVANIA', 'PA'], ['RHODE ISLAND', 'RI'], ['SOUTH CAROLINA', 'SC'],
  ['SOUTH DAKOTA', 'SD'], ['TENNESSEE', 'TN'], ['TEXAS', 'TX'], ['UTAH', 'UT'],
  ['VERMONT', 'VT'], ['VIRGINIA', 'VA'], ['WASHINGTON', 'WA'], ['WEST VIRGINIA', 'WV'],
  ['WISCONSIN', 'WI'], ['WYOMING', 'WY'],
]);

const BUSINESS_EMAIL_PARTS = new Set([
  'admin', 'billing', 'bookkeeping', 'contact', 'customerservice', 'hello', 'info',
  'office', 'sales', 'service', 'support', 'team', 'test', 'waves',
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function normalizeState(value) {
  const text = cleanText(value);
  if (!text) return null;
  const upper = text.toUpperCase().replace(/\./g, '');
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  return STATE_ALIASES.get(upper) || text;
}

function titleCaseName(value) {
  return value
    .split(/([-'\s])/)
    .map(part => (/[-'\s]/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
    .join('');
}

function isMissing(value) {
  return cleanText(value) == null;
}

function inferLastNameFromEmail(customer) {
  if (!isMissing(customer.last_name)) return null;
  const first = cleanText(customer.first_name);
  const email = cleanText(customer.email);
  if (!first || !email || !email.includes('@')) return null;

  const local = email.split('@')[0].toLowerCase();
  if (!local || BUSINESS_EMAIL_PARTS.has(local)) return null;

  const firstLower = first.toLowerCase().replace(/[^a-z]/g, '');
  const parts = local.split(/[._-]+/).filter(Boolean);

  if (parts.length >= 2 && parts[0].replace(/[^a-z]/g, '') === firstLower) {
    const candidate = parts.slice(1).join('').replace(/[0-9]+$/g, '').replace(/[^a-z'-]/g, '');
    if (!candidate || candidate.length < 2 || BUSINESS_EMAIL_PARTS.has(candidate)) return null;
    return titleCaseName(candidate);
  }

  return null;
}

function splitCommaName(customer) {
  if (!isMissing(customer.last_name)) return null;
  const first = cleanText(customer.first_name);
  if (!first || !first.includes(',')) return null;
  const [lastPart, firstPart, ...rest] = first.split(',').map(cleanText);
  if (!lastPart || !firstPart || rest.some(Boolean)) return null;
  if (!/^[A-Za-z][A-Za-z\s'-]+$/.test(lastPart) || !/^[A-Za-z][A-Za-z\s'-]+$/.test(firstPart)) return null;
  return {
    first_name: titleCaseName(firstPart),
    last_name: titleCaseName(lastPart),
  };
}

function componentValue(components, type, field = 'long_name') {
  const component = components.find(c => Array.isArray(c.types) && c.types.includes(type));
  return component ? component[field] : null;
}

function parseGoogleAddress(result) {
  const components = result?.address_components || [];
  const city =
    componentValue(components, 'locality') ||
    componentValue(components, 'postal_town') ||
    componentValue(components, 'sublocality') ||
    componentValue(components, 'administrative_area_level_3');
  const state = componentValue(components, 'administrative_area_level_1', 'short_name');
  const zip = componentValue(components, 'postal_code');
  return {
    city: cleanText(city),
    state: normalizeState(state),
    zip: cleanText(zip),
  };
}

async function geocodeCustomer(customer) {
  if (!GOOGLE_KEY) return null;
  if (!/\d/.test(String(customer.address_line1 || ''))) return null;
  const address = [customer.address_line1, customer.city, customer.state, customer.zip]
    .map(cleanText)
    .filter(Boolean)
    .join(', ');
  if (!address) return null;

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', address);
  url.searchParams.set('components', 'country:US');
  url.searchParams.set('key', GOOGLE_KEY);

  const response = await fetch(url);
  const data = await response.json();
  if (data.status !== 'OK' || !data.results?.length) {
    if (VERBOSE) console.log(`  geocode miss ${customer.id}: ${data.status}`);
    return null;
  }
  return parseGoogleAddress(data.results[0]);
}

function buildUpdates(customer, geocode) {
  const updates = {};
  const normalizedCity = cleanText(customer.city);
  const normalizedState = normalizeState(customer.state);
  const normalizedZip = cleanText(customer.zip);
  const commaName = splitCommaName(customer);
  const inferredLastName = inferLastNameFromEmail(customer);

  if (commaName) {
    updates.first_name = commaName.first_name;
    updates.last_name = commaName.last_name;
  }
  if (customer.city !== normalizedCity && normalizedCity) updates.city = normalizedCity;
  if (customer.state !== normalizedState && normalizedState) updates.state = normalizedState;
  if (customer.zip !== normalizedZip && normalizedZip) updates.zip = normalizedZip;
  if (!updates.last_name && inferredLastName) updates.last_name = inferredLastName;

  if (geocode) {
    if (isMissing(customer.city) && geocode.city) updates.city = geocode.city;
    if (isMissing(customer.state) && geocode.state) updates.state = geocode.state;
    if (isMissing(customer.zip) && geocode.zip) updates.zip = geocode.zip;
  }

  if (Object.keys(updates).length) updates.updated_at = new Date();
  return updates;
}

function needsReview(customer, updates) {
  return (
    isMissing(customer.city) && !updates.city ||
    isMissing(customer.state) && !updates.state ||
    isMissing(customer.zip) && !updates.zip ||
    isMissing(customer.last_name) && !updates.last_name
  );
}

async function main() {
  let query = db('customers')
    .whereNull('deleted_at')
    .select(
      'id', 'first_name', 'last_name', 'email', 'phone',
      'address_line1', 'city', 'state', 'zip', 'latitude', 'longitude'
    )
    .where(function () {
      this
        .whereNull('city').orWhereRaw("btrim(city) = ''").orWhereRaw('city <> btrim(city)')
        .orWhereNull('state').orWhereRaw("btrim(state) = ''").orWhereRaw("upper(btrim(state)) = 'FLORIDA'")
        .orWhereNull('zip').orWhereRaw("btrim(zip) = ''").orWhereRaw('zip <> btrim(zip)')
        .orWhereNull('last_name').orWhereRaw("btrim(last_name) = ''");
    })
    .orderBy('created_at', 'asc');

  if (LIMIT) query = query.limit(LIMIT);
  const customers = await query;

  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Found ${customers.length} customer(s) with contact cleanup candidates.\n`);

  const summary = { updated: 0, unchanged: 0, review: 0, geocoded: 0, lastNames: 0 };
  for (let i = 0; i < customers.length; i++) {
    const customer = customers[i];
    const hasAddressGap = isMissing(customer.city) || isMissing(customer.state) || isMissing(customer.zip);
    const geocode = hasAddressGap ? await geocodeCustomer(customer) : null;
    if (geocode) summary.geocoded += 1;

    const updates = buildUpdates(customer, geocode);
    if (updates.last_name) summary.lastNames += 1;
    if (needsReview(customer, updates)) summary.review += 1;

    const updateKeys = Object.keys(updates).filter(k => k !== 'updated_at');
    if (!updateKeys.length) {
      summary.unchanged += 1;
      if (VERBOSE) console.log(`[${i + 1}/${customers.length}] no change ${customer.id}`);
    } else {
      summary.updated += 1;
      const label = customer.id;
      console.log(`[${i + 1}/${customers.length}] ${APPLY ? 'update' : 'would update'} ${label}: ${updateKeys.join(', ')}`);
      if (VERBOSE || !APPLY) {
        console.log(`  ${JSON.stringify(Object.fromEntries(updateKeys.map(k => [k, updates[k]])))}`);
      }
      if (APPLY) {
        await db('customers').where({ id: customer.id }).update(updates);
      }
    }

    if (hasAddressGap) await sleep(DELAY_MS);
  }

  const remaining = await db('customers')
    .whereNull('deleted_at')
    .select(
      db.raw("count(*) filter (where city is null or btrim(city) = '') as missing_city"),
      db.raw("count(*) filter (where state is null or btrim(state) = '') as missing_state"),
      db.raw("count(*) filter (where zip is null or btrim(zip) = '') as missing_zip"),
      db.raw("count(*) filter (where last_name is null or btrim(last_name) = '') as missing_last_name"),
      db.raw("count(*) filter (where city is not null and city <> btrim(city)) as city_needs_trim"),
      db.raw("count(*) filter (where upper(btrim(state)) = 'FLORIDA') as state_name_values")
    )
    .first();

  console.log('\nSummary');
  console.log(JSON.stringify({ ...summary, remaining }, null, 2));

  await db.destroy();
}

main().catch(async (err) => {
  console.error(err);
  await db.destroy();
  process.exit(1);
});
