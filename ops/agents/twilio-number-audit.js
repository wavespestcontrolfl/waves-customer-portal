/**
 * twilio-number-audit.js — READ-ONLY
 *
 * Twilio number + compliance coverage audit. Every time a number is bought (or a
 * webhook is hand-edited in the console) the same four things go wrong, and each
 * one is invisible until a customer hits it:
 *
 *   1. the number is not in server/config/twilio-numbers.js — inbound texts to it
 *      are DROPPED by twilio-webhook.js ("unmanaged number") and calls log with
 *      location 'unknown';
 *   2. its voice / SMS / status-callback webhooks drift from the portal's — the
 *      2026-08-12 → 2026-09-07 incident: the Google Ads line pointed at a Sandy
 *      sandbox Function for four weeks while the campaign still spent;
 *   3. it is missing from a LIVE Trust Hub product (customer profile, SHAKEN/STIR,
 *      CNAM, Voice Integrity, Branded Calling) — the console's per-number
 *      "Not started" items;
 *   4. it is not a sender on the A2P-registered messaging service (10DLC) — or, for
 *      a toll-free number, has no approved toll-free verification — so the first
 *      outbound text from it fails.
 *
 * The canonical webhook config is the MODE across owned numbers per field (no
 * hard-coded host): one drifted line stands out, a fleet-wide host move does not.
 * A "live" Trust Hub product = twilio-approved with at least one assigned number;
 * duplicates / empty leftovers are reported, never treated as coverage.
 *
 * Prints the full picture, then defects. Exits 1 when defects exist so a sweep can
 * gate on it. No customer data is read; nothing is written to Twilio.
 *
 * Run (from the repo root — the twilio SDK is a server dependency):
 *   railway run node ops/agents/twilio-number-audit.js
 */

const path = require('path');
const twilio = require('twilio');
const REGISTRY = require(path.join(__dirname, '..', '..', 'server', 'config', 'twilio-numbers.js'));

// A TwiML App (voice/smsApplicationSid) or SIP trunk (trunkSid) OVERRIDES the
// URLs, so they are part of the routing config — a number handed to a third-party
// app keeps a canonical-looking voiceUrl and would otherwise pass.
const WEBHOOK_FIELDS = ['voiceUrl', 'voiceMethod', 'voiceFallbackUrl', 'statusCallback', 'smsUrl', 'smsMethod', 'voiceApplicationSid', 'smsApplicationSid', 'trunkSid'];
const TOLL_FREE = /^\+1(800|833|844|855|866|877|888)\d{7}$/;
// Twilio's fixed Trust Hub policy SIDs. The A2P Messaging Profile bundle never
// carries phone numbers by design (the brand registration hangs off it); a
// toll-free verification bundle covers exactly its one toll-free number. Neither
// is a fleet-wide product, so neither counts toward — or against — coverage.
const A2P_MESSAGING_PROFILE_POLICY = 'RNb0d4771c2c98518d916a3d4cd70a8f8b';
const TOLLFREE_VERIFICATION_POLICY = 'RNa282dd7f3dbef8586501ca2e045e764c';

function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

function short(u) { return u ? String(u).replace(/^https?:\/\//, '') : '(none)'; }

async function main() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    console.error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set — run via: railway run node ops/agents/twilio-number-audit.js');
    process.exit(1);
  }
  const client = twilio(sid, token);
  const defects = [];
  const defect = (n, what) => defects.push(`${n}  ${what}`);

  // ── 1. Owned numbers vs registry ─────────────────────────────
  const numbers = (await client.incomingPhoneNumbers.list({ limit: 500 }))
    .sort((a, b) => a.phoneNumber.localeCompare(b.phoneNumber));
  const numberBySid = new Map(numbers.map(n => [n.sid, n.phoneNumber]));
  const owned = new Set(numbers.map(n => n.phoneNumber));
  const registered = new Set([...REGISTRY.allNumbers.map(n => n.number), REGISTRY.mainLine.number]);

  console.log(`=== NUMBERS (${numbers.length} owned, ${registered.size} registered) ===`);
  for (const n of numbers) {
    const reg = REGISTRY.findByNumber(n.phoneNumber)
      || (n.phoneNumber === REGISTRY.mainLine.number ? { type: 'main_line', label: REGISTRY.mainLine.label } : null);
    console.log(`${n.phoneNumber}  "${n.friendlyName}"  ${reg ? `${reg.type} / ${reg.label || reg.domain || ''}` : 'NOT IN REGISTRY'}`);
    if (!reg) defect(n.phoneNumber, `not in server/config/twilio-numbers.js — inbound SMS dropped, calls log as 'unknown'`);
  }
  for (const r of registered) {
    if (!owned.has(r)) defect(r, 'registered in twilio-numbers.js but NOT owned on this Twilio account');
  }

  // ── 2. Webhook drift vs the fleet mode ───────────────────────
  const canonical = {};
  for (const f of WEBHOOK_FIELDS) canonical[f] = mode(numbers.map(n => String(n[f] || '')));
  console.log('\n=== WEBHOOK CANONICAL (mode across owned numbers) ===');
  for (const f of WEBHOOK_FIELDS) console.log(`  ${f}: ${short(canonical[f])}`);
  for (const n of numbers) {
    const drift = WEBHOOK_FIELDS.filter(f => String(n[f] || '') !== canonical[f]);
    if (drift.length) {
      console.log(`  DRIFT ${n.phoneNumber} "${n.friendlyName}": ${drift.map(f => `${f}=${short(n[f])}`).join('  ')}`);
      defect(n.phoneNumber, `webhook drift — ${drift.map(f => `${f}=${short(n[f])}`).join(', ')}`);
    }
  }

  // ── 3. Trust Hub coverage ────────────────────────────────────
  const listEndpoints = async (kind, bu) => {
    const list = kind === 'profile'
      ? await client.trusthub.v1.customerProfiles(bu).customerProfilesChannelEndpointAssignment.list({ limit: 500 })
      : await client.trusthub.v1.trustProducts(bu).trustProductsChannelEndpointAssignment.list({ limit: 500 });
    return new Set(list.map(a => numberBySid.get(a.channelEndpointSid)).filter(Boolean));
  };
  const profiles = await client.trusthub.v1.customerProfiles.list({ limit: 50 });
  const products = await client.trusthub.v1.trustProducts.list({ limit: 50 });
  const bundles = [
    ...profiles.map(p => ({ kind: 'profile', ...p })),
    ...products.map(p => ({ kind: 'product', ...p })),
  ];
  console.log('\n=== TRUST HUB ===');
  const livePerPolicy = new Map(); // policySid → { bundle, endpoints }
  for (const b of bundles) {
    const endpoints = await listEndpoints(b.kind, b.sid);
    console.log(`  ${b.kind === 'profile' ? 'profile' : 'product'} ${b.sid}  "${b.friendlyName}"  status=${b.status}  numbers=${endpoints.size}`);
    if (b.status !== 'twilio-approved' || endpoints.size === 0) continue;
    if (b.policySid === TOLLFREE_VERIFICATION_POLICY) continue;
    const cur = livePerPolicy.get(b.policySid);
    if (!cur || endpoints.size > cur.endpoints.size) livePerPolicy.set(b.policySid, { bundle: b, endpoints });
  }
  for (const { bundle, endpoints } of livePerPolicy.values()) {
    const missing = numbers.map(n => n.phoneNumber).filter(p => !endpoints.has(p));
    if (missing.length) {
      console.log(`  MISSING from "${bundle.friendlyName}" (${bundle.sid}): ${missing.join(', ')}`);
      for (const m of missing) defect(m, `not assigned to live ${bundle.kind} "${bundle.friendlyName}" (${bundle.sid})`);
    }
  }
  const leftovers = bundles.filter(b => b.status === 'twilio-approved'
    && b.policySid !== A2P_MESSAGING_PROFILE_POLICY
    && b.policySid !== TOLLFREE_VERIFICATION_POLICY
    && livePerPolicy.get(b.policySid)?.bundle.sid !== b.sid);
  if (leftovers.length) console.log(`  info: ${leftovers.length} approved bundle(s) carry no numbers (duplicates / leftovers, not coverage): ${leftovers.map(b => `${b.sid} "${b.friendlyName}"`).join(', ')}`);

  // ── 4. Messaging: brand, campaign, senders, toll-free ────────
  console.log('\n=== MESSAGING ===');
  const brands = await client.messaging.v1.brandRegistrations.list({ limit: 20 });
  for (const b of brands) {
    console.log(`  brand ${b.sid}  status=${b.status}  identity=${b.identityStatus}  type=${b.brandType}`);
    if (b.status !== 'APPROVED') defect('brand', `${b.sid} status=${b.status}`);
  }
  if (!brands.length) defect('brand', 'no A2P brand registration');
  const services = await client.messaging.v1.services.list({ limit: 50 });
  const registeredSenders = new Set();
  for (const s of services) {
    const campaigns = await client.messaging.v1.services(s.sid).usAppToPerson.list({ limit: 20 });
    const senders = await client.messaging.v1.services(s.sid).phoneNumbers.list({ limit: 500 });
    console.log(`  service ${s.sid}  "${s.friendlyName}"  senders=${senders.length}  campaigns=${campaigns.map(c => `${c.sid}:${c.campaignStatus}/${c.usAppToPersonUsecase}`).join(',') || 'none'}`);
    for (const c of campaigns) if (c.campaignStatus !== 'VERIFIED') defect('campaign', `${c.sid} on ${s.sid} status=${c.campaignStatus}`);
    if (campaigns.some(c => c.campaignStatus === 'VERIFIED')) senders.forEach(p => registeredSenders.add(p.phoneNumber));
  }
  const verifications = await client.messaging.v1.tollfreeVerifications.list({ limit: 20 });
  const approvedTollFree = new Set(verifications.filter(v => v.status === 'TWILIO_APPROVED').map(v => numberBySid.get(v.tollfreePhoneNumberSid)).filter(Boolean));
  for (const v of verifications) console.log(`  toll-free verification ${v.sid}  number=${numberBySid.get(v.tollfreePhoneNumberSid) || '(released)'}  status=${v.status}`);
  for (const n of numbers) {
    if (TOLL_FREE.test(n.phoneNumber)) {
      if (!approvedTollFree.has(n.phoneNumber)) defect(n.phoneNumber, 'toll-free number without an approved toll-free verification');
    } else if (!registeredSenders.has(n.phoneNumber)) {
      defect(n.phoneNumber, 'not a sender on a messaging service with a VERIFIED A2P campaign — outbound SMS from it will fail');
    }
  }

  // ── 5. Other senders (RCS / WhatsApp) — informational ────────
  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
  for (const channel of ['rcs', 'whatsapp']) {
    try {
      const r = await fetch(`https://messaging.twilio.com/v2/Channels/Senders?Channel=${channel}&PageSize=50`, { headers: { Authorization: auth } });
      const j = await r.json();
      const list = Array.isArray(j.senders) ? j.senders : [];
      if (list.length) console.log(`  ${channel} senders: ${list.map(s => `${s.sender_id} ${s.status}`).join('; ')}`);
    } catch (e) {
      console.log(`  ${channel} senders: unavailable (${e.message})`);
    }
  }

  // ── Verdict ──────────────────────────────────────────────────
  console.log(`\n=== DEFECTS (${defects.length}) ===`);
  for (const d of defects) console.log(`  ${d}`);
  if (!defects.length) console.log('  none — every owned number is registered, on the canonical webhooks, on every live Trust Hub product, and A2P/toll-free covered.');
  process.exit(defects.length ? 1 : 0);
}

main().catch((err) => {
  console.error('twilio-number-audit failed:', err.message);
  process.exit(2);
});
