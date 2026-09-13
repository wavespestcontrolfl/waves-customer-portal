// Mobile-only Service Library views. Rendered from ServiceLibraryPage when
// viewport < 768px. The menu exposes three drill-in views plus the parent
// Services hub's Treatment Plans workspace:
//   - Categories       — services grouped by `category`, item counts + subcategory counts
//   - Discounts        — list from GET /admin/discounts with % / $ suffix
//   - All Services     — flat list from GET /admin/services (+ Create Service CTA)
//
// Treatment Plans delegates to ServiceLibraryPage so desktop and mobile
// use the same URL-addressable workflow.

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Library,
  Percent,
  Plus,
} from "lucide-react";
import AdminCommandHeader from "./AdminCommandHeader";
import {
  ActionFeedback,
  Button,
  Card,
  CardBody,
  Checkbox,
  Field,
  Input,
  Select,
  UiSurface,
} from "../ui";
import { SERVICE_CATEGORY_LABELS as CATEGORY_LABELS } from "../../constants/serviceCategories";
import { buildMobileServicePayload } from "../../lib/serviceLibraryPayload";

const API = import.meta.env.VITE_API_URL || "/api";

async function aFetch(path, opts = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...opts,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || `HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchAllServices(params = new URLSearchParams()) {
  const rows = [];
  let offset = 0;
  let total = 0;
  do {
    const pageParams = new URLSearchParams(params);
    pageParams.set("limit", "500");
    pageParams.set("offset", String(offset));
    const data = await aFetch(`/admin/services?${pageParams}`);
    const page = data.services || [];
    rows.push(...page);
    total = Number(data.total || rows.length);
    offset += page.length;
    if (page.length === 0) break;
  } while (rows.length < total);
  return rows;
}

// Shared row styling for the drill-in lists.
const rowChrome =
  "flex min-h-[64px] items-center gap-3 bg-white border-hairline border-zinc-200 rounded-sm px-3 no-underline";
const editPanelChrome =
  "bg-zinc-50 border-hairline border-zinc-200 rounded-md p-4 flex flex-col gap-4 text-ui-body";

function saveButtonLabel(saving, isNew) {
  if (saving) return "Saving…";
  return isNew ? "Create" : "Save";
}

function SearchBar({ value, onChange, placeholder }) {
  return (
    <Input
      type="search"
      inputMode="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      className="mb-3"
    />
  );
}

function Header({ title, onBack, onAdd, centerTitle = false }) {
  return (
    <div className="mb-3 flex min-h-11 items-center justify-between">
      {" "}
      <Button
        type="button"
        onClick={onBack}
        aria-label="Back"
        variant="ghost"
        className="w-11 px-0"
      >
        <ChevronLeft size={20} aria-hidden />
      </Button>
      {centerTitle && (
        <div className="flex-1 text-center text-18 font-medium text-zinc-900">
          {title}
        </div>
      )}
      {onAdd ? (
        <Button
          type="button"
          onClick={onAdd}
          aria-label="Add"
          className="w-11 px-0"
        >
          <Plus size={20} aria-hidden />
        </Button>
      ) : (
        <div className="h-11 w-11" />
      )}
    </div>
  );
}

function LargeTitle({ children }) {
  return (
    <h1 className="m-0 mb-4 text-22 font-medium tracking-normal text-zinc-900">
      {children}
    </h1>
  );
}

// ── Menu (top of stack) ─────────────────────────────────────────────────
function MenuView({ onNav, onOpenProtocols }) {
  const items = [
    { key: "categories", label: "Categories", hint: "Group services by type" },
    {
      key: "discounts",
      label: "Discounts",
      hint: "Percentage & dollar discounts",
    },
    {
      key: "services",
      label: "All Services",
      hint: "Every service in the library",
    },
    {
      key: "protocols",
      label: "Treatment Plans",
      hint: "Seasonal treatment products and instructions",
    },
  ];
  return (
    <div className="mx-auto max-w-[640px] pb-10 pt-0">
      {" "}
      <AdminCommandHeader title="Services" icon={Library} />
      <div className="flex flex-col gap-2">
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            onClick={() => {
              if (it.key === "protocols") onOpenProtocols?.();
              else onNav(it.key);
            }}
            className={`${rowChrome} justify-between cursor-pointer hover:bg-zinc-50 text-left`}
          >
            {" "}
            <div className="flex-1 min-w-0">
              {" "}
              <div className="text-16 font-medium text-ink-primary">
                {it.label}
              </div>{" "}
              <div className="mt-1 truncate text-ui-caption text-ink-tertiary">
                {it.hint}
              </div>{" "}
            </div>{" "}
            <ChevronRight
              size={20}
              aria-hidden
              className="text-ink-secondary"
            />
          </button>
        ))}
      </div>{" "}
    </div>
  );
}

// ── Thumbnail (small square with Waves logo or category accent) ─────────
function Thumb({ icon }) {
  return (
    <div
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm bg-zinc-200 text-zinc-900"
      aria-hidden
    >
      {icon || (
        <img src="/waves-logo.png" alt="" className="w-8 h-8 object-contain" />
      )}
    </div>
  );
}

// ── Categories view ─────────────────────────────────────────────────────
function CategoriesView({ onBack }) {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [expandedKey, setExpandedKey] = useState(null);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setLoadError(false);
    fetchAllServices(new URLSearchParams({ is_active: "true" }))
      .then((rows) => {
        if (current) setServices(rows);
      })
      .catch(() => {
        if (current) setLoadError(true);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [loadAttempt]);

  const groups = useMemo(() => {
    // Group services by `category`. Count distinct subcategories within each
    // and keep the underlying service rows for the expanded panel.
    const map = new Map();
    for (const s of services) {
      const key = s.category || "other";
      if (!map.has(key)) map.set(key, { key, services: [], subs: new Set() });
      const g = map.get(key);
      g.services.push(s);
      if (s.subcategory) g.subs.add(s.subcategory);
    }
    const q = query.trim().toLowerCase();
    return Array.from(map.values())
      .map((g) => ({
        key: g.key,
        label: CATEGORY_LABELS[g.key] || g.key,
        itemCount: g.services.length,
        subCount: g.subs.size,
        services: g.services,
        subs: Array.from(g.subs).sort(),
      }))
      .filter((g) => !q || g.label.toLowerCase().includes(q))
      .sort((a, b) => b.itemCount - a.itemCount);
  }, [services, query]);

  return (
    <div className="mx-auto max-w-[640px] px-4 pb-10 pt-4">
      {" "}
      <Header title="Categories" onBack={onBack} />{" "}
      <LargeTitle>Categories</LargeTitle>{" "}
      <SearchBar
        value={query}
        onChange={setQuery}
        placeholder="Search Categories"
      />
      {loading ? (
        <div className="p-10 text-center text-ui-body text-ink-secondary">
          Loading…
        </div>
      ) : loadError ? (
        <ActionFeedback
          error
          onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
          className="my-4"
        >
          Could not load categories.
        </ActionFeedback>
      ) : groups.length === 0 ? (
        <div className="p-10 text-center text-ui-body text-ink-secondary">
          No categories
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((g) => {
            const isOpen = expandedKey === g.key;
            return (
              <div key={g.key} className="flex flex-col gap-2">
                {" "}
                <button
                  type="button"
                  onClick={() => setExpandedKey(isOpen ? null : g.key)}
                  aria-expanded={isOpen}
                  className={`${rowChrome} justify-between text-left u-focus-ring`}
                >
                  {" "}
                  <Thumb />{" "}
                  <div className="flex-1 min-w-0">
                    {" "}
                    <div className="truncate text-16 font-medium text-ink-primary">
                      {g.label}
                    </div>{" "}
                    <div className="mt-1 truncate text-ui-caption text-ink-tertiary">
                      {g.subCount} subcategor{g.subCount === 1 ? "y" : "ies"}
                    </div>{" "}
                  </div>{" "}
                  <div className="flex items-center gap-1 text-ui-body text-ink-secondary">
                    {" "}
                    <span className="u-nums">
                      {g.itemCount} item{g.itemCount === 1 ? "" : "s"}
                    </span>{" "}
                    <ChevronRight
                      size={18}
                      aria-hidden
                      className={
                        isOpen
                          ? "rotate-90 transition-transform"
                          : "transition-transform"
                      }
                    />
                  </div>{" "}
                </button>
                {isOpen && <CategoryDetail group={g} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CategoryDetail({ group }) {
  // Group services by subcategory so the panel mirrors how Virginia thinks
  // about the catalog. "—" header is used when subcategory is null.
  const bySub = useMemo(() => {
    const map = new Map();
    for (const s of group.services) {
      const k = s.subcategory || "";
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(s);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [group]);

  return (
    <Card className="bg-zinc-50">
      <CardBody className="space-y-4">
        {" "}
        <div className="text-ui-caption text-ink-tertiary">
          Categories are set per service. Edit a service from{" "}
          <span className="font-medium text-zinc-900">All Services</span>to move it.
        </div>
        {bySub.map(([sub, svcs]) => (
          <div key={sub || "__none__"} className="flex flex-col gap-1">
            {" "}
            <div className="text-ui-caption font-medium text-ink-secondary">
              {sub || "Uncategorized"}
            </div>
            {svcs.map((s) => (
              <div
                key={s.id}
                className="flex min-h-11 items-center justify-between rounded-sm border-hairline border-zinc-200 bg-white px-3"
              >
                {" "}
                <span className="truncate text-ui-body text-ink-primary">
                  {s.name}
                </span>{" "}
                <span className="u-nums text-ui-body text-ink-tertiary">
                  {s.pricing_type === "fixed" && s.base_price
                    ? `$${Number(s.base_price).toFixed(0)}`
                    : s.pricing_type === "variable" ||
                        s.pricing_type === "quoted"
                      ? "Variable"
                      : "—"}
                </span>{" "}
              </div>
            ))}
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

// ── Discounts view ──────────────────────────────────────────────────────
function DiscountsView({ onBack }) {
  const [discounts, setDiscounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setLoadError("");
    return aFetch("/admin/discounts")
      .then((d) => {
        // Endpoint returns a raw array.
        setDiscounts(Array.isArray(d) ? d : d.discounts || []);
        setLoading(false);
      })
      .catch((err) => {
        setLoadError(err?.message || "Failed to load discounts");
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const formatAmount = (d) => {
    const amt = Number(d.amount || 0);
    if (
      d.discount_type === "percentage" ||
      d.discount_type === "variable_percentage"
    ) {
      return `${amt.toFixed(0)}%`;
    }
    if (
      d.discount_type === "fixed_amount" ||
      d.discount_type === "variable_amount"
    ) {
      return `−$${amt.toFixed(2)}`;
    }
    if (d.discount_type === "free_service") return "Free";
    return amt ? String(amt) : "—";
  };

  const q = query.trim().toLowerCase();
  const list = discounts
    .filter((d) => d.is_active !== false)
    .filter((d) => !q || (d.name || "").toLowerCase().includes(q));

  return (
    <div className="mx-auto max-w-[640px] px-4 pb-10 pt-4">
      {" "}
      <Header
        title="Discounts"
        centerTitle
        onBack={onBack}
        onAdd={() => {
          setCreating(true);
          setExpandedId(null);
        }}
      />{" "}
      <SearchBar
        value={query}
        onChange={setQuery}
        placeholder="Search discounts"
      />
      {creating && (
        <div className="mb-3">
          {" "}
          <DiscountEditPanel
            discount={null}
            onCancel={() => setCreating(false)}
            onSaved={async () => {
              await load();
              setCreating(false);
            }}
          />{" "}
        </div>
      )}
      {loadError ? (
        <div
          role="alert"
          className="p-6 text-center text-ui-body text-alert-fg"
        >
          <div>{loadError}</div>
          <Button onClick={load} className="mt-3">
            Retry
          </Button>
        </div>
      ) : loading ? (
        <div className="p-10 text-center text-ui-body text-ink-secondary">
          Loading…
        </div>
      ) : list.length === 0 ? (
        <div className="p-10 text-center text-ui-body text-ink-secondary">
          No discounts
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((d) => {
            const isOpen = expandedId === d.id;
            return (
              <div key={d.id} className="flex flex-col gap-2">
                {" "}
                <button
                  type="button"
                  onClick={() => setExpandedId(isOpen ? null : d.id)}
                  aria-expanded={isOpen}
                  className={`${rowChrome} justify-between text-left u-focus-ring`}
                >
                  {" "}
                  <Thumb icon={<Percent size={18} aria-hidden />} />{" "}
                  <div className="flex-1 min-w-0">
                    {" "}
                    <div className="truncate text-16 font-medium text-ink-primary">
                      {d.name}
                    </div>{" "}
                  </div>{" "}
                  <div className="flex items-center gap-1 text-ui-body text-ink-primary">
                    {" "}
                    <span className="u-nums font-medium">
                      {formatAmount(d)}
                    </span>{" "}
                    <ChevronRight
                      size={18}
                      aria-hidden
                      className={
                        isOpen
                          ? "rotate-90 text-ink-secondary transition-transform"
                          : "text-ink-secondary transition-transform"
                      }
                    />
                  </div>{" "}
                </button>
                {isOpen && (
                  <DiscountEditPanel
                    discount={d}
                    onCancel={() => setExpandedId(null)}
                    onSaved={async () => {
                      await load();
                      setExpandedId(null);
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const DISCOUNT_TYPES = [
  { value: "percentage", label: "Percentage (%)" },
  { value: "fixed_amount", label: "Fixed amount ($)" },
  { value: "variable_percentage", label: "Variable percentage" },
  { value: "variable_amount", label: "Variable amount" },
  { value: "free_service", label: "Free service" },
];

function DiscountEditPanel({ discount, onCancel, onSaved }) {
  const isNew = !discount?.id;
  const availableDiscountTypes = DISCOUNT_TYPES.filter(
    (type) =>
      type.value !== "free_service" ||
      discount?.discount_type === "free_service",
  );
  const [name, setName] = useState(discount?.name || "");
  const [discountType, setDiscountType] = useState(
    discount?.discount_type || "percentage",
  );
  const [amount, setAmount] = useState(
    discount?.amount != null ? String(discount.amount) : "0",
  );
  const [isActive, setIsActive] = useState(discount?.is_active !== false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await aFetch(
        isNew ? "/admin/discounts" : `/admin/discounts/${discount.id}`,
        {
          method: isNew ? "POST" : "PUT",
          body: JSON.stringify({
            name: name.trim(),
            discount_type: discountType,
            amount: amount === "" ? 0 : Number(amount),
            is_active: isActive,
          }),
        },
      );
      await onSaved();
    } catch (err) {
      setError(err.message || "Save failed");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className={editPanelChrome}>
      {isNew && (
        <div className="text-16 font-medium text-ink-primary">New Discount</div>
      )}
      {!isNew && (
        <div className="bg-white border-hairline border-zinc-200 rounded-sm px-3 py-2">
          {" "}
          <div className="text-ui-caption font-medium text-ink-tertiary">
            Quick Edit
          </div>{" "}
          <div className="mt-1 text-ui-caption text-ink-secondary">
            {[
              discount?.discount_key,
              discount?.service_key_filter &&
                `Service: ${discount.service_key_filter}`,
              discount?.promo_code && `Promo: ${discount.promo_code}`,
            ]
              .filter(Boolean)
              .join(" · ") || "General discount"}
          </div>{" "}
        </div>
      )}
      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </Field>{" "}
      <div className="grid grid-cols-2 gap-3">
        {" "}
        <Field label="Type">
          <Select
            value={discountType}
            onChange={(e) => setDiscountType(e.target.value)}
          >
            {availableDiscountTypes.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>{" "}
        <Field label="Amount">
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={discountType === "free_service"}
          />
        </Field>{" "}
      </div>{" "}
      <Checkbox
        label="Active"
        checked={isActive}
        onChange={(e) => setIsActive(e.target.checked)}
      />
      {error && <ActionFeedback error>{error}</ActionFeedback>}
      <div className="flex gap-2 justify-end pt-1">
        {" "}
        <Button
          type="button"
          onClick={onCancel}
          disabled={saving}
          variant="secondary"
        >
          Cancel
        </Button>{" "}
        <Button type="submit" loading={saving}>
          {saveButtonLabel(saving, isNew)}
        </Button>{" "}
      </div>{" "}
    </form>
  );
}

// ── All Services view ───────────────────────────────────────────────────
function AllServicesView({ onBack }) {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [status, setStatus] = useState("active");
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setLoadError("");
    const params = new URLSearchParams();
    if (status === "active") params.set("is_active", "true");
    if (status === "inactive") params.set("is_active", "false");
    if (status === "archived") params.set("is_archived", "true");
    return fetchAllServices(params)
      .then((rows) => {
        setServices(rows);
        setLoading(false);
      })
      .catch((err) => {
        setLoadError(err?.message || "Failed to load services");
        setLoading(false);
      });
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  const formatDuration = (m) => {
    const n = Number(m || 0);
    if (!n) return "";
    if (n === 60) return "1 hr";
    if (n % 60 === 0) return `${n / 60} hr`;
    if (n < 60) return `${n} min`;
    return `${Math.floor(n / 60)} hr ${n % 60} min`;
  };

  const formatPrice = (s) => {
    if (s.pricing_type === "variable" || s.pricing_type === "quoted")
      return "Variable";
    const p = Number(s.base_price || 0);
    return p ? `$${p.toFixed(0)}` : "Variable";
  };

  const q = query.trim().toLowerCase();
  const list = services
    .filter((s) => !q || (s.name || "").toLowerCase().includes(q))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  return (
    <div className="mx-auto max-w-[640px] px-4 pb-10 pt-4">
      {" "}
      <Header title="All services" centerTitle onBack={onBack} />{" "}
      <Button
        type="button"
        onClick={() => {
          setCreating(true);
          setExpandedId(null);
        }}
        variant="secondary"
        className="mt-2 w-full"
      >
        Create Service
      </Button>
      {creating && (
        <div className="mt-3">
          {" "}
          <ServiceEditPanel
            service={null}
            onCancel={() => setCreating(false)}
            onSaved={async () => {
              setCreating(false);
              if (status === "active") await load();
              else setStatus("active");
            }}
          />{" "}
        </div>
      )}
      <div className="mt-3">
        {" "}
        <SearchBar
          value={query}
          onChange={setQuery}
          placeholder="Search All Services"
        />{" "}
      </div>{" "}
      <div className="mb-3 grid grid-cols-4 gap-2">
        {[
          ["active", "Active"],
          ["inactive", "Inactive"],
          ["all", "All"],
          ["archived", "Archived"],
        ].map(([key, label]) => (
          <Button
            key={key}
            variant={status === key ? "primary" : "secondary"}
            onClick={() => {
              setStatus(key);
              setExpandedId(null);
            }}
            className="w-full px-1"
          >
            {label}
          </Button>
        ))}
      </div>
      {loadError ? (
        <div
          role="alert"
          className="p-6 text-center text-ui-body text-alert-fg"
        >
          <div>{loadError}</div>
          <Button type="button" onClick={load} className="mt-3">
            Retry
          </Button>
        </div>
      ) : loading ? (
        <div className="p-10 text-center text-ui-body text-ink-secondary">
          Loading…
        </div>
      ) : list.length === 0 ? (
        <div className="p-10 text-center text-ui-body text-ink-secondary">
          No services
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((s) => {
            const duration = formatDuration(s.default_duration_minutes);
            const price = formatPrice(s);
            const isOpen = expandedId === s.id;
            return (
              <div key={s.id} className="flex flex-col gap-2">
                {" "}
                <button
                  type="button"
                  onClick={() => setExpandedId(isOpen ? null : s.id)}
                  aria-expanded={isOpen}
                  className={`${rowChrome} justify-between py-2 text-left u-focus-ring`}
                >
                  {" "}
                  <Thumb />{" "}
                  <div className="flex-1 min-w-0">
                    {" "}
                    <div className="truncate text-16 font-medium text-ink-primary">
                      {s.name}
                    </div>
                    {(duration || s.is_archived) && (
                      <div className="mt-1 truncate text-ui-caption text-ink-tertiary">
                        {[duration, s.is_archived && "Archived"]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    )}
                  </div>{" "}
                  <div className="flex items-center gap-2">
                    {" "}
                    <span className="u-nums text-ui-body font-medium text-ink-primary">
                      {price}
                    </span>{" "}
                    <ChevronRight
                      size={18}
                      aria-hidden
                      className={
                        isOpen
                          ? "rotate-90 text-ink-secondary transition-transform"
                          : "text-ink-secondary transition-transform"
                      }
                    />
                  </div>{" "}
                </button>
                {isOpen && (
                  <ServiceEditPanel
                    service={s}
                    onCancel={() => setExpandedId(null)}
                    onSaved={async () => {
                      await load();
                      setExpandedId(null);
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const PRICING_TYPES = [
  { value: "fixed", label: "Fixed price" },
  { value: "variable", label: "Variable" },
  { value: "quoted", label: "Quoted" },
];

function ServiceEditPanel({ service, onCancel, onSaved }) {
  const originalService = useRef(service);
  const isNew = !service?.id;
  const isArchived = !!service?.is_archived;
  const [name, setName] = useState(service?.name || "");
  const [duration, setDuration] = useState(
    service?.default_duration_minutes != null
      ? String(service.default_duration_minutes)
      : "60",
  );
  const [pricingType, setPricingType] = useState(
    service?.pricing_type || "variable",
  );
  const [basePrice, setBasePrice] = useState(
    service?.base_price != null ? String(service.base_price) : "",
  );
  const [isActive, setIsActive] = useState(service?.is_active !== false);
  const [requiresServiceReport, setRequiresServiceReport] = useState(
    service?.requires_service_report !== false,
  );
  const [requiresApplicationLog, setRequiresApplicationLog] = useState(
    !!service?.requires_application_log,
  );
  const [requiredPhotoCount, setRequiredPhotoCount] = useState(
    String(service?.required_photo_count || 0),
  );
  const [requiresCustomerSignature, setRequiresCustomerSignature] = useState(
    !!service?.requires_customer_signature,
  );
  const [requiresCustomerNotice, setRequiresCustomerNotice] = useState(
    !!service?.requires_customer_notice,
  );
  const [closeoutTouched, setCloseoutTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const toggleCloseout = (setter, value) => {
    setCloseoutTouched(true);
    setter(value);
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const closeoutPayload = closeoutTouched
      ? {
          requires_service_report: requiresServiceReport,
          requires_application_log: requiresApplicationLog,
          required_photo_count:
            requiredPhotoCount === "" ? 0 : Number(requiredPhotoCount),
          requires_customer_signature: requiresCustomerSignature,
          requires_customer_notice: requiresCustomerNotice,
          closeout_requirements_source: "manual",
        }
      : isNew
        ? {}
        : {
            requires_service_report: requiresServiceReport,
            requires_application_log: requiresApplicationLog,
            required_photo_count:
              requiredPhotoCount === "" ? 0 : Number(requiredPhotoCount),
            requires_customer_signature: requiresCustomerSignature,
            requires_customer_notice: requiresCustomerNotice,
            closeout_requirements_source:
              service?.closeout_requirements_source || "inferred_v1",
          };
    try {
      await aFetch(
        isNew ? "/admin/services" : `/admin/services/${service.id}`,
        {
          method: isNew ? "POST" : "PUT",
          body: JSON.stringify(buildMobileServicePayload({
            service,
            originalService: originalService.current,
            isNew,
            name,
            duration,
            pricingType,
            basePrice,
            isActive,
            closeoutPayload,
          })),
        },
      );
      await onSaved();
    } catch (err) {
      setError(err.message || "Save failed");
      setSaving(false);
    }
  };

  const restore = async () => {
    setSaving(true);
    setError(null);
    try {
      await aFetch(`/admin/services/${service.id}`, {
        method: "PUT",
        body: JSON.stringify({ is_archived: false, is_active: true }),
      });
      await onSaved();
    } catch (err) {
      setError(err.message || "Restore failed");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className={editPanelChrome}>
      {isNew && (
        <div className="text-16 font-medium text-ink-primary">New Service</div>
      )}
      {!isNew && (
        <div className="bg-white border-hairline border-zinc-200 rounded-sm px-3 py-2">
          {" "}
          <div className="text-ui-caption font-medium text-ink-tertiary">
            Quick Edit
          </div>{" "}
          <div className="mt-1 text-ui-caption text-ink-secondary">
            {[
              service?.service_key,
              CATEGORY_LABELS[service?.category] || service?.category,
              service?.billing_type,
              isArchived && "Archived",
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>{" "}
        </div>
      )}
      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </Field>{" "}
      <div className="grid grid-cols-2 gap-3">
        {" "}
        <Field label="Duration (min)">
          <Input
            type="number"
            inputMode="numeric"
            step="5"
            min="0"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </Field>{" "}
        <Field label="Pricing">
          <Select
            value={pricingType}
            onChange={(e) => setPricingType(e.target.value)}
          >
            {PRICING_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>{" "}
      </div>
      {pricingType === "fixed" && (
        <Field label="Base price ($)">
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={basePrice}
            onChange={(e) => setBasePrice(e.target.value)}
          />
        </Field>
      )}
      <Checkbox
        label="Active"
        checked={isActive}
        onChange={(e) => setIsActive(e.target.checked)}
      />
      <div className="border-t border-zinc-200 pt-3 flex flex-col gap-3">
        <div className="text-ui-body font-medium text-ink-primary">
          Closeout Requirements
        </div>
        <Checkbox
          label="Service report"
          checked={requiresServiceReport}
          onChange={(e) =>
            toggleCloseout(setRequiresServiceReport, e.target.checked)
          }
        />
        <Checkbox
          label="Application/material log"
          checked={requiresApplicationLog}
          onChange={(e) =>
            toggleCloseout(setRequiresApplicationLog, e.target.checked)
          }
        />
        <Field label="Required photos">
          <Input
            type="number"
            inputMode="numeric"
            step="1"
            min="0"
            value={requiredPhotoCount}
            onChange={(e) => {
              setCloseoutTouched(true);
              setRequiredPhotoCount(e.target.value);
            }}
          />
        </Field>
        <Checkbox
          label="Customer signature"
          checked={requiresCustomerSignature}
          onChange={(e) =>
            toggleCloseout(setRequiresCustomerSignature, e.target.checked)
          }
        />
        <Checkbox
          label="Customer notice"
          checked={requiresCustomerNotice}
          onChange={(e) =>
            toggleCloseout(setRequiresCustomerNotice, e.target.checked)
          }
        />
      </div>
      {error && <ActionFeedback error>{error}</ActionFeedback>}
      <div className="flex gap-2 justify-end pt-1">
        {isArchived && (
          <Button
            type="button"
            onClick={restore}
            disabled={saving}
            variant="secondary"
          >
            Restore
          </Button>
        )}
        <Button
          type="button"
          onClick={onCancel}
          disabled={saving}
          variant="secondary"
        >
          Cancel
        </Button>{" "}
        <Button type="submit" loading={saving}>
          {saveButtonLabel(saving, isNew)}
        </Button>{" "}
      </div>{" "}
    </form>
  );
}

// ── Root mobile component ───────────────────────────────────────────────
export default function MobileServiceLibrary({
  initialView = "menu",
  onOpenProtocols,
}) {
  const [view, setView] = useState(initialView); // 'menu' | 'categories' | 'discounts' | 'services'
  const onBack = () => setView("menu");

  useEffect(() => {
    setView(initialView || "menu");
  }, [initialView]);

  let content = <MenuView onNav={setView} onOpenProtocols={onOpenProtocols} />;
  if (view === "categories") content = <CategoriesView onBack={onBack} />;
  if (view === "discounts") content = <DiscountsView onBack={onBack} />;
  if (view === "services") content = <AllServicesView onBack={onBack} />;
  return (
    <UiSurface
      density="comfortable"
      className="min-w-0 text-ui-body text-zinc-900"
    >
      {content}
    </UiSurface>
  );
}
