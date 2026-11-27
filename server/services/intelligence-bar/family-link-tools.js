/**
 * Intelligence Bar — the customer page's "Same family" link
 * server/services/intelligence-bar/family-link-tools.js
 *
 * IB gap #27 (2026-11-27: "link customer profiles as family / household member on another customer's account"):
 * a card that replays the customer page's own Same family section (CustomerSameFamilySection.jsx).
 *
 *   link_customer_family   — the section's Link button (POST /admin/customers/:id/multi-home-family with
 *                            { otherCustomerId }), run through services/multi-home-family.js linkFamily: the SAME
 *                            function the route calls, so every rule and refusal is the page's own (both profiles
 *                            active, not already in two different families, not the same profile).
 *   unlink_customer_family — the section's Unlink button (DELETE /admin/customers/:id/multi-home-family), run
 *                            through unlinkFamily (a family left with one profile is dissolved, as on the page).
 *
 * What a link means (multi-home-family.js, owner 2026-11-04): the linked profiles count as ONE multi-home family for
 * the 10% Multi-Home Discount. The link itself sends nothing, changes no price, no visit, no invoice, no Bill-To and
 * no contact, and never writes customers.has_multi_home. Whether the discount later reaches other homes is the
 * discount's own rules (estimate discount picker, and the GATE_MULTI_HOME_ALL_HOMES job when that gate is on); the
 * card says so in plain words. A household member's own contacts, logins and Bill-To are other tools.
 *
 * Always a confirm card (write-gates.js two-step), admin only (the route is requireAdmin), never owner-direct,
 * platform path only (GATE_IB_PLATFORM). No gate of its own: it is the page's own button, sends nothing and moves no
 * money (undo = the other tool, or the page's Unlink).
 *
 *   unconfirmed -> a PREVIEW: nothing is written. Its `_version` pins what the card showed (both profiles' names,
 *                  active state and every member of each one's current family).
 *   confirmed   -> re-derives the preview and refuses with preview_changed on any drift, then takes the family
 *                  change lock in its own transaction, re-reads the card under it, and runs linkFamily /
 *                  unlinkFamily inside that transaction.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');

// The tools exist only on the platform path (GATE_IB_PLATFORM), read at call time.
function onPlatformPath() {
  return require('../../config/feature-gates').gateEnvValue('GATE_IB_PLATFORM') === true;
}

const USE_FOR_LINK = '"link Jane\'s profile to her mother\'s account as family", "add him as a household member on <customer>\'s account", "these two homes are the same family", "group these profiles for the multi-home discount"';

const FAMILY_LINK_TOOLS = [
  {
    name: 'link_customer_family',
    description: `Link TWO customer profiles as the "Same family" (household): the customer page's Same family Link button. Use it when a relative or household member has their own profile (their own home, phone or plan) and the operator wants it tied to another customer's account. The first call returns a PREVIEW and writes nothing: both profiles, the family each is in now, and the family after the link. The operator approves on the confirmation card; the confirmed run re-checks it and refuses if anything changed.
Effects: the linked profiles count as one multi-home family, so the 10% Multi-Home Discount can apply across their homes. Nothing is sent to anyone, and no price, visit, invoice, Bill-To payer, contact or login changes. If one profile is already in a family, the other joins that family.
Refused with the reason: a profile not found or not active, the same profile twice, or the two profiles already in two different families (unlink one first with unlink_customer_family). Admin only.
Pass customer_id (the account) and other_customer_id (the family member's profile); find both with query_customers first. A family member with NO profile of their own is not this tool: add them as a contact on the account (the customer page Contacts section), or create their profile first. Billing one profile to another person is set_customer_bill_to.
Use for: ${USE_FOR_LINK}.`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'The account the family member is linked to (from query_customers or get_customer_detail)' },
        other_customer_id: { type: 'string', format: 'uuid', description: 'The family or household member\'s own profile (from query_customers)' },
      },
      required: ['customer_id', 'other_customer_id'],
    },
    _sideEffects: true,
  },
  {
    name: 'unlink_customer_family',
    description: `Take ONE customer profile out of its "Same family" link: the customer page's Same family Unlink button. The first call returns a PREVIEW and writes nothing: the profile and who stays in the family. The operator approves on the confirmation card.
Effects: the profile no longer counts as part of that multi-home family for the 10% Multi-Home Discount. A family left with one profile is dissolved, as on the page. Nothing is sent to anyone, and no price, visit, invoice or contact changes (a discount already on a visit stays).
Refused when the profile is not in a family. Admin only.
Use for: "unlink her from that family", "remove this profile from the household link", "these two are not the same family".`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', format: 'uuid', description: 'The profile to take out of its family (from query_customers or get_customer_detail)' },
      },
      required: ['customer_id'],
    },
    _sideEffects: true,
  },
];

const refusal = (error, code, extra = {}) => ({ error, code, ...extra });
const NOTHING_SENT = { kind: 'comms', text: 'Nothing is sent: no text, email or call goes to anyone.' };
const NO_MONEY = { kind: 'operational', text: 'No price, visit, invoice, Bill-To payer, contact or login changes now.' };

function displayName(row) {
  const name = [row?.first_name, row?.last_name].map((p) => String(p || '').trim()).filter(Boolean).join(' ');
  return name || row?.company_name || 'Unnamed customer';
}

function displayAddress(row) {
  const street = [row?.address_line1, row?.address_line2].map((p) => String(p || '').trim()).filter(Boolean).join(', ');
  const place = [row?.city, [row?.state, row?.zip].filter(Boolean).join(' ')].map((p) => String(p || '').trim()).filter(Boolean).join(', ');
  return [street, place].filter(Boolean).join(', ');
}

const memberLabel = (m) => [m.name, m.address ? `(${m.address})` : null, m.active ? null : '[inactive]'].filter(Boolean).join(' ');

// One profile and the family it is in now (multi-home-family.js familyMembers: live members only).
async function loadProfile(database, rawId, label) {
  const id = String(rawId || '').trim().toLowerCase();
  if (!UUID_RE.test(id)) return refusal(`A valid ${label} id is required`, 'invalid_target');
  const row = await database('customers').where({ id }).first('id', 'first_name', 'last_name', 'company_name',
    'address_line1', 'address_line2', 'city', 'state', 'zip', 'active', 'deleted_at');
  if (!row || row.deleted_at) return refusal(`The ${label} profile was not found. Nothing was changed.`, 'customer_not_found');
  const family = await require('../multi-home-family').familyMembers(database, id);
  return {
    profile: {
      id,
      name: displayName(row),
      address: displayAddress(row),
      active: row.active === true,
      family_id: family.familyId,
      members: family.members.map(({ id: memberId, name, address, active }) => ({ id: memberId, name, address, active })),
    },
  };
}

const pinOf = (p) => ({ id: p.id, name: p.name, address: p.address, active: p.active, family_id: p.family_id, members: p.members.map((m) => [m.id, m.name, m.address, m.active]) });

async function buildLinkPlan(input, { database = db } = {}) {
  const a = await loadProfile(database, input.customer_id, 'account');
  if (a.error) return a;
  const b = await loadProfile(database, input.other_customer_id, 'family member');
  if (b.error) return b;
  const mine = a.profile;
  const other = b.profile;
  if (mine.id === other.id) return refusal('That is the same profile twice. Pass the family member\'s own profile as other_customer_id.', 'same_profile');
  for (const p of [mine, other]) {
    if (!p.active) return refusal(`${p.name}'s profile is not active. Only active profiles can be linked. Nothing was changed.`, 'profile_inactive');
  }
  if (mine.family_id && other.family_id && mine.family_id === other.family_id) {
    return refusal(`${mine.name} and ${other.name} are already linked as the same family. Nothing was changed.`, 'already_linked', {
      family: mine.members.map(memberLabel),
    });
  }
  if (mine.family_id && other.family_id) {
    return refusal(`${mine.name} and ${other.name} are already in two different families. Unlink one first (unlink_customer_family), then link them. Nothing was changed.`, 'different_families', {
      account_family: mine.members.map(memberLabel),
      other_family: other.members.map(memberLabel),
    });
  }
  // The family after the link: the existing family (whichever side has one) plus the side that joins it.
  const byId = new Map();
  for (const m of [...mine.members, ...other.members]) byId.set(m.id, m);
  for (const p of [mine, other]) if (!byId.has(p.id)) byId.set(p.id, { id: p.id, name: p.name, address: p.address, active: p.active });
  const after = [...byId.values()];
  return {
    preview: true,
    tool: 'link_customer_family',
    customer_id: mine.id,
    other_customer_id: other.id,
    account: { name: mine.name, address: mine.address },
    family_member: { name: other.name, address: other.address },
    joins_existing: Boolean(mine.family_id || other.family_id),
    family_after: after.map(memberLabel),
    effects: [
      { kind: 'operational', text: `${mine.name} and ${other.name} are linked as the Same family on both profiles.` },
      { kind: 'operational', text: 'Together they count as one multi-home family: the 10% Multi-Home Discount can apply across their homes under its usual rules.' },
      NO_MONEY,
      NOTHING_SENT,
      { kind: 'operational', text: 'Undo: Unlink in the profile\'s Same family section, or ask the bar to unlink it.' },
    ],
    sends_to_customer: false,
    _version: { op: 'link', account: pinOf(mine), other: pinOf(other) },
    note: 'PREVIEW ONLY — nothing was changed. Confirm links exactly these two profiles; if anything changed it refuses.',
  };
}

async function buildUnlinkPlan(input, { database = db } = {}) {
  const a = await loadProfile(database, input.customer_id, 'customer');
  if (a.error) return a;
  const mine = a.profile;
  if (!mine.family_id) return refusal(`${mine.name} is not linked to another profile as family. Nothing was changed.`, 'not_linked');
  const others = mine.members.filter((m) => m.id !== mine.id);
  const dissolves = others.length <= 1;
  return {
    preview: true,
    tool: 'unlink_customer_family',
    customer_id: mine.id,
    account: { name: mine.name, address: mine.address },
    family_now: mine.members.map(memberLabel),
    stays_linked: dissolves ? [] : others.map(memberLabel),
    dissolves,
    effects: [
      { kind: 'operational', text: `${mine.name} is taken out of the Same family link.` },
      dissolves
        ? { kind: 'operational', text: `${others[0] ? others[0].name : 'The other profile'} is then alone, so the family link is removed from both profiles.` }
        : { kind: 'operational', text: `The other ${others.length} profiles stay linked to each other.` },
      { kind: 'operational', text: `${mine.name} no longer counts in that multi-home family for the 10% Multi-Home Discount. A discount already on a visit stays.` },
      NO_MONEY,
      NOTHING_SENT,
    ],
    sends_to_customer: false,
    _version: { op: 'unlink', account: pinOf(mine) },
    note: 'PREVIEW ONLY — nothing was changed. Confirm unlinks exactly this profile; if anything changed it refuses.',
  };
}

const buildPlan = (toolName, input, opts) => (toolName === 'link_customer_family' ? buildLinkPlan(input, opts) : buildUnlinkPlan(input, opts));

const changedError = () => Object.assign(new Error('The family changed after the card was shown.'), { code: 'preview_changed' });
const CHANGED = { failed: true, code: 'preview_changed', preview_changed: true, error: 'The profiles or their family changed after the card was shown, so nothing was changed. Ask again for a fresh confirmation card.' };

async function commit(toolName, input, actionContext) {
  const pinned = input._verified_family_link_version;
  if (!pinned) return refusal('Use the confirmation card to approve this family link change.', 'approval_required');
  const plan = await buildPlan(toolName, input);
  if (plan.error) return { error: `Nothing was changed: ${plan.error}`, code: plan.code, preview_changed: true };
  if (JSON.stringify(plan._version) !== JSON.stringify(pinned)) return { customer_id: plan.customer_id, ...CHANGED };
  const Family = require('../multi-home-family');
  const actorId = actionContext?.technicianId || null;
  let members;
  try {
    await db.transaction(async (trx) => {
      // The page's own family-change lock first (held to the end of this transaction), then the card re-read under it,
      // so no other link or unlink can land between the check and the write.
      await Family.lockFamilyChanges(trx);
      const locked = await buildPlan(toolName, input, { database: trx });
      if (locked.error || JSON.stringify(locked._version) !== JSON.stringify(plan._version)) throw changedError();
      const result = toolName === 'link_customer_family'
        ? await Family.linkFamily(trx, { customerId: plan.customer_id, otherCustomerId: plan.other_customer_id, actorId })
        : await Family.unlinkFamily(trx, { customerId: plan.customer_id, actorId });
      members = result.members || [];
    });
  } catch (err) {
    if (err?.code === 'preview_changed') return { customer_id: plan.customer_id, ...CHANGED };
    // The service's own plain refusals (multi_home_family, operational): nothing was written (the transaction rolled back).
    if (err?.code === 'multi_home_family' && err.isOperational) {
      return { customer_id: plan.customer_id, failed: true, code: 'family_refused', error: `Nothing was changed: ${err.message}` };
    }
    logger.error(`[intelligence-bar:family-link] ${toolName} failed (${err?.code || err?.name || 'error'})`);
    return { customer_id: plan.customer_id, outcome_unknown: true, code: 'execution_interrupted',
      error: 'The family link change was interrupted — it may or may not have happened. Check the Same family section on the customer page before trying again.' };
  }
  logger.info(`[intelligence-bar:family-link] ${toolName} done for ${plan.customer_id}`);
  if (toolName === 'link_customer_family') {
    return { customer_id: plan.customer_id, other_customer_id: plan.other_customer_id, success: true, sent_to_customer: false,
      family: members.map(memberLabel),
      note: `${plan.account.name} and ${plan.family_member.name} are now linked as the Same family. Nothing was sent to anyone and no price changed.` };
  }
  return { customer_id: plan.customer_id, success: true, sent_to_customer: false,
    note: `${plan.account.name} is no longer in a Same family link.${plan.dissolves ? ' The family link is removed from the other profile too.' : ''} Nothing was sent to anyone and no price changed.` };
}

// ── card lines (authorization-contract.js) ──────────────────────

function cardLines(toolName, preview) {
  if (!FAMILY_LINK_TOOLS.some((t) => t.name === toolName) || !preview || preview.preview !== true || preview.tool !== toolName) return [];
  const where = (p) => (p.address ? `${p.name}, ${p.address}` : p.name);
  if (toolName === 'link_customer_family') {
    return [
      { kind: 'customer', text: `Account: ${where(preview.account)}` },
      { kind: 'customer', text: `Family member: ${where(preview.family_member)}` },
      { kind: 'operational', text: `Family after the link: ${preview.family_after.join('; ')}` },
      ...(preview.effects || []).map(({ kind, text }) => ({ kind, text })),
    ];
  }
  return [
    { kind: 'customer', text: `Profile: ${where(preview.account)}` },
    { kind: 'operational', text: `Family now: ${preview.family_now.join('; ')}` },
    ...(preview.effects || []).map(({ kind, text }) => ({ kind, text })),
  ];
}

// The short facts the confirmation card heads with (admin-intelligence-bar.js confirmationDisplayParams).
function pinnedDisplay(toolName, preview) {
  if (!preview || preview.preview !== true || preview.tool !== toolName) return null;
  if (toolName === 'link_customer_family') {
    return { account: preview.account.name, family_member: preview.family_member.name, family_after: preview.family_after.length, prices_change: 'no', sends_to_customer: 'nothing' };
  }
  return { profile: preview.account.name, family_dissolves: preview.dissolves ? 'yes' : 'no', prices_change: 'no', sends_to_customer: 'nothing' };
}

async function executeFamilyLinkTool(toolName, input = {}, actionContext = {}) {
  if (!FAMILY_LINK_TOOLS.some((t) => t.name === toolName)) return { error: `Unknown tool: ${toolName}` };
  // Admin only, like the page's Same family section (requireAdmin); the confirmed run needs a positive admin flag.
  if (actionContext?.isAdmin === false || (input.confirmed === true && actionContext?.isAdmin !== true)) {
    return refusal('Linking customer profiles as family is limited to admin accounts', 'permission_denied');
  }
  if (!onPlatformPath()) return refusal('Linking customer profiles as family from the bar is switched off.', 'gate_off');
  try {
    // Only /confirm-action sets confirmed (route-derived, never a model param).
    return input.confirmed === true ? await commit(toolName, input, actionContext) : await buildPlan(toolName, input);
  } catch (err) {
    logger.error(`[intelligence-bar:family-link] ${toolName} failed (${err?.code || err?.name || 'error'})`);
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', error: 'The family link change was interrupted — it may or may not have happened. Check the Same family section on the customer page before trying again.' }
      : { error: 'Could not prepare the family link card' };
  }
}

module.exports = {
  FAMILY_LINK_TOOLS,
  executeFamilyLinkTool,
  cardLines,
  pinnedDisplay,
  buildPlan,
};
