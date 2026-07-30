/**
 * DEV HARNESS (uncommitted) — renders the REAL customer PortalPage against a
 * fully stubbed api client so the current portal UI can be eyeballed (and
 * screenshotted for marketing) in a browser with populated demo data — no
 * database, backend, or login code required. Served by `npx vite` at
 * /preview-portal.html (?tab=services / ?tab=billing deep-links work).
 * NOT part of the app build. Demo persona is fictional (Jordan Rivera) —
 * never real customer data.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '../index.css';
import '../styles/brand-tokens.css';
import api from '../utils/api';
import { AuthProvider } from '../hooks/useAuth';
import PortalPage from '../pages/PortalPage';

// ── auth seed ──────────────────────────────────────────────────────────────
// useAuth only base64url-decodes the payload segment ({ customerId,
// sessionId }) — an unsigned three-segment token is enough for the provider
// to adopt the session and call our stubbed getMe().
const b64url = (obj) => btoa(JSON.stringify(obj))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const FAKE_TOKEN = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ customerId: 'cust-demo-1', sessionId: 'sess-demo-1' })}.demo-signature`;
localStorage.setItem('waves_token', FAKE_TOKEN);
localStorage.removeItem('waves_refresh_token');

// ── demo dates (relative to "today" so the preview stays evergreen) ────────
const addDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
};
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = (n) => iso(addDays(n));

// ── demo persona: Jordan Rivera (fictional) ────────────────────────────────
const CUSTOMER = {
  id: 'cust-demo-1',
  accountId: 'acct-demo-1',
  profileLabel: 'Home',
  isPrimaryProfile: true,
  firstName: 'Jordan',
  lastName: 'Rivera',
  email: 'jordan.rivera@example.com',
  phone: '9415550190',
  address: { line1: '1200 Palm Row Ct', line2: null, city: 'Parrish', state: 'FL', zip: '34219' },
  property: { lawnType: 'St. Augustine Full Sun', propertySqFt: 4800, lotSqFt: 9800, bedSqFt: 650, palmCount: 4, canopyType: null },
  tier: 'Silver', // Silver = Quarterly Pest Control + Lawn Care Program
  monthlyRate: null, // per-application billing — no monthly subscription rate
  memberSince: '2024-03-14',
  referralCode: 'JORDAN941',
  accountCredit: 0,
  credits: [],
  annualPrepay: null,
  notificationPrefs: {
    serviceReminder24h: true, techEnRoute: true, serviceCompleted: true,
    billingReminder: false, seasonalTips: true, smsEnabled: true, emailEnabled: true,
  },
};

// Arrival window display = 2 hours from window_start; window_end mirrors that.
const UPCOMING = [
  {
    id: 'visit-up-1',
    date: day(5),
    windowStart: '09:00:00',
    windowEnd: '11:00:00',
    serviceType: 'Quarterly Pest Control',
    status: 'confirmed',
    technician: 'Adam',
    customerConfirmed: true,
    confirmedAt: new Date().toISOString(),
    isRecurring: true,
    isCallback: false,
    rescheduleUrl: '/reschedule/demo-token-1',
  },
  {
    id: 'visit-up-2',
    date: day(21),
    windowStart: '13:00:00',
    windowEnd: '15:00:00',
    serviceType: 'Lawn Care Program',
    status: 'pending',
    technician: 'Adam',
    customerConfirmed: false,
    confirmedAt: null,
    isRecurring: true,
    isCallback: false,
    rescheduleUrl: '/reschedule/demo-token-2',
  },
];

const completedVisit = (over) => ({
  status: 'completed',
  technician: 'Adam',
  checkInTime: null,
  checkOutTime: null,
  notes: null,
  soilTemp: null,
  thatchMeasurement: null,
  soilPh: null,
  soilMoisture: null,
  products: [],
  hasPhotos: false,
  photoCount: 0,
  isProjectCompletion: false,
  projectId: null,
  projectType: null,
  projectReportPortalAttached: false,
  reportUrl: null,
  reportPdfUrl: null,
  reportToken: null,
  reportGeneratedAt: null,
  reportViewedAt: null,
  reportAvailable: false,
  ...over,
});

const COMPLETED = [
  completedVisit({
    id: 'svc-1',
    date: day(-22),
    type: 'Quarterly Pest Control',
    notes: 'Exterior perimeter application completed. Swept eaves and entry points, refreshed granular bait band along the foundation. No interior activity reported.',
    products: [
      { product_name: 'Bifen I/T', product_category: 'Insecticide', active_ingredient: 'Bifenthrin', moa_group: '3A', notes: null },
    ],
    reportUrl: '#',
    reportPdfUrl: '#',
    reportToken: 'demo-report-1',
    reportGeneratedAt: new Date(addDays(-22)).toISOString(),
    reportAvailable: true,
  }),
  completedVisit({
    id: 'svc-2',
    date: day(-50),
    type: 'Lawn Care Program',
    notes: 'Summer micronutrient application with spot weed treatment along the driveway edge. Turf color and density improving through the growing season.',
    soilTemp: 84.5,
    soilPh: 6.8,
    soilMoisture: 'Adequate',
    thatchMeasurement: 0.5,
    reportUrl: '#',
    reportPdfUrl: '#',
    reportToken: 'demo-report-2',
    reportGeneratedAt: new Date(addDays(-50)).toISOString(),
    reportAvailable: true,
  }),
  completedVisit({
    id: 'svc-3',
    date: day(-113),
    type: 'Quarterly Pest Control',
    notes: 'Quarterly exterior service completed. Inspected bait stations and treated mulch beds near the lanai.',
  }),
  completedVisit({
    id: 'svc-4',
    date: day(-140),
    type: 'Lawn Care Program',
    notes: 'Spring fertilization with pre-emergent weed control.',
    thatchMeasurement: 0.7,
  }),
];

const PAYMENTS = [
  {
    id: 'pay-1', date: day(-22), amount: 119, status: 'paid',
    description: 'Quarterly Pest Control — per application', type: 'one_time',
    cardBrand: 'visa', lastFour: '4242', processor: 'stripe', methodType: 'card',
    bankName: null, stripePaymentIntentId: null, refundAmount: null, refundStatus: null,
  },
  {
    id: 'pay-2', date: day(-50), amount: 86, status: 'paid',
    description: 'Lawn Care Program — per application', type: 'one_time',
    cardBrand: 'visa', lastFour: '4242', processor: 'stripe', methodType: 'card',
    bankName: null, stripePaymentIntentId: null, refundAmount: null, refundStatus: null,
  },
  {
    id: 'pay-3', date: day(-113), amount: 119, status: 'paid',
    description: 'Quarterly Pest Control — per application', type: 'one_time',
    cardBrand: 'visa', lastFour: '4242', processor: 'stripe', methodType: 'card',
    bankName: null, stripePaymentIntentId: null, refundAmount: null, refundStatus: null,
  },
];

const CARD = {
  id: 'pm-demo-1', processor: 'stripe', methodType: 'card', brand: 'visa',
  lastFour: '4242', expMonth: 12, expYear: 2028, isDefault: true,
  autopayEnabled: true, bankName: null, bankLastFour: null, achStatus: null,
};

const AUTOPAY = {
  state: 'active',
  autopay_enabled: true,
  paused_until: null,
  pause_reason: null,
  autopay_payment_method_id: 'pm-demo-1',
  billing_day: 1,
  billing_mode: 'per_application',
  non_monthly_billing: true,
  next_charge_date: null,
  next_charge_amount: null,
  next_charge_base_amount: null,
  next_charge_surcharge_amount: null,
  monthly_rate: null,
  waveguard_tier: 'Silver',
  payment_methods: [{
    id: 'pm-demo-1', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2028,
    is_default: true, autopay_enabled: true, method_type: 'card', bank_name: null, ach_status: null,
  }],
  recent_events: [],
};

const NOTIFICATION_PREFS = {
  appointmentConfirmation: true,
  serviceReminder72h: true,
  serviceReminder24h: true,
  techEnRoute: true,
  techArrived: true,
  autoFlipEnRoute: true,
  serviceCompleted: true,
  billingReminder: false,
  seasonalTips: true,
  smsEnabled: true,
  emailEnabled: true,
  billingEmail: 'jordan.rivera@example.com',
  billingContactName: '',
  paymentConfirmationSms: true,
  appointmentNotifyPrimary: false,
  serviceReportNotifyPrimary: false,
  appointmentConfirmationChannel: 'sms',
  serviceReminder72hChannel: 'sms',
  serviceReminder24hChannel: 'sms',
  enRouteChannel: 'sms',
  techArrivedChannel: 'sms',
  billingReminderChannel: 'sms',
  paymentConfirmationChannel: 'sms',
};

const PROPERTY_PREFERENCES = {
  neighborhoodGateCode: '', propertyGateCode: '', garageCode: '', lockboxCode: '',
  parkingNotes: 'Driveway parking is fine', sideGateAccess: 'left',
  petCount: 1, petDetails: 'Golden retriever — friendly', petsSecuredPlan: 'inside', petsStructured: [],
  preferredDay: 'no_preference', preferredTime: 'morning', contactPreference: 'text',
  blackoutStart: null, blackoutEnd: null,
  irrigationSystem: true, irrigationControllerLocation: 'Garage', irrigationZones: 6,
  irrigationInchesPerWeek: null, irrigationScheduleNotes: '', wateringDays: ['tuesday', 'saturday'],
  irrigationSystemType: [], rainSensor: true, irrigationIssues: '',
  hoaName: '', hoaRestrictions: '', hoaCompany: '', hoaPhone: '', hoaEmail: '',
  hoaLawnHeight: '', hoaSignageRules: '', hoaTimingRestrictions: '', hoaInspectionPeriod: '',
  accessNotes: '', specialInstructions: '',
  updatedAt: new Date(addDays(-30)).toISOString(),
};

// ── stub every api method PortalPage (and AuthProvider) touches ────────────
// Overwrites land on the instance, shadowing the ApiClient prototype — the
// real token plumbing (adoptTokens/clearTokens) keeps working underneath.
Object.assign(api, {
  // auth
  getMe: async () => CUSTOMER,
  getAuthProperties: async () => ({
    properties: [{
      id: 'cust-demo-1',
      profileLabel: 'Home',
      isPrimary: true,
      address: { line1: '1200 Palm Row Ct', city: 'Parrish', state: 'FL', zip: '34219' },
    }],
  }),

  // schedule
  getSchedule: async () => ({ hasCancellableWork: true, upcoming: UPCOMING }),
  getNextService: async () => ({ next: UPCOMING[0] }),
  confirmAppointment: async () => ({ success: true }),
  rescheduleAppointment: async () => ({ success: true }),

  // services
  getServices: async (params = {}) => ({
    services: COMPLETED.slice(params.offset || 0, (params.offset || 0) + (params.limit || 20)),
    total: COMPLETED.length,
    limit: params.limit || 20,
    offset: params.offset || 0,
  }),
  getService: async (id) => {
    const s = COMPLETED.find((v) => v.id === id) || COMPLETED[0];
    return {
      id: s.id, date: s.date, type: s.type, status: s.status,
      technician: s.technician, checkInTime: s.checkInTime, checkOutTime: s.checkOutTime,
      notes: s.notes,
      measurements: { soilTemp: s.soilTemp, thatchMeasurement: s.thatchMeasurement, soilPh: s.soilPh, soilMoisture: s.soilMoisture },
      products: s.products, photos: [],
    };
  },
  getServiceStats: async () => ({
    servicesYTD: 4,
    celsiusApplicationsThisYear: 1,
    celsiusMaxPerYear: 3,
    thatch: { current: 0.5, initial: 0.7, currentDate: day(-50), initialDate: day(-140) },
  }),
  getServiceReportUrl: () => '#',

  // billing
  getPayments: async () => ({
    payments: PAYMENTS, total: PAYMENTS.length, limit: 100, cursor: 0, hasMore: false, nextCursor: null,
  }),
  getBalance: async () => ({
    currentBalance: 0, upcomingCharges: 0, monthlyRate: 0, tier: 'Silver',
    processor: 'stripe', nextCharge: null, lastPaymentFailed: false,
  }),
  getCards: async () => ({ cards: [CARD] }),
  getAutopay: async () => AUTOPAY,
  updateAutopay: async () => ({ success: true, updated: true, changes: [] }),
  pauseAutopay: async () => ({ success: true }),
  resumeAutopay: async () => ({ success: true }),
  saveStripeCard: async () => ({ success: true }),
  createSetupIntent: async () => ({}),
  getBankVerificationLink: async () => ({ url: null }),
  removeCard: async () => ({ success: true }),
  setDefaultCard: async () => ({ success: true }),

  // notifications
  getNotificationPrefs: async () => NOTIFICATION_PREFS,
  updateNotificationPrefs: async () => ({ success: true }),
  getPropertyNotificationPrefs: async () => ({
    properties: [{
      id: 'cust-demo-1',
      profileLabel: 'Home',
      address: { line1: '1200 Palm Row Ct', city: 'Parrish', state: 'FL', zip: '34219' },
      preferences: {
        appointmentConfirmation: true, serviceReminder72h: true, serviceReminder24h: true,
        techEnRoute: true, techArrived: true, autoFlipEnRoute: true, serviceCompleted: true,
        billingReminder: false, seasonalTips: true, smsEnabled: true, emailEnabled: true,
        billingEmail: '', billingContactName: '', paymentConfirmationSms: true,
        appointmentNotifyPrimary: false, serviceReportNotifyPrimary: false,
      },
      serviceContact: null,
      serviceContacts: [],
      maxServiceContacts: 3,
    }],
  }),
  updatePropertyNotificationPrefs: async () => ({ success: true }),

  // referrals
  getReferrals: async () => ({
    referralCode: 'JORDAN941',
    referralLink: 'https://wavespestcontrol.com/refer/JORDAN941',
    milestoneLevel: 'none',
    nextMilestone: { level: 'advocate', threshold: 3, bonus: 2500, progress: 1, remaining: 2 },
    availableBalance: 0,
    pendingEarnings: 2500,
    totalEarned: 5000,
    totalPaidOut: 0,
    stats: { totalReferrals: 2, converted: 1, pending: 1, totalClicks: 9 },
    referrals: [
      { id: 'ref-1', name: 'Casey T.', phone: '(941) •••-0144', status: 'credited', rewardAmount: 25, rewardStatus: 'earned', createdAt: new Date(addDays(-70)).toISOString(), convertedAt: new Date(addDays(-58)).toISOString() },
      { id: 'ref-2', name: 'Morgan L.', phone: '(941) •••-0172', status: 'pending', rewardAmount: 0, rewardStatus: 'pending', createdAt: new Date(addDays(-12)).toISOString(), convertedAt: null },
    ],
    rewardPerReferral: 25,
  }),
  getReferralStats: async () => ({ totalReferrals: 2, totalConverted: 1, totalEarned: 5000, availableBalance: 0, referralCode: 'JORDAN941', referralLink: 'https://wavespestcontrol.com/refer/JORDAN941', milestoneLevel: 'none', enrolled: true }),
  submitReferral: async () => ({ success: true }),
  sendReferralEmailInvite: async () => ({ success: true }),

  // satisfaction / requests / documents
  getPendingSatisfaction: async () => ({ pending: [] }),
  submitSatisfaction: async () => ({ success: true }),
  getRequests: async () => ({ requests: [], total: 0 }),
  createRequest: async () => ({ success: true }),
  queryCustomerPricing: async () => ({}),
  getDocuments: async () => ({ documents: {}, total: 0 }),
  shareDocument: async () => ({ shareLink: '#' }),

  // property / preferences
  getPropertyPreferences: async () => ({ preferences: PROPERTY_PREFERENCES }),
  updatePropertyPreferences: async () => ({ preferences: PROPERTY_PREFERENCES, saved: true }),
  getServicePreferences: async () => ({ preferences: { interior_spray: true, exterior_sweep: true } }),
  updateServicePreferences: async () => ({ preferences: { interior_spray: true, exterior_sweep: true } }),
  getStationMap: async () => ({ available: false, reason: 'disabled', programs: {} }),

  // lawn health
  getLawnHealth: async () => ({
    scores: null, initialScores: null, hasLawnCare: false, photos: [], beforeAfter: null,
    trend: [], recommendations: null, assessmentCount: 0, nextMilestone: null,
    seasonalContext: null, neighborBenchmark: null, mowingHeight: null,
  }),
  getLawnHealthHistory: async () => ({ history: [] }),
  getLawnHealthPhotos: async () => ({ photos: [] }),

  // feed / content
  getWeather: async () => ({
    location: 'Parrish, FL',
    temp: 91, nightTemp: 76, humidity: 74, wind: '8 mph',
    forecast: 'Partly Cloudy',
    detailedForecast: 'Partly cloudy with a chance of afternoon showers.',
    isDaytime: true,
    pestPressure: {
      mosquito: { level: 'HIGH', color: '#E53935', advice: 'Peak mosquito activity — avoid standing water, barrier treatment is critical' },
      fungus: { level: 'MODERATE', color: '#FF9800', advice: 'Moderate fungus risk — water only in early morning' },
      chinch: { level: 'MODERATE', color: '#FF9800', advice: 'Chinch bugs active — watch sunny areas near driveways' },
    },
    irrigationRecommendation: 'Skip a cycle if afternoon rain arrives — about 0.75 inches this week is plenty.',
    updatedAt: new Date().toISOString(),
  }),
  getAlerts: async () => ({ alerts: [] }),
  getBlogPosts: async () => ({ posts: [] }),
  getNewsletterPosts: async () => ({ posts: [] }),
  getExpertPosts: async () => ({ posts: [] }),
  getLocalNews: async () => ({ posts: [] }),
  getFaq: async () => ({ categories: [] }),
  getMonthlyTip: async () => ({
    title: 'Summer Survival Mode',
    tip: 'Your lawn is stressed. Water deeply but less frequently. Mow high (4+ inches). Brown spots during extreme heat are normal summer dormancy for St. Augustine.',
    month: new Date().toLocaleString('en-US', { month: 'long' }),
  }),

  // tracking
  getActiveTracker: async () => ({ tracker: null }),
  getTodayTracker: async () => ({ tracker: null }),

  // misc / catch-alls — PortalPage also calls api.request directly
  // ('/tracking/maps-key', '/ai/chat', AuthProvider's '/auth/logout').
  request: async (path) => {
    if (String(path).startsWith('/tracking/maps-key')) return { key: '' };
    return {};
  },
  fetchRaw: async () => ({ ok: false, status: 404, blob: async () => new Blob(), text: async () => '' }),
  deleteAccount: async () => ({ success: true }),
  getBadges: async () => ({ badges: [] }),
  notifyBadge: async () => ({ success: true }),
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <AuthProvider>
      <PortalPage />
    </AuthProvider>
  </BrowserRouter>,
);
