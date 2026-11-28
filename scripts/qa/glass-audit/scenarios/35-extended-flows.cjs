'use strict';
// Extended public customer SPA flows added to close Glass audit scenario coverage gaps:
//   /moving/:token                  MovingPage.jsx
//   /h/:token                       MailHomePage.jsx
//   /careers/interview/:token       CareersInterviewPage.jsx
//   /visit/:token                   VisitSummaryPage.jsx
//   /inspection/:token              ScheduleFlowPage.jsx (flow="inspection")
//   /estimate/:token/assessment     ScheduleFlowPage.jsx (flow="assessment")

const { addETDays, etDateString } = require('../../../../server/utils/datetime-et');

const MOVE_TOKEN = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081'; // 48 hex
const MAIL_HOME_TOKEN = '2233445566778899aabbccddeeff0011'; // 32 hex
const INTERVIEW_TOKEN = '33445566778899aabbccddeeff00112233445566778899aabbccddeeff001122'; // 64 hex
const VISIT_TOKEN = '445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233'; // 64 hex
const INSPECT_TOKEN = '5566778899aabbccddeeff00112233445566778899aabbccddeeff0011223344'; // 64 hex
const ASSESS_TOKEN = '66778899aabbccddeeff00112233445566778899aabbccddeeff001122334455'; // 64 hex
const REPORT_TOKEN_A = '778899aabbccddeeff00112233445566';
const REPORT_TOKEN_B = '8899aabbccddeeff0011223344556677';

const ok = (body) => ({ status: 200, body });
const serverError = () => ({ status: 500, body: { error: 'glass-audit: simulated outage' } });

const ymdOut = (days) => etDateString(addETDays(new Date(), days));
const fullDateOf = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', {
  weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
});
const shortDateOf = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', {
  weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
}).replace(/,/g, '');

const DAY1 = ymdOut(3);
const DAY2 = ymdOut(4);

const AVAILABILITY = {
  days: [
    {
      date: DAY1,
      fullDate: fullDateOf(DAY1),
      nearby: true,
      rainChance: 15,
      slots: [
        { date: DAY1, start_time: '09:00', end_time: '10:00', start_label: '9:00 AM', end_label: '10:00 AM', technician_id: 'tech-preview', nearby: true, rank: 1 },
        { date: DAY1, start_time: '13:00', end_time: '14:00', start_label: '1:00 PM', end_label: '2:00 PM', technician_id: 'tech-preview', nearby: false, rank: 2 },
      ],
    },
    {
      date: DAY2,
      fullDate: fullDateOf(DAY2),
      nearby: false,
      rainChance: 20,
      slots: [
        { date: DAY2, start_time: '10:00', end_time: '11:00', start_label: '10:00 AM', end_label: '11:00 AM', technician_id: 'tech-preview', nearby: false, rank: 1 },
      ],
    },
  ],
};

const LEAD_FIXTURE = {
  first_name: 'Jordan',
  phone_masked: '(941) 555-0100',
  address_display: '1200 Sample Lane, Venice, FL 34285',
  has_address: true,
};

module.exports = [
  {
    id: 'moving',
    family: 'flow',
    surface: 'customer',
    role: 'public token',
    route: '/moving/:token',
    url: `/moving/${MOVE_TOKEN}`,
    ready: 'Moving, Jordan?',
    settle: 900,
    handle: ({ method, path }) => (method === 'GET' && path === `/api/public/moving/${MOVE_TOKEN}` ? ok({
      firstName: 'Jordan',
      services: ['Quarterly Pest Control'],
      status: 'pending',
      moveOutDate: ymdOut(14),
      moveInDate: ymdOut(21),
      newCity: null,
      verdict: null,
      addressOnFile: false,
    }) : null),
    states: [
      { name: 'default' },
      { name: 'error', ready: 'load that page', handle: () => serverError() },
    ],
  },
  {
    id: 'mail-home',
    family: 'flow',
    surface: 'customer',
    role: 'public token',
    route: '/h/:token',
    url: `/h/${MAIL_HOME_TOKEN}`,
    ready: 'Welcome to your new home',
    settle: 900,
    handle: ({ method, path }) => {
      if (method === 'GET' && path === `/api/public/home/${MAIL_HOME_TOKEN}`) {
        return ok({
          address: { line1: '1200 SAMPLE LN', city: 'VENICE', zip: '34285' },
          price: { monthly: 37, annual: 444, setupFee: 99 },
          plan: 'pest_quarterly',
        });
      }
      if (method === 'GET' && path === `/api/public/home/${MAIL_HOME_TOKEN}/times`) {
        return ok({
          offers: [
            { date: DAY1, start_time: '09:00', slot_sig: 'sig-1' },
            { date: DAY1, start_time: '13:00', slot_sig: 'sig-2' },
            { date: DAY2, start_time: '10:00', slot_sig: 'sig-3' },
          ],
        });
      }
      return null;
    },
    states: [
      { name: 'default' },
      { name: 'error', ready: 'This page is not available', handle: () => serverError() },
    ],
  },
  {
    id: 'careers-interview',
    family: 'flow',
    surface: 'customer',
    role: 'public token',
    route: '/careers/interview/:token',
    url: `/careers/interview/${INTERVIEW_TOKEN}`,
    ready: 'Confirm interview time',
    settle: 900,
    sheet: { sheetH1Min: 26 },
    handle: ({ method, path }) => (method === 'GET' && path === `/api/public/careers/interview/${INTERVIEW_TOKEN}` ? ok({
      first_name: 'Jordan',
      language: 'en',
      status: 'open',
      mode_options: ['phone', 'in_person'],
      in_person_address: '13649 Luxe Ave #110, Bradenton, FL 34211',
      timezone: 'America/New_York',
      booked: null,
      slots: [
        { date: DAY1, start: `${DAY1}T14:00:00Z`, end: `${DAY1}T14:30:00Z`, label: `${shortDateOf(DAY1)}, 10:00 AM` },
        { date: DAY1, start: `${DAY1}T15:00:00Z`, end: `${DAY1}T15:30:00Z`, label: `${shortDateOf(DAY1)}, 11:00 AM` },
      ],
    }) : null),
    states: [
      { name: 'default' },
      { name: 'error', ready: 'interview link', handle: () => serverError() },
    ],
  },
  {
    id: 'visit-summary',
    family: 'document-report',
    surface: 'customer',
    role: 'public token',
    route: '/visit/:token',
    url: `/visit/${VISIT_TOKEN}`,
    ready: 'Your visit summary',
    settle: 900,
    handle: ({ method, path }) => (method === 'GET' && path === `/api/visit-summary/${VISIT_TOKEN}` ? ok({
      serviceDate: ymdOut(-1),
      services: [
        { id: 1, serviceType: 'Quarterly Pest Control', outcome: 'completed', reportUrl: `/report/${REPORT_TOKEN_A}` },
        { id: 2, serviceType: 'Lawn Care Program', outcome: 'completed', reportUrl: `/report/${REPORT_TOKEN_B}` },
      ],
    }) : null),
    states: [
      { name: 'default' },
      { name: 'error', ready: 'visit summary', handle: () => serverError() },
    ],
  },
  {
    id: 'inspection',
    family: 'flow',
    surface: 'customer',
    role: 'public token',
    route: '/inspection/:token',
    url: `/inspection/${INSPECT_TOKEN}`,
    ready: 'Free consultation',
    settle: 900,
    sheet: { sheetH1Min: 30 },
    handle: ({ method, path }) => (method === 'GET' && path === `/api/public/inspection/${INSPECT_TOKEN}` ? ok({
      state: 'ok',
      lead: LEAD_FIXTURE,
      availability: AVAILABILITY,
      needs_address: false,
      selfServeNotice: true,
      durationMinutes: 30,
    }) : null),
    states: [
      { name: 'default' },
      { name: 'error', ready: 'consultation options', handle: () => serverError() },
    ],
  },
  {
    id: 'assessment',
    family: 'flow',
    surface: 'customer',
    role: 'public token',
    route: '/estimate/:token/assessment',
    url: `/estimate/${ASSESS_TOKEN}/assessment`,
    ready: 'Free Waves Assessment',
    settle: 900,
    sheet: { sheetH1Min: 30 },
    handle: ({ method, path }) => (method === 'GET' && path === `/api/public/estimate-assessment/${ASSESS_TOKEN}` ? ok({
      state: 'ok',
      lead: LEAD_FIXTURE,
      availability: AVAILABILITY,
      needs_address: false,
      selfServeNotice: true,
      durationMinutes: 30,
    }) : null),
    states: [
      { name: 'default' },
      { name: 'error', ready: 'assessment times', handle: () => serverError() },
    ],
  },
];
