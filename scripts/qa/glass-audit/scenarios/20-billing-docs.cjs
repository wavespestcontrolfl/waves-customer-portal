'use strict';
// Billing + document surfaces served by the SPA against token-gated public
// routes. Every payload here is FICTIONAL and shaped from the page's fetch
// usage + the serving route:
//   /pay/:token            client/src/pages/PayPageV2.jsx        server/routes/pay-v2.js
//   /pay/statement/:token  client/src/pages/StatementPayPage.jsx server/routes/pay-statement.js
//   /receipt/:token        client/src/pages/ReceiptPage.jsx      server/routes/receipt-v2.js
//   /contract/:token       client/src/pages/ContractSignPage.jsx server/routes/contracts-public.js
//   /price-change/:token   client/src/pages/PriceChangeNoticePage.jsx server/routes/price-change-public.js
//
// Stripe: the harness blocks every external origin, so https://js.stripe.com/v3/
// can never load. Left alone, the loader's 3 aborted attempts (~2s) flip the
// pay forms into their "couldn't load the secure payment form" retry card.
// The populated states therefore HOLD the Stripe script request pending (a
// route registered in `ready`, which out-ranks the harness's abort route) so
// the capture shows the page's own chrome around the Payment Element mount —
// method tiles, consent, totals, Pay button — with the iframe area empty.
// `stripe-blocked` states capture the retry card the harness's abort produces.
/* global document */

const HEX = '0123456789abcdef';
const hexToken = (seed, len) => Array.from({ length: len }, (_, i) => HEX[(seed * 7 + i * 13 + Math.floor(i / 3)) % 16]).join('');

const PAY_TOKEN = hexToken(1, 64);        // pay-v2.js TOKEN_RE /^[A-Za-z0-9_-]{20,64}$/
const STATEMENT_TOKEN = hexToken(2, 64);  // pay-statement.js /^[0-9a-f]{64}$/i
const RECEIPT_TOKEN = hexToken(3, 64);    // receipt-v2.js reuses the 64-char invoice token
const CONTRACT_TOKEN = hexToken(4, 64);   // contracts-public.js accepts 32..160 chars
const PRICE_TOKEN = hexToken(5, 32);      // price-change-public.js /^[a-f0-9]{32}$/i

const PUBLISHABLE_KEY = 'pk_test_glassaudit000000000000000000';

const json = (body, status = 200) => ({ status, body });
// PayPageV2 flips an unpaid invoice / statement into its "overdue" banner once the due date has passed
// (client/src/lib/invoiceDates.js), so open balances are due 14 ET calendar days after the run.
const { addETDays, etDateString } = require('../../../../server/utils/datetime-et');
const DUE_SOON = etDateString(addETDays(new Date(), 14));
const serverError = () => json({ error: 'glass-audit: simulated 500' }, 500);

// Hold the Stripe.js request open (never resolves, never errors) so the pay
// form stays in its pre-Element state for the capture, then wait for `text`.
const holdStripeThen = (text) => async (page) => {
  await page.route(/^https:\/\/js\.stripe\.com\//, () => new Promise(() => {}));
  await page.waitForFunction((t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()), text, { timeout: 30000 });
};

// ── /pay/:token ────────────────────────────────────────────────────────
const payLineItems = [
  { description: 'Quarterly Pest Control — exterior perimeter treatment, entry-point sealing and web removal', quantity: 1, unit_price: 149, amount: 149 },
  { description: 'Interior spot treatment (garage + lanai)', quantity: 1, unit_price: 25, amount: 25 },
  { description: 'Bait station refresh', quantity: 3, unit_price: 5, amount: 15 },
];

const payInvoice = (overrides = {}) => ({
  id: 4117,
  invoiceNumber: 'INV-2026-04117',
  title: 'Quarterly Pest Control — September 2026',
  status: 'sent',
  version: 1757400000000,
  saveRequired: false,
  captureNeeded: false,
  lineItems: payLineItems,
  subtotal: 189,
  discountAmount: 15,
  discountLabel: 'Neighbor referral discount',
  taxRate: 0,
  taxAmount: 0,
  total: 174,
  amountDue: 174,
  creditApplied: 0,
  dueDate: DUE_SOON,
  paidAt: null,
  cardBrand: null,
  cardLastFour: null,
  receiptUrl: null,
  notes: 'Gate code is on file. Please keep pets inside until the exterior application is dry — your technician will confirm timing.',
  annualPrepay: null,
  attachments: [
    { id: 91, fileName: 'Service-photos-September.pdf', mimeType: 'application/pdf', fileSizeBytes: 482113, createdAt: '2026-09-08T18:20:00.000Z' },
  ],
  ...overrides,
});

const payService = {
  type: 'Quarterly Pest Control',
  date: '2026-09-08',
  techName: 'Alex Morgan',
  techNotes: null,
  productsApplied: [],
  photos: [],
};

const customer = {
  firstName: 'Jordan',
  lastName: 'Rivera',
  email: 'jordan.rivera@example.com',
  tier: null,
  address: '1200 Sample Lane',
  city: 'Venice',
  state: 'FL',
  zip: '34285',
  isCommercial: false,
};

const payPayload = (invoiceOverrides = {}) => ({
  invoice: payInvoice(invoiceOverrides),
  service: payService,
  customer,
  payer: null,
  processor: 'stripe',
  stripe: { available: true, publishableKey: PUBLISHABLE_KEY },
  manualPayOptions: { zelle: { recipient: 'billing@example.com' }, amountDue: 174, version: 1757400000000 },
  payFaq: true,
});

const paySetupResponse = {
  version: 1757400000000,
  clientSecret: 'pi_glassaudit0000_secret_glassaudit0000',
  paymentIntentId: 'pi_glassaudit0000',
  amount: 174,
  baseAmount: 174,
  cardSurchargeRate: 0.029,
  publishableKey: PUBLISHABLE_KEY,
  coveredByCredit: false,
  status: 'sent',
  captureNeeded: false,
};

const payHandle = (invoiceOverrides = {}) => ({ method, path }) => {
  if (method === 'GET' && path === `/api/pay/${PAY_TOKEN}`) return json(payPayload(invoiceOverrides));
  if (method === 'POST' && path === `/api/pay/${PAY_TOKEN}/setup`) return json(paySetupResponse);
  if (method === 'POST' && path === `/api/pay/${PAY_TOKEN}/error`) return json({ ok: true });
  // The save-card effect re-locks the PI's tender on mount; answer with the
  // base amount (no surcharge until a card is quoted) — server shape from
  // StripeService.updatePaymentIntentAmount as consumed by syncAmountForMethod.
  if (method === 'POST' && path === `/api/pay/${PAY_TOKEN}/update-amount`) return json({ base: 174, surcharge: 0, total: 174, replaced: false });
  return null;
};

// ── /receipt/:token ────────────────────────────────────────────────────
const receiptPayload = () => ({
  invoice: {
    id: 4088,
    invoiceNumber: 'INV-2026-04088',
    title: 'Quarterly Pest Control + Lawn Fertilization — August 2026',
    status: 'paid',
    lineItems: [
      { description: 'Quarterly Pest Control — exterior perimeter treatment, entry-point sealing, web removal and interior spot treatment of garage and lanai', quantity: 1, unit_price: 149, amount: 149 },
      { description: 'Lawn fertilization (granular, slow-release)', quantity: 1, unit_price: 65, amount: 65 },
      { description: 'Bait station refresh', quantity: 3, unit_price: 5, amount: 15 },
      { description: 'Mosquito barrier add-on', quantity: 1, unit_price: 39, amount: 39 },
    ],
    subtotal: 268,
    discountAmount: 20,
    discountLabel: 'Bundle discount',
    taxRate: 0,
    taxAmount: 0,
    total: 248,
    creditApplied: 0,
    dueDate: '2026-09-05',
    paidAt: '2026-09-09T14:12:00.000Z',
    paymentMethod: 'card',
    cardBrand: 'visa',
    cardLastFour: '4242',
    notes: 'Thanks for leaving the side gate unlocked — the lanai screen was treated as requested.',
    creditMemo: null,
  },
  service: { type: 'Quarterly Pest Control', date: '2026-08-28', techName: 'Alex Morgan' },
  customer,
  payer: null,
  payment: {
    amount: 255.19,
    baseAmountCents: 24800,
    surchargeAmountCents: 719,
    surchargeRateBps: 290,
    cardFunding: 'credit',
    paymentDate: '2026-09-09T14:12:00.000Z',
    cardBrand: 'visa',
    cardLastFour: '4242',
    refundAmount: 0,
    refundStatus: null,
    refundedAt: null,
    remainingPaid: 255.19,
    state: 'paid',
  },
});

const receiptHandle = ({ method, path }) => {
  if (method === 'GET' && path === `/api/receipt/${RECEIPT_TOKEN}`) return json(receiptPayload());
  return null;
};

// ── /pay/statement/:token ──────────────────────────────────────────────
const statementPayload = (overrides = {}) => ({
  statement: {
    id: 218,
    number: 'S-218',
    status: 'sent',
    payable: true,
    period_start: '2026-08-01',
    period_end: '2026-08-31',
    due_date: DUE_SOON,
    terms: 'net30',
    subtotal: 645,
    tax_amount: 45.15,
    total: 690.15,
    invoice_count: 4,
    paid_at: null,
    active_payment_intent_id: null,
    ...overrides,
  },
  billTo: { company: 'Sample Property Management LLC', ap_email: 'ap@example.com' },
  lines: [
    { invoice_number: 'INV-2026-04021', service_date: '2026-08-04', service_type: 'Quarterly Pest Control', service_address: '1200 Sample Lane, Venice FL', subtotal: 149, tax_amount: 10.43, total: 159.43 },
    { invoice_number: 'INV-2026-04033', service_date: '2026-08-11', service_type: 'Quarterly Pest Control', service_address: '1204 Sample Lane, Venice FL', subtotal: 149, tax_amount: 10.43, total: 159.43 },
    { invoice_number: 'INV-2026-04049', service_date: '2026-08-18', service_type: 'Rodent exclusion follow-up', service_address: '18 Example Court, Nokomis FL', subtotal: 198, tax_amount: 13.86, total: 211.86 },
    { invoice_number: 'INV-2026-04061', service_date: '2026-08-26', service_type: 'Quarterly Pest Control', service_address: '1208 Sample Lane, Venice FL', subtotal: 149, tax_amount: 10.43, total: 159.43 },
  ],
  surchargeRateBps: 290,
  publishableKey: PUBLISHABLE_KEY,
});

const statementHandle = (overrides = {}) => ({ method, path }) => {
  if (method === 'GET' && path === `/api/pay/statement/${STATEMENT_TOKEN}`) return json(statementPayload(overrides));
  if (method === 'POST' && path === `/api/pay/statement/${STATEMENT_TOKEN}/setup`) {
    return json({ clientSecret: 'pi_glassauditstmt_secret_glassauditstmt', paymentIntentId: 'pi_glassauditstmt', amount: 690.15, baseAmount: 690.15, cardSurchargeRate: 0.029, publishableKey: PUBLISHABLE_KEY });
  }
  return null;
};

// ── /contract/:token ───────────────────────────────────────────────────
const CONTRACT_TEXT = [
  'RESIDENTIAL SERVICE AGREEMENT',
  '',
  'This agreement is between Waves Pest Control ("Waves") and the customer named above ("Customer") for recurring pest management at the service address on file.',
  '',
  '1. Services. Waves will perform quarterly exterior perimeter treatments, targeted interior treatments on request, and free re-service visits between scheduled treatments whenever covered activity is observed.',
  '',
  '2. Term. This agreement has no fixed term. Either party may end the recurring service at any time with notice; visits already performed remain billable.',
  '',
  '3. Pricing. The recurring price is shown on the estimate accepted by Customer. Waves provides written advance notice before any change to the recurring price.',
  '',
  '4. Access. Customer will provide reasonable access to the property, including gate codes and pet arrangements, on scheduled visit days.',
  '',
  '5. Payment. Invoices are due on receipt. Saved payment methods are charged only with Customer authorization recorded electronically.',
  '',
  '6. Electronic signature. By typing initials and a name below, Customer agrees that the electronic signature has the same effect as a handwritten signature.',
].join('\n');

const contractRow = (overrides = {}) => ({
  id: 612,
  customerId: 3301,
  paymentMethodId: null,
  createdBy: 7,
  contractType: 'document_template',
  title: 'Residential Service Agreement',
  status: 'viewed',
  recipientName: 'Jordan Rivera',
  recipientEmail: 'jordan.rivera@example.com',
  recipientPhone: null,
  serviceName: 'Quarterly Pest Control',
  renewalDate: null,
  cancellationDeadline: null,
  autoRenewalNoticeRequired: false,
  autoRenewalNoticeSentAt: null,
  consentTextVersion: null,
  consentTextSnapshot: null,
  contractTextSnapshot: CONTRACT_TEXT,
  esignDisclosureSnapshot: null,
  documentTemplateId: 12,
  documentTemplateVersionId: 31,
  documentTemplateKey: 'service_agreement',
  documentTemplateCategory: 'agreements',
  documentTemplateDocumentType: 'service_agreement',
  requiresSignature: true,
  // contracts-public.js answers 410 for an expired share token; keep it 30 days past the run.
  shareTokenExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
  sharedAt: '2026-09-08T12:00:00.000Z',
  viewedAt: '2026-09-09T15:04:00.000Z',
  signedAt: null,
  signedName: null,
  recipientInitials: null,
  cancelledAt: null,
  cancelledReason: null,
  createdAt: '2026-09-08T11:58:00.000Z',
  updatedAt: '2026-09-09T15:04:00.000Z',
  paymentMethodLabel: null,
  cardBrand: null,
  lastFour: null,
  methodType: null,
  bankName: null,
  signingUrl: null,
  ...overrides,
});

const autopayContract = () => contractRow({
  id: 613,
  contractType: 'autopay_authorization',
  title: 'AutoPay Authorization',
  documentTemplateId: null,
  documentTemplateVersionId: null,
  documentTemplateKey: null,
  documentTemplateCategory: null,
  documentTemplateDocumentType: null,
  paymentMethodId: 88,
  paymentMethodLabel: 'Visa ending 4242',
  cardBrand: 'visa',
  lastFour: '4242',
  methodType: 'card',
  // The AutoPay card renders both of these as live deadlines ("renews on", "cancel by"), so a
  // literal pair turns into a contract that renewed months ago -- generated from the run instead.
  renewalDate: etDateString(addETDays(new Date(), 180)),
  cancellationDeadline: etDateString(addETDays(new Date(), 166)),
  consentTextVersion: 'v3',
  contractTextSnapshot: [
    'AUTOPAY AUTHORIZATION',
    '',
    'I authorize Waves Pest Control to keep the payment method listed above on file and to charge it for agreed recurring service visits and any add-on service I approve, at the prices shown on my accepted estimate.',
    '',
    'I understand I can revoke this authorization at any time by contacting Waves, and that Waves will provide written notice before any change to the recurring price.',
  ].join('\n'),
});

const contractHandle = (row) => ({ method, path }) => {
  if (method === 'GET' && path === `/api/contracts/${CONTRACT_TOKEN}`) return json({ contract: row });
  if (method === 'POST' && path === `/api/contracts/${CONTRACT_TOKEN}/sign`) {
    return json({ contract: { ...row, status: 'signed', signedAt: '2026-09-10T13:30:00.000Z', signedName: 'Jordan Rivera', recipientInitials: 'JR' } });
  }
  return null;
};

// Drive the unsigned form through a (mocked) sign so the page renders its
// own signed-success card — the public GET 410s once a contract is signed,
// so this is the only way that state is reachable.
const signContract = async (page) => {
  await page.locator('input[name="initials"]').fill('JR');
  await page.locator('input[name="signedName"]').fill('Jordan Rivera');
  for (const box of await page.locator('input[type="checkbox"]').all()) await box.check();
  await page.getByRole('button', { name: /^Sign (Document|Authorization)$/ }).click();
  await page.waitForFunction(() => document.body.innerText.includes('signed'), null, { timeout: 15000 });
};

// ── /price-change/:token ───────────────────────────────────────────────
const priceChangeHandle = ({ method, path }) => {
  if (method === 'GET' && path === `/api/public/price-change/${PRICE_TOKEN}`) {
    return json({ firstName: 'Jordan', currentPrice: '$49.00', newPrice: '$54.00', cadenceLabel: 'month', effectiveDate: 'November 1, 2026' });
  }
  return null;
};

module.exports = [
  {
    id: 'pay-card', family: 'document-billing', surface: 'customer', role: 'public token', route: '/pay/:token',
    url: `/pay/${PAY_TOKEN}`, ready: holdStripeThen('Payment method'), handle: payHandle(), extraWidths: true, settle: 900,
    notes: 'Stripe Elements iframe cannot load (external origins are blocked). The populated states hold the js.stripe.com request pending so the page renders its own payment-method tiles, consent, and Pay button around an empty Element mount; the `stripe-blocked` state captures the retry card produced when the script is aborted. Endpoints mocked: GET /api/pay/:token, POST /api/pay/:token/setup, POST /api/pay/:token/update-amount, POST /api/pay/:token/error. The `paid` state follows the page\'s own redirect to /receipt/:token (GET /api/receipt/:token mocked in that state).',
    states: [
      { name: 'default' },
      { name: 'paid', handle: ({ method, path }) => {
        if (method === 'GET' && path === `/api/pay/${PAY_TOKEN}`) return json(payPayload({ status: 'paid', paidAt: '2026-09-09T14:12:00.000Z', cardBrand: 'visa', cardLastFour: '4242' }));
        if (method === 'GET' && path === `/api/receipt/${PAY_TOKEN}`) return json(receiptPayload());
        return null;
      }, ready: 'Payment received', widths: [390, 1440] },
      { name: 'covered-by-credit', handle: payHandle({ status: 'prepaid', creditApplied: 174, amountDue: 0 }), ready: 'nothing due', widths: [390, 1440] },
      { name: 'stripe-blocked', ready: 'load the secure payment form', widths: [390, 1440], settle: 500 },
      { name: 'error', handle: ({ method, path }) => (method === 'GET' && path === `/api/pay/${PAY_TOKEN}` ? serverError() : null), ready: 'Try again', widths: [390, 1440] },
      { name: 'not-found', handle: ({ method, path }) => (method === 'GET' && path === `/api/pay/${PAY_TOKEN}` ? json({ error: 'Invoice not found' }, 404) : null), ready: "couldn't find that invoice", widths: [390, 1440] },
    ],
  },
  {
    id: 'pay-statement', family: 'document-billing', surface: 'customer', role: 'public token (AP contact)', route: '/pay/statement/:token',
    url: `/pay/statement/${STATEMENT_TOKEN}`, ready: holdStripeThen('Continue to payment'), handle: statementHandle(), settle: 900,
    notes: 'Stripe Elements iframe cannot load (external origins are blocked); the js.stripe.com request is held pending so the statement card renders with an empty Element mount above the disabled "Continue to payment" button. Endpoints mocked: GET /api/pay/statement/:token, POST /api/pay/statement/:token/setup.',
    states: [
      { name: 'default' },
      { name: 'paid', handle: statementHandle({ status: 'paid', payable: false, paid_at: '2026-09-09T14:12:00.000Z' }), ready: 'your payment is in', widths: [390, 1440] },
      { name: 'error', handle: ({ method, path }) => (method === 'GET' && path === `/api/pay/statement/${STATEMENT_TOKEN}` ? serverError() : null), ready: 'Try again', widths: [390, 1440] },
    ],
  },
  {
    id: 'receipt', family: 'document-billing', surface: 'customer', role: 'public token', route: '/receipt/:token',
    url: `/receipt/${RECEIPT_TOKEN}`, ready: 'Payment received', handle: receiptHandle, extraWidths: true, settle: 800,
    notes: 'Endpoint mocked: GET /api/receipt/:token. The PDF link (/api/receipt/:token/pdf) is only an href and is never requested by the page.',
    states: [
      { name: 'default' },
      { name: 'fresh', url: `/receipt/${RECEIPT_TOKEN}?fresh=1`, widths: [390, 1440] },
      { name: 'error', handle: ({ method, path }) => (method === 'GET' && path === `/api/receipt/${RECEIPT_TOKEN}` ? serverError() : null), ready: 'Try again', widths: [390, 1440] },
    ],
  },
  {
    id: 'contract', family: 'document-billing', surface: 'customer', role: 'public token', route: '/contract/:token',
    url: `/contract/${CONTRACT_TOKEN}`, ready: 'Sign document', handle: contractHandle(contractRow()), settle: 800,
    notes: 'Endpoints mocked: GET /api/contracts/:token, POST /api/contracts/:token/sign (the `signed` state fills and submits the form, since the public GET 410s for signed contracts).',
    interactions: [
      { name: 'focus-input', fullPage: false, run: async (page) => { const i = page.locator('input[name="initials"]').first(); await i.scrollIntoViewIfNeeded(); await i.focus(); } },
    ],
    states: [
      { name: 'unsigned' },
      { name: 'signed', setup: signContract, interactions: [], widths: [390, 1440] },
      { name: 'autopay', handle: contractHandle(autopayContract()), ready: 'Sign authorization', widths: [390, 1440] },
      { name: 'error', handle: ({ method, path }) => (method === 'GET' && path === `/api/contracts/${CONTRACT_TOKEN}` ? json({ error: 'Could not load contract' }, 500) : null), ready: 'could not open that contract', interactions: [], widths: [390, 1440] },
    ],
  },
  {
    id: 'price-change', family: 'document-billing', surface: 'customer', role: 'public token', route: '/price-change/:token',
    url: `/price-change/${PRICE_TOKEN}`, ready: 'An update to your recurring service', handle: priceChangeHandle, settle: 800,
    notes: 'Endpoint mocked: GET /api/public/price-change/:token.',
    states: [
      { name: 'default' },
      { name: 'error', handle: ({ method, path }) => (method === 'GET' && path === `/api/public/price-change/${PRICE_TOKEN}` ? serverError() : null), ready: 'Try again', widths: [390, 1440] },
      { name: 'not-found', handle: ({ method, path }) => (method === 'GET' && path === `/api/public/price-change/${PRICE_TOKEN}` ? json({ error: 'Not found' }, 404) : null), ready: 'Notice not found', widths: [390, 1440] },
    ],
  },
];
