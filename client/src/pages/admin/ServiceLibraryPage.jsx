import { useState, useEffect, useCallback, useId } from "react";
import { useSearchParams } from "react-router-dom";
import { Library, Percent, Plus } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { DiscountsSection } from "./DiscountsTabs";
import useIsMobile from "../../hooks/useIsMobile";
import MobileServiceLibrary from "../../components/admin/MobileServiceLibrary";
import { SERVICE_CATEGORIES as CATEGORIES } from "../../constants/serviceCategories";

const API = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: teal/purple fold to zinc-900. Semantic green/amber/red preserved.
const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "#E4E4E7",
  teal: "#18181B",
  green: "#15803D",
  amber: "#A16207",
  red: "#991B1B",
  purple: "#18181B",
  text: "#27272A",
  muted: "#71717A",
  white: "#FFFFFF",
  input: "#FFFFFF",
  heading: "#09090B",
  inputBorder: "#D4D4D8",
  railBg: "#FAFAFA",
  selected: "#18181B",
  selectedFg: "#FAFAFA",
};

async function aFetch(path, opts = {}) {
  const r = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...opts,
  });
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    throw new Error(body?.error || `HTTP ${r.status}`);
  }
  return r.json();
}

const sCard = {
  background: D.card,
  border: `1px solid ${D.border}`,
  borderRadius: 12,
  padding: 16,
};
const sInput = {
  padding: "8px 12px",
  background: D.input,
  border: `1px solid ${D.border}`,
  borderRadius: 8,
  color: D.text,
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
  width: "100%",
};
const sBtn = (bg, color) => ({
  padding: "8px 16px",
  background: bg,
  color,
  border: "none",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
});

const EMPTY_SVC = {
  name: "",
  service_key: "",
  short_name: "",
  description: "",
  internal_notes: "",
  category: "pest_control",
  subcategory: "",
  billing_type: "recurring",
  is_waveguard: false,
  default_duration_minutes: 60,
  scheduling_buffer_minutes: 0,
  requires_follow_up: false,
  follow_up_interval_days: "",
  frequency: "",
  visits_per_year: "",
  pricing_type: "variable",
  base_price: "",
  pricing_model_key: "",
  is_taxable: false,
  tax_service_key: "",
  requires_license: false,
  license_category: "",
  min_tech_skill_level: 1,
  requires_service_report: true,
  requires_application_log: false,
  required_photo_count: 0,
  requires_customer_signature: false,
  requires_customer_notice: false,
  closeout_requirements_source: "inferred_v1",
  customer_visible: true,
  booking_enabled: true,
  sort_order: 100,
  icon: "",
  color: "#18181B",
  is_active: true,
};

const CLOSEOUT_REQUIREMENT_FIELDS = [
  "requires_service_report",
  "requires_application_log",
  "required_photo_count",
  "requires_customer_signature",
  "requires_customer_notice",
  "closeout_requirements_source",
];

// Visible name with the legacy "WaveGuard" suffix stripped (it's been getting
// jammed into the name string; we surface it as a pill instead).
function cleanName(svc) {
  return String(svc?.name || "")
    .replace(/\s*WaveGuard\s*$/i, "")
    .trim();
}

function parseProducts(svc) {
  const p = svc?.default_products;
  if (Array.isArray(p)) return p;
  if (typeof p === "string") {
    try {
      return JSON.parse(p);
    } catch {
      return [];
    }
  }
  return [];
}

function frequencyLabel(f) {
  if (!f) return "";
  return (
    {
      monthly: "Monthly",
      every_6_weeks: "Every 6 wk",
      bimonthly: "Bi-monthly",
      quarterly: "Quarterly",
      semiannual: "Semiannual",
      annual: "Annual",
    }[f] || f
  );
}

function billingLabel(b) {
  return b === "one_time"
    ? "One-Time"
    : b === "recurring"
      ? "Recurring"
      : b === "free"
        ? "Free"
        : b || "—";
}

function priceLabel(svc) {
  const p = Number(svc?.base_price || 0);
  if (svc?.pricing_type === "variable" || svc?.pricing_type === "quoted")
    return p ? `$${p.toFixed(0)}` : "Variable";
  return p ? `$${p.toFixed(0)}` : "—";
}

function categoryLabel(value) {
  return (
    (CATEGORIES.find((c) => c.value === value) || {}).label || value || "—"
  );
}

function closeoutRequirementLabels(svc) {
  return [
    svc?.requires_service_report !== false && "Service report",
    svc?.requires_application_log && "Application/material log",
    Number(svc?.required_photo_count || 0) > 0 && `${Number(svc.required_photo_count)} photo${Number(svc.required_photo_count) === 1 ? "" : "s"}`,
    svc?.requires_customer_signature && "Customer signature",
    svc?.requires_customer_notice && "Customer notice",
  ].filter(Boolean);
}

function Field({ label, children, half, htmlFor }) {
  return (
    <div
      style={{
        flex: half ? "1 1 48%" : "1 1 100%",
        minWidth: half ? 140 : 0,
        marginBottom: 10,
      }}
    >
      {" "}
      <label
        htmlFor={htmlFor}
        style={{
          fontSize: 11,
          color: D.muted,
          marginBottom: 3,
          display: "block",
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function ServiceForm({ svc, onSave, onCancel, isNew }) {
  const rawFormId = useId().replace(/:/g, "");
  const fieldId = (key) => `${rawFormId}-${key}`;
  const [form, setForm] = useState({ ...EMPTY_SVC, ...svc });
  const [closeoutTouched, setCloseoutTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));
  const setCloseout = (k, v) => {
    setCloseoutTouched(true);
    setForm((prev) => ({
      ...prev,
      [k]: v,
      closeout_requirements_source: "manual",
    }));
  };

  const submit = async () => {
    if (!String(form.name || "").trim()) {
      setError("Service name is required");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload = { ...form };
      if (isNew && !closeoutTouched) {
        CLOSEOUT_REQUIREMENT_FIELDS.forEach((key) => delete payload[key]);
      }
      await onSave(payload);
    } catch (e) {
      setError(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const inp = (key, type = "text", extra = {}) => (
    <input
      id={fieldId(key)}
      name={key}
      style={{
        ...sInput,
        ...(extra.disabled ? { opacity: 0.75, cursor: "not-allowed" } : {}),
      }}
      type={type}
      required={key === "name"}
      value={form[key] ?? ""}
      disabled={extra.disabled}
      title={extra.title}
      onChange={(e) =>
        set(
          key,
          type === "number"
            ? e.target.value === ""
              ? ""
              : Number(e.target.value)
            : e.target.value,
        )
      }
    />
  );
  const sel = (key, options) => (
    <select
      id={fieldId(key)}
      name={key}
      style={sInput}
      value={form[key] || ""}
      onChange={(e) => set(key, e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
  const chk = (key, label) => {
    const id = fieldId(key);
    return (
      <label
        htmlFor={id}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 13,
          color: D.text,
          cursor: "pointer",
        }}
      >
        {" "}
        <input
          id={id}
          name={key}
          type="checkbox"
          checked={!!form[key]}
          onChange={(e) => set(key, e.target.checked)}
        />
        {label}
      </label>
    );
  };
  const closeoutChk = (key, label) => {
    const id = fieldId(key);
    return (
      <label
        htmlFor={id}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 13,
          color: D.text,
          cursor: "pointer",
        }}
      >
        {" "}
        <input
          id={id}
          name={key}
          type="checkbox"
          checked={!!form[key]}
          onChange={(e) => setCloseout(key, e.target.checked)}
        />
        {label}
      </label>
    );
  };

  return (
    <div>
      {" "}
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: D.muted,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          marginBottom: 8,
        }}
      >
        Definition
      </div>{" "}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {" "}
        <Field label="Name" half htmlFor={fieldId("name")}>
          {inp("name")}
        </Field>{" "}
        <Field label="Service Key" half htmlFor={fieldId("service_key")}>
          {inp("service_key", "text", {
            disabled: !isNew,
            title: isNew ? undefined : "Service keys are locked after creation",
          })}
        </Field>{" "}
        <Field label="Short Name" half htmlFor={fieldId("short_name")}>
          {inp("short_name")}
        </Field>{" "}
        <Field label="Icon" half htmlFor={fieldId("icon")}>
          {inp("icon")}
        </Field>{" "}
        <Field label="Category" half htmlFor={fieldId("category")}>
          {sel("category", CATEGORIES)}
        </Field>{" "}
        <Field label="Subcategory" half htmlFor={fieldId("subcategory")}>
          {inp("subcategory")}
        </Field>{" "}
        <Field label="Billing Type" half htmlFor={fieldId("billing_type")}>
          {sel("billing_type", [
            { value: "recurring", label: "Recurring" },
            { value: "one_time", label: "One-Time" },
            { value: "free", label: "Free" },
          ])}
        </Field>{" "}
        <Field label="Frequency" half htmlFor={fieldId("frequency")}>
          {sel("frequency", [
            { value: "", label: "N/A" },
            { value: "monthly", label: "Monthly" },
            { value: "every_6_weeks", label: "Every 6 Weeks" },
            { value: "bimonthly", label: "Bi-Monthly" },
            { value: "quarterly", label: "Quarterly" },
            { value: "semiannual", label: "Semiannual" },
            { value: "annual", label: "Annual" },
          ])}
        </Field>{" "}
        <Field label="Visits/Year" half htmlFor={fieldId("visits_per_year")}>
          {inp("visits_per_year", "number")}
        </Field>{" "}
        <Field
          label="Duration (min)"
          half
          htmlFor={fieldId("default_duration_minutes")}
        >
          {inp("default_duration_minutes", "number")}
        </Field>{" "}
      </div>{" "}
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: D.muted,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          marginTop: 14,
          marginBottom: 8,
        }}
      >
        Pricing
      </div>{" "}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {" "}
        <Field label="Pricing Type" half htmlFor={fieldId("pricing_type")}>
          {sel("pricing_type", [
            { value: "variable", label: "Variable" },
            { value: "fixed", label: "Fixed" },
            { value: "quoted", label: "Quoted" },
          ])}
        </Field>{" "}
        <Field label="Price" half htmlFor={fieldId("base_price")}>
          {inp("base_price", "number")}
        </Field>{" "}
        <Field
          label="Pricing Model Key"
          half
          htmlFor={fieldId("pricing_model_key")}
        >
          {inp("pricing_model_key")}
        </Field>{" "}
        <Field label="Sort Order" half htmlFor={fieldId("sort_order")}>
          {inp("sort_order", "number")}
        </Field>{" "}
      </div>{" "}
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: D.muted,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          marginTop: 14,
          marginBottom: 8,
        }}
      >
        Compliance & Skills
      </div>{" "}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {" "}
        <Field
          label="Tax Service Key"
          half
          htmlFor={fieldId("tax_service_key")}
        >
          {inp("tax_service_key")}
        </Field>{" "}
        <Field
          label="License Category"
          half
          htmlFor={fieldId("license_category")}
        >
          {inp("license_category")}
        </Field>{" "}
        <Field
          label="Min Tech Skill Level"
          half
          htmlFor={fieldId("min_tech_skill_level")}
        >
          {inp("min_tech_skill_level", "number")}
        </Field>{" "}
        <Field label="Color" half htmlFor={fieldId("color")}>
          <input
            id={fieldId("color")}
            name="color"
            style={{ ...sInput, height: 36 }}
            type="color"
            value={form.color || "#18181B"}
            onChange={(e) => set("color", e.target.value)}
          />
        </Field>{" "}
      </div>{" "}
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 10 }}
      >
        {chk("is_waveguard", "WaveGuard")}
        {chk("is_taxable", "Taxable")}
        {chk("requires_license", "Requires License")}
        {chk("requires_follow_up", "Requires Follow-up")}
        {chk("customer_visible", "Customer Visible")}
        {chk("booking_enabled", "Booking Enabled")}
        {chk("is_active", "Active")}
      </div>
      {form.requires_follow_up && (
        <div style={{ marginTop: 8 }}>
          {" "}
          <Field
            label="Follow-up Interval (days)"
            half
            htmlFor={fieldId("follow_up_interval_days")}
          >
            {inp("follow_up_interval_days", "number")}
          </Field>{" "}
        </div>
      )}
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: D.muted,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          marginTop: 14,
          marginBottom: 8,
        }}
      >
        Closeout Requirements
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 10 }}>
        {closeoutChk("requires_service_report", "Service report")}
        {closeoutChk("requires_application_log", "Application/material log")}
        {closeoutChk("requires_customer_signature", "Customer signature")}
        {closeoutChk("requires_customer_notice", "Customer notice")}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
        <Field
          label="Required Photos"
          half
          htmlFor={fieldId("required_photo_count")}
        >
          <input
            id={fieldId("required_photo_count")}
            name="required_photo_count"
            style={sInput}
            type="number"
            min="0"
            step="1"
            value={form.required_photo_count ?? 0}
            onChange={(e) => setCloseout(
              "required_photo_count",
              e.target.value === "" ? 0 : Number(e.target.value),
            )}
          />
        </Field>
        <Field
          label="Requirement Source"
          half
          htmlFor={fieldId("closeout_requirements_source")}
        >
          <input
            id={fieldId("closeout_requirements_source")}
            name="closeout_requirements_source"
            style={{ ...sInput, opacity: 0.75 }}
            value={form.closeout_requirements_source || "manual"}
            readOnly
          />
        </Field>
      </div>
      <Field label="Description" htmlFor={fieldId("description")}>
        {" "}
        <textarea
          id={fieldId("description")}
          name="description"
          style={{ ...sInput, minHeight: 60, resize: "vertical" }}
          value={form.description || ""}
          onChange={(e) => set("description", e.target.value)}
        />{" "}
      </Field>{" "}
      <Field label="Internal Notes" htmlFor={fieldId("internal_notes")}>
        {" "}
        <textarea
          id={fieldId("internal_notes")}
          name="internal_notes"
          style={{ ...sInput, minHeight: 40, resize: "vertical" }}
          value={form.internal_notes || ""}
          onChange={(e) => set("internal_notes", e.target.value)}
        />{" "}
      </Field>
      {error && (
        <div
          style={{
            color: D.red,
            fontSize: 12,
            marginTop: 8,
            padding: "6px 10px",
            background: D.red + "15",
            borderRadius: 6,
          }}
        >
          {error}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        {" "}
        <button
          style={sBtn(D.teal, D.white)}
          onClick={submit}
          disabled={saving}
        >
          {saving ? "Saving..." : isNew ? "Create Service" : "Save Changes"}
        </button>
        {onCancel && (
          <button style={sBtn("transparent", D.muted)} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>{" "}
    </div>
  );
}

function normalizeTab(value) {
  return value === "discounts" ? "discounts" : "catalog";
}

// ── Left rail: category list + saved-view shortcuts ───────────────────
function RailItem({ label, count, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "7px 10px",
        borderRadius: 6,
        background: active ? D.selected : "transparent",
        color: active ? D.selectedFg : D.text,
        border: "none",
        cursor: "pointer",
        textAlign: "left",
        width: "100%",
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        marginBottom: 1,
        transition: "background 0.12s",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "#F0F0F1";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      {" "}
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>{" "}
      <span
        style={{
          fontSize: 11,
          fontWeight: 500,
          color: active ? "rgba(250,250,250,0.8)" : D.muted,
          marginLeft: 8,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {count}
      </span>{" "}
    </button>
  );
}

function RailSection({ title, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      {" "}
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: D.muted,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          padding: "4px 10px 6px",
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

// ── Middle list: compact two-line service rows ────────────────────────
function ServiceListRow({ svc, selected, onSelect }) {
  const sub = [
    billingLabel(svc.billing_type),
    frequencyLabel(svc.frequency),
    priceLabel(svc),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "12px 14px",
        background: selected ? D.selected : "transparent",
        color: selected ? D.selectedFg : D.text,
        border: "none",
        borderBottom: `1px solid ${D.border}`,
        cursor: "pointer",
        textAlign: "left",
        width: "100%",
        opacity: svc.is_archived ? 0.55 : svc.is_active ? 1 : 0.6,
        transition: "background 0.12s",
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = "#FAFAFA";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = "transparent";
      }}
    >
      {" "}
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          flexShrink: 0,
          background: svc.is_waveguard
            ? selected
              ? D.selectedFg
              : D.heading
            : "transparent",
          border: `1.5px solid ${selected ? D.selectedFg : D.muted}`,
        }}
        aria-hidden
      />{" "}
      <div style={{ flex: 1, minWidth: 0 }}>
        {" "}
        <div
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: selected ? D.selectedFg : D.heading,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {" "}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {cleanName(svc)}
          </span>
          {svc.is_archived && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                padding: "2px 5px",
                borderRadius: 3,
                background: selected ? "rgba(250,250,250,0.18)" : "#71717A18",
                color: selected ? D.selectedFg : D.muted,
                letterSpacing: 0.4,
                flexShrink: 0,
              }}
            >
              ARCHIVED
            </span>
          )}
          {svc.is_waveguard && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                padding: "2px 5px",
                borderRadius: 3,
                background: selected ? "rgba(250,250,250,0.18)" : "#18181B11",
                color: selected ? D.selectedFg : D.heading,
                letterSpacing: 0.4,
                flexShrink: 0,
              }}
            >
              WG
            </span>
          )}
        </div>{" "}
        <div
          style={{
            fontSize: 12,
            marginTop: 2,
            color: selected ? "rgba(250,250,250,0.7)" : D.muted,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {sub || "—"}
        </div>{" "}
      </div>{" "}
    </button>
  );
}

// ── Right pane: detail/edit view ──────────────────────────────────────
function DetailPane({
  svc,
  creating,
  onSaveNew,
  onCancelNew,
  onUpdated,
  onDeleted,
}) {
  if (creating) {
    return (
      <div
        style={{
          overflowY: "auto",
          height: "100%",
          minHeight: 0,
          WebkitOverflowScrolling: "touch",
        }}
      >
        {" "}
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 1,
            background: D.card,
            borderBottom: `1px solid ${D.border}`,
            padding: "20px 24px",
          }}
        >
          {" "}
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: D.muted,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              marginBottom: 4,
            }}
          >
            New
          </div>{" "}
          <h2
            style={{
              fontSize: 22,
              fontWeight: 500,
              color: D.heading,
              margin: 0,
              lineHeight: 1.2,
            }}
          >
            Add a Service
          </h2>{" "}
          <div style={{ fontSize: 13, color: D.muted, marginTop: 6 }}>
            Define a new entry in the service catalog.
          </div>{" "}
        </div>{" "}
        <div style={{ padding: "20px 24px" }}>
          {" "}
          <ServiceForm
            svc={null}
            onSave={onSaveNew}
            onCancel={onCancelNew}
            isNew
          />{" "}
        </div>{" "}
      </div>
    );
  }

  if (!svc) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: 10,
          padding: 32,
          color: D.muted,
          textAlign: "center",
        }}
      >
        {" "}
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 10,
            border: `1.5px dashed ${D.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: D.border,
            fontSize: 22,
            marginBottom: 4,
          }}
          aria-hidden
        >
          ◧
        </div>{" "}
        <div style={{ fontSize: 14, fontWeight: 500, color: D.text }}>
          Select a service to view details
        </div>{" "}
        <div style={{ fontSize: 12 }}>
          Or click <b>+ Add Service</b>to create one.
        </div>{" "}
      </div>
    );
  }

  const products = parseProducts(svc);
  const closeoutRequirements = closeoutRequirementLabels(svc);

  const handleDelete = async () => {
    if (
      !window.confirm(
        `Archive "${cleanName(svc)}"?\n\nThis removes it from the active service catalog. The archive will be blocked if this service is still referenced by live schedules, packages, add-ons, or discount rules.`,
      )
    )
      return;
    try {
      await aFetch(`/admin/services/${svc.id}`, { method: "DELETE" });
      onDeleted();
    } catch (err) {
      window.alert("Archive failed: " + (err?.message || "unknown error"));
    }
  };

  const handleToggleActive = async () => {
    try {
      await aFetch(`/admin/services/${svc.id}`, {
        method: "PUT",
        body: JSON.stringify({ is_active: !svc.is_active }),
      });
      onUpdated();
    } catch (err) {
      window.alert(
        "Status update failed: " + (err?.message || "unknown error"),
      );
    }
  };

  const handleRestore = async () => {
    try {
      await aFetch(`/admin/services/${svc.id}`, {
        method: "PUT",
        body: JSON.stringify({ is_archived: false, is_active: true }),
      });
      onUpdated("Restored");
    } catch (err) {
      window.alert("Restore failed: " + (err?.message || "unknown error"));
    }
  };

  return (
    <div
      style={{
        overflowY: "auto",
        height: "100%",
        minHeight: 0,
        WebkitOverflowScrolling: "touch",
      }}
      key={svc.id}
    >
      {/* Sticky summary header */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 1,
          background: D.card,
          borderBottom: `1px solid ${D.border}`,
          padding: "20px 24px",
        }}
      >
        {" "}
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: D.muted,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            marginBottom: 4,
          }}
        >
          {categoryLabel(svc.category)}
          {svc.subcategory ? ` · ${svc.subcategory}` : ""}
        </div>{" "}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          {" "}
          <h2
            style={{
              fontSize: 22,
              fontWeight: 500,
              color: D.heading,
              margin: 0,
              lineHeight: 1.25,
            }}
          >
            {cleanName(svc)}
            {svc.is_waveguard && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "3px 7px",
                  borderRadius: 4,
                  background: D.heading,
                  color: D.card,
                  marginLeft: 10,
                  verticalAlign: "middle",
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                WaveGuard
              </span>
            )}
          </h2>
          {svc.is_archived ? (
            <span
              style={{
                ...sBtn("#71717A18", D.muted),
                fontSize: 11,
                padding: "4px 10px",
                whiteSpace: "nowrap",
              }}
            >
              Archived
            </span>
          ) : (
            <button
              onClick={handleToggleActive}
              type="button"
              style={{
                ...sBtn(
                  svc.is_active ? D.green + "18" : D.red + "15",
                  svc.is_active ? D.green : D.red,
                ),
                fontSize: 11,
                padding: "4px 10px",
                whiteSpace: "nowrap",
              }}
              title="Toggle active status"
            >
              {svc.is_active ? "● Active" : "○ Inactive"}
            </button>
          )}
        </div>{" "}
        <div
          style={{
            display: "flex",
            gap: 12,
            marginTop: 12,
            fontSize: 13,
            color: D.muted,
            flexWrap: "wrap",
          }}
        >
          {" "}
          <span>
            <b style={{ color: D.text, fontWeight: 500 }}>
              {billingLabel(svc.billing_type)}
            </b>
            {svc.frequency ? ` · ${frequencyLabel(svc.frequency)}` : ""}
          </span>{" "}
          <span style={{ color: D.border }}>·</span>{" "}
          <span>
            <b style={{ color: D.text, fontWeight: 500 }}>{priceLabel(svc)}</b>
            {svc.pricing_type === "variable" ? " · variable" : ""}
          </span>
          {svc.default_duration_minutes > 0 && (
            <>
              {" "}
              <span style={{ color: D.border }}>·</span>{" "}
              <span>
                <b style={{ color: D.text, fontWeight: 500 }}>
                  {svc.default_duration_minutes} min
                </b>
              </span>{" "}
            </>
          )}
          {svc.visits_per_year > 0 && (
            <>
              {" "}
              <span style={{ color: D.border }}>·</span>{" "}
              <span>
                <b style={{ color: D.text, fontWeight: 500 }}>
                  {svc.visits_per_year} visits/yr
                </b>
              </span>{" "}
            </>
          )}
        </div>{" "}
      </div>
      {/* Read-only callouts */}
      <div style={{ padding: "20px 24px 0" }}>
        {svc.description && (
          <div style={{ marginBottom: 16 }}>
            {" "}
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: D.muted,
                textTransform: "uppercase",
                letterSpacing: 0.4,
                marginBottom: 6,
              }}
            >
              Description
            </div>{" "}
            <div style={{ fontSize: 13, color: D.text, lineHeight: 1.5 }}>
              {svc.description}
            </div>{" "}
          </div>
        )}
        {products.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            {" "}
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: D.muted,
                textTransform: "uppercase",
                letterSpacing: 0.4,
                marginBottom: 6,
              }}
            >
              Default Products
            </div>{" "}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {products.map((p, i) => (
                <span
                  key={i}
                  style={{
                    fontSize: 12,
                    padding: "4px 10px",
                    borderRadius: 4,
                    background: "#F4F4F5",
                    color: D.text,
                    border: `1px solid ${D.border}`,
                  }}
                >
                  {p}
                </span>
              ))}
            </div>{" "}
          </div>
        )}
        {closeoutRequirements.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            {" "}
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: D.muted,
                textTransform: "uppercase",
                letterSpacing: 0.4,
                marginBottom: 6,
              }}
            >
              Closeout Requirements
            </div>{" "}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {closeoutRequirements.map((item) => (
                <span
                  key={item}
                  style={{
                    fontSize: 12,
                    padding: "4px 10px",
                    borderRadius: 4,
                    background: "#F4F4F5",
                    color: D.text,
                    border: `1px solid ${D.border}`,
                  }}
                >
                  {item}
                </span>
              ))}
              <span
                style={{
                  fontSize: 12,
                  padding: "4px 10px",
                  borderRadius: 4,
                  background: "#FAFAFA",
                  color: D.muted,
                  border: `1px solid ${D.border}`,
                }}
              >
                {svc.closeout_requirements_source || "inferred_v1"}
              </span>
            </div>{" "}
          </div>
        )}
        {(svc.requires_license ||
          svc.license_category ||
          svc.min_tech_skill_level > 1 ||
          svc.requires_follow_up) && (
          <div
            style={{
              marginBottom: 16,
              display: "flex",
              gap: 24,
              flexWrap: "wrap",
            }}
          >
            {svc.license_category && (
              <div>
                {" "}
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: D.muted,
                    textTransform: "uppercase",
                    letterSpacing: 0.4,
                  }}
                >
                  License
                </div>{" "}
                <div style={{ fontSize: 13, color: D.text, marginTop: 2 }}>
                  {svc.license_category}
                </div>{" "}
              </div>
            )}
            {svc.min_tech_skill_level > 1 && (
              <div>
                {" "}
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: D.muted,
                    textTransform: "uppercase",
                    letterSpacing: 0.4,
                  }}
                >
                  Min Skill
                </div>{" "}
                <div style={{ fontSize: 13, color: D.text, marginTop: 2 }}>
                  Level {svc.min_tech_skill_level}
                </div>{" "}
              </div>
            )}
            {svc.requires_follow_up && (
              <div>
                {" "}
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: D.muted,
                    textTransform: "uppercase",
                    letterSpacing: 0.4,
                  }}
                >
                  Follow-up
                </div>{" "}
                <div style={{ fontSize: 13, color: D.text, marginTop: 2 }}>
                  {svc.follow_up_interval_days || "—"} days
                </div>{" "}
              </div>
            )}
          </div>
        )}
      </div>
      {/* Edit form */}
      <div style={{ padding: "8px 24px 24px" }}>
        {" "}
        <ServiceForm
          key={svc.id}
          svc={svc}
          onSave={async (data) => {
            await aFetch(`/admin/services/${svc.id}`, {
              method: "PUT",
              body: JSON.stringify(data),
            });
            onUpdated();
          }}
        />{" "}
        <div
          style={{
            marginTop: 16,
            paddingTop: 16,
            borderTop: `1px solid ${D.border}`,
          }}
        >
          {svc.is_archived ? (
            <button
              type="button"
              onClick={handleRestore}
              style={{
                ...sBtn(D.green + "18", D.green),
                border: `1px solid ${D.green}33`,
                fontSize: 12,
              }}
            >
              Restore service
            </button>
          ) : (
            <button
              type="button"
              onClick={handleDelete}
              style={{
                ...sBtn(D.red + "15", D.red),
                border: `1px solid ${D.red}33`,
                fontSize: 12,
              }}
            >
              Archive service
            </button>
          )}
        </div>{" "}
      </div>{" "}
    </div>
  );
}

// Tablet (768-1023px): horizontal-scroll category chips. <768 falls through to MobileServiceLibrary.
function CompactCategoryChips({ counts, selectedView, onChange }) {
  const items = [
    { key: "all", label: "All", count: counts.all },
    ...CATEGORIES.filter((c) => counts.byCategory[c.value]).map((c) => ({
      key: `category:${c.value}`,
      label: c.label,
      count: counts.byCategory[c.value],
    })),
    { key: "view:waveguard", label: "WaveGuard", count: counts.waveguard },
    ...(counts.inactive > 0
      ? [{ key: "view:inactive", label: "Inactive", count: counts.inactive }]
      : []),
    ...(counts.archived > 0
      ? [{ key: "view:archived", label: "Archived", count: counts.archived }]
      : []),
  ];
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        overflowX: "auto",
        padding: "0 0 12px",
        WebkitOverflowScrolling: "touch",
      }}
    >
      {items.map((it) => {
        const active = selectedView === it.key;
        return (
          <button
            key={it.key}
            onClick={() => onChange(it.key)}
            type="button"
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: "nowrap",
              background: active ? D.selected : D.card,
              color: active ? D.selectedFg : D.text,
              border: `1px solid ${active ? D.selected : D.border}`,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            {it.label}{" "}
            <span style={{ opacity: 0.7, marginLeft: 4 }}>{it.count}</span>{" "}
          </button>
        );
      })}
    </div>
  );
}

export default function ServiceLibraryPage() {
  const isMobile = useIsMobile(768);
  const [services, setServices] = useState([]);
  const [selectedView, setSelectedView] = useState("all");
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [toast, setToast] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTabState] = useState(() =>
    normalizeTab(searchParams.get("tab")),
  );
  // 768-1023px tablet stacked mode (separate from <768 mobile drilldown)
  const [isTablet, setIsTablet] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 1024,
  );

  useEffect(() => {
    const onResize = () => setIsTablet(window.innerWidth < 1024);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    setTabState(normalizeTab(searchParams.get("tab")));
  }, [searchParams]);

  const setTab = useCallback(
    (nextTab) => {
      const normalized = normalizeTab(nextTab);
      setTabState(normalized);
      const next = new URLSearchParams(searchParams);
      if (normalized === "discounts") next.set("tab", "discounts");
      else next.delete("tab");
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  };

  const loadServices = useCallback(async () => {
    try {
      // Load all services once; filter client-side for snappier nav.
      const data = await aFetch(
        "/admin/services?limit=500&include_archived=true",
      );
      setServices(data.services || []);
    } catch {
      setServices([]);
    }
  }, []);

  useEffect(() => {
    loadServices();
  }, [loadServices]);

  if (isMobile)
    return (
      <MobileServiceLibrary
        initialView={tab === "discounts" ? "discounts" : "menu"}
      />
    );

  const counts = (() => {
    const c = {
      all: 0,
      waveguard: 0,
      recurring: 0,
      onetime: 0,
      inactive: 0,
      archived: 0,
      byCategory: {},
    };
    for (const s of services) {
      if (s.is_archived) {
        c.archived++;
        continue;
      }
      if (s.is_active === false) {
        c.inactive++;
        continue;
      }
      c.all++;
      if (s.is_waveguard) c.waveguard++;
      if (s.billing_type === "recurring") c.recurring++;
      if (s.billing_type === "one_time") c.onetime++;
      const cat = s.category || "other";
      c.byCategory[cat] = (c.byCategory[cat] || 0) + 1;
    }
    return c;
  })();

  const viewFiltered = (() => {
    let list = services;
    if (selectedView === "all")
      list = list.filter((s) => s.is_active !== false && !s.is_archived);
    else if (selectedView === "view:waveguard")
      list = list.filter(
        (s) => s.is_waveguard && s.is_active !== false && !s.is_archived,
      );
    else if (selectedView === "view:recurring")
      list = list.filter(
        (s) =>
          s.billing_type === "recurring" &&
          s.is_active !== false &&
          !s.is_archived,
      );
    else if (selectedView === "view:onetime")
      list = list.filter(
        (s) =>
          s.billing_type === "one_time" &&
          s.is_active !== false &&
          !s.is_archived,
      );
    else if (selectedView === "view:inactive")
      list = list.filter((s) => s.is_active === false && !s.is_archived);
    else if (selectedView === "view:archived")
      list = list.filter((s) => s.is_archived);
    else if (selectedView.startsWith("category:")) {
      const cat = selectedView.slice("category:".length);
      list = list.filter(
        (s) =>
          (s.category || "other") === cat &&
          s.is_active !== false &&
          !s.is_archived,
      );
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (s) =>
          (s.name || "").toLowerCase().includes(q) ||
          (s.short_name || "").toLowerCase().includes(q) ||
          (s.service_key || "").toLowerCase().includes(q) ||
          (s.description || "").toLowerCase().includes(q),
      );
    }
    return [...list].sort(
      (a, b) =>
        (a.sort_order ?? 999) - (b.sort_order ?? 999) ||
        (a.name || "").localeCompare(b.name || ""),
    );
  })();

  const selectedSvc = services.find((s) => s.id === selectedId) || null;

  const handleCreate = async (data) => {
    const created = await aFetch("/admin/services", {
      method: "POST",
      body: JSON.stringify(data),
    });
    setShowNew(false);
    if (created?.id) setSelectedId(created.id);
    showToast("Service created");
    loadServices();
  };

  const handleUpdated = (message = "Saved") => {
    if (message === "Restored") setSelectedView("all");
    loadServices();
    showToast(message);
  };
  const handleDeleted = () => {
    setSelectedId(null);
    loadServices();
    showToast("Archived");
  };

  const tabs = [
    { key: "catalog", label: "Service Catalog", Icon: Library },
    { key: "discounts", label: "Discounts", Icon: Percent },
  ];

  return (
    <div style={{ maxWidth: 1300, margin: "0 auto" }}>
      {" "}
      <AdminCommandHeader
        title="Services"
        icon={Library}
        sections={tabs}
        activeKey={tab}
        onSectionChange={setTab}
        ariaLabel="Services section"
        navGridClassName="grid-cols-2"
        action={
          tab === "catalog"
            ? {
                label: "Add Service",
                icon: Plus,
                onClick: () => {
                  setShowNew(true);
                  setSelectedId(null);
                },
              }
            : null
        }
      />
      {/* Toast */}
      {toast && (
        <div
          style={{
            position: "fixed",
            top: 20,
            right: 20,
            background: D.green,
            color: D.card,
            padding: "10px 20px",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            zIndex: 9999,
          }}
        >
          {toast}
        </div>
      )}
      {/* === CATALOG TAB === */}
      {tab === "catalog" &&
        (isTablet ? (
          // Tablet (768-1023): stacked. Chips on top, full-width list, inline detail panel.
          <div>
            {" "}
            <CompactCategoryChips
              counts={counts}
              selectedView={selectedView}
              onChange={(v) => {
                setSelectedView(v);
                setSelectedId(null);
              }}
            />{" "}
            <div style={{ ...sCard, padding: 8, marginBottom: 12 }}>
              {" "}
              <input
                style={sInput}
                placeholder="Search services..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />{" "}
            </div>
            {showNew && (
              <div style={{ ...sCard, marginBottom: 12, padding: 0 }}>
                {" "}
                <DetailPane
                  creating
                  onSaveNew={handleCreate}
                  onCancelNew={() => setShowNew(false)}
                />{" "}
              </div>
            )}
            <div
              style={{
                background: D.card,
                border: `1px solid ${D.border}`,
                borderRadius: 12,
                overflow: "hidden",
              }}
            >
              {viewFiltered.length === 0 ? (
                <div
                  style={{
                    padding: 32,
                    textAlign: "center",
                    color: D.muted,
                    fontSize: 13,
                  }}
                >
                  No services found
                </div>
              ) : (
                viewFiltered.map((svc) => {
                  const isOpen = selectedId === svc.id;
                  return (
                    <div key={svc.id}>
                      {" "}
                      <ServiceListRow
                        svc={svc}
                        selected={isOpen}
                        onSelect={() => {
                          setSelectedId(isOpen ? null : svc.id);
                          setShowNew(false);
                        }}
                      />
                      {isOpen && (
                        <div
                          style={{
                            background: D.railBg,
                            borderBottom: `1px solid ${D.border}`,
                          }}
                        >
                          {" "}
                          <DetailPane
                            svc={svc}
                            onUpdated={handleUpdated}
                            onDeleted={handleDeleted}
                          />{" "}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>{" "}
          </div>
        ) : (
          // Desktop (≥1024): three-pane master-detail.
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "210px 360px 1fr",
              height: "clamp(420px, calc(100dvh - 240px), 760px)",
              minHeight: 0,
              minWidth: 0,
              background: D.card,
              border: `1px solid ${D.border}`,
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            {/* RAIL */}
            <div
              style={{
                borderRight: `1px solid ${D.border}`,
                padding: "12px 8px",
                overflowY: "auto",
                minHeight: 0,
                background: D.railBg,
              }}
            >
              {" "}
              <RailSection title="Catalog">
                {" "}
                <RailItem
                  label="All Services"
                  count={counts.all}
                  active={selectedView === "all"}
                  onClick={() => {
                    setSelectedView("all");
                    setSelectedId(null);
                  }}
                />{" "}
              </RailSection>{" "}
              <RailSection title="Categories">
                {CATEGORIES.filter((c) => counts.byCategory[c.value]).map(
                  (c) => (
                    <RailItem
                      key={c.value}
                      label={c.label}
                      count={counts.byCategory[c.value] || 0}
                      active={selectedView === `category:${c.value}`}
                      onClick={() => {
                        setSelectedView(`category:${c.value}`);
                        setSelectedId(null);
                      }}
                    />
                  ),
                )}
              </RailSection>{" "}
              <RailSection title="Saved Views">
                {" "}
                <RailItem
                  label="WaveGuard"
                  count={counts.waveguard}
                  active={selectedView === "view:waveguard"}
                  onClick={() => {
                    setSelectedView("view:waveguard");
                    setSelectedId(null);
                  }}
                />{" "}
                <RailItem
                  label="Recurring"
                  count={counts.recurring}
                  active={selectedView === "view:recurring"}
                  onClick={() => {
                    setSelectedView("view:recurring");
                    setSelectedId(null);
                  }}
                />{" "}
                <RailItem
                  label="One-Time"
                  count={counts.onetime}
                  active={selectedView === "view:onetime"}
                  onClick={() => {
                    setSelectedView("view:onetime");
                    setSelectedId(null);
                  }}
                />
                {/* Inactive only surfaces when there ARE inactive rows — keeps the
                    rail clean per Adam's directive while leaving a recovery path
                    for reactivating services that get deactivated. */}
                {counts.inactive > 0 && (
                  <RailItem
                    label="Inactive"
                    count={counts.inactive}
                    active={selectedView === "view:inactive"}
                    onClick={() => {
                      setSelectedView("view:inactive");
                      setSelectedId(null);
                    }}
                  />
                )}
                {counts.archived > 0 && (
                  <RailItem
                    label="Archived"
                    count={counts.archived}
                    active={selectedView === "view:archived"}
                    onClick={() => {
                      setSelectedView("view:archived");
                      setSelectedId(null);
                    }}
                  />
                )}
              </RailSection>{" "}
            </div>
            {/* LIST */}
            <div
              style={{
                borderRight: `1px solid ${D.border}`,
                display: "flex",
                flexDirection: "column",
                minWidth: 0,
                minHeight: 0,
              }}
            >
              {" "}
              <div
                style={{ padding: 12, borderBottom: `1px solid ${D.border}` }}
              >
                {" "}
                <input
                  style={sInput}
                  placeholder="Search services..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />{" "}
                <div
                  style={{
                    fontSize: 11,
                    color: D.muted,
                    marginTop: 8,
                    paddingLeft: 2,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {viewFiltered.length}{" "}
                  {viewFiltered.length === 1 ? "service" : "services"}
                </div>{" "}
              </div>{" "}
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                {viewFiltered.length === 0 ? (
                  <div
                    style={{
                      padding: 32,
                      textAlign: "center",
                      color: D.muted,
                      fontSize: 13,
                    }}
                  >
                    No services found
                  </div>
                ) : (
                  viewFiltered.map((svc) => (
                    <ServiceListRow
                      key={svc.id}
                      svc={svc}
                      selected={selectedId === svc.id && !showNew}
                      onSelect={() => {
                        setSelectedId(svc.id);
                        setShowNew(false);
                      }}
                    />
                  ))
                )}
              </div>{" "}
            </div>
            {/* DETAIL */}
            <div
              style={{
                minWidth: 0,
                minHeight: 0,
                height: "100%",
                background: D.card,
              }}
            >
              {" "}
              <DetailPane
                svc={showNew ? null : selectedSvc}
                creating={showNew}
                onSaveNew={handleCreate}
                onCancelNew={() => setShowNew(false)}
                onUpdated={handleUpdated}
                onDeleted={handleDeleted}
              />{" "}
            </div>{" "}
          </div>
        ))}
      {/* === DISCOUNTS TAB === */}
      {tab === "discounts" && <DiscountsSection />}
    </div>
  );
}
