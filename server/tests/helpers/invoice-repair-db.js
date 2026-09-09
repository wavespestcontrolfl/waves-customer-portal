const knex = require('knex');
const { randomUUID } = require('crypto');

// Explicit throwaway local database only. Each suite owns a random schema.
// This is the repair's relevant PostgreSQL schema subset, not a claim that
// every production migration ran. FK types/links follow initial_schema,
// invoices, service_records_scheduled_service_id, service_completion_attempts,
// appointment_workflow, third_party_payers, annual_prepay_terms, and visit_billing_dispositions.
async function createRepairDatabase() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/invoice_repair_test') {
    throw new Error('Repair tests require a local invoice_repair_test database');
  }
  const schema = `repair_${randomUUID().replace(/-/g, '')}`;
  const db = knex({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 8 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw(`
    CREATE TABLE payers (id serial PRIMARY KEY, active boolean DEFAULT true, tax_exempt boolean DEFAULT false,
      payment_terms text, display_name text, company_name text, ap_email text,
      billing_address_line1 text, billing_city text, billing_state text, billing_zip text);
    CREATE TABLE customers (id uuid PRIMARY KEY, payer_id integer REFERENCES payers(id));
    CREATE TABLE technicians (id uuid PRIMARY KEY, name text);
    CREATE TABLE services (id uuid PRIMARY KEY, name text, is_active boolean DEFAULT true);
    CREATE TABLE scheduled_services (id uuid PRIMARY KEY, customer_id uuid REFERENCES customers(id),
      scheduled_date date, service_type text, service_key_snapshot text, status text,
      technician_id uuid REFERENCES technicians(id), payer_id integer REFERENCES payers(id),
      po_number text, self_pay_override boolean DEFAULT false, is_callback boolean DEFAULT false, visit_id uuid);
    CREATE TABLE service_records (id uuid PRIMARY KEY, customer_id uuid REFERENCES customers(id),
      scheduled_service_id uuid REFERENCES scheduled_services(id), is_callback boolean DEFAULT false);
    CREATE TABLE service_completion_attempts (id uuid PRIMARY KEY,
      service_id uuid REFERENCES scheduled_services(id), service_record_id uuid REFERENCES service_records(id),
      status text, updated_at timestamptz DEFAULT now());
    CREATE TABLE invoices (id uuid PRIMARY KEY, customer_id uuid REFERENCES customers(id), status text,
      service_date date, service_type text, title text, line_items jsonb, subtotal numeric(10,2),
      discount_amount numeric(10,2), tax_amount numeric(10,2) DEFAULT 0, total numeric(10,2),
      technician_id uuid REFERENCES technicians(id), tech_name text, payer_id integer REFERENCES payers(id),
      po_number text, tax_rate numeric DEFAULT 0, payer_snapshot jsonb,
      scheduled_service_id uuid REFERENCES scheduled_services(id), service_record_id uuid REFERENCES service_records(id),
      annual_prepay_term_id uuid, archived_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE annual_prepay_terms (id uuid PRIMARY KEY, prepay_invoice_id uuid UNIQUE REFERENCES invoices(id) ON DELETE SET NULL);
    CREATE TABLE scheduled_service_addons (id uuid PRIMARY KEY, scheduled_service_id uuid REFERENCES scheduled_services(id));
    CREATE TABLE visit_billing_dispositions (id uuid PRIMARY KEY, scheduled_service_id uuid UNIQUE REFERENCES scheduled_services(id));
    CREATE TABLE visit_completion_packets (id uuid PRIMARY KEY, visit_id uuid UNIQUE);
  `);
  return { db, schema, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

async function seedPair(db, { invoice = {}, visit = {}, record = {}, customerId = randomUUID() } = {}) {
  const techId = randomUUID(); const invoiceId = randomUUID(); const visitId = randomUUID(); const recordId = randomUUID();
  await db('customers').insert({ id: customerId }).onConflict('id').ignore();
  await db('technicians').insert({ id: techId, name: 'Fixture Technician' });
  await db('scheduled_services').insert({ id: visitId, customer_id: customerId, scheduled_date: '2020-01-01',
    service_type: 'Pest Control', status: 'completed', technician_id: techId, ...visit });
  await db('service_records').insert({ id: recordId, customer_id: customerId, scheduled_service_id: visitId, ...record });
  await db('invoices').insert({ id: invoiceId, customer_id: customerId, status: 'paid', service_date: '2020-01-01',
    line_items: JSON.stringify([{ description: 'Pest Control', amount: 100 }]), total: 100, ...invoice });
  return { customerId, techId, invoiceId, visitId, recordId };
}

module.exports = { createRepairDatabase, seedPair };
