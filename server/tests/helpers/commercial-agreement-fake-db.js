// Synthetic fixtures and an in-memory stand-in for the tables the commercial proposal agreement service touches.
// Shared by commercial-proposal-agreement.test.js and the sign-route tests. No customer data.
const TEMPLATE_KEY = 'service_agreement.commercial_pest';

// Version 1's fixed payment paragraph (migration 20260623000005), so an issue on this body behaves like production's.
const { V1_PAYMENT } = require('../../models/migrations/20261025120000_commercial_agreement_payment_terms');
const BODY = [
  'Commercial Pest Service Agreement',
  'Business / account: {{customer.name}}',
  'Service location(s): {{customer.address}}',
  'Service plan: {{service.name}}',
  'Start date: {{agreement.start_date}}',
  V1_PAYMENT,
].join('\n');
const TEMPLATE = { id: 'tpl-1', template_key: TEMPLATE_KEY, status: 'active', active_version_id: 'ver-1', requires_signature: true, expire_after_days: 14, name: 'Commercial Pest Service Agreement' };
const VERSION = { id: 'ver-1', template_id: 'tpl-1', version_number: 1, title: 'Commercial Pest Service Agreement', body: BODY, signer_disclosure: 'I agree to sign electronically.' };

function estimateRow(overrides = {}, proposalOverrides = {}) {
  return {
    id: 'est-0001',
    estimate_slug: 'EST-2026-0042',
    customer_id: 'cust-1',
    status: 'viewed',
    customer_name: 'Harbor Plaza Association',
    address: '100 Sample Way, Bradenton, FL 34205',
    estimate_data: {
      proposal: {
        enabled: true,
        title: 'Commercial Service Proposal',
        preparedFor: 'Harbor Plaza Association LLC',
        propertyAddress: '100 Sample Way, Bradenton, FL 34205',
        taxRate: 0.07,
        taxLabel: 'Sales tax',
        commercialTerms: { paymentTerms: 'net30' },
        buildingUse: 'nonresidential',
        buildings: [{ name: 'Main building', lineItems: [{ description: 'Quarterly pest service', quantity: 1, unitPrice: 300, frequency: 'quarterly', taxable: true }] }],
        ...proposalOverrides,
      },
    },
    ...overrides,
  };
}

const CUSTOMER = { id: 'cust-1', first_name: 'Pat', last_name: 'Sample', email: 'pat@example.com', phone: '+19415550100', address_line1: '9 Home St', active: true };

// A tiny in-memory stand-in for the tables the service touches.
function makeDb({ estimate = estimateRow(), customer = CUSTOMER, contracts = [], template = TEMPLATE, version = VERSION } = {}) {
  const state = { estimate, customer, template, version, contracts: contracts.map((c) => ({ ...c })), events: [], writes: [], order: [] };
  const snapshotEstimateId = (row) => {
    const snap = typeof row.document_variables_snapshot === 'string' ? JSON.parse(row.document_variables_snapshot) : row.document_variables_snapshot;
    return snap?.estimate?.id;
  };
  const make = (table) => {
    const q = { where: {}, statusIn: null, statusNotIn: null, estimateId: null };
    const api = {
      where(obj) { Object.assign(q.where, obj); return api; },
      whereNull() { return api; },
      whereIn(col, vals) { if (col === 'status') q.statusIn = vals; return api; },
      whereNotIn(col, vals) { if (col === 'status') q.statusNotIn = vals; return api; },
      whereRaw(_sql, binds) { q.estimateId = binds[0]; return api; },
      orderByRaw() { return api; },
      forUpdate() { q.locked = true; state.order.push(table); return api; },
      async first() {
        if (table === 'document_templates') return q.where.template_key ? state.template : { active_version_id: state.template.active_version_id, status: state.template.status, template_key: state.template.template_key };
        if (table === 'document_template_versions') return state.version;
        if (table === 'estimates') return state.estimate;
        if (table === 'customers') return state.customer;
        if (table === 'customer_contracts') {
          // Lets a test act while the contract row lock is being waited on.
          if (q.locked && typeof state.onContractLock === 'function') await state.onContractLock();
          const rows = state.contracts
            .filter((c) => (q.where.id ? c.id === q.where.id : c.document_template_key === q.where.document_template_key))
            .filter((c) => q.estimateId == null || String(snapshotEstimateId(c)) === String(q.estimateId))
            .filter((c) => !q.statusIn || q.statusIn.includes(c.status))
            .filter((c) => !q.statusNotIn || !q.statusNotIn.includes(c.status))
            .sort((a, b) => (b.status === 'signed') - (a.status === 'signed'));
          return rows[0] || null;
        }
        return null;
      },
      async update(payload) {
        state.writes.push({ table, op: 'update', payload });
        if (table !== 'customer_contracts') return 1;
        const row = state.contracts.find((c) => c.id === q.where.id && (!q.statusIn || q.statusIn.includes(c.status)));
        if (!row) return 0;
        Object.assign(row, payload);
        return 1;
      },
      insert(row) {
        state.writes.push({ table, op: 'insert', payload: row });
        const stored = { id: `contract-${state.contracts.length + 1}`, created_at: new Date(), ...row };
        if (table === 'customer_contracts') state.contracts.push(stored);
        if (table === 'customer_contract_events') state.events.push(row);
        const result = Promise.resolve([1]);
        result.returning = async () => [stored];
        return result;
      },
    };
    return api;
  };
  const database = (table) => make(table);
  database.transaction = async (cb) => cb(database);
  database.raw = (s) => s;
  return { database, state };
}

module.exports = { BODY, TEMPLATE, VERSION, CUSTOMER, estimateRow, makeDb };
