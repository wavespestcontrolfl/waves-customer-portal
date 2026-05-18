/**
 * Email template library foundation.
 *
 * Waves owns template content, rendering, variable contracts, versioning,
 * preview fixtures, and send snapshots in-app. SendGrid remains the delivery
 * provider and event source, not the template source of truth.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const MARKETING_FROM = 'newsletter@wavespestcontrol.com';

const GROUPS = [
  {
    key: 'transactional_required',
    name: 'Required account notices',
    description: 'Security, payment, legal, and account notices that must reach the customer.',
    send_stream: 'transactional_required',
    user_can_unsubscribe: false,
    sort_order: 10,
  },
  {
    key: 'service_operational',
    name: 'Service and scheduling notices',
    description: 'Estimates, appointment prep, reports, onboarding, and service relationship emails.',
    send_stream: 'service_operational',
    user_can_unsubscribe: true,
    sort_order: 20,
  },
  {
    key: 'marketing_newsletter',
    name: 'Newsletter',
    description: 'Newsletter campaigns and subscribed community content.',
    send_stream: 'marketing_newsletter',
    user_can_unsubscribe: true,
    sort_order: 30,
  },
  {
    key: 'marketing_referral',
    name: 'Referral campaigns',
    description: 'Referral asks and promotional word-of-mouth campaigns.',
    send_stream: 'marketing_referral',
    user_can_unsubscribe: true,
    sort_order: 40,
  },
  {
    key: 'marketing_nurture',
    name: 'Lead nurture',
    description: 'Commercial lead nurture, winback, and re-engagement emails.',
    send_stream: 'marketing_nurture',
    user_can_unsubscribe: true,
    sort_order: 50,
  },
  {
    key: 'internal',
    name: 'Internal admin mail',
    description: 'Internal operational alerts and admin-only email.',
    send_stream: 'internal',
    user_can_unsubscribe: false,
    sort_order: 60,
  },
];

const TEMPLATES = [
  {
    key: 'estimate.delivery',
    name: 'Estimate Delivery',
    description: 'Immediate email sent when a Waves estimate is ready for review.',
    purpose: 'estimate',
    required: ['first_name', 'estimate_url'],
    optional: ['price_summary'],
    subject: 'Your Waves estimate is ready',
    preview: 'Review your service estimate and choose what works for you.',
    ctaLabel: 'View estimate',
    ctaUrlVariable: 'estimate_url',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your customized Waves estimate is ready for review.' },
      { type: 'paragraph', content: 'You can view the full breakdown, compare options, and choose the service plan that fits your home.' },
      { type: 'cta', label: 'View estimate', url_variable: 'estimate_url' },
      { type: 'small_note', content: 'Questions? Reply to this email and our team will help.' },
    ],
    fixture: { first_name: 'Taylor', estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample', price_summary: '$89/month' },
  },
  {
    key: 'estimate.unviewed_followup',
    name: 'Estimate Unviewed Follow-Up',
    description: 'Sent when an estimate has been delivered but not opened.',
    purpose: 'estimate',
    required: ['first_name', 'estimate_url'],
    subject: 'Your Waves estimate is ready to review',
    preview: 'A quick note in case the estimate link got buried.',
    ctaLabel: 'View estimate',
    ctaUrlVariable: 'estimate_url',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, we sent your Waves estimate yesterday and wanted to make sure the link made it to you.' },
      { type: 'paragraph', content: 'No rush. Take a look whenever you have a minute, and reply here if anything is unclear.' },
      { type: 'cta', label: 'View estimate', url_variable: 'estimate_url' },
    ],
    fixture: { first_name: 'Taylor', estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample' },
  },
  {
    key: 'estimate.viewed_followup',
    name: 'Estimate Viewed Follow-Up',
    description: 'Sent after a customer views an estimate but has not accepted.',
    purpose: 'estimate',
    required: ['first_name', 'estimate_url'],
    subject: 'Any questions about your Waves estimate?',
    preview: 'We can help talk through the details if anything is unclear.',
    ctaLabel: 'Review estimate',
    ctaUrlVariable: 'estimate_url',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, thanks for taking a look at your Waves estimate.' },
      { type: 'paragraph', content: 'If you want to talk through what is included, timing, or service options, just reply to this email and our team will help.' },
      { type: 'cta', label: 'Review estimate', url_variable: 'estimate_url' },
    ],
    fixture: { first_name: 'Taylor', estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample' },
  },
  {
    key: 'estimate.expiring_notice',
    name: 'Estimate Expiring Notice',
    description: 'Account-state notice when an estimate is close to expiration.',
    purpose: 'estimate',
    required: ['first_name', 'estimate_url', 'expires_at'],
    subject: 'Your Waves estimate expires {{expires_at}}',
    preview: 'Your estimate is still available for review until {{expires_at}}.',
    ctaLabel: 'View estimate',
    ctaUrlVariable: 'estimate_url',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves estimate is available until {{expires_at}}.' },
      { type: 'paragraph', content: 'You can review the details from the link below. If you need more time or have a question, reply here.' },
      { type: 'cta', label: 'View estimate', url_variable: 'estimate_url' },
    ],
    fixture: { first_name: 'Taylor', estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample', expires_at: 'June 12' },
  },
  {
    key: 'estimate.extension_notice',
    name: 'Estimate Extension Notice',
    description: 'Account-state notice when Waves extends an expired estimate.',
    purpose: 'estimate',
    required: ['first_name', 'estimate_url', 'new_expires_at'],
    subject: 'Your Waves estimate was extended',
    preview: 'We extended your estimate so the link stays available.',
    ctaLabel: 'View estimate',
    ctaUrlVariable: 'estimate_url',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves estimate was set to expire, so we extended it through {{new_expires_at}}.' },
      { type: 'paragraph', content: 'Nothing else changed. The link below has the same service details and pricing we already sent.' },
      { type: 'cta', label: 'View estimate', url_variable: 'estimate_url' },
    ],
    fixture: { first_name: 'Taylor', estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample', new_expires_at: 'June 19' },
  },
  {
    key: 'onboarding.24h_reminder',
    name: 'Onboarding 24h Reminder',
    description: 'Reminder for customers who accepted an estimate but have not finished setup.',
    purpose: 'onboarding',
    required: ['first_name', 'onboarding_url'],
    optional: ['plan_name'],
    subject: 'Finish setting up your Waves service',
    preview: 'A few details are still needed before we can finalize your first service.',
    ctaLabel: 'Finish setup',
    ctaUrlVariable: 'onboarding_url',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, thanks for choosing Waves.' },
      { type: 'paragraph', content: 'We still need a few quick details before we can finalize your first service. It usually takes about two minutes.' },
      { type: 'cta', label: 'Finish setup', url_variable: 'onboarding_url' },
    ],
    fixture: { first_name: 'Taylor', onboarding_url: 'https://portal.wavespestcontrol.com/onboard/sample', plan_name: 'WaveGuard' },
  },
  {
    key: 'onboarding.72h_reminder',
    name: 'Onboarding 72h Reminder',
    description: 'Second setup reminder for customers who have not completed onboarding.',
    purpose: 'onboarding',
    required: ['first_name', 'onboarding_url'],
    subject: 'Still here whenever you are',
    preview: 'Finish setup when you are ready and we will confirm the first service.',
    ctaLabel: 'Finish setup',
    ctaUrlVariable: 'onboarding_url',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, just a quick reminder that your Waves setup is still open.' },
      { type: 'paragraph', content: 'When you finish the remaining details, we can confirm your first service. If anything is holding you up, reply here.' },
      { type: 'cta', label: 'Finish setup', url_variable: 'onboarding_url' },
    ],
    fixture: { first_name: 'Taylor', onboarding_url: 'https://portal.wavespestcontrol.com/onboard/sample' },
  },
  {
    key: 'onboarding.expiring_notice',
    name: 'Onboarding Link Expiring',
    description: 'Account-state notice before an onboarding link expires.',
    purpose: 'onboarding',
    required: ['first_name', 'onboarding_url', 'expires_at'],
    optional: ['plan_name'],
    subject: 'Your Waves setup link expires {{expires_at}}',
    preview: 'Finish setup before the link expires so we can confirm service.',
    ctaLabel: 'Finish setup',
    ctaUrlVariable: 'onboarding_url',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves setup link expires {{expires_at}}.' },
      { type: 'paragraph', content: 'Finish the remaining details from the link below so we can keep your service setup moving.' },
      { type: 'cta', label: 'Finish setup', url_variable: 'onboarding_url' },
    ],
    fixture: { first_name: 'Taylor', onboarding_url: 'https://portal.wavespestcontrol.com/onboard/sample', expires_at: 'June 12', plan_name: 'WaveGuard' },
  },
  {
    key: 'invoice.sent',
    name: 'Invoice Sent',
    description: 'Professional billing email with a secure payment link.',
    purpose: 'invoice',
    legal: 'transactional_relationship',
    stream: 'transactional_required',
    sensitivity: 'financial',
    required: ['first_name', 'invoice_url', 'invoice_number', 'amount_due'],
    optional: ['due_date', 'service_label', 'service_date', 'attachment_note'],
    subject: 'Invoice {{invoice_number}} from Waves',
    preview: 'Your Waves invoice is ready for review and payment.',
    ctaLabel: 'View invoice',
    ctaUrlVariable: 'invoice_url',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves invoice {{invoice_number}} is ready.' },
      { type: 'details', rows: [{ label: 'Amount due', value: '{{amount_due}}' }, { label: 'Service', value: '{{service_label}}' }, { label: 'Service date', value: '{{service_date}}' }, { label: 'Due date', value: '{{due_date}}' }] },
      { type: 'cta', label: 'View invoice', url_variable: 'invoice_url' },
      { type: 'small_note', content: '{{attachment_note}}' },
      { type: 'small_note', content: 'If you already paid, no action is needed.' },
    ],
    fixture: { first_name: 'Taylor', invoice_url: 'https://portal.wavespestcontrol.com/pay/sample', invoice_number: 'W-1042', amount_due: '$129.00', due_date: 'June 15' },
  },
  {
    key: 'invoice.receipt',
    name: 'Payment Receipt',
    description: 'Payment receipt after a successful customer payment.',
    purpose: 'invoice',
    legal: 'transactional_relationship',
    stream: 'transactional_required',
    sensitivity: 'financial',
    required: ['first_name', 'receipt_url', 'invoice_number', 'amount_paid'],
    optional: ['paid_at', 'service_label', 'payment_method', 'memo'],
    subject: 'Receipt for {{invoice_number}}',
    preview: 'Thanks. Your Waves payment was received.',
    ctaLabel: 'View receipt',
    ctaUrlVariable: 'receipt_url',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, thanks. We received your payment for invoice {{invoice_number}}.' },
      { type: 'details', rows: [{ label: 'Amount paid', value: '{{amount_paid}}' }, { label: 'Service', value: '{{service_label}}' }, { label: 'Paid', value: '{{paid_at}}' }, { label: 'Method', value: '{{payment_method}}' }] },
      { type: 'callout', content: '{{memo}}' },
      { type: 'cta', label: 'View receipt', url_variable: 'receipt_url' },
    ],
    fixture: { first_name: 'Taylor', receipt_url: 'https://portal.wavespestcontrol.com/receipt/sample', invoice_number: 'W-1042', amount_paid: '$129.00', paid_at: 'June 8' },
  },
  {
    key: 'payment.failed',
    name: 'Payment Failed',
    description: 'Account-state notice when an autopay attempt fails.',
    purpose: 'payment',
    legal: 'transactional_relationship',
    stream: 'transactional_required',
    sensitivity: 'financial',
    required: ['first_name', 'payment_url'],
    optional: ['invoice_number', 'retry_date'],
    subject: 'Payment issue on your Waves account',
    preview: 'Your recent Waves payment did not go through.',
    ctaLabel: 'Update payment',
    ctaUrlVariable: 'payment_url',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your recent Waves payment did not go through.' },
      { type: 'paragraph', content: 'This is usually caused by an expired card, a bank flag, or a temporary processor issue. You can update payment from the secure link below.' },
      { type: 'cta', label: 'Update payment', url_variable: 'payment_url' },
      { type: 'small_note', content: 'If you already fixed this, no action is needed.' },
    ],
    fixture: { first_name: 'Taylor', payment_url: 'https://portal.wavespestcontrol.com/pay/sample', invoice_number: 'W-1042', retry_date: 'June 12' },
  },
  {
    key: 'service.report_ready',
    name: 'Service Report Ready',
    description: 'Email sent when a completed service report is ready.',
    purpose: 'report',
    sensitivity: 'property_sensitive',
    required: ['first_name', 'report_url', 'service_label'],
    optional: ['service_date', 'technician_name'],
    subject: 'Your Waves service report is ready',
    preview: 'Review your service summary, recommendations, and report details.',
    ctaLabel: 'View report',
    ctaUrlVariable: 'report_url',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your {{service_label}} report is ready.' },
      { type: 'paragraph', content: 'The visit is complete. You can review the summary, findings, recommendations, and any customer advisories from the secure report link.' },
      { type: 'cta', label: 'View report', url_variable: 'report_url' },
    ],
    fixture: { first_name: 'Taylor', report_url: 'https://portal.wavespestcontrol.com/report/sample', service_label: 'pest control', service_date: ' on June 8', technician_name: 'Alex' },
  },
  {
    key: 'project.report_ready',
    name: 'Project Report Ready',
    description: 'Email sent when an inspection or specialty project report is posted.',
    purpose: 'report',
    sensitivity: 'property_sensitive',
    required: ['first_name', 'report_url', 'report_type'],
    optional: ['inspection_date', 'property_address'],
    subject: 'Your Waves {{report_type}} report is ready',
    preview: 'Your report is posted and ready to review.',
    ctaLabel: 'View report',
    ctaUrlVariable: 'report_url',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves {{report_type}} report is posted.' },
      { type: 'paragraph', content: 'You can review the visit summary, photos, findings, and recommendations from the secure report link below.' },
      { type: 'cta', label: 'View report', url_variable: 'report_url' },
    ],
    fixture: { first_name: 'Taylor', report_url: 'https://portal.wavespestcontrol.com/report/project/sample', report_type: 'inspection', inspection_date: 'June 8', property_address: '13649 Luxe Ave' },
  },
  {
    key: 'prep.bed_bug',
    name: 'Bed Bug Prep Guide',
    description: 'Service prep instructions before a bed bug treatment.',
    purpose: 'prep',
    sensitivity: 'health_safety',
    required: ['first_name'],
    optional: ['prep_url'],
    subject: 'Your bed bug treatment prep guide',
    preview: 'Please review these prep steps before your Waves treatment.',
    ctaLabel: 'View prep guide',
    ctaUrlVariable: 'prep_url',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, please review the prep instructions before your bed bug treatment.' },
      { type: 'callout', content: 'Prep matters for this service. Clearing access and handling bedding correctly helps the treatment work as intended.' },
      { type: 'paragraph', content: 'If you have questions before the visit, reply to this email and we will help.' },
    ],
    fixture: { first_name: 'Taylor', prep_url: 'https://portal.wavespestcontrol.com/prep/bed-bug' },
  },
  {
    key: 'prep.cockroach',
    name: 'Cockroach Prep Guide',
    description: 'Service prep instructions before a cockroach treatment.',
    purpose: 'prep',
    sensitivity: 'health_safety',
    required: ['first_name'],
    optional: ['prep_url'],
    subject: 'Your cockroach treatment prep guide',
    preview: 'Please review these prep steps before your Waves treatment.',
    ctaLabel: 'View prep guide',
    ctaUrlVariable: 'prep_url',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, please review the prep instructions before your cockroach treatment.' },
      { type: 'callout', content: 'Please avoid store-bought sprays between visits. They can scatter activity and make treatment less effective.' },
      { type: 'paragraph', content: 'Reply to this email if anything is unclear before we arrive.' },
    ],
    fixture: { first_name: 'Taylor', prep_url: 'https://portal.wavespestcontrol.com/prep/cockroach' },
  },
  {
    key: 'welcome.new_recurring',
    name: 'New Recurring Customer Welcome',
    description: 'Welcome and first-service expectations for a new recurring customer.',
    purpose: 'onboarding',
    required: ['first_name'],
    optional: ['portal_url'],
    subject: 'Welcome to Waves, {{first_name}}',
    preview: 'What to expect from your first recurring service visit.',
    ctaLabel: 'Open portal',
    ctaUrlVariable: 'portal_url',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, welcome to Waves. We are glad to have you on our route.' },
      { type: 'paragraph', content: 'On the first recurring visit, our technician will inspect the property, treat the service areas, and note anything that needs follow-up.' },
      { type: 'small_note', content: 'Between services, reply to a Waves message if you need help.' },
    ],
    fixture: { first_name: 'Taylor', portal_url: 'https://portal.wavespestcontrol.com' },
  },
  {
    key: 'marketing.newsletter_issue',
    name: 'Newsletter Issue',
    description: 'Reusable marketing/newsletter template shell.',
    mode: 'marketing',
    purpose: 'campaign',
    legal: 'commercial_marketing',
    stream: 'marketing_newsletter',
    audience: 'subscriber',
    sensitivity: 'normal',
    fromEmail: MARKETING_FROM,
    replyTo: 'contact@wavespestcontrol.com',
    required: ['headline'],
    optional: ['primary_url'],
    subject: '{{headline}}',
    preview: 'The latest from Waves Pest Control.',
    ctaLabel: 'Read more',
    ctaUrlVariable: 'primary_url',
    blocks: [
      { type: 'heading', content: '{{headline}}' },
      { type: 'paragraph', content: 'Add the main newsletter story here.' },
    ],
    fixture: { headline: 'SWFL lawn and pest notes for the week', primary_url: 'https://wavespestcontrol.com' },
  },
];

const AUTOMATIONS = [
  {
    key: 'estimate.delivery',
    name: 'Estimate delivery',
    description: 'Immediate customer email when an estimate is sent from Waves admin.',
    trigger: 'estimate.sent',
    template: 'estimate.delivery',
    delayMinutes: 0,
    audience: 'lead',
    status: 'active',
    frequencyCap: 'once_per_estimate',
    idempotency: 'estimate.delivery:{estimate_id}',
    conditions: { estimate_status: ['sent', 'open'] },
    exit: { stop_if: ['estimate.accepted', 'estimate.archived'] },
    dryRunNotes: 'Counts recent estimates that are still open or sent.',
  },
  {
    key: 'estimate.unviewed_followup',
    name: 'Estimate unviewed follow-up',
    description: 'Follow-up when an estimate has been sent but has not been viewed.',
    trigger: 'estimate.sent',
    template: 'estimate.unviewed_followup',
    delayMinutes: 24 * 60,
    audience: 'lead',
    status: 'draft',
    frequencyCap: 'once_per_estimate',
    idempotency: 'estimate.unviewed_followup:{estimate_id}',
    conditions: { estimate_viewed: false, estimate_status: ['sent', 'open'] },
    exit: { stop_if: ['estimate.viewed', 'estimate.accepted', 'estimate.expired'] },
    dryRunNotes: 'Counts recent open estimates where view tracking is not present.',
  },
  {
    key: 'estimate.viewed_followup',
    name: 'Estimate viewed follow-up',
    description: 'Follow-up when a customer viewed an estimate but has not accepted it.',
    trigger: 'estimate.viewed',
    template: 'estimate.viewed_followup',
    delayMinutes: 24 * 60,
    audience: 'lead',
    status: 'draft',
    frequencyCap: 'once_per_estimate',
    idempotency: 'estimate.viewed_followup:{estimate_id}',
    conditions: { estimate_viewed: true, estimate_status: ['sent', 'open'] },
    exit: { stop_if: ['estimate.accepted', 'estimate.expired'] },
    dryRunNotes: 'Counts recent open estimates that have a viewed timestamp when available.',
  },
  {
    key: 'estimate.expiring_notice',
    name: 'Estimate expiring notice',
    description: 'Account-state notice before an estimate expires.',
    trigger: 'estimate.expiring_soon',
    template: 'estimate.expiring_notice',
    delayMinutes: 0,
    audience: 'lead',
    status: 'draft',
    frequencyCap: 'once_per_estimate_expiration',
    idempotency: 'estimate.expiring_notice:{estimate_id}:{expires_at}',
    conditions: { expires_within_days: 2, estimate_status: ['sent', 'open'] },
    exit: { stop_if: ['estimate.accepted', 'estimate.expired', 'estimate.archived'] },
    dryRunNotes: 'Counts open estimates with an expiration date in the next two days when that column exists.',
  },
  {
    key: 'estimate.extension_notice',
    name: 'Estimate extension notice',
    description: 'Account-state email when Waves extends an estimate.',
    trigger: 'estimate.auto_renewed',
    template: 'estimate.extension_notice',
    delayMinutes: 0,
    audience: 'lead',
    status: 'active',
    frequencyCap: 'once_per_estimate_extension',
    idempotency: 'estimate.extension_notice:{estimate_id}:{new_expires_at}',
    conditions: { renewal_count_gt: 0 },
    exit: { stop_if: ['estimate.accepted', 'estimate.archived'] },
    dryRunNotes: 'Counts estimates with renewal_count greater than zero when available.',
  },
  {
    key: 'onboarding.24h_reminder',
    name: 'Onboarding 24h reminder',
    description: 'First setup reminder after a customer accepts an estimate.',
    trigger: 'onboarding.created',
    template: 'onboarding.24h_reminder',
    delayMinutes: 24 * 60,
    audience: 'customer',
    status: 'active',
    frequencyCap: 'once_per_onboarding_session',
    idempotency: 'onboarding.24h_reminder:{onboarding_id}',
    conditions: { completed: false },
    exit: { stop_if: ['onboarding.completed', 'onboarding.expired'] },
    dryRunNotes: 'Counts incomplete onboarding sessions when the onboarding table is present.',
  },
  {
    key: 'onboarding.72h_reminder',
    name: 'Onboarding 72h reminder',
    description: 'Second setup reminder for an incomplete onboarding session.',
    trigger: 'onboarding.created',
    template: 'onboarding.72h_reminder',
    delayMinutes: 72 * 60,
    audience: 'customer',
    status: 'active',
    frequencyCap: 'once_per_onboarding_session',
    idempotency: 'onboarding.72h_reminder:{onboarding_id}',
    conditions: { completed: false },
    exit: { stop_if: ['onboarding.completed', 'onboarding.expired'] },
    dryRunNotes: 'Counts incomplete onboarding sessions when the onboarding table is present.',
  },
  {
    key: 'onboarding.expiring_notice',
    name: 'Onboarding link expiring',
    description: 'Notice before a setup link expires.',
    trigger: 'onboarding.expiring_soon',
    template: 'onboarding.expiring_notice',
    delayMinutes: 0,
    audience: 'customer',
    status: 'active',
    frequencyCap: 'once_per_onboarding_expiration',
    idempotency: 'onboarding.expiring_notice:{onboarding_id}:{expires_at}',
    conditions: { completed: false, expires_within_days: 2 },
    exit: { stop_if: ['onboarding.completed', 'onboarding.expired'] },
    dryRunNotes: 'Counts incomplete onboarding sessions that can be evaluated locally.',
  },
  {
    key: 'invoice.sent',
    name: 'Invoice sent',
    description: 'Billing email when an invoice is issued.',
    trigger: 'invoice.sent',
    template: 'invoice.sent',
    delayMinutes: 0,
    audience: 'customer',
    status: 'active',
    frequencyCap: 'once_per_invoice',
    idempotency: 'invoice.sent:{invoice_id}',
    conditions: { invoice_status: ['open', 'sent', 'unpaid'] },
    exit: { stop_if: ['invoice.paid', 'invoice.voided'] },
    dryRunNotes: 'Counts recent open invoices when invoices are available locally.',
  },
  {
    key: 'invoice.receipt',
    name: 'Payment receipt',
    description: 'Receipt email after a payment is recorded.',
    trigger: 'invoice.paid',
    template: 'invoice.receipt',
    delayMinutes: 0,
    audience: 'customer',
    status: 'active',
    frequencyCap: 'once_per_payment',
    idempotency: 'invoice.receipt:{invoice_id}:{payment_id}',
    conditions: { invoice_status: ['paid'] },
    exit: { stop_if: [] },
    dryRunNotes: 'Counts recently paid invoices when invoices are available locally.',
  },
  {
    key: 'payment.failed',
    name: 'Payment failed',
    description: 'Account-state email when an autopay attempt fails.',
    trigger: 'payment.failed',
    template: 'payment.failed',
    delayMinutes: 0,
    audience: 'customer',
    status: 'draft',
    frequencyCap: 'once_per_failed_attempt',
    idempotency: 'payment.failed:{invoice_id}:{attempted_at}',
    conditions: { payment_status: ['failed'] },
    exit: { stop_if: ['invoice.paid', 'payment_method.updated'] },
    dryRunNotes: 'Counts failed payments when a payment status column is available locally.',
  },
  {
    key: 'service.report_ready',
    name: 'Service report ready',
    description: 'Secure report link after a service visit is completed.',
    trigger: 'service_report.ready',
    template: 'service.report_ready',
    delayMinutes: 0,
    audience: 'customer',
    status: 'active',
    frequencyCap: 'once_per_service_report',
    idempotency: 'service.report_ready:{service_record_id}',
    conditions: { service_status: ['completed'] },
    exit: { stop_if: [] },
    dryRunNotes: 'Counts recently completed service records.',
  },
  {
    key: 'project.report_ready',
    name: 'Project report ready',
    description: 'Secure report link after an inspection or specialty project is posted.',
    trigger: 'project_report.ready',
    template: 'project.report_ready',
    delayMinutes: 0,
    audience: 'customer',
    status: 'active',
    frequencyCap: 'once_per_project_report',
    idempotency: 'project.report_ready:{project_id}',
    conditions: { report_status: ['ready', 'published'] },
    exit: { stop_if: [] },
    dryRunNotes: 'Counts recent project-report sends from email history.',
  },
  {
    key: 'prep.bed_bug',
    name: 'Bed bug prep guide',
    description: 'Prep instructions before a bed bug treatment.',
    trigger: 'appointment.booked',
    template: 'prep.bed_bug',
    delayMinutes: 0,
    audience: 'customer',
    status: 'draft',
    frequencyCap: 'once_per_appointment',
    idempotency: 'prep.bed_bug:{scheduled_service_id}',
    conditions: { service_type_contains: ['bed bug'] },
    exit: { stop_if: ['appointment.cancelled'] },
    dryRunNotes: 'Counts upcoming scheduled services with bed bug in the service type.',
  },
  {
    key: 'prep.cockroach',
    name: 'Cockroach prep guide',
    description: 'Prep instructions before a cockroach treatment.',
    trigger: 'appointment.booked',
    template: 'prep.cockroach',
    delayMinutes: 0,
    audience: 'customer',
    status: 'draft',
    frequencyCap: 'once_per_appointment',
    idempotency: 'prep.cockroach:{scheduled_service_id}',
    conditions: { service_type_contains: ['cockroach', 'roach'] },
    exit: { stop_if: ['appointment.cancelled'] },
    dryRunNotes: 'Counts upcoming scheduled services with cockroach or roach in the service type.',
  },
  {
    key: 'welcome.new_recurring',
    name: 'New recurring welcome',
    description: 'Welcome email for a new recurring customer.',
    trigger: 'customer.recurring_created',
    template: 'welcome.new_recurring',
    delayMinutes: 0,
    audience: 'customer',
    status: 'draft',
    frequencyCap: 'once_per_customer',
    idempotency: 'welcome.new_recurring:{customer_id}',
    conditions: { customer_type: ['recurring'] },
    exit: { stop_if: ['customer.cancelled'] },
    dryRunNotes: 'Counts active customers created in the last 30 days when created_at is present.',
  },
];

function templateRow(t) {
  return {
    template_key: t.key,
    name: t.name,
    description: t.description || null,
    mode: t.mode || 'service',
    purpose: t.purpose || 'general',
    legal_classification: t.legal || 'transactional_relationship',
    audience: t.audience || (t.mode === 'marketing' ? 'subscriber' : 'customer'),
    message_priority: t.priority || 'normal',
    content_sensitivity: t.sensitivity || 'normal',
    send_stream: t.stream || 'service_operational',
    suppression_group_key: t.stream || (t.mode === 'marketing' ? 'marketing_newsletter' : 'service_operational'),
    layout_wrapper_id: t.mode === 'marketing' ? 'newsletter_default_v1' : 'service_default_v1',
    from_name: t.fromName || 'Waves Pest Control',
    from_email: t.fromEmail || SERVICE_FROM,
    reply_to: t.replyTo || 'contact@wavespestcontrol.com',
    default_cta_label: t.ctaLabel || null,
    default_cta_url_variable: t.ctaUrlVariable || null,
    allowed_variables: JSON.stringify([...(t.required || []), ...(t.optional || [])]),
    required_variables: JSON.stringify(t.required || []),
    optional_variables: JSON.stringify(t.optional || []),
    status: 'active',
  };
}

function automationRow(a) {
  return {
    automation_key: a.key,
    name: a.name,
    description: a.description || null,
    trigger_event_key: a.trigger,
    trigger_description: a.description || null,
    template_key: a.template,
    delay_minutes: a.delayMinutes || 0,
    audience: a.audience || 'customer',
    status: a.status || 'draft',
    suppression_group_key: a.suppressionGroup || null,
    legal_classification: a.legal || 'transactional_relationship',
    frequency_cap: a.frequencyCap || 'once_per_entity',
    idempotency_key_template: a.idempotency || null,
    conditions: JSON.stringify(a.conditions || {}),
    exit_conditions: JSON.stringify(a.exit || {}),
    retry_policy: JSON.stringify(a.retry || { max_attempts: 2, backoff_minutes: [15, 60] }),
    quiet_hours: JSON.stringify(a.quietHours || { enabled: false }),
    timezone: a.timezone || 'America/New_York',
    owner: a.owner || 'operations',
    dry_run_notes: a.dryRunNotes || null,
  };
}

exports.up = async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  await knex.schema.createTable('email_preference_groups', (t) => {
    t.string('key', 80).primary();
    t.string('name', 160).notNullable();
    t.text('description');
    t.string('send_stream', 80).notNullable();
    t.boolean('user_can_unsubscribe').defaultTo(true);
    t.integer('sort_order').defaultTo(100);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('email_templates', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('template_key', 120).notNullable().unique();
    t.string('name', 180).notNullable();
    t.text('description');
    t.string('mode', 30).notNullable().defaultTo('service');
    t.string('purpose', 60).notNullable().defaultTo('general');
    t.string('legal_classification', 60).notNullable().defaultTo('transactional_relationship');
    t.string('audience', 60).notNullable().defaultTo('customer');
    t.string('message_priority', 30).notNullable().defaultTo('normal');
    t.string('content_sensitivity', 60).notNullable().defaultTo('normal');
    t.string('send_stream', 80).notNullable().defaultTo('service_operational');
    t.string('suppression_group_key', 80).references('key').inTable('email_preference_groups').onDelete('SET NULL');
    t.string('layout_wrapper_id', 80).notNullable().defaultTo('service_default_v1');
    t.string('from_name').defaultTo('Waves Pest Control');
    t.string('from_email').defaultTo(SERVICE_FROM);
    t.string('reply_to').defaultTo('contact@wavespestcontrol.com');
    t.string('default_cta_label');
    t.string('default_cta_url_variable');
    t.jsonb('allowed_variables').defaultTo('[]');
    t.jsonb('required_variables').defaultTo('[]');
    t.jsonb('optional_variables').defaultTo('[]');
    t.string('status', 30).defaultTo('draft');
    t.uuid('active_version_id');
    t.uuid('created_by').references('id').inTable('technicians').onDelete('SET NULL');
    t.uuid('last_published_by').references('id').inTable('technicians').onDelete('SET NULL');
    t.timestamp('last_published_at');
    t.timestamps(true, true);
    t.index(['mode', 'purpose']);
    t.index(['send_stream']);
    t.index(['status']);
  });

  await knex.schema.createTable('email_template_versions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('template_id').notNullable().references('id').inTable('email_templates').onDelete('CASCADE');
    t.integer('version_number').notNullable();
    t.string('status', 30).notNullable().defaultTo('draft');
    t.string('subject').notNullable();
    t.string('preview_text');
    t.jsonb('blocks').defaultTo('[]');
    t.text('text_body');
    t.jsonb('validation_snapshot').defaultTo('{}');
    t.uuid('created_by').references('id').inTable('technicians').onDelete('SET NULL');
    t.uuid('published_by').references('id').inTable('technicians').onDelete('SET NULL');
    t.timestamp('published_at');
    t.timestamps(true, true);
    t.unique(['template_id', 'version_number']);
    t.index(['template_id', 'status']);
  });

  await knex.schema.createTable('email_template_fixtures', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('template_id').notNullable().references('id').inTable('email_templates').onDelete('CASCADE');
    t.string('name', 120).notNullable().defaultTo('Happy path');
    t.jsonb('payload').defaultTo('{}');
    t.boolean('is_default').defaultTo(false);
    t.timestamps(true, true);
    t.index(['template_id']);
  });

  await knex.schema.createTable('email_messages', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('provider', 40).defaultTo('sendgrid');
    t.string('provider_message_id');
    t.uuid('template_id').references('id').inTable('email_templates').onDelete('SET NULL');
    t.uuid('template_version_id').references('id').inTable('email_template_versions').onDelete('SET NULL');
    t.string('template_key', 120);
    t.string('suppression_group_key_snapshot', 80);
    t.string('automation_run_id');
    t.string('trigger_event_id');
    t.string('recipient_type', 40);
    t.string('recipient_id');
    t.string('recipient_email_snapshot').notNullable();
    t.string('from_name_snapshot');
    t.string('from_email_snapshot');
    t.string('reply_to_snapshot');
    t.string('subject_snapshot');
    t.text('html_snapshot');
    t.text('text_snapshot');
    t.jsonb('payload_snapshot').defaultTo('{}');
    t.jsonb('categories').defaultTo('[]');
    t.string('status', 40).defaultTo('queued');
    t.string('idempotency_key', 260);
    t.text('error_message');
    t.timestamp('queued_at').defaultTo(knex.fn.now());
    t.timestamp('sent_at');
    t.timestamp('delivered_at');
    t.timestamp('opened_at');
    t.timestamp('clicked_at');
    t.timestamp('bounced_at');
    t.timestamp('complained_at');
    t.timestamps(true, true);
    t.index(['template_key']);
    t.index(['provider_message_id']);
    t.index(['recipient_email_snapshot']);
    t.index(['status', 'queued_at']);
    t.unique(['idempotency_key']);
  });

  await knex.schema.createTable('email_message_events', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('email_message_id').notNullable().references('id').inTable('email_messages').onDelete('CASCADE');
    t.string('provider', 40).defaultTo('sendgrid');
    t.string('provider_event_id');
    t.string('event_type', 60).notNullable();
    t.jsonb('raw_event').defaultTo('{}');
    t.timestamp('occurred_at').defaultTo(knex.fn.now());
    t.timestamps(true, true);
    t.index(['email_message_id']);
    t.index(['provider_event_id']);
  });

  await knex.schema.createTable('email_suppressions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('email').notNullable();
    t.string('group_key', 80).references('key').inTable('email_preference_groups').onDelete('SET NULL');
    t.string('suppression_type', 60).notNullable(); // unsubscribe | bounce | spam_complaint | manual | do_not_email
    t.string('status', 30).defaultTo('active');
    t.string('source', 120);
    t.timestamp('suppressed_at').defaultTo(knex.fn.now());
    t.timestamp('released_at');
    t.string('consent_source');
    t.timestamp('consent_timestamp');
    t.jsonb('metadata').defaultTo('{}');
    t.timestamps(true, true);
    t.index(['email']);
    t.index(['group_key', 'status']);
    t.index(['suppression_type', 'status']);
  });

  await knex.schema.createTable('email_template_automations', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('automation_key', 140).notNullable().unique();
    t.string('name', 180).notNullable();
    t.text('description');
    t.string('trigger_event_key', 120).notNullable();
    t.text('trigger_description');
    t.string('template_key', 120).notNullable().references('template_key').inTable('email_templates').onDelete('RESTRICT');
    t.integer('delay_minutes').notNullable().defaultTo(0);
    t.string('audience', 60).notNullable().defaultTo('customer');
    t.string('status', 30).notNullable().defaultTo('draft'); // draft | active | paused | archived
    t.string('suppression_group_key', 80).references('key').inTable('email_preference_groups').onDelete('SET NULL');
    t.string('legal_classification', 60).notNullable().defaultTo('transactional_relationship');
    t.string('frequency_cap', 120).defaultTo('once_per_entity');
    t.string('idempotency_key_template', 260);
    t.jsonb('conditions').defaultTo('{}');
    t.jsonb('exit_conditions').defaultTo('{}');
    t.jsonb('retry_policy').defaultTo('{}');
    t.jsonb('quiet_hours').defaultTo('{}');
    t.string('timezone', 80).defaultTo('America/New_York');
    t.string('owner', 120);
    t.text('dry_run_notes');
    t.uuid('created_by').references('id').inTable('technicians').onDelete('SET NULL');
    t.uuid('last_published_by').references('id').inTable('technicians').onDelete('SET NULL');
    t.timestamp('last_published_at');
    t.timestamps(true, true);
    t.index(['trigger_event_key']);
    t.index(['template_key']);
    t.index(['status']);
  });

  for (const group of GROUPS) {
    await knex('email_preference_groups').insert(group);
  }

  for (const t of TEMPLATES) {
    const [template] = await knex('email_templates').insert(templateRow(t)).returning('*');
    const [version] = await knex('email_template_versions').insert({
      template_id: template.id,
      version_number: 1,
      status: 'active',
      subject: t.subject,
      preview_text: t.preview || null,
      blocks: JSON.stringify(t.blocks || []),
      text_body: null,
      published_at: new Date(),
    }).returning('*');
    await knex('email_templates').where({ id: template.id }).update({
      active_version_id: version.id,
      last_published_at: new Date(),
    });
    await knex('email_template_fixtures').insert({
      template_id: template.id,
      name: 'Happy path',
      payload: JSON.stringify(t.fixture || {}),
      is_default: true,
    });
  }

  for (const automation of AUTOMATIONS) {
    const template = await knex('email_templates').where({ template_key: automation.template }).first();
    if (!template) continue;
    const groupKey = template.suppression_group_key || template.send_stream || null;
    await knex('email_template_automations').insert({
      ...automationRow(automation),
      suppression_group_key: groupKey,
      last_published_at: new Date(),
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('email_template_automations');
  await knex.schema.dropTableIfExists('email_suppressions');
  await knex.schema.dropTableIfExists('email_message_events');
  await knex.schema.dropTableIfExists('email_messages');
  await knex.schema.dropTableIfExists('email_template_fixtures');
  await knex.schema.dropTableIfExists('email_template_versions');
  await knex.schema.dropTableIfExists('email_templates');
  await knex.schema.dropTableIfExists('email_preference_groups');
};
