import { useEffect, useState, useCallback, useRef } from "react";
import { BookOpen, Calendar, ClipboardList, Mail, Plus } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { Badge, Button, Dialog, DialogBody, DialogFooter, Select } from "../../components/ui";
import { adminFetch } from "../../lib/adminFetch";
import CreateProjectModal from "../../components/tech/CreateProjectModal";
import WdoIntelligenceBar from "../../components/tech/WdoIntelligenceBar";
import WdoSignaturePad from "../../components/tech/WdoSignaturePad";
import useIsMobile from "../../hooks/useIsMobile";
import { applyProfileToWdoFindings, applyHistoryToWdoFindings } from "../../lib/wdoProfileToFindings";
import {
  INTERNAL_FINDING_KEYS,
  redactInspectionFeeCues,
  redactSpecificAmounts,
  resolveFeeValuesForScrub,
} from "../../lib/wdoReportFields";
import ProjectFindingFieldInput, {
  hasCatalogBackedProjectFields,
  normalizeApplicationRows,
} from "../../components/tech/ProjectFindingFieldInput";
import { parseSections, TERMITE_COMPLIANCE_SECTIONS } from "../ProjectReportViewPage";


/**
 * Projects — post-service inspection / documentation reports.
 *
 * Tier 2 light zinc palette. Techs create drafts from /tech; admin reviews,
 * edits findings, manages optional photos, and presses Send to generate the
 * customer-facing /report/project/:token link.
 */


const MONO = "'JetBrains Mono', monospace";

// C2 restyle: native confirm()/prompt() replaced with the shared Dialog
// primitives. ask(message) resolves true/false; ask(message, { input:
// "<placeholder>" }) renders a required text field and resolves the entered
// string, or null on cancel. Messages keep their \n structure (pre-line).
function useConfirmDialog() {
  const [pending, setPending] = useState(null);
  const [inputValue, setInputValue] = useState("");
  // The resolver lives in a ref and the close handler is stable —
  // Dialog's focus effect is keyed on onClose, so an inline handler that
  // changes identity per keystroke would refocus the panel and blur the
  // prompt input on every character (Codex P2).
  const pendingRef = useRef(null);
  const ask = useCallback(
    (message, opts = {}) =>
      new Promise((resolve) => {
        setInputValue("");
        pendingRef.current = { message, ...opts, resolve };
        setPending(pendingRef.current);
      }),
    [],
  );
  const settle = useCallback((result) => {
    if (pendingRef.current) pendingRef.current.resolve(result);
    pendingRef.current = null;
    setPending(null);
  }, []);
  const handleCancel = useCallback(() => {
    settle(pendingRef.current && pendingRef.current.input ? null : false);
  }, [settle]);
  // Dialog focuses its panel via setTimeout on open — an autoFocus attribute
  // loses that race, so the prompt input claims focus just after it.
  const inputRef = useRef(null);
  useEffect(() => {
    if (!pending || !pending.input) return undefined;
    const t = setTimeout(() => inputRef.current && inputRef.current.focus(), 50);
    return () => clearTimeout(t);
  }, [pending]);
  const element = pending ? (
    <Dialog open size="sm" onClose={handleCancel}>
      <DialogBody>
        <div style={{ fontSize: 14, color: "#27272A", whiteSpace: "pre-line", lineHeight: 1.5 }}>
          {pending.message}
        </div>
        {pending.input && (
          <input
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={pending.input}
            style={{ ...inputStyle, marginTop: 12 }}
          />
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={handleCancel}>
          Cancel
        </Button>
        <Button
          onClick={() => settle(pending.input ? inputValue.trim() : true)}
          disabled={pending.input ? !inputValue.trim() : false}
        >
          {pending.confirmLabel || "Confirm"}
        </Button>
      </DialogFooter>
    </Dialog>
  ) : null;
  return [ask, element];
}

// C1/C2 restyle: the detail pane's chrome constants now carry the V2 zinc
// ramp (whites/greys/black — owner direction). Names kept so the ~200
// consumer sites need no churn; the embedded CustomerProjectReportPreview
// deliberately does NOT read these — it mimics the customer-facing report.
const ESTIMATE_BG = "#FFFFFF";
const ESTIMATE_BORDER = "#E4E4E7";
const ESTIMATE_INPUT_BORDER = "#D4D4D8";
const ESTIMATE_INPUT_BG = "#FFFFFF";
const ESTIMATE_TEXT = "#18181B";
const ESTIMATE_MUTED = "#71717A";

// Status pills ride the shared Badge on the zinc ramp — sent is the "done"
// state (strong), draft/closed stay neutral; alert-fg is reserved for
// genuine alerts (stale WDO drafts, send blockers), never status decoration.
const STATUS_STYLES = {
  draft: { tone: "neutral", label: "Draft" },
  sent: { tone: "strong", label: "Sent" },
  closed: { tone: "neutral", label: "Closed" },
};

const TYPE_LABELS = {
  wdo_inspection: "WDO",
  termite_inspection: "Termite",
  termite_treatment: "Termite Treatment",
  pest_inspection: "Pest",
  one_time_pest_treatment: "One-Time Pest",
  one_time_lawn_treatment: "One-Time Lawn",
  flea: "Flea",
  cockroach: "Cockroach",
  rodent_exclusion: "Rodent",
  rodent_trapping: "Rodent Trap",
  wildlife_trapping: "Wildlife",
  mosquito_event: "Mosquito Event",
  palm_injection: "Palm Injection",
  bed_bug: "Bed Bug",
  pre_treatment_termite_certificate: "Pre-Treat Cert",
};
const WDO_TYPE = "wdo_inspection";
const CERTIFICATE_TYPE = "pre_treatment_termite_certificate";
const GENERAL_TYPE_LABELS = Object.fromEntries(
  Object.entries(TYPE_LABELS).filter(([key]) => key !== WDO_TYPE),
);
const GENERAL_PROJECT_TYPES = Object.keys(GENERAL_TYPE_LABELS);
const PROJECT_TYPES_WITH_PREP_GUIDES = new Set([
  "termite_inspection",
  "termite_treatment",
  "pest_inspection",
  "one_time_pest_treatment",
  "one_time_lawn_treatment",
  "flea",
  "cockroach",
  "rodent_exclusion",
  "rodent_trapping",
  "mosquito_event",
  "pre_treatment_termite_certificate",
]);
const BOOK_URL = "https://www.wavespestcontrol.com/book/";
const REQUIRED_RECOMMENDATION_SECTION_HEADINGS = [
  "WHAT WE INSPECTED",
  "WHAT WE FOUND",
  "WHAT WE RECOMMEND",
];
const RECOMMENDATION_SECTION_HEADINGS = [
  "CUSTOMER CONCERN",
  "WHAT WE INSPECTED",
  "WHAT WE FOUND",
  "WHAT WE DID",
  "WHAT WE RECOMMEND",
];
const TECHNICAL_SNIPPETS = [
  {
    label: "Moisture risk",
    text: "Moisture should be corrected because elevated moisture can support wood decay and create conditions that are more favorable for wood-destroying organisms.",
  },
  {
    label: "Wood rot",
    text: "Visible wood rot should be repaired after the moisture source is corrected so damaged material does not continue to deteriorate.",
  },
  {
    label: "Termite treatment",
    text: "A targeted termite treatment is recommended in the affected areas to address documented activity or conducive conditions while limiting unnecessary application elsewhere.",
  },
  {
    label: "Rodent entry",
    text: "Entry points should be sealed with durable materials after active trapping pressure is reduced, so rodents are not locked inside and future access is limited.",
  },
  {
    label: "Sanitation",
    text: "Reducing food, water, and harborage sources will improve treatment performance and help prevent pest pressure from rebuilding between services.",
  },
];

function getAdminRole() {
  try {
    return (
      JSON.parse(localStorage.getItem("waves_admin_user") || "{}")?.role || null
    );
  } catch {
    return null;
  }
}

function mergeProjectsUnique(...lists) {
  const byId = new Map();
  lists.flat().forEach((p) => {
    if (p?.id && !byId.has(p.id)) byId.set(p.id, p);
  });
  return Array.from(byId.values());
}

function fmtDate(d) {
  if (!d) return "—";
  const raw = String(d);
  const dateOnly = dateOnlyValue(raw);
  const date = dateOnly ? new Date(`${dateOnly}T12:00:00`) : new Date(raw);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

function formatProjectAppointmentDate(value) {
  if (!value) return "";
  const raw = String(value);
  const dateOnly = dateOnlyValue(raw);
  const date = dateOnly ? new Date(`${dateOnly}T12:00:00`) : new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

function formatProjectAppointmentTime(value) {
  if (!value) return "";
  const raw = String(value).trim();
  const match = /^(\d{1,2}):(\d{2})/.exec(raw);
  if (!match) return raw;
  const hour24 = Number(match[1]);
  const minute = match[2];
  const hour12 = hour24 % 12 || 12;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  return `${hour12}:${minute} ${suffix}`;
}

// The customer promise is ALWAYS windowStart + 2 hours — window_end is the
// internal job-duration estimate and never customer-facing. The public
// report page renders start+2h, so the staff preview must too.
function projectAppointmentWindowEnd(windowStart) {
  const raw = String(windowStart || "").trim();
  const match = /^(\d{1,2}):(\d{2})/.exec(raw);
  if (!match) return "";
  const hour24 = (Number(match[1]) + 2) % 24;
  return `${hour24}:${match[2]}`;
}

function formatProjectAppointmentWindow(appt) {
  if (!appt) return "";
  const date = formatProjectAppointmentDate(appt.scheduledDate);
  const start = formatProjectAppointmentTime(appt.windowStart);
  const end = formatProjectAppointmentTime(projectAppointmentWindowEnd(appt.windowStart));
  const window = start && end ? `${start}-${end}` : start || end;
  return [date, window].filter(Boolean).join(" ");
}

function dateInputValue(d) {
  if (!d) return "";
  const raw = String(d);
  const dateOnly = dateOnlyValue(raw);
  if (dateOnly) return dateOnly;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function dateOnlyValue(raw) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(raw))
    return raw.slice(0, 10);
  return "";
}

function hasMeaningfulValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function formatProjectCustomerAddress(project) {
  const line1 = project?.address_line1 || "";
  const city = project?.city || "";
  const state = project?.state || "";
  const zip = project?.zip || "";
  return [line1, [city, state].filter(Boolean).join(", "), zip]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeWdoSuggestions(current, suggestions, overwrite = false) {
  const allowed = [
    "property_address",
    "structures_inspected",
    "structure_type",
    "inspection_scope",
    "previous_treatment_evidence",
    "previous_treatment_notes",
  ];
  const next = { ...current };
  for (const key of allowed) {
    const value = suggestions?.[key];
    if (!hasMeaningfulValue(value)) continue;
    if (overwrite || !hasMeaningfulValue(next[key])) next[key] = value;
  }
  return next;
}

async function readJsonResponse(response, fallbackMessage) {
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const err = new Error(
      payload?.error ||
        fallbackMessage ||
        `Request failed (${response.status})`,
    );
    err.status = response.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

function money(value) {
  const amount = Number(value || 0);
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
  });
}

function closeoutBillingLabel(billing = {}) {
  if (!billing.required) return "No billing hold";
  if (billing.resolved) {
    if (billing.reason === "prepaid_covered") return `Prepaid covers ${money(billing.amount)}`;
    if (billing.invoiceId) return `Invoice ready ${money(billing.amount)}`;
    return `Billing resolved ${money(billing.amount)}`;
  }
  return `Billing required ${money(billing.amount)}`;
}

function closeoutFollowupLabel(followup = {}) {
  if (!followup.required) return "No follow-up automation";
  if (followup.unsupported || followup.reason === "auto_schedule_not_implemented") {
    return "Auto-schedule not available";
  }
  if (followup.suggestedDate && followup.days != null) {
    return `Alert for ${fmtDate(followup.suggestedDate)} (${followup.days} days)`;
  }
  return "Follow-up alert will be created";
}

function deliverySummary(channels = {}) {
  const entries = Object.entries(channels);
  if (!entries.length) return "";
  return entries
    .map(
      ([name, result]) =>
        `${name.toUpperCase()}: ${result?.ok ? "sent" : result?.error || "failed"}`,
    )
    .join(" · ");
}

// Per-application completeness checks for the pre-treatment certificate.
// Runs once over the flat primary-application keys (labelPrefix "") and once
// per additional_applications row — mirror of the server gate in
// server/routes/admin-projects.js.
function certApplicationChecks(app = {}, labelPrefix = "") {
  const productName = app.product_name === "Other"
    ? app.product_name_other
    : app.product_name;
  const rawMethod = app.treatment_method;
  const treatmentMethod = rawMethod === "Other"
    ? app.treatment_method_other
    : rawMethod;
  // Method-aware coverage requirements — bait systems have no gallons, borate
  // wood treatments may not either.
  const isBaitSystem = rawMethod === "Bait system";
  const isWoodTreatment = rawMethod === "Wood treatment (borate)";
  const needsGallons = !isBaitSystem && !isWoodTreatment;
  // A finished-solution concentration only exists for liquid soil barriers
  // — same rule as the server gate.
  const needsConcentration = needsGallons;
  const hasArea =
    hasMeaningfulValue(app.square_footage) ||
    hasMeaningfulValue(app.linear_feet);
  const coverageOk = needsGallons
    ? hasArea && hasMeaningfulValue(app.gallons_applied)
    : hasArea;
  const coverageLabel = needsGallons
    ? "Coverage + gallons applied"
    : "Coverage (sq ft or linear ft)";
  return [
    {
      label: `${labelPrefix}Method of treatment`,
      ok: hasMeaningfulValue(treatmentMethod),
    },
    {
      label: `${labelPrefix}Product used`,
      ok: hasMeaningfulValue(productName),
    },
    {
      label: `${labelPrefix}${
        needsConcentration
          ? "Active ingredient + concentration"
          : "Active ingredient"
      }`,
      ok:
        hasMeaningfulValue(app.active_ingredient) &&
        (!needsConcentration || hasMeaningfulValue(app.concentration_pct)),
    },
    {
      label: `${labelPrefix}${coverageLabel}`,
      ok: coverageOk,
    },
  ];
}

// Rows the tech added but never touched are ignored (matching the server
// gate and the certificate render) — only rows with content must be complete.
function meaningfulApplicationRows(findings) {
  return normalizeApplicationRows(findings?.additional_applications).filter(
    (row) => Object.values(row).some(hasMeaningfulValue),
  );
}

function evaluateProjectReadiness({
  project,
  typeCfg,
  findings,
  recommendations,
  projectDate,
}) {
  const isCertificate = project?.project_type === CERTIFICATE_TYPE;
  const required = [
    { label: isCertificate ? "Treatment date" : "Inspection date", ok: hasMeaningfulValue(projectDate) },
    { label: "Customer", ok: hasMeaningfulValue(project?.customer_name) },
    {
      label: "Report title or type",
      ok:
        hasMeaningfulValue(project?.title) ||
        hasMeaningfulValue(typeCfg?.label),
    },
    {
      label: "Findings captured",
      ok: Object.values(findings || {}).some(hasMeaningfulValue),
    },
  ];
  if (project?.project_type === WDO_TYPE) {
    required.push(
      {
        label: "Property inspected",
        ok: hasMeaningfulValue(findings?.property_address),
      },
      {
        label: "FDACS finding selected",
        ok: hasMeaningfulValue(findings?.wdo_finding),
      },
      {
        label: "Visible/access scope",
        ok: hasMeaningfulValue(findings?.inspection_scope),
      },
    );
  }
  // Termite Phase-3 compliance content — mirrors the server's
  // evaluateProjectSendReadiness (Codex P2 r3 on #2703) so the readiness
  // panel names the missing statutory fields instead of showing "ready"
  // and then failing with a generic 422 on send. Method lists mirror
  // TERMITE_PERIMETER_METHODS / TERMITE_LIQUID_DILUTION_METHODS in
  // project-types.js.
  // hard: true mirrors the server's non-overridable hardMissing gate — the
  // send flows must NOT offer the override path for these (Codex P3 r4).
  if (project?.project_type === "termite_inspection") {
    required.push(
      {
        label: 'Areas not inspected / why ("None" if all visible areas were inspected)',
        ok: hasMeaningfulValue(findings?.areas_not_inspected),
        hard: true,
      },
      {
        label: 'Inspection notice affixed ("Yes" required)',
        ok: String(findings?.inspection_notice_affixed || "") === "Yes",
        hard: true,
      },
    );
  }
  if (project?.project_type === "termite_treatment") {
    const method = String(findings?.treatment_method || "");
    const isPerimeter = ["Liquid perimeter", "Trenching"].includes(method);
    required.push(
      { label: "Treatment method", ok: hasMeaningfulValue(method), hard: true },
      { label: "EPA reg. no.", ok: hasMeaningfulValue(findings?.epa_registration), hard: true },
      {
        label: isPerimeter
          ? 'Posted notice placed ("Yes" required for exterior/perimeter applications)'
          : "Posted notice placed",
        ok: isPerimeter
          ? String(findings?.posted_notice || "") === "Yes"
          : hasMeaningfulValue(findings?.posted_notice),
        hard: true,
      },
    );
    if (["Spot treatment", "Liquid perimeter", "Trenching", "Wood treatment"].includes(method)) {
      required.push({
        label: "% solution",
        ok: hasMeaningfulValue(findings?.percent_solution),
        hard: true,
      });
    }
  }
  if (isCertificate) {
    required.push(
      {
        label: "Treatment address or lot/block",
        ok:
          hasMeaningfulValue(findings?.treatment_address) ||
          hasMeaningfulValue(findings?.lot_block),
      },
      {
        label: "Date of treatment",
        ok:
          hasMeaningfulValue(findings?.treatment_date) ||
          hasMeaningfulValue(projectDate),
      },
      ...certApplicationChecks(findings || {}),
      // Each additional application carries its own product record, so each
      // must be as complete as the primary before the certificate can send.
      ...meaningfulApplicationRows(findings).flatMap((row, index) =>
        certApplicationChecks(row, `Application ${index + 2}: `),
      ),
      {
        label: "Applicator's printed name",
        ok: hasMeaningfulValue(findings?.applicator_name),
      },
      {
        label: "Applicator FDACS ID #",
        ok: hasMeaningfulValue(findings?.applicator_fdacs_id),
      },
      {
        label: "Applicator attestation",
        ok: hasMeaningfulValue(findings?.applicator_attestation),
      },
    );
  }

  const text = [recommendations, ...Object.values(findings || {})]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const quality = [];
  if (
    /\b(termite|roach|ant|rodent|mouse|rat|bed bug|wdo)\b/.test(text) &&
    !/\b(kitchen|bath|attic|garage|eave|exterior|interior|bedroom|crawlspace|foundation|wall|ceiling|floor|window|door)\b/.test(
      text,
    )
  ) {
    quality.push("Pest or WDO activity is mentioned without a clear location.");
  }
  if (
    /\b(eliminate|eradicate|guarantee|100%|pest-free|impenetrable)\b/.test(text)
  ) {
    quality.push(
      "Avoid overpromising language such as guarantee, eradicate, eliminate, or pest-free.",
    );
  }

  return {
    required,
    missing: required.filter((item) => !item.ok),
    // Mirrors the server's hardMissing — compliance blockers the send
    // routes 422 on regardless of override_reason.
    hardMissing: required.filter((item) => !item.ok && item.hard),
    quality,
  };
}

function humanizeProjectKey(key) {
  return String(key || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function projectFieldLabel(typeCfg, key) {
  const field = typeCfg?.findingsFields?.find((f) => f.key === key);
  return field?.label || humanizeProjectKey(key);
}

function formatProjectPreviewValue(value) {
  if (Array.isArray(value)) {
    // Arrays of objects (certificate application rows) format each row on
    // its own line; the preview block renders pre-wrap.
    return value
      .map((item) => formatProjectPreviewValue(item))
      .filter((item) => hasMeaningfulValue(item))
      .join("\n");
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, v]) => hasMeaningfulValue(v))
      .map(([k, v]) => `${humanizeProjectKey(k)}: ${String(v)}`)
      .join("; ");
  }
  return String(value || "");
}

function customerAddressLine(project) {
  return [project?.city, project?.state].filter(Boolean).join(", ");
}

function parseProjectRecommendationSections(text) {
  const value = String(text || "");
  const hasAll = REQUIRED_RECOMMENDATION_SECTION_HEADINGS.every((heading) =>
    value.includes(heading),
  );
  if (!hasAll) return null;

  const sections = [];
  const headingPattern = new RegExp(
    `^(${RECOMMENDATION_SECTION_HEADINGS.join("|")})\\s*$`,
    "gm",
  );
  const indices = [];
  let match;
  while ((match = headingPattern.exec(value)) !== null) {
    indices.push({
      heading: match[1],
      start: match.index,
      contentStart: match.index + match[0].length,
    });
  }

  for (let i = 0; i < indices.length; i += 1) {
    const end = i + 1 < indices.length ? indices[i + 1].start : value.length;
    const body = value.slice(indices[i].contentStart, end).trim();
    if (body) sections.push({ heading: indices[i].heading, body });
  }

  const foundRequired = REQUIRED_RECOMMENDATION_SECTION_HEADINGS.every((heading) =>
    sections.some((section) => section.heading === heading),
  );
  return foundRequired ? sections : null;
}

function titleCaseProjectSection(text) {
  return String(text || "")
    .split(" ")
    .map((word) => word[0] + word.slice(1).toLowerCase())
    .join(" ");
}

function includesProjectTextAny(text, words) {
  const value = String(text || "").toLowerCase();
  return words.some((word) => value.includes(word));
}

function shouldShowProjectBookingCta(text) {
  const value = String(text || "");
  const negativeBeforeAction = /\b(no|not|none|without|unnecessary|isn'?t|not currently)\b.{0,55}\b(service|appointment|schedule|booking|treatment|treat|application|follow[-\s]?up|inspection|exclusion)\b/i.test(value);
  const actionBeforeNegative = /\b(service|appointment|booking|treatment|application|follow[-\s]?up|inspection|exclusion)\b.{0,55}\b(no|not|unnecessary|isn'?t)\b/i.test(value);
  if (negativeBeforeAction || actionBeforeNegative) return false;
  return /\b(schedule|book|appointment|recommend(?:ed)? (?:service|treatment|follow[-\s]?up|inspection)|apply|application|treatment|treat|follow[-\s]?up|exclusion|bait|boracare|bora care|termite|rodent|bed bug)\b/i.test(value);
}

function ProjectPreviewBookingCta({ upcomingAppointment, text }) {
  if (upcomingAppointment) {
    return (
      <div
        style={{
          marginTop: 12,
          padding: "10px 12px",
          borderRadius: 8,
          background: "#fff",
          border: "1px solid #D7E3EA",
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 900,
            color: "#1B2C5B",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          Upcoming appointment
        </div>
        <div style={{ fontSize: 13, color: "#465569", lineHeight: 1.55, marginTop: 4 }}>
          {[upcomingAppointment.serviceType, formatProjectAppointmentWindow(upcomingAppointment)]
            .filter(Boolean)
            .join(" - ")}
        </div>
        {upcomingAppointment.technicianName && (
          <div style={{ fontSize: 13, color: "#465569", lineHeight: 1.45 }}>
            Technician: {upcomingAppointment.technicianName}
          </div>
        )}
      </div>
    );
  }

  const label = includesProjectTextAny(text, ["rodent", "exclusion", "trap"])
    ? "Request Exclusion Estimate"
    : "Book an appointment";
  return (
    <div style={{ marginTop: 12, display: "flex", justifyContent: "center" }}>
      <a
        href={BOOK_URL}
        target="_blank"
        rel="noreferrer"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          minHeight: 40,
          padding: "11px 15px",
          borderRadius: 8,
          background: "#FFD700",
          color: "#1B2C5B",
          fontSize: 13,
          fontWeight: 900,
          textDecoration: "none",
        }}
      >
        <Calendar size={14} strokeWidth={2.25} />
        {label}
      </a>
    </div>
  );
}

function ProjectPreviewRecommendationsBlock({ text, upcomingAppointment }) {
  const sections = parseProjectRecommendationSections(text);
  const wrapStyle = {
    marginTop: 12,
    padding: "11px 12px",
    borderRadius: 9,
    background: "#F0F7FC",
    border: "1px solid #D7E3EA",
  };

  if (sections) {
    return (
      <div style={wrapStyle}>
        {sections.map((section, index) => (
          <div key={section.heading} style={{ marginTop: index === 0 ? 0 : 12 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#1B2C5B", marginBottom: 4 }}>
              {titleCaseProjectSection(section.heading)}
            </div>
            <div style={{ fontSize: 13, color: "#465569", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
              {section.body}
            </div>
            {section.heading === "WHAT WE RECOMMEND" &&
              shouldShowProjectBookingCta(section.body) && (
                <ProjectPreviewBookingCta upcomingAppointment={upcomingAppointment} text={section.body} />
              )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={wrapStyle}>
      <div style={{ fontSize: 12, fontWeight: 800, color: "#1B2C5B", marginBottom: 4 }}>
        Recommendations
      </div>
      <div style={{ fontSize: 13, color: "#465569", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
        {text}
      </div>
      {shouldShowProjectBookingCta(text) && (
        <ProjectPreviewBookingCta upcomingAppointment={upcomingAppointment} text={text} />
      )}
    </div>
  );
}

function ProjectPreviewPhotoTile({ photo, projectId }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    adminFetch(`/admin/projects/${projectId}/photos/${photo.id}/url`)
      .then((r) => readJsonResponse(r, "Could not load photo"))
      .then((d) => {
        if (!cancelled) setUrl(d.url || null);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [photo.id, projectId]);

  const label = photo.caption || (photo.category || "Service photo").replace(/_/g, " ");
  return (
    <div
      style={{
        borderRadius: 8,
        overflow: "hidden",
        border: "1px solid #D7E3EA",
        background: "#fff",
      }}
    >
      <div
        style={{
          aspectRatio: "1/1",
          background: "#F0F7FC",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#64748B",
          fontSize: 12,
          fontWeight: 700,
        }}
      >
        {url ? (
          <img
            src={url}
            alt={label}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          "Photo"
        )}
      </div>
      <div
        style={{
          padding: "7px 8px",
          fontSize: 12,
          fontWeight: 800,
          color: "#1B2C5B",
          textTransform: "capitalize",
        }}
      >
        {label}
      </div>
    </div>
  );
}

function CustomerProjectReportPreview({
  project,
  projectId,
  typeCfg,
  title,
  projectDate,
  findings,
  recommendations,
  upcomingAppointment,
  photos,
  sentLink,
}) {
  const typeLabel = typeCfg?.label || TYPE_LABELS[project.project_type] || "Inspection";
  // Same suppression rules as the customer-facing report page — the preview
  // staff approve must match what the customer actually sees: internal keys
  // filtered, and the raw findings hidden when the AI-drafted sectioned
  // narrative is present (the narrative is the customer rendering of them).
  // WDO keeps findings unless a filled FDACS filing is archived —
  // fdacs_pdf_available is computed by the detail endpoint with the same
  // rule as the public page (the raw archive index isn't served).
  // Preview == public: the sent link serves the fee-scrubbed narrative and
  // finding values (server /data egress applies @waves/report-redaction), so
  // the preview staff approve applies the SAME shared module — a legacy
  // narrative with a baked-in fee must look redacted here too, or staff
  // approve text the customer never sees (codex #2817). Type-gated to WDO,
  // the only type carrying the internal fee field.
  // Cue + recorded-value passes, matching the server /data serializer — the
  // fee values are the live edit state (findings.inspection_fee) merged with
  // the archived filing snapshot fees the detail endpoint derives (a
  // previously filed report can quote an older fee than the current field),
  // falling back to the shared flat default when blank, so staff approve
  // exactly what the customer's token serves (codex #2817).
  const previewFeeValues = project.project_type === WDO_TYPE
    ? resolveFeeValuesForScrub([
      findings?.inspection_fee ?? "",
      ...(Array.isArray(project.wdo_archived_fee_values) ? project.wdo_archived_fee_values : []),
    ])
    : [];
  const feeRedact = project.project_type === WDO_TYPE
    ? (text) => (typeof text === "string"
      ? redactSpecificAmounts(redactInspectionFeeCues(text), previewFeeValues)
      : text)
    : (text) => text;
  // Cue-only variant for STRUCTURED finding fields — the server limits the
  // value pass to free-prose (textarea) keys so "175 Main Street" with a
  // $175 fee is never corrupted; the preview must match.
  const feeRedactCueOnly = project.project_type === WDO_TYPE
    ? (text) => (typeof text === "string" ? redactInspectionFeeCues(text) : text)
    : (text) => text;
  const previewFreeTextKeys = (() => {
    const acc = new Set();
    const walk = (fields) => (fields || []).forEach((f) => {
      if (f.type === "textarea" && f.key) acc.add(f.key);
      if (f.fields) walk(f.fields);
    });
    walk(typeCfg?.findingsFields);
    walk(typeCfg?.fields);
    return acc;
  })();
  const customerRecommendations = recommendations
    ? feeRedact(String(recommendations))
    : recommendations;
  // Title and photo captions are free text on the same customer surface —
  // same scrub, or staff approve a headline/label the customer never sees.
  const reportTitle = feeRedact(String(title || "").trim()) || typeLabel;
  const aiNarrativeSections = customerRecommendations
    ? parseSections(String(customerRecommendations))
    : null;
  const suppressFindingsForNarrative = Boolean(aiNarrativeSections)
    && (project.project_type !== WDO_TYPE || Boolean(project.fdacs_pdf_available));
  const findingsEntries = suppressFindingsForNarrative ? [] : Object.entries(findings || {}).filter(
    ([k, v]) => !INTERNAL_FINDING_KEYS.has(k) && hasMeaningfulValue(formatProjectPreviewValue(v)),
  );
  // Same compliance-block rule as the public page (preview == final,
  // Codex P2 r4): when the narrative suppresses the raw findings, the
  // termite Phase-3 answers still render in their own record block.
  const complianceSection = TERMITE_COMPLIANCE_SECTIONS[project.project_type] || null;
  const complianceEntries = (suppressFindingsForNarrative && complianceSection)
    ? complianceSection.fields
      .map(([key, label]) => [label, findings?.[key]])
      .filter(([, v]) => hasMeaningfulValue(formatProjectPreviewValue(v)))
    : [];
  const visiblePhotos = (photos || []).slice(0, 4).map((p) => ({ ...p, caption: feeRedact(p.caption) }));
  const address = customerAddressLine(project);
  const metaRows = [
    projectDate ? `Inspection date: ${fmtDate(projectDate)}` : null,
    project.tech_name ? `Technician: ${project.tech_name}` : null,
    address || null,
  ].filter(Boolean);

  return (
    <div
      style={{
        border: "1px solid #D7E3EA",
        borderRadius: 12,
        overflow: "hidden",
        background: "#F7FBFE",
      }}
    >
      <div
        style={{
          background: "#065A8C",
          padding: "12px 14px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 10,
              color: "#CDEBFA",
              textTransform: "uppercase",
              letterSpacing: 1,
              fontWeight: 800,
            }}
          >
            Customer report preview
          </div>
          <div
            style={{
              fontSize: 18,
              color: "#fff",
              fontWeight: 800,
              marginTop: 2,
              lineHeight: 1.15,
            }}
          >
            {reportTitle}
          </div>
          <div style={{ fontSize: 12, color: "#DFF4FC", marginTop: 3 }}>
            {project.customer_name || "Customer"}
          </div>
        </div>
        <img src="/waves-logo.png" alt="Waves" style={{ height: 26 }} />
      </div>

      <div style={{ padding: 14 }}>
        {sentLink && (
          <a
            href={sentLink}
            target="_blank"
            rel="noreferrer"
            style={{
              display: "inline-flex",
              marginBottom: 12,
              color: "#065A8C",
              fontSize: 12,
              fontWeight: 800,
              textDecoration: "none",
            }}
          >
            Open live customer report
          </a>
        )}

        <div
          style={{
            background: "#fff",
            border: "1px solid #D7E3EA",
            borderRadius: 10,
            padding: 14,
          }}
        >
          {metaRows.length > 0 && (
            <div style={{ display: "grid", gap: 2, marginBottom: 12 }}>
              {metaRows.map((row) => (
                <div key={row} style={{ fontSize: 13, color: "#465569", lineHeight: 1.45 }}>
                  {row}
                </div>
              ))}
            </div>
          )}

          {findingsEntries.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 900,
                  color: "#1B2C5B",
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  marginBottom: 8,
                }}
              >
                Findings
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {findingsEntries.map(([key, value]) => (
                  <div
                    key={key}
                    style={{
                      padding: "9px 10px",
                      borderRadius: 9,
                      background: "#F0F7FC",
                      border: "1px solid #D7E3EA",
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 800, color: "#1B2C5B", marginBottom: 2 }}>
                      {projectFieldLabel(typeCfg, key)}
                    </div>
                    <div style={{ fontSize: 13, color: "#465569", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                      {(previewFreeTextKeys.has(key) ? feeRedact : feeRedactCueOnly)(formatProjectPreviewValue(value))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {complianceEntries.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 900,
                  color: "#1B2C5B",
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  marginBottom: 8,
                }}
              >
                {complianceSection.eyebrow}
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {complianceEntries.map(([label, value]) => (
                  <div
                    key={label}
                    style={{
                      padding: "9px 10px",
                      borderRadius: 9,
                      background: "#F0F7FC",
                      border: "1px solid #D7E3EA",
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 800, color: "#1B2C5B", marginBottom: 2 }}>
                      {label}
                    </div>
                    <div style={{ fontSize: 13, color: "#465569", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                      {feeRedactCueOnly(formatProjectPreviewValue(value))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {customerRecommendations ? (
            <ProjectPreviewRecommendationsBlock
              text={customerRecommendations}
              upcomingAppointment={upcomingAppointment}
            />
          ) : null}

          {visiblePhotos.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 900,
                  color: "#1B2C5B",
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  marginBottom: 8,
                }}
              >
                Photos
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(92px, 1fr))", gap: 8 }}>
                {visiblePhotos.map((photo) => (
                  <ProjectPreviewPhotoTile key={photo.id} photo={photo} projectId={projectId} />
                ))}
              </div>
              {(photos || []).length > visiblePhotos.length && (
                <div style={{ fontSize: 11, color: "#64748B", marginTop: 6 }}>
                  +{(photos || []).length - visiblePhotos.length} more shown on the full report
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ textAlign: "center", marginTop: 12 }}>
          <div style={{ fontSize: 13, color: "#465569" }}>Questions about this report?</div>
          <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 8 }}>
            <span
              style={{
                padding: "9px 14px",
                background: "#FFD700",
                color: "#1B2C5B",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 900,
              }}
            >
              Text Us
            </span>
            <span
              style={{
                padding: "9px 14px",
                background: "#E3F5FD",
                color: "#065A8C",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 900,
              }}
            >
              Call Us
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ProjectsPage() {
  const initialProjectId =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("projectId")
      : null;
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState("");
  const [filterType, setFilterType] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [typesRegistry, setTypesRegistry] = useState(null);
  const [createMode, setCreateMode] = useState(null);
  const [error, setError] = useState("");
  const isMobile = useIsMobile(900);
  const isAdmin = getAdminRole() === "admin";

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError("");
    const qs = new URLSearchParams();
    qs.set("limit", "500");
    if (filterStatus) qs.set("status", filterStatus);
    if (filterType) qs.set("project_type", filterType);
    try {
      const requests = [adminFetch(`/admin/projects?${qs.toString()}`)];
      if (!filterType) {
        const wdoQs = new URLSearchParams(qs);
        wdoQs.set("project_type", WDO_TYPE);
        requests.push(adminFetch(`/admin/projects?${wdoQs.toString()}`));
      }
      const responses = await Promise.all(requests);
      const payloads = await Promise.all(
        responses.map((res) =>
          readJsonResponse(res, "Could not load projects"),
        ),
      );
      setProjects(
        mergeProjectsUnique(payloads.flatMap((data) => data.projects || [])),
      );
    } catch (e) {
      setError(e.message || "Could not load projects");
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterType]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!initialProjectId || selectedId) return;
    if (projects.some((p) => p.id === initialProjectId)) {
      setSelectedId(initialProjectId);
    }
  }, [initialProjectId, projects, selectedId]);

  useEffect(() => {
    adminFetch("/admin/projects/types")
      .then((r) => readJsonResponse(r, "Could not load project types"))
      .then((d) => setTypesRegistry(d.types))
      .catch((e) => setError(e.message || "Could not load project types"));
  }, []);

  const regularProjects = projects.filter(
    (p) =>
      p.project_type !== WDO_TYPE &&
      (!filterType || p.project_type === filterType),
  );
  const wdoProjects = projects.filter((p) => p.project_type === WDO_TYPE);
  const showRegularProjects = filterType !== WDO_TYPE;
  const showWdoProjects = !filterType || filterType === WDO_TYPE;
  const selected = projects.find((p) => p.id === selectedId);

  return (
    <div className="max-w-[1300px] mx-auto text-ink-primary">
      {" "}
      <AdminCommandHeader
        title="Jobs"
        icon={ClipboardList}
        action={{
          label: "New Job",
          icon: Plus,
          onClick: () => setCreateMode("general"),
        }}
      />
      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-3 bg-white px-3 py-2.5 rounded-sm border-hairline border-zinc-200">
        <FilterSelect
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          {["draft", "sent", "closed"].map((s) => (
            <option key={s} value={s}>
              {STATUS_STYLES[s].label}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
        >
          <option value="">All types</option>
          {Object.entries(TYPE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </FilterSelect>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <div
        style={{
          display: "grid",
          // On phones the master-detail can't sit side by side — stack to one
          // column, and when a project is open show only the detail (full width)
          // so its title/photos aren't squished into a sliver. The detail's
          // close (X) returns to the list.
          gridTemplateColumns: !isMobile && selected ? "1fr 1.4fr" : "1fr",
          gap: 16,
        }}
      >
        {/* List — hidden on mobile while a detail is open */}
        <div
          style={{
            display: isMobile && selected ? "none" : "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {showRegularProjects &&
            (loading ? (
              <div className="p-6 text-13 text-zinc-500">Loading…</div>
            ) : regularProjects.length === 0 ? (
              <div className="p-6 bg-white rounded-sm border border-dashed border-zinc-300 text-13 text-zinc-500 text-center">
                No jobs match these filters.
              </div>
            ) : (
              regularProjects.map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  active={selectedId === p.id}
                  onSelect={() => setSelectedId(p.id)}
                />
              ))
            ))}

          {showWdoProjects && (
            <WdoReportsSection
              projects={wdoProjects}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </div>
        {/* Detail — keyed by project id so switching projects remounts the
            panel: stale edit state or an in-flight load for project A can
            never render onto (or save over) project B. */}
        {selected && (
          <ProjectDetail
            key={selected.id}
            projectId={selected.id}
            typesRegistry={typesRegistry}
            onClose={() => setSelectedId(null)}
            onChanged={loadProjects}
            canAdminActions={isAdmin}
          />
        )}
      </div>
      {createMode && (
        <CreateProjectModal
          theme="light"
          allowAiDraft
          defaultProjectType=""
          allowedProjectTypes={
            /* linkedCreationOnly (WDO, pre-treat cert — owner ruling
               2026-07-13) create from their scheduled visit, never ad hoc.
               FAIL CLOSED while the registry is loading/unavailable (Codex
               P2): an unfiltered list here would override the modal's own
               registry filtering and resurrect the linked-only lanes. */
            typesRegistry
              ? GENERAL_PROJECT_TYPES.filter(
                  (key) =>
                    !typesRegistry?.[key]?.appointmentManaged &&
                    !typesRegistry?.[key]?.linkedCreationOnly,
                )
              : []
          }
          onClose={() => setCreateMode(null)}
          onCreated={(p) => {
            setCreateMode(null);
            loadProjects();
            if (p?.id) setSelectedId(p.id);
          }}
        />
      )}
    </div>
  );
}

function WdoReportsSection({ projects, selectedId, onSelect }) {
  const urgentCount = projects.filter((p) => {
    if (p.status === "sent" || p.status === "closed") return false;
    const created = p.created_at ? new Date(p.created_at).getTime() : 0;
    return created && Date.now() - created > 24 * 60 * 60 * 1000;
  }).length;

  return (
    <section className="mt-4 pt-4 border-t border-hairline border-zinc-200 flex flex-col gap-2">
      {" "}
      <div className="flex items-start justify-between gap-2.5">
        {" "}
        <div>
          {" "}
          <div className="text-11 font-medium text-zinc-500 uppercase tracking-label">
            WDO Inspection Reports
          </div>{" "}
          <div className="text-13 text-ink-primary mt-1">
            Real-estate reports, realtor sharing, and closing-sensitive
            documentation.
          </div>
          {urgentCount > 0 && (
            <div className="text-11 text-alert-fg font-medium mt-1">
              {urgentCount} draft{urgentCount === 1 ? "" : "s"} older than 24h
            </div>
          )}
        </div>{" "}
        {/* + New WDO removed (owner ruling 2026-07-13): WDO reports are
            created from their scheduled visit in Dispatch / the tech
            portal, never ad hoc. */}
      </div>
      {projects.length === 0 ? (
        <div className="p-4 bg-white rounded-sm border border-dashed border-zinc-300 text-12 text-zinc-500 text-center">
          No WDO reports match these filters.
        </div>
      ) : (
        projects.map((p) => (
          <ProjectRow
            key={p.id}
            project={p}
            active={selectedId === p.id}
            onSelect={() => onSelect(p.id)}
            compactType="WDO"
          />
        ))
      )}
    </section>
  );
}

function FilterSelect({ value, onChange, children }) {
  // Shared Select primitive (its own caret) — width hugs the content like
  // the old inline select instead of the primitive's block default.
  return (
    <Select
      size="sm"
      value={value}
      onChange={onChange}
      className={`sm:!w-auto cursor-pointer ${value ? "text-ink-primary" : "text-zinc-500"}`}
    >
      {children}
    </Select>
  );
}

function ProjectRow({ project, active, onSelect, compactType }) {
  const status = STATUS_STYLES[project.status] || STATUS_STYLES.draft;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`text-left w-full cursor-pointer bg-white rounded-sm p-3 flex gap-3 items-start border ${
        active ? "border-zinc-900 ring-1 ring-zinc-900" : "border-hairline border-zinc-200 hover:border-zinc-400"
      }`}
    >
      {" "}
      <div className="flex-shrink-0 w-12 h-12 rounded-sm bg-zinc-100 flex items-center justify-center font-mono text-11 font-medium text-ink-primary">
        {compactType || TYPE_LABELS[project.project_type] || "Proj"}
      </div>{" "}
      <div className="flex-1 min-w-0">
        {" "}
        <div className="flex items-center justify-between gap-2">
          {" "}
          <div className="text-14 font-medium text-ink-primary whitespace-nowrap overflow-hidden text-ellipsis">
            {project.customer_name || "Customer"}
          </div>{" "}
          <Badge tone={status.tone} className="whitespace-nowrap">
            {status.label}
          </Badge>{" "}
        </div>{" "}
        <div className="text-12 text-zinc-500 mt-0.5">
          {project.title ||
            TYPE_LABELS[project.project_type] ||
            project.project_type}
        </div>{" "}
        <div className="flex gap-2.5 mt-1.5 text-11 text-zinc-500">
          {" "}
          <span>
            {fmtDate(project.project_date || project.created_at)}
          </span>{" "}
          <span>·</span> <span>{project.tech_name || "Tech"}</span>
          {project.photo_count > 0 && (
            <>
              <span>·</span>
              <span>{project.photo_count} </span>
            </>
          )}
        </div>{" "}
      </div>{" "}
    </button>
  );
}

// Named export: DispatchPageV2 and the tech portal mount this same editor
// in an overlay so project-backed visits (WDO, pre-treat cert) open their
// report in place from the schedule — the pest-completion interaction
// (owner ask 2026-07-13). Self-contained: fetches its own project by id.
export function ProjectDetail({
  projectId,
  typesRegistry,
  onClose,
  onChanged,
  canAdminActions = false,
  reloadKey = 0,
  onDirtyChange,
}) {
  const [confirmAsk, confirmDialog] = useConfirmDialog();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editFindings, setEditFindings] = useState({});
  const [editRecs, setEditRecs] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editProjectDate, setEditProjectDate] = useState("");
  const [dirty, setDirty] = useState(false);
  const [sentLink, setSentLink] = useState("");
  const [aiWriting, setAiWriting] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [delivery, setDelivery] = useState(null);
  const [aiUseComms, setAiUseComms] = useState(true);
  const [aiUsePhotos, setAiUsePhotos] = useState(true);
  const [productCatalog, setProductCatalog] = useState([]);
  // "Pay before you get the report" — default ON when the server offers the
  // option (WDO + gate enabled + not yet delivered).
  const [holdReportUntilPaid, setHoldReportUntilPaid] = useState(true);

  async function load(options = {}) {
    const { preserveEdits = false, background = false } = options;
    // background: refresh without tripping the full-editor loading swap —
    // the render gate is `loading || !project`, so a loud reload behind a
    // mounted, possibly-dirty editor replaced the whole form with a
    // "Loading project…" card and invited a no-confirm backdrop close
    // (house review on #2717). Background failures also stay quiet: the
    // decision-time preview re-fetch in handleClose still guards closeout.
    if (!background) {
      setLoading(true);
      setError("");
    }
    try {
      const [projectRes, activityRes] = await Promise.all([
        adminFetch(`/admin/projects/${projectId}`),
        adminFetch(`/admin/projects/${projectId}/activity`),
      ]);
      const d = await readJsonResponse(projectRes, "Could not load project");
      const activityData = await readJsonResponse(
        activityRes,
        "Could not load project history",
      );
      d.activity = activityData.activity || [];
      setData(d);
      if (!preserveEdits) {
        setEditFindings(d.project.findings || {});
        setEditRecs(d.project.recommendations || "");
        setEditTitle(d.project.title || "");
        setEditProjectDate(
          dateInputValue(d.project.project_date || d.project.created_at),
        );
        setDirty(false);
      }
      if (d.project.report_token) {
        setSentLink(
          `${window.location.origin}${d.project.report_url || `/report/project/${d.project.report_token}`}`,
        );
      } else {
        setSentLink("");
      }
      setDelivery(d.project.delivery_channels || null);
    } catch (e) {
      // A background/preserveEdits refresh must never blank or error-swap a
      // mounted editor (Codex r11 P2 + house review): keep the stale data,
      // and only surface the failure when this was a foreground load.
      if (!background) setError(e.message || "Could not load project");
      if (!preserveEdits) setData(null);
    } finally {
      if (!background) setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // The drawer instance survives across projects (dispatch overlay) — an
    // unchecked hold must not silently carry over to the next WDO.
    setHoldReportUntilPaid(true);
  }, [projectId]);

  // Host-driven data refresh (Codex r10 P2 on #2717): after an in-editor
  // payment detour (Details → checkout) resolves billing, the mounted
  // editor kept its stale closeoutPreview and left Close project disabled
  // — the decision-time preview fetch never runs off a disabled button.
  // preserveEdits keeps unsaved findings/recommendations intact;
  // background keeps the loading gate from swapping the form out.
  // The ref makes this fire only on post-mount CHANGES: the host's key is
  // a page-lifetime counter bumped by pest checkouts too, so an effect
  // keyed on truthiness double-loaded every mount after the session's
  // first payment (house review).
  const consumedReloadKeyRef = useRef(reloadKey);
  useEffect(() => {
    if (reloadKey === consumedReloadKeyRef.current) return;
    consumedReloadKeyRef.current = reloadKey;
    load({ preserveEdits: true, background: true });
  }, [reloadKey]);

  // Host-visible dirty signal (Codex r14 P2 on #2717): the dispatch
  // overlay's backdrop close needs to know when discarding would lose
  // unsaved edits — this editor keeps them only in component state.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const project = data?.project;
  const typeCfg =
    project && typesRegistry ? typesRegistry[project.project_type] : null;
  const closeoutPreview = data?.closeoutPreview || null;
  const billingBlocksClose =
    closeoutPreview?.billing?.required && !closeoutPreview?.billing?.resolved;
  const followupBlocksClose = !!closeoutPreview?.followup?.unsupported;
  const previewBlocksClose = closeoutPreview?.canClose === false;
  const closeoutBlocksClose = billingBlocksClose || followupBlocksClose || previewBlocksClose;
  const hasPrepGuide = project
    ? PROJECT_TYPES_WITH_PREP_GUIDES.has(project.project_type)
    : false;
  // WDO reports can't be sent until the licensee signature is captured.
  const wdoNeedsSignature =
    project?.project_type === WDO_TYPE && !project?.wdo_signature?.signed;
  // Payment hold: server-computed availability (WDO + gate on + not sent)
  // and the live held state driving the banner + manual-release hint.
  const reportHoldAvailable = !!project?.report_payment_hold_available;
  const reportHeld = ["held", "releasing"].includes(
    String(project?.report_hold_status || ""),
  );

  useEffect(() => {
    if (!typeCfg?.findingsFields || !hasCatalogBackedProjectFields(typeCfg.findingsFields) || productCatalog.length) return;
    adminFetch("/admin/dispatch/products/catalog")
      .then((r) => r.json())
      .then((d) => setProductCatalog(d.products || []))
      .catch(() => { /* product fields can still accept free text */ });
  }, [typeCfg, productCatalog.length]);

  function handleProductSelect(fieldKey, product) {
    const productName = product?.name || product?.product_name || "";
    const epaRegistration = product?.epa_reg_number || product?.epaRegNumber || "";
    const activeIngredient = product?.active_ingredient || product?.activeIngredient || "";
    const hasEpaField = typeCfg?.findingsFields?.some((field) => field.key === "epa_registration");
    const hasActiveIngredientField = typeCfg?.findingsFields?.some((field) => field.key === "active_ingredient");
    setEditFindings((f) => ({
      ...f,
      [fieldKey]: productName || f[fieldKey] || "",
      ...(hasEpaField && epaRegistration ? { epa_registration: epaRegistration } : {}),
      ...(hasActiveIngredientField && activeIngredient ? { active_ingredient: activeIngredient } : {}),
    }));
    setDirty(true);
  }

  async function saveDirtyProjectEdits(fallbackMessage) {
    if (!dirty) return;
    const saveRes = await adminFetch(`/admin/projects/${projectId}`, {
      method: "PUT",
      body: {
        title: editTitle || null,
        project_date: editProjectDate || null,
        findings: editFindings,
        recommendations: editRecs || null,
      },
    });
    await readJsonResponse(saveRes, fallbackMessage);
    setDirty(false);
  }

  async function saveEdits() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const r = await adminFetch(`/admin/projects/${projectId}`, {
        method: "PUT",
        body: {
          title: editTitle || null,
          project_date: editProjectDate || null,
          findings: editFindings,
          recommendations: editRecs || null,
        },
      });
      await readJsonResponse(r, "Could not save project changes");
      setDirty(false);
      await load();
      onChanged?.();
      setNotice("Changes saved.");
    } catch (e) {
      setError(e.message || "Could not save project changes");
    } finally {
      setSaving(false);
    }
  }

  async function handleSend() {
    if (!canAdminActions) {
      setError("Admin access required to send project reports.");
      return;
    }
    const readiness = evaluateProjectReadiness({
      project: { ...project, title: editTitle },
      typeCfg,
      findings: editFindings,
      recommendations: editRecs,
      projectDate: editProjectDate,
    });
    // Non-overridable compliance blockers (mirrors the server's hardMissing
    // 422): stop here instead of walking the admin into the override prompt
    // and a dead-end rejection (Codex P3 r4).
    if (readiness.hardMissing.length) {
      setError(
        `Required compliance fields must be completed before this report can send: ${readiness.hardMissing
          .map((item) => item.label)
          .join("; ")}`,
      );
      return;
    }
    if (readiness.missing.length || readiness.quality.length) {
      const lines = [
        ...readiness.missing.map((item) => `Missing: ${item.label}`),
        ...readiness.quality.map((item) => `Review: ${item}`),
      ];
      if (
        !(await confirmAsk(
          `This report has items to review before sending:\n\n${lines.join("\n")}\n\nSend anyway?`,
          { confirmLabel: "Send anyway" },
        ))
      )
        return;
    }
    let overrideReason = "";
    if (readiness.missing.length) {
      overrideReason =
        (await confirmAsk(
          "Enter the admin override reason for sending this incomplete report:",
          { input: "Override reason", confirmLabel: "Continue" },
        )) || "";
      if (!overrideReason) return;
    }
    const actionLabel =
      project.status === "sent"
        ? "Resend report to customer?"
        : "Send report to customer? This generates a public link and marks the project as Sent.";
    if (!(await confirmAsk(actionLabel, { confirmLabel: "Send" }))) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      // Persist any dirty edits (including an AI-drafted Recommendations block)
      // before delivery runs — otherwise the customer sees the pre-edit version
      // at the public link.
      await saveDirtyProjectEdits("Could not save project before sending");
      const r = await adminFetch(`/admin/projects/${projectId}/send`, {
        method: "POST",
        body: overrideReason ? { override_reason: overrideReason } : {},
      });
      const d = await readJsonResponse(r, "Could not send report");
      if (d.report_url) setSentLink(`${window.location.origin}${d.report_url}`);
      setDelivery(d.channels || null);
      if (d.sent === false || d.delivery_status === "failed") {
        setError(
          `Delivery failed; project remains in review. ${deliverySummary(d.channels)}`.trim(),
        );
      } else {
        setNotice(`Report delivered. ${deliverySummary(d.channels)}`.trim());
      }
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message || "Could not send report");
    } finally {
      setSaving(false);
    }
  }

  // Open the filled FDACS-13645 exactly as it will be filed, so the operator can
  // verify the official form is populated before sending. The endpoint is
  // admin-only (bearer auth), so fetch it with adminFetch and open the PDF as an
  // object URL — a plain link navigation drops the auth header and 401s.
  async function viewFilledFdacsPdf() {
    if (!projectId) return;
    setError("");
    // Open the tab synchronously inside the click gesture; Safari/iOS and strict
    // popup blockers reject window.open that happens only after an await. We set
    // its location once the blob is ready (no `noopener` — that would null `win`).
    const win = window.open("", "_blank");
    try {
      // Render from the SAME data the send will file — persist unsaved drawer
      // edits first, exactly like the send paths, so this isn't a stale preview.
      await saveDirtyProjectEdits("Could not save project before preview");
      const r = await adminFetch(`/admin/projects/${projectId}/fdacs-pdf`);
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || "Could not generate the filled FDACS-13645 PDF");
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      if (win) win.location = url;
      else window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      if (win) win.close();
      setError(e.message || "Could not open the filled FDACS-13645 PDF");
    }
  }

  async function handleSendWithInvoice() {
    if (!canAdminActions) {
      setError("Admin access required to send project reports.");
      return;
    }
    const readiness = evaluateProjectReadiness({
      project: { ...project, title: editTitle },
      typeCfg,
      findings: editFindings,
      recommendations: editRecs,
      projectDate: editProjectDate,
    });
    // Non-overridable compliance blockers (mirrors the server's hardMissing
    // 422): stop here instead of walking the admin into the override prompt
    // and a dead-end rejection (Codex P3 r4).
    if (readiness.hardMissing.length) {
      setError(
        `Required compliance fields must be completed before this report can send: ${readiness.hardMissing
          .map((item) => item.label)
          .join("; ")}`,
      );
      return;
    }
    let overrideReason = "";
    if (readiness.missing.length) {
      const lines = readiness.missing.map((item) => `Missing: ${item.label}`);
      if (!(await confirmAsk(`This report has items to review before sending:\n\n${lines.join("\n")}\n\nSend anyway?`, { confirmLabel: "Send anyway" }))) return;
      overrideReason =
        (await confirmAsk(
          "Enter the admin override reason for sending this incomplete report:",
          { input: "Override reason", confirmLabel: "Continue" },
        )) || "";
      if (!overrideReason) return;
    }
    // Resolved once per send: the toggle only renders when the server offers
    // the hold (WDO + gate on + not delivered), so a hidden toggle never
    // silently holds a non-eligible project.
    const sendHold = reportHoldAvailable && holdReportUntilPaid && project.status !== "closed";
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await saveDirtyProjectEdits("Could not save project before sending");
      // dry_run first so the operator can confirm the invoice amount.
      const preview = await adminFetch(`/admin/projects/${projectId}/send-with-invoice`, {
        method: "POST",
        body: {
          dry_run: true,
          ...(sendHold ? { hold_report_until_paid: true } : {}),
          ...(overrideReason ? { override_reason: overrideReason } : {}),
        },
      });
      const pv = await readJsonResponse(preview, "Could not prepare invoice");
      const inv = pv.invoice || {};
      const amount = inv.total != null ? `$${Number(inv.total).toFixed(2)}` : "the amount shown";
      const verb = inv.created ? "Create and send" : "Send";
      // A brand-new WDO has no invoice number yet (the draft is created on send),
      // so only name the number when the preview resolved an existing invoice.
      const invoiceLabel = inv.invoice_number ? ` ${inv.invoice_number}` : "";
      const isWdoReport = project.project_type === WDO_TYPE;
      const reportNoun = isWdoReport ? "WDO report" : "report";
      const emailContents = isWdoReport
        ? "FDACS-13645 report PDF + invoice PDF"
        : "report + invoice PDF";
      // Server-computed routing preview: who gets the combined email, whether
      // a distinct billing contact gets a copy, and which third parties from
      // the FDACS "Report sent to" line get a report-only copy (no invoice).
      const routing = pv.email_routing || {};
      const routingLines = [
        routing.recipient ? `Email to: ${routing.recipient}` : null,
        routing.billing_copy ? `Billing copy (same email): ${routing.billing_copy}` : null,
        routing.report_copies?.length
          ? sendHold
            ? `Report-only copy after payment, no invoice: ${routing.report_copies.join(", ")}`
            : `Report-only copy, no invoice: ${routing.report_copies.join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
      const confirmMessage = sendHold
        ? `${verb} invoice${invoiceLabel} for ${amount} and hold the ${reportNoun} until it's paid?\n\n` +
          `The customer gets the invoice + pay link now — no report. The FDACS-13645 report is emailed automatically the moment the invoice is paid.` +
          (routingLines ? `\n\n${routingLines}` : "")
        : `${verb} invoice${invoiceLabel} for ${amount} together with the ${reportNoun}?\n\n` +
          `The customer gets one email (${emailContents}) and one text (report + pay links).` +
          (routingLines ? `\n\n${routingLines}` : "");
      if (!(await confirmAsk(confirmMessage, { confirmLabel: verb }))) {
        setSaving(false);
        return;
      }
      const r = await adminFetch(`/admin/projects/${projectId}/send-with-invoice`, {
        method: "POST",
        body: {
          // Only an existing invoice carries an id from the preview; a new WDO
          // (id null) routes to the server's locked create path on send.
          ...(inv.id ? { invoice_id: inv.id } : {}),
          ...(sendHold ? { hold_report_until_paid: true } : {}),
          ...(overrideReason ? { override_reason: overrideReason } : {}),
        },
      });
      const d = await readJsonResponse(r, "Could not send report + invoice");
      if (d.report_url) setSentLink(`${window.location.origin}${d.report_url}`);
      setDelivery(d.channels || null);
      if (d.sent === false) {
        setError(`Delivery failed; project remains in review. ${deliverySummary(d.channels)}`.trim());
      } else if (d.report_held) {
        setNotice(
          `Invoice ${d.invoice?.invoice_number || ""} sent — report held; it delivers automatically once the invoice is paid. ${deliverySummary(d.channels)}`.trim(),
        );
      } else {
        setNotice(
          `Report + invoice ${d.invoice?.invoice_number || ""} delivered. ${deliverySummary(d.channels)}`.trim(),
        );
      }
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message || "Could not send report + invoice");
    } finally {
      setSaving(false);
    }
  }

  async function handleSendPrepGuide() {
    if (!canAdminActions) {
      setError("Admin access required to send prep guides.");
      return;
    }
    if (!PROJECT_TYPES_WITH_PREP_GUIDES.has(project?.project_type)) {
      setError("No default prep guide is configured for this project type.");
      return;
    }
    if (!(await confirmAsk("Send the prep guide email for this project?", { confirmLabel: "Send" }))) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await saveDirtyProjectEdits("Could not save project before sending prep guide");
      const r = await adminFetch(`/admin/projects/${projectId}/send-prep-guide`, {
        method: "POST",
      });
      const d = await readJsonResponse(r, "Could not send prep guide");
      setNotice(`Prep guide sent${d.template_key ? ` (${d.template_key})` : ""}.`);
      await load({ preserveEdits: true });
      onChanged?.();
    } catch (e) {
      setError(e.message || "Could not send prep guide");
    } finally {
      setSaving(false);
    }
  }

  async function handleSendPortalInvite() {
    if (!canAdminActions) {
      setError("Admin access required to send portal invites.");
      return;
    }
    if (!(await confirmAsk("Send a customer portal invite email for this project?", { confirmLabel: "Send" }))) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await saveDirtyProjectEdits("Could not save project before sending portal invite");
      const r = await adminFetch(`/admin/projects/${projectId}/send-portal-invite`, {
        method: "POST",
      });
      await readJsonResponse(r, "Could not send portal invite");
      setNotice("Portal invite sent.");
      await load({ preserveEdits: true });
      onChanged?.();
    } catch (e) {
      setError(e.message || "Could not send portal invite");
    } finally {
      setSaving(false);
    }
  }

  async function handleAiWrite() {
    if (!canAdminActions) {
      setError("Admin access required to draft project reports with AI.");
      return;
    }
    // Drafts into the Recommendations field. Replaces existing content so the
    // admin can tell what came from AI vs. what they kept by-hand; if the
    // admin liked prior text, Cmd-Z restores it before save.
    if (
      editRecs &&
      editRecs.trim() &&
      !(await confirmAsk(
        "Replace the current Recommendations text with an AI-drafted version?\n\nThe tech's original notes will still be used as context for the AI.",
        { confirmLabel: "Replace" },
      ))
    )
      return;
    setAiWriting(true);
    setError("");
    setNotice("");
    try {
      const r = await adminFetch(`/admin/projects/${projectId}/ai-write`, {
        method: "POST",
        body: {
          findings: editFindings,
          recommendations: editRecs,
          project_date: editProjectDate || null,
          include_communications: aiUseComms,
          include_photos: aiUsePhotos,
        },
      });
      const d = await readJsonResponse(r, "AI draft failed");
      if (d.report) {
        const aiText = d.report.trim();
        setEditRecs(aiText);
        // Autosave the AI draft so it can't be lost by hitting Send before
        // the admin manually saves. Other pending edits (title/findings)
        // are included in the same PUT.
        try {
          const saveRes = await adminFetch(`/admin/projects/${projectId}`, {
            method: "PUT",
            body: {
              title: editTitle || null,
              project_date: editProjectDate || null,
              findings: editFindings,
              recommendations: aiText,
            },
          });
          await readJsonResponse(
            saveRes,
            "AI draft created but autosave failed",
          );
          setDirty(false);
          await load();
          setNotice("AI draft saved.");
        } catch {
          // Autosave failed — leave it marked dirty so manual Save still works.
          setDirty(true);
          setNotice("AI draft created. Save changes to keep it.");
        }
      }
    } catch (e) {
      setError(`AI draft failed: ${e.message}`);
    } finally {
      setAiWriting(false);
    }
  }

  async function handleClose() {
    if (!canAdminActions) {
      setError("Admin access required to close projects.");
      return;
    }
    // Re-check the closeout preview at decision time (Codex r6 P3 on
    // #2717): the mounted preview goes stale when the linked visit is
    // cancelled/no-showed out-of-band (e.g. the schedule's overlaid
    // appointment sheet while this editor stays mounted), so the gates
    // below would promise "complete linked service" and then 409. Only
    // the preview is refreshed — data/edit state stay untouched so
    // unsaved edits survive; falls back to the mounted preview if the
    // fetch fails.
    let preview = closeoutPreview;
    try {
      const pr = await adminFetch(`/admin/projects/${projectId}`);
      const pd = await readJsonResponse(pr, "Could not refresh closeout preview");
      if (pd?.closeoutPreview) preview = pd.closeoutPreview;
    } catch {
      /* keep the mounted preview */
    }
    if (preview?.billing?.required && !preview?.billing?.resolved) {
      setError(
        `${closeoutBillingLabel(preview.billing)}. Create or collect the invoice before closing this project.`,
      );
      return;
    }
    if (preview?.followup?.unsupported) {
      setError(
        "Auto-schedule follow-up is not available yet. Change the follow-up policy to alert or schedule the follow-up manually before closing.",
      );
      return;
    }
    if (preview?.canClose === false) {
      const status = preview?.serviceCompletion?.status;
      setError(
        status
          ? `This project cannot close while the linked service is ${status}.`
          : "This project cannot close from its current service state.",
      );
      return;
    }
    const closeoutLines = [
      preview?.serviceCompletion?.willCompleteService
        ? `Service: complete ${preview.serviceCompletion.serviceType || "linked service"}`
        : null,
      preview?.billing ? `Billing: ${closeoutBillingLabel(preview.billing)}` : null,
      preview?.followup ? `Follow-up: ${closeoutFollowupLabel(preview.followup)}` : null,
      preview?.portal
        ? `Portal: ${preview.portal.attached ? "attached" : "token-only"}`
        : null,
    ].filter(Boolean);
    const confirmText = [
      "Close this project? It stays accessible but is filtered out of Sent view.",
      closeoutLines.length ? `\n${closeoutLines.join("\n")}` : "",
    ].join("");
    if (!(await confirmAsk(confirmText, { confirmLabel: "Close project" })))
      return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const r = await adminFetch(`/admin/projects/${projectId}/close`, {
        method: "POST",
      });
      const d = await readJsonResponse(r, "Could not close project");
      const serviceText = d.serviceCompleted ? " Service marked completed." : "";
      const portalText = d.portalAttached
        ? " Report attached to the customer portal."
        : d.serviceCompleted
        ? " Report remains token-only for this customer."
        : "";
      const followupText = d.followup?.alert?.created
        ? " Follow-up alert created."
        : d.followup?.alert?.existingAlertId
          ? " Existing follow-up alert kept."
          : "";
      // Notice BEFORE the host signal (house review): on a filtered Jobs
      // list onChanged's refetch can drop this project and unmount the
      // panel — a later setNotice would land on an unmounted component and
      // the operator would never see the close confirmation.
      setNotice(`Project closed.${serviceText}${portalText}${followupText}`);
      // Close also completes the linked visit — tell the host so schedule
      // embeds can retire their visit snapshot (DispatchPageV2 Details
      // handoff, Codex P1 on #2717). Emitted BEFORE the project reload:
      // during that await the host still rendered the Details pill off
      // the stale active snapshot, and a quick tap could cancel the
      // just-completed visit (Codex r10 P1). Consumers that take no args
      // (loadProjects) are unaffected by the earlier emission.
      onChanged?.({ visitCompleted: !!d.serviceCompleted });
      await load();
    } catch (e) {
      if (e.payload?.code === "project_completion_billing_required") {
        setError(
          `${e.message}. Amount: ${money(e.payload?.details?.amount || 0)}. Create or collect the invoice before closing.`,
        );
      } else if (e.payload?.code === "project_followup_auto_schedule_unsupported") {
        setError(
          "Auto-schedule follow-up is not available yet. Change the follow-up policy to alert or schedule the follow-up manually before closing.",
        );
      } else {
        setError(e.message || "Could not close project");
      }
    } finally {
      setSaving(false);
    }
  }

  async function handlePhotoDelete(photoId) {
    if (!(await confirmAsk("Remove this photo?", { confirmLabel: "Remove" }))) return;
    setError("");
    setNotice("");
    try {
      const r = await adminFetch(
        `/admin/projects/${projectId}/photos/${photoId}`,
        { method: "DELETE" },
      );
      await readJsonResponse(r, "Could not remove photo");
      await load();
      setNotice("Photo removed.");
    } catch (e) {
      setError(e.message || "Could not remove photo");
    }
  }

  async function uploadProjectPhoto(file, { category, caption } = {}) {
    const fd = new FormData();
    fd.append("photo", file);
    if (category) fd.append("category", category);
    if (caption) fd.append("caption", caption);
    const r = await adminFetch(`/admin/projects/${projectId}/photos`, {
      method: "POST",
      body: fd,
      headers: {},
    });
    await readJsonResponse(r, `Could not upload ${file.name}`);
  }

  async function handlePhotoUpload(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    setSaving(true);
    setError("");
    setNotice("");
    const failed = [];
    for (const f of files) {
      try {
        await uploadProjectPhoto(f);
      } catch (e) {
        failed.push(`${f.name}: ${e.message || "upload failed"}`);
      }
    }
    await load();
    if (failed.length) {
      setError(`Some photos did not upload: ${failed.join("; ")}`);
    } else {
      setNotice(
        `${files.length} photo${files.length === 1 ? "" : "s"} uploaded.`,
      );
    }
    setSaving(false);
  }

  async function handleEvidencePhotoSelected(file) {
    if (!file) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await uploadProjectPhoto(file, {
        category: "previous_treatment",
        caption: "Previous treatment evidence review",
      });
      await load({ preserveEdits: true });
      setNotice("Previous-treatment photo uploaded.");
    } catch (e) {
      setError(e.message || "Could not upload previous-treatment photo");
    } finally {
      setSaving(false);
    }
  }

  function appendTechnicalSnippet(text) {
    setEditRecs((prev) =>
      prev.trim() ? `${prev.trimEnd()}\n\n${text}` : text,
    );
    setDirty(true);
  }

  function fillWdoAddressFromCustomer() {
    const address = formatProjectCustomerAddress(project);
    if (!address) return;
    setEditFindings((f) => ({ ...f, property_address: address }));
    setDirty(true);
  }

  function applyWdoSuggestions(suggestions, options = {}) {
    setEditFindings((f) =>
      mergeWdoSuggestions(f, suggestions, options.overwrite),
    );
    setDirty(true);
  }

  function applyWdoProfile(profile) {
    setEditFindings((f) => applyProfileToWdoFindings(f, profile, { overwrite: true }));
    setDirty(true);
  }

  function applyWdoHistory(history) {
    setEditFindings((f) => applyHistoryToWdoFindings(f, history, { overwrite: true }));
    setDirty(true);
  }

  if (loading || !project) {
    return (
      <div
        style={{
          background: "#FFFFFF",
          border: `1px solid #E4E4E7`,
          borderRadius: 6,
          padding: 24,
          color: "#71717A",
        }}
      >
        {loading ? "Loading project…" : error || "Project unavailable."}
      </div>
    );
  }

  const status = STATUS_STYLES[project.status] || STATUS_STYLES.draft;
  const idPrefix = `project-${projectId}`;
  const fieldInputId = (key) => `${idPrefix}-finding-${key}`;
  const readiness = evaluateProjectReadiness({
    project: { ...project, title: editTitle },
    typeCfg,
    findings: editFindings,
    recommendations: editRecs,
    projectDate: editProjectDate,
  });

  return (
    <div
      style={{
        background: ESTIMATE_BG,
        border: `1px solid ${ESTIMATE_BORDER}`,
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        boxShadow: "0 10px 30px rgba(27, 44, 91, 0.08)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          padding: "20px 24px",
          borderBottom: `1px solid ${ESTIMATE_BORDER}`,
          background: "#FFFFFF",
        }}
      >
        {" "}
        <div style={{ flex: 1, minWidth: 0 }}>
          {" "}
          <div
            style={{
              fontSize: 12,
              color: ESTIMATE_MUTED,
              textTransform: "uppercase",
              letterSpacing: "0.12em",
              fontWeight: 500,
            }}
          >
            {typeCfg?.label || project.project_type} · {project.customer_name}
          </div>{" "}
          <div
            style={{
              fontSize: 24,
              fontWeight: 500,
              letterSpacing: "-0.01em",
              color: ESTIMATE_TEXT,
              marginTop: 4,
              lineHeight: 1.15,
              overflowWrap: "anywhere",
            }}
          >
            {project.title || typeCfg?.label || "Project"}
          </div>{" "}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 6,
              flexWrap: "wrap",
            }}
          >
            {" "}
            <Badge tone={status.tone}>{status.label}</Badge>{" "}
            <span style={{ fontSize: 11, color: "#71717A" }}>
              Inspection {fmtDate(project.project_date || project.created_at)}{" "}
              by {project.tech_name || "—"}
            </span>
            {project.sent_at && (
              <span style={{ fontSize: 11, color: "#71717A" }}>
                · Sent {fmtDate(project.sent_at)}
              </span>
            )}
          </div>{" "}
        </div>{" "}
        <button
          type="button"
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            color: "#71717A",
            fontSize: 22,
            cursor: "pointer",
            padding: "0 8px",
          }}
          aria-label="Close"
        >
          ×
        </button>{" "}
      </div>
      {/* Body */}
      <div
        style={{
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        {error && <Alert tone="error">{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}
        {delivery && (
          <DeliveryPanel channels={delivery} status={project.delivery_status} />
        )}
        {sentLink && (
          <div
            style={{
              padding: "10px 12px",
              background: "#FAFAFA",
              border: `1px solid #E4E4E7`,
              borderRadius: 6,
              fontSize: 12,
              color: "#09090B",
            }}
          >
            {" "}
            <div style={{ fontWeight: 500, marginBottom: 4 }}>
              Customer-facing report
            </div>{" "}
            <div
              style={{ fontFamily: MONO, fontSize: 11, wordBreak: "break-all" }}
            >
              {" "}
              <a
                href={sentLink}
                target="_blank"
                rel="noreferrer"
                style={{ color: "#18181B" }}
              >
                {sentLink}
              </a>{" "}
            </div>{" "}
          </div>
        )}
        <CustomerProjectReportPreview
          project={project}
          projectId={projectId}
          typeCfg={typeCfg}
          title={editTitle}
          projectDate={editProjectDate}
          findings={editFindings}
          recommendations={editRecs}
          upcomingAppointment={data.upcomingAppointment || null}
          photos={data.photos || []}
          sentLink={sentLink}
        />
        {project.project_type === WDO_TYPE && (
          <div
            style={{
              padding: "10px 12px",
              background: "#F4F4F5",
              border: `1px solid #E4E4E7`,
              borderRadius: 8,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
            }}
          >
            {" "}
            <div>
              <div style={{ fontSize: 12, fontWeight: 500, color: "#09090B" }}>
                FDACS-13645 WDO form
              </div>
              <div style={{ fontSize: 11, color: "#71717A", marginTop: 2 }}>
                Preview the filled report exactly as it will be filed.
              </div>
              <a
                href="/forms/fdacs-13645-wdo-inspection-report.pdf"
                target="_blank"
                rel="noreferrer"
                style={{
                  fontSize: 11,
                  color: "#71717A",
                  textDecoration: "underline",
                  marginTop: 4,
                  display: "inline-block",
                }}
              >
                Open blank template
              </a>
            </div>{" "}
            {/* The filled-form endpoint is admin-only (requireAdmin); only show
                the action to operators who can actually call it, so techs (who
                see this card too) aren't handed a button that always 403s. */}
            {canAdminActions && (
              <button
                type="button"
                onClick={viewFilledFdacsPdf}
                style={{
                  flexShrink: 0,
                  padding: "7px 10px",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 500,
                  color: "#09090B",
                  cursor: "pointer",
                  background: "#FFFFFF",
                  border: `1px solid #D4D4D8`,
                }}
              >
                View filled form
              </button>
            )}{" "}
          </div>
        )}
        <ReadinessPanel readiness={readiness} />
        {/* Title */}
        <div>
          {" "}
          <Label htmlFor={`${idPrefix}-title`}>Report title</Label>{" "}
          <input
            id={`${idPrefix}-title`}
            name="title"
            type="text"
            value={editTitle}
            onChange={(e) => {
              setEditTitle(e.target.value);
              setDirty(true);
            }}
            placeholder={typeCfg?.label || "Project"}
            style={inputStyle}
          />{" "}
        </div>{" "}
        <div>
          {" "}
          <Label htmlFor={`${idPrefix}-project-date`}>
            {project.project_type === CERTIFICATE_TYPE
              ? "Date of treatment"
              : "Inspection / project date"}
          </Label>{" "}
          <input
            id={`${idPrefix}-project-date`}
            name="project_date"
            type="date"
            value={editProjectDate}
            onChange={(e) => {
              setEditProjectDate(e.target.value);
              setDirty(true);
            }}
            // iOS WebKit gives date inputs an intrinsic shadow-DOM width that
            // can exceed width:100% — clamp it and drop the native appearance
            // so the field tracks the container like the sibling text inputs
            // (same fix as CreateProjectModal, #2806).
            style={{
              ...inputStyle,
              WebkitAppearance: "none",
              appearance: "none",
              minWidth: 0,
              maxWidth: "100%",
            }}
          />{" "}
        </div>
        {project.project_type === WDO_TYPE && (
          <WdoIntelligenceBar
            projectId={projectId}
            customerId={project.customer_id}
            propertyAddress={
              editFindings.property_address || formatProjectCustomerAddress(project)
            }
            findings={editFindings}
            onApplySuggestions={applyWdoSuggestions}
            onApplyProfile={applyWdoProfile}
            onApplyHistory={applyWdoHistory}
            initialProfile={project.property_profile || null}
            initialHistory={project.wdo_history || null}
            onEvidencePhotoSelected={handleEvidencePhotoSelected}
            disabled={saving || aiWriting}
            palette={{
              card: "#FFFFFF",
              bg: "#F4F4F5",
              border: "#E4E4E7",
              heading: "#09090B",
              text: "#27272A",
              muted: "#71717A",
              accent: "#18181B",
              accentText: "#fff",
              red: "#991B1B",
            }}
          />
        )}
        {/* Type-specific findings */}
        {typeCfg?.findingsFields?.map((field, fieldIndex) => (
          <div key={field.key}>
            {/* Sectioned schemas (WDO, pre-treat cert): header above the
                first field of each section — same scan-in-groups pattern as
                the typed CompletionPanel and CreateProjectModal. */}
            {field.section &&
              field.section !== typeCfg.findingsFields[fieldIndex - 1]?.section && (
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: "#27272A",
                    margin: "20px 0 10px",
                    paddingBottom: 6,
                    borderBottom: "1px solid #E4E4E7",
                  }}
                >
                  {field.section}
                </div>
              )}
            {" "}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                marginBottom: 6,
              }}
            >
              {field.label !== field.section && (
                <Label
                  htmlFor={fieldInputId(field.key)}
                  style={{ marginBottom: 0 }}
                >
                  {field.label}
                </Label>
              )}
              {project.project_type === WDO_TYPE &&
                field.key === "property_address" &&
                formatProjectCustomerAddress(project) && (
                  <button
                    type="button"
                    onClick={fillWdoAddressFromCustomer}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#18181B",
                      fontSize: 11,
                      fontWeight: 500,
                      cursor: "pointer",
                      padding: 0,
                      whiteSpace: "nowrap",
                    }}
                  >
                    Fill from customer
                  </button>
                )}
            </div>
            <ProjectFindingFieldInput
              field={field}
              id={fieldInputId(field.key)}
              name={`findings.${field.key}`}
              value={editFindings[field.key] || ""}
              onChange={(value) => {
                setEditFindings((f) => ({
                  ...f,
                  [field.key]: value,
                }));
                setDirty(true);
              }}
              inputStyle={inputStyle}
              products={productCatalog}
              onProductSelect={(product) => handleProductSelect(field.key, product)}
            />
          </div>
        ))}
        {/* Recommendations */}
        <div>
          {" "}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 6,
            }}
          >
            {" "}
            <Label
              htmlFor={`${idPrefix}-recommendations`}
              style={{ margin: 0 }}
            >
              Recommendations / notes
            </Label>
            {canAdminActions && (
              <button
                type="button"
                onClick={handleAiWrite}
                disabled={aiWriting || saving}
                title="Claude drafts Customer Concern, What We Inspected, What We Found, What We Did, and What We Recommend from selected context."
                style={{
                  padding: "4px 10px",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 500,
                  background: aiWriting ? "#71717A" : "#FFFFFF",
                  color: "#09090B",
                  border: `1px solid #D4D4D8`,
                  cursor: aiWriting || saving ? "default" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                {" "}
                <span aria-hidden="true"></span>
                {aiWriting ? "Drafting…" : "Write with AI"}
              </button>
            )}
          </div>
          {canAdminActions && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 10,
                margin: "0 0 8px",
                fontSize: 11,
                color: "#71717A",
              }}
            >
              {" "}
              <label
                style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
              >
                {" "}
                <input
                  id={`${idPrefix}-ai-comms`}
                  name="ai_include_communications"
                  type="checkbox"
                  checked={aiUseComms}
                  onChange={(e) => setAiUseComms(e.target.checked)}
                />
                Include recent calls/texts/emails
              </label>{" "}
              <label
                style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
              >
                {" "}
                <input
                  id={`${idPrefix}-ai-photos`}
                  name="ai_include_photos"
                  type="checkbox"
                  checked={aiUsePhotos}
                  onChange={(e) => setAiUsePhotos(e.target.checked)}
                />
                Include photos
              </label>{" "}
            </div>
          )}
          <textarea
            id={`${idPrefix}-recommendations`}
            name="recommendations"
            value={editRecs}
            onChange={(e) => {
              setEditRecs(e.target.value);
              setDirty(true);
            }}
            rows={8}
            placeholder={`Write freely, or tap "Write with AI" to draft the customer-facing report sections from findings, communication context, tech notes, and photos.`}
            style={{
              ...inputStyle,
              resize: "vertical",
              minHeight: 160,
              fontFamily: "'Roboto', Arial, sans-serif",
            }}
          />{" "}
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}
          >
            {TECHNICAL_SNIPPETS.map((snippet) => (
              <button
                key={snippet.label}
                type="button"
                onClick={() => appendTechnicalSnippet(snippet.text)}
                style={{
                  padding: "5px 8px",
                  borderRadius: 6,
                  border: `1px solid #D4D4D8`,
                  background: "#FFFFFF",
                  color: "#09090B",
                  fontSize: 11,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                {snippet.label}
              </button>
            ))}
          </div>{" "}
        </div>
        {/* Photos */}
        <div>
          {" "}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            {" "}
            <Label style={{ margin: 0 }}>
              Photos (optional) ({data.photos?.length || 0})
            </Label>{" "}
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "6px 12px",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 500,
                background: "#18181B",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              + Upload
              <input
                id={`${idPrefix}-photos`}
                name="project_photos"
                type="file"
                accept="image/*"
                multiple
                onChange={handlePhotoUpload}
                style={{ display: "none" }}
              />{" "}
            </label>{" "}
          </div>
          {data.photos?.length > 0 ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
                gap: 8,
              }}
            >
              {data.photos.map((ph) => (
                <PhotoThumb
                  key={ph.id}
                  photo={ph}
                  projectId={projectId}
                  onDelete={() => handlePhotoDelete(ph.id)}
                />
              ))}
            </div>
          ) : (
            <div
              style={{
                padding: "20px 0",
                fontSize: 12,
                color: "#71717A",
                textAlign: "center",
              }}
            >
              No photos yet.
            </div>
          )}
        </div>{" "}
        {canAdminActions && closeoutPreview && project.status !== "closed" && (
          <div
            style={{
              border: `1px solid ${closeoutBlocksClose ? "#FCA5A5" : "#E4E4E7"}`,
              background: closeoutBlocksClose ? "#FEF2F2" : "#FAFAFA",
              borderRadius: 8,
              padding: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: "#09090B",
                fontSize: 13,
                fontWeight: 850,
                marginBottom: 8,
              }}
            >
              <ClipboardList size={15} />
              Closeout
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
                gap: 8,
                fontSize: 12,
              }}
            >
              <div>
                <div style={{ color: "#71717A", fontSize: 11, fontWeight: 500 }}>
                  Service
                </div>
                <div style={{ color: "#09090B", fontWeight: 500 }}>
                  {closeoutPreview.serviceCompletion?.willCompleteService
                    ? `Complete ${closeoutPreview.serviceCompletion.serviceType || "linked service"}`
                    : closeoutPreview.serviceCompletion?.linked
                      ? "No service completion"
                      : "Project only"}
                </div>
              </div>
              <div>
                <div style={{ color: "#71717A", fontSize: 11, fontWeight: 500 }}>
                  Billing
                </div>
                <div
                  style={{
                    color: billingBlocksClose ? "#991B1B" : "#09090B",
                    fontWeight: 500,
                  }}
                >
                  {closeoutBillingLabel(closeoutPreview.billing)}
                </div>
              </div>
              <div>
                <div style={{ color: "#71717A", fontSize: 11, fontWeight: 500 }}>
                  Follow-up
                </div>
                <div style={{ color: followupBlocksClose ? "#991B1B" : "#09090B", fontWeight: 500 }}>
                  {closeoutFollowupLabel(closeoutPreview.followup)}
                </div>
              </div>
              <div>
                <div style={{ color: "#71717A", fontSize: 11, fontWeight: 500 }}>
                  Report
                </div>
                <div style={{ color: "#09090B", fontWeight: 500 }}>
                  {closeoutPreview.portal?.attached ? "Portal attached" : "Token-only"}
                </div>
              </div>
            </div>
            {billingBlocksClose && (
              <div style={{ marginTop: 8, color: "#991B1B", fontSize: 12, fontWeight: 750 }}>
                Resolve billing before closing. The project can stay in review until the invoice or prepaid coverage exists.
              </div>
            )}
            {followupBlocksClose && (
              <div style={{ marginTop: 8, color: "#991B1B", fontSize: 12, fontWeight: 750 }}>
                Auto-schedule follow-up is not wired yet. Use alert follow-up or schedule the return manually before closing.
              </div>
            )}
            {previewBlocksClose && !billingBlocksClose && !followupBlocksClose && (
              <div style={{ marginTop: 8, color: "#991B1B", fontSize: 12, fontWeight: 750 }}>
                This project cannot close from the linked service’s current state.
              </div>
            )}
          </div>
        )}
        <ProjectHistoryPanel activity={data.activity || []} />{" "}
      </div>
      {/* Signature capture is a FIELD action — the licensee signs at the
          inspection, and POST /:id/wdo-signature is requireTechOrAdmin — so
          it is deliberately NOT behind canAdminActions (Codex P2 on the
          tech in-place embed). Send/PDF/close stay admin-gated. */}
      {project.project_type === WDO_TYPE && project.status !== "closed" && (
        <div style={{ padding: "0 16px" }}>
          <WdoSignaturePad
            projectId={project.id}
            signature={project.wdo_signature}
            defaultSignerName={project.wdo_applicator?.name || project.tech_name || ""}
            defaultSignerIdCard={project.wdo_applicator?.idCardNo || ""}
            onChanged={() => load({ preserveEdits: true })}
          />
        </div>
      )}
      {reportHeld && (
        <div style={{ padding: "0 16px 12px" }}>
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid #FCD34D",
              background: "#FFFBEB",
              color: "#92400E",
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            Report held — the customer has the invoice and pay link, and the
            report is emailed automatically the moment the invoice is paid.
            &ldquo;Send report&rdquo; delivers it now and clears the hold.
            {project.report_hold_last_error ? (
              <div style={{ marginTop: 6, color: "#991B1B", fontWeight: 750 }}>
                Last automatic release attempt failed:{" "}
                {project.report_hold_last_error}
              </div>
            ) : null}
          </div>
        </div>
      )}
      {/* Footer actions */}
      <div
        style={{
          padding: "12px 16px",
          borderTop: `1px solid #E4E4E7`,
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          justifyContent: "flex-end",
          alignItems: "center",
        }}
      >
        {canAdminActions && reportHoldAvailable && project.status !== "closed" && (
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              fontSize: 13,
              color: "#3F3F46",
              fontWeight: 500,
              cursor: "pointer",
              marginRight: "auto",
            }}
            title="Send the invoice + pay link now; the FDACS report is emailed automatically once the invoice is paid"
          >
            <input
              type="checkbox"
              checked={holdReportUntilPaid}
              onChange={(e) => setHoldReportUntilPaid(e.target.checked)}
              disabled={saving}
            />
            Hold report until invoice is paid
          </label>
        )}
        {canAdminActions && (
          <button
            type="button"
            onClick={handleSendPortalInvite}
            disabled={saving}
            style={{
              ...btnSecondary,
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              opacity: saving ? 0.5 : 1,
            }}
          >
            <Mail size={16} />
            Portal invite
          </button>
        )}
        {canAdminActions && (
          <button
            type="button"
            onClick={handleSendPrepGuide}
            disabled={saving || !hasPrepGuide}
            title={hasPrepGuide ? "Send prep guide" : "No default prep guide for this project type"}
            style={{
              ...btnSecondary,
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              opacity: saving || !hasPrepGuide ? 0.45 : 1,
            }}
          >
            <BookOpen size={16} />
            Prep guide
          </button>
        )}
        {canAdminActions && project.status !== "closed" && (
          <button
            type="button"
            onClick={handleClose}
            disabled={saving || closeoutBlocksClose}
            title={
              billingBlocksClose
                ? "Resolve billing before closing"
                : followupBlocksClose
                  ? "Resolve follow-up automation before closing"
                  : previewBlocksClose
                    ? "Project cannot close from the current service state"
                  : "Close project"
            }
            style={{ ...btnSecondary, opacity: saving || closeoutBlocksClose ? 0.5 : 1 }}
          >
            {billingBlocksClose
              ? "Resolve billing first"
              : followupBlocksClose
                ? "Resolve follow-up first"
                : previewBlocksClose
                  ? "Cannot close"
                : "Close project"}
          </button>
        )}
        <button
          type="button"
          onClick={saveEdits}
          disabled={saving || !dirty}
          style={{ ...btnSecondary, opacity: saving || !dirty ? 0.4 : 1 }}
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        {canAdminActions &&
          project.status === "sent" &&
          project.status !== "closed" && (
            <button
              type="button"
              onClick={handleSend}
              disabled={saving || wdoNeedsSignature}
              style={{ ...btnPrimary, opacity: saving || wdoNeedsSignature ? 0.5 : 1 }}
              title={wdoNeedsSignature ? "Capture the licensee signature first" : undefined}
            >
              Resend report
            </button>
          )}
        {canAdminActions &&
          project.status !== "sent" &&
          project.status !== "closed" && (
            <button
              type="button"
              onClick={handleSend}
              disabled={saving || wdoNeedsSignature}
              style={{ ...btnPrimary, opacity: saving || wdoNeedsSignature ? 0.5 : 1 }}
              title={
                wdoNeedsSignature
                  ? "Capture the licensee signature first"
                  : reportHeld
                    ? "Deliver the report now — this releases the payment hold"
                    : undefined
              }
            >
              {reportHeld ? "Send report now (release hold)" : "Send report"}
            </button>
          )}
        {canAdminActions &&
          (project.project_type === WDO_TYPE || project.service_record_id) &&
          project.status !== "closed" && (
            <button
              type="button"
              onClick={handleSendWithInvoice}
              disabled={saving || wdoNeedsSignature}
              style={{ ...btnPrimary, opacity: saving || wdoNeedsSignature ? 0.5 : 1 }}
              title={
                wdoNeedsSignature
                  ? "Capture the licensee signature first"
                  : project.project_type === WDO_TYPE
                    ? "Send the filled FDACS-13645 report and an invoice together via email + text"
                    : "Send the report and an invoice together via email + text"
              }
            >
              Send report + invoice
            </button>
          )}
      </div>{" "}
      {confirmDialog}
    </div>
  );
}

const PROJECT_ACTIVITY_LABELS = {
  project_created: "Created",
  project_updated: "Updated",
  project_report_sent: "Sent",
  project_report_resent: "Resent",
  project_report_with_invoice_sent: "Report + invoice sent",
  project_report_with_invoice_failed: "Report + invoice failed",
  project_invoice_sent_report_held: "Invoice sent — report held",
  project_invoice_report_hold_failed: "Invoice send failed (hold)",
  project_report_released_after_payment: "Report released (paid)",
  project_report_release_blocked: "Report release blocked",
  project_prep_guide_sent: "Prep guide sent",
  project_prep_guide_failed: "Prep guide failed",
  project_portal_invite_sent: "Portal invite sent",
  project_portal_invite_failed: "Portal invite failed",
  project_closed: "Closed",
  project_followup_recorded: "Follow-up",
  project_photo_uploaded: "Photo uploaded",
  project_photo_deleted: "Photo deleted",
  project_report_viewed: "Viewed",
};

function fmtDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ProjectHistoryPanel({ activity }) {
  return (
    <div>
      {" "}
      <div
        style={{
          fontSize: 14,
          fontWeight: 500,
          color: "#09090B",
          marginBottom: 8,
        }}
      >
        History
      </div>
      {activity.length > 0 ? (
        <div
          style={{
            border: `1px solid #E4E4E7`,
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          {activity.map((item, idx) => (
            <div
              key={item.id || `${item.action}-${item.created_at}-${idx}`}
              style={{
                padding: "10px 12px",
                borderTop: idx === 0 ? "none" : `1px solid #E4E4E7`,
                background: "#FFFFFF",
              }}
            >
              {" "}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  alignItems: "flex-start",
                }}
              >
                {" "}
                <div style={{ minWidth: 0 }}>
                  {" "}
                  <div
                    style={{ fontSize: 14, fontWeight: 500, color: "#09090B" }}
                  >
                    {PROJECT_ACTIVITY_LABELS[item.action] || item.action}
                  </div>{" "}
                  <div style={{ fontSize: 14, color: "#71717A", marginTop: 2 }}>
                    {item.description || "Project activity recorded."}
                  </div>
                  {item.actor_name && (
                    <div style={{ fontSize: 14, color: "#71717A", marginTop: 4 }}>
                      By {item.actor_name}
                    </div>
                  )}
                </div>{" "}
                <div
                  style={{
                    flexShrink: 0,
                    fontSize: 14,
                    color: "#71717A",
                    textAlign: "right",
                  }}
                >
                  {fmtDateTime(item.created_at)}
                </div>{" "}
              </div>{" "}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ padding: "12px 0", fontSize: 14, color: "#71717A" }}>
          No activity recorded yet.
        </div>
      )}
    </div>
  );
}

function PhotoThumb({ photo, projectId, onDelete }) {
  const [url, setUrl] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setLoadFailed(false);
    adminFetch(`/admin/projects/${projectId}/photos/${photo.id}/url`)
      .then((r) => readJsonResponse(r, "Could not load photo"))
      .then((d) => {
        if (!cancelled) {
          if (d.url) setUrl(d.url);
          else setLoadFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, photo.id]);

  return (
    <div
      style={{
        position: "relative",
        background: "#F4F4F5",
        borderRadius: 8,
        border: `1px solid #E4E4E7`,
        overflow: "hidden",
        aspectRatio: "1/1",
      }}
    >
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          style={{ display: "block", width: "100%", height: "100%" }}
        >
          {" "}
          <img
            src={url}
            alt={photo.caption || photo.category || "Photo"}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />{" "}
        </a>
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            color: "#71717A",
          }}
        >
          {loadFailed ? "Photo unavailable" : "Loading…"}
        </div>
      )}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          padding: "4px 6px",
          background: "rgba(0,0,0,0.55)",
          color: "#fff",
          fontSize: 10,
          fontWeight: 500,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        {" "}
        <span
          style={{
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {(photo.category || "").replace(/_/g, " ")}
        </span>{" "}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            onDelete();
          }}
          style={{
            background: "transparent",
            border: "none",
            color: "#fff",
            cursor: "pointer",
            fontSize: 13,
            padding: 0,
            lineHeight: 1,
          }}
          aria-label="Remove photo"
        >
          ×
        </button>{" "}
      </div>{" "}
    </div>
  );
}

function ReadinessPanel({ readiness }) {
  const complete = readiness.missing.length === 0;
  const hasQualityNotes = readiness.quality.length > 0;
  return (
    <div
      style={{
        // V2 monochrome: complete = neutral zinc; blockers gate the send,
        // so the incomplete state carries the genuine-alert tint.
        padding: "10px 12px",
        background: complete && !hasQualityNotes ? "#FAFAFA" : "#FEF2F2",
        border: `1px solid ${complete && !hasQualityNotes ? "#E4E4E7" : "#FECACA"}`,
        borderRadius: 6,
      }}
    >
      {" "}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        {" "}
        <div>
          {" "}
          <div style={{ fontSize: 12, fontWeight: 500, color: "#09090B" }}>
            Pre-send review
          </div>{" "}
          <div style={{ fontSize: 11, color: "#71717A", marginTop: 2 }}>
            {complete
              ? "Required report details are present."
              : `${readiness.missing.length} required item${readiness.missing.length === 1 ? "" : "s"} still need attention.`}
          </div>{" "}
        </div>{" "}
        <span
          style={{
            flexShrink: 0,
            fontSize: 10,
            fontWeight: 500,
            color: complete && !hasQualityNotes ? "#3F3F46" : "#991B1B",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {complete && !hasQualityNotes ? "Ready" : "Review"}
        </span>{" "}
      </div>{" "}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 6,
          marginTop: 10,
        }}
      >
        {readiness.required.map((item) => (
          <div
            key={item.label}
            style={{
              fontSize: 11,
              color: item.ok ? "#3F3F46" : "#991B1B",
              background: item.ok ? "#FAFAFA" : "#FEF2F2",
              border: `1px solid ${item.ok ? "#E4E4E7" : "#FECACA"}`,
              borderRadius: 6,
              padding: "5px 7px",
            }}
          >
            {item.ok ? "Done" : "Missing"}: {item.label}
          </div>
        ))}
      </div>
      {hasQualityNotes && (
        <div
          style={{
            marginTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 5,
          }}
        >
          {readiness.quality.map((note) => (
            <div
              key={note}
              style={{ fontSize: 11, color: "#71717A", lineHeight: 1.4 }}
            >
              Review: {note}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Alert({ tone = "success", children }) {
  const isError = tone === "error";
  return (
    <div
      style={{
        // V2 monochrome: confirmations are neutral zinc; alert red is
        // reserved for genuine errors.
        padding: "9px 12px",
        background: isError ? "#FEF2F2" : "#FAFAFA",
        border: `1px solid ${isError ? "#FECACA" : "#E4E4E7"}`,
        borderRadius: 6,
        color: isError ? "#991B1B" : "#3F3F46",
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      {children}
    </div>
  );
}

function DeliveryPanel({ channels, status }) {
  const entries = Object.entries(channels || {});
  if (!entries.length) return null;
  return (
    <div
      style={{
        padding: "10px 12px",
        background: "#F4F4F5",
        border: `1px solid #E4E4E7`,
        borderRadius: 8,
      }}
    >
      {" "}
      <div
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: "#09090B",
          marginBottom: 8,
        }}
      >
        Delivery status{status ? `: ${String(status).replace(/_/g, " ")}` : ""}
      </div>{" "}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {entries.map(([channel, result]) => (
          <div
            key={channel}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 10,
              fontSize: 12,
            }}
          >
            {" "}
            <span
              style={{
                color: "#27272A",
                fontWeight: 500,
                textTransform: "uppercase",
              }}
            >
              {channel}
            </span>{" "}
            <span
              style={{
                color: result?.ok ? "#15803D" : "#991B1B",
                textAlign: "right",
              }}
            >
              {result?.ok ? "Sent" : result?.error || "Failed"}
            </span>{" "}
          </div>
        ))}
      </div>{" "}
    </div>
  );
}

function Label({ children, style, htmlFor }) {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        fontSize: 12,
        fontWeight: 500,
        color: ESTIMATE_MUTED,
        textTransform: "uppercase",
        letterSpacing: "0.12em",
        marginBottom: 8,
        display: "block",
        ...(style || {}),
      }}
    >
      {children}
    </label>
  );
}

const inputStyle = {
  width: "100%",
  minHeight: 44,
  background: ESTIMATE_INPUT_BG,
  color: ESTIMATE_TEXT,
  border: `1px solid ${ESTIMATE_INPUT_BORDER}`,
  borderRadius: 4,
  padding: "10px 12px",
  fontSize: 14,
  fontWeight: 400,
  boxSizing: "border-box",
  outline: "none",
};

const btnPrimary = {
  minHeight: 44,
  padding: "0 18px",
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 500,
  background: "#18181B",
  color: "#fff",
  border: "none",
  cursor: "pointer",
};
const btnSecondary = {
  minHeight: 44,
  padding: "0 16px",
  borderRadius: 4,
  fontSize: 14,
  fontWeight: 500,
  background: "#FFFFFF",
  color: ESTIMATE_TEXT,
  border: `1px solid ${ESTIMATE_INPUT_BORDER}`,
  cursor: "pointer",
};
