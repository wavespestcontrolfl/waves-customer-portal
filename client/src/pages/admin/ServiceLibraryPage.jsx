import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import { Library, Percent, Plus, Sprout } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import MobileServiceLibrary from "../../components/admin/MobileServiceLibrary";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  Field,
  Input,
  Select,
  Textarea,
  UiSurface,
} from "../../components/ui";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";
import useIsMobile from "../../hooks/useIsMobile";
import { SERVICE_CATEGORIES as CATEGORIES } from "../../constants/serviceCategories";
import { omitUnchangedDurationFields } from "../../lib/serviceLibraryPayload";
import { DiscountsSection } from "./DiscountsTabs";

const LawnProtocolCommandCenterPage = lazy(
  () => import("./LawnProtocolCommandCenterPage"),
);
const API = import.meta.env.VITE_API_URL || "/api";

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

async function fetchAllServices(query = "") {
  const rows = [];
  let offset = 0;
  let total = 0;
  do {
    const joiner = query ? "&" : "";
    const data = await aFetch(`/admin/services?${query}${joiner}limit=500&offset=${offset}`);
    const page = data.services || [];
    rows.push(...page);
    total = Number(data.total || rows.length);
    offset += page.length;
    if (page.length === 0) break;
  } while (rows.length < total);
  return rows;
}

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
  min_duration_minutes: "",
  max_duration_minutes: "",
  scheduling_buffer_minutes: 0,
  requires_follow_up: false,
  follow_up_interval_days: "",
  frequency: "",
  visits_per_year: "",
  pricing_type: "variable",
  base_price: "",
  price_range_min: "",
  price_range_max: "",
  pricing_model_key: "",
  is_taxable: false,
  tax_service_key: "",
  requires_license: false,
  license_category: "",
  min_tech_skill_level: 1,
  requires_certification: "",
  default_equipment: "",
  default_products: "",
  typical_materials_cost: "",
  requires_service_report: true,
  requires_application_log: false,
  required_photo_count: 0,
  requires_customer_signature: false,
  requires_customer_notice: false,
  closeout_requirements_source: "inferred_v1",
  customer_visible: true,
  booking_enabled: true,
  public_quote_selectable: false,
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

const SERVICE_SEARCH_FIELDS = [
  "name",
  "short_name",
  "service_key",
  "description",
];
const SERVICE_SEARCH_PLACEHOLDER = "Search services...";

function serviceSaveLabel(saving, isNew) {
  if (saving) return "Saving...";
  return isNew ? "Create Service" : "Save Changes";
}

const isActiveCatalogService = (service) =>
  service.is_active !== false && !service.is_archived;

const SERVICE_VIEW_PREDICATES = {
  all: isActiveCatalogService,
  "view:waveguard": (service) =>
    isActiveCatalogService(service) && service.is_waveguard,
  "view:recurring": (service) =>
    isActiveCatalogService(service) && service.billing_type === "recurring",
  "view:onetime": (service) =>
    isActiveCatalogService(service) && service.billing_type === "one_time",
  "view:inactive": (service) =>
    service.is_active === false && !service.is_archived,
  "view:archived": (service) => service.is_archived,
  ...Object.fromEntries(
    CATEGORIES.map((category) => [
      `category:${category.value}`,
      (service) =>
        isActiveCatalogService(service) &&
        (service.category || "other") === category.value,
    ]),
  ),
};

function cleanName(service) {
  return String(service?.name || "")
    .replace(/\s*WaveGuard\s*$/i, "")
    .trim();
}

function parseProducts(service) {
  const products = service?.default_products;
  if (Array.isArray(products)) return products;
  if (typeof products === "string") {
    try {
      return JSON.parse(products);
    } catch {
      return [];
    }
  }
  return [];
}

function frequencyLabel(frequency) {
  if (!frequency) return "";
  return (
    {
      monthly: "Monthly",
      every_6_weeks: "Every 6 wk",
      seasonal_feb_oct: "Seasonal (Feb–Oct)",
      bimonthly: "Bi-monthly",
      quarterly: "Quarterly",
      semiannual: "Semiannual",
      annual: "Annual",
    }[frequency] || frequency
  );
}

function billingLabel(billing) {
  if (billing === "one_time") return "One-Time";
  if (billing === "recurring") return "Recurring";
  if (billing === "free") return "Free";
  return billing || "—";
}

function priceLabel(service) {
  const price = Number(service?.base_price || 0);
  if (
    service?.pricing_type === "variable" ||
    service?.pricing_type === "quoted"
  ) {
    return price ? "$" + price.toFixed(0) : "Variable";
  }
  return price ? "$" + price.toFixed(0) : "—";
}

function variablePriceSuffix(service) {
  if (service?.pricing_type === "variable" && Number(service?.base_price) > 0) {
    return "variable";
  }
  return "";
}

function categoryLabel(value) {
  return (
    CATEGORIES.find((category) => category.value === value)?.label ||
    value ||
    "—"
  );
}

function closeoutRequirementLabels(service) {
  return [
    service?.requires_service_report !== false && "Service report",
    service?.requires_application_log && "Application/material log",
    Number(service?.required_photo_count || 0) > 0 &&
      Number(service.required_photo_count) +
        " photo" +
        (Number(service.required_photo_count) === 1 ? "" : "s"),
    service?.requires_customer_signature && "Customer signature",
    service?.requires_customer_notice && "Customer notice",
  ].filter(Boolean);
}

function FormSection({ title, children }) {
  return (
    <section className="space-y-3 border-t border-hairline border-zinc-200 pt-4 first:border-0 first:pt-0">
      <h3 className="text-ui-body font-medium text-zinc-900">{title}</h3>
      {children}
    </section>
  );
}

function ServiceForm({ svc, onSave, onCancel, isNew }) {
  const originalService = useRef(svc);
  const rawFormId = useId().replace(/:/g, "");
  const fieldId = (key) => rawFormId + "-" + key;
  const jsonForEdit = (value) => {
    if (value === null || value === undefined || value === "") return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  };
  const [form, setForm] = useState({
    ...EMPTY_SVC,
    ...svc,
    requires_certification: jsonForEdit(svc?.requires_certification),
    default_equipment: jsonForEdit(svc?.default_equipment),
    default_products: jsonForEdit(svc?.default_products),
  });
  const [closeoutTouched, setCloseoutTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = (key, value) =>
    setForm((current) => ({ ...current, [key]: value }));
  const setCloseout = (key, value) => {
    setCloseoutTouched(true);
    setForm((current) => ({
      ...current,
      [key]: value,
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
      const payload = isNew
        ? { ...form }
        : omitUnchangedDurationFields(form, originalService.current);
      if (isNew && !closeoutTouched)
        CLOSEOUT_REQUIREMENT_FIELDS.forEach((key) => delete payload[key]);
      await onSave(payload);
    } catch (saveError) {
      setError(saveError.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const input = (key, type = "text", extra = {}) => (
    <Input
      id={fieldId(key)}
      name={key}
      type={type}
      value={form[key] ?? ""}
      disabled={extra.disabled}
      title={extra.title}
      onChange={(event) =>
        set(
          key,
          type === "number"
            ? event.target.value === ""
              ? ""
              : Number(event.target.value)
            : event.target.value,
        )
      }
    />
  );
  const select = (key, options) => (
    <Select
      id={fieldId(key)}
      name={key}
      value={form[key] || ""}
      onChange={(event) => set(key, event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  );
  const choice = (key, label) => (
    <Checkbox
      id={fieldId(key)}
      name={key}
      label={label}
      checked={!!form[key]}
      onChange={(event) => set(key, event.target.checked)}
    />
  );
  const closeoutChoice = (key, label) => (
    <Checkbox
      id={fieldId(key)}
      name={key}
      label={label}
      checked={!!form[key]}
      onChange={(event) => setCloseout(key, event.target.checked)}
    />
  );

  return (
    <div className="space-y-5">
      <FormSection title="Definition">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" required>
            {input("name")}
          </Field>
          <Field label="Service Key">
            {input("service_key", "text", {
              disabled: !isNew,
              title: isNew
                ? undefined
                : "Service keys are locked after creation",
            })}
          </Field>
          <Field label="Short Name">{input("short_name")}</Field>
          <Field label="Icon">{input("icon")}</Field>
          <Field label="Category">{select("category", CATEGORIES)}</Field>
          <Field label="Subcategory">{input("subcategory")}</Field>
          <Field label="Billing Type">
            {select("billing_type", [
              { value: "recurring", label: "Recurring" },
              { value: "one_time", label: "One-Time" },
              { value: "free", label: "Free" },
            ])}
          </Field>
          <Field label="Frequency">
            {select("frequency", [
              { value: "", label: "N/A" },
              { value: "monthly", label: "Monthly" },
              { value: "every_6_weeks", label: "Every 6 Weeks" },
              { value: "seasonal_feb_oct", label: "Seasonal (Feb–Oct)" },
              { value: "bimonthly", label: "Bi-Monthly" },
              { value: "quarterly", label: "Quarterly" },
              { value: "semiannual", label: "Semiannual" },
              { value: "annual", label: "Annual" },
            ])}
          </Field>
          <Field label="Visits/Year">
            {input("visits_per_year", "number")}
          </Field>
          <Field label="Duration (min)">
            {input("default_duration_minutes", "number")}
          </Field>
          <Field label="Min Duration">
            {input("min_duration_minutes", "number")}
          </Field>
          <Field label="Max Duration">
            {input("max_duration_minutes", "number")}
          </Field>
          <Field label="Schedule Buffer">
            {input("scheduling_buffer_minutes", "number")}
          </Field>
        </div>
      </FormSection>

      <FormSection title="Pricing">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Pricing Type">
            {select("pricing_type", [
              { value: "variable", label: "Variable" },
              { value: "fixed", label: "Fixed" },
              { value: "quoted", label: "Quoted" },
            ])}
          </Field>
          <Field label="Price">{input("base_price", "number")}</Field>
          <Field label="Price Range Min">
            {input("price_range_min", "number")}
          </Field>
          <Field label="Price Range Max">
            {input("price_range_max", "number")}
          </Field>
          <Field label="Pricing Model Key">{input("pricing_model_key")}</Field>
          <Field label="Sort Order">{input("sort_order", "number")}</Field>
          <Field label="Typical Materials Cost">
            {input("typical_materials_cost", "number")}
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-4">
          {[
            ["requires_certification", "Required Certifications (JSON)"],
            ["default_equipment", "Default Equipment (JSON)"],
            ["default_products", "Default Products (JSON)"],
          ].map(([key, label]) => (
            <Field key={key} label={label}>
              <Textarea
                id={fieldId(key)}
                name={key}
                rows={3}
                value={form[key] || ""}
                onChange={(event) => set(key, event.target.value)}
                placeholder='["Example"]'
              />
            </Field>
          ))}
        </div>
      </FormSection>

      <FormSection title="Compliance & Skills">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Tax Service Key">{input("tax_service_key")}</Field>
          <Field label="License Category">{input("license_category")}</Field>
          <Field label="Min Tech Skill Level">
            {input("min_tech_skill_level", "number")}
          </Field>
          <Field label="Color">
            <Input
              id={fieldId("color")}
              name="color"
              type="color"
              className="px-1"
              value={form.color || "#18181B"}
              onChange={(event) => set("color", event.target.value)}
            />
          </Field>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-3">
          {choice("is_waveguard", "WaveGuard")}
          {choice("is_taxable", "Taxable")}
          {choice("requires_license", "Requires License")}
          {choice("requires_follow_up", "Requires Follow-up")}
          {choice("customer_visible", "Customer Visible")}
          {choice("booking_enabled", "Booking Enabled")}
          {choice("public_quote_selectable", "Quote Form Selectable")}
          {choice("is_active", "Active")}
        </div>
        {form.requires_follow_up && (
          <div className="max-w-sm">
            <Field label="Follow-up Interval (days)">
              {input("follow_up_interval_days", "number")}
            </Field>
          </div>
        )}
      </FormSection>

      <FormSection title="Closeout Requirements">
        <div className="flex flex-wrap gap-x-5 gap-y-3">
          {closeoutChoice("requires_service_report", "Service report")}
          {closeoutChoice(
            "requires_application_log",
            "Application/material log",
          )}
          {closeoutChoice("requires_customer_signature", "Customer signature")}
          {closeoutChoice("requires_customer_notice", "Customer notice")}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Required Photos">
            <Input
              id={fieldId("required_photo_count")}
              name="required_photo_count"
              type="number"
              min="0"
              step="1"
              value={form.required_photo_count ?? 0}
              onChange={(event) =>
                setCloseout(
                  "required_photo_count",
                  event.target.value === "" ? 0 : Number(event.target.value),
                )
              }
            />
          </Field>
          <Field label="Requirement Source">
            <Input
              id={fieldId("closeout_requirements_source")}
              name="closeout_requirements_source"
              value={form.closeout_requirements_source || "manual"}
              readOnly
            />
          </Field>
        </div>
      </FormSection>

      <Field label="Description">
        <Textarea
          id={fieldId("description")}
          name="description"
          rows={3}
          value={form.description || ""}
          onChange={(event) => set("description", event.target.value)}
        />
      </Field>
      <Field label="Internal Notes">
        <Textarea
          id={fieldId("internal_notes")}
          name="internal_notes"
          rows={2}
          value={form.internal_notes || ""}
          onChange={(event) => set("internal_notes", event.target.value)}
        />
      </Field>
      {error && <ActionFeedback error>{error}</ActionFeedback>}
      <div className="ui-record-actions">
        <Button onClick={submit} loading={saving}>
          {serviceSaveLabel(saving, isNew)}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

function normalizeTab(value) {
  return ["discounts", "protocols"].includes(value) ? value : "catalog";
}

function ownValue(record, key) {
  return Object.hasOwn(record, key) ? record[key] : null;
}

function RailItem({ label, count, active, onClick }) {
  return (
    <Button
      variant={active ? "primary" : "ghost"}
      onClick={onClick}
      aria-pressed={active}
      className={
        "mb-1 flex min-h-11 w-full items-center justify-between gap-2 rounded-sm px-3 text-left text-ui-body font-medium u-focus-ring " +
        (active ? "bg-zinc-900 text-white" : "text-zinc-900 hover:bg-zinc-100")
      }
    >
      <span className="truncate">{label}</span>
      <span
        className={
          "u-nums shrink-0 " + (active ? "text-zinc-200" : "text-ink-secondary")
        }
      >
        {count}
      </span>
    </Button>
  );
}

function RailSection({ title, children }) {
  return (
    <section className="mb-3">
      <h3 className="px-3 pb-2 pt-1 text-ui-caption font-medium text-ink-secondary">
        {title}
      </h3>
      {children}
    </section>
  );
}

function ServiceListRow({ svc, selected, onSelect }) {
  const summary = [
    billingLabel(svc.billing_type),
    frequencyLabel(svc.frequency),
    priceLabel(svc),
  ]
    .filter(Boolean)
    .join(" · ");
  const opacity = svc.is_archived
    ? "opacity-50"
    : svc.is_active
      ? ""
      : "opacity-60";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={
        "flex min-h-[64px] w-full items-center gap-3 border-b border-hairline border-zinc-200 px-4 py-3 text-left u-focus-ring " +
        (selected ? "bg-zinc-900 text-white " : "hover:bg-zinc-50 ") +
        opacity
      }
    >
      <span
        className={
          "h-2 w-2 shrink-0 rounded-full border " +
          (selected ? "border-white " : "border-zinc-500 ") +
          (svc.is_waveguard
            ? selected
              ? "bg-white"
              : "bg-zinc-900"
            : "bg-transparent")
        }
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-medium">
          <span className="truncate">{cleanName(svc)}</span>
          {svc.is_archived && (
            <Badge className={selected ? "bg-zinc-700 text-white" : undefined}>
              Archived
            </Badge>
          )}
          {svc.is_waveguard && (
            <Badge tone={selected ? "neutral" : "strong"}>WG</Badge>
          )}
        </div>
        <div
          className={
            "mt-1 truncate text-ui-caption " +
            (selected ? "text-zinc-200" : "text-ink-secondary")
          }
        >
          {summary || "—"}
        </div>
      </div>
    </button>
  );
}

function ServiceRows({
  loading,
  services,
  selectedId,
  showNew,
  onSelect,
  renderDetail,
}) {
  if (loading && services.length === 0) {
    return (
      <div className="p-8 text-center text-ink-secondary">
        Loading services…
      </div>
    );
  }
  if (services.length === 0) {
    return (
      <div className="p-8 text-center text-ink-secondary">
        No services found
      </div>
    );
  }
  return services.map((service) => {
    const row = (
      <ServiceListRow
        key={service.id}
        svc={service}
        selected={selectedId === service.id && !showNew}
        onSelect={() => onSelect(service)}
      />
    );
    if (!renderDetail) return row;
    return (
      <div key={service.id}>
        {row}
        {renderDetail(service)}
      </div>
    );
  });
}

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
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="sticky top-0 z-[1] border-b border-hairline border-zinc-200 bg-white px-4 py-4 sm:px-6">
          <div className="text-ui-caption text-ink-secondary">New</div>
          <h2 className="m-0 mt-1 text-22 font-medium leading-[1.3] text-zinc-950">
            Add a service
          </h2>
          <p className="m-0 mt-1 text-ui-body text-ink-secondary">
            Define a new entry in the service catalog.
          </p>
        </div>
        <div className="p-4 sm:p-6">
          <ServiceForm
            svc={null}
            onSave={onSaveNew}
            onCancel={onCancelNew}
            isNew
          />
        </div>
      </div>
    );
  }

  if (!svc) {
    return (
      <div className="flex h-full min-h-[260px] flex-col items-center justify-center gap-2 p-8 text-center text-ink-secondary">
        <Library size={32} strokeWidth={1.5} aria-hidden />
        <div className="font-medium text-zinc-900">
          Select a service to view details
        </div>
        <div className="text-ui-caption">
          Or click <strong>+ Add Service</strong>to create one.
        </div>
      </div>
    );
  }

  const products = parseProducts(svc);
  const closeoutRequirements = closeoutRequirementLabels(svc);
  const headlineFacts = [
    {
      key: "billing",
      visible: true,
      value: [billingLabel(svc.billing_type), frequencyLabel(svc.frequency)]
        .filter(Boolean)
        .join(" · "),
    },
    {
      key: "price",
      visible: true,
      value: [priceLabel(svc), variablePriceSuffix(svc)]
        .filter(Boolean)
        .join(" · "),
    },
    {
      key: "duration",
      visible: svc.default_duration_minutes > 0,
      value: `${svc.default_duration_minutes} min`,
    },
    {
      key: "visits",
      visible: svc.visits_per_year > 0,
      value: `${svc.visits_per_year} visits/yr`,
    },
  ]
    .filter((fact) => fact.visible)
    .map((fact) => fact.value)
    .join(" · ");
  const requirementItems = [
    {
      key: "license",
      label: "License",
      value: svc.license_category,
      visible: Boolean(svc.license_category),
    },
    {
      key: "skill",
      label: "Min Skill",
      value: `Level ${svc.min_tech_skill_level}`,
      visible: svc.min_tech_skill_level > 1,
    },
    {
      key: "follow-up",
      label: "Follow-up",
      value: `${[svc.follow_up_interval_days, "—"].find(Boolean)} days`,
      visible: Boolean(svc.requires_follow_up),
    },
  ].filter((item) => item.visible);
  const summarySections = [
    {
      key: "description",
      visible: Boolean(svc.description),
      content: (
        <section key="description">
          <h3 className="mb-1 text-ui-body font-medium text-zinc-900">
            Description
          </h3>
          <p className="m-0 text-ui-body text-zinc-800">{svc.description}</p>
        </section>
      ),
    },
    {
      key: "products",
      visible: products.length > 0,
      content: (
        <section key="products">
          <h3 className="mb-2 text-ui-body font-medium text-zinc-900">
            Default Products
          </h3>
          <div className="flex flex-wrap gap-2">
            {products.map((product, index) => (
              <Badge key={index}>{product}</Badge>
            ))}
          </div>
        </section>
      ),
    },
    {
      key: "closeout",
      visible: closeoutRequirements.length > 0,
      content: (
        <section key="closeout">
          <h3 className="mb-2 text-ui-body font-medium text-zinc-900">
            Closeout Requirements
          </h3>
          <div className="flex flex-wrap gap-2">
            {closeoutRequirements.map((item) => (
              <Badge key={item}>{item}</Badge>
            ))}
            <Badge>{svc.closeout_requirements_source || "inferred_v1"}</Badge>
          </div>
        </section>
      ),
    },
    {
      key: "requirements",
      visible: [
        svc.requires_license,
        svc.license_category,
        svc.min_tech_skill_level > 1,
        svc.requires_follow_up,
      ].some(Boolean),
      content: (
        <dl key="requirements" className="flex flex-wrap gap-x-6 gap-y-3">
          {requirementItems.map((item) => (
            <div key={item.key}>
              <dt className="font-medium text-zinc-900">{item.label}</dt>
              <dd className="m-0 text-ink-secondary">{item.value}</dd>
            </div>
          ))}
        </dl>
      ),
    },
  ].filter((section) => section.visible);

  const handleDelete = async () => {
    if (
      !window.confirm(
        'Archive "' +
          cleanName(svc) +
          '"?\n\nThis removes it from the active service catalog. The archive will be blocked if this service is still referenced by live schedules, packages, add-ons, or discount rules.',
      )
    )
      return;
    try {
      await aFetch(`/admin/services/${svc.id}`, { method: "DELETE" });
      onDeleted();
    } catch (error) {
      window.alert("Archive failed: " + (error?.message || "unknown error"));
    }
  };

  const handleToggleActive = async () => {
    try {
      await aFetch(`/admin/services/${svc.id}`, {
        method: "PUT",
        body: JSON.stringify({ is_active: !svc.is_active }),
      });
      onUpdated();
    } catch (error) {
      window.alert(
        "Status update failed: " + (error?.message || "unknown error"),
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
    } catch (error) {
      window.alert("Restore failed: " + (error?.message || "unknown error"));
    }
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto" key={svc.id}>
      <div className="sticky top-0 z-[1] border-b border-hairline border-zinc-200 bg-white px-4 py-4 sm:px-6">
        <div className="text-ui-caption text-ink-secondary">
          {[categoryLabel(svc.category), svc.subcategory]
            .filter(Boolean)
            .join(" · ")}
        </div>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <h2 className="m-0 flex flex-wrap items-center gap-2 text-22 font-medium leading-[1.3] text-zinc-950">
            {cleanName(svc)}
            {svc.is_waveguard && <Badge tone="strong">WaveGuard</Badge>}
          </h2>
          {svc.is_archived ? (
            <Badge>Archived</Badge>
          ) : (
            <Button
              variant="secondary"
              onClick={handleToggleActive}
              title="Toggle active status"
            >
              {svc.is_active ? "● Active" : "○ Inactive"}
            </Button>
          )}
        </div>
        <div className="u-nums mt-3 text-ui-body font-medium text-zinc-900">
          {headlineFacts}
        </div>
      </div>

      <div className="space-y-4 px-4 pt-5 sm:px-6">
        {summarySections.map((section) => section.content)}
      </div>

      <div className="p-4 sm:p-6">
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
        />
        <div className="mt-5 border-t border-hairline border-zinc-200 pt-4">
          {svc.is_archived ? (
            <Button variant="secondary" onClick={handleRestore}>
              Restore service
            </Button>
          ) : (
            <Button variant="danger" onClick={handleDelete}>
              Archive service
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function CompactCategoryChips({ counts, selectedView, onChange }) {
  const items = [
    { key: "all", label: "All", count: counts.all },
    ...CATEGORIES.filter((category) => counts.byCategory[category.value]).map(
      (category) => ({
        key: "category:" + category.value,
        label: category.label,
        count: counts.byCategory[category.value],
      }),
    ),
    { key: "view:waveguard", label: "WaveGuard", count: counts.waveguard },
    { key: "view:recurring", label: "Recurring", count: counts.recurring },
    { key: "view:onetime", label: "One-Time", count: counts.onetime },
    ...(counts.inactive > 0
      ? [{ key: "view:inactive", label: "Inactive", count: counts.inactive }]
      : []),
    ...(counts.archived > 0
      ? [{ key: "view:archived", label: "Archived", count: counts.archived }]
      : []),
  ];
  return (
    <div className="flex gap-2 overflow-x-auto pb-3">
      {items.map((item) => (
        <Button
          key={item.key}
          variant={selectedView === item.key ? "primary" : "secondary"}
          className="shrink-0"
          onClick={() => onChange(item.key)}
        >
          {item.label}{" "}
          <span className="u-nums ml-1 opacity-70">{item.count}</span>
        </Button>
      ))}
    </div>
  );
}

export default function ServiceLibraryPage() {
  const isMobile = useIsMobile(768);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedView, setSelectedView] = useState("all");
  const [selectedId, setSelectedId] = useState(null);
  const [secondary, setSecondary] = useState(null);
  const [search, setSearch] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);
  const [loadError, setLoadError] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTabState] = useState(() =>
    normalizeTab(searchParams.get("tab")),
  );
  const [isTablet, setIsTablet] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 1280,
  );

  useRenderedTabBeacon(
    "/admin/service-library",
    tab === "protocols" ? null : tab,
    [searchParams],
  );

  useEffect(() => {
    const onResize = () => setIsTablet(window.innerWidth < 1280);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    setTabState(normalizeTab(searchParams.get("tab")));
  }, [searchParams]);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const setTab = useCallback(
    (nextTab) => {
      const normalized = normalizeTab(nextTab);
      setTabState(normalized);
      const next = new URLSearchParams(searchParams);
      if (normalized === "catalog") {
        next.delete("tab");
        next.delete("protocolTab");
      } else {
        next.set("tab", normalized);
        if (normalized !== "protocols") next.delete("protocolTab");
      }
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const showToast = (message) => {
    clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(""), 3000);
  };

  const loadServices = useCallback(async () => {
    setLoading(true);
    try {
      setLoadError("");
      setServices(await fetchAllServices("include_archived=true"));
    } catch (error) {
      setLoadError(error?.message || "Failed to load the service catalog");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab !== "protocols") loadServices();
  }, [loadServices, tab]);

  if (isMobile && tab !== "protocols") {
    return (
      <MobileServiceLibrary
        initialView={tab === "discounts" ? "discounts" : "menu"}
        onOpenProtocols={() => setTab("protocols")}
      />
    );
  }

  const activeServices = services.filter(isActiveCatalogService);
  const counts = {
    all: activeServices.length,
    waveguard: activeServices.filter((service) => service.is_waveguard).length,
    recurring: activeServices.filter(
      (service) => service.billing_type === "recurring",
    ).length,
    onetime: activeServices.filter(
      (service) => service.billing_type === "one_time",
    ).length,
    inactive: services.filter(SERVICE_VIEW_PREDICATES["view:inactive"]).length,
    archived: services.filter(SERVICE_VIEW_PREDICATES["view:archived"]).length,
    byCategory: activeServices.reduce((byCategory, service) => {
      const category = service.category || "other";
      byCategory[category] = (byCategory[category] || 0) + 1;
      return byCategory;
    }, {}),
  };

  const configuredViewPredicate = ownValue(
    SERVICE_VIEW_PREDICATES,
    selectedView,
  );
  const viewPredicate = configuredViewPredicate || (() => true);
  const query = search.trim().toLowerCase();
  const viewFiltered = services
    .filter(viewPredicate)
    .filter(
      (service) =>
        !query ||
        SERVICE_SEARCH_FIELDS.some((field) =>
          String(service[field] || "")
            .toLowerCase()
            .includes(query),
        ),
    )
    .sort(
      (a, b) =>
        (a.sort_order ?? 999) - (b.sort_order ?? 999) ||
        (a.name || "").localeCompare(b.name || ""),
    );

  const selectedSvc = services.find((service) => service.id === selectedId);
  const {
    actions: secondaryActions,
    sections: secondarySections = [],
    activeKey: secondaryActiveKey,
    onChange: onSecondaryChange,
    ariaLabel: secondaryAriaLabel,
    navGridClassName: secondaryNavGridClassName,
  } = secondary ?? {};
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
    { key: "protocols", label: "Treatment Plans", Icon: Sprout },
    { key: "discounts", label: "Discounts", Icon: Percent },
  ];

  const selectView = (value) => {
    setSelectedView(value);
    setSelectedId(null);
  };
  const headerAction = ownValue(
    {
      catalog: {
        label: "Add Service",
        icon: Plus,
        onClick: () => {
          setShowNew(true);
          setSelectedId(null);
        },
      },
    },
    tab,
  );

  return (
    <UiSurface
      density="comfortable"
      className="mx-auto min-w-0 max-w-[1300px] text-ui-body text-zinc-900"
    >
      <AdminCommandHeader
        variant="workspace"
        title="Services"
        icon={Library}
        sections={tabs}
        activeKey={tab}
        onSectionChange={setTab}
        ariaLabel="Services section"
        navGridClassName="grid-cols-1 sm:grid-cols-3"
        actions={secondaryActions}
        secondarySections={secondarySections}
        secondaryActiveKey={secondaryActiveKey}
        onSecondaryChange={onSecondaryChange}
        secondaryAriaLabel={secondaryAriaLabel}
        secondaryNavGridClassName={secondaryNavGridClassName}
        action={headerAction}
      />

      {toast && (
        <ActionFeedback className="pointer-events-none fixed right-[calc(20px+env(safe-area-inset-right,0px))] top-[calc(20px+env(safe-area-inset-top,0px))] z-[300] max-w-[calc(100vw-40px)] rounded-md border-hairline border-zinc-200 bg-white px-3.5 py-3 shadow-lg">
          {toast}
        </ActionFeedback>
      )}
      {tab === "catalog" && loadError && (
        <Card className="mb-3">
          <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <ActionFeedback error className="flex-1">
              Service catalog unavailable: {loadError}
            </ActionFeedback>
            <Button variant="secondary" onClick={loadServices}>
              Retry
            </Button>
          </CardBody>
        </Card>
      )}

      {tab === "catalog" &&
        (isTablet ? (
          <div className="space-y-3">
            <CompactCategoryChips
              counts={counts}
              selectedView={selectedView}
              onChange={selectView}
            />
            <Card>
              <CardBody>
                <Field label="Search services">
                  <Input
                    type="search"
                    placeholder={SERVICE_SEARCH_PLACEHOLDER}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </Field>
              </CardBody>
            </Card>
            {showNew && (
              <Card>
                <DetailPane
                  creating
                  onSaveNew={handleCreate}
                  onCancelNew={() => setShowNew(false)}
                />
              </Card>
            )}
            <Card className="overflow-hidden">
              <ServiceRows
                loading={loading}
                services={viewFiltered}
                selectedId={selectedId}
                showNew={showNew}
                onSelect={(service) => {
                  const open = selectedId === service.id;
                  setSelectedId(open ? null : service.id);
                  setShowNew(false);
                }}
                renderDetail={(service) =>
                  selectedId === service.id ? (
                    <div className="border-b border-hairline border-zinc-200 bg-zinc-50">
                      <DetailPane
                        svc={service}
                        onUpdated={handleUpdated}
                        onDeleted={handleDeleted}
                      />
                    </div>
                  ) : null
                }
              />
            </Card>
          </div>
        ) : (
          <Card
            className="grid min-h-[420px] grid-cols-[210px_360px_minmax(0,1fr)] overflow-hidden"
            style={{
              height: "clamp(420px, calc(100dvh - 240px), 760px)",
            }}
          >
            <aside
              className="min-h-0 overflow-y-auto border-r border-hairline border-zinc-200 bg-zinc-50 p-2"
              aria-label="Service catalog filters"
            >
              <RailSection title="Catalog">
                <RailItem
                  label="All Services"
                  count={counts.all}
                  active={selectedView === "all"}
                  onClick={() => selectView("all")}
                />
              </RailSection>
              <RailSection title="Categories">
                {CATEGORIES.filter(
                  (category) => counts.byCategory[category.value],
                ).map((category) => (
                  <RailItem
                    key={category.value}
                    label={category.label}
                    count={counts.byCategory[category.value] || 0}
                    active={selectedView === "category:" + category.value}
                    onClick={() => selectView("category:" + category.value)}
                  />
                ))}
              </RailSection>
              <RailSection title="Saved Views">
                <RailItem
                  label="WaveGuard"
                  count={counts.waveguard}
                  active={selectedView === "view:waveguard"}
                  onClick={() => selectView("view:waveguard")}
                />
                <RailItem
                  label="Recurring"
                  count={counts.recurring}
                  active={selectedView === "view:recurring"}
                  onClick={() => selectView("view:recurring")}
                />
                <RailItem
                  label="One-Time"
                  count={counts.onetime}
                  active={selectedView === "view:onetime"}
                  onClick={() => selectView("view:onetime")}
                />
                {counts.inactive > 0 && (
                  <RailItem
                    label="Inactive"
                    count={counts.inactive}
                    active={selectedView === "view:inactive"}
                    onClick={() => selectView("view:inactive")}
                  />
                )}
                {counts.archived > 0 && (
                  <RailItem
                    label="Archived"
                    count={counts.archived}
                    active={selectedView === "view:archived"}
                    onClick={() => selectView("view:archived")}
                  />
                )}
              </RailSection>
            </aside>
            <section
              className="flex min-h-0 min-w-0 flex-col border-r border-hairline border-zinc-200"
              aria-label="Services"
            >
              <div className="border-b border-hairline border-zinc-200 p-3">
                <Field label="Search services">
                  <Input
                    type="search"
                    placeholder={SERVICE_SEARCH_PLACEHOLDER}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </Field>
                <div className="u-nums mt-2 text-ui-caption text-ink-secondary">
                  {viewFiltered.length}{" "}
                  {viewFiltered.length === 1 ? "service" : "services"}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <ServiceRows
                  loading={loading}
                  services={viewFiltered}
                  selectedId={selectedId}
                  showNew={showNew}
                  onSelect={(service) => {
                    setSelectedId(service.id);
                    setShowNew(false);
                  }}
                />
              </div>
            </section>
            <section
              className="min-h-0 min-w-0 bg-white"
              aria-label="Service details"
            >
              <DetailPane
                svc={showNew ? null : selectedSvc}
                creating={showNew}
                onSaveNew={handleCreate}
                onCancelNew={() => setShowNew(false)}
                onUpdated={handleUpdated}
                onDeleted={handleDeleted}
              />
            </section>
          </Card>
        ))}

      {tab === "protocols" && (
        <Suspense
          fallback={
            <Card>
              <CardBody className="py-10 text-center text-ink-secondary">
                Loading protocol workspace…
              </CardBody>
            </Card>
          }
        >
          <LawnProtocolCommandCenterPage
            embedded
            onSecondaryNav={setSecondary}
          />
        </Suspense>
      )}
      {tab === "discounts" && <DiscountsSection />}
    </UiSurface>
  );
}
