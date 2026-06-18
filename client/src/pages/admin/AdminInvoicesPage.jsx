// client/src/pages/admin/AdminInvoicesPage.jsx
//
// Admin Invoices page — list, search, create, edit, void, refund.
// Stats bar (draft / sent / viewed / paid / overdue), tap-to-pay launch
// for in-person collection, manual payment recording, follow-up
// sequence kickoff. Mobile + desktop.
//
// Endpoints:
//   GET   /admin/invoices?search=&status=&customerId=&from=&to=
//   GET   /admin/invoices/stats
//   POST  /admin/invoices/create
//   GET   /admin/invoices/:id
//   PUT   /admin/invoices/:id           (refund / void / mark paid)
//   POST  /admin/invoices/:id/send      (SMS + email pay link)
//   POST  /admin/invoices/:id/refund    (manual refund)
//   GET   /admin/customers/search       (autocomplete in create modal)
//   GET   /admin/service-records        (line-item picker)
//   POST  /api/stripe/terminal/start-payment-link  (Tap to Pay launch)
//
// Server orchestrators Codex should follow:
//   server/services/invoice.js              (create, list, update,
//                                             void, refund — pulls
//                                             discount-engine + tax-calc)
//   server/services/invoice-followups.js    (Day 3/5/7 SMS sequence,
//                                             stopOnPayment guard)
//   server/services/invoice-email.js        (template + send)
//   server/services/pdf/invoice-pdf.js      (PDF generation)
//   server/routes/admin-payments-reconcile.js  (Tap to Pay reconcile)
//   server/routes/admin-billing-health.js   (charge-now + manual refund)
//   server/services/discount-engine.js      (discount catalog + audit rows)
//   server/services/tax-calculator.js       (per-county sales tax)
//
// Audit focus:
// - Refund amount math: invoice.js → refund() pulls from
//   DiscountEngine. Confirm a refund REVERSES the credit-card
//   surcharge if the original payment was card (otherwise we eat the
//   surcharge). Verify it does NOT re-apply tax on a refund.
// - Void vs refund: void = unpaid invoice cancellation (no money
//   movement). Refund = paid invoice money-back. The UI wiring must
//   never swap them — voiding a paid invoice loses revenue silently;
//   refunding an unpaid one is a Stripe error.
// - Tap to Pay launch: deep-links into the WavesPay iOS app via
//   /api/stripe/terminal/start-payment-link. Confirm fallback when the
//   deep link doesn't resolve (Android, desktop, app not installed).
// - Send pay link single-flight: POST /:id/send fires SMS + email.
//   Double-click must not double-send (= duplicate SMS to customer
//   = TCPA risk + irritation).
// - Stats race: /stats counts and /list rows must agree at a moment
//   in time. If a paid status change happens between the two
//   requests, the stats bar can lie. Cache /stats with a short TTL
//   or compute client-side from /list.
// - Status filter composability: search + status + customerId +
//   date-range all hit the same endpoint. Pagination must reset on
//   filter change.
// - Follow-up sequence stopOnPayment: when an invoice gets marked
//   paid, the Day 3/5/7 SMS schedule must cancel. Verify the cron
//   checks payment status at FIRE time, not just at enqueue time —
//   a customer who pays manually shouldn't get a "you owe us" SMS
//   the next morning.
// - alert-fg discipline: spec reserves red for overdue / failed /
//   refund-error. Watch for decorative misuse.
import { useState, useEffect, useCallback, useRef } from "react";
import {
  ExternalLink,
  FileText,
  ListChecks,
  Paperclip,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { launchTapToPay } from "../../lib/tapToPay";
import { useFeatureFlag } from "../../hooks/useFeatureFlag";
import { computeCardTotal } from "../../lib/cardSurcharge";
import { invoiceDateOnly } from "../../lib/invoiceDates";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: teal/blue/purple fold to zinc-900. Semantic green/amber/red preserved.
// STATUS_COLORS folds cleanly — sent/viewed were both #0A7EC2 in V1, stay identical post-fold.
const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "#E4E4E7",
  teal: "#18181B",
  green: "#15803D",
  amber: "#A16207",
  red: "#991B1B",
  purple: "#18181B",
  blue: "#18181B",
  text: "#000000",
  muted: "#000000",
  white: "#FFFFFF",
  input: "#FFFFFF",
  heading: "#000000",
  inputBorder: "#D4D4D8",
};

async function adminFetch(path, options = {}) {
  const r = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  });
  if (!r.ok) {
    let message = `HTTP ${r.status}`;
    try {
      const data = await r.clone().json();
      message = data.error || data.message || message;
    } catch {
      const text = await r.text().catch(() => "");
      if (text) message = text;
    }
    const err = new Error(message);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function adminUpload(path, formData) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
    },
    body: formData,
  });
  if (!r.ok) {
    let message = `HTTP ${r.status}`;
    try {
      const data = await r.clone().json();
      message = data.error || data.message || message;
    } catch {
      const text = await r.text().catch(() => "");
      if (text) message = text;
    }
    const err = new Error(message);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

const sCard = {
  background: D.card,
  border: `1px solid ${D.border}`,
  borderRadius: 12,
  padding: 20,
  marginBottom: 12,
  boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
};
const sBtn = (bg, color, isMobile) => ({
  padding: isMobile ? "12px 18px" : "8px 16px",
  background: bg,
  color,
  border: "none",
  borderRadius: 8,
  fontSize: isMobile ? 14 : 13,
  fontWeight: 600,
  cursor: "pointer",
  minHeight: isMobile ? 44 : undefined,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
});
const sBadge = (bg, color) => ({
  fontSize: 10,
  padding: "2px 8px",
  borderRadius: 4,
  background: bg,
  color,
  fontWeight: 600,
  display: "inline-block",
});

function annualPrepayInvoiceLabel(inv = {}) {
  const status = String(inv.annual_prepay_status || "").toLowerCase();
  if (!status) return null;
  if (status === "payment_pending") return "Annual prepay pending";
  if (status === "active") return "Annual prepay active";
  if (status === "renewal_pending") return "Annual prepay renewal";
  if (status === "cancelled" || status === "canceled") return "Annual prepay cancelled";
  if (status === "refunded") return "Annual prepay refunded";
  return `Annual prepay ${status.replace(/_/g, " ")}`;
}

const sInput = (isMobile) => ({
  width: "100%",
  padding: isMobile ? "12px 14px" : "10px 12px",
  background: D.input,
  border: `1px solid ${D.border}`,
  borderRadius: 8,
  color: D.text,
  fontSize: isMobile ? 16 : 13,
  fontFamily: "'Roboto', Arial, sans-serif",
  outline: "none",
  boxSizing: "border-box",
  minHeight: isMobile ? 44 : undefined,
});

const ATTACHMENT_MAX_COUNT = 10;
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const ATTACHMENT_MAX_MB = ATTACHMENT_MAX_BYTES / 1024 / 1024;
const ATTACHMENT_ACCEPT = ".jpg,.jpeg,.png,.gif,.tif,.tiff,.bmp,.pdf";
const ATTACHMENT_ALLOWED_TYPE_LABEL = "JPG, PNG, GIF, TIFF, BMP, and PDF";
export const ATTACHMENT_HELP_TEXT = `Attach up to ${ATTACHMENT_MAX_COUNT} files totaling ${ATTACHMENT_MAX_MB} MB. Supported file types: ${ATTACHMENT_ALLOWED_TYPE_LABEL}.`;
export const ATTACHMENT_VISIBILITY_TEXT = "Customers can view these files from the invoice/payment link. They are not sent as separate email attachments.";
const ATTACHMENT_ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/tiff",
  "image/bmp",
  "image/x-ms-bmp",
  "application/pdf",
]);
const ATTACHMENT_ALLOWED_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "tif",
  "tiff",
  "bmp",
  "pdf",
]);

function fileExtension(name = "") {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

export function isAllowedAttachmentFile(file) {
  return (
    ATTACHMENT_ALLOWED_TYPES.has(String(file.type || "").toLowerCase()) ||
    ATTACHMENT_ALLOWED_EXTENSIONS.has(fileExtension(file.name))
  );
}

function formatFileSize(bytes = 0) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

export function attachmentTotalBytes(files = []) {
  return files.reduce((sum, file) => sum + Number(file.size || file.file_size_bytes || file.fileSizeBytes || 0), 0);
}

export function canAddInvoiceAttachments(files = []) {
  return files.length < ATTACHMENT_MAX_COUNT && attachmentTotalBytes(files) < ATTACHMENT_MAX_BYTES;
}

export function invoiceAttachmentLimitLabel(files = []) {
  return `${files.length}/${ATTACHMENT_MAX_COUNT} files · ${formatFileSize(attachmentTotalBytes(files))}/${ATTACHMENT_MAX_MB} MB`;
}

export function validateAttachmentFiles(existingFiles, incomingFiles) {
  const next = [...existingFiles, ...incomingFiles];
  if (next.length > ATTACHMENT_MAX_COUNT) {
    return `Attach up to ${ATTACHMENT_MAX_COUNT} files`;
  }
  if (attachmentTotalBytes(next) > ATTACHMENT_MAX_BYTES) {
    return "Attachments can total up to 25 MB";
  }
  const unsupported = incomingFiles.find((file) => !isAllowedAttachmentFile(file));
  if (unsupported) {
    return `Supported file types: ${ATTACHMENT_ALLOWED_TYPE_LABEL}`;
  }
  return null;
}

async function uploadInvoiceAttachments(invoiceId, files) {
  if (!files.length) return [];
  const fd = new FormData();
  files.forEach((file) => fd.append("attachments", file));
  const result = await adminUpload(`/admin/invoices/${invoiceId}/attachments`, fd);
  return result.attachments || [];
}

const STATUS_COLORS = {
  draft: D.muted,
  scheduled: D.amber,
  sending: D.amber,
  sent: D.blue,
  viewed: D.teal,
  paid: D.green,
  prepaid: D.green,
  overdue: D.red,
  void: D.muted,
};

function formatDateParam(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function datePeriodStart(period) {
  const current = new Date();
  const today = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate(),
  );
  if (period === "today") return today;
  if (period === "7d") return new Date(today.getTime() - 7 * 86400000);
  if (period === "30d") return new Date(today.getTime() - 30 * 86400000);
  if (period === "month")
    return new Date(current.getFullYear(), current.getMonth(), 1);
  return null;
}

function dateOnlyAtNoon(dateOnly) {
  return new Date(`${dateOnly}T12:00:00`);
}

function parseInvoiceCreatedAt(value) {
  if (!value) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return dateOnlyAtNoon(value);
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function invoiceListRowDate(inv = {}) {
  const serviceDate = invoiceDateOnly(inv.service_date);
  if (serviceDate) return dateOnlyAtNoon(serviceDate);
  return parseInvoiceCreatedAt(inv.created_at);
}

export default function AdminInvoicesPage() {
  const [tab, setTab] = useState("list");
  const [stats, setStats] = useState(null);
  const [toast, setToast] = useState("");
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  const loadStats = useCallback(async () => {
    const s = await adminFetch("/admin/invoices/stats").catch(() => null);
    setStats(s);
  }, []);
  useEffect(() => {
    loadStats();
  }, [loadStats]);
  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  };

  return (
    <div
      style={{
        maxWidth: 1300,
        margin: "0 auto",
        padding: isMobile ? "0 0 24px" : "0",
        fontFamily: "'Roboto', Arial, sans-serif",
        color: D.text,
      }}
    >
      {" "}
      <AdminCommandHeader
        title="Invoices"
        icon={FileText}
        action={{
          label: tab === "create" ? "Invoice List" : "Create Invoice",
          icon: tab === "create" ? ListChecks : Plus,
          variant: tab === "create" ? "secondary" : "primary",
          onClick: () => setTab(tab === "create" ? "list" : "create"),
        }}
      />
      {tab === "list" && (
        <InvoiceList
          showToast={showToast}
          onRefresh={loadStats}
          isMobile={isMobile}
          stats={stats}
        />
      )}
      {tab === "create" && (
        <CreateInvoice
          showToast={showToast}
          onCreated={() => {
            loadStats();
            setTab("list");
          }}
          isMobile={isMobile}
        />
      )}
      <div
        style={{
          position: "fixed",
          bottom: isMobile
            ? "calc(72px + env(safe-area-inset-bottom, 0px))"
            : 20,
          right: 20,
          background: D.card,
          border: `1px solid ${D.green}`,
          borderRadius: 8,
          padding: "10px 16px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          boxShadow: "0 8px 32px rgba(0,0,0,.4)",
          zIndex: 300,
          fontSize: 12,
          transform: toast ? "translateY(0)" : "translateY(80px)",
          opacity: toast ? 1 : 0,
          transition: "all .3s",
          pointerEvents: "none",
        }}
      >
        {" "}
        <span style={{ color: D.green }}>OK</span>
        <span style={{ color: D.text }}>{toast}</span>{" "}
      </div>{" "}
    </div>
  );
}

// ── Filter pill with dropdown ──
function FilterPill({ label, value, options, onChange, isMobile }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const current = options.find((o) => o.key === value) || options[0];
  return (
    <div ref={ref} style={{ position: "relative" }}>
      {" "}
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          padding: "10px 16px",
          borderRadius: 999,
          border: `1px solid ${D.border}`,
          background: D.card,
          color: D.text,
          fontSize: 14,
          fontWeight: 400,
          cursor: "pointer",
          minHeight: 40,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {" "}
        <span style={{ color: D.muted }}>{label}</span>{" "}
        <span style={{ fontWeight: 700, color: D.heading }}>
          {current.label}
        </span>{" "}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 20,
            background: D.card,
            border: `1px solid ${D.border}`,
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.08)",
            minWidth: 180,
            overflow: "hidden",
          }}
        >
          {options.map((o) => (
            <button
              key={o.key}
              onClick={() => {
                onChange(o.key);
                setOpen(false);
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: isMobile ? "12px 14px" : "10px 14px",
                border: "none",
                background: o.key === value ? "#F4F4F5" : D.card,
                color: D.heading,
                fontSize: 14,
                cursor: "pointer",
                fontWeight: o.key === value ? 600 : 400,
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Invoice List (mirrors attached UI) ──
function InvoiceList({ showToast, onRefresh, isMobile, stats }) {
  const PAGE_SIZE = 100;
  const [invoices, setInvoices] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState("all");
  const [datePeriod, setDatePeriod] = useState("all");
  const [sort, setSort] = useState("newest");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [batchSending, setBatchSending] = useState(false);
  const [sendModalInvoice, setSendModalInvoice] = useState(null);
  const [receiptModalInvoice, setReceiptModalInvoice] = useState(null);
  const [paymentModalInvoice, setPaymentModalInvoice] = useState(null);
  const [paymentPlanModalInvoice, setPaymentPlanModalInvoice] = useState(null);
  const [annualPrepayModalInvoice, setAnnualPrepayModalInvoice] = useState(null);
  const [applyCreditInvoice, setApplyCreditInvoice] = useState(null);
  const sendReceiptEnabled = useFeatureFlag("ff_invoice_send_receipt", true);

  const load = useCallback(
    async ({ append = false, pageNo = 1 } = {}) => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        page: String(pageNo),
        sort,
      });
      if (filter === "archived") params.set("archived", "only");
      else if (filter !== "all") params.set("status", filter);

      const term = query.trim();
      if (term) params.set("search", term);

      const start = datePeriodStart(datePeriod);
      if (start) params.set("from", formatDateParam(start));

      const data = await adminFetch(`/admin/invoices?${params}`).catch(
        () => null,
      );
      if (!data) {
        if (!append) {
          setInvoices([]);
          setTotal(0);
          setSelected(new Set());
        }
        return;
      }
      const rows = data.invoices || [];
      setInvoices((prev) => (append ? [...prev, ...rows] : rows));
      setTotal(Number(data.total ?? rows.length) || 0);
      setPage(Number(data.page || pageNo));
      if (!append) {
        setSelected(new Set());
      }
    },
    [PAGE_SIZE, datePeriod, filter, query, sort],
  );
  useEffect(() => {
    load();
  }, [load]);

  const handleSend = (invoice) => {
    setSendModalInvoice(invoice);
  };

  const handleVoid = async (id) => {
    if (!confirm("Void this invoice?")) return;
    await adminFetch(`/admin/invoices/${id}/void`, { method: "POST" });
    showToast("Invoice voided");
    load();
    onRefresh();
  };

  const handleReversePrepaid = async (id) => {
    if (
      !confirm(
        "Reverse this prepaid invoice? The applied account credit is returned to the customer and the invoice reopens for collection.",
      )
    )
      return;
    try {
      const res = await adminFetch(`/admin/invoices/${id}/reverse-prepaid`, {
        method: "POST",
      });
      showToast(
        `Prepaid reversed · $${Number(res.restored).toFixed(2)} credit restored`,
      );
      load();
      onRefresh();
    } catch (err) {
      showToast(`Reverse failed: ${err.message}`);
    }
  };

  const handleArchive = async (id) => {
    if (
      !confirm(
        "Archive this voided invoice? It stays accessible under the Archived filter.",
      )
    )
      return;
    const res = await adminFetch(`/admin/invoices/${id}/archive`, {
      method: "POST",
    });
    if (res?.error) {
      showToast(res.error);
      return;
    }
    showToast("Invoice archived");
    load();
    onRefresh();
  };

  const handleUnarchive = async (id) => {
    await adminFetch(`/admin/invoices/${id}/unarchive`, { method: "POST" });
    showToast("Invoice restored");
    load();
    onRefresh();
  };

  const toggleSelect = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  // Under the Needs-receipt filter the selection target flips from
  // "invoices we can send" to "paid invoices that still owe a receipt".
  const receiptMode = filter === "needs_receipt";
  const BATCH_RECEIPT_MAX = 25;
  const invoiceSendableStatuses = new Set([
    "draft",
    "scheduled",
    "sent",
    "viewed",
    "overdue",
  ]);
  const invoiceNonCollectibleStatuses = new Set([
    "paid",
    "prepaid",
    "void",
    "processing",
    "refunded",
    "canceled",
    "cancelled",
  ]);
  const sendableInvoices = receiptMode
    ? invoices.filter((i) => i.status === "paid" && !i.receipt_sent_at)
    : invoices.filter((i) => invoiceSendableStatuses.has(i.status));
  const selectAllSendable = () =>
    setSelected(
      new Set(
        sendableInvoices
          .slice(0, receiptMode ? BATCH_RECEIPT_MAX : sendableInvoices.length)
          .map((i) => i.id),
      ),
    );
  const clearSelection = () => setSelected(new Set());
  const handleBatchSend = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (receiptMode) {
      if (ids.length > BATCH_RECEIPT_MAX) {
        showToast(`Pick at most ${BATCH_RECEIPT_MAX} receipts per batch`);
        return;
      }
      if (
        !confirm(
          `Send ${ids.length} receipt${ids.length === 1 ? "" : "s"} via SMS + email?`,
        )
      )
        return;
    } else if (
      !confirm(
        `Send ${ids.length} invoice${ids.length === 1 ? "" : "s"} via SMS + email?`,
      )
    )
      return;
    setBatchSending(true);
    try {
      const endpoint = receiptMode
        ? "/admin/invoices/batch/send-receipts"
        : "/admin/invoices/batch/send";
      const result = await adminFetch(endpoint, {
        method: "POST",
        body: JSON.stringify({ invoiceIds: ids }),
      });
      const noun = receiptMode ? "receipt" : "invoice";
      showToast(
        `Sent ${result.sent_count} of ${result.total} ${noun}${result.total === 1 ? "" : "s"}${result.failed_count ? ` (${result.failed_count} failed)` : ""}`,
      );
      clearSelection();
      load();
      onRefresh();
    } catch (err) {
      showToast(`Batch send failed: ${err.message}`);
    } finally {
      setBatchSending(false);
    }
  };

  const domain = typeof window !== "undefined" ? window.location.origin : "";

  // Derive display status: overdue when unpaid + past due
  const getDisplayStatus = (inv) => {
    if (inv.status === "paid")
      return { key: "paid", label: "Paid", color: D.green };
    if (inv.status === "prepaid")
      return { key: "prepaid", label: "Prepaid", color: D.green };
    if (inv.status === "void")
      return { key: "void", label: "Void", color: D.muted };
    if (inv.status === "processing")
      return { key: "processing", label: "Processing", color: D.amber };
    if (inv.status === "refunded")
      return { key: "refunded", label: "Refunded", color: D.muted };
    if (inv.status === "canceled" || inv.status === "cancelled")
      return { key: "canceled", label: "Canceled", color: D.muted };
    if (inv.status === "scheduled") {
      // The send cron stops retrying after 5 attempts — without this the
      // invoice would sit as "Scheduled" forever with no visible signal.
      if (
        inv.scheduled_send_error &&
        Number(inv.scheduled_send_attempts) >= 5
      )
        return { key: "send_failed", label: "Send failed", color: D.red };
      return { key: "scheduled", label: "Scheduled", color: D.amber };
    }
    if (inv.status === "sending")
      return { key: "sending", label: "Sending", color: D.amber };
    if (inv.status === "draft")
      return { key: "draft", label: "Draft", color: D.muted };
    if (inv.due_date) {
      const due = new Date(inv.due_date + "T23:59:59");
      if (Date.now() > due.getTime())
        return { key: "overdue", label: "Overdue", color: D.red };
    }
    if (inv.status === "overdue")
      return { key: "overdue", label: "Overdue", color: D.red };
    if (inv.status === "viewed")
      return { key: "viewed", label: "Viewed", color: D.text };
    return { key: "sent", label: "Sent", color: D.text };
  };

  const rows = invoices;

  // Group by day — date header matches "Saturday, April 18, 2026"
  const groups = [];
  const groupMap = new Map();
  for (const inv of rows) {
    const d = invoiceListRowDate(inv);
    const key = d
      ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
      : "unknown";
    if (!groupMap.has(key)) {
      const label = d
        ? d.toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
          })
        : "Unknown date";
      const g = { key, label, items: [] };
      groupMap.set(key, g);
      groups.push(g);
    }
    groupMap.get(key).items.push(inv);
  }

  const rowPad = isMobile ? "18px 16px" : "16px 18px";

  return (
    <div>
      {/* Search */}
      <div style={{ padding: isMobile ? "4px 16px 12px" : "4px 0 12px" }}>
        {" "}
        <div style={{ position: "relative" }}>
          {" "}
          <span
            style={{
              position: "absolute",
              left: 18,
              top: "50%",
              transform: "translateY(-50%)",
              color: D.muted,
              fontSize: 16,
              pointerEvents: "none",
            }}
          >
            ⌕
          </span>{" "}
          <input
            id="admin-invoice-search"
            name="admin_invoice_search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            style={{
              width: "100%",
              padding: "14px 18px 14px 44px",
              background: D.card,
              border: `1px solid ${D.border}`,
              borderRadius: 999,
              fontSize: 16,
              color: D.text,
              outline: "none",
              boxSizing: "border-box",
              minHeight: 48,
            }}
          />{" "}
        </div>{" "}
      </div>
      {/* Filter pills */}
      <div
        style={{
          display: "flex",
          gap: 10,
          padding: isMobile ? "4px 16px 16px" : "4px 0 16px",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {" "}
        <FilterPill
          label="Filter"
          value={filter}
          onChange={setFilter}
          isMobile={isMobile}
          options={[
            { key: "all", label: "All" },
            { key: "overdue", label: "Overdue" },
            { key: "unpaid", label: "Unpaid" },
            { key: "paid", label: "Paid" },
            { key: "prepaid", label: "Prepaid" },
            { key: "needs_receipt", label: "Needs receipt" },
            { key: "draft", label: "Draft" },
            { key: "archived", label: "Archived" },
          ]}
        />{" "}
        <FilterPill
          label="Date"
          value={datePeriod}
          onChange={setDatePeriod}
          isMobile={isMobile}
          options={[
            { key: "all", label: "All" },
            { key: "today", label: "Today" },
            { key: "7d", label: "Last 7 days" },
            { key: "30d", label: "Last 30 days" },
            { key: "month", label: "This month" },
          ]}
        />{" "}
        <FilterPill
          label="Sort"
          value={sort}
          onChange={setSort}
          isMobile={isMobile}
          options={[
            { key: "newest", label: "Newest" },
            { key: "oldest", label: "Oldest" },
            { key: "amount_high", label: "Amount ↓" },
            { key: "amount_low", label: "Amount ↑" },
          ]}
        />
        {sendableInvoices.length > 0 && (
          <button
            onClick={selectAllSendable}
            style={{
              padding: "10px 16px",
              borderRadius: 999,
              border: `1px solid ${D.border}`,
              background: D.card,
              color: D.muted,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {receiptMode
              ? `Select ${Math.min(sendableInvoices.length, BATCH_RECEIPT_MAX)} to receipt`
              : `Select sendable (${sendableInvoices.length})`}
          </button>
        )}
        {stats && !isMobile && (
          <span style={{ marginLeft: "auto", fontSize: 12, color: D.muted }}>
            {stats.paid} paid · {stats.outstanding} outstanding ·{" "}
            {stats.overdue} overdue
          </span>
        )}
      </div>
      {/* List */}
      {rows.length === 0 ? (
        <div
          style={{
            padding: 48,
            textAlign: "center",
            color: D.muted,
            fontSize: 15,
          }}
        >
          No invoices match
        </div>
      ) : (
        <div
          style={{
            background: D.card,
            borderTop: `1px solid ${D.border}`,
            borderBottom: `1px solid ${D.border}`,
          }}
        >
          {groups.map((g) => (
            <div key={g.key}>
              {" "}
              <div
                style={{
                  padding: isMobile ? "16px 16px 10px" : "16px 18px 10px",
                  fontSize: 15,
                  fontWeight: 700,
                  color: D.heading,
                  borderBottom: `1px solid ${D.border}`,
                }}
              >
                {g.label}
              </div>
              {g.items.map((inv) => {
                const lineItems =
                  typeof inv.line_items === "string"
                    ? JSON.parse(inv.line_items)
                    : inv.line_items || [];
                const canSelect = receiptMode
                  ? inv.status === "paid" && !inv.receipt_sent_at
                  : invoiceSendableStatuses.has(inv.status);
                const isSelected = selected.has(inv.id);
                const display = getDisplayStatus(inv);
                const isOpen = expanded === inv.id;
                const cardOnFile =
                  inv.card_on_file && inv.card_on_file.last_four
                    ? inv.card_on_file
                    : null;
                const canCollect = !invoiceNonCollectibleStatuses.has(
                  inv.status,
                );
                return (
                  <div
                    key={inv.id}
                    style={{ borderBottom: `1px solid ${D.border}` }}
                  >
                    {" "}
                    <button
                      onClick={() => setExpanded(isOpen ? null : inv.id)}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        border: "none",
                        background: isSelected ? "#FAFAFA" : D.card,
                        padding: rowPad,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                      }}
                    >
                      {canSelect && (
                        <input
                          id={`invoice-row-select-${inv.id}`}
                          name="invoice_row_select"
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(inv.id)}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            width: 18,
                            height: 18,
                            cursor: "pointer",
                            accentColor: D.heading,
                          }}
                        />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {" "}
                        <div
                          style={{
                            fontSize: 17,
                            fontWeight: 700,
                            color: D.heading,
                            lineHeight: 1.25,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {inv.first_name} {inv.last_name}
                        </div>{" "}
                        <div
                          style={{ fontSize: 14, color: D.muted, marginTop: 4 }}
                        >
                          #{inv.invoice_number}
                        </div>{" "}
                      </div>{" "}
                      <div style={{ textAlign: "right" }}>
                        {" "}
                        <div
                          style={{
                            fontSize: 17,
                            fontWeight: 700,
                            color: D.heading,
                            fontFamily: "'Roboto', Arial, sans-serif",
                          }}
                        >
                          ${parseFloat(inv.total).toFixed(2)}
                        </div>{" "}
                        <div
                          style={{
                            fontSize: 14,
                            fontWeight: 600,
                            color: display.color,
                            marginTop: 4,
                          }}
                        >
                          {display.label}
                        </div>{" "}
                      </div>{" "}
                      <span
                        aria-hidden
                        style={{
                          color: D.muted,
                          fontSize: 18,
                          marginLeft: 4,
                          transform: isOpen ? "rotate(90deg)" : "none",
                          transition: "transform .15s",
                        }}
                      >
                        ›
                      </span>{" "}
                    </button>
                    {isOpen && (
                      <div
                        style={{
                          padding: isMobile ? "0 16px 18px" : "0 18px 18px",
                          background: "#FAFAFA",
                          borderTop: `1px solid ${D.border}`,
                        }}
                      >
                        {" "}
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 12,
                            padding: "14px 0",
                            fontSize: 13,
                            color: D.muted,
                          }}
                        >
                          {" "}
                          <span>
                            {inv.title ||
                              lineItems[0]?.description ||
                              "Service"}
                          </span>
                          {inv.waveguard_tier && (
                            <span style={sBadge(`${D.amber}22`, D.amber)}>
                              {inv.waveguard_tier}
                            </span>
                          )}
                          {annualPrepayInvoiceLabel(inv) && (
                            <span style={sBadge(
                              inv.annual_prepay_status === "active" ? `${D.green}22` : `${D.amber}22`,
                              inv.annual_prepay_status === "active" ? D.green : D.amber,
                            )}>
                              {annualPrepayInvoiceLabel(inv)}
                              {inv.annual_prepay_term_end ? ` · through ${inv.annual_prepay_term_end}` : ""}
                            </span>
                          )}
                          {cardOnFile && canCollect && (
                            <span>
                              Card {cardOnFile.brand || "Card"} •
                              {cardOnFile.last_four} on file
                            </span>
                          )}
                          {inv.active_payment_plan && (
                            <span style={sBadge("#E0F2FE", "#075985")}>
                              Plan $
                              {Number(
                                inv.active_payment_plan.payment_amount || 0,
                              ).toFixed(2)}{" "}
                              {inv.active_payment_plan.payment_frequency}
                            </span>
                          )}
                        </div>{" "}
                        <InvoiceTimeline invoice={inv} />{" "}
                        {/* Mounted only for the expanded row so attachment fetches stay lazy. */}
                        <InvoiceAttachmentsPanel
                          invoiceId={inv.id}
                          showToast={showToast}
                          isMobile={isMobile}
                        />
                        <div
                          style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
                        >
                          {(inv.status === "draft" ||
                            inv.status === "scheduled") && (
                            <button
                              onClick={() => handleSend(inv)}
                              style={sBtn(D.heading, D.white, isMobile)}
                              title="Send invoice via SMS + email"
                            >
                              Send
                            </button>
                          )}
                          {(inv.status === "sent" ||
                            inv.status === "viewed" ||
                            inv.status === "overdue") && (
                            <button
                              onClick={() => handleSend(inv)}
                              style={sBtn(D.heading, D.white, isMobile)}
                              title="Resend invoice via SMS + email"
                            >
                              Resend
                            </button>
                          )}
                          {canCollect && (
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(
                                  `${domain}/pay/${inv.token}`,
                                );
                                showToast("Pay link copied");
                              }}
                              style={sBtn(D.card, D.text, isMobile)}
                            >
                              Copy Link
                            </button>
                          )}
                          {canCollect && (
                            <button
                              onClick={async () => {
                                try {
                                  await launchTapToPay(inv.id);
                                } catch (e) {
                                  showToast(`Tap to Pay failed: ${e.message}`);
                                }
                              }}
                              style={sBtn(D.heading, D.white, isMobile)}
                              title="Open Waves Tech app to tap customer's card/phone"
                            >
                              Charge in person
                            </button>
                          )}
                          {canCollect && (
                            <button
                              onClick={() => setPaymentModalInvoice(inv)}
                              style={sBtn(D.heading, D.white, isMobile)}
                              title="Record cash, check, or Zelle payment and close the invoice"
                            >
                              Add payment
                            </button>
                          )}
                          {canCollect && (
                            <button
                              onClick={() => setApplyCreditInvoice(inv)}
                              style={sBtn(D.card, D.text, isMobile)}
                              title="Apply the customer's account credit — covers the invoice and marks it prepaid"
                            >
                              Apply credit
                            </button>
                          )}
                          {canCollect && !inv.active_payment_plan && (
                            <button
                              onClick={() => setPaymentPlanModalInvoice(inv)}
                              style={sBtn(D.card, D.text, isMobile)}
                              title="Create a payment plan and send the confirmation email"
                            >
                              Payment plan
                            </button>
                          )}
                          {inv.status !== "void" && (
                            <button
                              onClick={() => setAnnualPrepayModalInvoice(inv)}
                              style={sBtn(
                                inv.annual_prepay_term_id ? D.heading : D.card,
                                inv.annual_prepay_term_id ? D.white : D.text,
                                isMobile,
                              )}
                              title="Flag this invoice as a full-year prepayment — adds the coverage banner to the customer's invoice"
                            >
                              {inv.annual_prepay_term_id
                                ? "Annual prepay ✓"
                                : "Annual prepay"}
                            </button>
                          )}
                          {inv.status !== "void" && inv.token && (
                            <a
                              href={
                                inv.status === "paid"
                                  ? `${API_BASE}/receipt/${inv.token}/pdf`
                                  : `${API_BASE}/pay/${inv.token}/invoice.pdf`
                              }
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                ...sBtn(D.card, D.text, isMobile),
                                textDecoration: "none",
                                display: "inline-flex",
                                alignItems: "center",
                              }}
                              title={
                                inv.status === "paid"
                                  ? "Download the receipt PDF"
                                  : "Download the invoice PDF"
                              }
                            >
                              Download PDF
                            </a>
                          )}
                          {canCollect && (
                            <button
                              onClick={() => handleVoid(inv.id)}
                              style={sBtn("transparent", D.red, isMobile)}
                            >
                              Void
                            </button>
                          )}
                          {inv.status === "prepaid" && (
                            <button
                              onClick={() => handleReversePrepaid(inv.id)}
                              style={sBtn("transparent", D.red, isMobile)}
                              title="Return the applied account credit to the customer and reopen this invoice"
                            >
                              Reverse prepaid
                            </button>
                          )}
                          {inv.status === "void" && !inv.archived_at && (
                            <button
                              onClick={() => handleArchive(inv.id)}
                              style={sBtn(D.heading, D.white, isMobile)}
                              title="Tuck this voided invoice out of the default list"
                            >
                              Archive
                            </button>
                          )}
                          {inv.archived_at && (
                            <button
                              onClick={() => handleUnarchive(inv.id)}
                              style={sBtn("transparent", D.text, isMobile)}
                              title="Restore to the default list"
                            >
                              Unarchive
                            </button>
                          )}
                          {sendReceiptEnabled && inv.status === "paid" && (
                            <button
                              onClick={() => setReceiptModalInvoice(inv)}
                              style={sBtn(
                                inv.receipt_sent_at ? D.card : D.heading,
                                inv.receipt_sent_at ? D.text : D.white,
                                isMobile,
                              )}
                              title={
                                inv.receipt_sent_at
                                  ? "Resend receipt + log another touch"
                                  : "Email + SMS the receipt and close the service"
                              }
                            >
                              {inv.receipt_sent_at
                                ? "Resend receipt"
                                : "Send receipt"}
                            </button>
                          )}
                        </div>
                        {canCollect && inv.status !== "draft" && (
                          <FollowupPanel
                            invoiceId={inv.id}
                            showToast={showToast}
                            isMobile={isMobile}
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {invoices.length < total && (
        <div
          style={{
            padding: isMobile ? "18px 16px" : "18px 0",
            textAlign: "center",
          }}
        >
          {" "}
          <button
            onClick={async () => {
              setLoadingMore(true);
              try {
                await load({ append: true, pageNo: page + 1 });
              } finally {
                setLoadingMore(false);
              }
            }}
            disabled={loadingMore}
            style={{
              ...sBtn(D.card, D.text, isMobile),
              border: `1px solid ${D.border}`,
              opacity: loadingMore ? 0.6 : 1,
            }}
          >
            {loadingMore
              ? "Loading..."
              : `Load more (${invoices.length} of ${total})`}
          </button>{" "}
        </div>
      )}

      {selected.size > 0 && (
        <div
          style={{
            position: "fixed",
            bottom: isMobile
              ? "calc(72px + env(safe-area-inset-bottom, 0px))"
              : 20,
            left: "50%",
            transform: "translateX(-50%)",
            background: D.heading,
            color: D.white,
            borderRadius: 10,
            padding: "12px 20px",
            display: "flex",
            alignItems: "center",
            gap: 14,
            boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
            zIndex: 50,
          }}
        >
          {" "}
          <span style={{ fontWeight: 600, fontSize: 14 }}>
            {selected.size} selected
          </span>{" "}
          <button
            onClick={handleBatchSend}
            disabled={batchSending}
            style={{
              ...sBtn(D.white, D.heading, isMobile),
              opacity: batchSending ? 0.6 : 1,
            }}
          >
            {batchSending
              ? "Sending…"
              : receiptMode
                ? `Send ${selected.size} receipt${selected.size === 1 ? "" : "s"}`
                : `Send ${selected.size}`}
          </button>{" "}
          <button
            onClick={clearSelection}
            style={sBtn("transparent", D.white, isMobile)}
          >
            Clear
          </button>{" "}
        </div>
      )}

      {sendModalInvoice && (
        <SendInvoiceModal
          invoice={sendModalInvoice}
          isMobile={isMobile}
          onClose={() => setSendModalInvoice(null)}
          onSent={(res) => {
            setSendModalInvoice(null);
            const channels = [
              res?.sms?.ok && "SMS",
              res?.email?.ok && (
                res.email.recipient?.email
                  ? `email to ${res.email.recipient.email}`
                  : "email"
              ),
            ].filter(Boolean);
            showToast(
              channels.length
                ? `Invoice sent (${channels.join(" + ")})`
                : "Invoice send failed",
            );
            load();
            onRefresh();
          }}
          onError={(msg) => showToast(msg)}
        />
      )}

      {receiptModalInvoice && (
        <SendReceiptModal
          invoice={receiptModalInvoice}
          isMobile={isMobile}
          onClose={() => setReceiptModalInvoice(null)}
          onSent={() => {
            setReceiptModalInvoice(null);
            showToast("Receipt sent");
            load();
            onRefresh();
          }}
          onError={(msg) => showToast(msg)}
        />
      )}

      {paymentModalInvoice && (
        <RecordPaymentModal
          invoice={paymentModalInvoice}
          isMobile={isMobile}
          onClose={() => setPaymentModalInvoice(null)}
          onRecorded={(msg) => {
            setPaymentModalInvoice(null);
            showToast(msg);
            load();
            onRefresh();
          }}
          onError={(msg) => showToast(msg)}
        />
      )}

      {paymentPlanModalInvoice && (
        <PaymentPlanModal
          invoice={paymentPlanModalInvoice}
          isMobile={isMobile}
          onClose={() => setPaymentPlanModalInvoice(null)}
          onCreated={() => {
            setPaymentPlanModalInvoice(null);
            showToast("Payment plan created");
            load();
            onRefresh();
          }}
          onError={(msg) => showToast(msg)}
        />
      )}

      {annualPrepayModalInvoice && (
        <AnnualPrepayModal
          invoice={annualPrepayModalInvoice}
          isMobile={isMobile}
          onClose={() => setAnnualPrepayModalInvoice(null)}
          onSaved={(msg) => {
            setAnnualPrepayModalInvoice(null);
            showToast(msg);
            load();
            onRefresh();
          }}
          onError={(msg) => showToast(msg)}
        />
      )}

      {applyCreditInvoice && (
        <ApplyCreditModal
          invoice={applyCreditInvoice}
          isMobile={isMobile}
          onClose={() => setApplyCreditInvoice(null)}
          onApplied={(msg) => {
            setApplyCreditInvoice(null);
            showToast(msg);
            load();
            onRefresh();
          }}
          onError={(msg) => showToast(msg)}
        />
      )}
    </div>
  );
}

// ── Invoice activity timeline ──
// Reconstructed entirely from invoice row columns — no dedicated events table.
// Newest event on top so the current state is the first thing you read.
function buildInvoiceTimeline(inv) {
  const events = [];
  if (inv.status === "scheduled" && inv.scheduled_send_at) {
    const attempts = Number(inv.scheduled_send_attempts) || 0;
    const exhausted = attempts >= 5 && inv.scheduled_send_error;
    events.push({
      kind: "scheduled",
      at: inv.scheduled_send_at,
      label: exhausted
        ? "Scheduled send failed — out of retries"
        : attempts > 0
          ? `Scheduled to send (${attempts} failed attempt${attempts === 1 ? "" : "s"})`
          : "Scheduled to send",
      detail: inv.scheduled_send_error || null,
      color: exhausted ? D.red : D.amber,
      emphasis: Boolean(exhausted),
    });
  }
  if (inv.sent_at || inv.sms_sent_at) {
    events.push({
      kind: "sent",
      at: inv.sent_at || inv.sms_sent_at,
      label: "Invoice sent",
      detail: "SMS + email",
      color: D.text,
    });
  }
  if (inv.viewed_at) {
    const count = Number(inv.view_count) || 0;
    events.push({
      kind: "viewed",
      at: inv.viewed_at,
      label: "Customer opened the invoice",
      detail: count > 1 ? `${count} total views` : null,
      color: D.text,
    });
  }
  const reminderCount = Number(inv.sms_reminder_count) || 0;
  if (inv.last_reminder_at && reminderCount > 0) {
    events.push({
      kind: "reminder",
      at: inv.last_reminder_at,
      label:
        reminderCount === 1
          ? "Reminder sent"
          : `Reminder sent (${reminderCount} total)`,
      color: D.amber,
    });
  }
  if (inv.paid_at) {
    // Stripe payments carry card_brand / card_last_four; manual payments
    // (cash/check/zelle/other) carry payment_method + payment_reference.
    const MANUAL_LABELS = {
      cash: "Cash",
      check: "Check",
      zelle: "Zelle",
      other: "Other",
    };
    let method;
    if (inv.card_brand) {
      method = [
        inv.card_brand,
        inv.card_last_four ? `•${inv.card_last_four}` : null,
      ]
        .filter(Boolean)
        .join(" ");
    } else if (inv.payment_method && MANUAL_LABELS[inv.payment_method]) {
      method = [
        MANUAL_LABELS[inv.payment_method],
        inv.payment_reference ? `· ${inv.payment_reference}` : null,
        inv.payment_recorded_by
          ? `· logged by ${inv.payment_recorded_by}`
          : null,
      ]
        .filter(Boolean)
        .join(" ");
    } else if (inv.payment_method) {
      method = inv.payment_method;
    } else {
      method = null;
    }
    events.push({
      kind: "paid",
      at: inv.paid_at,
      label: `Paid $${parseFloat(inv.total).toFixed(2)}`,
      detail: method || null,
      color: D.green,
      emphasis: true,
    });
  }
  if (inv.receipt_sent_at) {
    events.push({
      kind: "receipt",
      at: inv.receipt_sent_at,
      label: "Receipt sent",
      detail: inv.receipt_memo ? `“${inv.receipt_memo}”` : null,
      color: D.green,
    });
  }
  if (inv.status === "void") {
    events.push({
      kind: "void",
      at: inv.updated_at,
      label: "Voided",
      color: D.muted,
    });
  }
  if (inv.archived_at) {
    events.push({
      kind: "archived",
      at: inv.archived_at,
      label: "Archived",
      color: D.muted,
    });
  }
  return events.sort((a, b) => new Date(b.at) - new Date(a.at));
}

function formatTimelineWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const timeStr = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  if (sameDay) return `Today at ${timeStr}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString())
    return `Yesterday at ${timeStr}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(
    "en-US",
    sameYear
      ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
}

function InvoiceTimeline({ invoice }) {
  const events = buildInvoiceTimeline(invoice);
  if (events.length === 0) return null;
  return (
    <div
      style={{
        margin: "4px 0 16px",
        paddingTop: 12,
        borderTop: `1px solid ${D.border}`,
      }}
    >
      {" "}
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.06em",
          color: D.muted,
          textTransform: "uppercase",
          marginBottom: 12,
        }}
      >
        Activity
      </div>{" "}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {events.map((e, i) => (
          <div
            key={`${e.kind}-${i}`}
            style={{ display: "flex", gap: 12, alignItems: "flex-start" }}
          >
            {" "}
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: e.color,
                marginTop: 6,
                flexShrink: 0,
                boxShadow: e.emphasis ? `0 0 0 3px ${e.color}22` : undefined,
              }}
            />{" "}
            <div style={{ flex: 1, minWidth: 0 }}>
              {" "}
              <div
                style={{
                  fontSize: 14,
                  color: D.heading,
                  fontWeight: e.emphasis ? 700 : 500,
                  lineHeight: 1.3,
                }}
              >
                {e.label}
              </div>
              {e.detail && (
                <div
                  style={{
                    fontSize: 13,
                    color: D.muted,
                    marginTop: 2,
                    lineHeight: 1.35,
                    wordBreak: "break-word",
                  }}
                >
                  {e.detail}
                </div>
              )}
              <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>
                {formatTimelineWhen(e.at)}
              </div>{" "}
            </div>{" "}
          </div>
        ))}
      </div>{" "}
    </div>
  );
}

function InvoiceAttachmentsPanel({ invoiceId, showToast, isMobile }) {
  const [attachments, setAttachments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const fileRef = useRef(null);
  const showToastRef = useRef(showToast);
  const helpId = `invoice-attachments-${invoiceId}-help`;
  const statusId = `invoice-attachments-${invoiceId}-status`;

  useEffect(() => {
    showToastRef.current = showToast;
  }, [showToast]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminFetch(`/admin/invoices/${invoiceId}/attachments`);
      setAttachments(data.attachments || []);
    } catch (err) {
      showToastRef.current(`Attachments failed to load: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleFiles = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length || uploading) return;
    const validation = validateAttachmentFiles(attachments, files);
    if (validation) {
      showToast(validation);
      return;
    }
    setUploading(true);
    try {
      await uploadInvoiceAttachments(invoiceId, files);
      showToast(`${files.length} attachment${files.length === 1 ? "" : "s"} uploaded`);
      await load();
    } catch (err) {
      showToast(`Attachment upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  const openAttachment = async (attachment) => {
    try {
      const data = await adminFetch(
        `/admin/invoices/${invoiceId}/attachments/${attachment.id}/url`,
      );
      if (data.url) window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      showToast(`Attachment open failed: ${err.message}`);
    }
  };

  const deleteAttachment = async (attachment) => {
    if (!confirm(`Remove ${attachment.file_name}?`)) return;
    setDeletingId(attachment.id);
    try {
      await adminFetch(
        `/admin/invoices/${invoiceId}/attachments/${attachment.id}`,
        { method: "DELETE" },
      );
      showToast("Attachment removed");
      await load();
    } catch (err) {
      showToast(`Attachment delete failed: ${err.message}`);
    } finally {
      setDeletingId(null);
    }
  };

  const canAdd = canAddInvoiceAttachments(attachments);

  return (
    <div
      style={{
        margin: "4px 0 16px",
        paddingTop: 12,
        borderTop: `1px solid ${D.border}`,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 10,
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.06em",
              color: D.muted,
              textTransform: "uppercase",
              marginBottom: 4,
            }}
          >
            <Paperclip size={13} strokeWidth={2.2} />
            Attachments
          </div>
          <div id={helpId} style={{ fontSize: 12, color: D.muted, lineHeight: 1.4 }}>
            {ATTACHMENT_HELP_TEXT}
            <br />
            {ATTACHMENT_VISIBILITY_TEXT}
          </div>
        </div>
        <input
          id={`invoice-attachments-${invoiceId}`}
          name="invoice_attachments"
          ref={fileRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          onChange={handleFiles}
          aria-describedby={`${helpId} ${statusId}`}
          style={{ display: "none" }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={!canAdd || uploading}
          aria-describedby={`${helpId} ${statusId}`}
          style={{
            ...sBtn(D.card, D.text, isMobile),
            border: `1px solid ${D.border}`,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            opacity: !canAdd || uploading ? 0.55 : 1,
          }}
        >
          <Upload size={14} strokeWidth={2.2} />
          {uploading ? "Uploading..." : "Add files"}
        </button>
      </div>

      {loading ? (
        <div id={statusId} role="status" aria-live="polite" style={{ fontSize: 12, color: D.muted }}>Loading attachments...</div>
      ) : attachments.length === 0 ? (
        <div id={statusId} role="status" aria-live="polite" style={{ fontSize: 12, color: D.muted }}>No files attached.</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) auto auto",
                alignItems: "center",
                gap: 8,
                padding: "9px 10px",
                border: `1px solid ${D.border}`,
                borderRadius: 8,
                background: D.card,
              }}
            >
              <button
                type="button"
                onClick={() => openAttachment(attachment)}
                style={{
                  minWidth: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  border: "none",
                  background: "transparent",
                  color: D.heading,
                  cursor: "pointer",
                  padding: 0,
                  textAlign: "left",
                }}
              >
                <FileText size={15} strokeWidth={2.1} />
                <span
                  style={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  {attachment.file_name}
                </span>
              </button>
              <span style={{ fontSize: 12, color: D.muted, whiteSpace: "nowrap" }}>
                {formatFileSize(attachment.file_size_bytes)}
              </span>
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  type="button"
                  onClick={() => openAttachment(attachment)}
                  aria-label={`Open ${attachment.file_name}`}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: D.muted,
                    cursor: "pointer",
                    width: 32,
                    height: 32,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <ExternalLink size={15} strokeWidth={2.2} />
                </button>
                <button
                  type="button"
                  onClick={() => deleteAttachment(attachment)}
                  disabled={deletingId === attachment.id}
                  aria-label={`Remove ${attachment.file_name}`}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: D.red,
                    cursor: deletingId === attachment.id ? "wait" : "pointer",
                    width: 32,
                    height: 32,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: deletingId === attachment.id ? 0.55 : 1,
                  }}
                >
                  <Trash2 size={15} strokeWidth={2.2} />
                </button>
              </div>
            </div>
          ))}
          <div id={statusId} role="status" aria-live="polite" style={{ fontSize: 11, color: D.muted }}>
            {invoiceAttachmentLimitLabel(attachments)}
          </div>
        </div>
      )}
    </div>
  );
}

function contactRoleLabel(role) {
  if (role === "billing_contact") return "Billing recipient";
  if (role === "invoice_override") return "One-time invoice recipient";
  if (role === "service_contact") return "Service contact";
  return "Primary customer";
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function DeliveryRow({ label, value, detail, missing }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "130px 1fr",
        gap: 12,
        alignItems: "start",
        padding: "12px 0",
        borderBottom: `1px solid ${D.border}`,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: D.muted,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 650,
            color: missing ? D.red : D.heading,
            overflowWrap: "anywhere",
          }}
        >
          {value}
        </div>
        {detail && (
          <div style={{ marginTop: 3, fontSize: 12, color: D.muted }}>
            {detail}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Send Invoice Modal ──
// Shows the resolved payment-link recipients before delivery. SMS stays on
// the primary account phone; email can be routed once or saved as billing.
function SendInvoiceModal({ invoice, isMobile, onClose, onSent, onError }) {
  const [loading, setLoading] = useState(true);
  const [recipients, setRecipients] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [useOverride, setUseOverride] = useState(false);
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError("");
    adminFetch(`/admin/invoices/${invoice.id}/recipients`)
      .then((data) => {
        if (!alive) return;
        setRecipients(data);
        setUseOverride(false);
        setRecipientName("");
        setRecipientEmail("");
        setSaveAsDefault(false);
      })
      .catch((err) => {
        if (!alive) return;
        setLoadError(err.message || "Recipient lookup failed");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [invoice.id]);

  const defaultEmail = recipients?.emailRecipient?.email || "";
  const defaultEmailRole = recipients?.emailRecipient?.role || "primary";
  const smsPhone = recipients?.smsRecipient?.phone || "";
  const overrideEmail = recipientEmail.trim();
  const overrideValid = !useOverride || isEmailLike(overrideEmail);
  const emailChannel = useOverride ? overrideValid : !!defaultEmail;
  const sendWithServerRecipients = !!loadError && !useOverride;
  const canSend =
    !loading &&
    !sending &&
    (sendWithServerRecipients || emailChannel || !!smsPhone) &&
    overrideValid;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      const body = {};
      if (useOverride) {
        body.invoiceRecipientEmail = overrideEmail;
        body.invoiceRecipientName = recipientName.trim() || undefined;
        body.saveBillingRecipient = saveAsDefault;
      }
      const res = await adminFetch(`/admin/invoices/${invoice.id}/send`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      onSent(res);
    } catch (err) {
      onError(`Invoice send failed: ${err.message}`);
    } finally {
      setSending(false);
    }
  };

  const customerName =
    recipients?.customerName ||
    [invoice.first_name, invoice.last_name].filter(Boolean).join(" ").trim() ||
    "Customer";

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 400,
        display: "flex",
        alignItems: isMobile ? "flex-end" : "center",
        justifyContent: "center",
        padding: isMobile ? 0 : 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: D.card,
          borderRadius: isMobile ? "16px 16px 0 0" : 14,
          width: "100%",
          maxWidth: 540,
          padding: isMobile ? "24px 20px 28px" : 28,
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
        }}
      >
        <div
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: D.heading,
            marginBottom: 4,
          }}
        >
          {invoice.status === "draft" || invoice.status === "scheduled"
            ? "Send invoice"
            : "Resend invoice"}
        </div>
        <div style={{ fontSize: 13, color: D.muted, marginBottom: 18 }}>
          Invoice #{invoice.invoice_number} · $
          {parseFloat(invoice.total).toFixed(2)} · {customerName}
        </div>

        {loading ? (
          <div style={{ padding: "18px 0", fontSize: 14, color: D.muted }}>
            Loading recipients...
          </div>
        ) : loadError ? (
          <div
            style={{
              padding: "12px 14px",
              border: `1px solid ${D.red}`,
              borderRadius: 8,
              color: D.red,
              fontSize: 13,
              lineHeight: 1.45,
            }}
          >
            {loadError}. You can still send using the saved invoice delivery settings.
          </div>
        ) : (
          <>
            <div style={{ borderTop: `1px solid ${D.border}` }}>
              <DeliveryRow
                label="SMS pay link"
                value={smsPhone || "No phone on primary customer"}
                detail={smsPhone ? "Primary customer phone" : "SMS will be skipped"}
                missing={!smsPhone}
              />
              <DeliveryRow
                label="Invoice email"
                value={
                  useOverride
                    ? (overrideEmail || "Enter one-time recipient email")
                    : (defaultEmail || "No invoice email configured")
                }
                detail={
                  useOverride
                    ? "One-time recipient for this send"
                    : (defaultEmail
                      ? contactRoleLabel(defaultEmailRole)
                      : "Email will be skipped unless you add a recipient")
                }
                missing={
                  useOverride
                    ? !!overrideEmail && !isEmailLike(overrideEmail)
                    : !defaultEmail
                }
              />
            </div>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginTop: 18,
                fontSize: 14,
                fontWeight: 650,
                color: D.text,
                cursor: "pointer",
              }}
            >
              <input
                id={`invoice-recipient-override-${invoice.id}`}
                name="invoice_recipient_override"
                type="checkbox"
                checked={useOverride}
                onChange={(e) => {
                  setUseOverride(e.target.checked);
                  if (!e.target.checked) setSaveAsDefault(false);
                }}
                style={{ width: 16, height: 16, accentColor: D.heading }}
              />
              Send invoice email to someone else
            </label>

            {useOverride && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: isMobile ? "1fr" : "1fr 1.4fr",
                  gap: 10,
                  marginTop: 12,
                }}
              >
                <div>
                  <label
                    htmlFor={`invoice-recipient-name-${invoice.id}`}
                    style={{
                      display: "block",
                      fontSize: 11,
                      fontWeight: 700,
                      color: D.muted,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      marginBottom: 6,
                    }}
                  >
                    Name
                  </label>
                  <input
                    id={`invoice-recipient-name-${invoice.id}`}
                    name="invoice_recipient_name"
                    autoComplete="name"
                    value={recipientName}
                    onChange={(e) => setRecipientName(e.target.value)}
                    placeholder="Accounts payable"
                    style={sInput(isMobile)}
                  />
                </div>
                <div>
                  <label
                    htmlFor={`invoice-recipient-email-${invoice.id}`}
                    style={{
                      display: "block",
                      fontSize: 11,
                      fontWeight: 700,
                      color: D.muted,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      marginBottom: 6,
                    }}
                  >
                    Email
                  </label>
                  <input
                    id={`invoice-recipient-email-${invoice.id}`}
                    name="invoice_recipient_email"
                    type="email"
                    autoComplete="email"
                    value={recipientEmail}
                    onChange={(e) => setRecipientEmail(e.target.value)}
                    placeholder="billing@example.com"
                    style={{
                      ...sInput(isMobile),
                      borderColor:
                        overrideEmail && !isEmailLike(overrideEmail)
                          ? D.red
                          : D.border,
                    }}
                  />
                </div>
              </div>
            )}

            {useOverride && (
              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  marginTop: 12,
                  fontSize: 13,
                  lineHeight: 1.45,
                  color: D.text,
                  cursor: "pointer",
                }}
              >
                <input
                  id={`invoice-recipient-save-${invoice.id}`}
                  name="invoice_recipient_save_default"
                  type="checkbox"
                  checked={saveAsDefault}
                  onChange={(e) => setSaveAsDefault(e.target.checked)}
                  style={{
                    width: 16,
                    height: 16,
                    accentColor: D.heading,
                    marginTop: 2,
                  }}
                />
                <span>
                  Save as this customer's billing recipient for future invoices
                </span>
              </label>
            )}
          </>
        )}

        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 22,
          }}
        >
          <button
            onClick={onClose}
            disabled={sending}
            style={sBtn("transparent", D.text, isMobile)}
          >
            Cancel
          </button>
          <button
            onClick={send}
            disabled={!canSend}
            style={{
              ...sBtn(D.heading, D.white, isMobile),
              opacity: canSend ? 1 : 0.5,
            }}
          >
            {sending ? "Sending..." : "Send invoice"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Send Receipt Modal ──
// Per-invoice action for paid invoices. Memo is ephemeral (stored on the
// invoice row as receipt_memo for audit) — not a customer preference.
function SendReceiptModal({ invoice, isMobile, onClose, onSent, onError }) {
  const [memo, setMemo] = useState("");
  const [sendEmail, setSendEmail] = useState(!!invoice.email);
  const [sendSms, setSendSms] = useState(!!invoice.phone);
  const [recipientLookup, setRecipientLookup] = useState(null);
  const [recipientsLoading, setRecipientsLoading] = useState(true);
  const [recipientLookupError, setRecipientLookupError] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let alive = true;
    setRecipientsLoading(true);
    setRecipientLookupError("");
    adminFetch(`/admin/invoices/${invoice.id}/recipients`)
      .then((data) => {
        if (!alive) return;
        setRecipientLookup(data);
        const nextEmail = data?.emailRecipient?.email || "";
        const nextPhone = data?.smsRecipient?.phone || "";
        setSendEmail(!!nextEmail);
        setSendSms(!!nextPhone);
      })
      .catch((err) => {
        if (!alive) return;
        setRecipientLookup(null);
        setSendEmail(!!invoice.email);
        setSendSms(!!invoice.phone);
        setRecipientLookupError(err.message || "Recipient lookup failed");
      })
      .finally(() => {
        if (alive) setRecipientsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [invoice.id, invoice.email, invoice.phone]);

  const receiptEmail = recipientLookup
    ? recipientLookup.emailRecipient?.email || ""
    : invoice.email || "";
  const receiptEmailRole = recipientLookup?.emailRecipient?.role || "primary";
  const receiptPhone = recipientLookup
    ? recipientLookup.smsRecipient?.phone || ""
    : invoice.phone || "";
  const hasEmail = !!receiptEmail;
  const hasPhone = !!receiptPhone;
  const anyChannel = sendEmail || sendSms;

  const handleSend = async () => {
    if (!anyChannel || sending || recipientsLoading) return;
    const via = sendEmail && sendSms ? "both" : sendEmail ? "email" : "sms";
    setSending(true);
    try {
      const res = await adminFetch(
        `/admin/invoices/${invoice.id}/send-receipt`,
        {
          method: "POST",
          body: JSON.stringify({ memo: memo.trim() || undefined, via }),
        },
      );
      if (!res.ok) {
        const detail =
          [res.email?.error, res.sms?.error].filter(Boolean).join(" · ") ||
          "Send failed";
        onError(`Receipt send failed: ${detail}`);
      } else {
        onSent();
      }
    } catch (err) {
      onError(`Receipt send failed: ${err.message}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 400,
        display: "flex",
        alignItems: isMobile ? "flex-end" : "center",
        justifyContent: "center",
        padding: isMobile ? 0 : 20,
      }}
    >
      {" "}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: D.card,
          borderRadius: isMobile ? "16px 16px 0 0" : 14,
          width: "100%",
          maxWidth: 440,
          padding: isMobile ? "24px 20px 28px" : 28,
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
        }}
      >
        {" "}
        <div
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: D.heading,
            marginBottom: 4,
          }}
        >
          Send receipt & close
        </div>{" "}
        <div style={{ fontSize: 13, color: D.muted, marginBottom: 20 }}>
          Invoice #{invoice.invoice_number} · $
          {parseFloat(invoice.total).toFixed(2)} · {invoice.first_name}{" "}
          {invoice.last_name}
        </div>{" "}
        <label
          style={{
            display: "block",
            fontSize: 12,
            fontWeight: 600,
            color: D.text,
            marginBottom: 6,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Optional memo
        </label>{" "}
        <textarea
          value={memo}
          onChange={(e) => setMemo(e.target.value.slice(0, 400))}
          placeholder="e.g. Left a spare trap in the garage — rebait in 2 weeks."
          rows={3}
          style={{
            ...sInput(isMobile),
            resize: "vertical",
            minHeight: 72,
            fontFamily: "inherit",
          }}
        />{" "}
        <div
          style={{
            fontSize: 11,
            color: D.muted,
            textAlign: "right",
            marginTop: 4,
            marginBottom: 18,
          }}
        >
          {memo.length}/400
        </div>{" "}
        {recipientLookupError && (
          <div
            style={{
              marginBottom: 12,
              padding: "10px 12px",
              background: "#FEF3C7",
              border: `1px solid ${D.amber}`,
              borderRadius: 8,
              fontSize: 12,
              color: D.text,
              lineHeight: 1.45,
            }}
          >
            Recipient lookup failed. Receipt delivery will use the invoice
            contact shown below.
          </div>
        )}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            marginBottom: 8,
          }}
        >
          {" "}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              cursor:
                hasEmail && !recipientsLoading ? "pointer" : "not-allowed",
              opacity: hasEmail && !recipientsLoading ? 1 : 0.5,
            }}
          >
            {" "}
            <input
              type="checkbox"
              checked={sendEmail && hasEmail}
              disabled={!hasEmail || recipientsLoading}
              onChange={(e) => setSendEmail(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: D.heading }}
            />{" "}
            <span style={{ fontSize: 14, color: D.text }}>
              Email{" "}
              {recipientsLoading ? (
                <span style={{ color: D.muted }}>· loading recipient</span>
              ) : receiptEmail ? (
                <span style={{ color: D.muted }}>
                  · {receiptEmail} · {contactRoleLabel(receiptEmailRole)}
                </span>
              ) : (
                <span style={{ color: D.muted, fontStyle: "italic" }}>
                  · no email on file
                </span>
              )}
            </span>{" "}
          </label>{" "}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              cursor:
                hasPhone && !recipientsLoading ? "pointer" : "not-allowed",
              opacity: hasPhone && !recipientsLoading ? 1 : 0.5,
            }}
          >
            {" "}
            <input
              type="checkbox"
              checked={sendSms && hasPhone}
              disabled={!hasPhone || recipientsLoading}
              onChange={(e) => setSendSms(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: D.heading }}
            />{" "}
            <span style={{ fontSize: 14, color: D.text }}>
              SMS{" "}
              {recipientsLoading ? (
                <span style={{ color: D.muted }}>· loading recipient</span>
              ) : receiptPhone ? (
                <span style={{ color: D.muted }}>· {receiptPhone}</span>
              ) : (
                <span style={{ color: D.muted, fontStyle: "italic" }}>
                  · no phone on file
                </span>
              )}
            </span>{" "}
          </label>{" "}
        </div>
        {invoice.receipt_sent_at && (
          <div
            style={{
              marginTop: 14,
              padding: "10px 12px",
              background: "#FEF3C7",
              border: `1px solid ${D.amber}`,
              borderRadius: 8,
              fontSize: 12,
              color: D.text,
              lineHeight: 1.45,
            }}
          >
            A receipt was already sent on{" "}
            {new Date(invoice.receipt_sent_at).toLocaleString()}. Sending again
            logs a second touch.
          </div>
        )}
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 20,
          }}
        >
          {" "}
          <button
            onClick={onClose}
            disabled={sending}
            style={sBtn("transparent", D.text, isMobile)}
          >
            Cancel
          </button>{" "}
          <button
            onClick={handleSend}
            disabled={!anyChannel || sending || recipientsLoading}
            style={{
              ...sBtn(D.heading, D.white, isMobile),
              opacity: !anyChannel || sending || recipientsLoading ? 0.5 : 1,
            }}
          >
            {sending ? "Sending…" : "Send receipt"}
          </button>{" "}
        </div>{" "}
      </div>{" "}
    </div>
  );
}

// ── Apply Credit Modal ──
// Draws down the customer's account credit to cover this invoice. Fully
// covering the full amount due marks the invoice prepaid. Account credit is
// the holding bucket for money paid ahead (quarterly prepay) or goodwill,
// issued from Customer 360. Partial application is deliberately not offered —
// a remaining balance would still be charged in full by the Stripe/Terminal
// pay paths, so credit must cover the whole invoice.
function ApplyCreditModal({ invoice, isMobile, onClose, onApplied, onError }) {
  const [loading, setLoading] = useState(true);
  const [ctx, setCtx] = useState(null);
  const [waiveSetupFee, setWaiveSetupFee] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await adminFetch(
          `/admin/invoices/${invoice.id}/credit-context`,
        );
        if (!alive) return;
        setCtx(data);
      } catch (err) {
        if (alive) onError(`Couldn't load account credit: ${err.message}`);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [invoice.id]);

  const balance = Number(ctx?.balance || 0);
  const amountDue = Number(ctx?.amount_due || 0);
  const canCover = amountDue > 0 && balance + 0.005 >= amountDue;
  const shortfall = Math.max(0, amountDue - balance);
  const canApply = !loading && !saving && canCover;

  const handleApply = async () => {
    if (!canApply) return;
    setSaving(true);
    try {
      const res = await adminFetch(
        `/admin/invoices/${invoice.id}/apply-credit`,
        {
          method: "POST",
          body: JSON.stringify({
            waiveSetupFee,
            note: note.trim() || undefined,
          }),
        },
      );
      onApplied(
        `Invoice marked prepaid · $${Number(res.applied).toFixed(2)} credit applied`,
      );
    } catch (err) {
      onError(`Apply credit failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const fieldLabel = {
    display: "block",
    fontSize: 12,
    fontWeight: 600,
    color: D.text,
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 400,
        display: "flex",
        alignItems: isMobile ? "flex-end" : "center",
        justifyContent: "center",
        padding: isMobile ? 0 : 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: D.card,
          borderRadius: isMobile ? "16px 16px 0 0" : 14,
          width: "100%",
          maxWidth: 460,
          padding: isMobile ? "24px 20px 28px" : 28,
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          maxHeight: "92vh",
          overflowY: "auto",
        }}
      >
        <div
          style={{ fontSize: 20, fontWeight: 700, color: D.heading, marginBottom: 4 }}
        >
          Apply account credit
        </div>
        <div style={{ fontSize: 13, color: D.muted, marginBottom: 20 }}>
          Invoice #{invoice.invoice_number} · {invoice.first_name}{" "}
          {invoice.last_name}
        </div>

        {loading ? (
          <div style={{ fontSize: 14, color: D.muted, padding: "20px 0" }}>
            Loading account credit…
          </div>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                marginBottom: 16,
                padding: "12px 14px",
                background: "#F4F4F5",
                border: `1px solid ${D.border}`,
                borderRadius: 8,
              }}
            >
              <div>
                <div style={{ fontSize: 11, color: D.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Available credit
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: balance > 0 ? D.heading : D.muted }}>
                  ${balance.toFixed(2)}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, color: D.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Amount due
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: D.heading }}>
                  ${amountDue.toFixed(2)}
                </div>
              </div>
            </div>

            {!canCover ? (
              <div style={{ fontSize: 13, color: D.muted, marginBottom: 8, lineHeight: 1.5 }}>
                {balance <= 0
                  ? "This customer has no account credit. "
                  : `Available credit ($${balance.toFixed(2)}) doesn't cover the $${amountDue.toFixed(2)} due — $${shortfall.toFixed(2)} short. `}
                Credit must cover the invoice in full. Issue more credit from the
                customer's profile (Customer 360 → Account credit), or lower the
                invoice, then try again.
              </div>
            ) : (
              <>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 16,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={waiveSetupFee}
                    onChange={(e) => setWaiveSetupFee(e.target.checked)}
                    style={{ width: 16, height: 16, accentColor: D.heading }}
                  />
                  <span style={{ fontSize: 14, color: D.text }}>
                    Waive initial / setup fee
                    <span style={{ color: D.muted, marginLeft: 6, fontStyle: "italic" }}>
                      · records the waiver on this invoice
                    </span>
                  </span>
                </label>

                <label style={fieldLabel}>Note (optional)</label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  placeholder="e.g. Q3 prepay collected by phone"
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    background: D.bg,
                    color: D.text,
                    border: `1px solid ${D.border}`,
                    borderRadius: 8,
                    fontSize: 14,
                    boxSizing: "border-box",
                    resize: "vertical",
                    fontFamily: "inherit",
                  }}
                />

                <div
                  style={{
                    marginTop: 14,
                    padding: "10px 12px",
                    background: "#F4F4F5",
                    border: `1px solid ${D.border}`,
                    borderRadius: 8,
                    fontSize: 12,
                    color: D.muted,
                    lineHeight: 1.45,
                  }}
                >
                  Applies ${amountDue.toFixed(2)} from account credit, marks the
                  invoice prepaid, and stops automated reminders.
                </div>
              </>
            )}
          </>
        )}

        <div
          style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}
        >
          <button
            onClick={onClose}
            disabled={saving}
            style={sBtn("transparent", D.text, isMobile)}
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={!canApply}
            style={{ ...sBtn(D.heading, D.white, isMobile), opacity: canApply ? 1 : 0.5 }}
          >
            {saving ? "Applying…" : "Apply & mark prepaid"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Record Payment Modal ──
// Square-parity flow: log cash / check / Zelle / other against an open
// invoice, mark it paid, and (by default) fire the receipt in the same
// call. Reference field captures check #, Zelle confirmation, etc.
function RecordPaymentModal({
  invoice,
  isMobile,
  onClose,
  onRecorded,
  onError,
}) {
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [sendReceipt, setSendReceipt] = useState(true);
  const [recipientLookup, setRecipientLookup] = useState(null);
  const [recipientsLoading, setRecipientsLoading] = useState(true);
  const [recipientLookupError, setRecipientLookupError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    setRecipientsLoading(true);
    setRecipientLookupError("");
    adminFetch(`/admin/invoices/${invoice.id}/recipients`)
      .then((data) => {
        if (!alive) return;
        setRecipientLookup(data);
      })
      .catch((err) => {
        if (!alive) return;
        setRecipientLookup(null);
        setRecipientLookupError(err.message || "Recipient lookup failed");
      })
      .finally(() => {
        if (alive) setRecipientsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [invoice.id]);

  const referenceLabel =
    method === "check"
      ? "Check number"
      : method === "zelle"
        ? "Zelle confirmation #"
        : method === "other"
          ? "Reference"
          : "Reference (optional)";

  const referencePlaceholder =
    method === "check"
      ? "e.g. 1042"
      : method === "zelle"
        ? "e.g. RP1ABCXYZ"
        : method === "other"
          ? "e.g. money order #, Venmo handle"
          : "";

  const receiptEmail = recipientLookup
    ? recipientLookup.emailRecipient?.email || ""
    : invoice.email || "";
  const receiptPhone = recipientLookup
    ? recipientLookup.smsRecipient?.phone || ""
    : invoice.phone || "";
  const hasEmail = !!receiptEmail;
  const hasPhone = !!receiptPhone;
  const hasContact = hasEmail || hasPhone;
  const receiptVia = hasEmail && hasPhone ? "both" : hasEmail ? "email" : "sms";
  const receiptChannels = [
    hasEmail && `email to ${receiptEmail}`,
    hasPhone && "SMS",
  ].filter(Boolean);
  const recordDisabled = saving || (sendReceipt && recipientsLoading);

  const handleRecord = async () => {
    if (recordDisabled) return;
    setSaving(true);
    try {
      const res = await adminFetch(
        `/admin/invoices/${invoice.id}/record-payment`,
        {
          method: "POST",
          body: JSON.stringify({
            method,
            reference: reference.trim() || undefined,
            note: note.trim() || undefined,
            sendReceipt: sendReceipt && hasContact,
            via: sendReceipt && hasContact ? receiptVia : undefined,
          }),
        },
      );
      const channels = [
        res.receipt?.email?.ok && "email",
        res.receipt?.sms?.ok && "sms",
      ].filter(Boolean);
      const msg =
        sendReceipt && hasContact && channels.length
          ? `Payment recorded · receipt sent (${channels.join(" + ")})`
          : "Payment recorded";
      onRecorded(msg);
    } catch (err) {
      onError(`Record payment failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const methodChoice = (key, label) => (
    <button
      key={key}
      type="button"
      onClick={() => setMethod(key)}
      style={{
        flex: 1,
        padding: "12px 10px",
        background: method === key ? D.heading : D.card,
        color: method === key ? D.white : D.text,
        border: `1px solid ${method === key ? D.heading : D.border}`,
        borderRadius: 8,
        fontSize: 14,
        fontWeight: 600,
        cursor: "pointer",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        minHeight: 44,
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 400,
        display: "flex",
        alignItems: isMobile ? "flex-end" : "center",
        justifyContent: "center",
        padding: isMobile ? 0 : 20,
      }}
    >
      {" "}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: D.card,
          borderRadius: isMobile ? "16px 16px 0 0" : 14,
          width: "100%",
          maxWidth: 460,
          padding: isMobile ? "24px 20px 28px" : 28,
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          maxHeight: "92vh",
          overflowY: "auto",
        }}
      >
        {" "}
        <div
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: D.heading,
            marginBottom: 4,
          }}
        >
          Add payment
        </div>{" "}
        <div style={{ fontSize: 13, color: D.muted, marginBottom: 20 }}>
          Invoice #{invoice.invoice_number} · $
          {parseFloat(invoice.total).toFixed(2)} · {invoice.first_name}{" "}
          {invoice.last_name}
        </div>{" "}
        <label
          style={{
            display: "block",
            fontSize: 12,
            fontWeight: 600,
            color: D.text,
            marginBottom: 8,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Payment method
        </label>{" "}
        <div
          style={{
            display: "flex",
            gap: 6,
            marginBottom: 18,
            flexWrap: "wrap",
          }}
        >
          {methodChoice("cash", "Cash")}
          {methodChoice("check", "Check")}
          {methodChoice("zelle", "Zelle")}
          {methodChoice("other", "Other")}
        </div>{" "}
        <label
          style={{
            display: "block",
            fontSize: 12,
            fontWeight: 600,
            color: D.text,
            marginBottom: 6,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          {referenceLabel}
        </label>{" "}
        <input
          value={reference}
          onChange={(e) => setReference(e.target.value.slice(0, 200))}
          placeholder={referencePlaceholder}
          style={sInput(isMobile)}
        />{" "}
        <label
          style={{
            display: "block",
            fontSize: 12,
            fontWeight: 600,
            color: D.text,
            margin: "16px 0 6px",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Note (optional)
        </label>{" "}
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 400))}
          placeholder="e.g. Customer dropped check off at the office"
          rows={2}
          style={{
            ...sInput(isMobile),
            resize: "vertical",
            minHeight: 56,
            fontFamily: "inherit",
          }}
        />{" "}
        <div
          style={{
            fontSize: 11,
            color: D.muted,
            textAlign: "right",
            marginTop: 4,
            marginBottom: 14,
          }}
        >
          {note.length}/400
        </div>{" "}
        {recipientLookupError && (
          <div
            style={{
              marginBottom: 12,
              padding: "10px 12px",
              background: "#FEF3C7",
              border: `1px solid ${D.amber}`,
              borderRadius: 8,
              fontSize: 12,
              color: D.text,
              lineHeight: 1.45,
            }}
          >
            Recipient lookup failed. Receipt delivery will use the invoice
            contact shown below.
          </div>
        )}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            cursor:
              hasContact && !recipientsLoading ? "pointer" : "not-allowed",
            opacity: hasContact && !recipientsLoading ? 1 : 0.5,
          }}
        >
          {" "}
          <input
            type="checkbox"
            checked={sendReceipt && hasContact}
            disabled={!hasContact || recipientsLoading}
            onChange={(e) => setSendReceipt(e.target.checked)}
            style={{ width: 16, height: 16, accentColor: D.heading }}
          />{" "}
          <span style={{ fontSize: 14, color: D.text }}>
            Send receipt now
            {recipientsLoading ? (
              <span style={{ color: D.muted, marginLeft: 6 }}>
                · loading recipients
              </span>
            ) : hasContact ? (
              <span style={{ color: D.muted, marginLeft: 6 }}>
                · {receiptChannels.join(" + ")}
              </span>
            ) : (
              <span
                style={{ color: D.muted, marginLeft: 6, fontStyle: "italic" }}
              >
                · no email or phone on file
              </span>
            )}
          </span>{" "}
        </label>{" "}
        <div
          style={{
            marginTop: 14,
            padding: "10px 12px",
            background: "#F4F4F5",
            border: `1px solid ${D.border}`,
            borderRadius: 8,
            fontSize: 12,
            color: D.muted,
            lineHeight: 1.45,
          }}
        >
          Marks this invoice paid and stops automated reminders. Use only after
          the money has actually arrived.
        </div>{" "}
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 20,
          }}
        >
          {" "}
          <button
            onClick={onClose}
            disabled={saving}
            style={sBtn("transparent", D.text, isMobile)}
          >
            Cancel
          </button>{" "}
          <button
            onClick={handleRecord}
            disabled={recordDisabled}
            style={{
              ...sBtn(D.heading, D.white, isMobile),
              opacity: recordDisabled ? 0.5 : 1,
            }}
          >
            {saving
              ? "Recording…"
              : sendReceipt && recipientsLoading
                ? "Loading recipients…"
                : sendReceipt && hasContact
                  ? "Record & send receipt"
                  : "Record payment"}
          </button>{" "}
        </div>{" "}
      </div>{" "}
    </div>
  );
}

// Flags an existing invoice as an annual prepayment so the customer-facing
// coverage banner renders on the pay page + PDF. Prefills from the linked term
// when one already exists (edit mode), otherwise from the invoice itself.
function AnnualPrepayModal({ invoice, isMobile, onClose, onSaved, onError }) {
  const [loading, setLoading] = useState(true);
  const [existing, setExisting] = useState(null);
  const [start, setStart] = useState(
    invoiceDateOnly(invoice.service_date) || todayDateInput(),
  );
  const [months, setMonths] = useState(12);
  const [planLabel, setPlanLabel] = useState(invoice.title || "");
  const [amount, setAmount] = useState(
    invoice.total != null ? String(parseFloat(invoice.total).toFixed(2)) : "",
  );
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    adminFetch(`/admin/invoices/${invoice.id}`)
      .then((data) => {
        if (!alive) return;
        const term = data?.annual_prepay;
        if (term) {
          setExisting(term);
          if (term.termStart) setStart(invoiceDateOnly(term.termStart) || start);
          if (term.coverageMonths) setMonths(term.coverageMonths);
          if (term.planLabel) setPlanLabel(term.planLabel);
          if (term.prepayAmount != null) {
            setAmount(String(Number(term.prepayAmount).toFixed(2)));
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [invoice.id]);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await adminFetch(`/admin/invoices/${invoice.id}/annual-prepay`, {
        method: "POST",
        body: JSON.stringify({
          termStart: start || undefined,
          months: Number(months) || undefined,
          planLabel: planLabel.trim() || undefined,
          prepayAmount: amount !== "" ? Number(amount) : undefined,
        }),
      });
      onSaved(existing ? "Annual prepay updated" : "Marked as annual prepay");
    } catch (err) {
      onError(`Annual prepay failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (removing) return;
    if (
      !confirm(
        "Remove the annual prepay flag from this invoice? The coverage banner will stop showing.",
      )
    )
      return;
    setRemoving(true);
    try {
      await adminFetch(`/admin/invoices/${invoice.id}/annual-prepay`, {
        method: "DELETE",
      });
      onSaved("Annual prepay removed");
    } catch (err) {
      onError(`Remove failed: ${err.message}`);
    } finally {
      setRemoving(false);
    }
  };

  const labelStyle = {
    display: "block",
    fontSize: 12,
    fontWeight: 600,
    color: D.text,
    margin: "16px 0 6px",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 400,
        display: "flex",
        alignItems: isMobile ? "flex-end" : "center",
        justifyContent: "center",
        padding: isMobile ? 0 : 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: D.card,
          borderRadius: isMobile ? "16px 16px 0 0" : 14,
          width: "100%",
          maxWidth: 460,
          padding: isMobile ? "24px 20px 28px" : 28,
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          maxHeight: "92vh",
          overflowY: "auto",
        }}
      >
        <div
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: D.heading,
            marginBottom: 4,
          }}
        >
          {existing ? "Annual prepay" : "Mark as annual prepay"}
        </div>
        <div style={{ fontSize: 13, color: D.muted, marginBottom: 16 }}>
          Invoice #{invoice.invoice_number} · {invoice.first_name}{" "}
          {invoice.last_name}
        </div>

        <div
          style={{
            padding: "10px 12px",
            background: "#F4F4F5",
            border: `1px solid ${D.border}`,
            borderRadius: 8,
            fontSize: 12,
            color: D.muted,
            lineHeight: 1.45,
          }}
        >
          Adds the "Annual prepayment" coverage banner to the customer's invoice
          (pay page + PDF), showing the dates this payment covers. Use it for a
          customer paying a full year up front.
        </div>

        <label style={labelStyle}>Coverage start</label>
        <input
          type="date"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          style={sInput(isMobile)}
        />

        <label style={labelStyle}>Term length (months)</label>
        <input
          type="number"
          min={1}
          max={60}
          value={months}
          onChange={(e) => setMonths(e.target.value)}
          style={sInput(isMobile)}
        />

        <label style={labelStyle}>Plan label</label>
        <input
          value={planLabel}
          onChange={(e) => setPlanLabel(e.target.value.slice(0, 120))}
          placeholder="e.g. WaveGuard Bronze Annual Prepay"
          style={sInput(isMobile)}
        />

        <label style={labelStyle}>Prepay amount</label>
        <input
          type="number"
          min={0}
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          style={sInput(isMobile)}
        />

        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 22,
          }}
        >
          <div>
            {existing && (
              <button
                onClick={handleRemove}
                disabled={removing || saving}
                style={{
                  ...sBtn("transparent", D.red, isMobile),
                  opacity: removing ? 0.5 : 1,
                }}
              >
                {removing ? "Removing…" : "Remove"}
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onClose}
              disabled={saving || removing}
              style={sBtn("transparent", D.text, isMobile)}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || removing || loading}
              style={{
                ...sBtn(D.heading, D.white, isMobile),
                opacity: saving || loading ? 0.5 : 1,
              }}
            >
              {saving ? "Saving…" : existing ? "Update" : "Mark prepaid"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function todayDateInput() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDaysDateInput(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function PaymentPlanModal({
  invoice,
  isMobile,
  onClose,
  onCreated,
  onError,
}) {
  const total = Number(invoice.total || 0);
  const startDate = todayDateInput();
  const [paymentAmount, setPaymentAmount] = useState(
    Number.isFinite(total) && total > 0 ? (Math.ceil((total / 3) * 100) / 100).toFixed(2) : "",
  );
  const [paymentFrequency, setPaymentFrequency] = useState("monthly");
  const [planStartDate, setPlanStartDate] = useState(startDate);
  const [nextPaymentDate, setNextPaymentDate] = useState(addDaysDateInput(startDate, 30));
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const amount = Number(paymentAmount);
  const validAmount = Number.isFinite(amount) && amount > 0 && amount <= total;
  const createDisabled = saving || !validAmount || !nextPaymentDate || !planStartDate;

  const createPlan = async () => {
    if (createDisabled) return;
    setSaving(true);
    try {
      await adminFetch(`/admin/invoices/${invoice.id}/payment-plan`, {
        method: "POST",
        body: JSON.stringify({
          totalBalance: total,
          paymentAmount: amount,
          paymentFrequency,
          planStartDate,
          nextPaymentDate,
          notes: notes.trim() || undefined,
        }),
      });
      onCreated();
    } catch (err) {
      onError(`Payment plan failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const frequencyChoice = (key, label) => (
    <button
      key={key}
      type="button"
      onClick={() => setPaymentFrequency(key)}
      style={{
        flex: 1,
        padding: "12px 10px",
        background: paymentFrequency === key ? D.heading : D.card,
        color: paymentFrequency === key ? D.white : D.text,
        border: `1px solid ${paymentFrequency === key ? D.heading : D.border}`,
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        minHeight: 44,
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 400,
        display: "flex",
        alignItems: isMobile ? "flex-end" : "center",
        justifyContent: "center",
        padding: isMobile ? 0 : 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: D.card,
          borderRadius: isMobile ? "16px 16px 0 0" : 14,
          width: "100%",
          maxWidth: 500,
          padding: isMobile ? "24px 20px 28px" : 28,
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          maxHeight: "92vh",
          overflowY: "auto",
        }}
      >
        <div
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: D.heading,
            marginBottom: 4,
          }}
        >
          Create payment plan
        </div>
        <div style={{ fontSize: 13, color: D.muted, marginBottom: 20 }}>
          Invoice #{invoice.invoice_number} · ${total.toFixed(2)} ·{" "}
          {invoice.first_name} {invoice.last_name}
        </div>

        <label
          style={{
            display: "block",
            fontSize: 12,
            fontWeight: 600,
            color: D.text,
            marginBottom: 6,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Payment amount
        </label>
        <input
          type="number"
          min="0.01"
          step="0.01"
          value={paymentAmount}
          onChange={(e) => setPaymentAmount(e.target.value)}
          style={sInput(isMobile)}
        />
        {!validAmount && (
          <div style={{ color: D.red, fontSize: 12, marginTop: 6 }}>
            Enter an amount greater than $0 and no more than ${total.toFixed(2)}.
          </div>
        )}

        <label
          style={{
            display: "block",
            fontSize: 12,
            fontWeight: 600,
            color: D.text,
            margin: "16px 0 8px",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Frequency
        </label>
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          {frequencyChoice("weekly", "Weekly")}
          {frequencyChoice("biweekly", "Biweekly")}
          {frequencyChoice("monthly", "Monthly")}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
            gap: 12,
          }}
        >
          <div>
            <label
              style={{
                display: "block",
                fontSize: 12,
                fontWeight: 600,
                color: D.text,
                marginBottom: 6,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Start date
            </label>
            <input
              type="date"
              value={planStartDate}
              onChange={(e) => setPlanStartDate(e.target.value)}
              style={sInput(isMobile)}
            />
          </div>
          <div>
            <label
              style={{
                display: "block",
                fontSize: 12,
                fontWeight: 600,
                color: D.text,
                marginBottom: 6,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Next payment
            </label>
            <input
              type="date"
              value={nextPaymentDate}
              onChange={(e) => setNextPaymentDate(e.target.value)}
              style={sInput(isMobile)}
            />
          </div>
        </div>

        <label
          style={{
            display: "block",
            fontSize: 12,
            fontWeight: 600,
            color: D.text,
            margin: "16px 0 6px",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Note (optional)
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value.slice(0, 500))}
          placeholder="e.g. Customer requested three monthly payments"
          rows={3}
          style={{
            ...sInput(isMobile),
            resize: "vertical",
            minHeight: 72,
            fontFamily: "inherit",
          }}
        />

        <div
          style={{
            marginTop: 14,
            padding: "10px 12px",
            background: "#F4F4F5",
            border: `1px solid ${D.border}`,
            borderRadius: 8,
            fontSize: 12,
            color: D.muted,
            lineHeight: 1.45,
          }}
        >
          Creates the plan, adds an invoice timeline entry, and sends the
          customer the payment plan confirmation email.
        </div>

        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 20,
          }}
        >
          <button
            onClick={onClose}
            disabled={saving}
            style={sBtn("transparent", D.text, isMobile)}
          >
            Cancel
          </button>
          <button
            onClick={createPlan}
            disabled={createDisabled}
            style={{
              ...sBtn(D.heading, D.white, isMobile),
              opacity: createDisabled ? 0.5 : 1,
            }}
          >
            {saving ? "Creating…" : "Create plan"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Create Invoice ──
function CreateInvoice({ showToast, onCreated, isMobile }) {
  function defaultServiceDate() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const get = (type) => parts.find((part) => part.type === type)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  }
  const newLineItem = () => ({
    client_id: `li_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    description: "",
    quantity: 1,
    unit_price: 0,
  });
  const [customerQuery, setCustomerQuery] = useState("");
  const [customers, setCustomers] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [serviceRecords, setServiceRecords] = useState([]);
  const [selectedService, setSelectedService] = useState(null);
  const [serviceDate, setServiceDate] = useState(defaultServiceDate);
  const [lineItems, setLineItems] = useState(() => [newLineItem()]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [sendTiming, setSendTiming] = useState("now");
  const [sendCustomAt, setSendCustomAt] = useState("");
  const [dueTiming, setDueTiming] = useState("today");
  const [dueCustomDate, setDueCustomDate] = useState("");
  const [requestReview, setRequestReview] = useState(false);
  const [reviewTiming, setReviewTiming] = useState("120");
  const [reviewCustomAt, setReviewCustomAt] = useState("");
  const [serviceSearchIdx, setServiceSearchIdx] = useState(null);
  const [serviceResults, setServiceResults] = useState([]);
  const [availableDiscounts, setAvailableDiscounts] = useState([]);
  const [discountSearchIdx, setDiscountSearchIdx] = useState(null);
  const [discountQueries, setDiscountQueries] = useState({});
  const [aiNotesLoading, setAiNotesLoading] = useState(false);
  const [queuedAttachments, setQueuedAttachments] = useState([]);
  const attachmentInputRef = useRef(null);

  // Load active, invoice-visible discounts once. Tier discounts are included here
  // for explicit line-level selection; customer tier never applies a hidden discount.
  useEffect(() => {
    adminFetch("/admin/discounts")
      .then((d) => {
        const list = (Array.isArray(d) ? d : d.discounts || []).filter(
          (x) => x.is_active && x.show_in_invoices,
        );
        setAvailableDiscounts(list);
      })
      .catch(() => {});
  }, []);

  // Customer search
  useEffect(() => {
    if (customerQuery.length < 2) {
      setCustomers([]);
      return;
    }
    const t = setTimeout(() => {
      adminFetch(
        `/admin/invoices/customers/search?q=${encodeURIComponent(customerQuery)}`,
      )
        .then((d) => setCustomers(d.customers || []))
        .catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [customerQuery]);

  // Load service records when customer selected
  useEffect(() => {
    if (!selectedCustomer) {
      setServiceRecords([]);
      return;
    }
    adminFetch(`/admin/invoices/service-records/${selectedCustomer.id}`)
      .then((d) => setServiceRecords(d.records || []))
      .catch(() => {});
  }, [selectedCustomer]);

  // Service library search for active line item
  useEffect(() => {
    if (serviceSearchIdx === null) {
      setServiceResults([]);
      return;
    }
    const q = lineItems[serviceSearchIdx]?.description || "";
    if (q.length < 2) {
      setServiceResults([]);
      return;
    }
    const t = setTimeout(() => {
      adminFetch(
        `/admin/services?search=${encodeURIComponent(q)}&is_active=true&limit=10`,
      )
        .then((d) => setServiceResults(d.services || []))
        .catch(() => setServiceResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [serviceSearchIdx, lineItems]);

  const pickService = (i, svc) => {
    const updated = [...lineItems];
    updated[i] = {
      ...updated[i],
      _kind: "service",
      description: svc.name,
      unit_price: Number(svc.base_price) || updated[i].unit_price || 0,
    };
    setLineItems(updated);
    setServiceSearchIdx(null);
    setServiceResults([]);
  };

  const isCustomAmountDiscount = (d) =>
    d.discount_type === "variable_amount" ||
    (d.discount_type === "fixed_amount" &&
      (d.discount_key === "custom_dollar" || !(Number(d.amount) > 0)));
  const isCustomPercentageDiscount = (d) =>
    d.discount_type === "variable_percentage" ||
    (d.discount_type === "percentage" &&
      (d.discount_key === "custom_percent" || !(Number(d.amount) > 0)));

  const formatDiscountLabel = (d) =>
    d.discount_type === "percentage" ||
    d.discount_type === "variable_percentage"
      ? isCustomPercentageDiscount(d)
        ? "custom %"
        : `${Number(d.amount)}%`
      : d.discount_type === "fixed_amount" ||
          d.discount_type === "variable_amount"
        ? isCustomAmountDiscount(d)
          ? "custom $"
          : `$${Number(d.amount).toFixed(2)}`
        : d.discount_type === "free_service"
          ? "free"
          : "";

  const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

  const getCustomDiscountValue = (discount, parent, baseAmount) => {
    if (isCustomAmountDiscount(discount)) {
      const raw = window.prompt(
        `Discount amount for ${parent.description || "this line"} ($)`,
        Number(discount.amount) > 0 ? Number(discount.amount).toFixed(2) : "",
      );
      if (raw === null) return null;
      const customAmount = roundMoney(raw);
      if (!(customAmount > 0)) {
        showToast("Enter a discount amount greater than $0");
        return null;
      }
      return {
        dollars: Math.min(baseAmount, customAmount),
        custom_discount_amount: customAmount,
      };
    }
    if (isCustomPercentageDiscount(discount)) {
      const raw = window.prompt(
        `Discount percentage for ${parent.description || "this line"} (%)`,
        Number(discount.amount) > 0 ? String(Number(discount.amount)) : "",
      );
      if (raw === null) return null;
      const customPercentage = Number(raw);
      if (
        !Number.isFinite(customPercentage) ||
        customPercentage <= 0 ||
        customPercentage > 100
      ) {
        showToast("Enter a discount percentage between 0 and 100");
        return null;
      }
      return {
        dollars: Math.min(
          baseAmount,
          roundMoney(
            previewDiscount(
              { ...discount, amount: customPercentage },
              baseAmount,
            ),
          ),
        ),
        custom_discount_percentage: customPercentage,
      };
    }
    return null;
  };

  const matchingDiscounts = (lineIdx) => {
    const lineKey = lineItems[lineIdx]?.client_id || lineIdx;
    const q = (discountQueries[lineKey] || "").trim().toLowerCase();
    if (!q) return availableDiscounts.slice(0, 10);
    return availableDiscounts
      .filter((d) =>
        `${d.name || ""} ${d.description || ""} ${formatDiscountLabel(d)}`
          .toLowerCase()
          .includes(q),
      )
      .slice(0, 10);
  };

  const addDiscountToLine = (lineIdx, discount) => {
    const parent = lineItems[lineIdx];
    if (!parent || parent._kind === "discount") return;
    const baseAmount = Math.max(0, lineAmount(parent));
    if (!parent.description || baseAmount <= 0) {
      showToast(
        "Choose a service and enter a price before applying a discount",
      );
      return;
    }
    const custom = getCustomDiscountValue(discount, parent, baseAmount);
    if (
      (isCustomAmountDiscount(discount) ||
        isCustomPercentageDiscount(discount)) &&
      !custom
    )
      return;
    const dollars =
      custom?.dollars ??
      Math.min(baseAmount, roundMoney(previewDiscount(discount, baseAmount)));
    if (dollars <= 0) {
      showToast("Discount has no amount for this line");
      return;
    }
    const discountItem = {
      client_id: `li_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      _kind: "discount",
      discount_id: discount.id,
      discount_key: discount.discount_key || null,
      discount_for: parent.client_id,
      description: `${discount.name} (${parent.description || "line item"})`,
      quantity: 1,
      unit_price: -dollars,
      amount: -dollars,
      is_waveguard_tier_discount: !!discount.is_waveguard_tier_discount,
      ...(custom?.custom_discount_amount
        ? { custom_discount_amount: custom.custom_discount_amount }
        : {}),
      ...(custom?.custom_discount_percentage
        ? { custom_discount_percentage: custom.custom_discount_percentage }
        : {}),
    };
    const updated = [...lineItems];
    let insertAt = lineIdx + 1;
    while (
      updated[insertAt]?._kind === "discount" &&
      updated[insertAt]?.discount_for === parent.client_id
    )
      insertAt += 1;
    updated.splice(insertAt, 0, discountItem);
    setLineItems(updated);
    setDiscountSearchIdx(null);
    setDiscountQueries((prev) => ({
      ...prev,
      [parent.client_id || lineIdx]: "",
    }));
  };

  const addLineItem = () => setLineItems([...lineItems, newLineItem()]);
  const removeLineItem = (i) => {
    const id = lineItems[i]?.client_id;
    setLineItems(
      lineItems.filter((item, idx) => idx !== i && item.discount_for !== id),
    );
    setDiscountSearchIdx((prev) => (prev === i ? null : prev));
  };
  const updateLineItem = (i, field, value) => {
    const updated = [...lineItems];
    updated[i] = {
      ...updated[i],
      [field]: field === "description" ? value : parseFloat(value) || 0,
    };
    setLineItems(updated);
  };

  const lineAmount = (item) =>
    Math.round(
      (Number(item.quantity) || 1) * (Number(item.unit_price) || 0) * 100,
    ) / 100;
  const serviceLineItems = lineItems.filter((i) => i._kind !== "discount");
  const subtotal = serviceLineItems.reduce(
    (sum, i) => sum + Math.max(0, lineAmount(i)),
    0,
  );
  const lineDiscountAmt = Math.abs(
    lineItems
      .filter((i) => i._kind === "discount")
      .reduce((sum, i) => sum + Math.min(0, lineAmount(i)), 0),
  );

  // Mirror server discount-engine math so the preview matches stored totals.
  const previewDiscount = (disc, baseAmount) => {
    const amt = Number(disc.amount) || 0;
    if (
      disc.discount_type === "percentage" ||
      disc.discount_type === "variable_percentage"
    ) {
      let dollars = baseAmount * (amt / 100);
      if (disc.max_discount_dollars)
        dollars = Math.min(dollars, Number(disc.max_discount_dollars));
      return dollars;
    }
    if (
      disc.discount_type === "fixed_amount" ||
      disc.discount_type === "variable_amount"
    )
      return amt;
    if (disc.discount_type === "free_service") return baseAmount;
    return 0;
  };
  const totalDiscountAmt = Math.min(subtotal, lineDiscountAmt);

  const afterDiscount = subtotal - totalDiscountAmt;
  const isCommercial =
    selectedCustomer?.property_type === "commercial" ||
    selectedCustomer?.property_type === "business";
  const taxRate = isCommercial ? 0.07 : 0;
  const tax = afterDiscount * taxRate;
  const total = afterDiscount + tax;
  const cardCharge = computeCardTotal(total);

  const dateOnly = (date) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value;
    const y = get("year");
    const m = get("month");
    const d = get("day");
    return `${y}-${m}-${d}`;
  };
  const addDays = (days) => {
    const [y, m, d] = dateOnly(new Date()).split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  };
  const invoiceDueDate = () => {
    if (dueTiming === "today") return dateOnly(new Date());
    if (dueTiming === "tomorrow") return dateOnly(addDays(1));
    if (dueTiming === "7") return dateOnly(addDays(7));
    if (dueTiming === "30") return dateOnly(addDays(30));
    return dueCustomDate || null;
  };
  const invoiceScheduledFor = () => {
    if (sendTiming === "now" || sendTiming === "draft") return null;
    if (sendTiming === "tomorrow_8") {
      return `${dateOnly(addDays(1))}T08:00`;
    }
    return sendCustomAt || null;
  };

  const reviewDelayMinutes = () => {
    if (!requestReview) return null;
    if (reviewTiming === "now") return 0;
    if (reviewTiming === "custom") {
      const target = new Date(reviewCustomAt);
      return reviewCustomAt && !Number.isNaN(target.getTime()) ? 0 : null;
    }
    return Number(reviewTiming) || 120;
  };

  const handleWriteNotesWithAI = async () => {
    const usableLines = lineItems.filter(
      (i) => i._kind !== "discount" && i.description,
    );
    if (!notes.trim() && usableLines.length === 0) {
      showToast("Add notes or services first");
      return;
    }
    setAiNotesLoading(true);
    try {
      const result = await adminFetch("/admin/invoices/notes/ai", {
        method: "POST",
        body: JSON.stringify({
          input: notes,
          customerName: selectedCustomer
            ? `${selectedCustomer.first_name || ""} ${selectedCustomer.last_name || ""}`.trim()
            : "",
          services: usableLines.map((item) => ({
            description: item.description,
            quantity: Number(item.quantity) || 1,
          })),
        }),
      });
      if (result.notes) {
        setNotes(result.notes);
        showToast("Notes written with AI");
      } else {
        showToast("AI did not return notes");
      }
    } catch (e) {
      showToast(`AI notes failed: ${e.message}`);
    }
    setAiNotesLoading(false);
  };

  const handleQueuedAttachments = (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    const validation = validateAttachmentFiles(queuedAttachments, files);
    if (validation) {
      showToast(validation);
      return;
    }
    setQueuedAttachments((prev) => [...prev, ...files]);
  };

  const removeQueuedAttachment = (idx) => {
    setQueuedAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleCreate = async () => {
    if (!selectedCustomer) {
      showToast("Select a customer");
      return;
    }
    if (
      !lineItems.some(
        (i) => i._kind !== "discount" && i.description && i.unit_price > 0,
      )
    ) {
      showToast("Add at least one line item");
      return;
    }
    if (!serviceDate) {
      showToast("Choose a service date");
      return;
    }
    const dueDate = invoiceDueDate();
    if (!dueDate) {
      showToast("Choose a due date");
      return;
    }
    const scheduledFor = invoiceScheduledFor();
    if (sendTiming === "custom" && !scheduledFor) {
      showToast("Choose an invoice send time");
      return;
    }
    const reviewDelay = reviewDelayMinutes();
    if (sendTiming !== "draft" && requestReview && reviewDelay === null) {
      showToast("Choose a review request time");
      return;
    }
    setSaving(true);

    try {
      const body = {
        customerId: selectedCustomer.id,
        serviceRecordId: selectedService?.id || null,
        serviceDate,
        lineItems: lineItems
          .filter((i) => i.description && Number(i.unit_price) !== 0)
          .map((i) => ({
            ...i,
            amount: lineAmount(i),
          })),
        notes: notes || null,
        dueDate,
      };

      const invoice = await adminFetch("/admin/invoices", {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (queuedAttachments.length > 0 && invoice.id) {
        try {
          await uploadInvoiceAttachments(invoice.id, queuedAttachments);
        } catch (attachmentErr) {
          showToast(
            `Invoice created, but attachments failed: ${attachmentErr.message}`,
          );
          onCreated();
          setSaving(false);
          return;
        }
      }

      if (sendTiming === "now" && invoice.id) {
        await adminFetch(`/admin/invoices/${invoice.id}/send`, {
          method: "POST",
          body: JSON.stringify({
            requestReview,
            reviewDelayMinutes: reviewDelay,
            reviewTiming,
            reviewScheduledFor:
              reviewTiming === "custom" ? reviewCustomAt : null,
          }),
        });
        showToast(`Invoice created & sent: ${invoice.invoice_number}`);
      } else if (sendTiming !== "draft" && invoice.id) {
        await adminFetch(`/admin/invoices/${invoice.id}/schedule-send`, {
          method: "POST",
          body: JSON.stringify({
            scheduledFor,
            requestReview,
            reviewDelayMinutes: reviewDelay,
            reviewTiming,
            reviewScheduledFor:
              reviewTiming === "custom" ? reviewCustomAt : null,
          }),
        });
        showToast(`Invoice scheduled: ${invoice.invoice_number}`);
      } else {
        showToast(`Invoice created: ${invoice.invoice_number} (draft)`);
      }
      onCreated();
    } catch (e) {
      showToast(`Error: ${e.message}`);
    }
    setSaving(false);
  };

  const sectionHeader = (title, action = null) => (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: 12,
        marginBottom: 14,
        flexWrap: "wrap",
      }}
    >
      {" "}
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
          minWidth: 0,
        }}
      >
        {" "}
        <div style={{ minWidth: 0 }}>
          {" "}
          <div style={{ fontSize: 15, fontWeight: 700, color: D.heading }}>
            {title}
          </div>{" "}
        </div>{" "}
      </div>
      {action}
    </div>
  );

  const lineRowGrid = (item) => ({
    display: "grid",
    gridTemplateColumns: isMobile
      ? "minmax(0, 1fr) 76px"
      : "minmax(260px, 1fr) 84px 132px 36px",
    gap: 8,
    alignItems: "start",
    padding: item._kind === "discount" ? "8px 0 8px 18px" : "12px 0",
    borderTop: `1px solid ${D.border}`,
    background: item._kind === "discount" ? "#F0FDF4" : "transparent",
    borderRadius: item._kind === "discount" ? 8 : 0,
  });

  const fieldLabel = (label, align = "left") => (
    <div
      style={{
        fontSize: 11,
        color: D.muted,
        textTransform: "uppercase",
        letterSpacing: 0.6,
        marginBottom: 5,
        textAlign: align,
      }}
    >
      {label}
    </div>
  );

  const panelStyle = (style) => ({
    ...sCard,
    padding: isMobile ? 14 : 18,
    marginBottom: 0,
    borderRadius: 10,
    ...style,
  });
  const primaryActionLabel = saving
    ? "Creating..."
    : sendTiming === "now"
      ? "Send Invoice"
      : sendTiming === "draft"
        ? "Create Draft"
        : "Schedule Invoice";
  const canAddQueuedAttachments = canAddInvoiceAttachments(queuedAttachments);
  const queuedAttachmentHelpId = "invoice-create-attachments-help";
  const queuedAttachmentStatusId = "invoice-create-attachments-status";
  const lineTableColumns = "minmax(260px, 1fr) 84px 132px 36px";
  const summaryRowStyle = (size = 12, weight = 400) => ({
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) max-content",
    gap: 12,
    alignItems: "baseline",
    fontSize: size,
    fontWeight: weight,
    color: D.text,
    marginBottom: 4,
  });
  const summaryLabelStyle = { minWidth: 0, overflowWrap: "anywhere" };
  const summaryAmountStyle = {
    fontFamily: "'Roboto', Arial, sans-serif",
    textAlign: "right",
    whiteSpace: "nowrap",
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1fr) 340px",
        gap: 16,
        alignItems: "start",
        fontFamily: "'Roboto', Arial, sans-serif",
        color: D.text,
      }}
    >
      {" "}
      <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
        {" "}
        <div style={panelStyle({ padding: isMobile ? 14 : 16 })}>
          {" "}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            {" "}
            <div>
              {" "}
              <div style={{ fontSize: 18, fontWeight: 800, color: D.heading }}>
                Invoice Builder
              </div>{" "}
            </div>{" "}
          </div>{" "}
        </div>{" "}
        <div style={panelStyle()}>
          {sectionHeader("Customer")}
          {selectedCustomer ? (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: D.input,
                borderRadius: 8,
                padding: "10px 12px",
                border: `1px solid ${D.teal}`,
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              {" "}
              <div>
                {" "}
                <span style={{ color: D.heading, fontWeight: 600 }}>
                  {selectedCustomer.first_name} {selectedCustomer.last_name}
                </span>{" "}
                <span style={{ color: D.muted, fontSize: 12, marginLeft: 8 }}>
                  {selectedCustomer.phone}
                </span>
                {selectedCustomer.waveguard_tier && (
                  <span
                    style={{
                      ...sBadge(`${D.amber}22`, D.amber),
                      marginLeft: 8,
                    }}
                  >
                    {selectedCustomer.waveguard_tier}
                  </span>
                )}
              </div>{" "}
              <button
                onClick={() => {
                  setSelectedCustomer(null);
                  setSelectedService(null);
                  setCustomerQuery("");
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: D.muted,
                  cursor: "pointer",
                  fontSize: 18,
                  padding: isMobile ? "10px 12px" : "4px 8px",
                  minHeight: isMobile ? 44 : undefined,
                  minWidth: isMobile ? 44 : undefined,
                }}
              >
                x
              </button>{" "}
            </div>
          ) : (
            <div style={{ position: "relative" }}>
              {" "}
              <input
                value={customerQuery}
                onChange={(e) => setCustomerQuery(e.target.value)}
                placeholder="Search by name, phone, or email..."
                style={sInput(isMobile)}
              />
              {customers.length > 0 && (
                <div
                  style={{
                    position: "absolute",
                    top: "100%",
                    left: 0,
                    right: 0,
                    background: D.card,
                    border: `1px solid ${D.border}`,
                    borderRadius: 8,
                    zIndex: 10,
                    maxHeight: 200,
                    overflow: "auto",
                    marginTop: 4,
                  }}
                >
                  {customers.map((c) => (
                    <div
                      key={c.id}
                      onClick={() => {
                        setSelectedCustomer(c);
                        setCustomers([]);
                        setCustomerQuery("");
                      }}
                      style={{
                        padding: "10px 12px",
                        cursor: "pointer",
                        borderBottom: `1px solid ${D.border}`,
                        fontSize: 13,
                      }}
                    >
                      {" "}
                      <span style={{ color: D.heading }}>
                        {c.first_name} {c.last_name}
                      </span>{" "}
                      <span style={{ color: D.muted, marginLeft: 8 }}>
                        {c.phone}
                      </span>
                      {c.waveguard_tier && (
                        <span
                          style={{
                            ...sBadge(`${D.amber}22`, D.amber),
                            marginLeft: 8,
                          }}
                        >
                          {c.waveguard_tier}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {serviceRecords.length > 0 && (
          <div style={panelStyle()}>
            {sectionHeader("Service History")}
            <select
              value={selectedService?.id || ""}
              onChange={(e) => {
                const sr = serviceRecords.find((r) => r.id === e.target.value);
                setSelectedService(sr || null);
                if (sr?.service_date) setServiceDate(sr.service_date);
                if (sr && lineItems.length === 1 && !lineItems[0].description) {
                  setLineItems([
                    {
                      ...lineItems[0],
                      _kind: "service",
                      description: sr.service_type,
                      quantity: 1,
                      unit_price: 0,
                    },
                  ]);
                }
              }}
              style={sInput(isMobile)}
            >
              {" "}
              <option value="">No service linked</option>
              {serviceRecords.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.service_type} --{" "}
                  {new Date(r.service_date + "T12:00:00").toLocaleDateString()}{" "}
                  -- {r.tech_name || "Unknown tech"}
                </option>
              ))}
            </select>{" "}
          </div>
        )}
        <div style={panelStyle()}>
          {sectionHeader("Service Date")}
          <input
            type="date"
            value={serviceDate}
            onChange={(e) => setServiceDate(e.target.value)}
            style={sInput(isMobile)}
          />{" "}
        </div>{" "}
        <div style={panelStyle()}>
          {sectionHeader("Services")}
          {!isMobile && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: lineTableColumns,
                gap: 8,
                padding: "0 0 8px",
                borderBottom: `1px solid ${D.border}`,
                color: D.muted,
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: 0.6,
              }}
            >
              {" "}
              <div>Item</div> <div style={{ textAlign: "center" }}>Qty</div>{" "}
              <div>Rate</div> <div />{" "}
            </div>
          )}
          {lineItems.map((item, i) => (
            <div key={item.client_id || i} style={lineRowGrid(item)}>
              {" "}
              <div style={{ position: "relative", minWidth: 0 }}>
                {isMobile &&
                  fieldLabel(
                    item._kind === "discount" ? "Discount" : "Service",
                  )}
                <input
                  value={item.description}
                  onChange={(e) =>
                    updateLineItem(i, "description", e.target.value)
                  }
                  onFocus={() => {
                    if (item._kind !== "discount") setServiceSearchIdx(i);
                  }}
                  onBlur={() =>
                    setTimeout(() => {
                      setServiceSearchIdx((prev) => (prev === i ? null : prev));
                    }, 150)
                  }
                  placeholder={
                    item._kind === "discount" ? "Discount" : "Search services"
                  }
                  style={{ ...sInput(isMobile), color: D.text }}
                  readOnly={item._kind === "discount"}
                />
                {serviceSearchIdx === i &&
                  (lineItems[i]?.description || "").length >= 2 && (
                    <div
                      style={{
                        position: "absolute",
                        top: "100%",
                        left: 0,
                        right: 0,
                        background: D.card,
                        border: `1px solid ${D.border}`,
                        borderRadius: 8,
                        zIndex: 20,
                        maxHeight: 240,
                        overflow: "auto",
                        marginTop: 4,
                        boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                      }}
                    >
                      {serviceResults.length === 0 ? (
                        <div
                          style={{
                            padding: "10px 12px",
                            color: D.muted,
                            fontSize: 12,
                          }}
                        >
                          No services match. Check Services catalog.
                        </div>
                      ) : (
                        serviceResults.map((svc) => (
                          <div
                            key={svc.id}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              pickService(i, svc);
                            }}
                            style={{
                              padding: "10px 12px",
                              cursor: "pointer",
                              borderBottom: `1px solid ${D.border}`,
                              fontSize: 13,
                              display: "flex",
                              justifyContent: "space-between",
                              gap: 8,
                              alignItems: "center",
                            }}
                          >
                            {" "}
                            <div style={{ minWidth: 0, flex: 1 }}>
                              {" "}
                              <div
                                style={{
                                  color: D.heading,
                                  fontWeight: 600,
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {svc.name}
                              </div>
                              {svc.short_name &&
                                svc.short_name !== svc.name && (
                                  <div
                                    style={{
                                      color: D.muted,
                                      fontSize: 11,
                                      marginTop: 2,
                                    }}
                                  >
                                    {svc.short_name}
                                  </div>
                                )}
                            </div>
                            {svc.base_price != null &&
                              Number(svc.base_price) > 0 && (
                                <span
                                  style={{
                                    color: D.text,
                                    fontFamily: "'Roboto', Arial, sans-serif",
                                    fontSize: 12,
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  ${Number(svc.base_price).toFixed(2)}
                                </span>
                              )}
                          </div>
                        ))
                      )}
                    </div>
                  )}
              </div>{" "}
              <div>
                {isMobile && fieldLabel("Qty", "center")}
                <input
                  type="number"
                  value={item.quantity}
                  onChange={(e) =>
                    updateLineItem(i, "quantity", e.target.value)
                  }
                  min="1"
                  readOnly={item._kind === "discount"}
                  style={{ ...sInput(isMobile), textAlign: "center" }}
                />{" "}
              </div>{" "}
              <div style={{ position: "relative" }}>
                {isMobile &&
                  fieldLabel(item._kind === "discount" ? "Credit" : "Price")}
                <span
                  style={{
                    position: "absolute",
                    left: 10,
                    top: isMobile ? 43 : 20,
                    transform: "translateY(-50%)",
                    color: D.muted,
                    fontSize: isMobile ? 16 : 13,
                  }}
                >
                  $
                </span>{" "}
                <input
                  type="number"
                  value={item.unit_price || ""}
                  onChange={(e) =>
                    updateLineItem(i, "unit_price", e.target.value)
                  }
                  placeholder="0.00"
                  step="0.01"
                  readOnly={item._kind === "discount"}
                  style={{
                    ...sInput(isMobile),
                    paddingLeft: 22,
                    color: D.text,
                  }}
                />{" "}
              </div>
              {lineItems.length > 1 && (
                <button
                  onClick={() => removeLineItem(i)}
                  aria-label="Remove line item"
                  style={{
                    background: "none",
                    border: "none",
                    color: D.red,
                    cursor: "pointer",
                    fontSize: 18,
                    padding: isMobile ? "30px 12px 10px" : "6px 4px",
                    minHeight: isMobile ? 44 : undefined,
                    minWidth: isMobile ? 44 : undefined,
                  }}
                >
                  x
                </button>
              )}
              {item._kind !== "discount" && (
                <div
                  style={{
                    gridColumn: "1 / -1",
                    position: "relative",
                    padding: "0 0 2px",
                  }}
                >
                  {fieldLabel("Discount")}
                  <input
                    value={discountQueries[item.client_id || i] || ""}
                    onChange={(e) => {
                      setDiscountQueries((prev) => ({
                        ...prev,
                        [item.client_id || i]: e.target.value,
                      }));
                      if (availableDiscounts.length > 0)
                        setDiscountSearchIdx(i);
                    }}
                    onFocus={() => {
                      if (availableDiscounts.length > 0)
                        setDiscountSearchIdx(i);
                    }}
                    onBlur={() =>
                      setTimeout(() => {
                        setDiscountSearchIdx((prev) =>
                          prev === i ? null : prev,
                        );
                      }, 150)
                    }
                    placeholder={
                      availableDiscounts.length === 0
                        ? "No invoice discounts are available"
                        : `Search discounts${item.description ? ` for ${item.description}` : ""}...`
                    }
                    disabled={availableDiscounts.length === 0}
                    style={{
                      ...sInput(isMobile),
                      fontSize: isMobile ? 15 : 12,
                      minHeight: isMobile ? 42 : 36,
                      padding: isMobile ? "10px 12px" : "8px 10px",
                      opacity: availableDiscounts.length === 0 ? 0.65 : 1,
                    }}
                  />
                  {discountSearchIdx === i && (
                    <div
                      style={{
                        position: "absolute",
                        top: "100%",
                        left: 0,
                        right: 0,
                        background: D.card,
                        border: `1px solid ${D.border}`,
                        borderRadius: 8,
                        zIndex: 18,
                        maxHeight: 220,
                        overflow: "auto",
                        marginTop: 4,
                        boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                      }}
                    >
                      {matchingDiscounts(i).length === 0 ? (
                        <div
                          style={{
                            padding: "10px 12px",
                            color: D.muted,
                            fontSize: 12,
                          }}
                        >
                          No discounts match.
                        </div>
                      ) : (
                        matchingDiscounts(i).map((d) => (
                          <div
                            key={d.id}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              addDiscountToLine(i, d);
                            }}
                            style={{
                              padding: "10px 12px",
                              cursor: "pointer",
                              borderBottom: `1px solid ${D.border}`,
                              fontSize: 13,
                              display: "flex",
                              justifyContent: "space-between",
                              gap: 8,
                              alignItems: "center",
                            }}
                          >
                            {" "}
                            <span
                              style={{
                                color: D.heading,
                                fontWeight: 600,
                                minWidth: 0,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {d.name}
                            </span>{" "}
                            <span
                              style={{
                                color: D.text,
                                fontFamily: "'Roboto', Arial, sans-serif",
                                fontSize: 12,
                                whiteSpace: "nowrap",
                              }}
                            >
                              {formatDiscountLabel(d)}
                            </span>{" "}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          <button
            onClick={addLineItem}
            style={{
              ...sBtn("transparent", D.teal, isMobile),
              padding: isMobile ? "12px 14px" : "8px 12px",
              fontSize: isMobile ? 14 : 12,
              marginTop: 10,
            }}
          >
            + Add service
          </button>{" "}
        </div>{" "}
        <div style={panelStyle()}>
          {sectionHeader("Attachments")}
          <input
            ref={attachmentInputRef}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            onChange={handleQueuedAttachments}
            aria-describedby={`${queuedAttachmentHelpId} ${queuedAttachmentStatusId}`}
            style={{ display: "none" }}
          />
          <div id={queuedAttachmentHelpId} style={{ fontSize: 12, color: D.muted, lineHeight: 1.45, marginBottom: 12 }}>
            {ATTACHMENT_HELP_TEXT}
            <br />
            {ATTACHMENT_VISIBILITY_TEXT}
          </div>
          <button
            type="button"
            onClick={() => attachmentInputRef.current?.click()}
            disabled={!canAddQueuedAttachments}
            aria-describedby={`${queuedAttachmentHelpId} ${queuedAttachmentStatusId}`}
            style={{
              ...sBtn(D.card, D.text, isMobile),
              border: `1px solid ${D.border}`,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              opacity: canAddQueuedAttachments ? 1 : 0.55,
            }}
          >
            <Upload size={14} strokeWidth={2.2} />
            Add files
          </button>
          {queuedAttachments.length > 0 ? (
            <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
              {queuedAttachments.map((file, idx) => (
                <div
                  key={`${file.name}-${file.size}-${idx}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) auto auto",
                    alignItems: "center",
                    gap: 8,
                    padding: "9px 10px",
                    border: `1px solid ${D.border}`,
                    borderRadius: 8,
                    background: "#FAFAFA",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      minWidth: 0,
                    }}
                  >
                    <Paperclip size={15} strokeWidth={2.1} />
                    <span
                      style={{
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 13,
                        fontWeight: 600,
                        color: D.heading,
                      }}
                    >
                      {file.name}
                    </span>
                  </div>
                  <span style={{ fontSize: 12, color: D.muted, whiteSpace: "nowrap" }}>
                    {formatFileSize(file.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeQueuedAttachment(idx)}
                    aria-label={`Remove ${file.name}`}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: D.red,
                      cursor: "pointer",
                      width: 32,
                      height: 32,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Trash2 size={15} strokeWidth={2.2} />
                  </button>
                </div>
              ))}
              <div id={queuedAttachmentStatusId} role="status" aria-live="polite" style={{ fontSize: 11, color: D.muted }}>
                {invoiceAttachmentLimitLabel(queuedAttachments)}
              </div>
            </div>
          ) : (
            <div id={queuedAttachmentStatusId} role="status" aria-live="polite" style={{ fontSize: 12, color: D.muted, marginTop: 10 }}>
              No files selected.
            </div>
          )}
        </div>{" "}
        <div style={panelStyle()}>
          {sectionHeader("Delivery")}
          <div style={{ marginBottom: 14 }}>
            {" "}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                marginBottom: 4,
              }}
            >
              {" "}
              <label
                style={{
                  fontSize: 11,
                  color: D.muted,
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                  display: "block",
                }}
              >
                Notes (optional)
              </label>{" "}
              <button
                type="button"
                onClick={handleWriteNotesWithAI}
                disabled={aiNotesLoading}
                style={{
                  ...sBtn("transparent", D.teal, isMobile),
                  padding: isMobile ? "9px 10px" : "6px 8px",
                  fontSize: isMobile ? 12 : 11,
                  minHeight: isMobile ? 38 : 30,
                  opacity: aiNotesLoading ? 0.55 : 1,
                  whiteSpace: "nowrap",
                }}
              >
                {aiNotesLoading ? "Writing..." : "Write with AI"}
              </button>{" "}
            </div>{" "}
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder=""
              style={{ ...sInput(isMobile), resize: "vertical" }}
            />{" "}
          </div>{" "}
          <div style={{ marginBottom: 14 }}>
            {" "}
            <div
              style={{
                fontSize: 11,
                color: D.muted,
                textTransform: "uppercase",
                letterSpacing: 0.8,
                marginBottom: 6,
              }}
            >
              Schedule
            </div>{" "}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
                gap: 8,
              }}
            >
              {" "}
              <div>
                {" "}
                <label
                  style={{
                    fontSize: 12,
                    color: D.text,
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Send
                </label>{" "}
                <select
                  value={sendTiming}
                  onChange={(e) => setSendTiming(e.target.value)}
                  style={sInput(isMobile)}
                >
                  {" "}
                  <option value="now">Immediately</option>{" "}
                  <option value="tomorrow_8">Tomorrow at 8 AM</option>{" "}
                  <option value="custom">Custom time</option>{" "}
                  <option value="draft">Save draft</option>{" "}
                </select>{" "}
              </div>{" "}
              <div>
                {" "}
                <label
                  style={{
                    fontSize: 12,
                    color: D.text,
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Due
                </label>{" "}
                <select
                  value={dueTiming}
                  onChange={(e) => setDueTiming(e.target.value)}
                  style={sInput(isMobile)}
                >
                  {" "}
                  <option value="today">Today</option>{" "}
                  <option value="tomorrow">Tomorrow</option>{" "}
                  <option value="7">In 7 days</option>{" "}
                  <option value="30">In 30 days</option>{" "}
                  <option value="custom">Custom date</option>{" "}
                </select>{" "}
              </div>{" "}
            </div>
            {(sendTiming === "custom" || dueTiming === "custom") && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
                  gap: 8,
                  marginTop: 8,
                }}
              >
                {sendTiming === "custom" ? (
                  <input
                    type="datetime-local"
                    value={sendCustomAt}
                    onChange={(e) => setSendCustomAt(e.target.value)}
                    style={sInput(isMobile)}
                  />
                ) : (
                  <div />
                )}
                {dueTiming === "custom" ? (
                  <input
                    type="date"
                    value={dueCustomDate}
                    onChange={(e) => setDueCustomDate(e.target.value)}
                    style={sInput(isMobile)}
                  />
                ) : (
                  <div />
                )}
              </div>
            )}
          </div>{" "}
          <div
            style={{
              marginBottom: 16,
              opacity: sendTiming !== "draft" ? 1 : 0.5,
            }}
          >
            {" "}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: requestReview ? 8 : 0,
              }}
            >
              {" "}
              <input
                type="checkbox"
                checked={requestReview}
                onChange={(e) => setRequestReview(e.target.checked)}
                disabled={sendTiming === "draft"}
                id="review-toggle"
              />{" "}
              <label
                htmlFor="review-toggle"
                style={{ fontSize: 13, color: D.text }}
              >
                Send review request
              </label>{" "}
            </div>
            {requestReview && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
                  gap: 8,
                  paddingLeft: 22,
                }}
              >
                {" "}
                <select
                  value={reviewTiming}
                  onChange={(e) => setReviewTiming(e.target.value)}
                  disabled={sendTiming === "draft"}
                  style={sInput(isMobile)}
                >
                  {" "}
                  <option value="now">Now</option>{" "}
                  <option value="120">In 2 hours</option>{" "}
                  <option value="tomorrow_8">Tomorrow at 8 AM</option>{" "}
                  <option value="custom">Custom time</option>{" "}
                </select>
                {reviewTiming === "custom" && (
                  <input
                    type="datetime-local"
                    value={reviewCustomAt}
                    onChange={(e) => setReviewCustomAt(e.target.value)}
                    disabled={sendTiming === "draft"}
                    style={sInput(isMobile)}
                  />
                )}
              </div>
            )}
          </div>{" "}
        </div>{" "}
      </div>{" "}
      <div
        style={{
          position: isMobile ? "relative" : "sticky",
          top: 20,
          alignSelf: "start",
        }}
      >
        {" "}
        <div style={sCard}>
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: D.heading,
              marginBottom: 4,
            }}
          >
            Invoice Summary
          </div>{" "}
          <div style={{ fontSize: 12, color: D.muted, marginBottom: 12 }}>
            {selectedCustomer
              ? `${selectedCustomer.first_name} ${selectedCustomer.last_name}`
              : "No customer selected"}
          </div>{" "}
          <div
            style={{
              display: "grid",
              gap: 6,
              fontSize: 12,
              color: D.text,
              marginBottom: 14,
            }}
          >
            {" "}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              {" "}
              <span style={{ color: D.muted }}>Send</span>{" "}
              <span>
                {sendTiming === "now"
                  ? "Immediately"
                  : sendTiming === "draft"
                    ? "Draft"
                    : sendTiming === "tomorrow_8"
                      ? "Tomorrow 8 AM"
                      : "Custom"}
              </span>{" "}
            </div>{" "}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              {" "}
              <span style={{ color: D.muted }}>Due</span>{" "}
              <span>
                {dueTiming === "today"
                  ? "Today"
                  : dueTiming === "tomorrow"
                    ? "Tomorrow"
                    : dueTiming === "7"
                      ? "7 days"
                      : dueTiming === "30"
                        ? "30 days"
                        : dueCustomDate || "Custom"}
              </span>{" "}
            </div>{" "}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              {" "}
              <span style={{ color: D.muted }}>Sales tax</span>{" "}
              <span>{isCommercial ? "Commercial only" : "None"}</span>{" "}
            </div>{" "}
          </div>{" "}
          <button
            onClick={handleCreate}
            disabled={saving}
            style={{
              ...sBtn("#111", D.white, isMobile),
              width: "100%",
              padding: 14,
              minHeight: isMobile ? 48 : undefined,
              opacity: saving ? 0.5 : 1,
              marginBottom: 14,
            }}
          >
            {primaryActionLabel}
          </button>
          {lineItems
            .filter((i) => i.description)
            .map((item, i) => {
              const amount = lineAmount(item);
              return (
                <div
                  key={item.client_id || i}
                  style={{
                    ...summaryRowStyle(13),
                    paddingLeft: item._kind === "discount" ? 12 : 0,
                  }}
                >
                  {" "}
                  <span style={summaryLabelStyle}>
                    {item.description}
                    {item.quantity > 1 ? ` x${item.quantity}` : ""}
                  </span>{" "}
                  <span style={summaryAmountStyle}>
                    {amount < 0 ? "-" : ""}${Math.abs(amount).toFixed(2)}
                  </span>{" "}
                </div>
              );
            })}
          <div
            style={{
              borderTop: `1px solid ${D.border}`,
              marginTop: 12,
              paddingTop: 12,
            }}
          >
            {" "}
            <div style={summaryRowStyle()}>
              {" "}
              <span style={summaryLabelStyle}>Subtotal</span>
              <span style={summaryAmountStyle}>
                ${subtotal.toFixed(2)}
              </span>{" "}
            </div>
            {lineDiscountAmt > 0 && (
              <div style={summaryRowStyle()}>
                {" "}
                <span style={summaryLabelStyle}>Line-item discounts</span>
                <span style={summaryAmountStyle}>
                  -${lineDiscountAmt.toFixed(2)}
                </span>{" "}
              </div>
            )}
            {tax > 0 && (
              <div style={summaryRowStyle()}>
                {" "}
                <span style={summaryLabelStyle}>
                  Tax ({Math.round(taxRate * 100)}%)
                </span>
                <span style={summaryAmountStyle}>${tax.toFixed(2)}</span>{" "}
              </div>
            )}
            <div
              style={{
                ...summaryRowStyle(18, 700),
                marginTop: 8,
                paddingTop: 8,
                borderTop: `2px solid ${D.teal}`,
              }}
            >
              {" "}
              <span style={summaryLabelStyle}>Total</span>
              <span style={summaryAmountStyle}>${total.toFixed(2)}</span>{" "}
            </div>
            {cardCharge.surcharge > 0 && (
              <div style={{ ...summaryRowStyle(), marginTop: 6 }}>
                {" "}
                <span style={summaryLabelStyle}>
                  Credit Card Surcharge
                </span>
                <span style={summaryAmountStyle}>
                  ${cardCharge.surcharge.toFixed(2)}
                </span>{" "}
              </div>
            )}
          </div>{" "}
        </div>{" "}
      </div>{" "}
    </div>
  );
}

// ── Follow-up Sequence Panel (per-invoice) ──
function FollowupPanel({ invoiceId, showToast, isMobile }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const d = await adminFetch(`/admin/invoices/${invoiceId}/followup`).catch(
      () => null,
    );
    setData(d);
  }, [invoiceId]);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (path, body) => {
    setBusy(true);
    try {
      await adminFetch(`/admin/invoices/${invoiceId}/followup/${path}`, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
      });
      showToast("Done");
      await load();
    } catch {
      showToast("Action failed");
    } finally {
      setBusy(false);
    }
  };

  if (!data)
    return (
      <div style={{ marginTop: 10, fontSize: 12, color: D.muted }}>
        Loading follow-up…
      </div>
    );

  const seq = data.sequence;
  const steps = data.steps || [];

  const STATUS_COLOR = {
    active: D.green,
    paused: D.amber,
    stopped: D.muted,
    completed: D.muted,
    autopay_hold: D.teal,
  };

  const nextStep = seq ? steps[seq.step_index] : null;

  return (
    <div
      style={{
        marginTop: 12,
        padding: 12,
        background: "#F8FAFC",
        border: `1px solid ${D.border}`,
        borderRadius: 8,
      }}
    >
      {" "}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 10,
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        {" "}
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: D.heading,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          Automated Follow-ups
        </div>
        {seq ? (
          <span
            style={sBadge(
              `${STATUS_COLOR[seq.status] || D.muted}22`,
              STATUS_COLOR[seq.status] || D.muted,
            )}
          >
            {seq.status.replace("_", " ")}
          </span>
        ) : (
          <span style={sBadge(`${D.muted}22`, D.muted)}>not scheduled</span>
        )}
      </div>
      {seq && (
        <div
          style={{
            fontSize: 12,
            color: D.muted,
            marginBottom: 10,
            lineHeight: 1.6,
          }}
        >
          {" "}
          <div>
            Touches sent: <b style={{ color: D.heading }}>{seq.touches_sent}</b>
            of {steps.length}
          </div>
          {nextStep && seq.next_touch_at && seq.status === "active" && (
            <div>
              Next: <b style={{ color: D.heading }}>{nextStep.label}</b>on{" "}
              {new Date(seq.next_touch_at).toLocaleString()}
            </div>
          )}
          {seq.status === "autopay_hold" && (
            <div>
              On autopay hold — will release after{" "}
              {data.autopayFailureThreshold} failed attempts (
              {seq.autopay_failures_observed} so far)
            </div>
          )}
          {seq.status === "paused" && seq.paused_reason && (
            <div>Paused: {seq.paused_reason}</div>
          )}
          {seq.status === "stopped" && seq.stopped_reason && (
            <div>Stopped: {seq.stopped_reason}</div>
          )}
          {seq.last_touch_at && (
            <div>
              Last touch: {new Date(seq.last_touch_at).toLocaleString()}
            </div>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {seq && seq.status === "active" && (
          <>
            {" "}
            <button
              disabled={busy}
              onClick={() => {
                const reason = prompt(
                  'Why pause? (e.g. "customer said they\'ll pay Friday")',
                );
                if (reason !== null) act("pause", { reason });
              }}
              style={sBtn(D.amber, D.white, isMobile)}
            >
              Pause
            </button>{" "}
            <button
              disabled={busy}
              onClick={() => {
                if (confirm("Send the next follow-up SMS right now?"))
                  act("send-now");
              }}
              style={sBtn(D.teal, D.white, isMobile)}
            >
              Send Next Now
            </button>{" "}
            <button
              disabled={busy}
              onClick={() => {
                const reason = prompt(
                  'Why stop? (e.g. "waived", "customer disputed")',
                );
                if (reason !== null) act("stop", { reason });
              }}
              style={sBtn("transparent", D.red, isMobile)}
            >
              Stop
            </button>{" "}
          </>
        )}
        {seq && (seq.status === "paused" || seq.status === "autopay_hold") && (
          <>
            {" "}
            <button
              disabled={busy}
              onClick={() => act("resume")}
              style={sBtn(D.green, D.white, isMobile)}
            >
              Resume
            </button>{" "}
            <button
              disabled={busy}
              onClick={() => {
                if (confirm("Send the next follow-up SMS right now?"))
                  act("send-now");
              }}
              style={sBtn(D.teal, D.white, isMobile)}
            >
              Send Now
            </button>{" "}
          </>
        )}
      </div>{" "}
    </div>
  );
}
