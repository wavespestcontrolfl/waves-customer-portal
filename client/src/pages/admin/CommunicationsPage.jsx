// client/src/pages/admin/CommunicationsPage.jsx
//
// Shared-utility module for the V2 admin Communications surface. The V1
// page component was deleted in the V1→V2 migration; this file is
// retained only for named exports consumed by CommunicationsPageV2 and
// CallLogTabV2:
//   - ALL_NUMBERS               (the four Twilio business numbers)
//   - NUMBER_LABEL_MAP          (number → "Bradenton" / "Sarasota" etc)
//   - call disposition constants (legacy named exports, kept for any
//                                  future consumer)
//
// Endpoints these helpers are wired against (kept in sync with V2):
//   GET   /admin/communications/log
//   GET   /admin/communications/stats
//   POST  /admin/communications/sms
//   GET/POST /admin/communications/ai-auto-reply{,-status}
//   POST  /admin/communications/ai-draft
//   GET   /admin/communications/blocked-numbers, POST/DELETE
//   POST  /admin/communications/schedule-sms, GET, DELETE
//   POST  /admin/communications/attach (multipart)
//
// Audit focus:
// - Reusable exports: any change here also affects V2. ALL_NUMBERS /
//   NUMBER_LABEL_MAP / disposition constants are the public API
//   surface; touching them is a coordinated change.
// - Blocked-number list management: POST/DELETE need explicit
//   confirmation gates (un-blocking spam = customer harm if wrong).
// - SMS scheduling queue: a scheduled SMS that fires after the
//   customer has texted STOP — is the scheduled send cancelled, or
//   does it ship anyway and create a compliance issue?
// - Attach endpoint (POST /attach): multipart upload then sms POST.
//   Confirm partial upload failure cancels the send (no half-sent
//   MMS with broken media URL).
import { useState, useEffect, useCallback, useMemo, useRef } from "react";

import CallRecordingsPanel from "./CallRecordingsPanel";
import AuthenticatedCallAudio from "../../components/admin/AuthenticatedCallAudio";
import PushSettings from "../../components/admin/PushSettings";
import { TECH_LINE_NUMBERS } from "../../constants/techLines";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const D = {
  bg: "#F1F5F9",
  card: "#FFFFFF",
  border: "#E2E8F0",
  teal: "#0A7EC2",
  green: "#16A34A",
  amber: "#F0A500",
  red: "#C0392B",
  text: "#334155",
  muted: "#64748B",
  white: "#FFFFFF",
  heading: "#0F172A",
  inputBorder: "#CBD5E1",
};
const isMobile = typeof window !== "undefined" && window.innerWidth < 640;

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then(async (r) => {
    if (!r.ok) {
      // Surface the server's reason (e.g. 409 CUSTOMER_NUMBER names the
      // customer) instead of a bare status code.
      const body = await r.json().catch(() => null);
      // 409 CUSTOMER_NUMBER names the matched record — keep it in the
      // message so the operator knows WHICH customer to review.
      let message = (body && body.error) || `HTTP ${r.status}`;
      if (body && body.customer_name) message += ` (${body.customer_name})`;
      const err = new Error(message);
      err.status = r.status;
      err.code = body && body.code;
      err.customerId = body && body.customer_id;
      throw err;
    }
    return r.json();
  });
}

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const mins = Math.floor((Date.now() - d) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}


const TEMPLATES = [
  {
    label: "Service reminder",
    body: "Hi! This is Waves Pest Control. Just a reminder that your service is scheduled for tomorrow. Reply CONFIRM to confirm or call us to reschedule.",
  },
  {
    label: "Running late",
    body: "Hi! This is Waves Pest Control. Our technician is running a bit behind schedule. We estimate arrival in about 15-20 minutes. Sorry for the delay!",
  },
  {
    label: "Review request",
    body: "Thanks for choosing Waves Pest Control! We'd love your feedback. Please leave us a quick review: [LINK]",
  },
  {
    label: "Confirm scheduling",
    body: "Hi {name}, your service is scheduled for {date}. Reply CONFIRM.",
  },
  {
    label: "Service complete",
    body: "All done! Your report is in your portal.",
  },
  {
    label: "Follow-up",
    body: "Following up on your request. Adam will address this at your next visit.",
  },
  {
    label: "Quick acknowledge",
    body: "We received your message and will respond within 1 hour.",
  },
];

const ALL_NUMBERS = [
  {
    group: "GBP Locations",
    numbers: [
      {
        number: "+19412975749",
        formatted: "(941) 297-5749",
        label: "wavespestcontrol.com (main)",
      },
      {
        number: "+19413187612",
        formatted: "(941) 318-7612",
        label: "Waves Pest Control Lakewood Ranch",
      },
      {
        number: "+19412972606",
        formatted: "(941) 297-2606",
        label: "Waves Pest Control Sarasota",
      },
      {
        number: "+19412973337",
        formatted: "(941) 297-3337",
        label: "Waves Pest Control Venice",
      },
      {
        number: "+19412972817",
        formatted: "(941) 297-2817",
        label: "Waves Pest Control Parrish",
      },
    ],
  },
  {
    group: "Pest Control Domains",
    numbers: [
      {
        number: "+19412838194",
        formatted: "(941) 283-8194",
        label: "bradentonflexterminator.com",
      },
      {
        number: "+19413265011",
        formatted: "(941) 326-5011",
        label: "bradentonflpestcontrol.com",
      },
      {
        number: "+19412972671",
        formatted: "(941) 297-2671",
        label: "sarasotaflpestcontrol.com",
      },
      {
        number: "+19412135203",
        formatted: "(941) 213-5203",
        label: "palmettoexterminator.com",
      },
      {
        number: "+19412943355",
        formatted: "(941) 294-3355",
        label: "palmettoflpestcontrol.com",
      },
      {
        number: "+19419098995",
        formatted: "(941) 909-8995",
        label: "parrishexterminator.com",
      },
      {
        number: "+19412535279",
        formatted: "(941) 253-5279",
        label: "parrishpestcontrol.com",
      },
      {
        number: "+19413187765",
        formatted: "(941) 318-7765",
        label: "sarasotaflexterminator.com",
      },
      {
        number: "+19412998937",
        formatted: "(941) 299-8937",
        label: "veniceexterminator.com",
      },
      {
        number: "+19412411388",
        formatted: "(941) 241-1388",
        label: "veniceflpestcontrol.com",
      },
      {
        number: "+19412589109",
        formatted: "(941) 258-9109",
        label: "northportflpestcontrol.com",
      },
      {
        number: "+19412402066",
        formatted: "(941) 240-2066",
        label: "wavespestcontrol.com/north-port",
      },
    ],
  },
  {
    group: "Paid Campaigns",
    numbers: [
      {
        number: "+19412691697",
        formatted: "(941) 269-1697",
        label: "Google Ads — Pest",
      },
      {
        number: "+19418775491",
        formatted: "(941) 877-5491",
        label: "Facebook Ads — Pest",
      },
    ],
  },
  {
    group: "Lawn Care Domains",
    numbers: [
      {
        number: "+19413041850",
        formatted: "(941) 304-1850",
        label: "bradentonfllawncare.com",
      },
      {
        number: "+19412691692",
        formatted: "(941) 269-1692",
        label: "sarasotafllawncare.com",
      },
      {
        number: "+19412077456",
        formatted: "(941) 207-7456",
        label: "parrishfllawncare.com",
      },
      {
        number: "+19414131227",
        formatted: "(941) 413-1227",
        label: "venicelawncare.com",
      },
      {
        number: "+19412413824",
        formatted: "(941) 241-3824",
        label: "waveslawncare.com",
      },
    ],
  },
  {
    group: "Operations",
    numbers: [
      {
        number: "+18559260203",
        formatted: "(855) 926-0203",
        label: "AI Agent",
      },
      {
        number: "+19412412459",
        formatted: "(941) 241-2459",
        label: "Waves Van",
      },
    ],
  },
  {
    // Per-tech lines — one shared list with the Team tab picker.
    group: "Tech Lines",
    numbers: TECH_LINE_NUMBERS,
  },
];

// Flat lookup: number ->label
const NUMBER_LABEL_MAP = {};
ALL_NUMBERS.forEach((g) =>
  g.numbers.forEach((n) => {
    NUMBER_LABEL_MAP[n.number] = n.label;
  }),
);


const CALL_DISPOSITIONS = [
  { value: "", label: "Tag call..." },
  { value: "new_lead_booked", label: "New lead — booked" },
  { value: "new_lead_no_booking", label: "New lead — no booking" },
  { value: "existing_service_q", label: "Existing — service Q" },
  { value: "existing_complaint", label: "Existing — complaint" },
  { value: "spam", label: "Spam / wrong number" },
];



// =========================================================================
// MAIN COMMUNICATIONS PAGE
// =========================================================================

// Named exports for V2 reuse
export {
  ALL_NUMBERS,
  TEMPLATES,
  CALL_DISPOSITIONS,
  NUMBER_LABEL_MAP,
};
