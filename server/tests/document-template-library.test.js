const fs = require('fs');
const path = require('path');
const {
  buildCustomerDocumentContext,
  normalizeTemplateKey,
  renderDocumentTemplate,
  renderDocumentText,
  serializeTemplate,
  validateTemplatePayload,
  validateVersionPayload,
} = require('../services/document-template-library');
const DocumentContractDelivery = require('../services/document-contract-delivery');
const BulkDocumentSend = require('../services/document-template-bulk-send');
const {
  contractExpiresAt,
  documentContractExpiresAt,
  documentRequiresSignature,
} = require('../services/contracts');

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
      templateKey: 'prep.view_only',
      name: 'Bed Bug Prep',
      category: 'Prep Form',
      documentType: 'Prep Form',
      requiresSignature: false,
    })).toThrow(/marketing customer-guide/);
    expect(validateTemplatePayload({
      requiresSignature: false,
    }, { partial: true })).toMatchObject({
      requires_signature: false,
    });
    expect(validateTemplatePayload({
      templateKey: 'marketing.product_safety',
      name: 'Products & Safety',
      category: 'marketing',
      documentType: 'customer_guide',
      requiresSignature: false,
      reminderScheduleDays: [],
    })).toMatchObject({
      category: 'marketing',
      document_type: 'customer_guide',
      requires_signature: false,
      reminder_schedule_days: [],
    });
    expect(serializeTemplate({
      template_key: 'marketing.product_safety',
      name: 'Products & Safety',
      category: 'marketing',
      document_type: 'customer_guide',
      requires_signature: false,
      reminder_schedule_days: [],
      expire_after_days: 14,
    })).toMatchObject({
      requiresSignature: false,
      reminderScheduleDays: [],
    });
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
    const marketingMigration = fs.readFileSync(
      path.join(__dirname, '..', 'models', 'migrations', '20260611000001_seed_products_solutions_document.js'),
      'utf8',
    );
    const bulkGuideMigration = fs.readFileSync(
      path.join(__dirname, '..', 'models', 'migrations', '20260611000002_seed_product_safety_bulk_templates.js'),
      'utf8',
    );
    const signatureSnapshotMigration = fs.readFileSync(
      path.join(__dirname, '..', 'models', 'migrations', '20260611000003_customer_contract_signature_snapshot.js'),
      'utf8',
    );
    const publicContracts = fs.readFileSync(path.join(__dirname, '..', 'routes', 'contracts-public.js'), 'utf8');
    const adminContracts = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-contracts.js'), 'utf8');
    const adminDocumentTemplates = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-document-templates.js'), 'utf8');
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
    expect(marketingMigration).toContain('marketing.products_solutions');
    expect(marketingMigration).toContain("requires_signature: false");
    expect(marketingMigration).toContain('Waves Products & Solutions Guide');
    expect(bulkGuideMigration).toContain('marketing.pest_products_safety');
    expect(bulkGuideMigration).toContain('marketing.lawn_products_safety');
    expect(bulkGuideMigration).toContain("requires_signature: false");
    expect(signatureSnapshotMigration).toContain('requires_signature_snapshot');
    expect(adminIndex).toContain("app.use('/api/admin/document-templates'");
    expect(adminDocumentTemplates).toContain("router.post('/:key/bulk-preview'");
    expect(adminDocumentTemplates).toContain("router.post('/:key/bulk-send'");
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
    expect(documentDelivery).toContain('documentContractExpiresAt');
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
    expect(sms).not.toContain('STOP');
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
    expect(contractExpiresAt(now).toISOString()).toBe('2026-06-15T12:00:00.000Z');
    expect(contractExpiresAt(now, 365).toISOString()).toBe('2026-06-15T12:00:00.000Z');
    expect(documentContractExpiresAt(now, 365, { requires_signature_snapshot: true }).toISOString()).toBe('2026-06-15T12:00:00.000Z');
    expect(documentContractExpiresAt(now, 365, { requires_signature_snapshot: false }).toISOString()).toBe('2026-06-15T12:00:00.000Z');
  });

  test('view-only document request delivery copy does not ask for a signature', () => {
    const contract = {
      title: 'Waves Products & Solutions Guide',
      status: 'sent',
      requires_signature_snapshot: false,
      document_template_requires_signature: true,
      share_token_expires_at: new Date(Date.now() + 60_000),
    };
    const customer = { first_name: 'Alice', last_name: 'Customer' };
    const signingUrl = 'https://portal.example/contract/token';

    expect(DocumentContractDelivery._internals.requiresSignature(contract)).toBe(false);
    expect(documentRequiresSignature(contract)).toBe(false);
    const sms = DocumentContractDelivery._internals.smsBody({
      contract,
      customer,
      signingUrl,
      action: 'send',
    });
    expect(sms).toContain('ready for your review');
    expect(sms).not.toContain('signature');

    const email = DocumentContractDelivery._internals.emailPayload({
      contract,
      customer,
      signingUrl,
      action: 'send',
    });
    expect(email.text).toContain('View document');
    expect(email.text).not.toContain('Review and sign');
    expect(email.text).not.toContain('signature');
  });

  test('bulk document send helpers keep guide sends bounded and customer-facing', async () => {
    expect(BulkDocumentSend.MAX_BULK_LIMIT).toBe(250);
    expect(BulkDocumentSend._internals.normalizeBulkOptions({
      audience: 'active_lawn',
      guideType: 'all',
      channel: 'both',
      limit: 999,
      skipRecentDays: 14,
    })).toMatchObject({
      audience: 'active_lawn',
      guideType: 'lawn',
      channel: 'sms',
      limit: 250,
      skipRecentDays: 14,
    });
    expect(() => BulkDocumentSend._internals.validateBulkSendSelectors({
      guideType: 'all',
      channel: 'sms',
    })).toThrow(/audience/);
    expect(() => BulkDocumentSend._internals.validateBulkSendSelectors({
      audience: 'bogus',
      guideType: 'all',
      channel: 'sms',
    })).toThrow(/Invalid bulk product guide audience/);
    expect(() => BulkDocumentSend._internals.validateBulkSendSelectors({
      audience: 'active_customers',
      guideType: 'all',
      channel: 'email',
    })).toThrow(/delivery channel/);
    expect(() => BulkDocumentSend._internals.validateBulkSendSelectors({
      audience: 'active_customers',
      guideType: 'all',
      channel: 'sms',
    })).not.toThrow();

    expect(BulkDocumentSend._internals.channelsFor('both')).toEqual(['sms']);
    expect(BulkDocumentSend._internals.channelsForCustomer({
      email: 'customer@example.com',
      phone: '',
      email_enabled: true,
      sms_enabled: true,
    }, ['email', 'sms'])).toEqual(['email']);
    expect(BulkDocumentSend._internals.channelsForCustomer({
      phone: '(941) 555-0101',
      sms_enabled: true,
      seasonal_tips: false,
    }, ['sms'], { smsPurpose: 'marketing' })).toEqual([]);
    expect(BulkDocumentSend._internals.channelsForCustomer({
      phone: '(941) 555-0101',
      sms_enabled: true,
      seasonal_tips: true,
    }, ['sms'], { smsPurpose: 'marketing' })).toEqual(['sms']);
    expect(BulkDocumentSend._internals.marketingSmsConsentBasis({
      phone: '(941) 555-0101',
      sms_enabled: true,
      seasonal_tips: true,
      notification_prefs_updated_at: '2026-06-11T10:00:00.000Z',
    })).toMatchObject({
      status: 'opted_in',
      source: 'notification_prefs.seasonal_tips',
      capturedAt: '2026-06-11T10:00:00.000Z',
    });
    expect(BulkDocumentSend._internals.isBulkGuideTemplate({
      category: 'marketing',
      document_type: 'customer_guide',
      requires_signature: false,
    })).toBe(true);
    expect(BulkDocumentSend._internals.isBulkGuideTemplate({
      category: 'marketing',
      document_type: 'customer_guide',
      requires_signature: true,
    })).toBe(false);

    const bulkSendService = fs.readFileSync(path.join(__dirname, '..', 'services', 'document-template-bulk-send.js'), 'utf8');
    const deliveryService = fs.readFileSync(path.join(__dirname, '..', 'services', 'document-contract-delivery.js'), 'utf8');
    const bulkMarketingContract = {
      contract_type: 'document_template',
      document_template_category: 'marketing',
      document_template_document_type: 'customer_guide',
      requires_signature_snapshot: false,
    };
    expect(DocumentContractDelivery._internals.isMarketingCustomerGuide(bulkMarketingContract)).toBe(true);
    expect(DocumentContractDelivery._internals.smsBody({
      contract: {
        ...bulkMarketingContract,
        title: 'Pest Products & Safety Guide',
      },
      customer: { first_name: 'Alice' },
      signingUrl: 'https://portal.example/contract/token',
      action: 'send',
      smsPurpose: 'marketing',
    })).toContain('Reply STOP to opt out. Msg & data rates may apply.');
    await expect(DocumentContractDelivery._internals.deliveryOptionsForContract(bulkMarketingContract, {
      channel: 'email',
      action: 'send',
    })).rejects.toMatchObject({ code: 'MARKETING_GUIDE_EMAIL_DISABLED' });
    const duplicateExclusionIndex = bulkSendService.indexOf('candidateQuery = applyRecentDuplicateExclusion');
    const audienceLimitIndex = bulkSendService.indexOf('.limit(options.limit)', duplicateExclusionIndex);
    expect(duplicateExclusionIndex).toBeGreaterThan(-1);
    expect(audienceLimitIndex).toBeGreaterThan(duplicateExclusionIndex);
    expect(bulkSendService).toContain(".whereNotNull('recent_cc.shared_at')");
    expect(bulkSendService).toContain("draft.whereNull('shared_at')");
    expect(bulkSendService).toContain('etDateString');
    expect(bulkSendService).toContain("const LIVE_SCHEDULED_SERVICE_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site']");
    expect(bulkSendService).toContain('status IN (?, ?, ?, ?)');
    expect(bulkSendService).toContain('assertBulkGuideTemplate(loaded.template)');
    expect(bulkSendService).toContain('assertNoRecentBulkContract');
    expect(bulkSendService).toContain('duplicateContract');
    expect(bulkSendService).toContain("const CHANNELS = new Set(['sms'])");
    expect(bulkSendService).toContain("status: 'draft'");
    expect(bulkSendService).toContain('bulk_send_cancelled');
    expect(bulkSendService).toContain('requires_signature_snapshot');
    expect(bulkSendService).toContain("smsPurpose: 'marketing'");
    expect(deliveryService).toContain('MARKETING_GUIDE_EMAIL_DISABLED');
    expect(deliveryService).toContain('MARKETING_SMS_OPT_IN_REQUIRED');
    expect(deliveryService).toContain('deliveryOptionsForContract');
    expect(deliveryService).toContain('purpose: smsPurpose');
    expect(deliveryService).toContain('consentBasis: smsConsentBasis || undefined');

    const appendix = BulkDocumentSend._internals.formatProductGuideAppendix({
      guideType: 'pest',
      products: [{
        id: 'product-1',
        name: 'Demand CS',
        common_name: 'Demand CS',
        active_ingredient: 'Lambda-cyhalothrin',
        epa_reg_number: '100-1066',
        public_summary: 'Used for targeted exterior perimeter pest pressure.',
        customer_safety_summary: 'Keep people and pets away from treated surfaces until dry.',
        service_type: 'Quarterly Pest Control',
      }],
    });
    expect(appendix).toContain('Customer-facing pest control product notes');
    expect(appendix).toContain('active, public, and approved');
    expect(appendix).toContain('Demand CS');
    expect(appendix).toContain('EPA Reg. #100-1066');
    expect(appendix).not.toContain('best_price');
  });
});
