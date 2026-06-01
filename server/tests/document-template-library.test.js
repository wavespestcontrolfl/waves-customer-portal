const fs = require('fs');
const path = require('path');
const {
  buildCustomerDocumentContext,
  normalizeTemplateKey,
  renderDocumentTemplate,
  renderDocumentText,
  validateTemplatePayload,
  validateVersionPayload,
} = require('../services/document-template-library');
const DocumentContractDelivery = require('../services/document-contract-delivery');
const { contractExpiresAt } = require('../services/contracts');

describe('document template library', () => {
  test('renders merge fields and reports unresolved variables', () => {
    const rendered = renderDocumentTemplate({
      template: { template_key: 'service_agreement.test' },
      version: {
        id: 'version-1',
        version_number: 2,
        title: '{{customer.name}} Service Agreement',
        body: 'Service: {{service.name}}\nMissing: {{agreement.start_date}}',
      },
      context: {
        customer: { name: 'Alice Customer' },
        service: { name: 'Quarterly Pest' },
      },
    });

    expect(rendered).toMatchObject({
      title: 'Alice Customer Service Agreement',
      body: 'Service: Quarterly Pest\nMissing: {{agreement.start_date}}',
      usedVariables: ['agreement.start_date', 'customer.name', 'service.name'],
      unresolvedVariables: ['agreement.start_date'],
      renderSummary: {
        templateKey: 'service_agreement.test',
        templateVersionId: 'version-1',
        versionNumber: 2,
        unresolvedVariables: ['agreement.start_date'],
      },
    });
  });

  test('builds customer document context with business and customer defaults', () => {
    const context = buildCustomerDocumentContext({
      id: 'customer-1',
      first_name: 'Bob',
      last_name: 'Builder',
      email: 'bob@example.com',
      phone: '9415550100',
      address_line1: '123 Main St',
      city: 'Bradenton',
      state: 'FL',
      zip: '34211',
      waveguard_tier: 'WaveGuard Plus',
    }, {
      agreementStartDate: '2026-06-10',
      inspectionDate: '2026-06-12',
      customer: { name: 'Wrong Customer' },
      business: { name: 'Wrong Business' },
    });

    expect(context).toMatchObject({
      business: {
        name: 'Waves Pest Control, LLC',
      },
      customer: {
        id: 'customer-1',
        name: 'Bob Builder',
        address: '123 Main St, Bradenton FL 34211',
      },
      service: {
        name: 'WaveGuard Plus',
      },
      agreement: {
        start_date: '2026-06-10',
      },
      inspection: {
        date: '2026-06-12',
      },
    });
  });

  test('normalizes template and version payloads for storage', () => {
    expect(normalizeTemplateKey(' Service Agreement.Residential ')).toBe('service_agreement.residential');
    expect(validateTemplatePayload({
      templateKey: 'prep.bed_bug',
      name: ' Bed Bug Prep ',
      category: 'Prep Form',
      documentType: 'Prep Form',
      tags: 'prep, bed_bug, prep',
      variables: 'customer.name, service.date',
      expireAfterDays: 365,
    })).toMatchObject({
      template_key: 'prep.bed_bug',
      name: 'Bed Bug Prep',
      category: 'prep_form',
      document_type: 'prep_form',
      tags: ['prep', 'bed_bug'],
      variables: ['customer.name', 'service.date'],
      expire_after_days: 14,
      requires_signature: true,
    });
    expect(() => validateTemplatePayload({
      templateKey: 'prep.no_signature',
      name: 'Prep No Signature',
      requiresSignature: false,
    })).toThrow(/require e-signature/);
    expect(validateVersionPayload({
      title: 'Title',
      body: 'Body',
      requiredFields: '',
    })).toMatchObject({
      title: 'Title',
      body: 'Body',
      required_fields: ['initials', 'signedName'],
    });
    expect(() => normalizeTemplateKey('Bad Key!')).toThrow(/Template key/);
  });

  test('document template migration and routes wire into contracts', () => {
    const migration = fs.readFileSync(
      path.join(__dirname, '..', 'models', 'migrations', '20260601000009_document_template_library.js'),
      'utf8',
    );
    const workflowMigration = fs.readFileSync(
      path.join(__dirname, '..', 'models', 'migrations', '20260601000010_document_workflow_defaults.js'),
      'utf8',
    );
    const reminderClaimMigration = fs.readFileSync(
      path.join(__dirname, '..', 'models', 'migrations', '20260601000011_document_reminder_claims.js'),
      'utf8',
    );
    const publicContracts = fs.readFileSync(path.join(__dirname, '..', 'routes', 'contracts-public.js'), 'utf8');
    const adminContracts = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-contracts.js'), 'utf8');
    const contractService = fs.readFileSync(path.join(__dirname, '..', 'services', 'contracts.js'), 'utf8');
    const documentDelivery = fs.readFileSync(path.join(__dirname, '..', 'services', 'document-contract-delivery.js'), 'utf8');
    const legacyEmail = fs.readFileSync(path.join(__dirname, '..', 'services', 'email.js'), 'utf8');
    const messagingPolicy = fs.readFileSync(path.join(__dirname, '..', 'services', 'messaging', 'policy.js'), 'utf8');
    const adminIndex = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

    expect(migration).toContain("createTable('document_templates'");
    expect(migration).toContain("createTable('document_template_versions'");
    expect(migration).toContain("document_template_id");
    expect(workflowMigration).toContain('default_delivery_channel');
    expect(workflowMigration).toContain('reminder_schedule_days');
    expect(workflowMigration).toContain('expire_after_days');
    expect(reminderClaimMigration).toContain('uniq_document_reminder_claim_offset');
    expect(reminderClaimMigration).toContain("event_type = 'reminder_claimed'");
    expect(adminIndex).toContain("app.use('/api/admin/document-templates'");
    expect(adminContracts).toContain("router.get('/:id/events'");
    expect(adminContracts).toContain('serializeContractEvent');
    expect(adminContracts).toContain("router.get('/requests'");
    expect(adminContracts).toContain("router.get('/requests/stats'");
    expect(adminContracts).toContain("router.post('/:id/send-email'");
    expect(adminContracts).toContain("router.post('/:id/send-sms'");
    expect(adminContracts).toContain("router.post('/:id/remind'");
    expect(adminContracts).toContain("contract_type: 'autopay_authorization'");
    expect(adminContracts).toContain(".whereNotNull('payment_method_id')");
    expect(messagingPolicy).toContain('document_request');
    expect(contractService).toContain('includeDocumentSnapshots');
    expect(contractService).toContain('options.includeAudit !== false');
    expect(publicContracts).toContain("const isAutopayAuthorization = contract.contract_type === 'autopay_authorization'");
    expect(publicContracts).toContain('Document agreement is required.');
    expect(publicContracts).toContain("agreementType: isAutopayAuthorization ? 'autopay_authorization' : 'document_terms'");
    expect(documentDelivery).toContain('activateCommittedDelivery');
    expect(documentDelivery).toContain('claimReminderOffset');
    expect(legacyEmail).toContain('logger.error(`[email] send failed: ${err.message}`)');
  });

  test('renderDocumentText leaves non-placeholder text untouched', () => {
    expect(renderDocumentText('No merge fields here.', {})).toEqual({
      rendered: 'No merge fields here.',
      usedVariables: [],
      unresolvedVariables: [],
    });
  });

  test('document request delivery copy and derived status stay deterministic', () => {
    const contract = {
      title: 'Residential Pest Service Agreement',
      status: 'sent',
      share_token_expires_at: new Date(Date.now() + 60_000),
    };
    const customer = { first_name: 'Alice', last_name: 'Customer' };
    expect(DocumentContractDelivery.requestStatus(contract)).toBe('sent');
    expect(DocumentContractDelivery.requestStatus({
      ...contract,
      share_token_expires_at: new Date(Date.now() - 60_000),
    })).toBe('expired');
    const sms = DocumentContractDelivery._internals.smsBody({
      contract,
      customer,
      signingUrl: 'https://portal.example/contract/token',
      action: 'reminder',
    });
    expect(sms).toContain('Hi Alice');
    expect(sms).toContain('Residential Pest Service Agreement');
    expect(sms).toContain('https://portal.example/contract/token');
    const email = DocumentContractDelivery._internals.emailPayload({
      contract,
      customer,
      signingUrl: 'https://portal.example/contract/token',
      action: 'send',
    });
    expect(email.subject).toContain('Residential Pest Service Agreement');
    expect(email.text).toContain('Review and sign');
    expect(DocumentContractDelivery._internals.parseReminderSchedule('[3,1,-1]')).toEqual([1, 3, -1]);
    const now = new Date('2026-06-01T12:00:00Z');
    expect(contractExpiresAt(now, 365).toISOString()).toBe('2026-06-15T12:00:00.000Z');
  });
});
