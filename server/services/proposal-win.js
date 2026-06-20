// ============================================================
// proposal-win.js — Commercial-proposal "win" paths (#1917)
//
// PR #1913 shipped the commercial-proposal PDF + manual acceptance, but
// deferred two acceptance paths because EstimateConverter does not read a
// proposal's per-building pricing (it converts the legacy result/recurring
// service mix). Those two paths live here and are invoked from
// estimate-manual-acceptance.js when an operator marks a commercial proposal
// won:
//
//   1. LEAD WIN — the proposal estimate has no linked customer (a pure
//      prospect, e.g. an HOA quoted from scratch). Winning auto-creates the
//      customer from the proposal/contact details and promotes it to a real
//      customer (pipeline_stage=active_customer, member_since=today), reusing
//      the canonical account/customer-creation helpers so the new row gets the
//      same default sub-rows and account de-dup as the Customers quick-add.
//
//   2. INVOICE-MODE WIN — the proposal is bill_by_invoice (billed by invoice,
//      not autopay). Winning builds the first invoice directly from the
//      proposal line items: every line billed once = the one-time items plus
//      the first period of each recurring line (a line's `amount` is already a
//      single occurrence). Ongoing recurring visits bill as completed through
//      the normal per-visit invoicing; scheduling/onboarding stays operator
//      driven, matching #1913's design.
//
// Tax: InvoiceService applies a single rate to the whole subtotal, but a
// proposal carries per-line `taxable` flags. We pass a blended effective rate
// (taxableSubtotal * taxRate / subtotal) so the invoice's tax dollars match
// the proposal PDF exactly. When the proposal is uniformly taxable (or fully
// non-taxable — the common case) the blended rate equals the real rate (or 0).
// ============================================================

const InvoiceService = require('./invoice');
const { computeProposalTotals } = require('./estimate-proposal');
const { etDateString } = require('../utils/datetime-et');
const logger = require('./logger');

// Real-customer stages (mirrors customer-stages whereRealCustomer / the route's
// REAL_CUSTOMER_STAGES). Entering one stamps member_since as the conversion date.
const REAL_CUSTOMER_STAGES = new Set(['active_customer', 'won', 'at_risk']);
// Stages whose member_since is a genuine customer start to preserve; anything
// else is a pre-sale lead-intake date that conversion overwrites.
const FORMER_OR_CURRENT_CUSTOMER_STAGES = new Set([...REAL_CUSTOMER_STAGES, 'churned', 'dormant']);

// Human label for the first occurrence of each recurring cadence, appended to
// the invoice line so a board reader knows the recurring price is one period.
const FIRST_PERIOD_LABEL = {
  monthly: 'first month',
  bimonthly: 'first 2-month service',
  quarterly: 'first quarter',
  annual: 'first year',
};

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanStr(value, max = 200) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function winError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// Resolve the contact/identity for the new customer from the proposal first
// (operator-authored), then the estimate's own contact fields.
function resolveProposalWinContact(estimate = {}, proposal = {}) {
  // Clamp to the DB column widths so a long HOA/legal name can't roll the
  // insert back: customers/customer_accounts first_name varchar(50),
  // company_name varchar(150), phone varchar(20), email varchar(150).
  const fullName = cleanStr(proposal.preparedFor || estimate.customer_name, 150);
  return {
    name: fullName.slice(0, 50),
    companyName: fullName || null,
    phone: cleanStr(estimate.customer_phone, 20) || null,
    email: cleanStr(estimate.customer_email, 150).toLowerCase() || null,
    address: cleanStr(proposal.propertyAddress || estimate.address, 200) || null,
  };
}

// Build the acceptance invoice line items + tax from the proposal: every line
// once (one-time items + first period of each recurring line).
function buildProposalFirstInvoice(proposal) {
  const buildings = Array.isArray(proposal?.buildings) ? proposal.buildings : [];
  const isMultiBuilding = buildings.length > 1;
  const taxRate = Math.min(1, Math.max(0, num(proposal?.taxRate, 0)));

  const lineItems = [];
  let subtotal = 0;
  let taxableSubtotal = 0;

  for (const building of buildings) {
    const buildingName = cleanStr(building?.name, 120);
    for (const item of (Array.isArray(building?.lineItems) ? building.lineItems : [])) {
      const amount = roundMoney(item?.amount);
      if (!(amount > 0)) continue;

      const periodNote = item.frequency && item.frequency !== 'one_time'
        ? ` (${FIRST_PERIOD_LABEL[item.frequency] || 'first period'})`
        : '';
      const prefix = isMultiBuilding && buildingName ? `${buildingName} — ` : '';
      const description = cleanStr(`${prefix}${item.description || 'Service'}${periodNote}`, 300);

      lineItems.push({
        description,
        quantity: Math.max(1, Math.round(num(item.quantity, 1))),
        unit_price: roundMoney(item.unitPrice),
      });
      subtotal = roundMoney(subtotal + amount);
      if (item.taxable === true) taxableSubtotal = roundMoney(taxableSubtotal + amount);
    }
  }

  const taxAmount = roundMoney(taxableSubtotal * taxRate);
  // Blended rate so InvoiceService (single-rate) reproduces the exact tax
  // dollars across mixed-taxability lines. round(subtotal * (taxAmount/subtotal))
  // === taxAmount, so the invoice total matches the proposal PDF to the cent.
  const blendedTaxRate = subtotal > 0 ? taxAmount / subtotal : 0;

  return {
    lineItems,
    subtotal,
    taxableSubtotal,
    taxRate,
    taxAmount,
    blendedTaxRate,
    total: roundMoney(subtotal + taxAmount),
  };
}

// Stamps that promote a customer to a real, active customer on a proposal win:
// lead-stage → active_customer with member_since as the conversion date, and
// reactivate a deactivated/churned row. Returns {} when the row is already a
// live real customer. Mirrors the EstimateConverter promotion semantics that
// commercial proposals skip (they don't run the converter).
function commercialWinPromotionStamps(customer = {}, today = etDateString()) {
  const stamps = {};
  if (!REAL_CUSTOMER_STAGES.has(customer.pipeline_stage)) {
    stamps.pipeline_stage = 'active_customer';
    stamps.pipeline_stage_changed_at = new Date();
    if (!FORMER_OR_CURRENT_CUSTOMER_STAGES.has(customer.pipeline_stage) || !customer.member_since) {
      stamps.member_since = today;
    }
  }
  if (customer.active === false) stamps.active = true;
  if (customer.pipeline_stage === 'churned' || customer.churned_at) {
    stamps.churned_at = null;
    stamps.churn_reason = null;
  }
  // Un-archive a soft-deleted customer being reactivated on a win (mirrors
  // EstimateConverter) — otherwise the won/invoiced customer stays hidden from
  // whereNull(deleted_at) admin/revenue/dashboard queries.
  if (customer.deleted_at) stamps.deleted_at = null;
  return stamps;
}

// Promote an ALREADY-linked customer on a commercial proposal win. Proposals
// skip EstimateConverter (the path that normally promotes/reactivates a linked
// customer), so without this a proposal linked to a lead/inactive/churned
// customer would be won + invoiced while the customer stays outside
// active-customer/revenue/dashboard queries.
async function promoteLinkedCustomerForProposalWin({ trx, customerId, today = etDateString() }) {
  if (!customerId) return;
  const customer = await trx('customers')
    .where({ id: customerId })
    .first('pipeline_stage', 'member_since', 'active', 'churned_at', 'deleted_at');
  if (!customer) return;
  const stamps = commercialWinPromotionStamps(customer, today);
  if (Object.keys(stamps).length) {
    await trx('customers').where({ id: customerId }).update(stamps);
    logger.info(`[proposal-win] promoted linked customer ${customerId} on proposal win`);
  }
}

// Auto-create (or link + promote) the customer for a no-customer proposal win.
// Returns { customerId, created }.
async function ensureCustomerForProposalWin({ trx, estimate, proposal, today = etDateString() }) {
  const contact = resolveProposalWinContact(estimate, proposal);
  // customers.phone is NOT NULL and the account de-dup key, so a new-customer
  // win needs a phone. Fail with a controlled validation error rather than
  // letting the insert hit a DB not-null/unique error and 500/rollback.
  if (!contact.phone) {
    throw winError(
      'Add a phone number to the estimate before winning it as a new customer.',
      400,
    );
  }

  // Reuse the canonical account de-dup + customer-create primitives (same path
  // as Customers quick-add / leads convert). Lazy-required to avoid a
  // service↔route load cycle.
  const adminCustomers = require('../routes/admin-customers');
  const { ensureCustomerAccount, createDefaultCustomerRows } = adminCustomers;

  const firstName = contact.name || 'Commercial Account';
  const account = await ensureCustomerAccount(trx, {
    firstName,
    lastName: null,
    phone: contact.phone,
    email: contact.email,
    companyName: contact.companyName,
  });

  // A customer already exists for this contact (phone match): link to it and
  // promote a lead-stage row to a real customer rather than creating a
  // duplicate profile (customer-count accuracy).
  if (account.existingCustomer?.id) {
    const existing = account.existingCustomer;
    // Link to it and promote/reactivate (lead→active_customer, undo churn/
    // deactivation) rather than creating a duplicate profile.
    const stamps = commercialWinPromotionStamps(existing, today);
    if (Object.keys(stamps).length) {
      await trx('customers').where({ id: existing.id }).update(stamps);
    }
    logger.info(`[proposal-win] linked proposal estimate ${estimate.id} to existing customer ${existing.id}`);
    return { customerId: existing.id, created: false };
  }

  const [created] = await trx('customers').insert({
    account_id: account.accountId,
    is_primary_profile: true,
    profile_label: 'Commercial property',
    first_name: firstName,
    last_name: null,
    phone: contact.phone,
    email: contact.email,
    address_line1: contact.address,
    pipeline_stage: 'active_customer',
    pipeline_stage_changed_at: new Date(),
    member_since: today,
    lead_source: 'commercial_proposal',
    // A commercial proposal IS commercial service. property_type drives
    // taxability (InvoiceService forces residential invoices to $0 tax per
    // operator policy), so the proposal's per-line tax only bills when the
    // customer is commercial.
    property_type: 'commercial',
    active: true,
  }).returning('*');
  await createDefaultCustomerRows(trx, created.id);
  logger.info(`[proposal-win] created customer ${created.id} from won proposal estimate ${estimate.id}`);
  return { customerId: created.id, created: true };
}

// Create the acceptance invoice for a bill-by-invoice commercial proposal.
// Returns the invoice row, or null when the proposal has no billable lines.
async function createProposalAcceptanceInvoice({ trx, estimate, proposal, customerId }) {
  if (!customerId) throw winError('A customer is required to invoice a proposal win.', 400);
  const built = buildProposalFirstInvoice(proposal);
  if (!built.lineItems.length || !(built.subtotal > 0)) {
    logger.warn(`[proposal-win] proposal estimate ${estimate.id} has no billable lines — invoice skipped`);
    return null;
  }

  // InvoiceService forces residential invoices to $0 tax (operator policy keyed
  // on customers.property_type). When the proposal has taxable lines, the
  // billed customer must be commercial or the tax silently drops to $0 and the
  // board is underbilled — so ensure the flag before invoicing. (A new
  // proposal-win customer is already inserted commercial; this covers a
  // phone-matched or operator-pre-linked customer.)
  if (built.taxableSubtotal > 0) {
    const cust = await trx('customers').where({ id: customerId }).first('property_type');
    if (cust && cust.property_type !== 'commercial' && cust.property_type !== 'business') {
      await trx('customers').where({ id: customerId }).update({ property_type: 'commercial' });
      logger.info(`[proposal-win] flagged customer ${customerId} commercial so taxable proposal estimate ${estimate.id} bills tax`);
    }
  }

  const invoice = await InvoiceService.create({
    database: trx,
    customerId,
    title: cleanStr(proposal.title || 'Commercial Service Proposal', 160),
    lineItems: built.lineItems,
    taxRate: built.blendedTaxRate,
    notes: `Generated from accepted commercial proposal (estimate #${estimate.id}). `
      + 'Covers one-time items plus the first period of each recurring service; '
      + 'ongoing recurring visits are billed as completed.',
    dueDate: etDateString(),
  });
  logger.info(`[proposal-win] invoice ${invoice.invoice_number} ($${built.total}) from won proposal estimate ${estimate.id}`);
  return invoice;
}

module.exports = {
  REAL_CUSTOMER_STAGES,
  resolveProposalWinContact,
  buildProposalFirstInvoice,
  commercialWinPromotionStamps,
  promoteLinkedCustomerForProposalWin,
  ensureCustomerForProposalWin,
  createProposalAcceptanceInvoice,
};
