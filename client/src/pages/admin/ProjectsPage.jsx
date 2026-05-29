import { useEffect, useState, useCallback } from "react";
import { BookOpen, Calendar, ClipboardList, Mail, Plus } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { adminFetch } from "../../lib/adminFetch";
import CreateProjectModal from "../../components/tech/CreateProjectModal";
import WdoIntelligenceBar from "../../components/tech/WdoIntelligenceBar";
import WdoSignaturePad from "../../components/tech/WdoSignaturePad";
import useIsMobile from "../../hooks/useIsMobile";
import { applyProfileToWdoFindings, applyHistoryToWdoFindings } from "../../lib/wdoProfileToFindings";
import ProjectFindingFieldInput, { hasCatalogBackedProjectFields } from "../../components/tech/ProjectFindingFieldInput";
import { COLORS, FONTS } from "../../theme-brand";

/**
 * Projects — post-service inspection / documentation reports.
 *
 * Tier 2 light zinc palette. Techs create drafts from /tech; admin reviews,
 * edits findings, manages optional photos, and presses Send to generate the
 * customer-facing /report/project/:token link.
 */

const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "#E4E4E7",
  heading: "#09090B",
  text: "#27272A",
  muted: "#71717A",
  accent: "#18181B",
  accentHover: "#27272A",
  success: "#15803D",
  amber: "#A16207",
  red: "#991B1B",
  inputBorder: "#D4D4D8",
  pill: "#F4F4F5",
};

const MONO = "'JetBrains Mono', monospace";
const ESTIMATE_BG = "#FAF8F3";
const ESTIMATE_BORDER = "#E7E2D7";
const ESTIMATE_INPUT_BORDER = "#CFE7F5";
const ESTIMATE_INPUT_BG = "#F8FCFE";
const ESTIMATE_TEXT = COLORS.blueDeeper;
const ESTIMATE_MUTED = "#6B7280";

const STATUS_STYLES = {
  draft: { bg: "#FEF3C7", fg: "#92400E", label: "Draft" },
  sent: { bg: "#DCFCE7", fg: "#166534", label: "Sent" },
  closed: { bg: "#E4E4E7", fg: "#52525B", label: "Closed" },
};

const TYPE_LABELS = {
  wdo_inspection: "WDO",
  termite_inspection: "Termite",
  termite_treatment: "Termite Treatment",
  pest_inspection: "Pest",
  one_time_pest_treatment: "One-Time Pest",
  one_time_lawn_treatment: "One-Time Lawn",
  flea: "Flea",
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

function formatProjectAppointmentWindow(appt) {
  if (!appt) return "";
  const date = formatProjectAppointmentDate(appt.scheduledDate);
  const start = formatProjectAppointmentTime(appt.windowStart);
  const end = formatProjectAppointmentTime(appt.windowEnd);
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
  if (isCertificate) {
    const productName = findings?.product_name === "Other"
      ? findings?.product_name_other
      : findings?.product_name;
    const rawMethod = findings?.treatment_method;
    const treatmentMethod = rawMethod === "Other"
      ? findings?.treatment_method_other
      : rawMethod;
    // Mirror server-side method-aware coverage requirements in
    // server/routes/admin-projects.js — bait systems have no gallons, borate
    // wood treatments may not either.
    const isBaitSystem = rawMethod === "Bait system";
    const isWoodTreatment = rawMethod === "Wood treatment (borate)";
    const needsGallons = !isBaitSystem && !isWoodTreatment;
    const hasArea =
      hasMeaningfulValue(findings?.square_footage) ||
      hasMeaningfulValue(findings?.linear_feet);
    const coverageOk = needsGallons
      ? hasArea && hasMeaningfulValue(findings?.gallons_applied)
      : hasArea;
    const coverageLabel = needsGallons
      ? "Coverage + gallons applied"
      : "Coverage (sq ft or linear ft)";
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
      {
        label: "Method of treatment",
        ok: hasMeaningfulValue(treatmentMethod),
      },
      {
        label: "Product used",
        ok: hasMeaningfulValue(productName),
      },
      {
        label: "Active ingredient + concentration",
        ok:
          hasMeaningfulValue(findings?.active_ingredient) &&
          hasMeaningfulValue(findings?.concentration_pct),
      },
      {
        label: coverageLabel,
        ok: coverageOk,
      },
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
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
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
  const reportTitle = String(title || "").trim() || typeLabel;
  const findingsEntries = Object.entries(findings || {}).filter(([, v]) =>
    hasMeaningfulValue(formatProjectPreviewValue(v)),
  );
  const visiblePhotos = (photos || []).slice(0, 4);
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
                      {formatProjectPreviewValue(value)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {recommendations ? (
            <ProjectPreviewRecommendationsBlock
              text={recommendations}
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
    <div
      style={{
        maxWidth: 1300,
        margin: "0 auto",
        color: D.text,
        fontFamily: "'Roboto', Arial, sans-serif",
      }}
    >
      {" "}
      <AdminCommandHeader
        title="Projects"
        icon={ClipboardList}
        action={{
          label: "New Project",
          icon: Plus,
          onClick: () => setCreateMode("general"),
        }}
      />
      {/* Filters */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 12,
          background: D.card,
          padding: "10px 12px",
          borderRadius: 10,
          border: `1px solid ${D.border}`,
        }}
      >
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
              <div style={{ padding: 24, color: D.muted }}>Loading…</div>
            ) : regularProjects.length === 0 ? (
              <div
                style={{
                  padding: 24,
                  background: D.card,
                  borderRadius: 10,
                  border: `1px dashed ${D.border}`,
                  color: D.muted,
                  textAlign: "center",
                }}
              >
                No projects match these filters.
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
              onCreate={() => setCreateMode("wdo")}
            />
          )}
        </div>
        {/* Detail */}
        {selected && (
          <ProjectDetail
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
          defaultProjectType={createMode === "wdo" ? WDO_TYPE : ""}
          allowedProjectTypes={
            createMode === "wdo" ? [WDO_TYPE] : GENERAL_PROJECT_TYPES
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

function WdoReportsSection({ projects, selectedId, onSelect, onCreate }) {
  const urgentCount = projects.filter((p) => {
    if (p.status === "sent" || p.status === "closed") return false;
    const created = p.created_at ? new Date(p.created_at).getTime() : 0;
    return created && Date.now() - created > 24 * 60 * 60 * 1000;
  }).length;

  return (
    <section
      style={{
        marginTop: 18,
        paddingTop: 16,
        borderTop: `1px solid ${D.border}`,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {" "}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        {" "}
        <div>
          {" "}
          <div
            style={{
              fontSize: 11,
              fontWeight: 800,
              color: D.muted,
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            WDO Inspection Reports
          </div>{" "}
          <div style={{ fontSize: 13, color: D.text, marginTop: 3 }}>
            Real-estate reports, realtor sharing, and closing-sensitive
            documentation.
          </div>
          {urgentCount > 0 && (
            <div
              style={{
                fontSize: 11,
                color: D.amber,
                marginTop: 4,
                fontWeight: 700,
              }}
            >
              {urgentCount} draft{urgentCount === 1 ? "" : "s"} older than 24h
            </div>
          )}
        </div>{" "}
        <button
          type="button"
          onClick={onCreate}
          style={{
            ...btnSecondary,
            padding: "7px 10px",
            fontSize: 11,
            fontWeight: 800,
            whiteSpace: "nowrap",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          + New WDO
        </button>{" "}
      </div>
      {projects.length === 0 ? (
        <div
          style={{
            padding: 18,
            background: D.card,
            borderRadius: 10,
            border: `1px dashed ${D.border}`,
            color: D.muted,
            fontSize: 12,
            textAlign: "center",
          }}
        >
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
  return (
    <select
      value={value}
      onChange={onChange}
      style={{
        padding: "6px 28px 6px 12px",
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 600,
        color: value ? D.text : D.muted,
        background: D.card,
        border: `1px solid ${D.inputBorder}`,
        cursor: "pointer",
        appearance: "none",
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2371717A' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 10px center",
      }}
    >
      {children}
    </select>
  );
}

function ProjectRow({ project, active, onSelect, compactType }) {
  const status = STATUS_STYLES[project.status] || STATUS_STYLES.draft;
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        textAlign: "left",
        width: "100%",
        cursor: "pointer",
        background: D.card,
        border: `1px solid ${active ? D.accent : D.border}`,
        borderRadius: 10,
        padding: "12px 14px",
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
      }}
    >
      {" "}
      <div
        style={{
          flexShrink: 0,
          width: 48,
          height: 48,
          borderRadius: 8,
          background: D.pill,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: MONO,
          fontSize: 11,
          fontWeight: 700,
          color: D.heading,
        }}
      >
        {compactType || TYPE_LABELS[project.project_type] || "Proj"}
      </div>{" "}
      <div style={{ flex: 1, minWidth: 0 }}>
        {" "}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: D.heading,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {project.customer_name || "Customer"}
          </div>{" "}
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: "2px 8px",
              borderRadius: 999,
              background: status.bg,
              color: status.fg,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              whiteSpace: "nowrap",
            }}
          >
            {status.label}
          </span>{" "}
        </div>{" "}
        <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>
          {project.title ||
            TYPE_LABELS[project.project_type] ||
            project.project_type}
        </div>{" "}
        <div
          style={{
            display: "flex",
            gap: 10,
            marginTop: 6,
            fontSize: 11,
            color: D.muted,
          }}
        >
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

function ProjectDetail({
  projectId,
  typesRegistry,
  onClose,
  onChanged,
  canAdminActions = false,
}) {
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

  async function load(options = {}) {
    const { preserveEdits = false } = options;
    setLoading(true);
    setError("");
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
      setError(e.message || "Could not load project");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(); /* eslint-disable-next-line */
  }, [projectId]);

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
    if (readiness.missing.length || readiness.quality.length) {
      const lines = [
        ...readiness.missing.map((item) => `Missing: ${item.label}`),
        ...readiness.quality.map((item) => `Review: ${item}`),
      ];
      if (
        !confirm(
          `This report has items to review before sending:\n\n${lines.join("\n")}\n\nSend anyway?`,
        )
      )
        return;
    }
    let overrideReason = "";
    if (readiness.missing.length) {
      overrideReason =
        window
          .prompt(
            "Enter the admin override reason for sending this incomplete report:",
          )
          ?.trim() || "";
      if (!overrideReason) return;
    }
    const actionLabel =
      project.status === "sent"
        ? "Resend report to customer?"
        : "Send report to customer? This generates a public link and marks the project as Sent.";
    if (!confirm(actionLabel)) return;
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
    let overrideReason = "";
    if (readiness.missing.length) {
      const lines = readiness.missing.map((item) => `Missing: ${item.label}`);
      if (!confirm(`This report has items to review before sending:\n\n${lines.join("\n")}\n\nSend anyway?`)) return;
      overrideReason =
        window.prompt("Enter the admin override reason for sending this incomplete report:")?.trim() || "";
      if (!overrideReason) return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await saveDirtyProjectEdits("Could not save project before sending");
      // dry_run first so the operator can confirm the invoice amount.
      const preview = await adminFetch(`/admin/projects/${projectId}/send-with-invoice`, {
        method: "POST",
        body: { dry_run: true, ...(overrideReason ? { override_reason: overrideReason } : {}) },
      });
      const pv = await readJsonResponse(preview, "Could not prepare invoice");
      const inv = pv.invoice || {};
      const amount = inv.total != null ? `$${Number(inv.total).toFixed(2)}` : "the amount shown";
      const verb = inv.created ? "Create and send" : "Send";
      if (
        !confirm(
          `${verb} invoice ${inv.invoice_number || ""} for ${amount} together with the WDO report?\n\n` +
            `The customer gets one email (FDACS-13645 report PDF + invoice PDF) and one text (report + pay links).`,
        )
      ) {
        setSaving(false);
        return;
      }
      const r = await adminFetch(`/admin/projects/${projectId}/send-with-invoice`, {
        method: "POST",
        body: {
          invoice_id: inv.id,
          ...(overrideReason ? { override_reason: overrideReason } : {}),
        },
      });
      const d = await readJsonResponse(r, "Could not send report + invoice");
      if (d.report_url) setSentLink(`${window.location.origin}${d.report_url}`);
      setDelivery(d.channels || null);
      if (d.sent === false) {
        setError(`Delivery failed; project remains in review. ${deliverySummary(d.channels)}`.trim());
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
    if (!confirm("Send the prep guide email for this project?")) return;
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
    if (!confirm("Send a customer portal invite email for this project?")) return;
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
      !confirm(
        "Replace the current Recommendations text with an AI-drafted version?\n\nThe tech's original notes will still be used as context for the AI.",
      )
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
    if (billingBlocksClose) {
      setError(
        `${closeoutBillingLabel(closeoutPreview.billing)}. Create or collect the invoice before closing this project.`,
      );
      return;
    }
    if (followupBlocksClose) {
      setError(
        "Auto-schedule follow-up is not available yet. Change the follow-up policy to alert or schedule the follow-up manually before closing.",
      );
      return;
    }
    if (previewBlocksClose) {
      const status = closeoutPreview?.serviceCompletion?.status;
      setError(
        status
          ? `This project cannot close while the linked service is ${status}.`
          : "This project cannot close from its current service state.",
      );
      return;
    }
    const closeoutLines = [
      closeoutPreview?.serviceCompletion?.willCompleteService
        ? `Service: complete ${closeoutPreview.serviceCompletion.serviceType || "linked service"}`
        : null,
      closeoutPreview?.billing ? `Billing: ${closeoutBillingLabel(closeoutPreview.billing)}` : null,
      closeoutPreview?.followup ? `Follow-up: ${closeoutFollowupLabel(closeoutPreview.followup)}` : null,
      closeoutPreview?.portal
        ? `Portal: ${closeoutPreview.portal.attached ? "attached" : "token-only"}`
        : null,
    ].filter(Boolean);
    const confirmText = [
      "Close this project? It stays accessible but is filtered out of Sent view.",
      closeoutLines.length ? `\n${closeoutLines.join("\n")}` : "",
    ].join("");
    if (!confirm(confirmText))
      return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const r = await adminFetch(`/admin/projects/${projectId}/close`, {
        method: "POST",
      });
      const d = await readJsonResponse(r, "Could not close project");
      await load();
      onChanged?.();
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
      setNotice(`Project closed.${serviceText}${portalText}${followupText}`);
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
    if (!confirm("Remove this photo?")) return;
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
          background: D.card,
          border: `1px solid ${D.border}`,
          borderRadius: 10,
          padding: 24,
          color: D.muted,
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
        borderRadius: 16,
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
          background: COLORS.white,
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
              fontWeight: 800,
            }}
          >
            {typeCfg?.label || project.project_type} · {project.customer_name}
          </div>{" "}
          <div
            style={{
              fontFamily: FONTS.serif,
              fontSize: 32,
              fontWeight: 500,
              color: ESTIMATE_TEXT,
              marginTop: 4,
              lineHeight: 1.1,
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
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                padding: "2px 8px",
                borderRadius: 999,
                background: status.bg,
                color: status.fg,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              {status.label}
            </span>{" "}
            <span style={{ fontSize: 11, color: D.muted }}>
              Inspection {fmtDate(project.project_date || project.created_at)}{" "}
              by {project.tech_name || "—"}
            </span>
            {project.sent_at && (
              <span style={{ fontSize: 11, color: D.muted }}>
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
            color: D.muted,
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
              background: "#ECFDF5",
              border: `1px solid #A7F3D0`,
              borderRadius: 8,
              fontSize: 12,
              color: D.heading,
            }}
          >
            {" "}
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
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
                style={{ color: "#065F46" }}
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
              background: D.pill,
              border: `1px solid ${D.border}`,
              borderRadius: 8,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
            }}
          >
            {" "}
            <div>
              {" "}
              <div style={{ fontSize: 12, fontWeight: 800, color: D.heading }}>
                FDACS-13645 WDO form
              </div>{" "}
              <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>
                Use this as the official inspection template and review copy.
              </div>{" "}
            </div>{" "}
            <a
              href="/forms/fdacs-13645-wdo-inspection-report.pdf"
              target="_blank"
              rel="noreferrer"
              style={{
                flexShrink: 0,
                padding: "7px 10px",
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 800,
                color: D.heading,
                textDecoration: "none",
                background: D.card,
                border: `1px solid ${D.inputBorder}`,
              }}
            >
              Open PDF
            </a>{" "}
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
            Inspection / project date
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
            style={inputStyle}
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
              card: D.card,
              bg: D.pill,
              border: D.border,
              heading: D.heading,
              text: D.text,
              muted: D.muted,
              accent: D.accent,
              accentText: "#fff",
              red: D.red,
            }}
          />
        )}
        {/* Type-specific findings */}
        {typeCfg?.findingsFields?.map((field) => (
          <div key={field.key}>
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
              <Label
                htmlFor={fieldInputId(field.key)}
                style={{ marginBottom: 0 }}
              >
                {field.label}
              </Label>
              {project.project_type === WDO_TYPE &&
                field.key === "property_address" &&
                formatProjectCustomerAddress(project) && (
                  <button
                    type="button"
                    onClick={fillWdoAddressFromCustomer}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: D.accent,
                      fontSize: 11,
                      fontWeight: 800,
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
                  fontWeight: 700,
                  background: aiWriting ? D.muted : D.card,
                  color: D.heading,
                  border: `1px solid ${D.inputBorder}`,
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
                color: D.muted,
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
                  border: `1px solid ${D.inputBorder}`,
                  background: D.card,
                  color: D.heading,
                  fontSize: 11,
                  fontWeight: 700,
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
                fontWeight: 700,
                background: D.accent,
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
                color: D.muted,
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
              border: `1px solid ${closeoutBlocksClose ? "#FCA5A5" : D.border}`,
              background: closeoutBlocksClose ? "#FEF2F2" : "#F8FAFC",
              borderRadius: 8,
              padding: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: D.heading,
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
                <div style={{ color: D.muted, fontSize: 11, fontWeight: 800 }}>
                  Service
                </div>
                <div style={{ color: D.heading, fontWeight: 800 }}>
                  {closeoutPreview.serviceCompletion?.willCompleteService
                    ? `Complete ${closeoutPreview.serviceCompletion.serviceType || "linked service"}`
                    : closeoutPreview.serviceCompletion?.linked
                      ? "No service completion"
                      : "Project only"}
                </div>
              </div>
              <div>
                <div style={{ color: D.muted, fontSize: 11, fontWeight: 800 }}>
                  Billing
                </div>
                <div
                  style={{
                    color: billingBlocksClose ? D.red : D.heading,
                    fontWeight: 800,
                  }}
                >
                  {closeoutBillingLabel(closeoutPreview.billing)}
                </div>
              </div>
              <div>
                <div style={{ color: D.muted, fontSize: 11, fontWeight: 800 }}>
                  Follow-up
                </div>
                <div style={{ color: followupBlocksClose ? D.red : D.heading, fontWeight: 800 }}>
                  {closeoutFollowupLabel(closeoutPreview.followup)}
                </div>
              </div>
              <div>
                <div style={{ color: D.muted, fontSize: 11, fontWeight: 800 }}>
                  Report
                </div>
                <div style={{ color: D.heading, fontWeight: 800 }}>
                  {closeoutPreview.portal?.attached ? "Portal attached" : "Token-only"}
                </div>
              </div>
            </div>
            {billingBlocksClose && (
              <div style={{ marginTop: 8, color: D.red, fontSize: 12, fontWeight: 750 }}>
                Resolve billing before closing. The project can stay in review until the invoice or prepaid coverage exists.
              </div>
            )}
            {followupBlocksClose && (
              <div style={{ marginTop: 8, color: D.red, fontSize: 12, fontWeight: 750 }}>
                Auto-schedule follow-up is not wired yet. Use alert follow-up or schedule the return manually before closing.
              </div>
            )}
            {previewBlocksClose && !billingBlocksClose && !followupBlocksClose && (
              <div style={{ marginTop: 8, color: D.red, fontSize: 12, fontWeight: 750 }}>
                This project cannot close from the linked service’s current state.
              </div>
            )}
          </div>
        )}
        <ProjectHistoryPanel activity={data.activity || []} />{" "}
      </div>
      {canAdminActions && project.project_type === WDO_TYPE && project.status !== "closed" && (
        <div style={{ padding: "0 16px" }}>
          <WdoSignaturePad
            projectId={project.id}
            signature={project.wdo_signature}
            defaultSignerName={project.tech_name || ""}
            onChanged={() => load({ preserveEdits: true })}
          />
        </div>
      )}
      {/* Footer actions */}
      <div
        style={{
          padding: "12px 16px",
          borderTop: `1px solid ${D.border}`,
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          justifyContent: "flex-end",
          alignItems: "center",
        }}
      >
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
              title={wdoNeedsSignature ? "Capture the licensee signature first" : undefined}
            >
              Send report
            </button>
          )}
        {canAdminActions &&
          project.project_type === WDO_TYPE &&
          project.status !== "closed" && (
            <button
              type="button"
              onClick={handleSendWithInvoice}
              disabled={saving || wdoNeedsSignature}
              style={{ ...btnPrimary, opacity: saving || wdoNeedsSignature ? 0.5 : 1 }}
              title={wdoNeedsSignature ? "Capture the licensee signature first" : "Send the filled FDACS-13645 report and an invoice together via email + text"}
            >
              Send report + invoice
            </button>
          )}
      </div>{" "}
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
          fontWeight: 800,
          color: D.heading,
          marginBottom: 8,
        }}
      >
        History
      </div>
      {activity.length > 0 ? (
        <div
          style={{
            border: `1px solid ${D.border}`,
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          {activity.map((item, idx) => (
            <div
              key={item.id || `${item.action}-${item.created_at}-${idx}`}
              style={{
                padding: "10px 12px",
                borderTop: idx === 0 ? "none" : `1px solid ${D.border}`,
                background: D.card,
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
                    style={{ fontSize: 14, fontWeight: 800, color: D.heading }}
                  >
                    {PROJECT_ACTIVITY_LABELS[item.action] || item.action}
                  </div>{" "}
                  <div style={{ fontSize: 14, color: D.muted, marginTop: 2 }}>
                    {item.description || "Project activity recorded."}
                  </div>
                  {item.actor_name && (
                    <div style={{ fontSize: 14, color: D.muted, marginTop: 4 }}>
                      By {item.actor_name}
                    </div>
                  )}
                </div>{" "}
                <div
                  style={{
                    flexShrink: 0,
                    fontSize: 14,
                    color: D.muted,
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
        <div style={{ padding: "12px 0", fontSize: 14, color: D.muted }}>
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
        background: D.pill,
        borderRadius: 8,
        border: `1px solid ${D.border}`,
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
            color: D.muted,
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
          fontWeight: 600,
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
        padding: "10px 12px",
        background: complete && !hasQualityNotes ? "#ECFDF5" : "#FFFBEB",
        border: `1px solid ${complete && !hasQualityNotes ? "#A7F3D0" : "#FDE68A"}`,
        borderRadius: 8,
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
          <div style={{ fontSize: 12, fontWeight: 800, color: D.heading }}>
            Pre-send review
          </div>{" "}
          <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>
            {complete
              ? "Required report details are present."
              : `${readiness.missing.length} required item${readiness.missing.length === 1 ? "" : "s"} still need attention.`}
          </div>{" "}
        </div>{" "}
        <span
          style={{
            flexShrink: 0,
            fontSize: 10,
            fontWeight: 800,
            color: complete && !hasQualityNotes ? "#065F46" : "#92400E",
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
              color: item.ok ? "#166534" : "#92400E",
              background: item.ok ? "#F0FDF4" : "#FEF3C7",
              border: `1px solid ${item.ok ? "#BBF7D0" : "#FDE68A"}`,
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
              style={{ fontSize: 11, color: "#92400E", lineHeight: 1.4 }}
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
        padding: "9px 12px",
        background: isError ? "#FEF2F2" : "#ECFDF5",
        border: `1px solid ${isError ? "#FECACA" : "#A7F3D0"}`,
        borderRadius: 8,
        color: isError ? D.red : "#065F46",
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
        background: D.pill,
        border: `1px solid ${D.border}`,
        borderRadius: 8,
      }}
    >
      {" "}
      <div
        style={{
          fontSize: 12,
          fontWeight: 800,
          color: D.heading,
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
                color: D.text,
                fontWeight: 700,
                textTransform: "uppercase",
              }}
            >
              {channel}
            </span>{" "}
            <span
              style={{
                color: result?.ok ? D.success : D.red,
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
        fontWeight: 800,
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
  minHeight: 48,
  background: ESTIMATE_INPUT_BG,
  color: ESTIMATE_TEXT,
  border: `1px solid ${ESTIMATE_INPUT_BORDER}`,
  borderRadius: 10,
  padding: "12px 14px",
  fontSize: 15,
  fontWeight: 500,
  boxSizing: "border-box",
  fontFamily: FONTS.body,
  outline: "none",
};

const btnPrimary = {
  minHeight: 48,
  padding: "0 18px",
  borderRadius: 10,
  fontSize: 14,
  fontWeight: 700,
  background: ESTIMATE_TEXT,
  color: "#fff",
  border: "none",
  cursor: "pointer",
};
const btnSecondary = {
  minHeight: 48,
  padding: "0 16px",
  borderRadius: 10,
  fontSize: 14,
  fontWeight: 600,
  background: COLORS.white,
  color: ESTIMATE_TEXT,
  border: `1px solid ${ESTIMATE_BORDER}`,
  cursor: "pointer",
};
