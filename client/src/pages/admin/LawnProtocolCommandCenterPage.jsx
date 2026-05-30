import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  Beaker,
  BookOpen,
  Clock,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  Gauge,
  Package,
  RefreshCw,
  ShieldCheck,
  Sprout,
  Wrench,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";

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

function fmtDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function statusTone(status) {
  if (status === "ok") return "text-green-700 bg-green-50 border-green-200";
  if (status === "low") return "text-amber-800 bg-amber-50 border-amber-200";
  if (status === "unmapped") return "text-red-700 bg-red-50 border-red-200";
  return "text-zinc-700 bg-zinc-50 border-zinc-200";
}

function readinessTone(status) {
  if (status === "ready") return "good";
  if (status === "warning") return "warn";
  if (status === "blocked") return "bad";
  return "neutral";
}

function readinessIssueAction(issue, appointment) {
  const code = String(issue?.code || "");
  if (code === "missing_protocol_assignment") {
    return { type: "assign", label: "Assign" };
  }
  if (code.includes("calibration") || code.includes("equipment")) {
    return { type: "link", label: "Calibration", to: "/admin/equipment?tab=calibrations" };
  }
  if (code.includes("inventory") || code.includes("product")) {
    return { type: "link", label: "Inventory", to: "/admin/inventory?tab=protocols" };
  }
  if (code.includes("turf_profile") || code.includes("profile")) {
    return { type: "link", label: "Customer", to: `/admin/customers?customerId=${encodeURIComponent(appointment.customerId || "")}` };
  }
  if (code.includes("assessment")) {
    return { type: "link", label: "Assessment", to: "/admin/lawn-assessment" };
  }
  if (code.includes("sop") || code.includes("wiki")) {
    return { type: "tab", label: "SOP Refs", tab: "bridges" };
  }
  if (code.includes("blackout") || code.includes("ordinance") || code.includes("phosphorus") || code.includes("nitrogen")) {
    return { type: "link", label: "Compliance", to: "/admin/compliance" };
  }
  return { type: "link", label: "Dispatch", to: `/admin/dispatch?tab=schedule&serviceId=${encodeURIComponent(appointment.id || "")}` };
}

function readinessResolutionCopy(issue) {
  const code = String(issue?.code || "");
  if (code === "missing_protocol_assignment") {
    return "Assign the active protocol window and a field-verified calibration. Re-scan readiness after assignment.";
  }
  if (code.includes("calibration") || code.includes("equipment")) {
    return "Verify the equipment calibration, mark expired records inactive, or assign a valid field-verified calibration.";
  }
  if (code.includes("inventory") || code.includes("product")) {
    return "Restock the mapped product, correct the stock count, or update the protocol product mapping before route day.";
  }
  if (code.includes("turf_profile") || code.includes("profile")) {
    return "Complete the customer turf profile fields needed for cultivar, ordinance zone, turf square footage, and legal gates.";
  }
  if (code.includes("assessment")) {
    return "Complete or update the lawn assessment so irrigation, thatch, pest, disease, and chronic decline flags are current.";
  }
  if (code.includes("sop") || code.includes("wiki")) {
    return "Attach or sync the seasonal SOP reference for the active protocol window.";
  }
  if (code.includes("blackout") || code.includes("ordinance") || code.includes("phosphorus") || code.includes("nitrogen")) {
    return "Review the compliance gate and adjust the plan to the allowed blackout-safe or ordinance-safe alternative.";
  }
  return "Open the appointment in dispatch and resolve the field or office exception before the route is released.";
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

function ReadinessActionButton({ action, appointment, issue, assigningServiceId, onAssign, onTab }) {
  if (!action) return null;
  if (action.type === "link") {
    return (
      <Link
        to={action.to}
        className="inline-flex items-center justify-center rounded-sm border border-zinc-300 bg-white px-3 py-2 text-11 font-medium uppercase tracking-label text-zinc-800 hover:bg-zinc-50"
      >
        {action.label}
      </Link>
    );
  }
  if (action.type === "tab") {
    return (
      <button
        type="button"
        className="inline-flex items-center justify-center rounded-sm border border-zinc-300 bg-white px-3 py-2 text-11 font-medium uppercase tracking-label text-zinc-800 hover:bg-zinc-50"
        onClick={() => onTab(action.tab)}
      >
        {action.label}
      </button>
    );
  }
  if (action.type === "assign") {
    return (
      <button
        type="button"
        className="inline-flex items-center justify-center rounded-sm bg-zinc-900 px-3 py-2 text-11 font-medium uppercase tracking-label text-white disabled:opacity-50"
        disabled={assigningServiceId === appointment.id}
        onClick={() => onAssign(appointment.id)}
      >
        {assigningServiceId === appointment.id ? "Assigning" : action.label}
      </button>
    );
  }
  return (
    <Link
      to={`/admin/dispatch?tab=schedule&serviceId=${encodeURIComponent(appointment?.id || "")}`}
      className="inline-flex items-center justify-center rounded-sm border border-zinc-300 bg-white px-3 py-2 text-11 font-medium uppercase tracking-label text-zinc-800 hover:bg-zinc-50"
    >
      {issue?.severity === "block" ? "Resolve" : "Review"}
    </Link>
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

function buildGateDraft(gate) {
  return {
    title: gate?.title || "",
    gateType: gate?.type || "",
    severity: gate?.severity || "",
    ruleText: gate?.ruleText || "",
    logicText: JSON.stringify(gate?.logic || {}, null, 2),
    wikiRefsText: (gate?.wikiRefs || []).join("\n"),
  };
}

export default function LawnProtocolCommandCenterPage() {
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get("tab") || "overview";
  const [activeTab, setActiveTab] = useState(initialTab);
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
  const [gateDrafts, setGateDrafts] = useState({});
  const [savingGateId, setSavingGateId] = useState("");
  const [selectedProtocolId, setSelectedProtocolId] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [creatingDraft, setCreatingDraft] = useState(false);
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [assigningServiceId, setAssigningServiceId] = useState("");
  const [savingSnapshot, setSavingSnapshot] = useState(false);
  const [selectedExceptionServiceId, setSelectedExceptionServiceId] = useState("");
  const [substitutionSearch, setSubstitutionSearch] = useState({});
  const [substitutionResults, setSubstitutionResults] = useState({});
  const [substitutionDrafts, setSubstitutionDrafts] = useState({});
  const [savingSubstitutionKey, setSavingSubstitutionKey] = useState("");
  const [restockDrafts, setRestockDrafts] = useState({});
  const [savingRestockKey, setSavingRestockKey] = useState("");

  const load = (protocolId = selectedProtocolId) => {
    setLoading(true);
    setError("");
    const suffix = protocolId ? `?protocolId=${encodeURIComponent(protocolId)}` : "";
    adminFetch(`/admin/protocols/lawn/command-center${suffix}`)
      .then((result) => {
        setData(result);
        setWikiDraft((result?.protocol?.window?.wikiRefs || []).join("\n"));
        const nextGateDrafts = {};
        (result?.protocol?.gates || []).forEach((gate) => {
          if (gate.id) nextGateDrafts[gate.id] = buildGateDraft(gate);
        });
        setGateDrafts(nextGateDrafts);
      })
      .catch((err) => setError(err.message || "Could not load protocol command center"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const protocol = data?.protocol || {};
  const window = protocol.window || {};
  const products = protocol.products || [];
  const canEditProtocol = protocol.status === "draft";
  const publishValidation = data?.publishValidation || { canPublish: false, issues: [], counts: {} };
  const defaultProducts = useMemo(() => products.filter((p) => p.defaultInPlan), [products]);
  const conditionalProducts = useMemo(() => products.filter((p) => !p.defaultInPlan), [products]);
  const exceptionAppointments = useMemo(
    () => (data?.readinessQueue?.appointments || []).filter((appt) => appt.status === "blocked" || appt.status === "warning"),
    [data?.readinessQueue?.appointments],
  );
  const selectedExceptionAppointment = useMemo(() => {
    if (!exceptionAppointments.length) return null;
    return exceptionAppointments.find((appt) => appt.id === selectedExceptionServiceId) || exceptionAppointments[0];
  }, [exceptionAppointments, selectedExceptionServiceId]);
  const exceptionIssueCounts = useMemo(() => {
    const counts = {};
    exceptionAppointments.forEach((appt) => {
      (appt.issues || []).forEach((issue) => {
        const key = issue.code || issue.severity || "unknown";
        counts[key] = (counts[key] || 0) + 1;
      });
    });
    return Object.entries(counts)
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count);
  }, [exceptionAppointments]);

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

  async function bulkAssignReadyAppointments() {
    setBulkAssigning(true);
    setError("");
    setNotice("");
    try {
      const result = await adminPost("/admin/protocols/lawn/readiness/bulk-assign", {
        days: data?.readinessQueue?.days || 14,
        limit: 75,
      });
      setNotice(`Bulk assigned ${result.assigned || 0} appointment${result.assigned === 1 ? "" : "s"}; skipped ${result.skipped || 0}.`);
      setData((prev) => ({
        ...(prev || {}),
        readinessQueue: result.readinessQueue || prev?.readinessQueue,
        readinessSnapshots: result.readinessSnapshots || prev?.readinessSnapshots,
      }));
    } catch (err) {
      setError(err.message || "Could not bulk assign appointments");
    } finally {
      setBulkAssigning(false);
    }
  }

  async function assignReadinessAppointment(serviceId) {
    if (!serviceId) return;
    setAssigningServiceId(serviceId);
    setError("");
    setNotice("");
    try {
      const result = await adminPost(`/admin/protocols/lawn/readiness/${serviceId}/assign`, {
        days: data?.readinessQueue?.days || 14,
      });
      setNotice("Appointment assigned from readiness queue.");
      setData((prev) => ({
        ...(prev || {}),
        readinessQueue: result.readinessQueue || prev?.readinessQueue,
        readinessSnapshots: result.readinessSnapshots || prev?.readinessSnapshots,
      }));
    } catch (err) {
      setError(err.message || "Could not assign appointment");
    } finally {
      setAssigningServiceId("");
    }
  }

  function substitutionKey(appointmentId, issue) {
    return `${appointmentId}:${issue?.metadata?.productId || issue?.code || "product"}`;
  }

  async function searchSubstitutionProducts(key) {
    const query = substitutionSearch[key] || "";
    const result = await adminFetch(`/admin/protocols/lawn/substitution-products?q=${encodeURIComponent(query)}`);
    setSubstitutionResults((prev) => ({ ...prev, [key]: result.products || [] }));
  }

  async function approveProductSubstitution(appointment, issue) {
    const key = substitutionKey(appointment.id, issue);
    const originalProductId = issue?.metadata?.productId;
    const draft = substitutionDrafts[key] || {};
    if (!originalProductId || !draft.substituteProductId) {
      setError("Select a substitute product before approving the substitution.");
      return;
    }
    setSavingSubstitutionKey(key);
    setError("");
    setNotice("");
    try {
      const result = await adminPost(`/admin/protocols/lawn/readiness/${appointment.id}/substitutions`, {
        originalProductId,
        substituteProductId: draft.substituteProductId,
        ratePer1000: draft.ratePer1000 || null,
        rateUnit: draft.rateUnit || null,
        reason: draft.reason || "Inventory readiness substitution",
        days: data?.readinessQueue?.days || 14,
      });
      setNotice("Product substitution approved and readiness was rechecked.");
      setData((prev) => ({
        ...(prev || {}),
        readinessQueue: result.readinessQueue || prev?.readinessQueue,
        readinessSnapshots: result.readinessSnapshots || prev?.readinessSnapshots,
      }));
    } catch (err) {
      setError(err.message || "Could not approve product substitution");
    } finally {
      setSavingSubstitutionKey("");
    }
  }

  async function createRestockRequest(appointment, issue) {
    const key = substitutionKey(appointment.id, issue);
    const productId = issue?.metadata?.productId;
    const draft = restockDrafts[key] || {};
    if (!productId) {
      setError("This inventory issue is missing a product id.");
      return;
    }
    setSavingRestockKey(key);
    setError("");
    setNotice("");
    try {
      const result = await adminPost(`/admin/protocols/lawn/readiness/${appointment.id}/restock-requests`, {
        productId,
        requestedQuantity: draft.requestedQuantity || null,
        unit: draft.unit || issue?.metadata?.inventory?.unit || null,
        targetStock: draft.targetStock || null,
        vendor: draft.vendor || null,
        neededBy: draft.neededBy || appointment.scheduledDate || null,
        priority: draft.priority || "high",
        reason: draft.reason || issue.message || "WaveGuard readiness inventory exception",
        issueCode: issue.code || null,
        days: data?.readinessQueue?.days || 14,
      });
      setNotice(`Restock request created for ${result.restockRequest?.productName || "product"}.`);
      setData((prev) => ({
        ...(prev || {}),
        readinessQueue: result.readinessQueue || prev?.readinessQueue,
        readinessSnapshots: result.readinessSnapshots || prev?.readinessSnapshots,
      }));
    } catch (err) {
      setError(err.message || "Could not create restock request");
    } finally {
      setSavingRestockKey("");
    }
  }

  async function saveReadinessSnapshot() {
    setSavingSnapshot(true);
    setError("");
    setNotice("");
    try {
      const result = await adminPost("/admin/protocols/lawn/readiness/snapshot", {
        days: data?.readinessQueue?.days || 14,
        limit: 75,
      });
      const blocked = result.snapshot?.blocked_count || 0;
      setNotice(blocked
        ? `Readiness snapshot saved. Admin alert opened for ${blocked} blocked appointment${blocked === 1 ? "" : "s"}.`
        : "Readiness snapshot saved. No blocked appointments found.");
      setData((prev) => ({
        ...(prev || {}),
        readinessQueue: result.readinessQueue || prev?.readinessQueue,
        readinessSnapshots: result.readinessSnapshots || prev?.readinessSnapshots,
      }));
    } catch (err) {
      setError(err.message || "Could not save readiness snapshot");
    } finally {
      setSavingSnapshot(false);
    }
  }

  function updateGateDraft(gateId, field, value) {
    setGateDrafts((prev) => ({
      ...prev,
      [gateId]: {
        ...(prev[gateId] || {}),
        [field]: value,
      },
    }));
  }

  async function saveGate(gate) {
    const draft = gateDrafts[gate.id] || buildGateDraft(gate);
    let logic = {};
    try {
      logic = draft.logicText?.trim() ? JSON.parse(draft.logicText) : {};
    } catch {
      setError(`Gate logic for "${gate.title}" is not valid JSON.`);
      return;
    }
    setSavingGateId(gate.id);
    setError("");
    setNotice("");
    try {
      await adminPut(`/admin/protocols/lawn/gates/${gate.id}`, {
        title: draft.title,
        gateType: draft.gateType,
        severity: draft.severity,
        ruleText: draft.ruleText,
        logic,
        wikiRefs: draft.wikiRefsText,
      });
      setNotice("Protocol gate updated.");
      await load();
    } catch (err) {
      setError(err.message || "Could not update protocol gate");
    } finally {
      setSavingGateId("");
    }
  }

  const sections = [
    { key: "overview", label: "Overview", Icon: Sprout },
    { key: "readiness", label: "Readiness", Icon: AlertTriangle },
    { key: "products", label: "Products", Icon: Package },
    { key: "gates", label: "Gates", Icon: ShieldCheck },
    { key: "calibration", label: "Calibration", Icon: Gauge },
    { key: "bridges", label: "Bridges", Icon: BookOpen },
    { key: "audit", label: "Audit", Icon: Clock },
  ];

  return (
    <div className="mx-auto max-w-7xl px-4 py-4 md:px-6">
      <AdminCommandHeader
        title="Lawn Protocol"
        icon={Sprout}
        sections={sections}
        activeKey={activeTab}
        onSectionChange={setActiveTab}
        navGridClassName="grid-cols-2 lg:grid-cols-7"
        actions={[
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
            onClick: load,
            disabled: loading,
          },
        ]}
      />

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
                Active view is read-only. Create or select a draft before changing products, gates, or SOP refs.
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

              <Section title="Current Protocol Window" icon={ClipboardCheck}>
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
                <Section title="Required Closeout Tasks" icon={CheckCircle2}>
                  <div className="grid gap-2">
                    {(window.requiredTasks || []).map((task) => (
                      <div key={task} className="flex items-start gap-2 rounded-sm border border-zinc-200 p-3 text-13 text-zinc-700">
                        <CheckCircle2 size={16} className="mt-0.5 text-green-700" />
                        <span>{task}</span>
                      </div>
                    ))}
                    {!window.requiredTasks?.length && <div className="text-13 text-zinc-500">No required tasks for this window.</div>}
                  </div>
                </Section>

                <Section title="Compliance Gates" icon={ShieldCheck}>
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

          {activeTab === "readiness" && (
            <div className="grid gap-4">
              <div className="grid gap-3 md:grid-cols-4">
                <Stat label="Ready" value={data?.readinessQueue?.statusCounts?.ready || 0} tone="text-green-700" />
                <Stat label="Warnings" value={data?.readinessQueue?.statusCounts?.warning || 0} tone="text-amber-700" />
                <Stat label="Blocked" value={data?.readinessQueue?.statusCounts?.blocked || 0} tone="text-red-700" />
                <Stat label="Window" value={`${data?.readinessQueue?.days || 14} days`} />
              </div>

              <Section title="Readiness Snapshot" icon={ClipboardCheck}>
                <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
                  <div className="rounded-sm border border-zinc-200 bg-zinc-50 p-3">
                    <div className="text-11 uppercase tracking-label text-zinc-500">Last snapshot</div>
                    <div className="mt-2 text-16 font-medium text-zinc-900">
                      {data?.readinessSnapshots?.last ? fmtDateTime(data.readinessSnapshots.last.created_at) : "No snapshot saved"}
                    </div>
                    {data?.readinessSnapshots?.last && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Pill tone="good">{data.readinessSnapshots.last.ready_count || 0} Ready</Pill>
                        <Pill tone="warn">{data.readinessSnapshots.last.warning_count || 0} Warn</Pill>
                        <Pill tone="bad">{data.readinessSnapshots.last.blocked_count || 0} Blocked</Pill>
                      </div>
                    )}
                    <button
                      type="button"
                      className="mt-4 rounded-sm bg-zinc-900 px-3 py-2 text-12 font-medium uppercase tracking-label text-white disabled:opacity-50"
                      disabled={savingSnapshot}
                      onClick={saveReadinessSnapshot}
                    >
                      {savingSnapshot ? "Saving..." : "Save Snapshot"}
                    </button>
                  </div>
                  <div>
                    <div className="mb-2 text-11 uppercase tracking-label text-zinc-500">Recent blocked trend</div>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      {(data?.readinessSnapshots?.recent || []).slice(0, 8).map((snap) => (
                        <div key={snap.id} className="rounded-sm border border-zinc-200 p-3">
                          <div className="text-12 font-medium text-zinc-900">{fmtDate(snap.snapshot_date || snap.created_at)}</div>
                          <div className="mt-2 text-22 font-medium text-red-700">{snap.blocked_count || 0}</div>
                          <div className="text-11 uppercase tracking-label text-zinc-500">blocked</div>
                        </div>
                      ))}
                      {!data?.readinessSnapshots?.recent?.length && (
                        <div className="rounded-sm border border-zinc-200 p-3 text-13 text-zinc-500">
                          Save a snapshot to begin tracking readiness history.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </Section>

              <Section title="Exception Resolution" icon={Wrench}>
                {exceptionAppointments.length ? (
                  <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
                    <div className="grid gap-3">
                      <div>
                        <div className="text-11 uppercase tracking-label text-zinc-500">Open exceptions</div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Pill tone="bad">{exceptionAppointments.filter((appt) => appt.status === "blocked").length} Blocked</Pill>
                          <Pill tone="warn">{exceptionAppointments.filter((appt) => appt.status === "warning").length} Warning</Pill>
                        </div>
                      </div>
                      <div className="grid gap-2">
                        {exceptionAppointments.map((appt) => {
                          const selected = selectedExceptionAppointment?.id === appt.id;
                          return (
                            <button
                              key={appt.id}
                              type="button"
                              className={`rounded-sm border p-3 text-left transition-colors ${selected ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 bg-white hover:bg-zinc-50"}`}
                              onClick={() => setSelectedExceptionServiceId(appt.id)}
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="font-medium text-zinc-900">{appt.customerName}</div>
                                <Pill tone={readinessTone(appt.status)}>{appt.status}</Pill>
                              </div>
                              <div className="mt-1 text-12 text-zinc-500">
                                {fmtDate(appt.scheduledDate)} · {appt.city || "No city"} · {appt.counts?.block || 0} block / {appt.counts?.warn || 0} warn
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      {!!exceptionIssueCounts.length && (
                        <div className="rounded-sm border border-zinc-200 bg-zinc-50 p-3">
                          <div className="text-11 uppercase tracking-label text-zinc-500">Top issue types</div>
                          <div className="mt-2 grid gap-1">
                            {exceptionIssueCounts.slice(0, 5).map((item) => (
                              <div key={item.code} className="flex items-center justify-between gap-3 text-12">
                                <span className="text-zinc-700">{item.code.replace(/_/g, " ")}</span>
                                <span className="font-medium text-zinc-900">{item.count}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="rounded-sm border border-zinc-200 bg-white p-4">
                      {selectedExceptionAppointment && (
                        <>
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <div className="text-11 uppercase tracking-label text-zinc-500">Selected appointment</div>
                              <div className="mt-1 text-18 font-medium text-zinc-900">{selectedExceptionAppointment.customerName}</div>
                              <div className="mt-1 text-13 text-zinc-500">
                                {fmtDate(selectedExceptionAppointment.scheduledDate)} · {selectedExceptionAppointment.address || "No address"}{selectedExceptionAppointment.city ? `, ${selectedExceptionAppointment.city}` : ""}
                              </div>
                            </div>
                            <Pill tone={readinessTone(selectedExceptionAppointment.status)}>{selectedExceptionAppointment.status}</Pill>
                          </div>
                          <div className="mt-4 grid gap-3">
                            {(selectedExceptionAppointment.issues || []).map((issue, index) => {
                              const action = readinessIssueAction(issue, selectedExceptionAppointment);
                              return (
                                <div key={`${selectedExceptionAppointment.id}-resolution-${issue.code}-${index}`} className="rounded-sm border border-zinc-200 p-3">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <Pill tone={issueTone(issue.severity)}>{issue.severity}</Pill>
                                    <span className="text-12 font-medium uppercase tracking-label text-zinc-500">{issue.code?.replace(/_/g, " ") || "issue"}</span>
                                  </div>
                                  <div className="mt-2 text-13 leading-5 text-zinc-800">{issue.message}</div>
                                  <div className="mt-2 text-12 leading-5 text-zinc-500">{readinessResolutionCopy(issue)}</div>
                                  {String(issue.code || "").includes("inventory") && issue?.metadata?.productId && (
                                    <div className="mt-3 rounded-sm border border-amber-200 bg-amber-50 p-3">
                                      <div className="text-11 font-medium uppercase tracking-label text-amber-900">Approve substitute for this appointment</div>
                                      {(() => {
                                        const key = substitutionKey(selectedExceptionAppointment.id, issue);
                                        const draft = substitutionDrafts[key] || {};
                                        const results = substitutionResults[key] || [];
                                        return (
                                          <div className="mt-2 grid gap-2">
                                            <div className="flex flex-wrap gap-2">
                                              <input
                                                value={substitutionSearch[key] || ""}
                                                onChange={(event) => setSubstitutionSearch((prev) => ({ ...prev, [key]: event.target.value }))}
                                                placeholder="Search replacement product"
                                                className="min-w-[220px] flex-1 rounded-sm border border-zinc-300 bg-white px-3 py-2 text-13 text-zinc-900"
                                              />
                                              <button
                                                type="button"
                                                className="rounded-sm border border-zinc-300 bg-white px-3 py-2 text-11 font-medium uppercase tracking-label text-zinc-800"
                                                onClick={() => searchSubstitutionProducts(key)}
                                              >
                                                Search
                                              </button>
                                            </div>
                                            {!!results.length && (
                                              <select
                                                value={draft.substituteProductId || ""}
                                                onChange={(event) => {
                                                  const product = results.find((row) => row.id === event.target.value);
                                                  setSubstitutionDrafts((prev) => ({
                                                    ...prev,
                                                    [key]: {
                                                      ...(prev[key] || {}),
                                                      substituteProductId: event.target.value,
                                                      ratePer1000: product?.defaultRatePer1000 ?? prev[key]?.ratePer1000 ?? "",
                                                      rateUnit: product?.rateUnit || prev[key]?.rateUnit || "",
                                                    },
                                                  }));
                                                }}
                                                className="rounded-sm border border-zinc-300 bg-white px-3 py-2 text-13 text-zinc-900"
                                              >
                                                <option value="">Select substitute</option>
                                                {results.map((product) => (
                                                  <option key={product.id} value={product.id}>
                                                    {product.name} {product.inventoryOnHand != null ? `(${product.inventoryOnHand} ${product.inventoryUnit || ""} on hand)` : ""}
                                                  </option>
                                                ))}
                                              </select>
                                            )}
                                            <div className="grid gap-2 sm:grid-cols-3">
                                              <input
                                                value={draft.ratePer1000 || ""}
                                                onChange={(event) => setSubstitutionDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), ratePer1000: event.target.value } }))}
                                                placeholder="Rate / 1K"
                                                className="rounded-sm border border-zinc-300 bg-white px-3 py-2 text-13 text-zinc-900"
                                              />
                                              <input
                                                value={draft.rateUnit || ""}
                                                onChange={(event) => setSubstitutionDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), rateUnit: event.target.value } }))}
                                                placeholder="Unit"
                                                className="rounded-sm border border-zinc-300 bg-white px-3 py-2 text-13 text-zinc-900"
                                              />
                                              <input
                                                value={draft.reason || ""}
                                                onChange={(event) => setSubstitutionDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), reason: event.target.value } }))}
                                                placeholder="Reason"
                                                className="rounded-sm border border-zinc-300 bg-white px-3 py-2 text-13 text-zinc-900"
                                              />
                                            </div>
                                            <button
                                              type="button"
                                              className="justify-self-start rounded-sm bg-zinc-900 px-3 py-2 text-11 font-medium uppercase tracking-label text-white disabled:opacity-50"
                                              disabled={savingSubstitutionKey === key}
                                              onClick={() => approveProductSubstitution(selectedExceptionAppointment, issue)}
                                            >
                                              {savingSubstitutionKey === key ? "Approving..." : "Approve Substitute"}
                                            </button>
                                          </div>
                                        );
                                      })()}
                                    </div>
                                  )}
                                  {String(issue.code || "").includes("inventory") && issue?.metadata?.productId && (
                                    <div className="mt-3 rounded-sm border border-zinc-200 bg-zinc-50 p-3">
                                      <div className="text-11 font-medium uppercase tracking-label text-zinc-600">Create restock request</div>
                                      {(() => {
                                        const key = substitutionKey(selectedExceptionAppointment.id, issue);
                                        const draft = restockDrafts[key] || {};
                                        return (
                                          <div className="mt-2 grid gap-2">
                                            <div className="grid gap-2 sm:grid-cols-4">
                                              <input
                                                value={draft.requestedQuantity || ""}
                                                onChange={(event) => setRestockDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), requestedQuantity: event.target.value } }))}
                                                placeholder="Qty"
                                                className="rounded-sm border border-zinc-300 bg-white px-3 py-2 text-13 text-zinc-900"
                                              />
                                              <input
                                                value={draft.unit || issue?.metadata?.inventory?.unit || ""}
                                                onChange={(event) => setRestockDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), unit: event.target.value } }))}
                                                placeholder="Unit"
                                                className="rounded-sm border border-zinc-300 bg-white px-3 py-2 text-13 text-zinc-900"
                                              />
                                              <input
                                                type="date"
                                                value={draft.neededBy || String(selectedExceptionAppointment.scheduledDate || "").slice(0, 10)}
                                                onChange={(event) => setRestockDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), neededBy: event.target.value } }))}
                                                className="rounded-sm border border-zinc-300 bg-white px-3 py-2 text-13 text-zinc-900"
                                              />
                                              <select
                                                value={draft.priority || "high"}
                                                onChange={(event) => setRestockDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), priority: event.target.value } }))}
                                                className="rounded-sm border border-zinc-300 bg-white px-3 py-2 text-13 text-zinc-900"
                                              >
                                                <option value="normal">Normal</option>
                                                <option value="high">High</option>
                                                <option value="urgent">Urgent</option>
                                              </select>
                                            </div>
                                            <input
                                              value={draft.reason || ""}
                                              onChange={(event) => setRestockDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), reason: event.target.value } }))}
                                              placeholder="Reason"
                                              className="rounded-sm border border-zinc-300 bg-white px-3 py-2 text-13 text-zinc-900"
                                            />
                                            <button
                                              type="button"
                                              className="justify-self-start rounded-sm border border-zinc-300 bg-white px-3 py-2 text-11 font-medium uppercase tracking-label text-zinc-800 disabled:opacity-50"
                                              disabled={savingRestockKey === key}
                                              onClick={() => createRestockRequest(selectedExceptionAppointment, issue)}
                                            >
                                              {savingRestockKey === key ? "Creating..." : "Create Restock Request"}
                                            </button>
                                          </div>
                                        );
                                      })()}
                                    </div>
                                  )}
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    <ReadinessActionButton
                                      action={action}
                                      appointment={selectedExceptionAppointment}
                                      issue={issue}
                                      assigningServiceId={assigningServiceId}
                                      onAssign={assignReadinessAppointment}
                                      onTab={setActiveTab}
                                    />
                                    <Link
                                      to={`/admin/dispatch?tab=schedule&serviceId=${encodeURIComponent(selectedExceptionAppointment.id || "")}`}
                                      className="inline-flex items-center justify-center rounded-sm border border-zinc-300 bg-white px-3 py-2 text-11 font-medium uppercase tracking-label text-zinc-800 hover:bg-zinc-50"
                                    >
                                      Appointment
                                    </Link>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-sm border border-green-200 bg-green-50 p-4 text-13 text-green-800">
                    No blocked or warning appointments in the current readiness window.
                  </div>
                )}
              </Section>

              <Section title="Upcoming WaveGuard Lawn Readiness" icon={AlertTriangle}>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-13 leading-6 text-zinc-600">
                    Office preflight for upcoming lawn appointments. Resolve blocked rows before route day.
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="rounded-sm border border-zinc-300 bg-white px-3 py-2 text-12 font-medium uppercase tracking-label text-zinc-800 disabled:opacity-50"
                      disabled={savingSnapshot}
                      onClick={saveReadinessSnapshot}
                    >
                      {savingSnapshot ? "Saving..." : "Save Snapshot"}
                    </button>
                    <button
                      type="button"
                      className="rounded-sm bg-zinc-900 px-3 py-2 text-12 font-medium uppercase tracking-label text-white disabled:opacity-50"
                      disabled={bulkAssigning}
                      onClick={bulkAssignReadyAppointments}
                    >
                      {bulkAssigning ? "Assigning..." : "Bulk Assign Ready"}
                    </button>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-13">
                    <thead className="text-11 uppercase tracking-label text-zinc-500">
                      <tr className="border-b border-zinc-200">
                        <th className="py-2 pr-4 font-medium">Appointment</th>
                        <th className="py-2 pr-4 font-medium">Customer</th>
                        <th className="py-2 pr-4 font-medium">Protocol</th>
                        <th className="py-2 pr-4 font-medium">Status</th>
                        <th className="py-2 pr-4 font-medium">Top Issues</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data?.readinessQueue?.appointments || []).map((appt) => (
                        <tr key={appt.id} className="border-b border-zinc-100 align-top">
                          <td className="py-3 pr-4">
                            <div className="font-medium text-zinc-900">{fmtDate(appt.scheduledDate)}</div>
                            <div className="text-12 text-zinc-500">{appt.windowStart || "Any time"} · {appt.technicianName || "Unassigned"}</div>
                          </td>
                          <td className="py-3 pr-4">
                            <div className="font-medium text-zinc-900">{appt.customerName}</div>
                            <div className="text-12 text-zinc-500">{appt.address || "No address"}{appt.city ? `, ${appt.city}` : ""}</div>
                          </td>
                          <td className="py-3 pr-4">
                            <div className="text-zinc-900">{appt.protocolWindowTitle || "No window"}</div>
                            <div className="text-12 text-zinc-500">
                              {appt.assignment?.assignedAt ? "Assigned" : "Not assigned"}
                            </div>
                          </td>
                          <td className="py-3 pr-4">
                            <Pill tone={readinessTone(appt.status)}>{appt.status}</Pill>
                            <div className="mt-1 text-12 text-zinc-500">
                              {appt.counts?.block || 0} block · {appt.counts?.warn || 0} warn
                            </div>
                          </td>
                          <td className="py-3 pr-4">
                            <div className="grid gap-1">
                              {(appt.issues || []).slice(0, 4).map((issue, index) => {
                                const action = readinessIssueAction(issue, appt);
                                return (
                                  <div key={`${appt.id}-${issue.code}-${index}`} className="flex flex-wrap items-center gap-2 text-12 leading-5 text-zinc-700">
                                    <span>
                                      <span className={issue.severity === "block" ? "font-medium text-red-700" : "font-medium text-amber-700"}>
                                        {issue.code?.replace(/_/g, " ") || issue.severity}:
                                      </span>{" "}
                                      {issue.message}
                                    </span>
                                    {action.type === "link" && (
                                      <Link
                                        to={action.to}
                                        className="rounded-sm border border-zinc-200 px-2 py-0.5 text-10 font-medium uppercase tracking-label text-zinc-700 hover:bg-zinc-50"
                                      >
                                        {action.label}
                                      </Link>
                                    )}
                                    {action.type === "tab" && (
                                      <button
                                        type="button"
                                        className="rounded-sm border border-zinc-200 px-2 py-0.5 text-10 font-medium uppercase tracking-label text-zinc-700 hover:bg-zinc-50"
                                        onClick={() => setActiveTab(action.tab)}
                                      >
                                        {action.label}
                                      </button>
                                    )}
                                    {action.type === "assign" && (
                                      <button
                                        type="button"
                                        className="rounded-sm border border-zinc-200 px-2 py-0.5 text-10 font-medium uppercase tracking-label text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                                        disabled={assigningServiceId === appt.id}
                                        onClick={() => assignReadinessAppointment(appt.id)}
                                      >
                                        {assigningServiceId === appt.id ? "Assigning" : action.label}
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                              {!appt.issues?.length && <div className="text-12 text-green-700">Ready for route.</div>}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!data?.readinessQueue?.appointments?.length && (
                    <div className="p-4 text-13 text-zinc-500">No upcoming WaveGuard lawn appointments found.</div>
                  )}
                </div>
              </Section>
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

              <Section title="Conditional Products" icon={AlertTriangle}>
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

          {activeTab === "gates" && (
            <div className="grid gap-4">
              <Section title="Protocol Gate Editor" icon={ShieldCheck}>
                <div className="mb-4 rounded-sm border border-amber-200 bg-amber-50 p-3 text-13 leading-6 text-amber-900">
                  Gate changes affect treatment planning, service report context, and crew enforcement. Keep legal lockouts and label restrictions conservative.
                </div>
                <div className="grid gap-4">
                  {(protocol.gates || []).map((gate) => {
                    const draft = gateDrafts[gate.id] || buildGateDraft(gate);
                    return (
                      <div key={gate.id || gate.key} className="rounded-md border border-zinc-200 p-4">
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div className="text-14 font-medium text-zinc-900">{gate.key}</div>
                            <div className="mt-1 text-12 text-zinc-500">{gate.type} · {gate.severity}</div>
                          </div>
                          <button
                            type="button"
                            className="rounded-sm bg-zinc-900 px-3 py-2 text-12 font-medium uppercase tracking-label text-white disabled:opacity-50"
                            disabled={savingGateId === gate.id || !gate.id || !canEditProtocol}
                            onClick={() => saveGate(gate)}
                          >
                            {savingGateId === gate.id ? "Saving..." : "Save Gate"}
                          </button>
                        </div>

                        <div className="grid gap-3 lg:grid-cols-[1fr_180px_180px]">
                          <label className="grid gap-1 text-12 font-medium uppercase tracking-label text-zinc-500">
                            Title
                            <input
                              value={draft.title}
                              onChange={(e) => updateGateDraft(gate.id, "title", e.target.value)}
                              disabled={!canEditProtocol}
                              className="rounded-sm border border-zinc-300 px-3 py-2 text-13 font-normal normal-case tracking-normal text-zinc-900"
                            />
                          </label>
                          <label className="grid gap-1 text-12 font-medium uppercase tracking-label text-zinc-500">
                            Type
                            <input
                              value={draft.gateType}
                              onChange={(e) => updateGateDraft(gate.id, "gateType", e.target.value)}
                              disabled={!canEditProtocol}
                              className="rounded-sm border border-zinc-300 px-3 py-2 text-13 font-normal normal-case tracking-normal text-zinc-900"
                            />
                          </label>
                          <label className="grid gap-1 text-12 font-medium uppercase tracking-label text-zinc-500">
                            Severity
                            <select
                              value={draft.severity}
                              onChange={(e) => updateGateDraft(gate.id, "severity", e.target.value)}
                              disabled={!canEditProtocol}
                              className="rounded-sm border border-zinc-300 px-3 py-2 text-13 font-normal normal-case tracking-normal text-zinc-900"
                            >
                              <option value="block">block</option>
                              <option value="lockout">lockout</option>
                              <option value="warn">warn</option>
                              <option value="info">info</option>
                            </select>
                          </label>
                        </div>

                        <label className="mt-3 grid gap-1 text-12 font-medium uppercase tracking-label text-zinc-500">
                          Rule Text
                          <textarea
                            value={draft.ruleText}
                            onChange={(e) => updateGateDraft(gate.id, "ruleText", e.target.value)}
                            rows={3}
                            disabled={!canEditProtocol}
                            className="rounded-sm border border-zinc-300 px-3 py-2 text-13 font-normal normal-case leading-6 tracking-normal text-zinc-900"
                          />
                        </label>

                        <div className="mt-3 grid gap-3 lg:grid-cols-2">
                          <label className="grid gap-1 text-12 font-medium uppercase tracking-label text-zinc-500">
                            Logic JSON
                            <textarea
                              value={draft.logicText}
                              onChange={(e) => updateGateDraft(gate.id, "logicText", e.target.value)}
                              rows={8}
                              spellCheck={false}
                              disabled={!canEditProtocol}
                              className="font-mono rounded-sm border border-zinc-300 px-3 py-2 text-12 font-normal normal-case leading-5 tracking-normal text-zinc-900"
                            />
                          </label>
                          <label className="grid gap-1 text-12 font-medium uppercase tracking-label text-zinc-500">
                            Wiki/SOP Refs
                            <textarea
                              value={draft.wikiRefsText}
                              onChange={(e) => updateGateDraft(gate.id, "wikiRefsText", e.target.value)}
                              rows={8}
                              disabled={!canEditProtocol}
                              className="rounded-sm border border-zinc-300 px-3 py-2 text-13 font-normal normal-case leading-6 tracking-normal text-zinc-900"
                              placeholder="One reference per line"
                            />
                          </label>
                        </div>
                      </div>
                    );
                  })}
                  {!protocol.gates?.length && <div className="text-13 text-zinc-500">No gates are configured for this protocol.</div>}
                </div>
              </Section>
            </div>
          )}

          {activeTab === "calibration" && (
            <div className="grid gap-4">
              <Section
                title="Active Spray Calibrations"
                icon={Gauge}
                action={<Link to="/admin/equipment?tab=calibrations" className="text-12 font-medium uppercase tracking-label text-zinc-700 hover:text-zinc-900">Open Calibration</Link>}
              >
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {(data?.calibrations || []).map((row) => {
                    const expired = row.expires_at && new Date(row.expires_at) < new Date();
                    return (
                      <div key={row.id} className="rounded-sm border border-zinc-200 p-4">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-14 font-medium text-zinc-900">{row.system_name}</div>
                          <Pill tone={expired ? "bad" : "good"}>{expired ? "Expired" : "Active"}</Pill>
                        </div>
                        <div className="mt-3 grid gap-2 text-13 text-zinc-600">
                          <div className="flex justify-between"><span>Carrier</span><span className="font-medium text-zinc-900">{fmtNumber(row.carrier_gal_per_1000, " gal/1K")}</span></div>
                          <div className="flex justify-between"><span>Tank</span><span className="font-medium text-zinc-900">{fmtNumber(row.tank_capacity_gal, " gal")}</span></div>
                          <div className="flex justify-between"><span>Pressure</span><span className="font-medium text-zinc-900">{fmtNumber(row.pressure_psi, " psi")}</span></div>
                          <div className="flex justify-between"><span>Expires</span><span className="font-medium text-zinc-900">{fmtDate(row.expires_at)}</span></div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Section>

              <Section title="Assessment Fields Feeding This Protocol" icon={Beaker}>
                <div className="grid gap-2 md:grid-cols-3">
                  {(data?.health?.requiredProfileFields || []).map((field) => (
                    <div key={field} className="rounded-sm border border-zinc-200 bg-zinc-50 px-3 py-2 text-13 text-zinc-700">
                      {String(field).replace(/_/g, " ")}
                    </div>
                  ))}
                </div>
              </Section>
            </div>
          )}

          {activeTab === "bridges" && (
            <div className="grid gap-4 lg:grid-cols-3">
              <BridgeList title="Field Execution" items={data?.bridges?.fieldExecution} />
              <BridgeList title="Office Control" items={data?.bridges?.officeControl} />
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
              <Section title="Recent Protocol Completions" icon={Wrench}>
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
              <Section title="Protocol Change History" icon={Clock}>
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
    </div>
  );
}
