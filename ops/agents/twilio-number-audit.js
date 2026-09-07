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
 *   2. its routing drifts from the contract in scripts/twilio/routing-contract.js
 *      (voice / fallback / status-callback / SMS URLs and methods, plus the App
 *      and trunk overrides) — the 2026-08-12 → 2026-09-07 incident: the Google
 *      Ads line pointed at a Sandy sandbox Function for four weeks while the
 *      campaign still spent;
 *   3. it is missing from a LIVE Trust Hub product (customer profile, SHAKEN/STIR,
 *      CNAM, Voice Integrity, Branded Calling) — the console's per-number
 *      "Not started" items;
 *   4. it is not a sender on the A2P-registered messaging service (10DLC) — or, for
 *      a toll-free number, has no approved toll-free verification — so the first
 *      outbound text from it fails.
 *
 * The relay sandbox line (VOICE_RELAY_SANDBOX_NUMBER) is the one owned number
 * that is supposed to fail 1 and 2: it stays out of the registry (or parked under
 * `unassigned`) and routes to /relay-sandbox. It is reported on its own and never
 * counted against the fleet. A "live" Trust Hub product = twilio-approved with at
 * least one assigned number; duplicate / empty leftovers are listed, never
 * treated as coverage. scripts/twilio/audit-inbound-routing.js is the companion
 * TRAFFIC audit (call legs + call_log over N days, Studio rollback contract);
 * this one is the configuration audit and needs no database.
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
const { APP_ROUTING, SMS_ROUTING, SANDBOX_ROUTING, routingDrift } = require(path.join(__dirname, '..', '..', 'scripts', 'twilio', 'routing-contract.js'));

const TOLL_FREE = /^\+1(800|833|844|855|866|877|888)\d{7}$/;
// Twilio's fixed Trust Hub policy SIDs. The A2P Messaging Profile bundle never
// carries phone numbers by design (the brand registration hangs off it); a
// toll-free verification bundle covers exactly its one toll-free number. Neither
// is a fleet-wide product, so neither counts toward — or against — coverage.
const NON_FLEET_POLICIES = new Set([
  'RNb0d4771c2c98518d916a3d4cd70a8f8b', // A2P Messaging Profile
  'RNa282dd7f3dbef8586501ca2e045e764c', // Toll-free verification
]);
// The fleet-wide products every Waves number must sit on, by Twilio's fixed
// policy SID. A product that is rejected, expired, or emptied is a defect in its
// own right — otherwise it would simply drop out of the coverage loop. CNAM:
// Twilio only self-serves local numbers (toll-free CNAM goes through Support),
// so a toll-free line is exempt from that one.
const CNAM_POLICY = 'RNf3db3cd1fe25fcfd3c3ded065c8fea53';
const EXPECTED_PRODUCTS = Object.freeze({
  'SHAKEN/STIR': 'RN7a97559effdf62d00f4298208492a5ea',
  CNAM: CNAM_POLICY,
  'Voice Integrity': 'RN5b3660f9598883b1df4e77f77acefba0',
  'Branded Calling': 'RNa0b74679be7511921f4d2e3094fa6d23',
});

const last10 = (v) => String(v == null ? '' : v).replace(/\D/g, '').slice(-10);
const day = (d) => new Date(d).toISOString().slice(0, 10);
// Display only: drops the https:// everyone shares; any other scheme stays visible.
const short = (u) => (u ? String(u).replace(/^https:\/\//, '') : '(none)');

// ── 1 + 2. Registry membership and routing, per owned number ─────────────
function auditRouting(numbers, sandbox, ownedNumbers) {
  const defects = [];
  console.log(`=== NUMBERS (${numbers.length} owned) ===`);
  for (const n of numbers) {
    const reg = REGISTRY.findByNumber(n.phoneNumber)
      || (n.phoneNumber === REGISTRY.mainLine.number ? { type: 'main_line', label: REGISTRY.mainLine.label } : null);
    const drift = routingDrift(n);
    console.log(`${n.phoneNumber}  "${n.friendlyName}"  ${reg ? [reg.type, reg.label, reg.domain].filter(Boolean).join(' / ') : 'NOT IN REGISTRY'}${drift.length ? `  DRIFT ${drift.map(f => `${f}=${short(n[f])}`).join(' ')}` : ''}`);
    if (!reg) defects.push(`${n.phoneNumber}  not in server/config/twilio-numbers.js — inbound SMS dropped, calls log as 'unknown'`);
    if (drift.length) defects.push(`${n.phoneNumber}  routing drift — ${drift.map(f => `${f}=${short(n[f])} (expected ${short(APP_ROUTING[f]) || 'empty'})`).join(', ')}`);
  }
  // Ownership is checked against EVERY owned number — the sandbox line may
  // legitimately sit in the registry under `unassigned`.
  for (const r of new Set([...REGISTRY.allNumbers.map(n => n.number), REGISTRY.mainLine.number])) {
    if (!ownedNumbers.has(r)) defects.push(`${r}  registered in twilio-numbers.js but NOT owned on this Twilio account`);
  }
  if (sandbox) {
    const parked = (REGISTRY.unassigned || []).some(u => last10(u.number) === last10(sandbox.phoneNumber));
    const live = !parked && !!REGISTRY.findByNumber(sandbox.phoneNumber);
    console.log(`\n=== RELAY SANDBOX LINE (VOICE_RELAY_SANDBOX_NUMBER, excluded from the fleet checks above) ===`);
    const misrouted = routingDrift(sandbox, SANDBOX_ROUTING);
    console.log(`${sandbox.phoneNumber}  "${sandbox.friendlyName}"  registry=${parked ? 'parked (unassigned)' : live ? 'LIVE LINE' : 'absent'}  voice=${short(sandbox.voiceUrl)} [${sandbox.voiceMethod}]`);
    if (live) defects.push(`${sandbox.phoneNumber}  VOICE_RELAY_SANDBOX_NUMBER is a registered live line — the server refuses every sandbox call (403); park it under twilio-numbers.unassigned or pick another number`);
    if (misrouted.length) defects.push(`${sandbox.phoneNumber}  VOICE_RELAY_SANDBOX_NUMBER routing — ${misrouted.map(f => `${f}=${short(sandbox[f])} (expected ${short(SANDBOX_ROUTING[f])})`).join(', ')}; sandbox calls never reach /relay-sandbox`);
  }
  return defects;
}

// ── 3. Trust Hub: every fleet number on every live product ───────────────
async function auditTrustHub(client, fleet, numberBySid) {
  const defects = [];
  const listEndpoints = async (b) => {
    const list = b.kind === 'profile'
      ? await client.trusthub.v1.customerProfiles(b.sid).customerProfilesChannelEndpointAssignment.list({ limit: 500 })
      : await client.trusthub.v1.trustProducts(b.sid).trustProductsChannelEndpointAssignment.list({ limit: 500 });
    return new Set(list.map(a => numberBySid.get(a.channelEndpointSid)).filter(Boolean));
  };
  const bundles = [
    ...(await client.trusthub.v1.customerProfiles.list({ limit: 50 })).map(p => ({ kind: 'profile', ...p })),
    ...(await client.trusthub.v1.trustProducts.list({ limit: 50 })).map(p => ({ kind: 'product', ...p })),
  ];
  console.log('\n=== TRUST HUB ===');
  // policySid → { bundle, endpoints }: coverage per policy is the UNION of every
  // approved, unexpired bundle of that policy that carries numbers (duplicates
  // sometimes both carry a few); `bundle` names the first one seen.
  const livePerPolicy = new Map();
  for (const b of bundles) {
    const endpoints = await listEndpoints(b);
    // `status` has no expired value; an approved bundle past validUntil is still
    // reported approved, so the timestamp is checked on its own.
    const expired = Boolean(b.validUntil) && new Date(b.validUntil) < new Date();
    console.log(`  ${b.kind} ${b.sid}  "${b.friendlyName}"  status=${b.status}${expired ? ` EXPIRED ${day(b.validUntil)}` : ''}  numbers=${endpoints.size}`);
    if (expired && endpoints.size) defects.push(`${b.kind} ${b.sid}  "${b.friendlyName}" expired ${day(b.validUntil)} while still carrying ${endpoints.size} number(s)`);
    if (b.status !== 'twilio-approved' || expired || !endpoints.size || NON_FLEET_POLICIES.has(b.policySid)) continue;
    const live = livePerPolicy.get(b.policySid);
    if (live) endpoints.forEach(e => live.endpoints.add(e));
    else livePerPolicy.set(b.policySid, { bundle: b, endpoints });
  }
  for (const [name, policy] of Object.entries(EXPECTED_PRODUCTS)) {
    if (!livePerPolicy.has(policy)) defects.push(`trust hub  no approved, unexpired ${name} product carrying numbers (policy ${policy})`);
  }
  if (![...livePerPolicy.values()].some(l => l.bundle.kind === 'profile')) defects.push('trust hub  no approved, unexpired customer profile carrying numbers');
  for (const { bundle, endpoints } of livePerPolicy.values()) {
    const required = bundle.policySid === CNAM_POLICY ? fleet.filter(p => !TOLL_FREE.test(p)) : fleet;
    const missing = required.filter(p => !endpoints.has(p));
    if (missing.length) console.log(`  MISSING from "${bundle.friendlyName}" (${bundle.sid}): ${missing.join(', ')}`);
    for (const m of missing) defects.push(`${m}  not assigned to live ${bundle.kind} "${bundle.friendlyName}" (${bundle.sid})`);
  }
  const leftovers = bundles.filter(b => b.status === 'twilio-approved' && !NON_FLEET_POLICIES.has(b.policySid)
    && livePerPolicy.get(b.policySid)?.bundle.sid !== b.sid);
  if (leftovers.length) console.log(`  info: ${leftovers.length} approved bundle(s) carry no numbers (duplicates / leftovers, not coverage): ${leftovers.map(b => `${b.sid} "${b.friendlyName}"`).join(', ')}`);
  return defects;
}

// ── 4. Messaging: every fleet number can text ─────────────────────────────
async function auditMessaging(client, fleet, numberBySid) {
  const defects = [];
  console.log('\n=== MESSAGING ===');
  const brands = await client.messaging.v1.brandRegistrations.list({ limit: 20 });
  for (const b of brands) console.log(`  brand ${b.sid}  status=${b.status}  identity=${b.identityStatus}  type=${b.brandType}`);
  // Historical failed / deleted registrations stay on the account; only the
  // absence of an approved brand is a defect.
  if (!brands.some(b => b.status === 'APPROVED')) defects.push('brand  no APPROVED A2P brand registration');
  const registeredSenders = new Set();
  const poolAge = new Map(); // number → ms since it joined a campaign-verified pool
  for (const s of await client.messaging.v1.services.list({ limit: 50 })) {
    const pool = await client.messaging.v1.services(s.sid).phoneNumbers.list({ limit: 500 });
    const senders = pool.map(p => p.phoneNumber);
    const carriesFleet = senders.some(p => fleet.includes(p));
    const campaigns = await client.messaging.v1.services(s.sid).usAppToPerson.list({ limit: 20 });
    const verified = campaigns.some(c => c.campaignStatus === 'VERIFIED');
    console.log(`  service ${s.sid}  "${s.friendlyName}"  senders=${senders.length}  inbound_webhook_on_number=${s.useInboundWebhookOnNumber}  service_inbound=${short(s.inboundRequestUrl)} [${s.inboundMethod}]  campaigns=[${campaigns.map(c => `${c.sid}:${c.campaignStatus}/${c.usAppToPersonUsecase}`).join(',')}]`);
    if (!carriesFleet) continue;
    // With useInboundWebhookOnNumber off, the SERVICE's inbound + fallback URL and
    // method replace every pool number's SMS fields — the per-number contract
    // above would pass while texts went to a null or foreign URL. Same exact
    // comparison as the number check, on the service's effective values.
    if (!s.useInboundWebhookOnNumber) {
      const effective = { smsUrl: s.inboundRequestUrl, smsMethod: s.inboundMethod, smsFallbackUrl: s.fallbackUrl, smsFallbackMethod: s.fallbackMethod };
      const drift = routingDrift(effective, SMS_ROUTING);
      if (drift.length) defects.push(`service ${s.sid}  overrides inbound SMS for its ${senders.length} senders — ${drift.map(f => `${f}=${short(effective[f])} (expected ${short(APP_ROUTING[f]) || 'empty'})`).join(', ')}; set useInboundWebhookOnNumber=true or match the contract`);
    }
    // A service without a VERIFIED campaign registers nothing: its fleet numbers
    // surface individually in the per-number verdict below.
    // Carrier registration starts at the LATER of the sender joining the pool and
    // the campaign becoming VERIFIED (a pool can predate its campaign by days).
    const verifiedAt = Math.max(0, ...campaigns.filter(c => c.campaignStatus === 'VERIFIED').map(c => new Date(c.dateUpdated).getTime()));
    if (verified) pool.forEach(p => { registeredSenders.add(p.phoneNumber); poolAge.set(p.phoneNumber, Date.now() - Math.max(verifiedAt, new Date(p.dateCreated).getTime())); });
  }
  const verifications = await client.messaging.v1.tollfreeVerifications.list({ limit: 20 });
  const approvedTollFree = new Set(verifications.filter(v => v.status === 'TWILIO_APPROVED').map(v => numberBySid.get(v.tollfreePhoneNumberSid)).filter(Boolean));
  for (const v of verifications) console.log(`  toll-free verification ${v.sid}  number=${numberBySid.get(v.tollfreePhoneNumberSid) || '(released)'}  status=${v.status}`);
  // Pool membership on a VERIFIED campaign is what triggers Twilio's carrier
  // registration of a number, but the API exposes no per-number registration
  // status (probed 2026-09-07: the Services/{MG}/PhoneNumbers/{PN} resource has
  // no status field; /Compliance/Usa2p/PhoneNumbers and /A2P/PhoneNumbers are
  // 404). Registration normally completes within hours, so a number that joined
  // the pool inside the last day is called out for a Console check rather than
  // reported ready.
  const PROPAGATION_MS = 24 * 60 * 60 * 1000;
  for (const p of fleet) {
    if (TOLL_FREE.test(p)) {
      if (!approvedTollFree.has(p)) defects.push(`${p}  toll-free number without an approved toll-free verification`);
    } else if (!registeredSenders.has(p)) {
      defects.push(`${p}  not a sender on a messaging service with a VERIFIED A2P campaign — outbound SMS from it will fail`);
    } else if (poolAge.get(p) < PROPAGATION_MS) {
      console.log(`  info: ${p} joined the sender pool ${Math.round(poolAge.get(p) / 3600000)}h ago — carrier registration may still be propagating; confirm in Console → Messaging → Services → Sender Pool before the first outbound text`);
    }
  }
  // Other channel senders — informational (an RCS agent left in DRAFT is what
  // the console's "finish compliance for N numbers and senders" banner counts).
  const auth = 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  for (const channel of ['rcs', 'whatsapp']) {
    try {
      const r = await fetch(`https://messaging.twilio.com/v2/Channels/Senders?Channel=${channel}&PageSize=50`, { headers: { Authorization: auth } });
      const list = (await r.json()).senders;
      if (Array.isArray(list) && list.length) console.log(`  ${channel} senders: ${list.map(x => `${x.sender_id} ${x.status}`).join('; ')}`);
    } catch (e) {
      console.log(`  ${channel} senders: unavailable (${e.message})`);
    }
  }
  return defects;
}

async function main() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set — run via: railway run node ops/agents/twilio-number-audit.js');
    process.exit(1);
  }
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const owned = (await client.incomingPhoneNumbers.list({ limit: 500 })).sort((a, b) => a.phoneNumber.localeCompare(b.phoneNumber));
  const numberBySid = new Map(owned.map(n => [n.sid, n.phoneNumber]));
  // Matched on the last 10 digits, the same way the /relay-sandbox route matches
  // Twilio's To (any format). A configured value that yields no match — a
  // released number, a typo, or no digits at all — is a defect, distinct from unset.
  const sandboxRaw = String(process.env.VOICE_RELAY_SANDBOX_NUMBER || '').trim();
  const sandboxKey = last10(sandboxRaw);
  const sandbox = sandboxKey ? owned.find(n => last10(n.phoneNumber) === sandboxKey) : null;
  const numbers = owned.filter(n => n !== sandbox);
  const fleet = numbers.map(n => n.phoneNumber);

  const defects = [];
  if (sandboxRaw && !sandbox) defects.push(`sandbox  VOICE_RELAY_SANDBOX_NUMBER is set (…${sandboxRaw.slice(-4)}) but matches no owned number`);
  defects.push(
    ...auditRouting(numbers, sandbox, new Set(owned.map(n => n.phoneNumber))),
    ...(await auditTrustHub(client, fleet, numberBySid)),
    ...(await auditMessaging(client, fleet, numberBySid)),
  );
  console.log(`\n=== DEFECTS (${defects.length}) ===`);
  for (const d of defects) console.log(`  ${d}`);
  if (!defects.length) console.log('  none — every owned number is registered, on the routing contract, on every live Trust Hub product, and A2P/toll-free covered.');
  process.exit(defects.length ? 1 : 0);
}

main().catch((err) => {
  console.error('twilio-number-audit failed:', err.message);
  process.exit(2);
});
