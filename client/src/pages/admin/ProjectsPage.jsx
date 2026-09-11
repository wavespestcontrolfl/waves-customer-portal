import { useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { BookOpen, Calendar, ClipboardList, ExternalLink, Mail, Plus, Sparkles, Upload, X } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Input,
  Select,
  Switch,
  Textarea,
  UiSurface,
} from "../../components/ui";
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
import termiteTreatmentMethods from "../../../../shared/termite-treatment-methods.json";

const {
  TERMITE_LIQUID_DILUTION_METHODS,
  TERMITE_PERIMETER_METHODS,
} = termiteTreatmentMethods;


/**
 * Projects — post-service inspection / documentation reports.
 *
 * Tier 2 light zinc palette. Techs create drafts from /tech; admin reviews,
 * edits findings, manages optional photos, and presses Send to generate the
 * customer-facing /report/project/:token link.
 */


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
    <Dialog open size="sm" onClose={handleCancel} aria-label="Confirmation">
      <DialogBody>
        <div className="whitespace-pre-line text-ui-body text-zinc-700">
          {pending.message}
        </div>
        {pending.input && (
          <Input
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={pending.input}
            className="mt-3"
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
const OFFICIAL_TERMITE_DOCUMENT_TYPES = new Set([WDO_TYPE, CERTIFICATE_TYPE]);
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
  return `Invoice not sent ${money(billing.amount)}`;
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
  // Unchanged from main on purpose — see the note in the server mirror
  // (admin-projects.js): re-gating stored "Other" records is a separate
  // business decision, not part of removing the form inputs.
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
    const isPerimeter = TERMITE_PERIMETER_METHODS.includes(method);
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
    if (TERMITE_LIQUID_DILUTION_METHODS.includes(method)) {
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
      <div className="mt-3 rounded-md border-hairline border-zinc-200 bg-white p-3 text-center">
        <div className="text-ui-body font-medium text-zinc-900">
          Upcoming appointment
        </div>
        <div className="mt-1 text-ui-body text-zinc-700">
          {[upcomingAppointment.serviceType, formatProjectAppointmentWindow(upcomingAppointment)]
            .filter(Boolean)
            .join(" - ")}
        </div>
        {upcomingAppointment.technicianName && (
          <div className="text-ui-body text-zinc-700">
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
    <div className="mt-3 flex justify-center">
      <a
        href={BOOK_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-h-11 items-center gap-2 rounded-sm border-hairline border-zinc-900 bg-zinc-900 px-4 py-2 text-ui-body font-medium text-white u-focus-ring"
      >
        <Calendar size={14} strokeWidth={2.25} />
        {label}
      </a>
    </div>
  );
}

function ProjectPreviewRecommendationsBlock({ text, upcomingAppointment }) {
  const sections = parseProjectRecommendationSections(text);

  if (sections) {
    return (
      <div className="mt-3 rounded-md border-hairline border-zinc-200 bg-zinc-50 p-3">
        {sections.map((section, index) => (
          <div key={section.heading} className={index === 0 ? "" : "mt-3"}>
            <div className="mb-1 text-ui-body font-medium text-zinc-900">
              {titleCaseProjectSection(section.heading)}
            </div>
            <div className="whitespace-pre-wrap text-ui-body text-zinc-700">
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
    <div className="mt-3 rounded-md border-hairline border-zinc-200 bg-zinc-50 p-3">
      <div className="mb-1 text-ui-body font-medium text-zinc-900">
        Recommendations
      </div>
      <div className="whitespace-pre-wrap text-ui-body text-zinc-700">
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
    <div className="overflow-hidden rounded-md border-hairline border-zinc-200 bg-white">
      <div className="flex aspect-square items-center justify-center bg-zinc-100 text-ui-body font-medium text-ink-secondary">
        {url ? (
          <img
            src={url}
            alt={label}
            className="h-full w-full object-cover"
          />
        ) : (
          "Photo"
        )}
      </div>
      <div className="p-2 text-ui-body font-medium capitalize text-zinc-900">
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
    <Card>
      <CardHeader className="flex items-center justify-between gap-3 bg-zinc-50">
        <div className="min-w-0">
          <div className="text-ui-body text-ink-secondary">
            Customer report preview
          </div>
          <div className="mt-1 text-18 font-medium leading-tight text-zinc-900">
            {reportTitle}
          </div>
          <div className="mt-1 text-ui-body text-ink-secondary">
            {project.customer_name || "Customer"}
          </div>
        </div>
        <img src="/waves-logo.png" alt="Waves" className="h-7 w-auto" />
      </CardHeader>

      <CardBody>
        {sentLink && (
          <a
            href={sentLink}
            target="_blank"
            rel="noreferrer"
            className="mb-3 inline-flex min-h-11 items-center gap-2 text-ui-body font-medium text-zinc-900 underline u-focus-ring"
          >
            <ExternalLink size={16} aria-hidden />
            Open live customer report
          </a>
        )}

        <div className="rounded-md border-hairline border-zinc-200 bg-white p-4">
          {metaRows.length > 0 && (
            <div className="mb-3 grid gap-1">
              {metaRows.map((row) => (
                <div key={row} className="text-ui-body text-zinc-700">
                  {row}
                </div>
              ))}
            </div>
          )}

          {findingsEntries.length > 0 && (
            <div className="mt-3">
              <div className="mb-2 text-ui-body font-medium text-zinc-900">
                Findings
              </div>
              <div className="grid gap-2">
                {findingsEntries.map(([key, value]) => (
                  <div
                    key={key}
                    className="rounded-md border-hairline border-zinc-200 bg-zinc-50 p-3"
                  >
                    <div className="mb-1 text-ui-body font-medium text-zinc-900">
                      {projectFieldLabel(typeCfg, key)}
                    </div>
                    <div className="whitespace-pre-wrap text-ui-body text-zinc-700">
                      {(previewFreeTextKeys.has(key) ? feeRedact : feeRedactCueOnly)(formatProjectPreviewValue(value))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {complianceEntries.length > 0 && (
            <div className="mt-3">
              <div className="mb-2 text-ui-body font-medium text-zinc-900">
                {complianceSection.eyebrow}
              </div>
              <div className="grid gap-2">
                {complianceEntries.map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-md border-hairline border-zinc-200 bg-zinc-50 p-3"
                  >
                    <div className="mb-1 text-ui-body font-medium text-zinc-900">
                      {label}
                    </div>
                    <div className="whitespace-pre-wrap text-ui-body text-zinc-700">
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
            <div className="mt-3">
              <div className="mb-2 text-ui-body font-medium text-zinc-900">
                Photos
              </div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(92px,1fr))] gap-2">
                {visiblePhotos.map((photo) => (
                  <ProjectPreviewPhotoTile key={photo.id} photo={photo} projectId={projectId} />
                ))}
              </div>
              {(photos || []).length > visiblePhotos.length && (
                <div className="mt-2 text-ui-body text-ink-secondary">
                  +{(photos || []).length - visiblePhotos.length} more shown on the full report
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-3 text-center">
          <div className="text-ui-body text-ink-secondary">Questions about this report?</div>
          <div className="mt-2 flex justify-center gap-2">
            <span className="rounded-sm border-hairline border-zinc-300 bg-white px-4 py-2 text-ui-body font-medium text-zinc-900">
              Text us
            </span>
            <span className="rounded-sm border-hairline border-zinc-300 bg-white px-4 py-2 text-ui-body font-medium text-zinc-900">
              Call us
            </span>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

export default function ProjectsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialProjectId = searchParams.get("projectId");
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
    if (!initialProjectId) {
      setSelectedId(null);
      return;
    }
    const match = projects.find(
      (project) => String(project.id) === String(initialProjectId),
    );
    setSelectedId(match?.id || null);
  }, [initialProjectId, projects]);

  const selectProject = useCallback(
    (projectId) => {
      if (!projectId) return;
      const next = new URLSearchParams(searchParams);
      next.set("projectId", String(projectId));
      setSearchParams(next);
      setSelectedId(projectId);
    },
    [searchParams, setSearchParams],
  );

  const closeProject = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("projectId");
    setSearchParams(next, { replace: true });
    setSelectedId(null);
  }, [searchParams, setSearchParams]);

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
    <UiSurface density="comfortable" className="mx-auto max-w-[1300px] text-ui-body text-ink-primary">
      <AdminCommandHeader
        variant="workspace"
        title="Reports"
        icon={ClipboardList}
        action={{
          label: "New reports",
          icon: Plus,
          onClick: () => setCreateMode("general"),
        }}
      />
      {/* Filters */}
      <Card className="mb-4">
        <CardBody className="flex flex-wrap gap-2">
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
        </CardBody>
      </Card>
      {error && <ActionFeedback error className="mb-4">{error}</ActionFeedback>}
      <div className={`grid gap-4 ${!isMobile && selected ? "grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]" : "grid-cols-1"}`}>
        {/* List — hidden on mobile while a detail is open */}
        <div className={`${isMobile && selected ? "hidden" : "flex"} flex-col gap-2`}>
          {showRegularProjects &&
            (loading ? (
              <ActionFeedback className="min-h-20">Loading reports...</ActionFeedback>
            ) : regularProjects.length === 0 ? (
              <Card><CardBody className="py-8 text-center text-ink-secondary">
                No reports match these filters.
              </CardBody></Card>
            ) : (
              regularProjects.map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  active={selectedId === p.id}
                  onSelect={() => selectProject(p.id)}
                />
              ))
            ))}

          {showWdoProjects && (
            <WdoReportsSection
              projects={wdoProjects}
              selectedId={selectedId}
              onSelect={selectProject}
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
            onClose={closeProject}
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
            if (p?.id) selectProject(p.id);
          }}
        />
      )}
    </UiSurface>
  );
}

function WdoReportsSection({ projects, selectedId, onSelect }) {
  const urgentCount = projects.filter((p) => {
    if (p.status === "sent" || p.status === "closed") return false;
    const created = p.created_at ? new Date(p.created_at).getTime() : 0;
    return created && Date.now() - created > 24 * 60 * 60 * 1000;
  }).length;

  return (
    <section className="mt-4 flex flex-col gap-2 border-t border-hairline border-zinc-200 pt-4">
      <div className="flex items-start justify-between gap-2.5">
        {" "}
        <div>
          <div className="text-ui-body font-medium text-zinc-900">
            WDO inspection reports
          </div>{" "}
          <div className="mt-1 text-ui-body text-ink-secondary">
            Real-estate reports, realtor sharing, and closing-sensitive
            documentation.
          </div>
          {urgentCount > 0 && (
            <div className="mt-1 text-ui-body font-medium text-alert-fg">
              {urgentCount} draft{urgentCount === 1 ? "" : "s"} older than 24h
            </div>
          )}
        </div>{" "}
        {/* + New WDO removed (owner ruling 2026-07-13): WDO reports are
            created from their scheduled visit in Dispatch / the tech
            portal, never ad hoc. */}
      </div>
      {projects.length === 0 ? (
        <Card><CardBody className="text-center text-ink-secondary">
          No WDO reports match these filters.
        </CardBody></Card>
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
      className={`min-h-14 w-full cursor-pointer rounded-md border bg-white p-3 text-left u-focus-ring ${
        active ? "border-zinc-900 ring-1 ring-zinc-900" : "border-hairline border-zinc-200 hover:border-zinc-400"
      }`}
    >
      <div className="flex items-start gap-3">
      <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-sm bg-zinc-100 text-ui-caption font-medium text-ink-primary">
        {compactType || TYPE_LABELS[project.project_type] || "Project"}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          {" "}
          <div className="overflow-hidden text-ellipsis whitespace-nowrap text-ui-body font-medium text-ink-primary">
            {project.customer_name || "Customer"}
          </div>{" "}
          <Badge tone={status.tone} className="whitespace-nowrap">
            {status.label}
          </Badge>{" "}
        </div>{" "}
        <div className="mt-1 text-ui-body text-ink-secondary">
          {project.title ||
            TYPE_LABELS[project.project_type] ||
            project.project_type}
        </div>{" "}
        <div className="mt-2 flex flex-wrap gap-2 text-ui-caption text-ink-secondary">
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
      </div>
      </div>
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
  // Signed, but the content (findings/date/photos) changed afterwards — the
  // server 422s the send, so surface the re-sign requirement HERE instead of
  // letting the operator discover it as a send failure.
  const wdoSignatureStale =
    project?.project_type === WDO_TYPE &&
    !!project?.wdo_signature?.signed &&
    !!project?.wdo_signature?.content_stale;
  const wdoSendBlocked = wdoNeedsSignature || wdoSignatureStale;
  const wdoSendBlockedTitle = wdoNeedsSignature
    ? "Capture the licensee signature first"
    : "Report changed after signing — the licensee must clear & re-sign first";
  // Payment hold: server-computed availability (official termite document +
  // gate on + not sent) and the live state driving the release hint.
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
    setSaving(true);
    setError("");
    setNotice("");
    try {
      // Persist any dirty edits (including an AI-drafted Recommendations block)
      // BEFORE the routing preview — the "Report sent to" third-party copies
      // are parsed from the saved findings, so an unsaved edit would preview
      // (and then send) against stale routing.
      await saveDirtyProjectEdits("Could not save project before sending");
      // dry_run routing preview: the report-only send was the one blind path —
      // the operator never saw who the FDACS "Report sent to" copies go to
      // (or that a typo'd address silently drops one).
      const preview = await adminFetch(`/admin/projects/${projectId}/send`, {
        method: "POST",
        body: {
          dry_run: true,
          ...(overrideReason ? { override_reason: overrideReason } : {}),
        },
      });
      const pv = await readJsonResponse(preview, "Could not prepare report send");
      const routing = pv.email_routing || {};
      const routingLines = [
        routing.recipient
          ? `Email to: ${routing.recipient}`
          : "⚠ No customer email on file — the report email can't deliver.",
        routing.report_copies?.length
          ? `Report-only copy, no invoice: ${routing.report_copies.join(", ")}`
          : null,
        pv.releases_payment_hold
          ? "This send RELEASES the payment hold — the report goes out now, before payment."
          : null,
      ]
        .filter(Boolean)
        .join("\n");
      const actionLabel =
        (project.status === "sent"
          ? "Resend report to customer?"
          : "Send report to customer? This generates a public link and marks the project as Sent.") +
        (routingLines ? `\n\n${routingLines}` : "");
      if (!(await confirmAsk(actionLabel, { confirmLabel: "Send" }))) {
        setSaving(false);
        return;
      }
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
    return <ActionFeedback className="min-h-20">{loading ? "Loading project..." : error || "Project unavailable."}</ActionFeedback>;
  }

  const status = STATUS_STYLES[project.status] || STATUS_STYLES.draft;
  const idPrefix = `project-${projectId}`;
  const isOfficialTermiteDocument = OFFICIAL_TERMITE_DOCUMENT_TYPES.has(project.project_type);
  const fieldInputId = (key) => `${idPrefix}-finding-${key}`;
  const readiness = evaluateProjectReadiness({
    project: { ...project, title: editTitle },
    typeCfg,
    findings: editFindings,
    recommendations: editRecs,
    projectDate: editProjectDate,
  });

  return (
    <Card
      data-official-document-editor={isOfficialTermiteDocument ? project.project_type : undefined}
      className="flex min-w-0 flex-col overflow-hidden"
    >
      {/* Header */}
      <CardHeader className="flex items-start justify-between gap-3 p-5">
        <div className="min-w-0 flex-1">
          <div className="text-ui-body text-ink-secondary">
            {typeCfg?.label || project.project_type} · {project.customer_name}
          </div>{" "}
          <div className="mt-1 break-words text-22 font-medium leading-tight text-zinc-900">
            {project.title || typeCfg?.label || "Project"}
          </div>{" "}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {" "}
            <Badge tone={status.tone}>{status.label}</Badge>{" "}
            <span className="text-ui-body text-ink-secondary">
              Inspection {fmtDate(project.project_date || project.created_at)}{" "}
              by {project.tech_name || "—"}
            </span>
            {project.sent_at && (
              <span className="text-ui-body text-ink-secondary">
                · Sent {fmtDate(project.sent_at)}
              </span>
            )}
          </div>{" "}
        </div>{" "}
        <Button
          variant="ghost"
          onClick={onClose}
          className="ui-icon-action"
          aria-label="Close"
        >
          <X size={20} aria-hidden />
        </Button>{" "}
      </CardHeader>
      {/* Body */}
      <CardBody className="flex flex-col gap-5 p-5">
        {error && <Alert tone="error">{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}
        {delivery && (
          <DeliveryPanel channels={delivery} status={project.delivery_status} />
        )}
        {sentLink && (
          <div className="rounded-md border-hairline border-zinc-200 bg-zinc-50 p-3 text-ui-body text-zinc-900">
            <div className="mb-1 font-medium">
              Customer-facing report
            </div>{" "}
            <div className="break-all u-nums">
              {" "}
              <a
                href={sentLink}
                target="_blank"
                rel="noreferrer"
                className="underline u-focus-ring"
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
          <Card className="bg-zinc-50"><CardBody className="flex flex-wrap items-center justify-between gap-3">
            {" "}
            <div>
              <div className="text-ui-body font-medium text-zinc-900">
                FDACS-13645 WDO form
              </div>
              <div className="mt-1 text-ui-body text-ink-secondary">
                Preview the filled report exactly as it will be filed.
              </div>
              <a
                href="/forms/fdacs-13645-wdo-inspection-report.pdf"
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex min-h-11 items-center text-ui-body text-zinc-900 underline u-focus-ring"
              >
                Open blank template
              </a>
            </div>{" "}
            {/* The filled-form endpoint is admin-only (requireAdmin); only show
                the action to operators who can actually call it, so techs (who
                see this card too) aren't handed a button that always 403s. */}
            {canAdminActions && (
              <Button
                variant="secondary"
                onClick={viewFilledFdacsPdf}
              >
                View filled form
              </Button>
            )}{" "}
          </CardBody></Card>
        )}
        <ReadinessPanel readiness={readiness} />
        {/* Title */}
        <Field label="Report title">
          <Input
            id={`${idPrefix}-title`}
            name="title"
            type="text"
            value={editTitle}
            onChange={(e) => {
              setEditTitle(e.target.value);
              setDirty(true);
            }}
            placeholder={typeCfg?.label || "Project"}
          />
        </Field>
        <Field label={project.project_type === CERTIFICATE_TYPE ? "Date of treatment" : "Inspection / project date"}>
          <Input
            id={`${idPrefix}-project-date`}
            name="project_date"
            type="date"
            value={editProjectDate}
            onChange={(e) => {
              setEditProjectDate(e.target.value);
              setDirty(true);
            }}
            className="min-w-0 max-w-full appearance-none"
          />
        </Field>
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
          />
        )}
        {/* Type-specific findings stay in the shared tech/admin renderer. */}
        <div data-shared-project-fields className="space-y-3">
        {typeCfg?.findingsFields?.map((field, fieldIndex) => (
          <div key={field.key}>
            {/* Sectioned schemas (WDO, pre-treat cert): header above the
                first field of each section — same scan-in-groups pattern as
                the typed CompletionPanel and CreateProjectModal. */}
            {field.section &&
              field.section !== typeCfg.findingsFields[fieldIndex - 1]?.section && (
                <div className="mb-3 mt-5 border-b border-zinc-200 pb-2 text-ui-body font-medium text-zinc-900">
                  {field.section}
                </div>
              )}
            {" "}
            <div className="mb-2 flex items-center justify-between gap-2">
              {field.label !== field.section && (
                <label
                  htmlFor={fieldInputId(field.key)}
                  className="ui-label text-zinc-900"
                >
                  {field.label}
                </label>
              )}
              {project.project_type === WDO_TYPE &&
                field.key === "property_address" &&
                formatProjectCustomerAddress(project) && (
                  <Button
                    variant="ghost"
                    onClick={fillWdoAddressFromCustomer}
                  >
                    Fill from customer
                  </Button>
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
              inputStyle={{ width: "100%" }}
              products={productCatalog}
              onProductSelect={(product) => handleProductSelect(field.key, product)}
            />
          </div>
        ))}
        </div>
        {/* Recommendations */}
        <div>
          {" "}
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <label
              htmlFor={`${idPrefix}-recommendations`}
              className="ui-label text-zinc-900"
            >
              Recommendations / notes
            </label>
            {canAdminActions && (
              <Button
                variant="secondary"
                onClick={handleAiWrite}
                disabled={aiWriting || saving}
                loading={aiWriting}
                title="Claude drafts Customer Concern, What We Inspected, What We Found, What We Did, and What We Recommend from selected context."
              >
                <Sparkles size={16} aria-hidden />
                {aiWriting ? "Drafting…" : "Write with AI"}
              </Button>
            )}
          </div>
          {canAdminActions && (
            <div className="mb-2 flex flex-wrap gap-3 text-ui-body text-ink-secondary">
              <Switch
                  id={`${idPrefix}-ai-comms`}
                  checked={aiUseComms}
                  onChange={setAiUseComms}
                  label="Include recent calls/texts/emails"
                />
              <Switch
                  id={`${idPrefix}-ai-photos`}
                  checked={aiUsePhotos}
                  onChange={setAiUsePhotos}
                  label="Include photos"
                />
            </div>
          )}
          <Textarea
            id={`${idPrefix}-recommendations`}
            name="recommendations"
            value={editRecs}
            onChange={(e) => {
              setEditRecs(e.target.value);
              setDirty(true);
            }}
            rows={8}
            placeholder={`Write freely, or tap "Write with AI" to draft the customer-facing report sections from findings, communication context, tech notes, and photos.`}
            className="min-h-40"
          />{" "}
          <div className="mt-2 flex flex-wrap gap-2">
            {TECHNICAL_SNIPPETS.map((snippet) => (
              <Button
                key={snippet.label}
                variant="secondary"
                onClick={() => appendTechnicalSnippet(snippet.text)}
              >
                {snippet.label}
              </Button>
            ))}
          </div>{" "}
        </div>
        {/* Photos */}
        <div>
          {" "}
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="ui-label text-zinc-900">
              Photos (optional) ({data.photos?.length || 0})
            </div>{" "}
            <label className="ui-control ui-action ui-control-comfortable inline-flex cursor-pointer items-center justify-center gap-2 rounded-sm border-hairline border-zinc-900 bg-zinc-900 px-4 text-ui-body font-medium text-white u-focus-ring">
              <Upload size={16} aria-hidden /> Upload
              <input
                id={`${idPrefix}-photos`}
                name="project_photos"
                type="file"
                accept="image/*"
                multiple
                onChange={handlePhotoUpload}
                className="sr-only"
              />{" "}
            </label>{" "}
          </div>
          {data.photos?.length > 0 ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
              {data.photos.map((ph) => (
                <PhotoThumb
                  key={ph.id}
                  photo={ph}
                  projectId={projectId}
                  onDelete={() => handlePhotoDelete(ph.id)}
                  onCaptionSaved={() => load({ preserveEdits: true })}
                />
              ))}
            </div>
          ) : (
            <div className="py-5 text-center text-ui-body text-ink-secondary">
              No photos yet.
            </div>
          )}
        </div>{" "}
        {canAdminActions && closeoutPreview && project.status !== "closed" && (
          <Card className={closeoutBlocksClose ? "border-alert-fg" : "bg-zinc-50"}>
            <CardHeader className="flex items-center gap-2">
              <ClipboardList size={15} />
              <CardTitle>Closeout</CardTitle>
            </CardHeader>
            <CardBody>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3 text-ui-body">
              <div>
                <div className="text-ink-secondary">Service</div>
                <div className="font-medium text-zinc-900">
                  {closeoutPreview.serviceCompletion?.willCompleteService
                    ? `Complete ${closeoutPreview.serviceCompletion.serviceType || "linked service"}`
                    : closeoutPreview.serviceCompletion?.linked
                      ? "No service completion"
                      : "Project only"}
                </div>
              </div>
              <div>
                <div className="text-ink-secondary">Billing</div>
                <div className={`font-medium ${billingBlocksClose ? "text-alert-fg" : "text-zinc-900"}`}>
                  {closeoutBillingLabel(closeoutPreview.billing)}
                </div>
              </div>
              <div>
                <div className="text-ink-secondary">Follow-up</div>
                <div className={`font-medium ${followupBlocksClose ? "text-alert-fg" : "text-zinc-900"}`}>
                  {closeoutFollowupLabel(closeoutPreview.followup)}
                </div>
              </div>
              <div>
                <div className="text-ink-secondary">Report</div>
                <div className="font-medium text-zinc-900">
                  {closeoutPreview.portal?.attached ? "Portal attached" : "Token-only"}
                </div>
              </div>
            </div>
            {billingBlocksClose && (
              <ActionFeedback error className="mt-2">
                Use the completion action to charge an authorized card on file, or send the invoice and hold the customer&apos;s {project.project_type === CERTIFICATE_TYPE ? "certificate" : "report"} until payment.
              </ActionFeedback>
            )}
            {followupBlocksClose && (
              <ActionFeedback error className="mt-2">
                Auto-schedule follow-up is not wired yet. Use alert follow-up or schedule the return manually before closing.
              </ActionFeedback>
            )}
            {previewBlocksClose && !billingBlocksClose && !followupBlocksClose && (
              <ActionFeedback error className="mt-2">
                This project cannot close from the linked service’s current state.
              </ActionFeedback>
            )}
            </CardBody>
          </Card>
        )}
        <ProjectHistoryPanel activity={data.activity || []} />{" "}
      </CardBody>
      {/* Signature capture is a FIELD action — the licensee signs at the
          inspection, and POST /:id/wdo-signature is requireTechOrAdmin — so
          it is deliberately NOT behind canAdminActions (Codex P2 on the
          tech in-place embed). Send/PDF/close stay admin-gated. */}
      {project.project_type === WDO_TYPE && project.status !== "closed" && (
        <div className="px-4">
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
        <div className="px-4 pb-3">
          <ActionFeedback error>
            Report held — the customer has the invoice and pay link, and the
            report is emailed automatically the moment the invoice is paid.
            &ldquo;Send report&rdquo; delivers it now and clears the hold.
            {project.report_hold_last_error ? (
              <span className="font-medium">
                Last automatic release attempt failed:{" "}
                {project.report_hold_last_error}
              </span>
            ) : null}
          </ActionFeedback>
        </div>
      )}
      {/* Footer actions */}
      <CardFooter className="flex flex-wrap items-center justify-end gap-2">
        {canAdminActions && reportHoldAvailable && project.status !== "closed" && (
          <Switch
            className="mr-auto"
            title={project.project_type === WDO_TYPE
              ? "Send the invoice + pay link now; the FDACS report is emailed automatically once the invoice is paid"
              : "Send the invoice + pay link now; the pre-treatment certificate is delivered automatically once the invoice is paid"}
            checked={holdReportUntilPaid}
            onChange={setHoldReportUntilPaid}
            disabled={saving}
            label="Hold report until invoice is paid"
          />
        )}
        {canAdminActions && !isOfficialTermiteDocument && (
          <Button
            variant="secondary"
            onClick={handleSendPortalInvite}
            disabled={saving}
          >
            <Mail size={16} />
            Portal invite
          </Button>
        )}
        {canAdminActions && !isOfficialTermiteDocument && (
          <Button
            variant="secondary"
            onClick={handleSendPrepGuide}
            disabled={saving || !hasPrepGuide}
            title={hasPrepGuide ? "Send prep guide" : "No default prep guide for this project type"}
          >
            <BookOpen size={16} />
            Prep guide
          </Button>
        )}
        {canAdminActions && project.status !== "closed" && (
          <Button
            variant="secondary"
            onClick={handleClose}
            disabled={saving || closeoutBlocksClose}
            title={
              billingBlocksClose
                ? "Send the invoice before closing"
                : followupBlocksClose
                  ? "Resolve follow-up automation before closing"
                  : previewBlocksClose
                    ? "Project cannot close from the current service state"
                  : "Close project"
            }
          >
            {billingBlocksClose
              ? "Send invoice first"
              : followupBlocksClose
                ? "Resolve follow-up first"
                : previewBlocksClose
                  ? "Cannot close"
                : "Close project"}
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={saveEdits}
          disabled={saving || !dirty}
        >
          {saving ? "Saving…" : "Save changes"}
        </Button>
        {canAdminActions &&
          project.status === "sent" &&
          project.status !== "closed" && (
            <Button
              onClick={handleSend}
              disabled={saving || wdoSendBlocked}
              title={wdoSendBlocked ? wdoSendBlockedTitle : undefined}
            >
              Resend report
            </Button>
          )}
        {canAdminActions &&
          project.status !== "sent" &&
          project.status !== "closed" && (
            <Button
              onClick={handleSend}
              disabled={saving || wdoSendBlocked}
              title={
                wdoSendBlocked
                  ? wdoSendBlockedTitle
                  : reportHeld
                    ? "Deliver the report now — this releases the payment hold"
                    : undefined
              }
            >
              {reportHeld ? "Send report now (release hold)" : "Send report"}
            </Button>
          )}
        {canAdminActions &&
          (project.project_type === WDO_TYPE ||
            project.project_type === CERTIFICATE_TYPE ||
            project.service_record_id) &&
          project.status !== "closed" && (
            <Button
              onClick={handleSendWithInvoice}
              disabled={saving || wdoSendBlocked}
              title={
                wdoSendBlocked
                  ? wdoSendBlockedTitle
                  : reportHoldAvailable
                    ? holdReportUntilPaid
                      ? project.project_type === WDO_TYPE
                        ? "Send the invoice and payment link now; release the FDACS-13645 report automatically after payment"
                        : "Send the invoice and payment link now; release the pre-treatment certificate automatically after payment"
                      : "Send the report and an invoice together via email + text"
                    : "Send the report and an invoice together via email + text"
              }
            >
              {reportHoldAvailable && holdReportUntilPaid
                ? "Send invoice & hold report"
                : "Send report + invoice"}
            </Button>
          )}
      </CardFooter>{" "}
      {confirmDialog}
    </Card>
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
      <div className="mb-2 text-ui-body font-medium text-zinc-900">
        History
      </div>
      {activity.length > 0 ? (
        <Card className="overflow-hidden">
          {activity.map((item, idx) => (
            <div
              key={item.id || `${item.action}-${item.created_at}-${idx}`}
              className={`${idx === 0 ? "" : "border-t border-zinc-200"} bg-white p-3`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-ui-body font-medium text-zinc-900">
                    {PROJECT_ACTIVITY_LABELS[item.action] || item.action}
                  </div>{" "}
                  <div className="mt-1 text-ui-body text-ink-secondary">
                    {item.description || "Project activity recorded."}
                  </div>
                  {item.actor_name && (
                    <div className="mt-1 text-ui-body text-ink-secondary">
                      By {item.actor_name}
                    </div>
                  )}
                </div>{" "}
                <div className="flex-shrink-0 text-right text-ui-body text-ink-secondary u-nums">
                  {fmtDateTime(item.created_at)}
                </div>{" "}
              </div>{" "}
            </div>
          ))}
        </Card>
      ) : (
        <div className="py-3 text-ui-body text-ink-secondary">
          No activity recorded yet.
        </div>
      )}
    </div>
  );
}

// Named export so the caption editor can be mounted standalone in tests and
// UI verification (the drawer needs a full project fixture to render).
export function PhotoThumb({ photo, projectId, onDelete, onCaptionSaved }) {
  const [url, setUrl] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // Inline caption editing — captions print on the FDACS photo addendum, and
  // the admin drawer previously had no way to add or fix one (office-added
  // photos landed on the legal PDF as bare "Service photo").
  const [editingCaption, setEditingCaption] = useState(false);
  const [captionDraft, setCaptionDraft] = useState(photo.caption || "");
  const [captionSaving, setCaptionSaving] = useState(false);

  async function saveCaption() {
    setCaptionSaving(true);
    try {
      const r = await adminFetch(`/admin/projects/${projectId}/photos/${photo.id}`, {
        method: "PUT",
        body: { caption: captionDraft.slice(0, 200) },
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || "Could not save caption");
      }
      setEditingCaption(false);
      await onCaptionSaved?.();
    } catch {
      // keep the editor open so the admin can retry
    } finally {
      setCaptionSaving(false);
    }
  }
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
    <div className="relative aspect-square overflow-hidden rounded-md border-hairline border-zinc-200 bg-zinc-100">
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="block h-full w-full u-focus-ring"
        >
          {" "}
          <img
            src={url}
            alt={photo.caption || photo.category || "Photo"}
            className="h-full w-full object-cover"
          />{" "}
        </a>
      ) : (
        <div className="flex h-full w-full items-center justify-center text-ui-body text-ink-secondary">
          {loadFailed ? "Photo unavailable" : "Loading…"}
        </div>
      )}
      <div
        className={`absolute inset-x-0 bottom-0 bg-black/70 px-2 py-2 text-ui-body font-medium text-white ${
          editingCaption ? "space-y-2" : "flex min-h-11 items-center justify-between gap-1"
        }`}
      >
        {" "}
        {editingCaption ? (
          <>
            <Input
              type="text"
              value={captionDraft}
              maxLength={200}
              autoFocus
              onChange={(e) => setCaptionDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveCaption();
                if (e.key === "Escape") setEditingCaption(false);
              }}
              placeholder="Photo caption"
              className="w-full min-w-0"
            />
            <div className="flex justify-end gap-1">
              <Button
                variant="ghost"
                onClick={saveCaption}
                disabled={captionSaving}
                className="ui-icon-action text-white hover:bg-white/10"
                aria-label="Save caption"
              >
                ✓
              </Button>
              <Button
                variant="ghost"
                onClick={() => setEditingCaption(false)}
                disabled={captionSaving}
                className="ui-icon-action text-white hover:bg-white/10"
                aria-label="Cancel caption edit"
              >
                ✕
              </Button>
            </div>
          </>
        ) : (
          <>
            <span title={photo.caption || undefined} className="overflow-hidden text-ellipsis whitespace-nowrap">
              {photo.caption || (photo.category || "").replace(/_/g, " ")}
            </span>{" "}
            <Button
              variant="ghost"
              onClick={(e) => {
                e.preventDefault();
                setCaptionDraft(photo.caption || "");
                setEditingCaption(true);
              }}
              className="ui-icon-action text-white hover:bg-white/10"
              aria-label="Edit caption"
            >
              ✎
            </Button>
            <Button
              variant="ghost"
              onClick={(e) => {
                e.preventDefault();
                onDelete();
              }}
              className="ui-icon-action text-white hover:bg-white/10"
              aria-label="Remove photo"
            >
              ×
            </Button>
          </>
        )}{" "}
      </div>{" "}
    </div>
  );
}

function ReadinessPanel({ readiness }) {
  const complete = readiness.missing.length === 0;
  const hasQualityNotes = readiness.quality.length > 0;
  return (
    <Card className={complete && !hasQualityNotes ? "bg-zinc-50" : "border-alert-fg"}>
      <CardBody>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-ui-body font-medium text-zinc-900">
            Pre-send review
          </div>{" "}
          <div className="mt-1 text-ui-body text-ink-secondary">
            {complete
              ? "Required report details are present."
              : `${readiness.missing.length} required item${readiness.missing.length === 1 ? "" : "s"} still need attention.`}
          </div>{" "}
        </div>{" "}
        <Badge tone={complete && !hasQualityNotes ? "strong" : "alert"}>
          {complete && !hasQualityNotes ? "Ready" : "Review"}
        </Badge>{" "}
      </div>{" "}
      <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
        {readiness.required.map((item) => (
          <div
            key={item.label}
            className={`rounded-sm border-hairline p-2 text-ui-body ${item.ok ? "border-zinc-200 bg-white text-zinc-700" : "border-alert-fg bg-white text-alert-fg"}`}
          >
            {item.ok ? "Done" : "Missing"}: {item.label}
          </div>
        ))}
      </div>
      {hasQualityNotes && (
        <div className="mt-3 flex flex-col gap-2">
          {readiness.quality.map((note) => (
            <div key={note} className="text-ui-body text-ink-secondary">
              Review: {note}
            </div>
          ))}
        </div>
      )}
      </CardBody>
    </Card>
  );
}

function Alert({ tone = "success", children }) {
  return <ActionFeedback error={tone === "error"}>{children}</ActionFeedback>;
}

function DeliveryPanel({ channels, status }) {
  const entries = Object.entries(channels || {});
  if (!entries.length) return null;
  return (
    <Card className="bg-zinc-50"><CardBody>
      <div className="mb-2 text-ui-body font-medium text-zinc-900">
        Delivery status{status ? `: ${String(status).replace(/_/g, " ")}` : ""}
      </div>{" "}
      <div className="flex flex-col gap-2">
        {entries.map(([channel, result]) => (
          <div key={channel} className="flex justify-between gap-3 text-ui-body">
            {" "}
            <span className="font-medium capitalize text-zinc-900">
              {channel}
            </span>{" "}
            <span className={`text-right ${result?.ok ? "text-zinc-700" : "text-alert-fg"}`}>
              {result?.ok ? "Sent" : result?.error || "Failed"}
            </span>{" "}
          </div>
        ))}
      </div>{" "}
    </CardBody></Card>
  );
}
