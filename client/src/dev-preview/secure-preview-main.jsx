/**
 * DEV HARNESS (not part of the app build) — renders the REAL
 * SecureAppointmentPage against a stubbed fetch + Stripe so the
 * plan-choice states (GATE_SECURE_PLAN_CHOICE lane) can be eyeballed and
 * screenshotted with no database, backend, or Stripe key. Served by
 * `npx vite` at /preview-secure.html. Scenarios via ?v=:
 *   pest          — recurring pest: $99-waiver plan choice (add &sel=per_application
 *                   to pre-select and reveal the card form)
 *   lawn          — recurring lawn: 5% prepay discount choice
 *   onetime       — one-time visit: price panel, no choice
 *   prepaySelected— returning visitor with an unpaid prepay invoice
 *   gateoff       — no planContext: the original card-only page
 * Demo persona is fictional — never real customer data.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '../index.css';
import '../styles/brand-tokens.css';

const TOKEN = 'a'.repeat(64);
const params = new URLSearchParams(window.location.search);
const scenario = params.get('v') || 'pest';
const preselect = params.get('sel') || null;

const BASE = {
  firstName: 'Taylor',
  serviceType: 'Quarterly Pest Control',
  dateDisplay: 'Tue, Aug 4',
  windowDisplay: '8–10 AM',
  clientSecret: 'seti_demo_secret',
  setupIntentId: 'seti_demo',
  publishableKey: 'pk_test_demo',
};

const PAYLOADS = {
  pest: () => ({
    state: 'ready',
    ...BASE,
    planContext: {
      mode: 'recurring',
      planClass: 'fee_waiver',
      perVisit: 135,
      visitsPerYear: 4,
      annualBase: 540,
      prepay: { total: 540, discount: 0, ratePctLabel: '' },
      setupFee: { amount: 99, waivedWithPrepay: true },
      selected: preselect,
    },
  }),
  lawn: () => ({
    state: 'ready',
    ...BASE,
    firstName: 'Jordan',
    serviceType: 'Lawn Care',
    dateDisplay: 'Thu, Aug 6',
    windowDisplay: '10–12 PM',
    planContext: {
      mode: 'recurring',
      planClass: 'discount',
      perVisit: 89,
      visitsPerYear: 6,
      annualBase: 534,
      prepay: { total: 507.3, discount: 26.7, ratePctLabel: '5%' },
      setupFee: null,
      selected: preselect,
    },
  }),
  onetime: () => ({
    state: 'ready',
    ...BASE,
    firstName: 'Casey',
    serviceType: 'One-Time Pest Treatment',
    dateDisplay: 'Fri, Aug 7',
    windowDisplay: '12–2 PM',
    planContext: { mode: 'one_time', perVisit: 189, selected: null },
  }),
  prepaySelected: () => ({
    state: 'prepay_selected',
    ...BASE,
    payUrl: '#demo-pay-link',
    planContext: {
      mode: 'recurring',
      planClass: 'fee_waiver',
      perVisit: 135,
      visitsPerYear: 4,
      annualBase: 540,
      prepay: { total: 540, discount: 0, ratePctLabel: '' },
      setupFee: { amount: 99, waivedWithPrepay: true },
      selected: 'prepay_annual',
    },
  }),
  gateoff: () => ({ state: 'ready', ...BASE }),
};

// ── fetch stub ─────────────────────────────────────────────────────────────
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  const respond = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
  if (url.includes('/public/secure-card/') && url.includes('/select-plan')) {
    const plan = JSON.parse(init?.body || '{}').plan;
    if (plan === 'prepay_annual') return respond({ ok: true, plan, payUrl: '#demo-pay-link' });
    return respond({ ok: true, plan });
  }
  if (url.includes('/public/secure-card/') && url.includes('/complete')) {
    return respond({ success: true });
  }
  if (url.includes('/public/secure-card/')) {
    return respond((PAYLOADS[scenario] || PAYLOADS.pest)());
  }
  if (url.startsWith('/api/')) return respond({ error: 'preview-harness: endpoint not mocked' }, 404);
  return originalFetch(input, init);
};

// ── Stripe stub ────────────────────────────────────────────────────────────
// stripeLoader reuses window.Stripe when present, so no js.stripe.com load
// happens. The fake Payment Element mounts a static field mock so shots show
// the card step instead of an empty box.
window.Stripe = () => ({
  elements: () => ({
    create: () => {
      const handlers = {};
      return {
        mount(el) {
          const node = typeof el === 'string' ? document.querySelector(el) : el;
          if (node) {
            node.innerHTML = `
              <div style="display:flex;gap:8px;margin-bottom:9px">
                <div style="flex:1;height:42px;border-radius:7px;background:#000;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14.5px">Apple Pay</div>
                <div style="flex:1;height:42px;border-radius:7px;background:#fff;border:1px solid #D8D0C0;color:#3c4043;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14.5px">G Pay</div>
              </div>
              <div style="border:1px solid #D8D0C0;border-radius:7px;background:#fff;padding:12px;font-size:14.5px;color:#94A3B8">Card number</div>
              <div style="display:flex;gap:8px;margin-top:8px">
                <div style="flex:1;border:1px solid #D8D0C0;border-radius:7px;background:#fff;padding:12px;font-size:14.5px;color:#94A3B8">MM / YY</div>
                <div style="flex:1;border:1px solid #D8D0C0;border-radius:7px;background:#fff;padding:12px;font-size:14.5px;color:#94A3B8">CVC</div>
                <div style="flex:1;border:1px solid #D8D0C0;border-radius:7px;background:#fff;padding:12px;font-size:14.5px;color:#94A3B8">ZIP</div>
              </div>`;
          }
          setTimeout(() => handlers.ready && handlers.ready(), 0);
        },
        on(evt, cb) { handlers[evt] = cb; },
        unmount() {},
        destroy() {},
      };
    },
    submit: async () => ({}),
  }),
  confirmSetup: async () => ({ setupIntent: { id: 'seti_demo', status: 'succeeded' } }),
});

// Import AFTER the stubs so the page's module graph sees them.
const { default: SecureAppointmentPage } = await import('../pages/SecureAppointmentPage');

ReactDOM.createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={[`/secure/${TOKEN}`]}>
    <Routes>
      <Route path="/secure/:token" element={<SecureAppointmentPage />} />
    </Routes>
  </MemoryRouter>,
);
