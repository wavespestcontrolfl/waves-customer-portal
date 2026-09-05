import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";
import {
  AlertTriangle,
  Beaker,
  BookOpen,
  Clock,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  Package,
  RefreshCw,
  ShieldCheck,
  Sprout,
  Wrench,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import ProtocolReferenceTabV2 from "./ProtocolReferenceTabV2";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data.error || "Request failed");
      err.validation = data.validation || null;
      throw err;
    }
    return data;
  });
}

function adminPut(path, body) {
  return fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data.error || "Request failed");
      err.validation = data.validation || null;
      throw err;
    }
    return data;
  });
}

function adminPost(path, body = {}) {
  return fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data.error || "Request failed");
      err.validation = data.validation || null;
      throw err;
    }
    return data;
  });
}

function fmtNumber(value, suffix = "") {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
}

function fmtDate(value) {
  if (!value) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [year, month, day] = String(value).split("-").map(Number);
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "America/New_York",
    }).format(new Date(Date.UTC(year, month - 1, day, 12)));
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
}

function statusTone(status) {
  if (status === "ok") return "text-green-700 bg-green-50 border-green-200";
  if (status === "low") return "text-amber-800 bg-amber-50 border-amber-200";
  if (status === "unmapped") return "text-red-700 bg-red-50 border-red-200";
  return "text-zinc-700 bg-zinc-50 border-zinc-200";
}

function Pill({ children, tone = "neutral" }) {
  const cls = tone === "good"
    ? "text-green-700 bg-green-50 border-green-200"
    : tone === "warn"
      ? "text-amber-800 bg-amber-50 border-amber-200"
      : tone === "bad"
        ? "text-red-700 bg-red-50 border-red-200"
        : "text-zinc-700 bg-zinc-50 border-zinc-200";
  return (
    <span className={`inline-flex items-center rounded-sm border px-2 py-1 text-11 font-medium uppercase tracking-label ${cls}`}>
      {children}
    </span>
  );
}

function issueTone(severity) {
  if (severity === "block") return "bad";
  if (severity === "warn") return "warn";
  return "neutral";
}

function Stat({ label, value, tone }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-4">
      <div className="text-11 uppercase tracking-label text-zinc-500">{label}</div>
      <div className={`mt-2 text-24 font-medium ${tone || "text-zinc-900"}`}>{value}</div>
    </div>
  );
}

function Section({ title, icon: Icon, children, action }) {
  return (
    <section className="rounded-md border border-zinc-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3">
        <div className="flex items-center gap-2 text-14 font-medium text-zinc-900">
          {Icon && <Icon size={16} strokeWidth={1.9} className="text-zinc-600" />}
          {title}
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function BridgeList({ title, items }) {
  return (
    <Section title={title} icon={ExternalLink}>
      <div className="grid gap-2">
        {(items || []).map((item) => (
          <Link
            key={`${item.path}-${item.label}`}
            to={item.path}
            className="rounded-sm border border-zinc-200 p-3 transition-colors hover:bg-zinc-50"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="text-14 font-medium text-zinc-900">{item.label}</div>
              <ExternalLink size={14} className="text-zinc-400" />
            </div>
            <div className="mt-1 text-12 leading-5 text-zinc-500">{item.description}</div>
          </Link>
        ))}
      </div>
    </Section>
  );
}

const PROTOCOL_SECTIONS = [
  { key: "mixing", label: "Mixing & labels", Icon: Beaker },
  { key: "overview", label: "Overview", Icon: Sprout },
  { key: "products", label: "Products", Icon: Package },
  { key: "bridges", label: "Instructions", Icon: BookOpen },
  { key: "audit", label: "History", Icon: Clock },
];
const PROTOCOL_TAB_KEYS = new Set(PROTOCOL_SECTIONS.map(({ key }) => key));

function normalizeProtocolTab(value) {
  if (["readiness", "gates", "calibration"].includes(value)) return "overview";
  return PROTOCOL_TAB_KEYS.has(value) ? value : "mixing";
}

// `onSecondaryNav` (from ServiceLibraryPage): the Services header owns the
// card, so the protocol sections + actions are handed up to its second row
// instead of rendering a second header underneath.
export default function LawnProtocolCommandCenterPage({ embedded = false, onSecondaryNav }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryKey = embedded ? "protocolTab" : "tab";
  const activeTab = normalizeProtocolTab(searchParams.get(queryKey));

  // Usage beacon for the leaf that actually RENDERS — invalid or missing
  // ?protocolTab= resolves to Mixing & labels without rewriting the URL. The
  // Service Library host defers to this page for its deepest leaf,
  // matching the nested-*Tab convention (Codex #2961 r17). Embedded-only:
  // the standalone route was retired.
  useRenderedTabBeacon(
    "/admin/service-library",
    embedded ? activeTab : null,
    [searchParams],
  );
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [productSearch, setProductSearch] = useState({});
  const [productResults, setProductResults] = useState({});
  const [savingProductId, setSavingProductId] = useState("");
  const [wikiDraft, setWikiDraft] = useState("");
  const [savingWiki, setSavingWiki] = useState(false);
  const [syncingWiki, setSyncingWiki] = useState(false);
  const [tasksDraft, setTasksDraft] = useState("");
  const [savingTasks, setSavingTasks] = useState(false);
  const [selectedProtocolId, setSelectedProtocolId] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [creatingDraft, setCreatingDraft] = useState(false);
  const setActiveTab = (nextTab) => {
    const next = new URLSearchParams(searchParams);
    const normalized = normalizeProtocolTab(nextTab);
    if (normalized === "mixing") next.delete(queryKey);
    else next.set(queryKey, normalized);
    setSearchParams(next, { replace: true });
  };

  const load = (protocolId = selectedProtocolId) => {
    setLoading(true);
    setError("");
    const suffix = protocolId ? `?protocolId=${encodeURIComponent(protocolId)}` : "";
    adminFetch(`/admin/protocols/lawn/command-center${suffix}`)
      .then((result) => {
        setData(result);
        setWikiDraft((result?.protocol?.window?.wikiRefs || []).join("\n"));
        setTasksDraft((result?.protocol?.window?.requiredTasks || []).join("\n"));
      })
      .catch((err) => setError(err.message || "Could not load protocol command center"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (activeTab !== "mixing" && !data) load();
  }, [activeTab]);

  const protocol = data?.protocol || {};
  const window = protocol.window || {};
  const products = protocol.products || [];
  const canEditProtocol = protocol.status === "draft";
  const publishValidation = data?.publishValidation || { canPublish: false, issues: [], counts: {} };
  const defaultProducts = useMemo(() => products.filter((p) => p.defaultInPlan), [products]);
  const conditionalProducts = useMemo(() => products.filter((p) => !p.defaultInPlan), [products]);
  async function searchCatalogProducts(protocolProductId) {
    const query = productSearch[protocolProductId] || "";
    if (!query.trim()) return;
    const result = await adminFetch(`/admin/inventory?search=${encodeURIComponent(query.trim())}&limit=8`);
    setProductResults((prev) => ({ ...prev, [protocolProductId]: result.products || [] }));
  }

  async function updateProtocolProduct(product, patch) {
    setSavingProductId(product.id);
    setError("");
    setNotice("");
    try {
      await adminPut(`/admin/protocols/lawn/products/${product.id}`, patch);
      setNotice("Protocol product updated.");
      await load();
    } catch (err) {
      setError(err.message || "Could not update protocol product");
    } finally {
      setSavingProductId("");
    }
  }

  async function saveWikiRefs() {
    if (!window.key) return;
    setSavingWiki(true);
    setError("");
    setNotice("");
    try {
      await adminPut(`/admin/protocols/lawn/windows/${window.key}`, { protocolId: protocol.id, wikiRefs: wikiDraft });
      setNotice("Wiki/SOP references updated.");
      await load();
    } catch (err) {
      setError(err.message || "Could not update wiki references");
    } finally {
      setSavingWiki(false);
    }
  }

  async function saveRequiredTasks() {
    if (!window.key) return;
    setSavingTasks(true);
    setError("");
    setNotice("");
    try {
      await adminPut(`/admin/protocols/lawn/windows/${window.key}`, { protocolId: protocol.id, requiredTasks: tasksDraft });
      setNotice("Required closeout tasks updated.");
      await load();
    } catch (err) {
      setError(err.message || "Could not update required tasks");
    } finally {
      setSavingTasks(false);
    }
  }

  async function syncWindowSop() {
    if (!window.key || !protocol.id) return;
    setSyncingWiki(true);
    setError("");
    setNotice("");
    try {
      const result = await adminPost(`/admin/protocols/lawn/windows/${window.key}/wiki-sync`, { protocolId: protocol.id });
      const suffix = result.attachmentRequiresDraft
        ? " Create/select a draft to attach the ref to the protocol window."
        : " SOP ref attached to this draft window.";
      setNotice(`Window SOP synced to Knowledge Base.${suffix}`);
      await load();
    } catch (err) {
      setError(err.message || "Could not sync window SOP");
    } finally {
      setSyncingWiki(false);
    }
  }

  async function createDraft() {
    setCreatingDraft(true);
    setError("");
    setNotice("");
    try {
      const result = await adminPost("/admin/protocols/lawn/drafts", { protocolKey: protocol.protocolKey });
      const draftId = result?.draft?.id;
      if (draftId) setSelectedProtocolId(draftId);
      setNotice("Draft protocol created. Edits will apply to this draft.");
      await load(draftId);
    } catch (err) {
      setError(err.message || "Could not create protocol draft");
    } finally {
      setCreatingDraft(false);
    }
  }

  async function publishDraft() {
    if (protocol.status !== "draft" || !protocol.id) return;
    setPublishing(true);
    setError("");
    setNotice("");
    try {
      await adminPost(`/admin/protocols/lawn/drafts/${protocol.id}/publish`);
      setSelectedProtocolId("");
      setNotice("Draft published as the active crew protocol.");
      await load("");
    } catch (err) {
      setError(err.message || "Could not publish protocol draft");
      if (err.validation) setData((prev) => ({ ...(prev || {}), publishValidation: err.validation }));
    } finally {
      setPublishing(false);
    }
  }

  const headerActions = activeTab === "mixing" ? [] : [
    {
      key: "create-draft",
      label: "Create Draft",
      icon: ClipboardCheck,
      variant: "secondary",
      onClick: createDraft,
      disabled: loading || creatingDraft,
    },
    ...(protocol.status === "draft"
      ? [{
          key: "publish",
          label: "Publish",
          icon: CheckCircle2,
          variant: "primary",
          onClick: publishDraft,
          disabled: loading || publishing || !publishValidation.canPublish,
        }]
      : []),
    {
      key: "refresh",
      label: "Refresh",
      icon: RefreshCw,
      variant: "secondary",
      onClick: () => load(),
      disabled: loading,
    },
  ];
  const hubOwnsHeader = embedded && Boolean(onSecondaryNav);
  const hubNavRef = useRef({});
  hubNavRef.current = { setActiveTab, headerActions };
  const actionsSignature = headerActions.map((a) => `${a.key}:${a.disabled ? 1 : 0}`).join("|");
  useEffect(() => {
    if (!hubOwnsHeader) return undefined;
    onSecondaryNav({
      sections: PROTOCOL_SECTIONS,
      activeKey: activeTab,
      onChange: (key) => hubNavRef.current.setActiveTab(key),
      ariaLabel: "Protocol section",
      navGridClassName: "grid-cols-2 lg:grid-cols-5",
      actions: hubNavRef.current.headerActions.map((a) => ({
        ...a,
        onClick: (...args) => {
          const live = hubNavRef.current.headerActions.find((x) => x.key === a.key);
          return live?.onClick(...args);
        },
      })),
    });
    return () => onSecondaryNav(null);
  }, [hubOwnsHeader, onSecondaryNav, activeTab, actionsSignature]);

  return (
    <div className={embedded
      ? "px-4 pb-4 md:px-6"
      : "mx-auto max-w-7xl px-4 py-4 md:px-6"}
    >
      {!hubOwnsHeader && (
      <AdminCommandHeader
        title="Treatment Plans"
        icon={Sprout}
        sections={PROTOCOL_SECTIONS}
        activeKey={activeTab}
        onSectionChange={setActiveTab}
        headingLevel={embedded ? 2 : 1}
        sticky={!embedded}
        navGridClassName="grid-cols-2 lg:grid-cols-5"
        actions={headerActions}
      />
      )}

      {activeTab === "mixing" ? <ProtocolReferenceTabV2 /> : <>
      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-13 text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-13 text-green-700">
          {notice}
        </div>
      )}

      {!loading && (
        <div className="mb-4 rounded-md border border-zinc-200 bg-white p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={protocol.status === "active" ? "good" : "warn"}>{protocol.status || "unknown"}</Pill>
                <span className="text-13 font-medium text-zinc-900">{protocol.name}</span>
                <span className="text-12 text-zinc-500">{protocol.version}</span>
              </div>
              <div className="mt-1 text-12 text-zinc-500">
                Active view is read-only. Create or select a draft before changing products or instructions.
              </div>
            </div>
            <select
              value={selectedProtocolId}
              onChange={(e) => {
                setSelectedProtocolId(e.target.value);
                load(e.target.value);
              }}
              className="min-w-[240px] rounded-sm border border-zinc-300 px-3 py-2 text-13 text-zinc-900"
            >
              <option value="">Active protocol</option>
              {(data?.drafts || []).map((draft) => (
                <option key={draft.id} value={draft.id}>
                  Draft {draft.version}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {!loading && protocol.status === "draft" && (
        <div className={`mb-4 rounded-md border p-3 ${publishValidation.canPublish ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50"}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-13 font-medium text-zinc-900">Publish checklist</div>
              <div className="mt-1 text-12 text-zinc-600">
                {publishValidation.canPublish
                  ? "No blocking issues. Warnings should still be reviewed before publishing."
                  : "Resolve blocking issues before this draft can become the active crew protocol."}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Pill tone={publishValidation.counts?.block ? "bad" : "good"}>{publishValidation.counts?.block || 0} Block</Pill>
              <Pill tone={publishValidation.counts?.warn ? "warn" : "good"}>{publishValidation.counts?.warn || 0} Warn</Pill>
            </div>
          </div>
          {!!publishValidation.issues?.length && (
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {publishValidation.issues.slice(0, 8).map((issue, index) => (
                <div key={`${issue.code}-${index}`} className="rounded-sm border border-zinc-200 bg-white p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={issueTone(issue.severity)}>{issue.severity}</Pill>
                    <span className="text-12 font-medium uppercase tracking-label text-zinc-500">{issue.code}</span>
                  </div>
                  <div className="mt-2 text-13 leading-5 text-zinc-800">{issue.message}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="rounded-md border border-zinc-200 bg-white p-6 text-14 text-zinc-500">
          Loading protocol command center...
        </div>
      ) : (
        <>
          {activeTab === "overview" && (
            <div className="grid gap-4">
              <div className="grid gap-3 md:grid-cols-4">
                <Stat label="Active window" value={window.title || "No window"} />
                <Stat label="Default products" value={defaultProducts.length} />
                <Stat
                  label="Inventory flags"
                  value={(data?.health?.lowStockProducts || 0) + (data?.health?.unmappedProducts || 0)}
                  tone={(data?.health?.lowStockProducts || data?.health?.unmappedProducts) ? "text-amber-700" : "text-green-700"}
                />
                <Stat label="30-day completions" value={data?.completionStats?.completions30d || 0} />
              </div>

              <Section title="Current protocol window" icon={ClipboardCheck}>
                <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="m-0 text-20 font-medium text-zinc-900">{window.title}</h2>
                      <Pill>{protocol.version}</Pill>
                      <Pill tone="good">{window.productionMode || "production"}</Pill>
                    </div>
                    <p className="mt-3 max-w-3xl text-14 leading-6 text-zinc-600">{window.goal}</p>
                    <div className="mt-4 rounded-sm bg-zinc-50 p-3 text-13 leading-6 text-zinc-700">
                      {protocol.operatingSentence}
                    </div>
                  </div>
                  <div className="grid gap-2 text-13">
                    <div className="flex justify-between border-b border-zinc-100 py-2">
                      <span className="text-zinc-500">Visit type</span>
                      <span className="font-medium text-zinc-900">{window.visitType || "—"}</span>
                    </div>
                    <div className="flex justify-between border-b border-zinc-100 py-2">
                      <span className="text-zinc-500">Carrier</span>
                      <span className="font-medium text-zinc-900">{fmtNumber(window.defaultCarrierGalPer1000, " gal/1K")}</span>
                    </div>
                    <div className="flex justify-between border-b border-zinc-100 py-2">
                      <span className="text-zinc-500">Month</span>
                      <span className="font-medium text-zinc-900">{window.month || "—"}</span>
                    </div>
                  </div>
                </div>
              </Section>

              <div className="grid gap-4 lg:grid-cols-2">
                <Section title="Required closeout tasks" icon={CheckCircle2}>
                  <div className="grid gap-2">
                    {(window.requiredTasks || []).map((task) => (
                      <div key={task} className="flex items-start gap-2 rounded-sm border border-zinc-200 p-3 text-13 text-zinc-700">
                        <CheckCircle2 size={16} className="mt-0.5 text-green-700" />
                        <span>{task}</span>
                      </div>
                    ))}
                    {!window.requiredTasks?.length && <div className="text-13 text-zinc-500">No required tasks for this window.</div>}
                  </div>
                  {canEditProtocol ? (
                    <div className="mt-3 border-t border-zinc-200 pt-3">
                      <textarea
                        value={tasksDraft}
                        onChange={(e) => setTasksDraft(e.target.value)}
                        rows={5}
                        className="w-full rounded-sm border border-zinc-300 px-3 py-2 text-13 text-zinc-900"
                        placeholder="One closeout task per line (e.g. chinch_float_test)"
                      />
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                        <div className="text-12 text-zinc-500">Drives the closeout checklist gate — a missing required task blocks completion.</div>
                        <button
                          type="button"
                          className="rounded-sm bg-zinc-900 px-3 py-2 text-12 font-medium uppercase tracking-label text-white disabled:opacity-50"
                          disabled={savingTasks || !window.key}
                          onClick={saveRequiredTasks}
                        >
                          {savingTasks ? "Saving..." : "Save Tasks"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 text-12 text-zinc-500">Create or select a draft to edit required tasks.</div>
                  )}
                </Section>

                <Section title="Product restrictions" icon={ShieldCheck}>
                  <div className="grid gap-2">
                    {(protocol.gates || []).slice(0, 6).map((gate) => (
                      <div key={gate.key} className="rounded-sm border border-zinc-200 p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-13 font-medium text-zinc-900">{gate.title}</div>
                          <Pill tone={gate.severity === "lockout" ? "bad" : "warn"}>{gate.severity || gate.type}</Pill>
                        </div>
                        <div className="mt-1 text-12 leading-5 text-zinc-500">{gate.ruleText}</div>
                      </div>
                    ))}
                  </div>
                </Section>
              </div>
            </div>
          )}

          {activeTab === "products" && (
            <div className="grid gap-4">
              <Section
                title="Protocol Products + Inventory"
                icon={Package}
                action={<Link to="/admin/inventory?tab=protocols" className="text-12 font-medium uppercase tracking-label text-zinc-700 hover:text-zinc-900">Open Inventory</Link>}
              >
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-13">
                    <thead className="text-11 uppercase tracking-label text-zinc-500">
                      <tr className="border-b border-zinc-200">
                        <th className="py-2 pr-4 font-medium">Product</th>
                        <th className="py-2 pr-4 font-medium">Role</th>
                        <th className="py-2 pr-4 font-medium">Rate</th>
                        <th className="py-2 pr-4 font-medium">Carrier</th>
                        <th className="py-2 pr-4 font-medium">Inventory</th>
                        <th className="py-2 pr-4 font-medium">Mode</th>
                        <th className="py-2 pr-4 font-medium">Manage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {products.map((product) => {
                        const inv = product.inventory || {};
                        return (
                          <tr key={product.id} className="border-b border-zinc-100">
                            <td className="py-3 pr-4">
                              <div className="font-medium text-zinc-900">{product.productName || product.protocolProductName}</div>
                              <div className="text-12 text-zinc-500">{product.protocolProductName}</div>
                            </td>
                            <td className="py-3 pr-4 text-zinc-700">{product.role || "—"}</td>
                            <td className="py-3 pr-4 text-zinc-700">{fmtNumber(product.ratePer1000)} {product.rateUnit || ""}</td>
                            <td className="py-3 pr-4 text-zinc-700">{fmtNumber(product.carrierGalPer1000, " gal/1K")}</td>
                            <td className="py-3 pr-4">
                              <span className={`inline-flex rounded-sm border px-2 py-1 text-11 font-medium uppercase tracking-label ${statusTone(inv.status)}`}>
                                {inv.status || "unknown"}
                              </span>
                              <div className="mt-1 text-12 text-zinc-500">
                                {inv.onHand == null ? "No stock count" : `${fmtNumber(inv.onHand)} ${inv.unit || ""}`}
                              </div>
                            </td>
                            <td className="py-3 pr-4">
                              <Pill tone={product.defaultInPlan ? "good" : "neutral"}>{product.defaultInPlan ? "Default" : "Conditional"}</Pill>
                            </td>
                            <td className="min-w-[260px] py-3 pr-4">
                              <div className="flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  className="rounded-sm border border-zinc-200 px-2 py-1 text-11 font-medium uppercase tracking-label text-zinc-700 hover:bg-zinc-50"
                                  disabled={savingProductId === product.id || !canEditProtocol}
                                  onClick={() => updateProtocolProduct(product, { defaultInPlan: !product.defaultInPlan })}
                                >
                                  {product.defaultInPlan ? "Make Conditional" : "Make Default"}
                                </button>
                                {product.productId && (
                                  <button
                                    type="button"
                                    className="rounded-sm border border-zinc-200 px-2 py-1 text-11 font-medium uppercase tracking-label text-zinc-700 hover:bg-zinc-50"
                                    disabled={savingProductId === product.id || !canEditProtocol}
                                    onClick={() => updateProtocolProduct(product, { productId: null })}
                                  >
                                    Unmap
                                  </button>
                                )}
                              </div>
                              <div className="mt-2 flex gap-2">
                                <input
                                  value={productSearch[product.id] || ""}
                                  onChange={(e) => setProductSearch((prev) => ({ ...prev, [product.id]: e.target.value }))}
                                  placeholder="Search catalog product"
                                  disabled={!canEditProtocol}
                                  className="min-w-0 flex-1 rounded-sm border border-zinc-300 px-2 py-1.5 text-12 text-zinc-900"
                                />
                                <button
                                  type="button"
                                  className="rounded-sm bg-zinc-900 px-2 py-1.5 text-11 font-medium uppercase tracking-label text-white disabled:opacity-50"
                                  disabled={savingProductId === product.id || !canEditProtocol}
                                  onClick={() => searchCatalogProducts(product.id)}
                                >
                                  Search
                                </button>
                              </div>
                              {!!productResults[product.id]?.length && (
                                <div className="mt-2 grid gap-1">
                                  {productResults[product.id].map((result) => (
                                    <button
                                      type="button"
                                      key={result.id}
                                      className="rounded-sm border border-zinc-200 px-2 py-1.5 text-left text-12 text-zinc-700 hover:bg-zinc-50"
                                      disabled={savingProductId === product.id || !canEditProtocol}
                                      onClick={() => updateProtocolProduct(product, { productId: result.id })}
                                    >
                                      <span className="font-medium text-zinc-900">{result.name}</span>
                                      <span className="ml-2 text-zinc-500">{result.activeIngredient || result.category || ""}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Section>

              <Section title="Conditional products" icon={AlertTriangle}>
                <div className="grid gap-2 md:grid-cols-2">
                  {conditionalProducts.map((product) => (
                    <div key={product.id} className="rounded-sm border border-zinc-200 p-3">
                      <div className="text-13 font-medium text-zinc-900">{product.productName || product.protocolProductName}</div>
                      <div className="mt-1 text-12 text-zinc-500">{product.role || "conditional"} · {product.applicationMode || "field-gated"}</div>
                    </div>
                  ))}
                  {!conditionalProducts.length && <div className="text-13 text-zinc-500">No conditional products in this window.</div>}
                </div>
              </Section>
            </div>
          )}

          {activeTab === "bridges" && (
            <div className="grid gap-4 lg:grid-cols-3">
              <BridgeList title="Field execution" items={data?.bridges?.fieldExecution} />
              <BridgeList title="Office control" items={data?.bridges?.officeControl} />
              <BridgeList title="Reporting + Compliance" items={data?.bridges?.reporting} />
              <Section title="Current Window Wiki/SOP Refs" icon={BookOpen}>
                {(data?.wikiPages || []).length > 0 && (
                  <div className="mb-3 grid gap-2">
                    {data.wikiPages.map((page) => (
                      <Link
                        key={page.id}
                        to="/admin/kb"
                        className="rounded-sm border border-zinc-200 p-3 transition-colors hover:bg-zinc-50"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-13 font-medium text-zinc-900">{page.title}</div>
                          <Pill tone={page.status === "active" ? "good" : "neutral"}>{page.status || "kb"}</Pill>
                        </div>
                        <div className="mt-1 text-12 text-zinc-500">
                          {page.slug} · {page.confidence || "medium"} confidence · updated {fmtDate(page.updatedAt)}
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
                <textarea
                  value={wikiDraft}
                  onChange={(e) => setWikiDraft(e.target.value)}
                  rows={7}
                  className="w-full rounded-sm border border-zinc-300 px-3 py-2 text-13 text-zinc-900"
                  placeholder="One wiki/SOP reference per line"
                />
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-12 text-zinc-500">Saved refs travel with the protocol window into treatment plans and service reports.</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="rounded-sm border border-zinc-300 bg-white px-3 py-2 text-12 font-medium uppercase tracking-label text-zinc-800 disabled:opacity-50"
                      disabled={syncingWiki || !window.key || !protocol.id}
                      onClick={syncWindowSop}
                    >
                      {syncingWiki ? "Syncing..." : "Sync SOP"}
                    </button>
                    <button
                      type="button"
                      className="rounded-sm bg-zinc-900 px-3 py-2 text-12 font-medium uppercase tracking-label text-white disabled:opacity-50"
                      disabled={savingWiki || !window.key || !canEditProtocol}
                      onClick={saveWikiRefs}
                    >
                      {savingWiki ? "Saving..." : "Save Refs"}
                    </button>
                  </div>
                </div>
              </Section>
              <Section title="Recent protocol completions" icon={Wrench}>
                <div className="grid gap-2">
                  {(data?.completionStats?.recent || []).map((row) => (
                    <div key={row.id} className="rounded-sm border border-zinc-200 p-3">
                      <div className="text-13 font-medium text-zinc-900">{row.window_title}</div>
                      <div className="mt-1 text-12 text-zinc-500">
                        {fmtDate(row.created_at)} · {fmtNumber(row.treated_sqft, " sq ft")} · {fmtNumber(row.carrier_gal_per_1000, " gal/1K")}
                      </div>
                    </div>
                  ))}
                  {!data?.completionStats?.recent?.length && <div className="text-13 text-zinc-500">No protocol completions logged yet.</div>}
                </div>
              </Section>
            </div>
          )}

          {activeTab === "audit" && (
            <div className="grid gap-4">
              <Section title="Protocol change history" icon={Clock}>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-13">
                    <thead className="text-11 uppercase tracking-label text-zinc-500">
                      <tr className="border-b border-zinc-200">
                        <th className="py-2 pr-4 font-medium">When</th>
                        <th className="py-2 pr-4 font-medium">Actor</th>
                        <th className="py-2 pr-4 font-medium">Entity</th>
                        <th className="py-2 pr-4 font-medium">Changed Fields</th>
                        <th className="py-2 pr-4 font-medium">Context</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data?.recentAudit || []).map((row) => {
                        const changed = Array.isArray(row.changed_fields)
                          ? row.changed_fields
                          : [];
                        const metadata = row.metadata || {};
                        return (
                          <tr key={row.id} className="border-b border-zinc-100 align-top">
                            <td className="py-3 pr-4 text-zinc-700">{fmtDate(row.created_at)}</td>
                            <td className="py-3 pr-4">
                              <div className="font-medium text-zinc-900">{row.actor_name || row.actor_email || "Staff"}</div>
                              {row.actor_email && <div className="text-12 text-zinc-500">{row.actor_email}</div>}
                            </td>
                            <td className="py-3 pr-4">
                              <Pill>{row.entity_type}</Pill>
                              <div className="mt-1 text-12 text-zinc-500">{row.action}</div>
                            </td>
                            <td className="py-3 pr-4">
                              <div className="flex max-w-xl flex-wrap gap-1">
                                {changed.map((field) => (
                                  <span key={field} className="rounded-sm bg-zinc-100 px-2 py-1 text-11 text-zinc-700">
                                    {String(field).replace(/_/g, " ")}
                                  </span>
                                ))}
                                {!changed.length && <span className="text-12 text-zinc-500">No field delta</span>}
                              </div>
                            </td>
                            <td className="py-3 pr-4 text-12 text-zinc-500">
                              {metadata.windowKey || metadata.gateKey || metadata.route || "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {!data?.recentAudit?.length && (
                    <div className="rounded-sm border border-zinc-200 p-4 text-13 text-zinc-500">
                      No protocol edits have been audited yet.
                    </div>
                  )}
                </div>
              </Section>
            </div>
          )}
        </>
      )}
      </>}
    </div>
  );
}
