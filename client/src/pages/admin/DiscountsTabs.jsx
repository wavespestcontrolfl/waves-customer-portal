import { useCallback, useEffect, useState } from "react";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  Input,
  Select,
  Tab,
  TabList,
  TabPanel,
  Table,
  Tabs,
  TBody,
  TD,
  TH,
  THead,
  TR,
  UiSurface,
} from "../../components/ui";

const API = import.meta.env.VITE_API_URL || "/api";

function af(path, opts = {}) {
  return fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...opts,
  }).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  });
}

const TYPE_LABELS = {
  percentage: "Percentage (%)",
  fixed_amount: "Amount ($)",
  variable_amount: "Variable ($)",
  variable_percentage: "Variable (%)",
  free_service: "Free Service",
};

const EMPTY = {
  discount_key: "",
  name: "",
  description: "",
  discount_type: "percentage",
  amount: 0,
  max_discount_dollars: "",
  applies_to: "all",
  service_category_filter: "",
  service_key_filter: "",
  requires_waveguard_tier: "",
  is_waveguard_tier_discount: false,
  requires_military: false,
  requires_senior: false,
  requires_referral: false,
  requires_new_customer: false,
  requires_multi_home: false,
  requires_prepayment: false,
  min_service_count: "",
  min_subtotal: "",
  is_stackable: true,
  stack_group: "",
  priority: 100,
  promo_code: "",
  promo_code_expiry: "",
  promo_code_max_uses: "",
  is_active: true,
  is_auto_apply: false,
  show_in_estimates: true,
  show_in_invoices: true,
  show_in_scheduling: false,
  sort_order: "",
  color: "#18181B",
  icon: "",
};

function toETDateTimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  const hour = part("hour") === "24" ? "00" : part("hour");
  return `${part("year")}-${part("month")}-${part("day")}T${hour}:${part("minute")}`;
}

function SectionLabel({ children }) {
  return (
    <h3 className="col-span-full border-t border-hairline border-zinc-200 pt-4 text-ui-body font-medium text-zinc-900">
      {children}
    </h3>
  );
}

function MetricCard({ label, value }) {
  return (
    <Card>
      <CardBody className="text-center">
        <div className="text-ui-caption text-ink-secondary">{label}</div>
        <div className="u-nums mt-1 text-22 font-medium text-zinc-950">
          {value}
        </div>
      </CardBody>
    </Card>
  );
}

function DiscountsSection() {
  const [discounts, setDiscounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState("catalog");
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [toast, setToast] = useState("");
  const [previewCid, setPreviewCid] = useState("");
  const [previewSub, setPreviewSub] = useState("");
  const [previewResult, setPreviewResult] = useState(null);
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState(false);
  const [statsAttempt, setStatsAttempt] = useState(0);
  const [customers, setCustomers] = useState([]);
  const [custSearch, setCustSearch] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setLoadError("");
    return af("/admin/discounts")
      .then((data) => setDiscounts(Array.isArray(data) ? data : []))
      .catch((error) => {
        setDiscounts([]);
        setLoadError(error?.message || "Failed to load discounts");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const show = (message) => {
    setToast(message);
    setTimeout(() => setToast(""), 3000);
  };

  const save = async () => {
    try {
      const payload = { ...form };
      if (!payload.promo_code) delete payload.promo_code;
      [
        "max_discount_dollars",
        "min_service_count",
        "min_subtotal",
        "promo_code_max_uses",
        "sort_order",
      ].forEach((key) => {
        if (payload[key] === "") payload[key] = null;
      });
      if (editing) {
        await af(`/admin/discounts/${editing}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        show("Discount updated");
      } else {
        await af("/admin/discounts", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        show("Discount created");
      }
      load();
      setTab("catalog");
      setEditing(null);
      setForm({ ...EMPTY });
    } catch (error) {
      show(`Error: ${error.message}`);
    }
  };

  const toggleActive = async (d) => {
    await af(`/admin/discounts/${d.id}`, {
      method: "PUT",
      body: JSON.stringify({ is_active: !d.is_active }),
    });
    load();
  };

  const startEdit = (discount) => {
    const next = { ...EMPTY };
    Object.keys(EMPTY).forEach((key) => {
      if (discount[key] !== null && discount[key] !== undefined)
        next[key] = discount[key];
    });
    if (next.promo_code_expiry)
      next.promo_code_expiry = toETDateTimeLocal(next.promo_code_expiry);
    setForm(next);
    setEditing(discount.id);
    setTab("form");
  };

  const runPreview = async () => {
    try {
      const result = await af("/admin/discounts/calculate", {
        method: "POST",
        body: JSON.stringify({
          customerId: previewCid || null,
          subtotal: Number(previewSub) || 0,
        }),
      });
      setPreviewResult(result);
    } catch {
      show("Preview failed");
    }
  };

  const searchCustomers = async (q) => {
    setCustSearch(q);
    if (q.length < 2) {
      setCustomers([]);
      return;
    }
    try {
      const result = await af(
        `/admin/customers?search=${encodeURIComponent(q)}&limit=5`,
      );
      setCustomers(result.customers || result || []);
    } catch {
      setCustomers([]);
    }
  };

  useEffect(() => {
    if (tab !== "stats") return;
    let current = true;
    setStatsLoading(true);
    setStatsError(false);
    setStats(null);
    af("/admin/discounts/stats")
      .then((data) => {
        if (current) setStats(data);
      })
      .catch(() => {
        if (current) setStatsError(true);
      })
      .finally(() => {
        if (current) setStatsLoading(false);
      });
    return () => {
      current = false;
    };
  }, [tab, statsAttempt]);

  const update = (key, value) =>
    setForm((current) => ({ ...current, [key]: value }));
  const choice = (key, label) => (
    <Checkbox
      label={label}
      checked={!!form[key]}
      onChange={(event) => update(key, event.target.checked)}
    />
  );
  const sortedDiscounts = [...discounts].sort((a, b) =>
    (a.name || "").localeCompare(b.name || ""),
  );
  const visibleTabs = [
    { key: "catalog", label: "Discount Catalog" },
    ...(tab === "form"
      ? [{ key: "form", label: editing ? "Edit Discount" : "Create Discount" }]
      : []),
    { key: "preview", label: "Preview" },
    { key: "stats", label: "Stats" },
  ];

  return (
    <UiSurface density="comfortable" className="space-y-4 text-ui-body text-zinc-900">
      <div className="ui-record-actions justify-end">
        <Button
          onClick={() => {
            setEditing(null);
            setForm({ ...EMPTY });
            setTab("form");
          }}
        >
          + New Discount
        </Button>
      </div>
      {toast && (
        <ActionFeedback
          error={toast.startsWith("Error") || toast === "Preview failed"}
        >
          {toast}
        </ActionFeedback>
      )}
      <Tabs variant="section" value={tab} onValueChange={setTab}>
        <TabList scrollable aria-label="Discount tools">
          {visibleTabs.map((item) => (
            <Tab key={item.key} value={item.key}>
              {item.label}
            </Tab>
          ))}
        </TabList>

        <TabPanel value="catalog">
          {loading ? (
            <Card>
              <CardBody className="py-10 text-center text-ink-secondary">
                Loading discounts…
              </CardBody>
            </Card>
          ) : loadError ? (
            <Card>
              <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <ActionFeedback error className="flex-1">
                  {loadError}
                </ActionFeedback>
                <Button variant="secondary" onClick={load}>
                  Retry
                </Button>
              </CardBody>
            </Card>
          ) : sortedDiscounts.length === 0 ? (
            <Card>
              <CardBody className="py-10 text-center text-ink-secondary">
                No discounts yet. Click <strong>+ New Discount</strong> to add
                your first one.
              </CardBody>
            </Card>
          ) : (
            <Card className="overflow-hidden">
              <Table layout="records" aria-label="Discount catalog">
                <THead>
                  <TR>
                    <TH aria-label="Icon" />
                    <TH>Name</TH>
                    <TH>Type</TH>
                    <TH align="right">Amount</TH>
                    <TH>Eligibility</TH>
                    <TH>Stack</TH>
                    <TH>Auto</TH>
                    <TH align="right">Used</TH>
                    <TH align="right">Total given</TH>
                    <TH align="center">Active</TH>
                    <TH aria-label="Actions" />
                  </TR>
                </THead>
                <TBody>
                  {sortedDiscounts.map((discount) => {
                    const rules = [
                      discount.requires_military && "Military",
                      discount.requires_senior && "Senior",
                      discount.requires_multi_home && "Multi-home",
                      discount.requires_new_customer && "New",
                      discount.requires_prepayment && "Prepay",
                      discount.requires_referral && "Referral",
                      discount.requires_waveguard_tier &&
                        discount.requires_waveguard_tier,
                    ].filter(Boolean);
                    const amount = discount.discount_type.includes("percentage")
                      ? `${discount.amount}%`
                      : discount.discount_type.includes("amount") ||
                          discount.discount_type === "fixed_amount"
                        ? `$${Number(discount.amount).toFixed(2)}`
                        : "Free";
                    return (
                      <TR
                        key={discount.id}
                        className={
                          discount.is_active ? undefined : "opacity-50"
                        }
                      >
                        <TD data-label="Icon">{discount.icon || ""}</TD>
                        <TD
                          data-label="Name"
                          className="font-medium text-zinc-950"
                        >
                          {discount.name}
                        </TD>
                        <TD data-label="Type">
                          <Badge>
                            {TYPE_LABELS[discount.discount_type] ||
                              discount.discount_type}
                          </Badge>
                        </TD>
                        <TD
                          data-label="Amount"
                          align="right"
                          nums
                          className="font-medium"
                        >
                          {amount}
                        </TD>
                        <TD data-label="Eligibility">
                          {rules.length ? (
                            rules.join(", ")
                          ) : (
                            <span className="text-ink-secondary">None</span>
                          )}
                        </TD>
                        <TD data-label="Stack">
                          {discount.stack_group || (
                            <span className="text-ink-secondary">—</span>
                          )}
                        </TD>
                        <TD data-label="Auto">
                          {discount.is_auto_apply ? (
                            <Badge tone="strong">Auto</Badge>
                          ) : (
                            <span className="text-ink-secondary">Manual</span>
                          )}
                        </TD>
                        <TD data-label="Used" align="right" nums>
                          {discount.times_applied || 0}
                        </TD>
                        <TD data-label="Total given" align="right" nums>
                          $
                          {Number(discount.total_discount_given || 0).toFixed(
                            2,
                          )}
                        </TD>
                        <TD data-label="Active" align="center">
                          <Button
                            variant="secondary"
                            onClick={() => toggleActive(discount)}
                          >
                            {discount.is_active ? "On" : "Off"}
                          </Button>
                        </TD>
                        <TD data-label="Actions" align="right">
                          <Button
                            variant="ghost"
                            onClick={() => startEdit(discount)}
                          >
                            Edit
                          </Button>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </Card>
          )}
        </TabPanel>

        <TabPanel value="form" keepMounted={tab === "form"}>
          <Card>
            <CardHeader>
              <CardTitle>
                {editing ? "Edit Discount" : "New Discount"}
              </CardTitle>
            </CardHeader>
            <CardBody className="space-y-5">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field label="Key">
                  <Input
                    value={form.discount_key}
                    onChange={(event) =>
                      update("discount_key", event.target.value)
                    }
                    disabled={!!editing}
                    title={
                      editing
                        ? "Discount keys are locked after creation"
                        : undefined
                    }
                  />
                </Field>
                <Field label="Name">
                  <Input
                    value={form.name}
                    onChange={(event) => update("name", event.target.value)}
                  />
                </Field>
                <Field label="Description" className="md:col-span-2">
                  <Input
                    value={form.description}
                    onChange={(event) =>
                      update("description", event.target.value)
                    }
                  />
                </Field>
                <Field label="Type">
                  <Select
                    value={form.discount_type}
                    onChange={(event) =>
                      update("discount_type", event.target.value)
                    }
                  >
                    <option value="fixed_amount">Amount ($)</option>
                    <option value="percentage">Percentage (%)</option>
                    <option value="variable_amount">Variable Amount ($)</option>
                    <option value="variable_percentage">
                      Variable Percentage (%)
                    </option>
                    <option value="free_service">Free Service</option>
                  </Select>
                </Field>
                <Field
                  label={`Amount ${form.discount_type.includes("percentage") ? "(%)" : "($)"}${form.discount_type.startsWith("variable") ? " — base/default" : ""}`}
                >
                  <Input
                    type="number"
                    value={form.amount}
                    onChange={(event) => update("amount", event.target.value)}
                  />
                </Field>
                <Field label="Max Discount ($)">
                  <Input
                    type="number"
                    value={form.max_discount_dollars}
                    onChange={(event) =>
                      update("max_discount_dollars", event.target.value)
                    }
                  />
                </Field>
                <Field label="Priority (lower = first)">
                  <Input
                    type="number"
                    value={form.priority}
                    onChange={(event) => update("priority", event.target.value)}
                  />
                </Field>
                <SectionLabel>Eligibility rules</SectionLabel>
                <div className="col-span-full flex flex-wrap gap-x-5 gap-y-3">
                  {choice("requires_military", "Military")}
                  {choice("requires_senior", "Senior")}
                  {choice("requires_multi_home", "Multi-Home")}
                  {choice("requires_new_customer", "New Customer")}
                  {choice("requires_referral", "Referral")}
                  {choice("requires_prepayment", "Prepayment")}
                  {choice("is_waveguard_tier_discount", "Tier Discount")}
                </div>
                <Field label="Requires WaveGuard Tier">
                  <Select
                    value={form.requires_waveguard_tier}
                    onChange={(event) =>
                      update("requires_waveguard_tier", event.target.value)
                    }
                  >
                    <option value="">Any / None</option>
                    <option>Platinum</option>
                    <option>Gold</option>
                    <option>Silver</option>
                    <option>Bronze</option>
                    <option>One-Time</option>
                  </Select>
                </Field>
                <Field label="Min Subtotal ($)">
                  <Input
                    type="number"
                    value={form.min_subtotal}
                    onChange={(event) =>
                      update("min_subtotal", event.target.value)
                    }
                  />
                </Field>
                <Field label="Min Service Count">
                  <Input
                    type="number"
                    value={form.min_service_count}
                    onChange={(event) =>
                      update("min_service_count", event.target.value)
                    }
                  />
                </Field>
                <Field label="Service Key Filter">
                  <Input
                    value={form.service_key_filter}
                    onChange={(event) =>
                      update("service_key_filter", event.target.value)
                    }
                  />
                </Field>
                <SectionLabel>Stacking & visibility</SectionLabel>
                <Field label="Stack Group">
                  <Input
                    value={form.stack_group}
                    onChange={(event) =>
                      update("stack_group", event.target.value)
                    }
                  />
                </Field>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                  {choice("is_stackable", "Stackable")}
                  {choice("is_auto_apply", "Auto-Apply")}
                  {choice("is_active", "Active")}
                </div>
                <div className="col-span-full flex flex-wrap items-center gap-x-5 gap-y-3">
                  {choice("show_in_estimates", "Show in Estimates")}
                  {choice("show_in_invoices", "Show in Invoices")}
                  {choice("show_in_scheduling", "Show in Scheduling")}
                </div>
                <SectionLabel>Promo code</SectionLabel>
                <Field label="Code">
                  <Input
                    value={form.promo_code}
                    onChange={(event) =>
                      update("promo_code", event.target.value)
                    }
                    placeholder="e.g. SUMMER25"
                  />
                </Field>
                <Field label="Expiry">
                  <Input
                    type="datetime-local"
                    value={form.promo_code_expiry}
                    onChange={(event) =>
                      update("promo_code_expiry", event.target.value)
                    }
                  />
                </Field>
                <Field label="Max Uses">
                  <Input
                    type="number"
                    value={form.promo_code_max_uses}
                    onChange={(event) =>
                      update("promo_code_max_uses", event.target.value)
                    }
                  />
                </Field>
                <Field label="Color">
                  <Input
                    type="color"
                    className="px-1"
                    value={form.color}
                    onChange={(event) => update("color", event.target.value)}
                  />
                </Field>
                <Field label="Icon (emoji)">
                  <Input
                    value={form.icon}
                    onChange={(event) => update("icon", event.target.value)}
                  />
                </Field>
                <Field label="Sort Order">
                  <Input
                    type="number"
                    value={form.sort_order}
                    onChange={(event) =>
                      update("sort_order", event.target.value)
                    }
                  />
                </Field>
              </div>
              <div className="ui-record-actions">
                <Button onClick={save}>{editing ? "Update" : "Create"}</Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setTab("catalog");
                    setEditing(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </CardBody>
          </Card>
        </TabPanel>

        <TabPanel value="preview">
          <Card>
            <CardHeader>
              <CardTitle>Discount Preview</CardTitle>
            </CardHeader>
            <CardBody className="space-y-5">
              <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_160px_auto]">
                <div className="relative">
                  <Field label="Customer Search">
                    <Input
                      value={custSearch}
                      onChange={(event) => searchCustomers(event.target.value)}
                      placeholder="Name, email, or phone"
                    />
                  </Field>
                  {customers.length > 0 && (
                    <div className="absolute z-10 mt-1 max-h-40 w-full overflow-auto rounded-md border-hairline border-zinc-200 bg-white">
                      {customers.map((customer) => (
                        <button
                          key={customer.id}
                          type="button"
                          className="block min-h-11 w-full border-b border-hairline border-zinc-100 px-3 py-2 text-left text-ui-body hover:bg-zinc-50 u-focus-ring"
                          onClick={() => {
                            setPreviewCid(customer.id);
                            setCustSearch(
                              `${customer.first_name} ${customer.last_name}`,
                            );
                            setCustomers([]);
                          }}
                        >
                          {customer.first_name} {customer.last_name} —{" "}
                          {customer.waveguard_tier || "No tier"}{" "}
                          {customer.is_military ? "(Military)" : ""}{" "}
                          {customer.is_senior ? "(Senior)" : ""}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <Field label="Subtotal ($)">
                  <Input
                    type="number"
                    value={previewSub}
                    onChange={(event) => setPreviewSub(event.target.value)}
                    placeholder="250.00"
                  />
                </Field>
                <Button onClick={runPreview}>Calculate</Button>
              </div>
              {previewResult && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <MetricCard
                      label="Subtotal"
                      value={`$${previewResult.subtotal.toFixed(2)}`}
                    />
                    <MetricCard
                      label="Discount"
                      value={`-$${previewResult.totalDiscount.toFixed(2)}`}
                    />
                    <MetricCard
                      label="After Discount"
                      value={`$${previewResult.afterDiscount.toFixed(2)}`}
                    />
                  </div>
                  {previewResult.discounts.length === 0 && (
                    <div className="py-5 text-center text-ink-secondary">
                      No applicable discounts
                    </div>
                  )}
                  {previewResult.discounts.map((discount, index) => (
                    <div
                      key={index}
                      className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline border-zinc-200 py-2"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        {discount.icon && (
                          <span aria-hidden>{discount.icon}</span>
                        )}
                        <span className="font-medium text-zinc-950">
                          {discount.name}
                        </span>
                        <Badge>
                          {discount.discount_type.includes("percentage")
                            ? `${discount.amount}%`
                            : discount.discount_type.includes("amount") ||
                                discount.discount_type === "fixed_amount"
                              ? `$${discount.amount}`
                              : "Free"}
                        </Badge>
                      </div>
                      <div className="u-nums font-medium text-zinc-950">
                        -${discount.discount_dollars.toFixed(2)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </TabPanel>

        <TabPanel value="stats">
          {statsLoading && (
            <ActionFeedback>Loading discount statistics…</ActionFeedback>
          )}
          {statsError && (
            <ActionFeedback
              error
              onRetry={() => setStatsAttempt((attempt) => attempt + 1)}
            >
              Could not load discount statistics.
            </ActionFeedback>
          )}
          {stats && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <MetricCard
                  label="Total Applications"
                  value={stats.totalApplied}
                />
                <MetricCard
                  label="Total Discounts Given"
                  value={`$${stats.totalGiven.toFixed(2)}`}
                />
              </div>
              <Card className="overflow-hidden">
                <Table layout="records" aria-label="Discount statistics">
                  <THead>
                    <TR>
                      <TH>Name</TH>
                      <TH>Key</TH>
                      <TH align="right">Times Applied</TH>
                      <TH align="right">Total Given</TH>
                      <TH>Active</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {stats.discounts.map((discount) => (
                      <TR key={discount.id}>
                        <TD
                          data-label="Name"
                          className="font-medium text-zinc-950"
                        >
                          {discount.name}
                        </TD>
                        <TD data-label="Key">{discount.discount_key}</TD>
                        <TD data-label="Times applied" align="right" nums>
                          {discount.times_applied || 0}
                        </TD>
                        <TD data-label="Total given" align="right" nums>
                          $
                          {Number(discount.total_discount_given || 0).toFixed(
                            2,
                          )}
                        </TD>
                        <TD data-label="Active">
                          <Badge
                            tone={discount.is_active ? "strong" : "neutral"}
                          >
                            {discount.is_active ? "Active" : "Inactive"}
                          </Badge>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </Card>
            </div>
          )}
        </TabPanel>
      </Tabs>
    </UiSurface>
  );
}

export { DiscountsSection };
