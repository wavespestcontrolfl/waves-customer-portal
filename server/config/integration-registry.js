const ADMIN_INTEGRATIONS = [
  {
    id: 'twilio',
    category: 'Messaging',
    name: 'Twilio',
    platform: 'Twilio',
    description: 'SMS, OTP login, voice calls',
    env: {
      required: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
      supporting: [],
    },
    health: { type: 'token-health', key: 'twilio', primaryEnvKey: 'TWILIO_AUTH_TOKEN' },
    gates: [
      { key: 'twilioSms', label: 'SMS' },
      { key: 'twilioVoice', label: 'Voice' },
      { key: 'webhooks', label: 'Webhooks' },
    ],
  },
  {
    id: 'sendgrid',
    category: 'Messaging',
    name: 'SendGrid',
    platform: 'SendGrid',
    description: 'Newsletter + transactional email (primary)',
    env: {
      required: ['SENDGRID_API_KEY'],
      supporting: ['SENDGRID_FROM_EMAIL', 'SENDGRID_ASM_GROUP_NEWSLETTER', 'SENDGRID_ASM_GROUP_SERVICE'],
    },
    readiness: {
      degradeWhenMissing: ['SENDGRID_FROM_EMAIL'],
    },
    health: { type: 'token-health', key: 'sendgrid', primaryEnvKey: 'SENDGRID_API_KEY' },
    gates: [],
  },
  {
    id: 'stripe',
    category: 'Payments & Billing',
    name: 'Stripe',
    platform: 'Stripe',
    description: 'Payment Element, invoicing, Tap to Pay',
    env: {
      required: ['STRIPE_SECRET_KEY'],
      supporting: ['STRIPE_WEBHOOK_SECRET'],
    },
    readiness: {
      degradeWhenMissing: ['STRIPE_WEBHOOK_SECRET'],
    },
    health: { type: 'token-health', key: 'stripe', primaryEnvKey: 'STRIPE_SECRET_KEY' },
    gates: [],
  },
  {
    id: 'anthropic',
    category: 'AI Providers',
    name: 'Anthropic (Claude)',
    platform: 'Anthropic',
    description: 'Intelligence Bar, agents, triage',
    env: { required: ['ANTHROPIC_API_KEY'], supporting: [] },
    health: { type: 'token-health', key: 'anthropic', primaryEnvKey: 'ANTHROPIC_API_KEY' },
    gates: [],
  },
  {
    id: 'openai',
    category: 'AI Providers',
    name: 'OpenAI (ChatGPT)',
    platform: 'OpenAI',
    description: 'Property search and satellite review',
    env: { required: ['OPENAI_API_KEY'], supporting: [] },
    health: { type: 'token-health', key: 'openai', primaryEnvKey: 'OPENAI_API_KEY' },
    gates: [],
  },
  {
    id: 'gemini',
    category: 'AI Providers',
    name: 'Google Gemini',
    platform: 'Google',
    description: 'Property search and satellite review',
    env: { required: ['GEMINI_API_KEY'], supporting: [] },
    health: { type: 'token-health', key: 'gemini', primaryEnvKey: 'GEMINI_API_KEY' },
    gates: [],
  },
  {
    id: 'google_apis',
    category: 'Data & Research',
    name: 'Google APIs',
    platform: 'Google',
    description: 'Maps, GSC, PageSpeed, Places Autocomplete',
    env: {
      required: [],
      oneOfRequired: ['GOOGLE_API_KEY', 'GOOGLE_MAPS_API_KEY'],
      supporting: ['GOOGLE_MAPS_BROWSER_API_KEY'],
    },
    health: { type: 'token-health', key: 'google', primaryEnvKey: 'GOOGLE_API_KEY or GOOGLE_MAPS_API_KEY' },
    gates: [],
  },
  {
    id: 'dataforseo',
    category: 'Data & Research',
    name: 'DataForSEO',
    platform: 'DataForSEO',
    description: 'Rank tracking, SERP, backlinks',
    env: { required: ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'], supporting: [] },
    health: { type: 'token-health', key: 'dataforseo', primaryEnvKey: 'DATAFORSEO_LOGIN' },
    gates: [{ key: 'seoIntelligence', label: 'SEO' }],
  },
  {
    id: 'facebook',
    category: 'Social & Listings',
    name: 'Facebook',
    platform: 'Meta',
    description: 'Post scheduling, lead ads ingest',
    env: { required: ['FACEBOOK_ACCESS_TOKEN'], supporting: [] },
    health: { type: 'token-health', key: 'facebook', primaryEnvKey: 'FACEBOOK_ACCESS_TOKEN' },
    gates: [],
  },
  {
    id: 'instagram',
    category: 'Social & Listings',
    name: 'Instagram',
    platform: 'Meta',
    description: 'Post scheduling via Graph API',
    env: { required: ['INSTAGRAM_ACCOUNT_ID'], supporting: [] },
    health: { type: 'token-health', key: 'instagram', primaryEnvKey: 'INSTAGRAM_ACCOUNT_ID' },
    gates: [],
  },
  {
    id: 'linkedin',
    category: 'Social & Listings',
    name: 'LinkedIn',
    platform: 'LinkedIn',
    description: 'Company-page posting via OAuth (Posts API)',
    // OAuth model: app creds in env, the page token is DB-stored (services/linkedin.js).
    // COMPANY_ID is required to post (createPost targets urn:li:organization:<id>),
    // so it's required config, not merely supporting.
    env: { required: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'LINKEDIN_COMPANY_ID'], supporting: [] },
    health: { type: 'token-health', key: 'linkedin', primaryEnvKey: 'LINKEDIN_CLIENT_ID' },
    gates: [],
  },
  {
    id: 'google_business_profile',
    category: 'Social & Listings',
    name: 'Google Business Profile',
    platform: 'Google',
    description: '4 locations: LWR, Parrish, Sarasota, Venice',
    env: {
      // OAuth refresh tokens are NOT env config: they are stored in
      // system_settings by the admin connect flow and verified per-location
      // by token-health checkGBP. Only the OAuth client credentials are
      // required in the environment.
      required: [
        'GBP_CLIENT_ID_LWR',
        'GBP_CLIENT_SECRET_LWR',
        'GBP_CLIENT_ID_PARRISH',
        'GBP_CLIENT_SECRET_PARRISH',
        'GBP_CLIENT_ID_SARASOTA',
        'GBP_CLIENT_SECRET_SARASOTA',
        'GBP_CLIENT_ID_VENICE',
        'GBP_CLIENT_SECRET_VENICE',
      ],
      supporting: [],
    },
    health: {
      type: 'grouped',
      aggregate: 'fraction',
      children: [
        { key: 'gbp_lwr', label: 'LWR' },
        { key: 'gbp_parrish', label: 'Parrish' },
        { key: 'gbp_sarasota', label: 'Sarasota' },
        { key: 'gbp_venice', label: 'Venice' },
      ],
    },
    gates: [],
  },
  {
    id: 'bouncie',
    category: 'Fleet',
    name: 'Bouncie',
    platform: 'Bouncie',
    description: 'GPS + mileage tracking for tech vehicles',
    env: {
      required: ['BOUNCIE_CLIENT_ID', 'BOUNCIE_CLIENT_SECRET', 'BOUNCIE_REFRESH_TOKEN'],
      supporting: ['BOUNCIE_WEBHOOK_SECRET'],
    },
    readiness: {
      degradeWhenMissing: ['BOUNCIE_WEBHOOK_SECRET'],
    },
    health: { type: 'token-health', key: 'bouncie', primaryEnvKey: 'BOUNCIE_REFRESH_TOKEN' },
    gates: [],
  },
];

function getIntegrationEnvKeys() {
  return Array.from(new Set(
    ADMIN_INTEGRATIONS.flatMap((integration) => [
      ...(integration.env?.required || []),
      ...(integration.env?.oneOfRequired || []),
      ...(integration.env?.supporting || []),
    ]),
  ));
}

module.exports = {
  ADMIN_INTEGRATIONS,
  getIntegrationEnvKeys,
};
