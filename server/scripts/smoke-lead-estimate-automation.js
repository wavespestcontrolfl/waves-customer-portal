#!/usr/bin/env node

const assert = require('node:assert/strict');

const leadWebhookRouter = require('../routes/lead-webhook');
const {
  buildAutomatedLeadDraftEstimate,
  evaluateLeadEstimateAutomationReadiness,
} = require('../services/lead-estimate-automation');
const adminEstimatesRouter = require('../routes/admin-estimates');

const { buildLeadWebhookIntake } = leadWebhookRouter._test;
const {
  assertEstimateSendable,
  leadEstimateAutomationSummary,
} = adminEstimatesRouter._internals;

function phoneFor(index) {
  return `+1941555010${index}`;
}

const cases = [
  {
    name: 'waves main mosquito',
    expect: 'generated',
    payload: {
      firstName: 'Maria',
      lastName: 'Garcia',
      email: 'maria.smoke@example.com',
      phone: '(941) 555-0101',
      address: '100 Wave Ave, Sarasota, FL 34236',
      service_interest: 'Mosquito Control',
      frequency: 'ongoing',
      page_url: 'https://www.wavespestcontrol.com/mosquito',
      homeSqFt: 2100,
      lotSqFt: 9500,
    },
  },
  {
    name: 'pest spoke recurring pest',
    expect: 'generated',
    payload: {
      name: 'Peter Pest',
      email: 'peter.smoke@example.com',
      phone: '9415550102',
      address: '200 Palm St, Bradenton, FL 34205',
      domain: 'bradentonflpestcontrol.com',
      interest: 'pest',
      frequency: 'ongoing',
      homeSqFt: 1800,
      lotSqFt: 7200,
    },
  },
  {
    name: 'lawn spoke recurring lawn',
    expect: 'generated',
    payload: {
      name: 'Laura Lawn',
      email: 'laura.smoke@example.com',
      phone: '9415550103',
      address: '300 Turf Ct, Venice, FL 34285',
      domain: 'venicelawncare.com',
      interest: 'lawn',
      frequency: 'ongoing',
      homeSqFt: 2200,
      lotSqFt: 8500,
    },
  },
  {
    name: 'termite manual review',
    expect: 'manual_review_required',
    payload: {
      name: 'Terry Termite',
      email: 'terry.smoke@example.com',
      phone: '9415550104',
      address: '400 Colony Rd, Parrish, FL 34219',
      domain: 'parrishpestcontrol.com',
      specific_service: 'termite_treatment',
      frequency: 'one-time',
      homeSqFt: 1900,
      lotSqFt: 7400,
    },
  },
];

function buildPersistedShape({ index, intake, readiness, draft }) {
  const phone = phoneFor(index + 1);
  return {
    customer: {
      id: `smoke-customer-${index + 1}`,
      first_name: intake.firstName,
      last_name: intake.lastName,
      phone,
      email: intake.email,
      address_line1: intake.normalizedAddress.line1,
      city: intake.normalizedAddress.city,
      state: intake.normalizedAddress.state || 'FL',
      zip: intake.normalizedAddress.zip,
      lead_service_interest: intake.serviceInterest,
    },
    lead: {
      id: `smoke-lead-${index + 1}`,
      first_name: intake.firstName,
      last_name: intake.lastName,
      phone,
      email: intake.email,
      address: intake.fullAddress,
      service_interest: intake.serviceInterest,
      extracted_data: {
        stage: 'lead_webhook_received',
        service_interest: intake.serviceInterest,
        automation: {
          leadEstimateAutomation: readiness,
          draftEstimateAutomation: draft.automation,
        },
        attribution: {
          leadSource: intake.leadSource,
          pageUrl: intake.pageUrl,
          landingUrl: intake.landingUrl,
        },
        address: intake.normalizedAddress,
      },
    },
    estimate: {
      id: `smoke-estimate-${index + 1}`,
      // The real lead-webhook persistence mints a share token on insert; the
      // send gate now refuses token-less rows, so the fixture must carry one.
      token: `smoke-token-${index + 1}`,
      status: 'draft',
      source: 'lead_webhook',
      customer_name: `${intake.firstName} ${intake.lastName}`.trim(),
      customer_phone: phone,
      customer_email: intake.email,
      address: intake.fullAddress,
      service_interest: intake.serviceInterest,
      monthly_total: draft.monthly || null,
      annual_total: draft.annual || null,
      onetime_total: draft.oneTimeTotal || null,
      estimate_data: draft.estimateData,
    },
  };
}

function runCase(testCase, index) {
  const intake = buildLeadWebhookIntake(testCase.payload);
  const readiness = evaluateLeadEstimateAutomationReadiness({
    intake,
    phone: phoneFor(index + 1),
    serviceInterest: intake.serviceInterest,
  });
  const draft = buildAutomatedLeadDraftEstimate({
    intake,
    body: testCase.payload,
    readiness,
  });
  const persisted = buildPersistedShape({ index, intake, readiness, draft });
  const summary = leadEstimateAutomationSummary(persisted.estimate.estimate_data);

  assert.equal(readiness.ready, true, `${testCase.name}: readiness gate should pass`);
  assert.equal(draft.automation.status, testCase.expect, `${testCase.name}: draft status`);
  assert.equal(summary.status, testCase.expect, `${testCase.name}: admin summary status`);
  assert.equal(persisted.customer.lead_service_interest, intake.serviceInterest, `${testCase.name}: customer service interest`);
  assert.equal(persisted.lead.extracted_data.automation.draftEstimateAutomation.status, testCase.expect, `${testCase.name}: lead automation status`);

  if (testCase.expect === 'generated') {
    assert.ok(
      Number(persisted.estimate.monthly_total || persisted.estimate.onetime_total) > 0,
      `${testCase.name}: generated estimates should have a priced total`
    );
    assert.doesNotThrow(() => assertEstimateSendable(persisted.estimate), `${testCase.name}: generated draft can pass send gate`);
  } else {
    assert.equal(persisted.estimate.monthly_total, null, `${testCase.name}: manual review should not set monthly total`);
    assert.throws(
      () => assertEstimateSendable(persisted.estimate),
      /manual review/i,
      `${testCase.name}: manual-review draft should be blocked from send`
    );
  }

  return {
    name: testCase.name,
    leadSource: intake.leadSource.source,
    leadSourceDetail: intake.leadSource.detail,
    serviceInterest: intake.serviceInterest,
    readiness: readiness.status,
    confidence: readiness.confidence,
    draftStatus: draft.automation.status,
    monthlyTotal: persisted.estimate.monthly_total,
    oneTimeTotal: persisted.estimate.onetime_total,
  };
}

const results = cases.map(runCase);
console.table(results);
console.log(`Lead estimate automation smoke passed: ${results.length} payloads`);
