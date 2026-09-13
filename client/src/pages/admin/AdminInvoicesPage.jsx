import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogBody,
  DialogTitle,
  Field,
  Input,
  Select,
  Textarea,
  UiSurface,
  buttonStyles,
  cn,
} from "../../components/ui";
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
//   PUT   /admin/invoices/:id           (edit unpaid invoices — draft/
//                                         scheduled/sent/viewed/overdue)
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
import { useSearchParams } from "react-router-dom";
import {
  ExternalLink,
  FileText,
  ListChecks,
  Loader2,
  Paperclip,
  Plus,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { launchTapToPay } from "../../lib/tapToPay";
import { useFeatureFlag } from "../../hooks/useFeatureFlag";
import { computeCardTotal } from "../../lib/cardSurcharge";
import {
  invoiceDateOnly,
  formatInvoiceDate,
  isInvoiceDueDateOverdue,
} from "../../lib/invoiceDates";
import { formatETDate } from "../../lib/timezone";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import DictationButton from "../../components/tech/DictationButton";
import MobileCardOnFileSheet from "../../components/schedule/MobileCardOnFileSheet";
import { getAdminUser } from "../../lib/adminAuth";
const API_BASE = import.meta.env.VITE_API_URL || "/api";
// V2 token pass: teal/blue/purple fold to zinc-900. Semantic green/amber/red preserved.
// STATUS_COLORS folds cleanly — sent/viewed were both #0A7EC2 in V1, stay identical post-fold.

export async function adminFetch(path, options = {}) {
  const r = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  });
  if (!r.ok) {
    let message = `HTTP ${r.status}`;
    let code = null;
    let body = null;
    try {
      const data = await r.clone().json();
      body = data;
      message = data.error || data.message || message;
      // The server's machine-readable code (e.g. DEPOSIT_CREDIT_CHANGED) —
      // callers branch on it.
      if (data.code) code = String(data.code);
    } catch {
      const text = await r.text().catch(() => "");
      if (text) message = text;
    }
    const err = new Error(message);
    err.status = r.status;
    if (code) err.code = code;
    // The refused payload (e.g. BALANCE_CHANGED's authoritative figures) —
    // callers read what the server would actually bill.
    if (body && typeof body === "object") err.body = body;
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
function annualPrepayInvoiceLabel(inv = {}) {
  const status = String(inv.annual_prepay_status || "").toLowerCase();
  if (!status) return null;
  if (status === "payment_pending") return "Annual prepay pending";
  if (status === "active") return "Annual prepay active";
  if (status === "renewal_pending") return "Annual prepay renewal";
  if (status === "cancelled" || status === "canceled")
    return "Annual prepay cancelled";
  if (status === "refunded") return "Annual prepay refunded";
  return `Annual prepay ${status.replace(/_/g, " ")}`;
}
// Icon and accessible name retain their space while the caller is pending.
function AiWriteButton({ loading, disabled, onClick, title }) {
  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      title={title}
      aria-label={title}
      variant={"secondary"}
      onClickCapture={(event) =>
        event.currentTarget.focus({
          preventScroll: true,
        })
      }
      className="ui-icon-action"
    >
      {loading ? (
        <Loader2
          size={20}
          strokeWidth={2.2}
          className="animate-spin motion-reduce:animate-none"
          aria-hidden
        />
      ) : (
        <Sparkles size={20} strokeWidth={2.2} aria-hidden />
      )}
    </Button>
  );
}

// Merge a dictated transcript chunk onto the current field value, inserting a
// space at the seam and clamping to maxLen when the field is length-capped.
function appendDictation(prev, chunk, maxLen) {
  const base = prev || "";
  const sep = base && !/\s$/.test(base) ? " " : "";
  const next = base + sep + chunk;
  return typeof maxLen === "number" ? next.slice(0, maxLen) : next;
}

// Shared palette for in-box DictationButton instances on this page.

const ATTACHMENT_MAX_COUNT = 10;
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const ATTACHMENT_MAX_MB = ATTACHMENT_MAX_BYTES / 1024 / 1024;
const ATTACHMENT_ACCEPT = ".jpg,.jpeg,.png,.gif,.tif,.tiff,.bmp,.pdf";
const ATTACHMENT_ALLOWED_TYPE_LABEL = "JPG, PNG, GIF, TIFF, BMP, and PDF";
export const ATTACHMENT_HELP_TEXT = `Attach up to ${ATTACHMENT_MAX_COUNT} files totaling ${ATTACHMENT_MAX_MB} MB. Supported file types: ${ATTACHMENT_ALLOWED_TYPE_LABEL}.`;
export const ATTACHMENT_VISIBILITY_TEXT =
  "Customers can view these files from the invoice/payment link. They are not sent as separate email attachments.";
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
  const match = String(name)
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/);
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
  return files.reduce(
    (sum, file) =>
      sum +
      Number(file.size || file.file_size_bytes || file.fileSizeBytes || 0),
    0,
  );
}
export function canAddInvoiceAttachments(files = []) {
  return (
    files.length < ATTACHMENT_MAX_COUNT &&
    attachmentTotalBytes(files) < ATTACHMENT_MAX_BYTES
  );
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
  const unsupported = incomingFiles.find(
    (file) => !isAllowedAttachmentFile(file),
  );
  if (unsupported) {
    return `Supported file types: ${ATTACHMENT_ALLOWED_TYPE_LABEL}`;
  }
  return null;
}
async function uploadInvoiceAttachments(invoiceId, files) {
  if (!files.length) return [];
  const fd = new FormData();
  files.forEach((file) => fd.append("attachments", file));
  const result = await adminUpload(
    `/admin/invoices/${invoiceId}/attachments`,
    fd,
  );
  return result.attachments || [];
}
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

// Ledger-backed estimate-deposit credit rides as a negative deposit_credit
// line item (the server rejects hand-supplied ones, so category is reliable).
// Returned as a positive dollar total for the row chip — the only list-view
// trace of deposit money, since deposits are never payments/invoices rows.
// ---- Open-visit link: create-path conflicts and balance confirmation ----
// Every 409 the linked create can refuse with because the VISIT or its
// money moved since the picker loaded. All of them reload the picker while
// keeping the selected visit (Codex P2 #4131): a visit that left the open
// list then renders the gone-state note and blocks Create, instead of the
// stale row staying selected with Create enabled for a 409 on every retry.
export const VISIT_STATE_CONFLICT_CODES = [
  "DEPOSIT_CREDIT_CHANGED",
  "DEPOSIT_CREDIT_UNVERIFIABLE",
  "BALANCE_CHANGED",
  "visit_not_open",
  "visit_link_moved",
  "visit_invoice_refunded",
  "visit_billing_changing",
  "visit_prepaid",
  "visit_billing_unverifiable",
  "visit_already_invoiced",
  "SCHEDULED_PRICE_MOVED",
  // The visit's Bill-To changed between the picker's payer-derived preview
  // and the create (Codex round 14 P2 #4131) — same reload-and-reselect
  // recovery as every other visit-state conflict above, so the picker
  // re-resolves the current payer instead of leaving the stale preview and
  // a disabled retry.
  "PAYER_CHANGED",
];
export function reloadsVisitPickerAfterCreateError(code) {
  return VISIT_STATE_CONFLICT_CODES.includes(String(code || ""));
}
// The selected visit after a picker reload: the fresh row when it is still
// open (its deposit credit may have moved), otherwise the stale selection is
// RETAINED so linkedVisitGone can render — never silently deselected, which
// would let the next Create go out unlinked.
// A picker response is applied only while the customer it was requested
// for is still the selected one (pre-push P1 r3): switching customers with
// a request in flight must not let the old customer's records and visits
// overwrite the new customer's — a cross-customer link the create would
// then refuse (or worse, honor).
export function visitPickerResponseIsCurrent(currentCustomerId, requestedCustomerId) {
  return currentCustomerId != null && String(currentCustomerId) === String(requestedCustomerId);
}

export function reconcileSelectedOpenVisit(selected, visits = []) {
  if (!selected) return null;
  const refreshed = (Array.isArray(visits) ? visits : []).find((v) => v && v.id === selected.id);
  return refreshed || selected;
}
// A linked open-visit invoice is sent now or kept as a draft — never queued
// for a future time (Codex P1 #4131 r2): the completion reuses the linked
// invoice and texts its pay link, and markDeliverySent clears the scheduled
// send, so the chosen time would not be honored anyway.
export function openVisitSendTimingBlocked(sendTiming, selectedOpenVisit) {
  return !!selectedOpenVisit && sendTiming !== "now" && sendTiming !== "draft";
}
// A pre-completion invoice linked to an open visit never carries a review
// ask (Codex P1 #4131 r4): the visit may be days away and the send route
// would enroll the ask after its delay regardless — the server drops it,
// and the form disables the toggle so nothing is silently ignored.
export function openVisitReviewRequestBlocked(selectedOpenVisit) {
  return !!selectedOpenVisit;
}
// The identity of a previewed balance: the visit, the deposit it carries,
// and the billable lines. A server-confirmed balance is honored only while
// the form still matches it — editing a line invalidates the confirmation.
export function openVisitBalanceKey({ selectedOpenVisit, lineItems = [] }) {
  if (!selectedOpenVisit) return null;
  return JSON.stringify({
    visit: selectedOpenVisit.id,
    deposit: Math.max(0, Number(selectedOpenVisit.deposit_credit) || 0),
    lines: (lineItems || []).map((i) => [i.description, Number(i.quantity), Number(i.unit_price), i.discount_id || null, i._kind || null]),
  });
}
// The server's BALANCE_CHANGED payload as a confirmation the form can show
// and re-submit (null for any other error, or one with no usable figure).
export function confirmedBalanceFromError(err, key) {
  if (!err || err.code !== "BALANCE_CHANGED" || !key) return null;
  const b = err.body || {};
  const balanceDue = Number(b.balanceDue);
  if (!Number.isFinite(balanceDue) || balanceDue < 0) return null;
  return {
    key,
    balanceDue: Math.round(balanceDue * 100) / 100,
    invoiceTotal: Number.isFinite(Number(b.invoiceTotal)) ? Number(b.invoiceTotal) : null,
    appliedDepositCredit: Number.isFinite(Number(b.appliedDepositCredit)) ? Number(b.appliedDepositCredit) : null,
  };
}
// What the linked create sends for the server to check before anything is
// created: the pending deposit the summary previewed (DEPOSIT_CREDIT_CHANGED
// when it moved) and the balance the operator approved — the server-
// confirmed one when the form still matches it, else the local preview
// (BALANCE_CHANGED when the authoritative total differs).
export function openVisitCreateExpectations({ selectedOpenVisit, balanceDue, confirmedBalance, balanceKey }) {
  if (!selectedOpenVisit) return {};
  const confirmed = confirmedBalance && balanceKey && confirmedBalance.key === balanceKey ? confirmedBalance : null;
  return {
    expectedDepositCredit: Math.max(0, Number(selectedOpenVisit.deposit_credit) || 0),
    expectedBalanceDue: Math.round((confirmed ? confirmed.balanceDue : Math.max(0, Number(balanceDue) || 0)) * 100) / 100,
  };
}

// The selected open visit left the open list on a reload (completed or
// prepaid since). It stays selected so the picker renders the gone state
// and Create is blocked — never silently dropped into an unlinked create.
export function isLinkedVisitGone(selectedOpenVisit, openVisits = []) {
  return !!selectedOpenVisit && !openVisits.some((v) => v.id === selectedOpenVisit.id);
}
// The linked visit's previewed credit (its pending estimate deposit, capped
// at the form total like the server caps it) and the balance after it.
export function previewLinkedBalance({ selectedOpenVisit, total }) {
  const depositCredit = Math.min(total, Math.max(0, Number(selectedOpenVisit?.deposit_credit) || 0));
  return { depositCredit, previewBalanceDue: Math.max(0, Math.round((total - depositCredit) * 100) / 100) };
}
// The balance the summary shows and the create sends: the server-confirmed
// one (BALANCE_CHANGED) while the form still matches the state it was
// computed for, else the local preview.
export function resolveLinkedBalance({ confirmedBalance, balanceKey, previewBalanceDue }) {
  const serverBalance = confirmedBalance && balanceKey && confirmedBalance.key === balanceKey ? confirmedBalance : null;
  return { serverBalance, balanceDue: serverBalance ? serverBalance.balanceDue : previewBalanceDue };
}
// Create-step 1 — the pre-submit validation, as the toast that blocks it
// (null = proceed). One place for every "cannot create yet" rule.
export function createInvoiceBlocker({
  selectedCustomer, lineItems, serviceDate, dueDate, sendTiming, scheduledFor, requestReview, reviewDelay, linkedVisitGone, selectedOpenVisit,
}) {
  if (!selectedCustomer) return "Select a customer";
  if (!lineItems.some((i) => i._kind !== "discount" && i.description && i.unit_price > 0)) return "Add at least one line item";
  if (!serviceDate) return "Choose a service date";
  if (!dueDate) return "Choose a due date";
  if (sendTiming === "custom" && !scheduledFor) return "Choose an invoice send time";
  // The review ask is validated on the same effective value the form
  // renders (Codex P2 r6 #4131): a linked open visit blocks the ask, so a
  // still-true underlying state must not demand a review time the operator
  // cannot see or set.
  const reviewAsk = requestReview && !openVisitReviewRequestBlocked(selectedOpenVisit);
  if (sendTiming !== "draft" && reviewAsk && reviewDelay === null) return "Choose a review request time";
  if (linkedVisitGone) return "The linked visit is no longer open (completed or prepaid since) — re-check the visit link before creating.";
  if (openVisitSendTimingBlocked(sendTiming, selectedOpenVisit)) {
    return "An invoice linked to an open visit is sent now or saved as a draft — the completion sends it, so a future send time would not be kept.";
  }
  return null;
}

export function invoiceDepositCreditTotal(lineItems) {
  if (!Array.isArray(lineItems)) return 0;
  return lineItems
    .filter((li) => li && li.category === "deposit_credit")
    .reduce((sum, li) => sum + Math.abs(Number(li.amount) || 0), 0);
}

// Create-path send toast. /admin/invoices/:id/send returns per-channel
// results ({ sms: { ok }, email: { ok, recipient } }) and 200 when EITHER
// channel succeeded — a flat "created & sent" toast hides a half-failed
// send (SendInvoiceModal already reads the channels; the create path must
// too). Exported for tests.
export function invoiceCreatedSendToast(invoiceNumber, res) {
  // Account credit fully covered the invoice at send time: sendViaSMSAndEmail
  // returns ok:true with covered_by_credit and BOTH channels not-ok — that is
  // a success (the invoice is prepaid, nothing to deliver), not a failed send.
  if (res?.covered_by_credit) {
    return `Invoice created: ${invoiceNumber} — fully covered by account credit, nothing to send`;
  }
  // The linked visit's completion delivered it first: a no-op, not a failure.
  if (res?.already_delivered) {
    return `Invoice created: ${invoiceNumber} — already delivered by the visit's completion, not sent again`;
  }
  // …or queued it for the send window (quiet hours): the text is live and
  // delivers at 8 AM — also a no-op, never a Resend prompt (Codex P2 r8).
  if (res?.queued_delivery) {
    return `Invoice created: ${invoiceNumber} — the visit's completion already queued the text for the send window, not sent again`;
  }
  const sent = [
    res?.sms?.ok && "SMS",
    res?.email?.ok &&
      (res.email.recipient?.email
        ? `email to ${res.email.recipient.email}`
        : "email"),
  ].filter(Boolean);
  const failed = [
    res?.sms && !res.sms.ok && "SMS",
    res?.email && !res.email.ok && "email",
  ].filter(Boolean);
  if (!sent.length) {
    return `Invoice created but not sent: ${invoiceNumber} — use Resend on the invoice`;
  }
  return failed.length
    ? `Invoice created: ${invoiceNumber} — sent via ${sent.join(" + ")}; ${failed.join(" + ")} failed`
    : `Invoice created & sent: ${invoiceNumber} (${sent.join(" + ")})`;
}

// After an AMBIGUOUS send/schedule failure (the request threw, but the
// server may have committed and delivered before the response was lost),
// classify the re-fetched persisted row: only a still-draft row is provably
// unsent — anything else must NOT be offered an automatic resend (duplicate
// customer comms). null/unfetchable → "unknown" (fail closed). Exported for
// tests.
export function persistedSendDisposition(persisted) {
  const status = String(persisted?.status || "").toLowerCase();
  if (!status) return "unknown";
  // Draft alone is NOT proof of non-delivery: a provider-success /
  // bookkeeping-failure send (SMS or email leg) can leave the row draft
  // after the message was accepted. Delivery stamps (sent_at, sms_sent_at,
  // email_sent_at) are only ever written after provider success, so a draft
  // row carrying any of them must not be offered Resend.
  if (
    status === "draft" &&
    (persisted?.sent_at || persisted?.sms_sent_at || persisted?.email_sent_at)
  ) {
    return "unknown";
  }
  if (status === "draft") return "unsent";
  // Only states that MEAN delivered count as committed. Everything else —
  // 'sending' (live claim that can still fail back to draft), 'scheduled'
  // (a failed Send-now can restore the prior schedule), 'void',
  // 'processing' — is not delivery evidence: block the automatic resend
  // without claiming the send went through.
  const DELIVERED_STATUSES = ["sent", "viewed", "overdue", "paid", "prepaid"];
  return DELIVERED_STATUSES.includes(status) ? "committed" : "unknown";
}

// Toast for a send/schedule request that failed AFTER the invoice row was
// persisted. The builder must still close (onCreated) — leaving the form
// intact invites a second Create click that duplicates the invoice.
// Exported for tests.
export function invoiceCreatedSendFailedToast(
  invoiceNumber,
  action,
  err,
  recovery = "Use Resend on the invoice.",
) {
  const label = invoiceNumber ? `Invoice ${invoiceNumber}` : "Invoice";
  return `${label} created but not ${action} — ${err?.message || "send failed"}. ${recovery}`;
}
export function buildInvoiceListParams({
  limit = 100,
  pageNo = 1,
  sort = "newest",
  filter = "all",
  query = "",
  datePeriod = "all",
  customerFilterId = "",
} = {}) {
  const params = new URLSearchParams({
    limit: String(limit),
    page: String(pageNo),
    sort,
  });
  if (filter === "archived") params.set("archived", "only");
  else if (filter !== "all") params.set("status", filter);
  const term = query.trim();
  if (term) params.set("search", term);
  if (customerFilterId) params.set("customerId", customerFilterId);
  const start = datePeriodStart(datePeriod);
  if (start) params.set("from", formatDateParam(start));
  return params;
}

// The "Link to visit" panel of the create form: completed records and open
// visits, the gone-state of a selected visit that left the open list, and
// the linked-visit notes. Renders nothing when there is nothing to link.
// Tier 1 (components/ui + Tailwind) — mirrors the Service History card this
// panel replaces.
function VisitLinkPanel({
  serviceRecords, openVisits, selectedService, selectedOpenVisit, linkedVisitGone, sectionHeader, onPick, disabled,
}) {
  if (serviceRecords.length === 0 && openVisits.length === 0 && !linkedVisitGone) return null;
  const value = selectedOpenVisit ? `visit:${selectedOpenVisit.id}` : selectedService ? `record:${selectedService.id}` : "";
  const dateLabel = (d) => new Date(d + "T12:00:00").toLocaleDateString();
  return (
    <Card className="p-4">
      {sectionHeader("Link to visit")}
      <Field className="min-w-0" label="Link a visit">
        <Select
          value={value}
          onChange={(e) => {
            const [kind, id] = String(e.target.value).split(":");
            onPick({
              record: kind === "record" ? serviceRecords.find((r) => r.id === id) || null : null,
              visit: kind === "visit" ? openVisits.find((v) => v.id === id) || null : null,
            });
          }}
          disabled={disabled}
        >
          <option value="">No visit linked</option>
          {linkedVisitGone && (
            <option value={`visit:${selectedOpenVisit.id}`} disabled>
              {selectedOpenVisit.service_type} -- {dateLabel(selectedOpenVisit.scheduled_date)} -- no longer open
            </option>
          )}
          {openVisits.length > 0 && (
            <optgroup label="Open visits (not yet completed)">
              {openVisits.map((v) => (
                <option key={v.id} value={`visit:${v.id}`}>
                  {v.service_type} -- {dateLabel(v.scheduled_date)} -- {String(v.status || "scheduled").replace("_", " ")}
                </option>
              ))}
            </optgroup>
          )}
          {serviceRecords.length > 0 && (
            <optgroup label="Completed visits">
              {serviceRecords.map((r) => (
                <option key={r.id} value={`record:${r.id}`}>
                  {r.service_type} -- {dateLabel(r.service_date)} -- {r.tech_name || "Unknown tech"}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </Field>
      {selectedOpenVisit && !linkedVisitGone && (
        <div className="mt-2 text-ui-body text-ink-secondary">
          Linked to the open visit — when it is completed, this invoice is reused instead of a new one being created. It is sent now or kept as a draft (no future send time — the completion would send it first).
        </div>
      )}
      {linkedVisitGone && (
        <div className="mt-2 text-ui-body text-zinc-900">
          This visit is no longer open — it was completed or prepaid since you picked it. Check the customer's invoices before creating another; pick a visit above to continue.
        </div>
      )}
    </Card>
  );
}

// The summary's balance rows for a linked open visit: the previewed deposit
// credit and balance, or — after a BALANCE_CHANGED refusal — the server's
// authoritative figures the next Create will send.
function LinkedBalanceSummary({ depositCredit, balanceDue, serverBalance, rowStyle, labelStyle, amountStyle }) {
  if (serverBalance) {
    return (
      <>
        {serverBalance.invoiceTotal != null && (
          <div style={{ ...rowStyle(), marginTop: 6 }}>
            <span style={labelStyle}>Total on file (tax / exemption as billed by the server)</span>
            <span style={amountStyle}>${serverBalance.invoiceTotal.toFixed(2)}</span>
          </div>
        )}
        {serverBalance.appliedDepositCredit > 0 && (
          <div style={{ ...rowStyle(), marginTop: 4 }}>
            <span style={labelStyle}>Deposit credit (paid at acceptance) — applied automatically</span>
            <span style={amountStyle}>-${serverBalance.appliedDepositCredit.toFixed(2)}</span>
          </div>
        )}
        <div style={{ ...rowStyle(16, 700), marginTop: 4 }}>
          <span style={labelStyle}>Balance due — as the customer will be billed</span>
          <span style={amountStyle}>${balanceDue.toFixed(2)}</span>
        </div>
        <div className="mt-1 text-ui-caption text-ink-secondary">
          The server's tax or exemption on file changed the balance from the preview above. Click Create again to send this balance.
        </div>
      </>
    );
  }
  if (!(depositCredit > 0)) return null;
  return (
    <>
      <div style={{ ...rowStyle(), marginTop: 6 }}>
        <span style={labelStyle}>Deposit credit (paid at acceptance) — applied automatically</span>
        <span style={amountStyle}>-${depositCredit.toFixed(2)}</span>
      </div>
      <div style={{ ...rowStyle(16, 700), marginTop: 4 }}>
        <span style={labelStyle}>Balance due</span>
        <span style={amountStyle}>${balanceDue.toFixed(2)}</span>
      </div>
    </>
  );
}

export default function AdminInvoicesPage() {
  const [tab, setTab] = useState("list");
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState(false);
  const [builderPending, setBuilderPending] = useState(false);
  const statsRequestRef = useRef(0);
  const [toast, setToast] = useState("");
  const [toastTone, setToastTone] = useState("ok");
  const [editInvoice, setEditInvoice] = useState(null);
  // Set when an already-delivered invoice was just edited: the list view
  // opens the resend modal for this id so the customer gets the new version.
  const [promptResendId, setPromptResendId] = useState(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  // Bumped when something outside InvoiceList settles an invoice (the Zelle
  // notice card) so the list refetches instead of showing it still open.
  const [listRefreshKey, setListRefreshKey] = useState(0);
  const loadStats = useCallback(async () => {
    const request = ++statsRequestRef.current;
    setStatsLoading(true);
    setStatsError(false);
    setStats(null);
    const s = await adminFetch("/admin/invoices/stats").catch(() => null);
    if (request !== statsRequestRef.current) return;
    setStats(s);
    setStatsError(!s);
    setStatsLoading(false);
  }, []);
  useEffect(() => {
    loadStats();
  }, [loadStats]);
  // tone "ok" | "error": a failure is announced as one (prefix, colour, a
  // longer dwell) instead of behind a green "OK".
  const toastTimerRef = useRef(null);
  const showToast = (msg, tone = "ok") => {
    setToast(msg);
    setToastTone(tone);
    // One timer at a time — an older toast's timer never clears a newer one.
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(
      () => setToast(""),
      tone === "error" ? 8000 : 3500,
    );
  };
  useEffect(() => () => clearTimeout(toastTimerRef.current), []);
  return (
    <UiSurface
      density="comfortable"
      className="mx-auto max-w-[1300px] text-ui-body text-zinc-900 u-nums"
    >
      {" "}
      <AdminCommandHeader
        title="Invoices"
        icon={FileText}
        action={{
          label: tab === "create" ? "Invoice list" : "Create invoice",
          icon: tab === "create" ? ListChecks : Plus,
          variant: tab === "create" ? "secondary" : "primary",
          disabled: builderPending,
          onClick: () => {
            if (builderPending) return;
            if (tab === "create") {
              setEditInvoice(null);
              setTab("list");
            } else {
              setTab("create");
            }
          },
        }}
        variant="workspace"
      />
      {tab === "list" && (statsLoading || statsError) && (
        <ActionFeedback
          error={statsError}
          onRetry={statsError ? loadStats : undefined}
          className="mb-5 min-h-11"
        >
          {statsError
            ? "Invoice totals could not be loaded."
            : "Loading invoice totals…"}
        </ActionFeedback>
      )}
      {tab === "list" && (
        <ZelleNoticesCard
          showToast={showToast}
          onRefresh={() => {
            loadStats();
            setListRefreshKey((k) => k + 1);
          }}
          isMobile={isMobile}
        />
      )}
      {tab === "list" && (
        <InvoiceList
          showToast={showToast}
          onRefresh={loadStats}
          refreshKey={listRefreshKey}
          onEdit={(inv) => {
            setEditInvoice(inv);
            setTab("create");
          }}
          isMobile={isMobile}
          stats={stats}
          promptResendId={promptResendId}
          onPromptResendHandled={() => setPromptResendId(null)}
        />
      )}
      {tab === "create" && (
        <CreateInvoice
          showToast={showToast}
          editInvoice={editInvoice}
          onPendingChange={setBuilderPending}
          onCreated={(opts) => {
            loadStats();
            setEditInvoice(null);
            setTab("list");
            setPromptResendId(opts?.promptResendId || null);
          }}
          isMobile={isMobile}
          key={editInvoice?.id || "new-invoice"}
        />
      )}
      <div
        className="fixed right-4 left-4 sm:left-auto sm:max-w-xl z-[500]"
        style={{
          top: isMobile
            ? "calc(64px + env(safe-area-inset-top, 0px))"
            : undefined,
          bottom: isMobile ? undefined : 20,
        }}
      >
        {toast && (
          <ActionFeedback
            error={toastTone === "error"}
            className="bg-white border-hairline border-zinc-300 rounded-md p-4"
          >
            {toast}
          </ActionFeedback>
        )}
      </div>{" "}
    </UiSurface>
  );
}

// ── Zelle payments to review (GATE_ZELLE_NOTICE_RECONCILE lane) ──
// The park queue for Capital One Zelle notices the reconciler could not
// settle on its own: one row per notice — payer · amount · memo · reason —
// with the invoice candidates it found. Apply settles the chosen invoice
// through the same Zelle + receipt path the reconciler uses (server
// re-validates the choice); Ignore closes the notice. Hidden when nothing is
// parked, so the list is untouched on an ordinary day.
const NOTICE_REASON_LABELS = {
  no_match: "No open invoice for this amount",
  multiple_matches: "Several invoices match",
  name_mismatch: "Amount matches, name does not",
  possible_duplicate: "Possibly already recorded",
  sender_unverified: "Sender could not be verified",
  parse_failed: "Notice could not be read",
  apply_failed: "Recording failed",
  stale_notice: "Over 48 hours old when first processed",
};
// Red only for the two reasons that are genuine alerts (a spoof or a failed
// settlement) — everything else is an ordinary review item.
const NOTICE_ALERT_REASONS = new Set(["apply_failed", "sender_unverified"]);

// Dropdown order: exact-amount + name match first, then exact amount, then
// the near-amount leads; stable within each band. Exported for the vitest.
export function orderNoticeCandidates(candidates = []) {
  const rank = (c) =>
    c.exact_amount && c.name_match
      ? 0
      : c.exact_amount
        ? 1
        : c.name_match
          ? 2
          : 3;
  return (Array.isArray(candidates) ? candidates : [])
    .map((c, i) => ({
      c,
      i,
    }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map(({ c }) => c);
}
export function noticeCandidateLabel(c = {}) {
  const due = Number.isFinite(Number(c.amount_due_cents))
    ? `$${(Number(c.amount_due_cents) / 100).toFixed(2)}`
    : "";
  const flags = [c.exact_amount && "exact amount", c.name_match && "name match"]
    .filter(Boolean)
    .join(", ");
  return `${c.invoice_number || c.invoice_id} · ${c.customer_name || "—"} · ${due}${flags ? ` (${flags})` : ""}`;
}
function noticeAmount(n) {
  return n?.amount_cents == null
    ? "—"
    : `$${(n.amount_cents / 100).toFixed(2)}`;
}
function ZelleNoticesCard({ showToast, onRefresh, isMobile }) {
  const busyRef = useRef(false);
  const [notices, setNotices] = useState([]);
  const [choice, setChoice] = useState({});
  // id of the notice whose Apply/Ignore is in flight; every row's controls
  // lock while one is pending so a second action cannot re-enable the first
  // row mid-flight or race its reload.
  const [busy, setBusy] = useState(null);
  const pending = busy !== null;
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const data = await adminFetch(
        "/admin/invoices/payment-notices?status=parked&limit=100",
      );
      setNotices(Array.isArray(data?.notices) ? data.notices : []);
      setError("");
    } catch (err) {
      // 404 = the lane's routes are not deployed yet; stay hidden quietly.
      if (err?.status !== 404)
        setError(err.message || "Could not load Zelle notices");
      setNotices([]);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  if (!notices.length && !error) return null;
  const apply = async (n) => {
    if (busyRef.current) return;
    const ordered = orderNoticeCandidates(n.candidates);
    const invoiceId = choice[n.id] || ordered[0]?.invoice_id;
    if (!invoiceId) return;
    const picked = ordered.find((c) => c.invoice_id === invoiceId);
    // The apply route only settles an exact-cent match; near-amount leads are
    // dropdown context, recorded from the invoice itself.
    if (!picked?.exact_amount || pending) return;
    const label = picked.invoice_number;
    if (
      !window.confirm(
        `Mark ${label} paid via Zelle (${noticeAmount(n)} from ${n.payer_name || "unknown payer"}) and send the receipt (email + SMS)?`,
      )
    )
      return;
    busyRef.current = true;
    setBusy({ id: n.id, action: "apply" });
    try {
      const res = await adminFetch(
        `/admin/invoices/payment-notices/${encodeURIComponent(n.id)}/apply`,
        {
          method: "POST",
          body: JSON.stringify({
            invoiceId,
          }),
        },
      );
      // receipt: { email, sms } from the send, or null when the invoice
      // settled but a later step threw (server closes the notice as applied
      // and cannot say whether the receipt went out).
      const legs = [
        res?.receipt?.email?.ok && "email",
        res?.receipt?.sms?.ok && "SMS",
      ]
        .filter(Boolean)
        .join(" + ");
      const receiptNote =
        res?.receipt == null
          ? " — receipt unknown, check the invoice"
          : legs
            ? ` — receipt sent (${legs})`
            : " — receipt not delivered";
      showToast(`${label} marked paid via Zelle${receiptNote}`);
      await load();
      onRefresh?.();
    } catch (err) {
      showToast(err.message || "Could not apply the Zelle payment", "error");
      // The server may have re-parked the notice as apply_failed, another
      // operator may have resolved it, or the settlement may have committed
      // before the response was lost — show the authoritative state of the
      // queue AND the invoice list/stats (harmless on an ordinary refusal).
      await load();
      onRefresh?.();
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };
  const ignore = async (n) => {
    if (busyRef.current) return;
    if (pending) return;
    if (
      !window.confirm(
        `Ignore this Zelle notice (${noticeAmount(n)} from ${n.payer_name || "unknown payer"})? It will not be recorded.`,
      )
    )
      return;
    busyRef.current = true;
    setBusy({ id: n.id, action: "ignore" });
    try {
      await adminFetch(
        `/admin/invoices/payment-notices/${encodeURIComponent(n.id)}/ignore`,
        {
          method: "POST",
        },
      );
      showToast("Zelle notice ignored");
      await load();
    } catch (err) {
      showToast(err.message || "Could not ignore the notice", "error");
      // Same as Apply: the server may have closed it before the response was
      // lost, or another operator may have resolved it — show its state.
      await load();
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };
  return (
    <Card
      style={{
        borderColor: "#52525B",
      }}
      data-testid="zelle-notices-card"
      className="p-4 mb-5"
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <div className="text-ui-field font-medium text-zinc-900">
          Zelle payments to review{notices.length ? ` (${notices.length})` : ""}
        </div>
        <div className="text-ui-body text-ink-secondary">
          Capital One notices the portal could not match to one invoice on its
          own.
        </div>
      </div>
      {error && (
        <div
          style={{
            marginBottom: 10,
          }}
          className="text-ui-body text-alert-fg"
        >
          {error}
        </div>
      )}
      {notices.map((n) => {
        const ordered = orderNoticeCandidates(n.candidates);
        const selected = choice[n.id] || ordered[0]?.invoice_id || "";
        const selectedExact = Boolean(
          ordered.find((c) => c.invoice_id === selected)?.exact_amount,
        );
        const alert = NOTICE_ALERT_REASONS.has(n.park_reason);
        return (
          <div
            key={n.id}
            style={{
              display: "grid",
              gridTemplateColumns: isMobile
                ? "1fr"
                : "minmax(0, 1.4fr) minmax(0, 1.6fr) auto",
              gap: 12,
              alignItems: "center",
              padding: "12px 0",
              borderTop: "1px solid #E4E4E7",
            }}
          >
            <div
              style={{
                minWidth: 0,
              }}
            >
              <div className="text-ui-body font-medium text-zinc-900">
                {n.payer_name || "Unknown payer"} · {noticeAmount(n)}
              </div>
              <div
                style={{
                  marginTop: 2,
                  overflowWrap: "anywhere",
                }}
                className="text-ui-body text-ink-secondary"
              >
                {n.memo ? `Memo: ${n.memo}` : "No memo"}
                {n.received_at
                  ? ` · ${formatETDate(n.received_at, {
                      month: "short",
                      day: "numeric",
                    })}`
                  : ""}
              </div>
              <div
                style={{
                  marginTop: 6,
                }}
              >
                <Badge
                  className="max-w-full whitespace-normal"
                  tone={alert ? "alert" : "neutral"}
                >
                  {NOTICE_REASON_LABELS[n.park_reason] ||
                    n.park_reason ||
                    "Needs review"}
                </Badge>
                {n.apply_error && (
                  <span
                    style={{
                      marginLeft: 8,
                    }}
                    className="text-ui-body text-alert-fg"
                  >
                    {n.apply_error}
                  </span>
                )}
              </div>
            </div>
            <div
              style={{
                minWidth: 0,
              }}
            >
              {ordered.length ? (
                <Field
                  className="min-w-0"
                  label={`Invoice for ${n.payer_name || "payer"} ${noticeAmount(n)}`}
                >
                  <Select
                    aria-label={`Invoice for ${n.payer_name || "payer"} ${noticeAmount(n)}`}
                    value={selected}
                    onChange={(e) =>
                      setChoice((prev) => ({
                        ...prev,
                        [n.id]: e.target.value,
                      }))
                    }
                    disabled={pending}
                  >
                    {ordered.map((c) => (
                      <option key={c.invoice_id} value={c.invoice_id}>
                        {noticeCandidateLabel(c)}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <div className="text-ui-body text-ink-secondary">
                  No candidate invoices — record it from the invoice if it
                  exists, or ignore.
                </div>
              )}
              {ordered.length > 0 && !selectedExact && (
                <div
                  style={{
                    marginTop: 4,
                  }}
                  className="text-ui-body text-ink-secondary"
                >
                  Near-amount lead — record the payment from that invoice, then
                  ignore this notice.
                </div>
              )}
            </div>
            <div
              style={{
                display: "flex",
                gap: 8,
                justifyContent: isMobile ? "stretch" : "flex-end",
              }}
            >
              <Button
                type="button"
                style={{
                  flex: isMobile ? 1 : undefined,
                }}
                disabled={!selectedExact || pending}
                onClick={() => apply(n)}
                variant="secondary"
                loading={busy?.id === n.id && busy.action === "apply"}
                onClickCapture={(event) =>
                  event.currentTarget.focus({
                    preventScroll: true,
                  })
                }
                className="min-w-11"
              >
                Apply &amp; send receipt
              </Button>
              <Button
                type="button"
                style={{
                  flex: isMobile ? 1 : undefined,
                }}
                disabled={pending}
                onClick={() => ignore(n)}
                loading={busy?.id === n.id && busy.action === "ignore"}
                variant={"secondary"}
                onClickCapture={(event) =>
                  event.currentTarget.focus({
                    preventScroll: true,
                  })
                }
                className="min-w-11"
              >
                Ignore
              </Button>
            </div>
          </div>
        );
      })}
    </Card>
  );
}

// ── Filter pill with dropdown ──
function InvoiceFilter({ label, value, options, onChange, disabled }) {
  return (
    <Field label={label} className="min-w-[140px] flex-1">
      <Select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      >
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

// ── Invoice List (mirrors attached UI) ──
function InvoiceList({
  showToast,
  onRefresh,
  refreshKey = 0,
  onEdit,
  isMobile,
  stats,
  promptResendId,
  onPromptResendHandled,
}) {
  const rowActionBusyRef = useRef(false);
  const reversingIdRef = useRef(false);
  const cancellingPlanInvoiceIdRef = useRef(false);
  const batchSendingRef = useRef(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const customerFilterId =
    searchParams.get("customer") || searchParams.get("customerId") || "";
  // POST /admin/invoices/:id/charge-card is requireAdmin on the server
  // (off-session saved-card charges are admin-only); the charge action only
  // renders for admin-role users, failing closed on missing/unknown role.
  // The "card on file" info badge stays visible to all staff.
  const isAdminUser = getAdminUser()?.role === "admin";
  const PAGE_SIZE = 100;
  const [invoices, setInvoices] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState("all");
  const [datePeriod, setDatePeriod] = useState("all");
  const [sort, setSort] = useState("newest");
  const [query, setQuery] = useState("");
  // The list fetch follows the search box by 300 ms (the customer search in
  // CreateInvoice already does) and only the newest response paints, so fast
  // typing no longer flickers to an earlier query's rows. A failed load says
  // so instead of reading as "No invoices match".
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [deepLinkError, setDeepLinkError] = useState("");
  const [deepLinkAttempt, setDeepLinkAttempt] = useState(0);
  const listReqIdRef = useRef(0);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);
  const [expanded, setExpanded] = useState(null);
  // A deep-linked invoice fetched ahead of its page lives OUTSIDE the
  // paginated collection (Codex PR r9 P2): merging it into `invoices`
  // inflated the length and hid Load More before the real pages were
  // exhausted. Rendered rows merge it; pagination math never sees it.
  const [deepLinkedInvoice, setDeepLinkedInvoice] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [batchSending, setBatchSending] = useState(false);
  const [sendModalInvoice, setSendModalInvoice] = useState(null);
  const [receiptModalInvoice, setReceiptModalInvoice] = useState(null);
  const [paymentModalInvoice, setPaymentModalInvoice] = useState(null);
  const [paymentPlanModalInvoice, setPaymentPlanModalInvoice] = useState(null);
  const [cancellingPlanInvoiceId, setCancellingPlanInvoiceId] = useState(null);
  // Reverse prepaid moves money, so it carries its own latch: the shared
  // rowActionBusy scalar can be overwritten and cleared by a sibling
  // action mid-flight, which would re-enable the button early.
  const [reversingId, setReversingId] = useState(null);
  const [annualPrepayModalInvoice, setAnnualPrepayModalInvoice] =
    useState(null);
  const [applyCreditInvoice, setApplyCreditInvoice] = useState(null);
  const [cardOnFileInvoice, setCardOnFileInvoice] = useState(null);
  const sendReceiptEnabled = useFeatureFlag("ff_invoice_send_receipt", true);
  const load = useCallback(
    async ({ append = false, pageNo = 1 } = {}) => {
      const params = buildInvoiceListParams({
        limit: PAGE_SIZE,
        pageNo,
        sort,
        filter,
        query: debouncedQuery,
        datePeriod,
        customerFilterId,
      });

      // Only a replacement load takes a new id; an append rides on the
      // current one, so it can never invalidate a filter/sort/date reload
      // and is itself discarded if such a reload started meanwhile.
      const reqId = append ? listReqIdRef.current : ++listReqIdRef.current;
      setMoreError(false);
      if (!append) {
        setListLoading(true);
        setListError(false);
      }
      const data = await adminFetch(`/admin/invoices?${params}`).catch(
        () => null,
      );
      // A newer request has been issued since — let it paint instead.
      if (reqId !== listReqIdRef.current) return;
      if (!append) setListLoading(false);
      if (!data) {
        if (!append) {
          setListError(true);
          setInvoices([]);
          setTotal(0);
          setSelected(new Set());
        } else {
          setMoreError(true);
        }
        return;
      }
      const rows = data.invoices || [];
      // Dedupe by id: a deep-linked invoice fetched ahead of its page
      // (?invoice=) must not appear twice once pagination reaches it
      // (Codex PR r6 P2 — duplicate keys, doubled expanded rows).
      setInvoices((prev) =>
        append
          ? [
              ...prev,
              ...rows.filter(
                (r) => !prev.some((p) => String(p.id) === String(r.id)),
              ),
            ]
          : rows,
      );
      setTotal(Number(data.total ?? rows.length) || 0);
      setPage(Number(data.page || pageNo));
      if (!append) {
        setSelected(new Set());
      }
    },
    [PAGE_SIZE, customerFilterId, datePeriod, debouncedQuery, filter, sort],
  );
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // Keep expanded invoice detail in the URL so notification links, mobile
  // back navigation, and refresh all restore the same row. A deep-linked
  // invoice outside the loaded page (an old stale draft the dashboard
  // alert targets) is fetched by id and prepended, so the link always
  // lands ON the row instead of a generic list (Codex PR r5 P2).
  useEffect(() => {
    const invoiceId = searchParams.get("invoice");
    setDeepLinkError("");
    if (!invoiceId) {
      setExpanded(null);
      setDeepLinkedInvoice(null);
      return;
    }
    const match = invoices.find((inv) => String(inv.id) === String(invoiceId));
    if (match) {
      setExpanded(match.id);
      // The separately fetched row is only for OUT-OF-PAGE targets —
      // clear a stale one so it stops rendering outside the active
      // filters (Codex PR r10 P2).
      setDeepLinkedInvoice((prev) =>
        prev && String(prev.id) !== String(invoiceId) ? null : prev,
      );
      return;
    }
    setDeepLinkedInvoice((prev) =>
      prev && String(prev.id) !== String(invoiceId) ? null : prev,
    );
    let cancelled = false;
    adminFetch(`/admin/invoices/${encodeURIComponent(invoiceId)}`)
      .then((row) => {
        if (cancelled || !row?.id) return;
        // getById nests customer fields — flatten to the list-row shape
        // so the deep-linked row renders name/contact like every other
        // row (Codex PR r11 P2).
        const flat = {
          ...row,
          first_name: row.first_name ?? row.customer?.first_name ?? null,
          last_name: row.last_name ?? row.customer?.last_name ?? null,
          phone: row.phone ?? row.customer?.phone ?? null,
          email: row.email ?? row.customer?.email ?? null,
          card_on_file: row.card_on_file ?? row.customer?.card_on_file ?? null,
        };
        setDeepLinkedInvoice(flat);
        setExpanded(row.id);
      })
      .catch((error) => {
        if (cancelled) return;
        setExpanded(null);
        setDeepLinkError(`Could not load the linked invoice: ${error.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [invoices, searchParams, deepLinkAttempt]);
  const toggleExpanded = (invoiceId) => {
    const isOpen = String(expanded) === String(invoiceId);
    const next = new URLSearchParams(searchParams);
    if (isOpen) next.delete("invoice");
    else next.set("invoice", String(invoiceId));
    setSearchParams(next, {
      replace: isOpen,
    });
    // The URL effect owns expansion, including deferred route updates and Back.
  };
  const clearCustomerFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("customer");
    next.delete("customerId");
    setSearchParams(next, {
      replace: true,
    });
  };
  const handleSend = (invoice) => {
    setSendModalInvoice(invoice);
  };

  // After an already-delivered invoice was edited, open the resend modal for
  // it so the customer gets the updated version. Fetched by id (not from the
  // list rows) so the modal shows the fresh totals even when the invoice is
  // outside the current page/filter. If that refresh fails, fall back to the
  // freshly reloaded list row so the promised modal still opens; only when
  // neither is available does the prompt surface as a toast pointing at the
  // row's own Resend button — never silently dropped.
  useEffect(() => {
    if (!promptResendId) return;
    let alive = true;
    (async () => {
      const inv = await adminFetch(`/admin/invoices/${promptResendId}`).catch(
        () => null,
      );
      if (!alive) return;
      if (inv) {
        onPromptResendHandled?.();
        setSendModalInvoice(inv);
        return;
      }
      const fromList = invoices.find(
        (i) => String(i.id) === String(promptResendId),
      );
      if (fromList) {
        onPromptResendHandled?.();
        setSendModalInvoice(fromList);
        return;
      }
      onPromptResendHandled?.();
      showToast(
        "Couldn't open the resend dialog — use Resend on the invoice so the customer gets the updated version",
      );
    })();
    return () => {
      alive = false;
    };
  }, [promptResendId, onPromptResendHandled, invoices, showToast]);

  // Per-row busy id for void/archive/unarchive: without it a failed request
  // was an unhandled rejection (no toast, no refresh) and the button stayed
  // clickable mid-flight (double-fire).
  const [rowActionBusy, setRowActionBusy] = useState(null);
  const handleVoid = async (id) => {
    if (rowActionBusyRef.current) return;
    if (!confirm("Void this invoice?")) return;
    rowActionBusyRef.current = true;
    setRowActionBusy(id);
    try {
      await adminFetch(`/admin/invoices/${id}/void`, {
        method: "POST",
      });
      showToast("Invoice voided");
      load();
      onRefresh();
    } catch (err) {
      showToast(`Void failed: ${err.message}`, "error");
    } finally {
      rowActionBusyRef.current = false;
      setRowActionBusy(null);
    }
  };
  const handleUnvoid = async (id) => {
    if (rowActionBusyRef.current) return;
    if (
      !confirm(
        "Restore this voided invoice to a draft? It becomes editable and collectible again.",
      )
    )
      return;
    rowActionBusyRef.current = true;
    setRowActionBusy(id);
    try {
      await adminFetch(`/admin/invoices/${id}/unvoid`, {
        method: "POST",
      });
      showToast("Invoice restored to draft");
      load();
      onRefresh();
    } catch (err) {
      showToast(`Unvoid failed: ${err.message}`, "error");
    } finally {
      rowActionBusyRef.current = false;
      setRowActionBusy(null);
    }
  };
  const handleReversePrepaid = async (id) => {
    if (reversingIdRef.current) return;
    if (reversingId) return;
    if (
      !confirm(
        "Reverse this prepaid invoice? The applied account credit is returned to the customer and the invoice reopens for collection.",
      )
    )
      return;
    reversingIdRef.current = true;
    setReversingId(id);
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
      showToast(`Reverse failed: ${err.message}`, "error");
    } finally {
      reversingIdRef.current = false;
      setReversingId(null);
    }
  };
  const handleCancelPaymentPlan = async (id, planId) => {
    if (cancellingPlanInvoiceIdRef.current) return;
    if (
      !confirm(
        "Cancel this payment plan? The invoice reopens for normal collection and editing.",
      )
    )
      return;
    cancellingPlanInvoiceIdRef.current = true;
    setCancellingPlanInvoiceId(id);
    try {
      const res = await adminFetch(
        `/admin/invoices/${id}/payment-plan/cancel`,
        {
          method: "POST",
          body: JSON.stringify({
            paymentPlanId: planId,
          }),
        },
      );
      // Settlement can win the cancel race — the server then COMPLETES the
      // plan instead. Surface what actually happened; a "cancelled" toast
      // would misrepresent the collection state.
      showToast(
        res?.completedInsteadOfCancelled
          ? res.message ||
              "Invoice settled while cancelling — the plan was completed, not cancelled"
          : "Payment plan cancelled",
      );
      load();
      onRefresh();
    } catch (err) {
      showToast(`Cancel plan failed: ${err.message}`, "error");
    } finally {
      cancellingPlanInvoiceIdRef.current = false;
      setCancellingPlanInvoiceId(null);
    }
  };
  const handleArchive = async (id) => {
    if (rowActionBusyRef.current) return;
    if (
      !confirm(
        "Archive this voided invoice? It stays accessible under the Archived filter.",
      )
    )
      return;
    rowActionBusyRef.current = true;
    setRowActionBusy(id);
    try {
      await adminFetch(`/admin/invoices/${id}/archive`, {
        method: "POST",
      });
      showToast("Invoice archived");
      load();
      onRefresh();
    } catch (err) {
      showToast(`Archive failed: ${err.message}`, "error");
    } finally {
      rowActionBusyRef.current = false;
      setRowActionBusy(null);
    }
  };
  const handleUnarchive = async (id) => {
    if (rowActionBusyRef.current) return;
    rowActionBusyRef.current = true;
    setRowActionBusy(id);
    try {
      await adminFetch(`/admin/invoices/${id}/unarchive`, {
        method: "POST",
      });
      showToast("Invoice restored");
      load();
      onRefresh();
    } catch (err) {
      showToast(`Restore failed: ${err.message}`, "error");
    } finally {
      rowActionBusyRef.current = false;
      setRowActionBusy(null);
    }
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
    if (batchSendingRef.current) return;
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
    batchSendingRef.current = true;
    setBatchSending(true);
    try {
      const endpoint = receiptMode
        ? "/admin/invoices/batch/send-receipts"
        : "/admin/invoices/batch/send";
      const result = await adminFetch(endpoint, {
        method: "POST",
        body: JSON.stringify({
          invoiceIds: ids,
        }),
      });
      const noun = receiptMode ? "receipt" : "invoice";
      showToast(
        `Sent ${result.sent_count} of ${result.total} ${noun}${result.total === 1 ? "" : "s"}${result.failed_count ? ` (${result.failed_count} failed)` : ""}`,
      );
      clearSelection();
      load();
      onRefresh();
    } catch (err) {
      showToast(`Batch send failed: ${err.message}`, "error");
    } finally {
      batchSendingRef.current = false;
      setBatchSending(false);
    }
  };
  const domain = typeof window !== "undefined" ? window.location.origin : "";

  // Derive display status: overdue when unpaid + past due
  const getDisplayStatus = (inv) => {
    if (inv.status === "paid")
      return {
        key: "paid",
        label: "Paid",
        color: "#52525B",
      };
    if (inv.status === "prepaid")
      return {
        key: "prepaid",
        label: "Prepaid",
        color: "#52525B",
      };
    if (inv.status === "void")
      return {
        key: "void",
        label: "Void",
        color: "#52525B",
      };
    if (inv.status === "processing")
      return {
        key: "processing",
        label: "Processing",
        color: "#52525B",
      };
    if (inv.status === "refunded")
      return {
        key: "refunded",
        label: "Refunded",
        color: "#52525B",
      };
    if (inv.status === "canceled" || inv.status === "cancelled")
      return {
        key: "canceled",
        label: "Canceled",
        color: "#52525B",
      };
    if (inv.status === "scheduled") {
      // A recovered crashed-send claim is parked here with NO send date
      // (delivery unverified — the cron must not retry it). Without its own
      // signal it would read as an ordinary "Scheduled" invoice forever.
      if (inv.scheduled_send_error && !inv.scheduled_send_at)
        return {
          key: "send_review",
          label: "Needs review",
          color: "#C8312F",
        };
      // The send cron stops retrying after 5 attempts — without this the
      // invoice would sit as "Scheduled" forever with no visible signal.
      if (inv.scheduled_send_error && Number(inv.scheduled_send_attempts) >= 5)
        return {
          key: "send_failed",
          label: "Send failed",
          color: "#C8312F",
        };
      return {
        key: "scheduled",
        label: "Scheduled",
        color: "#52525B",
      };
    }
    if (inv.status === "sending")
      return {
        key: "sending",
        label: "Sending",
        color: "#52525B",
      };
    if (inv.status === "draft")
      return {
        key: "draft",
        label: "Draft",
        color: "#52525B",
      };
    // ET wall-clock, like the server's list filter — the old browser-local
    // check flipped rows a day early/late for anyone outside ET.
    if (isInvoiceDueDateOverdue(inv.due_date))
      return {
        key: "overdue",
        label: "Overdue",
        color: "#C8312F",
      };
    if (inv.status === "overdue")
      return {
        key: "overdue",
        label: "Overdue",
        color: "#C8312F",
      };
    if (inv.status === "viewed")
      return {
        key: "viewed",
        label: "Viewed",
        color: "#18181B",
      };
    return {
      key: "sent",
      label: "Sent",
      color: "#18181B",
    };
  };
  const rows =
    deepLinkedInvoice &&
    !invoices.some((inv) => String(inv.id) === String(deepLinkedInvoice.id))
      ? [deepLinkedInvoice, ...invoices]
      : invoices;

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
      const g = {
        key,
        label,
        items: [],
      };
      groupMap.set(key, g);
      groups.push(g);
    }
    groupMap.get(key).items.push(inv);
  }
  return (
    <div>
      {/* Search */}
      <div
        style={{
          padding: "4px 0 12px",
        }}
      >
        {" "}
        <div
          style={{
            position: "relative",
          }}
        >
          {" "}
          <Field className="min-w-0" label="Search invoices">
            <Input
              id="admin-invoice-search"
              name="admin_invoice_search"
              value={query}
              disabled={batchSending}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              style={{
                width: "100%",
                boxSizing: "border-box",
              }}
            />
          </Field>{" "}
        </div>{" "}
      </div>
      {customerFilterId && (
        <div
          style={{
            margin: isMobile ? "0 16px 12px" : "0 0 12px",
            padding: "10px 12px",
            border: "1px solid #E4E4E7",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
          className="rounded-md bg-white text-ui-body"
        >
          <span>Customer invoices only</span>
          <Button
            type="button"
            onClick={clearCustomerFilter}
            aria-label="Clear customer invoice filter"
            variant={"secondary"}
            onClickCapture={(event) =>
              event.currentTarget.focus({
                preventScroll: true,
              })
            }
            className="min-w-11"
          >
            Show all
          </Button>
        </div>
      )}
      {/* Filter pills */}
      <div
        style={{
          display: "flex",
          gap: 10,
          padding: "4px 0 16px",
          alignItems: "flex-end",
          flexWrap: "wrap",
        }}
      >
        {" "}
        <InvoiceFilter
          label="Filter"
          disabled={batchSending}
          value={filter}
          onChange={setFilter}
          options={[
            {
              key: "all",
              label: "All",
            },
            {
              key: "overdue",
              label: "Overdue",
            },
            {
              key: "unpaid",
              label: "Unpaid",
            },
            {
              key: "paid",
              label: "Paid",
            },
            {
              key: "prepaid",
              label: "Prepaid",
            },
            {
              key: "needs_receipt",
              label: "Needs receipt",
            },
            {
              key: "draft",
              label: "Draft",
            },
            {
              key: "archived",
              label: "Archived",
            },
          ]}
        />{" "}
        <InvoiceFilter
          label="Date"
          disabled={batchSending}
          value={datePeriod}
          onChange={setDatePeriod}
          options={[
            {
              key: "all",
              label: "All",
            },
            {
              key: "today",
              label: "Today",
            },
            {
              key: "7d",
              label: "Last 7 days",
            },
            {
              key: "30d",
              label: "Last 30 days",
            },
            {
              key: "month",
              label: "This month",
            },
          ]}
        />{" "}
        <InvoiceFilter
          label="Sort"
          disabled={batchSending}
          value={sort}
          onChange={setSort}
          options={[
            {
              key: "newest",
              label: "Newest",
            },
            {
              key: "oldest",
              label: "Oldest",
            },
            {
              key: "amount_high",
              label: "Amount ↓",
            },
            {
              key: "amount_low",
              label: "Amount ↑",
            },
          ]}
        />
        {sendableInvoices.length > 0 && (
          <Button
            onClick={selectAllSendable}
            disabled={batchSending}
            variant={"secondary"}
            onClickCapture={(event) =>
              event.currentTarget.focus({
                preventScroll: true,
              })
            }
            className="min-w-11"
          >
            {receiptMode
              ? `Select ${Math.min(sendableInvoices.length, BATCH_RECEIPT_MAX)} to receipt`
              : `Select sendable (${sendableInvoices.length})`}
          </Button>
        )}
        {stats && !isMobile && (
          <span
            style={{
              marginLeft: "auto",
            }}
            className="text-ui-body text-ink-secondary"
          >
            {stats.paid} paid · {stats.outstanding} outstanding ·{" "}
            {stats.overdue} overdue
            {Number(stats.deposits?.onHand) > 0 && (
              <>
                {" · "}
                <span className="text-ink-secondary">
                  ${Number(stats.deposits.onHand).toFixed(2)} deposits on hand
                  {stats.deposits.onHandCount > 1
                    ? ` (${stats.deposits.onHandCount})`
                    : ""}
                </span>
              </>
            )}
          </span>
        )}
      </div>
      {/* List */}
      {deepLinkError && (
        <ActionFeedback
          error
          onRetry={() => setDeepLinkAttempt((attempt) => attempt + 1)}
          className="mb-4"
        >
          {deepLinkError}
        </ActionFeedback>
      )}
      {listLoading && rows.length > 0 && (
        <ActionFeedback className="mb-4">Refreshing invoices…</ActionFeedback>
      )}
      {listError && rows.length > 0 && (
        <ActionFeedback error onRetry={() => load()} className="mb-4">
          Could not load the invoice list.
        </ActionFeedback>
      )}
      {rows.length === 0 ? (
        <div
          style={{
            padding: 48,
            textAlign: "center",
          }}
          className={cn(
            listError ? "text-alert-fg" : "text-ink-secondary",
            "text-ui-field min-h-[240px] box-border",
          )}
        >
          {listError ? (
            <>
              <div role="alert">Could not load invoices</div>
              <Button
                type="button"
                onClick={() => load()}
                style={{
                  marginTop: 12,
                }}
                variant={"secondary"}
                onClickCapture={(event) =>
                  event.currentTarget.focus({
                    preventScroll: true,
                  })
                }
                className="min-w-11"
              >
                Retry
              </Button>
            </>
          ) : listLoading ? (
            "Loading invoices…"
          ) : (
            <>
              <div>
                {query || filter !== "all" || datePeriod !== "all"
                  ? "No invoices match"
                  : "No invoices yet. Create an invoice to get started."}
              </div>
              {(query || filter !== "all" || datePeriod !== "all") && (
                <Button
                  variant="secondary"
                  className="mt-3"
                  onClick={() => {
                    setQuery("");
                    setFilter("all");
                    setDatePeriod("all");
                  }}
                >
                  Clear filters
                </Button>
              )}
            </>
          )}
        </div>
      ) : (
        <div
          style={{
            borderTop: "1px solid #E4E4E7",
            borderBottom: "1px solid #E4E4E7",
          }}
          className="bg-white"
        >
          {groups.map((g) => (
            <div key={g.key}>
              {" "}
              <div
                style={{
                  padding: isMobile ? "16px 16px 10px" : "16px 18px 10px",
                  borderBottom: "1px solid #E4E4E7",
                }}
                className="text-ui-field font-medium text-zinc-900"
              >
                {g.label}
              </div>
              {g.items.map((inv) => {
                // Every row reserves the checkbox column once any sibling can
                // select, so names line up regardless of status.
                const anyRowSelectable = g.items.some((row) =>
                  receiptMode
                    ? row.status === "paid" && !row.receipt_sent_at
                    : invoiceSendableStatuses.has(row.status),
                );
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
                const depositApplied = invoiceDepositCreditTotal(lineItems);
                return (
                  <div
                    key={inv.id}
                    style={{
                      borderBottom: "1px solid #E4E4E7",
                    }}
                  >
                    {" "}
                    <div className="flex items-center gap-3 px-4 py-3">
                      {canSelect ? (
                        <Checkbox
                          id={`invoice-row-select-${inv.id}`}
                          disabled={batchSending}
                          name="invoice_row_select"
                          checked={isSelected}
                          onChange={() => toggleSelect(inv.id)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`Select invoice ${inv.invoice_number}`}
                          label={
                            <span className="sr-only">
                              Select invoice {inv.invoice_number}
                            </span>
                          }
                        />
                      ) : anyRowSelectable ? (
                        <span
                          aria-hidden
                          style={{
                            width: 18,
                            height: 18,
                            flexShrink: 0,
                          }}
                        />
                      ) : null}
                      <Button
                        onClick={() => toggleExpanded(inv.id)}
                        onClickCapture={(event) =>
                          event.currentTarget.focus({
                            preventScroll: true,
                          })
                        }
                        variant="ghost"
                        className="min-w-0 flex-1 justify-start text-left whitespace-normal"
                        aria-expanded={isOpen}
                        aria-controls={`invoice-detail-${inv.id}`}
                      >
                        <div
                          style={{
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          {" "}
                          <div
                            style={{
                              lineHeight: 1.25,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                            className="text-ui-field font-medium text-zinc-900"
                          >
                            {inv.first_name} {inv.last_name}
                          </div>{" "}
                          <div
                            style={{
                              marginTop: 4,
                            }}
                            className="text-ui-body text-ink-secondary"
                          >
                            #{inv.invoice_number}
                          </div>{" "}
                        </div>{" "}
                        <div
                          style={{
                            textAlign: "right",
                          }}
                        >
                          {" "}
                          <div className="text-ui-field font-medium text-zinc-900">
                            ${parseFloat(inv.total).toFixed(2)}
                          </div>{" "}
                          <div
                            style={{
                              color: display.color,
                              marginTop: 4,
                            }}
                            className="text-ui-body font-medium"
                          >
                            {display.label}
                          </div>{" "}
                        </div>{" "}
                        <span
                          aria-hidden
                          style={{
                            marginLeft: 4,
                            transform: isOpen ? "rotate(90deg)" : "none",
                            transition: "transform .15s",
                          }}
                          className="text-ink-secondary text-18"
                        >
                          ›
                        </span>{" "}
                      </Button>
                    </div>
                    {isOpen && (
                      <div
                        id={`invoice-detail-${inv.id}`}
                        style={{
                          padding: isMobile ? "0 16px 18px" : "0 18px 18px",
                          borderTop: "1px solid #E4E4E7",
                        }}
                        className="bg-zinc-50"
                      >
                        {" "}
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 12,
                            padding: "14px 0",
                          }}
                          className="text-ui-body text-ink-secondary"
                        >
                          {" "}
                          <span>
                            {inv.title ||
                              lineItems[0]?.description ||
                              "Service"}
                          </span>
                          {inv.waveguard_tier && (
                            <Badge className="max-w-full whitespace-normal">
                              {inv.waveguard_tier}
                            </Badge>
                          )}
                          {annualPrepayInvoiceLabel(inv) && (
                            <Badge className="max-w-full whitespace-normal">
                              {annualPrepayInvoiceLabel(inv)}
                              {inv.annual_prepay_term_end
                                ? ` · through ${formatInvoiceDate(inv.annual_prepay_term_end)}`
                                : ""}
                            </Badge>
                          )}
                          {depositApplied > 0 && (
                            <Badge className="max-w-full whitespace-normal">
                              ${depositApplied.toFixed(2)} deposit applied
                            </Badge>
                          )}
                          {cardOnFile && canCollect && (
                            <span>
                              Card {cardOnFile.brand || "Card"} •
                              {cardOnFile.last_four} on file
                            </span>
                          )}
                          {inv.active_payment_plan && (
                            <Badge className="max-w-full whitespace-normal">
                              Plan $
                              {Number(
                                inv.active_payment_plan.payment_amount || 0,
                              ).toFixed(2)}{" "}
                              {inv.active_payment_plan.payment_frequency}
                            </Badge>
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
                          style={{
                            display: "flex",
                            gap: 8,
                            flexWrap: "wrap",
                          }}
                        >
                          {(inv.status === "draft" ||
                            inv.status === "scheduled") && (
                            <Button
                              onClick={() => handleSend(inv)}
                              title="Send invoice via SMS + email"
                              variant={"secondary"}
                              onClickCapture={(event) =>
                                event.currentTarget.focus({
                                  preventScroll: true,
                                })
                              }
                              className="min-w-11"
                            >
                              Send
                            </Button>
                          )}
                          {(inv.status === "draft" ||
                            inv.status === "scheduled" ||
                            inv.status === "sent" ||
                            inv.status === "viewed" ||
                            inv.status === "overdue") &&
                            !inv.stripe_payment_intent_id &&
                            !inv.active_payment_plan &&
                            !inv.annual_prepay_term_id && (
                              <Button
                                onClick={() => onEdit?.(inv)}
                                title={
                                  inv.status === "draft" ||
                                  inv.status === "scheduled"
                                    ? "Edit line items, notes, and due date before sending"
                                    : "Edit line items, notes, and due date — resend after saving so the customer sees the new version"
                                }
                                variant={"secondary"}
                                onClickCapture={(event) =>
                                  event.currentTarget.focus({
                                    preventScroll: true,
                                  })
                                }
                                className="min-w-11"
                              >
                                Edit
                              </Button>
                            )}
                          {(inv.status === "sent" ||
                            inv.status === "viewed" ||
                            inv.status === "overdue") && (
                            <Button
                              onClick={() => handleSend(inv)}
                              title="Resend invoice via SMS + email"
                              variant={"secondary"}
                              onClickCapture={(event) =>
                                event.currentTarget.focus({
                                  preventScroll: true,
                                })
                              }
                              className="min-w-11"
                            >
                              Resend
                            </Button>
                          )}
                          {canCollect && (
                            <Button
                              onClick={() => {
                                navigator.clipboard.writeText(
                                  `${domain}/pay/${inv.token}`,
                                );
                                showToast("Pay link copied");
                              }}
                              variant={"secondary"}
                              onClickCapture={(event) =>
                                event.currentTarget.focus({
                                  preventScroll: true,
                                })
                              }
                              className="min-w-11"
                            >
                              Copy link
                            </Button>
                          )}
                          {canCollect && (
                            <Button
                              onClick={async () => {
                                try {
                                  await launchTapToPay(inv.id);
                                } catch (e) {
                                  showToast(
                                    `Tap to Pay failed: ${e.message}`,
                                    "error",
                                  );
                                }
                              }}
                              title="Open Waves Tech app to tap customer's card/phone"
                              variant={"secondary"}
                              onClickCapture={(event) =>
                                event.currentTarget.focus({
                                  preventScroll: true,
                                })
                              }
                              className="min-w-11"
                            >
                              Charge in person
                            </Button>
                          )}
                          {/* Payer-billed invoices collect from the payer's AP
                              inbox — the saved card belongs to the homeowner,
                              so the charge endpoint rejects them. */}
                          {isAdminUser &&
                            canCollect &&
                            cardOnFile &&
                            !inv.payer_id && (
                              <Button
                                onClick={() => setCardOnFileInvoice(inv)}
                                title="Charge the customer's saved card or bank on file — collects now, no send needed"
                                variant={"secondary"}
                                onClickCapture={(event) =>
                                  event.currentTarget.focus({
                                    preventScroll: true,
                                  })
                                }
                                className="min-w-11"
                              >
                                Charge card on file
                              </Button>
                            )}
                          {canCollect && (
                            <Button
                              onClick={() => setPaymentModalInvoice(inv)}
                              title="Record cash, check, Zelle, Venmo, or PayPal payment and close the invoice"
                              variant={"secondary"}
                              onClickCapture={(event) =>
                                event.currentTarget.focus({
                                  preventScroll: true,
                                })
                              }
                              className="min-w-11"
                            >
                              Add payment
                            </Button>
                          )}
                          {canCollect && (
                            <Button
                              onClick={() => setApplyCreditInvoice(inv)}
                              title="Apply the customer's account credit — covers the invoice and marks it prepaid"
                              variant={"secondary"}
                              onClickCapture={(event) =>
                                event.currentTarget.focus({
                                  preventScroll: true,
                                })
                              }
                              className="min-w-11"
                            >
                              Apply credit
                            </Button>
                          )}
                          {canCollect && !inv.active_payment_plan && (
                            <Button
                              onClick={() => setPaymentPlanModalInvoice(inv)}
                              title="Create a payment plan and send the confirmation email"
                              variant={"secondary"}
                              onClickCapture={(event) =>
                                event.currentTarget.focus({
                                  preventScroll: true,
                                })
                              }
                              className="min-w-11"
                            >
                              Payment plan
                            </Button>
                          )}
                          {isAdminUser && inv.active_payment_plan && (
                            <Button
                              onClick={() =>
                                handleCancelPaymentPlan(
                                  inv.id,
                                  inv.active_payment_plan.id,
                                )
                              }
                              disabled={cancellingPlanInvoiceId === inv.id}
                              title="Cancel the active payment plan — the invoice reopens for normal collection and editing"
                              variant={"secondary"}
                              onClickCapture={(event) =>
                                event.currentTarget.focus({
                                  preventScroll: true,
                                })
                              }
                              className="min-w-11"
                            >
                              {cancellingPlanInvoiceId === inv.id
                                ? "Cancelling…"
                                : "Cancel plan"}
                            </Button>
                          )}
                          {inv.status !== "void" && (
                            <Button
                              onClick={() => setAnnualPrepayModalInvoice(inv)}
                              title="Flag this invoice as a full-year prepayment — adds the coverage banner to the customer's invoice"
                              variant={"secondary"}
                              onClickCapture={(event) =>
                                event.currentTarget.focus({
                                  preventScroll: true,
                                })
                              }
                              className="min-w-11"
                            >
                              {inv.annual_prepay_term_id
                                ? "Annual prepay ✓"
                                : "Annual prepay"}
                            </Button>
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
                                textDecoration: "none",
                                display: "inline-flex",
                                alignItems: "center",
                              }}
                              title={
                                inv.status === "paid"
                                  ? "Download the receipt PDF"
                                  : "Download the invoice PDF"
                              }
                              className={cn(
                                buttonStyles({
                                  variant: "secondary",
                                  density: "comfortable",
                                }),
                              )}
                            >
                              Download PDF
                            </a>
                          )}
                          {canCollect && (
                            <Button
                              onClick={() => handleVoid(inv.id)}
                              disabled={rowActionBusy === inv.id}
                              onClickCapture={(event) =>
                                event.currentTarget.focus({
                                  preventScroll: true,
                                })
                              }
                              className="min-w-11"
                              variant="danger"
                            >
                              Void
                            </Button>
                          )}
                          {inv.status === "prepaid" && (
                            <Button
                              onClick={() => handleReversePrepaid(inv.id)}
                              disabled={reversingId !== null}
                              title="Return the applied account credit to the customer and reopen this invoice"
                              onClickCapture={(event) =>
                                event.currentTarget.focus({
                                  preventScroll: true,
                                })
                              }
                              className="min-w-11"
                              variant="danger"
                            >
                              Reverse prepaid
                            </Button>
                          )}
                          {isAdminUser && inv.status === "void" && (
                            <Button
                              onClick={() => handleUnvoid(inv.id)}
                              disabled={rowActionBusy === inv.id}
                              title="Restore this voided invoice to an editable draft"
                              variant={"secondary"}
                              onClickCapture={(event) =>
                                event.currentTarget.focus({
                                  preventScroll: true,
                                })
                              }
                              className="min-w-11"
                            >
                              Unvoid
                            </Button>
                          )}
                          {inv.status === "void" && !inv.archived_at && (
                            <Button
                              onClick={() => handleArchive(inv.id)}
                              disabled={rowActionBusy === inv.id}
                              title="Tuck this voided invoice out of the default list"
                              variant={"secondary"}
                              onClickCapture={(event) =>
                                event.currentTarget.focus({
                                  preventScroll: true,
                                })
                              }
                              className="min-w-11"
                            >
                              Archive
                            </Button>
                          )}
                          {inv.archived_at && (
                            <Button
                              onClick={() => handleUnarchive(inv.id)}
                              disabled={rowActionBusy === inv.id}
                              title="Restore to the default list"
                              variant={"secondary"}
                              onClickCapture={(event) =>
                                event.currentTarget.focus({
                                  preventScroll: true,
                                })
                              }
                              className="min-w-11"
                            >
                              Unarchive
                            </Button>
                          )}
                          {sendReceiptEnabled && inv.status === "paid" && (
                            <Button
                              onClick={() => setReceiptModalInvoice(inv)}
                              title={
                                inv.receipt_sent_at
                                  ? "Resend receipt + log another touch"
                                  : "Email + SMS the receipt and close the service"
                              }
                              variant={"secondary"}
                              onClickCapture={(event) =>
                                event.currentTarget.focus({
                                  preventScroll: true,
                                })
                              }
                              className="min-w-11"
                            >
                              {inv.receipt_sent_at
                                ? "Resend receipt"
                                : "Send receipt"}
                            </Button>
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

      {moreError && (
        <ActionFeedback error className="mt-4">
          Could not load more invoices. Use Load more to retry.
        </ActionFeedback>
      )}
      {invoices.length < total && (
        <div
          style={{
            padding: isMobile ? "18px 16px" : "18px 0",
            textAlign: "center",
          }}
        >
          {" "}
          <Button
            onClick={async () => {
              setLoadingMore(true);
              try {
                await load({
                  append: true,
                  pageNo: page + 1,
                });
              } finally {
                setLoadingMore(false);
              }
            }}
            disabled={loadingMore || listLoading}
            variant={"secondary"}
            onClickCapture={(event) =>
              event.currentTarget.focus({
                preventScroll: true,
              })
            }
            className="min-w-11"
            loading={loadingMore}
          >
            {`Load more (${invoices.length} of ${total})`}
          </Button>{" "}
        </div>
      )}

      {selected.size > 0 && (
        <div
          style={{
            position: "fixed",
            width: "max-content",
            bottom: isMobile
              ? "calc(72px + env(safe-area-inset-bottom, 0px))"
              : 20,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "12px 20px",
            display: "flex",
            alignItems: "center",
            gap: 14,
            zIndex: 50,
          }}
          className="bg-zinc-900 text-white rounded-md max-w-[calc(100%-2rem)] flex-wrap justify-center"
        >
          {" "}
          <span className="font-medium text-ui-body">
            {selected.size} selected
          </span>{" "}
          <Button
            onClick={handleBatchSend}
            disabled={batchSending}
            variant={"secondary"}
            onClickCapture={(event) =>
              event.currentTarget.focus({
                preventScroll: true,
              })
            }
            className="min-w-11"
            loading={batchSending}
          >
            {receiptMode
              ? `Send ${selected.size} receipt${selected.size === 1 ? "" : "s"}`
              : `Send ${selected.size}`}
          </Button>{" "}
          <Button
            onClick={clearSelection}
            disabled={batchSending}
            variant={"secondary"}
            onClickCapture={(event) =>
              event.currentTarget.focus({
                preventScroll: true,
              })
            }
            className="min-w-11"
          >
            Clear
          </Button>{" "}
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
              res?.email?.ok &&
                (res.email.recipient?.email
                  ? `email to ${res.email.recipient.email}`
                  : "email"),
            ].filter(Boolean);
            showToast(
              channels.length
                ? `Invoice sent (${channels.join(" + ")})`
                : "Invoice send failed",
            );
            load();
            onRefresh();
          }}
          onError={(msg) => showToast(msg, "error")}
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
          onError={(msg) => showToast(msg, "error")}
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
          onError={(msg) => showToast(msg, "error")}
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
          onError={(msg) => showToast(msg, "error")}
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
          onError={(msg) => showToast(msg, "error")}
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
          onError={(msg) => showToast(msg, "error")}
        />
      )}

      {cardOnFileInvoice && (
        <MobileCardOnFileSheet
          presentation="admin"
          desktopVisible
          invoiceId={cardOnFileInvoice.id}
          customerId={cardOnFileInvoice.customer_id}
          customerName={
            `${cardOnFileInvoice.first_name || ""} ${cardOnFileInvoice.last_name || ""}`.trim() ||
            "Customer"
          }
          onClose={() => setCardOnFileInvoice(null)}
          onChargeSuccess={(r) => {
            setCardOnFileInvoice(null);
            if (r?.covered_by_credit) {
              showToast(
                "Account credit covered it — invoice marked prepaid, card not charged",
              );
            } else if (r?.status === "processing") {
              showToast(
                "Bank payment started — invoice will mark paid when it settles",
              );
            } else {
              const brand = r?.brand
                ? r.brand.charAt(0).toUpperCase() +
                  r.brand.slice(1).toLowerCase()
                : "Card";
              showToast(
                `Charged $${Number(r?.amount || 0).toFixed(2)} to ${brand}${r?.last4 ? ` •${r.last4}` : ""} on file`,
              );
            }
            load();
            onRefresh();
          }}
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
  if (
    inv.status === "scheduled" &&
    !inv.scheduled_send_at &&
    inv.scheduled_send_error
  ) {
    // Parked recovery state: a crashed send claim was released with its
    // send date cleared (delivery unverified, no automatic retry) — the
    // operator has to verify and resend/re-schedule by hand.
    events.push({
      kind: "send_review",
      at: inv.updated_at || inv.created_at,
      label: "Send interrupted — needs review",
      detail: inv.scheduled_send_error,
      color: "#C8312F",
      emphasis: true,
    });
  }
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
      color: exhausted ? "#C8312F" : "#52525B",
      emphasis: Boolean(exhausted),
    });
  }
  if (inv.sent_at || inv.sms_sent_at) {
    events.push({
      kind: "sent",
      at: inv.sent_at || inv.sms_sent_at,
      label: "Invoice sent",
      detail: "SMS + email",
      color: "#18181B",
    });
  }
  if (inv.viewed_at) {
    const count = Number(inv.view_count) || 0;
    events.push({
      kind: "viewed",
      at: inv.viewed_at,
      label: "Customer opened the invoice",
      detail: count > 1 ? `${count} total views` : null,
      color: "#18181B",
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
      color: "#52525B",
    });
  }
  if (inv.paid_at) {
    // Stripe payments carry card_brand / card_last_four; manual payments
    // (cash/check/zelle/venmo/paypal/other) carry payment_method + payment_reference.
    const MANUAL_LABELS = {
      cash: "Cash",
      check: "Check",
      zelle: "Zelle",
      venmo: "Venmo",
      paypal: "PayPal",
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
      color: "#52525B",
      emphasis: true,
    });
  }
  if (inv.receipt_sent_at) {
    events.push({
      kind: "receipt",
      at: inv.receipt_sent_at,
      label: "Receipt sent",
      detail: inv.receipt_memo ? `“${inv.receipt_memo}”` : null,
      color: "#52525B",
    });
  }
  if (inv.status === "void") {
    events.push({
      kind: "void",
      at: inv.updated_at,
      label: "Voided",
      color: "#52525B",
    });
  }
  if (inv.archived_at) {
    events.push({
      kind: "archived",
      at: inv.archived_at,
      label: "Archived",
      color: "#52525B",
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
      ? {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }
      : {
          month: "short",
          day: "numeric",
          year: "numeric",
        },
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
        borderTop: "1px solid #E4E4E7",
      }}
    >
      {" "}
      <div
        style={{
          marginBottom: 12,
        }}
        className="text-ui-body font-medium text-ink-secondary"
      >
        Activity
      </div>{" "}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {events.map((e, i) => (
          <div
            key={`${e.kind}-${i}`}
            style={{
              display: "flex",
              gap: 12,
              alignItems: "flex-start",
            }}
          >
            {" "}
            <div
              style={{
                width: 8,
                height: 8,
                background: e.color,
                marginTop: 6,
                flexShrink: 0,
              }}
              className={cn("rounded-md", "")}
            />{" "}
            <div
              style={{
                flex: 1,
                minWidth: 0,
              }}
            >
              {" "}
              <div
                style={{
                  lineHeight: 1.3,
                }}
                className={cn("text-ui-body", "text-zinc-900", "font-medium")}
              >
                {e.label}
              </div>
              {e.detail && (
                <div
                  style={{
                    marginTop: 2,
                    lineHeight: 1.35,
                    wordBreak: "break-word",
                  }}
                  className="text-ui-body text-ink-secondary"
                >
                  {e.detail}
                </div>
              )}
              <div
                style={{
                  marginTop: 2,
                }}
                className="text-ui-body text-ink-secondary"
              >
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
  const uploadingRef = useRef(false);
  const deletingIdRef = useRef(false);
  const [attachments, setAttachments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const fileRef = useRef(null);
  const helpId = `invoice-attachments-${invoiceId}-help`;
  const statusId = `invoice-attachments-${invoiceId}-status`;
  const load = useCallback(async () => {
    setLoading(true);
    setReadError("");
    try {
      const data = await adminFetch(`/admin/invoices/${invoiceId}/attachments`);
      setAttachments(data.attachments || []);
    } catch (err) {
      setReadError(`Attachments failed to load: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);
  useEffect(() => {
    load();
  }, [load]);
  const handleFiles = async (event) => {
    if (uploadingRef.current) return;
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length || uploading) return;
    const validation = validateAttachmentFiles(attachments, files);
    if (validation) {
      showToast(validation);
      return;
    }
    uploadingRef.current = true;
    setUploading(true);
    try {
      await uploadInvoiceAttachments(invoiceId, files);
      showToast(
        `${files.length} attachment${files.length === 1 ? "" : "s"} uploaded`,
      );
      await load();
    } catch (err) {
      showToast(`Attachment upload failed: ${err.message}`, "error");
    } finally {
      uploadingRef.current = false;
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
      showToast(`Attachment open failed: ${err.message}`, "error");
    }
  };
  const deleteAttachment = async (attachment) => {
    if (deletingIdRef.current) return;
    if (!confirm(`Remove ${attachment.file_name}?`)) return;
    deletingIdRef.current = true;
    setDeletingId(attachment.id);
    try {
      await adminFetch(
        `/admin/invoices/${invoiceId}/attachments/${attachment.id}`,
        {
          method: "DELETE",
        },
      );
      showToast("Attachment removed");
      await load();
    } catch (err) {
      showToast(`Attachment delete failed: ${err.message}`, "error");
    } finally {
      deletingIdRef.current = false;
      setDeletingId(null);
    }
  };
  const canAdd = canAddInvoiceAttachments(attachments);
  if (readError)
    return (
      <ActionFeedback error onRetry={load} className="my-4">
        {readError}
      </ActionFeedback>
    );
  return (
    <div
      style={{
        margin: "4px 0 16px",
        paddingTop: 12,
        borderTop: "1px solid #E4E4E7",
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
        <div
          style={{
            minWidth: 0,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 4,
            }}
            className="text-ui-body font-medium text-ink-secondary"
          >
            <Paperclip size={13} strokeWidth={2.2} />
            Attachments
          </div>
          <div
            id={helpId}
            style={{
              lineHeight: 1.4,
            }}
            className="text-ui-body text-ink-secondary"
          >
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
          style={{
            display: "none",
          }}
        />
        <Button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={!canAdd || uploading}
          aria-describedby={`${helpId} ${statusId}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
          variant={"secondary"}
          onClickCapture={(event) =>
            event.currentTarget.focus({
              preventScroll: true,
            })
          }
          className="min-w-11"
          loading={uploading}
        >
          <Upload size={14} strokeWidth={2.2} />
          {"Add files"}
        </Button>
      </div>

      {loading ? (
        <div
          id={statusId}
          role="status"
          aria-live="polite"
          className="text-ui-body text-ink-secondary"
        >
          Loading attachments...
        </div>
      ) : attachments.length === 0 ? (
        <div
          id={statusId}
          role="status"
          aria-live="polite"
          className="text-ui-body text-ink-secondary"
        >
          No files attached.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gap: 8,
          }}
        >
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) auto auto",
                alignItems: "center",
                gap: 8,
                padding: "9px 10px",
                border: "1px solid #E4E4E7",
              }}
              className="rounded-md bg-white"
            >
              <Button
                type="button"
                onClick={() => openAttachment(attachment)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  textAlign: "left",
                }}
                variant={"secondary"}
                onClickCapture={(event) =>
                  event.currentTarget.focus({
                    preventScroll: true,
                  })
                }
                className="min-w-11"
              >
                <FileText size={15} strokeWidth={2.1} />
                <span
                  style={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  className="text-ui-body font-medium"
                >
                  {attachment.file_name}
                </span>
              </Button>
              <span
                style={{
                  whiteSpace: "nowrap",
                }}
                className="text-ui-body text-ink-secondary"
              >
                {formatFileSize(attachment.file_size_bytes)}
              </span>
              <div
                style={{
                  display: "flex",
                  gap: 4,
                }}
              >
                <Button
                  type="button"
                  onClick={() => openAttachment(attachment)}
                  aria-label={`Open ${attachment.file_name}`}
                  style={{
                    width: 32,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  variant={"secondary"}
                  onClickCapture={(event) =>
                    event.currentTarget.focus({
                      preventScroll: true,
                    })
                  }
                  className="min-w-11"
                >
                  <ExternalLink size={15} strokeWidth={2.2} />
                </Button>
                <Button
                  type="button"
                  onClick={() => deleteAttachment(attachment)}
                  disabled={deletingId === attachment.id}
                  aria-label={`Remove ${attachment.file_name}`}
                  style={{
                    width: 32,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                  onClickCapture={(event) =>
                    event.currentTarget.focus({
                      preventScroll: true,
                    })
                  }
                  className="min-w-11"
                  variant="danger"
                >
                  <Trash2 size={15} strokeWidth={2.2} />
                </Button>
              </div>
            </div>
          ))}
          <div
            id={statusId}
            role="status"
            aria-live="polite"
            className="text-ui-body text-ink-secondary"
          >
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
        borderBottom: "1px solid #E4E4E7",
      }}
    >
      <div className="text-ui-body font-medium text-ink-secondary">{label}</div>
      <div
        style={{
          minWidth: 0,
        }}
      >
        <div
          style={{
            overflowWrap: "anywhere",
          }}
          className={cn(
            "text-ui-body",
            "font-medium",
            missing ? "text-alert-fg" : "text-zinc-900",
          )}
        >
          {value}
        </div>
        {detail && (
          <div
            style={{
              marginTop: 3,
            }}
            className="text-ui-body text-ink-secondary"
          >
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
function SendInvoiceModal({
  invoice,
  isMobile,
  onClose,
  onSent,
  onError: reportError,
}) {
  const sendingRef = useRef(false);
  const [actionError, setActionError] = useState("");
  const onError = (message) => {
    setActionError(message);
    reportError(message);
  };
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
    if (sendingRef.current) return;
    if (!canSend) return;
    sendingRef.current = true;
    setActionError("");
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
      sendingRef.current = false;
      setSending(false);
    }
  };
  const customerName =
    recipients?.customerName ||
    [invoice.first_name, invoice.last_name].filter(Boolean).join(" ").trim() ||
    "Customer";
  return (
    <Dialog open={true} onClose={sending ? undefined : onClose} layer={400}>
      <DialogBody className="space-y-4 text-ui-body text-zinc-900">
        <DialogTitle>
          {invoice.status === "draft" || invoice.status === "scheduled"
            ? "Send invoice"
            : "Resend invoice"}
        </DialogTitle>
        {actionError && <ActionFeedback error>{actionError}</ActionFeedback>}
        <div
          style={{
            marginBottom: 18,
          }}
          className="text-ui-body text-ink-secondary"
        >
          Invoice #{invoice.invoice_number} · $
          {parseFloat(invoice.total).toFixed(2)} · {customerName}
        </div>
        {loading ? (
          <div
            style={{
              padding: "18px 0",
            }}
            className="text-ui-body text-ink-secondary"
          >
            Loading recipients...
          </div>
        ) : loadError ? (
          <div
            style={{
              padding: "12px 14px",
              border: "1px solid #C8312F",
              lineHeight: 1.45,
            }}
            className="rounded-md text-alert-fg text-ui-body"
          >
            {loadError}. You can still send using the saved invoice delivery
            settings.
          </div>
        ) : (
          <>
            <div
              style={{
                borderTop: "1px solid #E4E4E7",
              }}
            >
              <DeliveryRow
                label="SMS pay link"
                value={smsPhone || "No phone on primary customer"}
                detail={
                  smsPhone ? "Primary customer phone" : "SMS will be skipped"
                }
                missing={!smsPhone}
              />
              <DeliveryRow
                label="Invoice email"
                value={
                  useOverride
                    ? overrideEmail || "Enter one-time recipient email"
                    : defaultEmail || "No invoice email configured"
                }
                detail={
                  useOverride
                    ? "One-time recipient for this send"
                    : defaultEmail
                      ? contactRoleLabel(defaultEmailRole)
                      : "Email will be skipped unless you add a recipient"
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
                cursor: "pointer",
              }}
              className="ui-choice-label flex items-center gap-2 text-ui-body text-zinc-900"
            >
              <Checkbox
                id={`invoice-recipient-override-${invoice.id}`}
                name="invoice_recipient_override"
                checked={useOverride}
                onChange={(e) => {
                  setUseOverride(e.target.checked);
                  if (!e.target.checked) setSaveAsDefault(false);
                }}
                style={{
                  width: 16,
                  accentColor: "#18181B",
                }}
                disabled={sending}
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
                  <Field label={<>Name</>} className="min-w-0">
                    <Input
                      id={`invoice-recipient-name-${invoice.id}`}
                      name="invoice_recipient_name"
                      autoComplete="name"
                      value={recipientName}
                      onChange={(e) => setRecipientName(e.target.value)}
                      placeholder="Accounts payable"
                      disabled={sending}
                    />
                  </Field>
                </div>
                <div>
                  <Field label={<>Email</>} className="min-w-0">
                    <Input
                      id={`invoice-recipient-email-${invoice.id}`}
                      name="invoice_recipient_email"
                      type="email"
                      autoComplete="email"
                      value={recipientEmail}
                      onChange={(e) => setRecipientEmail(e.target.value)}
                      placeholder="billing@example.com"
                      style={{
                        borderColor:
                          overrideEmail && !isEmailLike(overrideEmail)
                            ? "#C8312F"
                            : "#E4E4E7",
                      }}
                      disabled={sending}
                    />
                  </Field>
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
                  lineHeight: 1.45,
                  cursor: "pointer",
                }}
                className="ui-choice-label flex items-center gap-2 text-ui-body text-zinc-900"
              >
                <Checkbox
                  id={`invoice-recipient-save-${invoice.id}`}
                  name="invoice_recipient_save_default"
                  checked={saveAsDefault}
                  onChange={(e) => setSaveAsDefault(e.target.checked)}
                  style={{
                    width: 16,
                    accentColor: "#18181B",
                    marginTop: 2,
                  }}
                  disabled={sending}
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
          <Button
            onClick={onClose}
            disabled={sending}
            variant={"secondary"}
            onClickCapture={(event) =>
              event.currentTarget.focus({
                preventScroll: true,
              })
            }
            className="min-w-11"
          >
            Cancel
          </Button>
          <Button
            onClick={send}
            disabled={!canSend}
            variant={"primary"}
            onClickCapture={(event) =>
              event.currentTarget.focus({
                preventScroll: true,
              })
            }
            className="min-w-11"
            loading={sending}
          >
            {"Send invoice"}
          </Button>
        </div>
      </DialogBody>
    </Dialog>
  );
}

// ── Send Receipt Modal ──
// Per-invoice action for paid invoices. Memo is ephemeral (stored on the
// invoice row as receipt_memo for audit) — not a customer preference.
function SendReceiptModal({
  invoice,
  isMobile,
  onClose,
  onSent,
  onError: reportError,
}) {
  const sendingRef = useRef(false);
  const [actionError, setActionError] = useState("");
  const onError = (message) => {
    setActionError(message);
    reportError(message);
  };
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
    if (sendingRef.current) return;
    if (!anyChannel || sending || recipientsLoading) return;
    const via = sendEmail && sendSms ? "both" : sendEmail ? "email" : "sms";
    sendingRef.current = true;
    setActionError("");
    setSending(true);
    try {
      const res = await adminFetch(
        `/admin/invoices/${invoice.id}/send-receipt`,
        {
          method: "POST",
          body: JSON.stringify({
            memo: memo.trim() || undefined,
            via,
          }),
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
      sendingRef.current = false;
      setSending(false);
    }
  };
  return (
    <Dialog open={true} onClose={sending ? undefined : onClose} layer={400}>
      <DialogBody className="space-y-4 text-ui-body text-zinc-900">
        <DialogTitle>Send receipt & close</DialogTitle>
        {actionError && <ActionFeedback error>{actionError}</ActionFeedback>}
        <div
          style={{
            marginBottom: 20,
          }}
          className="text-ui-body text-ink-secondary"
        >
          Invoice #{invoice.invoice_number} · $
          {parseFloat(invoice.total).toFixed(2)} · {invoice.first_name}{" "}
          {invoice.last_name}
        </div>
        <Field label={<>Optional memo</>} className="min-w-0">
          <Textarea
            value={memo}
            onChange={(e) => setMemo(e.target.value.slice(0, 400))}
            placeholder="e.g. Left a spare trap in the garage — rebait in 2 weeks."
            rows={3}
            style={{
              resize: "vertical",
            }}
            disabled={sending}
          />
        </Field>
        <div
          style={{
            textAlign: "right",
            marginTop: 4,
            marginBottom: 18,
          }}
          className="text-ui-body text-ink-secondary"
        >
          {memo.length}/400
        </div>
        {recipientLookupError && (
          <div
            style={{
              marginBottom: 12,
              padding: "10px 12px",
              border: "1px solid #52525B",
              lineHeight: 1.45,
            }}
            className="bg-zinc-100 rounded-md text-ui-body text-zinc-900"
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
            className="ui-choice-label flex items-center gap-2 text-ui-body text-zinc-900"
          >
            {" "}
            <Checkbox
              checked={sendEmail && hasEmail}
              onChange={(e) => setSendEmail(e.target.checked)}
              style={{
                width: 16,
                accentColor: "#18181B",
              }}
              disabled={sending || !hasEmail || recipientsLoading}
            />{" "}
            <span className="text-ui-body text-zinc-900">
              Email{" "}
              {recipientsLoading ? (
                <span className="text-ink-secondary">· loading recipient</span>
              ) : receiptEmail ? (
                <span className="text-ink-secondary">
                  · {receiptEmail} · {contactRoleLabel(receiptEmailRole)}
                </span>
              ) : (
                <span
                  style={{
                    fontStyle: "italic",
                  }}
                  className="text-ink-secondary"
                >
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
            className="ui-choice-label flex items-center gap-2 text-ui-body text-zinc-900"
          >
            {" "}
            <Checkbox
              checked={sendSms && hasPhone}
              onChange={(e) => setSendSms(e.target.checked)}
              style={{
                width: 16,
                accentColor: "#18181B",
              }}
              disabled={sending || !hasPhone || recipientsLoading}
            />{" "}
            <span className="text-ui-body text-zinc-900">
              SMS{" "}
              {recipientsLoading ? (
                <span className="text-ink-secondary">· loading recipient</span>
              ) : receiptPhone ? (
                <span className="text-ink-secondary">· {receiptPhone}</span>
              ) : (
                <span
                  style={{
                    fontStyle: "italic",
                  }}
                  className="text-ink-secondary"
                >
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
              border: "1px solid #52525B",
              lineHeight: 1.45,
            }}
            className="bg-zinc-100 rounded-md text-ui-body text-zinc-900"
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
          <Button
            onClick={onClose}
            disabled={sending}
            variant={"secondary"}
            onClickCapture={(event) =>
              event.currentTarget.focus({
                preventScroll: true,
              })
            }
            className="min-w-11"
          >
            Cancel
          </Button>{" "}
          <Button
            onClick={handleSend}
            disabled={!anyChannel || sending || recipientsLoading}
            variant={"primary"}
            onClickCapture={(event) =>
              event.currentTarget.focus({
                preventScroll: true,
              })
            }
            className="min-w-11"
            loading={sending}
          >
            {"Send receipt"}
          </Button>{" "}
        </div>
      </DialogBody>
    </Dialog>
  );
}

// ── Apply Credit Modal ──
// Draws down the customer's account credit to cover this invoice. Fully
// covering the full amount due marks the invoice prepaid. Account credit is
// the holding bucket for money paid ahead (quarterly prepay) or goodwill,
// issued from Customer 360. Partial application is deliberately not offered —
// a remaining balance would still be charged in full by the Stripe/Terminal
// pay paths, so credit must cover the whole invoice.
function ApplyCreditModal({
  invoice,
  isMobile,
  onClose,
  onApplied,
  onError: reportError,
}) {
  const savingRef = useRef(false);
  const [actionError, setActionError] = useState("");
  const onError = (message) => {
    setActionError(message);
    reportError(message);
  };
  const [loading, setLoading] = useState(true);
  const [ctx, setCtx] = useState(null);
  const [readError, setReadError] = useState("");
  const [readAttempt, setReadAttempt] = useState(0);
  const [waiveSetupFee, setWaiveSetupFee] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setReadError("");
    (async () => {
      try {
        const data = await adminFetch(
          `/admin/invoices/${invoice.id}/credit-context`,
        );
        if (!alive) return;
        setCtx(data);
      } catch (err) {
        if (alive) setReadError(`Couldn't load account credit: ${err.message}`);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [invoice.id, readAttempt]);
  const balance = Number(ctx?.balance || 0);
  const amountDue = Number(ctx?.amount_due || 0);
  const canCover = amountDue > 0 && balance + 0.005 >= amountDue;
  const shortfall = Math.max(0, amountDue - balance);
  const canApply = !loading && !readError && !saving && canCover;
  const handleApply = async () => {
    if (savingRef.current) return;
    if (!canApply) return;
    savingRef.current = true;
    setActionError("");
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
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <Dialog open={true} onClose={saving ? undefined : onClose} layer={400}>
      <DialogBody className="space-y-4 text-ui-body text-zinc-900">
        <DialogTitle>Apply account credit</DialogTitle>
        {actionError && <ActionFeedback error>{actionError}</ActionFeedback>}
        <div
          style={{
            marginBottom: 20,
          }}
          className="text-ui-body text-ink-secondary"
        >
          Invoice #{invoice.invoice_number} · {invoice.first_name}{" "}
          {invoice.last_name}
        </div>
        {loading ? (
          <div
            style={{
              padding: "20px 0",
            }}
            className="text-ui-body text-ink-secondary"
          >
            Loading account credit…
          </div>
        ) : readError ? (
          <ActionFeedback
            error
            onRetry={() => setReadAttempt((attempt) => attempt + 1)}
          >
            {readError}
          </ActionFeedback>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                marginBottom: 16,
                padding: "12px 14px",
                border: "1px solid #E4E4E7",
              }}
              className="bg-zinc-100 rounded-md"
            >
              <div>
                <div className="text-ui-body text-ink-secondary">
                  Available credit
                </div>
                <div
                  className={cn(
                    "text-18",
                    "font-medium",
                    balance > 0 ? "text-zinc-900" : "text-ink-secondary",
                  )}
                >
                  ${balance.toFixed(2)}
                </div>
              </div>
              <div
                style={{
                  textAlign: "right",
                }}
              >
                <div className="text-ui-body text-ink-secondary">
                  Amount due
                </div>
                <div className="text-18 font-medium text-zinc-900">
                  ${amountDue.toFixed(2)}
                </div>
              </div>
            </div>

            {!canCover ? (
              <div
                style={{
                  marginBottom: 8,
                  lineHeight: 1.5,
                }}
                className="text-ui-body text-ink-secondary"
              >
                {balance <= 0
                  ? "This customer has no account credit. "
                  : `Available credit ($${balance.toFixed(2)}) doesn't cover the $${amountDue.toFixed(2)} due — $${shortfall.toFixed(2)} short. `}
                Credit must cover the invoice in full. Issue more credit from
                the customer's profile (Customer 360 → Account credit), or lower
                the invoice, then try again.
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
                  className="ui-choice-label flex items-center gap-2 text-ui-body text-zinc-900"
                >
                  <Checkbox
                    checked={waiveSetupFee}
                    onChange={(e) => setWaiveSetupFee(e.target.checked)}
                    style={{
                      width: 16,
                      accentColor: "#18181B",
                    }}
                    disabled={saving}
                  />
                  <span className="text-ui-body text-zinc-900">
                    Waive initial / setup fee
                    <span
                      style={{
                        marginLeft: 6,
                        fontStyle: "italic",
                      }}
                      className="text-ink-secondary"
                    >
                      · records the waiver on this invoice
                    </span>
                  </span>
                </label>

                <Field className="min-w-0" label={<>Note (optional)</>}>
                  <Textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                    placeholder="e.g. Q3 prepay collected by phone"
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      resize: "vertical",
                    }}
                    disabled={saving}
                  />
                </Field>

                <div
                  style={{
                    marginTop: 14,
                    padding: "10px 12px",
                    border: "1px solid #E4E4E7",
                    lineHeight: 1.45,
                  }}
                  className="bg-zinc-100 rounded-md text-ui-body text-ink-secondary"
                >
                  Applies ${amountDue.toFixed(2)} from account credit, marks the
                  invoice prepaid, and stops automated reminders.
                </div>
              </>
            )}
          </>
        )}
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 20,
          }}
        >
          <Button
            onClick={onClose}
            disabled={saving}
            variant={"secondary"}
            onClickCapture={(event) =>
              event.currentTarget.focus({
                preventScroll: true,
              })
            }
            className="min-w-11"
          >
            Cancel
          </Button>
          <Button
            onClick={handleApply}
            disabled={!canApply}
            variant={"primary"}
            onClickCapture={(event) =>
              event.currentTarget.focus({
                preventScroll: true,
              })
            }
            className="min-w-11"
            loading={saving}
          >
            {"Apply & mark prepaid"}
          </Button>
        </div>
      </DialogBody>
    </Dialog>
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
  onError: reportError,
}) {
  const savingRef = useRef(false);
  const [actionError, setActionError] = useState("");
  const onError = (message) => {
    setActionError(message);
    reportError(message);
  };
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
        : method === "venmo"
          ? "Venmo transaction ID"
          : method === "paypal"
            ? "PayPal transaction ID"
            : method === "other"
              ? "Reference"
              : "Reference (optional)";
  const referencePlaceholder =
    method === "check"
      ? "e.g. 1042"
      : method === "zelle"
        ? "e.g. RP1ABCXYZ"
        : method === "venmo"
          ? "e.g. 4123456789012345678 or @handle"
          : method === "paypal"
            ? "e.g. 1AB23456CD789012E"
            : method === "other"
              ? "e.g. money order #"
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
    if (savingRef.current) return;
    if (recordDisabled) return;
    savingRef.current = true;
    setActionError("");
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
      savingRef.current = false;
      setSaving(false);
    }
  };
  const methodChoice = (key, label) => (
    <Button
      key={key}
      type="button"
      onClick={() => setMethod(key)}
      style={{
        flex: 1,
      }}
      variant={method === key ? "primary" : "secondary"}
      onClickCapture={(event) =>
        event.currentTarget.focus({
          preventScroll: true,
        })
      }
      className="min-w-11"
      aria-pressed={method === key}
      disabled={saving}
    >
      {label}
    </Button>
  );
  return (
    <Dialog open={true} onClose={saving ? undefined : onClose} layer={400}>
      <DialogBody className="space-y-4 text-ui-body text-zinc-900">
        <DialogTitle>Add payment</DialogTitle>
        {actionError && <ActionFeedback error>{actionError}</ActionFeedback>}
        <div
          style={{
            marginBottom: 20,
          }}
          className="text-ui-body text-ink-secondary"
        >
          Invoice #{invoice.invoice_number} · $
          {parseFloat(invoice.total).toFixed(2)} · {invoice.first_name}{" "}
          {invoice.last_name}
        </div>
        <label
          style={{
            display: "block",
            marginBottom: 8,
          }}
          className="text-ui-body font-medium text-zinc-900"
        >
          Payment method
        </label>
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
          {methodChoice("venmo", "Venmo")}
          {methodChoice("paypal", "PayPal")}
          {methodChoice("other", "Other")}
        </div>
        <Field label={<>{referenceLabel}</>} className="min-w-0">
          <Input
            value={reference}
            onChange={(e) => setReference(e.target.value.slice(0, 200))}
            placeholder={referencePlaceholder}
            disabled={saving}
          />
        </Field>
        <Field label={<>Note (optional)</>} className="min-w-0">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 400))}
            placeholder="e.g. Customer dropped check off at the office"
            rows={2}
            style={{
              resize: "vertical",
            }}
            disabled={saving}
          />
        </Field>
        <div
          style={{
            textAlign: "right",
            marginTop: 4,
            marginBottom: 14,
          }}
          className="text-ui-body text-ink-secondary"
        >
          {note.length}/400
        </div>
        {recipientLookupError && (
          <div
            style={{
              marginBottom: 12,
              padding: "10px 12px",
              border: "1px solid #52525B",
              lineHeight: 1.45,
            }}
            className="bg-zinc-100 rounded-md text-ui-body text-zinc-900"
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
          className="ui-choice-label flex items-center gap-2 text-ui-body text-zinc-900"
        >
          {" "}
          <Checkbox
            checked={sendReceipt && hasContact}
            onChange={(e) => setSendReceipt(e.target.checked)}
            style={{
              width: 16,
              accentColor: "#18181B",
            }}
            disabled={saving || !hasContact || recipientsLoading}
          />{" "}
          <span className="text-ui-body text-zinc-900">
            Send receipt now
            {recipientsLoading ? (
              <span
                style={{
                  marginLeft: 6,
                }}
                className="text-ink-secondary"
              >
                · loading recipients
              </span>
            ) : hasContact ? (
              <span
                style={{
                  marginLeft: 6,
                }}
                className="text-ink-secondary"
              >
                · {receiptChannels.join(" + ")}
              </span>
            ) : (
              <span
                style={{
                  marginLeft: 6,
                  fontStyle: "italic",
                }}
                className="text-ink-secondary"
              >
                · no email or phone on file
              </span>
            )}
          </span>{" "}
        </label>
        <div
          style={{
            marginTop: 14,
            padding: "10px 12px",
            border: "1px solid #E4E4E7",
            lineHeight: 1.45,
          }}
          className="bg-zinc-100 rounded-md text-ui-body text-ink-secondary"
        >
          Marks this invoice paid and stops automated reminders. Use only after
          the money has actually arrived.
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 20,
          }}
        >
          {" "}
          <Button
            onClick={onClose}
            disabled={saving}
            variant={"secondary"}
            onClickCapture={(event) =>
              event.currentTarget.focus({
                preventScroll: true,
              })
            }
            className="min-w-11"
          >
            Cancel
          </Button>{" "}
          <Button
            onClick={handleRecord}
            disabled={recordDisabled}
            variant={"primary"}
            onClickCapture={(event) =>
              event.currentTarget.focus({
                preventScroll: true,
              })
            }
            className="min-w-11"
            loading={saving}
          >
            {sendReceipt && recipientsLoading
              ? "Loading recipients…"
              : sendReceipt && hasContact
                ? "Record & send receipt"
                : "Record payment"}
          </Button>{" "}
        </div>
      </DialogBody>
    </Dialog>
  );
}

// Cadence → default visit count, mirroring the Customer 360 annual-prepay form
// (and the server's coverageCadence normalization). Picking a cadence presets
// the visit count; the operator can still override it.
const ANNUAL_PREPAY_CADENCE_OPTIONS = [
  {
    value: "monthly",
    label: "Monthly",
    visits: 12,
  },
  {
    value: "bimonthly",
    label: "Every 2 months",
    visits: 6,
  },
  {
    value: "quarterly",
    label: "Quarterly",
    visits: 4,
  },
  {
    value: "triannual",
    label: "Every 4 months",
    visits: 3,
  },
  {
    value: "semiannual",
    label: "Semiannual",
    visits: 2,
  },
  {
    value: "every_6_weeks",
    label: "Every 6 weeks",
    visits: 9,
  },
  {
    value: "annual",
    label: "Annual",
    visits: 1,
  },
];
const ANNUAL_PREPAY_CADENCE_VISITS = Object.fromEntries(
  ANNUAL_PREPAY_CADENCE_OPTIONS.map((option) => [
    option.value,
    String(option.visits),
  ]),
);

// Flags an existing invoice as an annual prepayment so the customer-facing
// coverage banner renders on the pay page + PDF. When a service type + visit
// count are set, paying the invoice also auto-marks that many scheduled visits
// prepaid (so completing them doesn't re-invoice the prepaid customer).
// Prefills from the linked term when one already exists (edit mode), otherwise
// from the invoice itself.
function AnnualPrepayModal({
  invoice,
  isMobile,
  onClose,
  onSaved,
  onError: reportError,
}) {
  const [readError, setReadError] = useState("");
  const [readAttempt, setReadAttempt] = useState(0);
  const savingRef = useRef(false);
  const [actionError, setActionError] = useState("");
  const onError = (message) => {
    setActionError(message);
    reportError(message);
  };
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
  const [serviceType, setServiceType] = useState("");
  const [cadence, setCadence] = useState("quarterly");
  // Whether `cadence` reflects a real choice (stored on the term, or picked by
  // the operator) vs. the untouched default. We only send cadence when it's
  // explicit; otherwise we omit it so the server's authoritative inference
  // (label-first, then visit count) decides — the client must not overwrite a
  // legacy term's schedule with the default "quarterly".
  const [cadenceExplicit, setCadenceExplicit] = useState(false);
  const [visitCount, setVisitCount] = useState("4");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    let alive = true;
    setReadError("");
    setLoading(true);
    adminFetch(`/admin/invoices/${invoice.id}`)
      .then((data) => {
        if (!alive) return;
        const term = data?.annual_prepay;
        // The customer's real recurring coverage (server-derived: service label
        // + the cadence the server would infer; never the invoice title). Used
        // only to seed a brand-new term's covered service/cadence/visit count.
        const suggested = data?.suggested_coverage || null;
        if (term) {
          setExisting(term);
          if (term.termStart)
            setStart(invoiceDateOnly(term.termStart) || start);
          if (term.coverageMonths) setMonths(term.coverageMonths);
          if (term.planLabel) setPlanLabel(term.planLabel);
          if (term.prepayAmount != null) {
            setAmount(String(Number(term.prepayAmount).toFixed(2)));
          }
          // Reflect the stored coverage exactly. A display-only term has no
          // coverage service type — keep it blank so an unrelated edit doesn't
          // silently convert it into visit coverage.
          setServiceType(term.coverageServiceType || "");
          if (term.coverageVisitCount != null) {
            setVisitCount(String(term.coverageVisitCount));
          }
          // Only adopt a stored cadence as explicit. If the term predates the
          // cadence column (null), leave it non-explicit so we omit it on save
          // and the server re-infers from the service label / visit count
          // instead of us overwriting the schedule with the default.
          if (term.coverageCadence) {
            setCadence(term.coverageCadence);
            setCadenceExplicit(true);
          }
        } else if (suggested?.serviceType) {
          // Brand-new term: default the covered service to the customer's real
          // recurring service so the standard Mark-prepaid flow auto-covers the
          // visits. Also adopt the server-inferred cadence (and its visit count)
          // so a non-quarterly plan isn't stamped as quarterly. Marked explicit
          // since it's a real suggestion. Operator can clear/override any of it.
          setServiceType(suggested.serviceType);
          if (suggested.cadence) {
            setCadence(suggested.cadence);
            setCadenceExplicit(true);
            const preset = ANNUAL_PREPAY_CADENCE_VISITS[suggested.cadence];
            if (preset) setVisitCount(preset);
          }
        }
      })
      .catch((error) => {
        if (alive)
          setReadError(`Could not load annual prepay: ${error.message}`);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [invoice.id, readAttempt]);

  // Picking a cadence presets its standard visit count (operator can override).
  const handleCadenceChange = (value) => {
    setCadence(value);
    setCadenceExplicit(true);
    const preset = ANNUAL_PREPAY_CADENCE_VISITS[value];
    if (preset) setVisitCount(preset);
  };
  const trimmedService = serviceType.trim();
  const parsedVisits = parseInt(visitCount, 10);
  const coverageVisitsValid =
    Number.isInteger(parsedVisits) && parsedVisits >= 1 && parsedVisits <= 24;
  // A service type with no valid visit count is incomplete coverage: the server
  // would store the service type but skip stamping (which needs both), leaving
  // an invoice that still re-bills its visits. Block the save in that state.
  const coverageInvalid = trimmedService !== "" && !coverageVisitsValid;
  const handleSave = async () => {
    if (loading || readError) return;
    if (savingRef.current) return;
    if (saving || coverageInvalid) return;
    savingRef.current = true;
    setActionError("");
    setSaving(true);
    try {
      await adminFetch(`/admin/invoices/${invoice.id}/annual-prepay`, {
        method: "POST",
        body: JSON.stringify({
          termStart: start || undefined,
          months: Number(months) || undefined,
          planLabel: planLabel.trim() || undefined,
          prepayAmount: amount !== "" ? Number(amount) : undefined,
          // Coverage: send the service type + visits so payment auto-marks the
          // scheduled visits prepaid. Empty service type → display-only flag.
          coverageServiceType: trimmedService,
          coverageVisitCount:
            trimmedService && coverageVisitsValid ? parsedVisits : undefined,
          // For a NEW term, send the visible cadence so what the form shows is
          // what gets seeded (the server's label-first inference would otherwise
          // override the displayed default). For an EXISTING term, omit it
          // unless explicit, so an unrelated edit never overwrites a legacy
          // null-cadence term's inferred schedule with the default.
          coverageCadence:
            trimmedService && (!existing || cadenceExplicit)
              ? cadence
              : undefined,
        }),
      });
      onSaved(existing ? "Annual prepay updated" : "Marked as annual prepay");
    } catch (err) {
      onError(`Annual prepay failed: ${err.message}`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const handleRemove = async () => {
    if (loading || readError) return;
    if (savingRef.current) return;
    if (removing) return;
    if (
      !confirm(
        "Remove the annual prepay flag from this invoice? The coverage banner will stop showing.",
      )
    )
      return;
    savingRef.current = true;
    setActionError("");
    setRemoving(true);
    try {
      await adminFetch(`/admin/invoices/${invoice.id}/annual-prepay`, {
        method: "DELETE",
      });
      onSaved("Annual prepay removed");
    } catch (err) {
      onError(`Remove failed: ${err.message}`);
    } finally {
      savingRef.current = false;
      setRemoving(false);
    }
  };
  return (
    <Dialog
      open={true}
      layer={400}
      onClose={saving || removing ? undefined : onClose}
    >
      <DialogBody className="space-y-4 text-ui-body text-zinc-900">
        <DialogTitle>
          {existing ? "Annual prepay" : "Mark as annual prepay"}
        </DialogTitle>
        {loading ? (
          <ActionFeedback>Loading annual prepay…</ActionFeedback>
        ) : readError ? (
          <ActionFeedback
            error
            onRetry={() => setReadAttempt((attempt) => attempt + 1)}
          >
            {readError}
          </ActionFeedback>
        ) : null}
        {actionError && <ActionFeedback error>{actionError}</ActionFeedback>}
        <div
          style={{
            marginBottom: 16,
          }}
          className="text-ui-body text-ink-secondary"
        >
          Invoice #{invoice.invoice_number} · {invoice.first_name}{" "}
          {invoice.last_name}
        </div>
        <div
          style={{
            padding: "10px 12px",
            border: "1px solid #E4E4E7",
            lineHeight: 1.45,
          }}
          className="bg-zinc-100 rounded-md text-ui-body text-ink-secondary"
        >
          Adds the "Annual prepayment" coverage banner to the customer's invoice
          (pay page + PDF), showing the dates this payment covers. Use it for a
          customer paying a full year up front. With a service type + visit
          count set below, paying this invoice also auto-marks that many
          scheduled visits prepaid, so completing them won't re-bill the
          customer.
        </div>
        <Field label={<>Coverage start</>} className="min-w-0">
          <Input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            disabled={loading || !!readError || saving || removing}
          />
        </Field>
        <Field label={<>Term length (months)</>} className="min-w-0">
          <Input
            type="number"
            min={1}
            max={60}
            value={months}
            onChange={(e) => setMonths(e.target.value)}
            disabled={loading || !!readError || saving || removing}
          />
        </Field>
        <Field label={<>Service type covered</>} className="min-w-0">
          <Input
            value={serviceType}
            onChange={(e) => setServiceType(e.target.value.slice(0, 100))}
            placeholder="e.g. Quarterly Pest Control"
            disabled={loading || !!readError || saving || removing}
          />
        </Field>
        <div
          style={{
            marginTop: 4,
          }}
          className="text-ui-body text-ink-secondary"
        >
          Match the scheduled visits this covers. Leave blank for a display-only
          flag (no auto-prepaid visits).
        </div>
        <div
          style={{
            display: "flex",
            gap: 12,
          }}
        >
          <div
            style={{
              flex: 1,
            }}
          >
            <Field label={<>Cadence</>} className="min-w-0">
              <Select
                value={cadence}
                onChange={(e) => handleCadenceChange(e.target.value)}
                disabled={
                  loading ||
                  !!readError ||
                  saving ||
                  removing ||
                  saving ||
                  removing
                }
              >
                {ANNUAL_PREPAY_CADENCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div
            style={{
              flex: 1,
            }}
          >
            <Field label={<>Visits covered</>} className="min-w-0">
              <Input
                type="number"
                min={1}
                max={24}
                value={visitCount}
                onChange={(e) => setVisitCount(e.target.value)}
                disabled={
                  loading ||
                  !!readError ||
                  saving ||
                  removing ||
                  saving ||
                  removing
                }
              />
            </Field>
          </div>
        </div>
        {coverageInvalid && (
          <div
            style={{
              marginTop: 4,
            }}
            className="text-ui-body text-alert-fg"
          >
            Enter a visit count (1–24) for this service type, or clear the
            service type for a display-only flag.
          </div>
        )}
        <Field label={<>Plan label</>} className="min-w-0">
          <Input
            value={planLabel}
            onChange={(e) => setPlanLabel(e.target.value.slice(0, 120))}
            placeholder="e.g. WaveGuard Bronze Annual Prepay"
            disabled={loading || !!readError || saving || removing}
          />
        </Field>
        <Field label={<>Prepay amount</>} className="min-w-0">
          <Input
            type="number"
            min={0}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={loading || !!readError || saving || removing}
          />
        </Field>
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
              <Button
                onClick={handleRemove}
                onClickCapture={(event) =>
                  event.currentTarget.focus({
                    preventScroll: true,
                  })
                }
                className="min-w-11"
                disabled={
                  loading ||
                  !!readError ||
                  saving ||
                  removing ||
                  removing ||
                  saving
                }
                variant="danger"
              >
                {removing ? "Removing…" : "Remove"}
              </Button>
            )}
          </div>
          <div
            style={{
              display: "flex",
              gap: 8,
            }}
          >
            <Button
              onClick={onClose}
              disabled={saving || removing}
              variant={"secondary"}
              onClickCapture={(event) =>
                event.currentTarget.focus({
                  preventScroll: true,
                })
              }
              className="min-w-11"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              variant={"primary"}
              onClickCapture={(event) =>
                event.currentTarget.focus({
                  preventScroll: true,
                })
              }
              className="min-w-11"
              loading={saving}
              disabled={
                loading ||
                !!readError ||
                saving ||
                removing ||
                saving ||
                removing ||
                loading ||
                coverageInvalid
              }
            >
              {existing ? "Update" : "Mark prepaid"}
            </Button>
          </div>
        </div>
      </DialogBody>
    </Dialog>
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
  onError: reportError,
}) {
  const savingRef = useRef(false);
  const [actionError, setActionError] = useState("");
  const onError = (message) => {
    setActionError(message);
    reportError(message);
  };
  const total = Number(invoice.total || 0);
  const startDate = todayDateInput();
  const [paymentAmount, setPaymentAmount] = useState(
    Number.isFinite(total) && total > 0
      ? (Math.ceil((total / 3) * 100) / 100).toFixed(2)
      : "",
  );
  const [paymentFrequency, setPaymentFrequency] = useState("monthly");
  const [planStartDate, setPlanStartDate] = useState(startDate);
  const [nextPaymentDate, setNextPaymentDate] = useState(
    addDaysDateInput(startDate, 30),
  );
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const amount = Number(paymentAmount);
  const validAmount = Number.isFinite(amount) && amount > 0 && amount <= total;
  const createDisabled =
    saving || !validAmount || !nextPaymentDate || !planStartDate;
  const createPlan = async () => {
    if (savingRef.current) return;
    if (createDisabled) return;
    savingRef.current = true;
    setActionError("");
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
      savingRef.current = false;
      setSaving(false);
    }
  };
  const frequencyChoice = (key, label) => (
    <Button
      key={key}
      type="button"
      onClick={() => setPaymentFrequency(key)}
      style={{
        flex: 1,
      }}
      variant={paymentFrequency === key ? "primary" : "secondary"}
      onClickCapture={(event) =>
        event.currentTarget.focus({
          preventScroll: true,
        })
      }
      className="min-w-11"
      disabled={saving}
      aria-pressed={paymentFrequency === key}
    >
      {label}
    </Button>
  );
  return (
    <Dialog open={true} onClose={saving ? undefined : onClose} layer={400}>
      <DialogBody className="space-y-4 text-ui-body text-zinc-900">
        <DialogTitle>Create payment plan</DialogTitle>
        {actionError && <ActionFeedback error>{actionError}</ActionFeedback>}
        <div
          style={{
            marginBottom: 20,
          }}
          className="text-ui-body text-ink-secondary"
        >
          Invoice #{invoice.invoice_number} · ${total.toFixed(2)} ·{" "}
          {invoice.first_name} {invoice.last_name}
        </div>
        <Field label={<>Payment amount</>} className="min-w-0">
          <Input
            type="number"
            min="0.01"
            step="0.01"
            value={paymentAmount}
            onChange={(e) => setPaymentAmount(e.target.value)}
            disabled={saving}
          />
        </Field>
        {!validAmount && (
          <div
            style={{
              marginTop: 6,
            }}
            className="text-alert-fg text-ui-body"
          >
            Enter an amount greater than $0 and no more than ${total.toFixed(2)}
            .
          </div>
        )}
        <label
          style={{
            display: "block",
            margin: "16px 0 8px",
          }}
          className="text-ui-body font-medium text-zinc-900"
        >
          Frequency
        </label>
        <div
          style={{
            display: "flex",
            gap: 6,
            marginBottom: 16,
          }}
        >
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
            <Field label={<>Start date</>} className="min-w-0">
              <Input
                type="date"
                value={planStartDate}
                onChange={(e) => setPlanStartDate(e.target.value)}
                disabled={saving}
              />
            </Field>
          </div>
          <div>
            <Field label={<>Next payment</>} className="min-w-0">
              <Input
                type="date"
                value={nextPaymentDate}
                onChange={(e) => setNextPaymentDate(e.target.value)}
                disabled={saving}
              />
            </Field>
          </div>
        </div>
        <Field label={<>Note (optional)</>} className="min-w-0">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value.slice(0, 500))}
            placeholder="e.g. Customer requested three monthly payments"
            rows={3}
            style={{
              resize: "vertical",
            }}
            disabled={saving}
          />
        </Field>
        <div
          style={{
            marginTop: 14,
            padding: "10px 12px",
            border: "1px solid #E4E4E7",
            lineHeight: 1.45,
          }}
          className="bg-zinc-100 rounded-md text-ui-body text-ink-secondary"
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
          <Button
            onClick={onClose}
            disabled={saving}
            variant={"secondary"}
            onClickCapture={(event) =>
              event.currentTarget.focus({
                preventScroll: true,
              })
            }
            className="min-w-11"
          >
            Cancel
          </Button>
          <Button
            onClick={createPlan}
            disabled={createDisabled}
            variant={"primary"}
            onClickCapture={(event) =>
              event.currentTarget.focus({
                preventScroll: true,
              })
            }
            className="min-w-11"
            loading={saving}
          >
            {"Create plan"}
          </Button>
        </div>
      </DialogBody>
    </Dialog>
  );
}

// ── Create Invoice ──
function CreateInvoice({
  showToast: reportToast,
  onCreated,
  editInvoice,
  isMobile,
  onPendingChange,
}) {
  const [discountsLoading, setDiscountsLoading] = useState(true);
  const [discountsError, setDiscountsError] = useState("");
  const [discountsAttempt, setDiscountsAttempt] = useState(0);
  const [customerSearchLoading, setCustomerSearchLoading] = useState(false);
  const [customerSearchError, setCustomerSearchError] = useState("");
  const [customerSearchAttempt, setCustomerSearchAttempt] = useState(0);
  const [serviceRecordsError, setServiceRecordsError] = useState("");
  const [serviceRecordsAttempt, setServiceRecordsAttempt] = useState(0);
  const [serviceSearchLoading, setServiceSearchLoading] = useState(false);
  const [serviceSearchError, setServiceSearchError] = useState("");
  const [serviceSearchAttempt, setServiceSearchAttempt] = useState(0);
  const [actionError, setActionError] = useState("");
  const showToast = (message, tone = "ok") => {
    if (tone === "error" || message.startsWith("Error:"))
      setActionError(message);
    reportToast(message, tone);
  };
  const savingRef = useRef(false);
  const aiNotesLoadingRef = useRef(false);
  const aiMessageLoadingRef = useRef(false);
  // Set ({ invoice, reason }) when POST /admin/invoices succeeded but
  // /schedule-send failed: the invoice row EXISTS, so the editable builder
  // must not render for it again — every editable-retry variant leaked
  // (duplicate create on customer reselect, un-synced fields/attachments).
  // A recovery panel replaces the form and operates only on the persisted
  // row: adjust time + retry schedule, send now, or keep as draft.
  const [pendingScheduleInvoice, setPendingScheduleInvoice] = useState(null);
  const [retryScheduleAt, setRetryScheduleAt] = useState("");
  const editMode = !!editInvoice;
  // Editing an invoice the customer already received: the copy in their inbox
  // is stale until Adam resends, so the form shows a reminder and the save
  // path prompts the resend modal.
  const editingDelivered =
    editMode && ["sent", "viewed", "overdue"].includes(editInvoice.status);
  // One-tap AI summary (pulls context from the linked visit + source toggles).
  // Off by default; the base "Write with AI" still works from typed input + lines.
  const aiSummaryEnabled = useFeatureFlag("ff_invoice_ai_summary");
  // Optional AI-assisted personal thank-you message in the invoice email body
  // (separate from the service summary). Off by default.
  const emailMessageEnabled = useFeatureFlag("ff_invoice_email_message");
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
  // The customer's OPEN visits (pending/confirmed/en route/on site) — an
  // invoice raised before the closeout links to its visit here, so the
  // completion reuses it instead of minting a second one.
  const [openVisits, setOpenVisits] = useState([]);
  const [selectedOpenVisit, setSelectedOpenVisit] = useState(null);
  // The balance the server said it would actually bill (409 BALANCE_CHANGED),
  // keyed to the form state it was computed for — the summary shows it and
  // the next Create sends it as the approved balance.
  const [confirmedBalance, setConfirmedBalance] = useState(null);
  // The linked visit left the open list on a reload (completed or prepaid
  // between the preview and the create). The link is kept — never silently
  // dropped into an unlinked create, which would bypass invoice adoption
  // and the prepaid guards — and Create is blocked until the operator picks
  // again with the visit's new state in view.
  const linkedVisitGone = isLinkedVisitGone(selectedOpenVisit, openVisits);
  const [serviceDate, setServiceDate] = useState(defaultServiceDate);
  const [lineItems, setLineItems] = useState(() => [newLineItem()]);
  const [notes, setNotes] = useState("");
  const [emailMessage, setEmailMessage] = useState("");
  const [aiMessageLoading, setAiMessageLoading] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [sendTiming, setSendTiming] = useState("now");
  const [sendCustomAt, setSendCustomAt] = useState("");
  const [dueTiming, setDueTiming] = useState("today");
  const [dueCustomDate, setDueCustomDate] = useState("");
  const [requestReview, setRequestReview] = useState(false);
  // ONE effective value for the review ask (Codex P2 r6 #4131): a linked
  // open visit blocks the ask, and the checkbox renders unchecked +
  // disabled — but the underlying state may still be true (enabled, Custom
  // chosen with no date, THEN the visit linked). Rendering the controls
  // and validating Create from the raw state while the checkbox shows the
  // ask as off blocked Create on "Choose a review request time" for an ask
  // the form said was not being made. Every reader below uses this.
  const reviewRequestActive = requestReview && !openVisitReviewRequestBlocked(selectedOpenVisit);
  const [reviewTiming, setReviewTiming] = useState("120");
  const [reviewCustomAt, setReviewCustomAt] = useState("");
  const [serviceSearchIdx, setServiceSearchIdx] = useState(null);
  const [serviceResults, setServiceResults] = useState([]);
  const [availableDiscounts, setAvailableDiscounts] = useState([]);
  const [discountSearchIdx, setDiscountSearchIdx] = useState(null);
  const [discountQueries, setDiscountQueries] = useState({});
  const [aiNotesLoading, setAiNotesLoading] = useState(false);
  const [aiSources, setAiSources] = useState({
    jobSummary: true,
    forms: true,
    lineItems: true,
  });
  const [queuedAttachments, setQueuedAttachments] = useState([]);
  const attachmentInputRef = useRef(null);
  // Snapshot of the line items as loaded in edit mode, so a save that didn't
  // touch them can omit line_items entirely and skip the server retotal —
  // which would otherwise revalidate (and reject) discounts that have since
  // been disabled/hidden on an otherwise-valid open draft.
  const editLineItemsBaselineRef = useRef(null);

  // Load active, invoice-visible discounts once. Tier discounts are included here
  // for explicit line-level selection; customer tier never applies a hidden discount.
  const builderBusy = saving || aiNotesLoading || aiMessageLoading;
  useEffect(() => {
    onPendingChange(saving || aiNotesLoading || aiMessageLoading);
    return () => onPendingChange(false);
  }, [saving, aiNotesLoading, aiMessageLoading, onPendingChange]);
  useEffect(() => {
    let alive = true;
    setDiscountsLoading(true);
    setDiscountsError("");
    adminFetch("/admin/discounts")
      .then((data) => {
        if (alive)
          setAvailableDiscounts(
            (Array.isArray(data) ? data : data.discounts || []).filter(
              (discount) => discount.is_active && discount.show_in_invoices,
            ),
          );
      })
      .catch((error) => {
        if (alive) setDiscountsError(error.message || "Discounts unavailable");
      })
      .finally(() => {
        if (alive) setDiscountsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [discountsAttempt]);

  // Edit mode: prefill the builder from the existing draft. Only the fields
  // the PUT /admin/invoices/:id route actually persists are loaded into editable
  // state (line items, notes, due date); the customer and service date are shown
  // read-only because the update route never rewrites them. We use the customer's
  // CURRENT property_type (from the list row) for taxability — the server
  // retotal forces residential tax to zero regardless of the stored rate, so
  // deriving taxability from the stored rate would mismatch the saved total when
  // a customer's type changed after the invoice was created.
  useEffect(() => {
    if (!editMode) return;
    setSelectedCustomer({
      id: editInvoice.customer_id,
      first_name: editInvoice.first_name,
      last_name: editInvoice.last_name,
      phone: editInvoice.phone,
      email: editInvoice.email,
      waveguard_tier: editInvoice.waveguard_tier,
      property_type:
        editInvoice.property_type ||
        (Number(editInvoice.tax_rate) > 0 ? "commercial" : "residential"),
    });
    const stored =
      typeof editInvoice.line_items === "string"
        ? (() => {
            try {
              return JSON.parse(editInvoice.line_items);
            } catch {
              return [];
            }
          })()
        : editInvoice.line_items || [];
    const prefilled = (Array.isArray(stored) ? stored : []).map((item) => ({
      ...item,
      client_id: item.client_id || newLineItem().client_id,
    }));
    const initialLineItems = prefilled.length ? prefilled : [newLineItem()];
    setLineItems(initialLineItems);
    editLineItemsBaselineRef.current = JSON.stringify(initialLineItems);
    setNotes(editInvoice.notes || "");
    setEmailMessage(editInvoice.email_message || "");
    setTitle(editInvoice.title || "");
    const due = invoiceDateOnly(editInvoice.due_date);
    if (due) {
      setDueTiming("custom");
      setDueCustomDate(due);
    }
    const svc = invoiceDateOnly(editInvoice.service_date);
    if (svc) setServiceDate(svc);
    // Deliberately keyed on the edited invoice only (react-hooks/
    // exhaustive-deps isn't configured in the errors-only lint config — a
    // disable directive for it is itself an unknown-rule error).
  }, [editMode, editInvoice]);

  // Customer search
  useEffect(() => {
    if (editMode) return;
    let alive = true;
    setCustomerSearchError("");
    setCustomers([]);
    if (customerQuery.length < 2) {
      setCustomerSearchLoading(false);
      return;
    }
    setCustomerSearchLoading(true);
    const timer = setTimeout(() => {
      adminFetch(
        "/admin/invoices/customers/search?q=" +
          encodeURIComponent(customerQuery),
      )
        .then((data) => {
          if (alive) setCustomers(data.customers || []);
        })
        .catch((error) => {
          if (alive)
            setCustomerSearchError(
              error.message || "Customer search unavailable",
            );
        })
        .finally(() => {
          if (alive) setCustomerSearchLoading(false);
        });
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [customerQuery, customerSearchAttempt, editMode]);

  // Load service records when customer selected (skip in edit mode — the
  // service-history linker is hidden and the update route can't relink it).
  // The picker feed: completed records + open visits (each with the deposit
  // credit the linked mint will apply). Re-read after a deposit-drift
  // refusal below, so the summary shows the credit that will actually apply.
  // Stale-response guard (pre-push P1 r3): the customer the picker is
  // currently for. A response for any other customer — or one that lands
  // after the customer was cleared — is dropped, never applied. Returns
  // null in that case so conflict-triggered reloads skip their follow-up.
  const visitPickerCustomerRef = useRef(null);
  const loadVisitPicker = async (customerId) => {
    const d = await adminFetch(`/admin/invoices/service-records/${customerId}`);
    if (!visitPickerResponseIsCurrent(visitPickerCustomerRef.current, customerId)) return null;
    setServiceRecords(d.records || []);
    const visits = d.openVisits || [];
    setOpenVisits(visits);
    return visits;
  };
  useEffect(() => {
    let alive = true;
    visitPickerCustomerRef.current = !editMode && selectedCustomer ? selectedCustomer.id : null;
    setServiceRecords([]);
    setOpenVisits([]);
    setServiceRecordsError("");
    if (editMode || !selectedCustomer) return;
    loadVisitPicker(selectedCustomer.id).catch((error) => {
      if (alive) setServiceRecordsError(error.message || "Service history unavailable");
    });
    return () => {
      alive = false;
    };
  }, [selectedCustomer, serviceRecordsAttempt, editMode]);

  // Service library search for active line item
  useEffect(() => {
    let alive = true;
    setServiceResults([]);
    setServiceSearchError("");
    const query =
      serviceSearchIdx === null
        ? ""
        : lineItems[serviceSearchIdx]?.description || "";
    if (query.length < 2) {
      setServiceSearchLoading(false);
      return;
    }
    setServiceSearchLoading(true);
    const timer = setTimeout(() => {
      adminFetch(
        "/admin/services?search=" +
          encodeURIComponent(query) +
          "&is_active=true&limit=10",
      )
        .then((data) => {
          if (alive) setServiceResults(data.services || []);
        })
        .catch((error) => {
          if (alive)
            setServiceSearchError(
              error.message || "Service catalog unavailable",
            );
        })
        .finally(() => {
          if (alive) setServiceSearchLoading(false);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [serviceSearchIdx, lineItems, serviceSearchAttempt]);
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
              {
                ...discount,
                amount: customPercentage,
              },
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
        ? {
            custom_discount_amount: custom.custom_discount_amount,
          }
        : {}),
      ...(custom?.custom_discount_percentage
        ? {
            custom_discount_percentage: custom.custom_discount_percentage,
          }
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
  // In edit mode mirror the server retotal exactly: tax applies only when the
  // CURRENT customer is commercial (residential is forced to zero server-side),
  // and at the invoice's stored rate (which may not be exactly 7%). Gating on
  // the live property_type keeps the preview honest if the customer's type
  // changed after the invoice was created.
  const taxRate = editMode
    ? isCommercial
      ? Number(editInvoice.tax_rate) || 0
      : 0
    : isCommercial
      ? 0.07
      : 0;
  const tax = afterDiscount * taxRate;
  const total = afterDiscount + tax;
  // An open visit's pending estimate deposit is credited automatically when
  // the linked invoice is created — preview it so the operator sees the
  // balance the customer will actually be sent (surcharge follows the balance).
  const { depositCredit, previewBalanceDue } = previewLinkedBalance({ selectedOpenVisit, total });
  // The server's authoritative balance (tax rate / exemption on file) once
  // it refused the preview — shown in its place while the form still
  // matches the state it was computed for.
  const balanceKey = openVisitBalanceKey({ selectedOpenVisit, lineItems });
  const { serverBalance, balanceDue } = resolveLinkedBalance({ confirmedBalance, balanceKey, previewBalanceDue });
  const cardCharge = computeCardTotal(balanceDue);

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

  // The completed visit this invoice is tied to — set when picking a service
  // in create mode, or carried on the invoice row in edit mode.
  const linkedServiceRecordId =
    selectedService?.id || editInvoice?.service_record_id || null;
  const handleWriteNotesWithAI = async () => {
    if (aiNotesLoadingRef.current) return;
    const usableLines = lineItems.filter(
      (i) => i._kind !== "discount" && i.description,
    );
    const canPullVisit = aiSummaryEnabled && !!linkedServiceRecordId;
    if (!notes.trim() && usableLines.length === 0 && !canPullVisit) {
      showToast("Add notes or services first");
      return;
    }
    aiNotesLoadingRef.current = true;
    setAiNotesLoading(true);
    try {
      const result = await adminFetch("/admin/invoices/notes/ai", {
        method: "POST",
        body: JSON.stringify({
          input: notes,
          customerName: selectedCustomer
            ? `${selectedCustomer.first_name || ""} ${selectedCustomer.last_name || ""}`.trim()
            : "",
          // Required server-side to scope the visit lookup to THIS customer.
          customerId: selectedCustomer?.id || editInvoice?.customer_id || null,
          services: usableLines.map((item) => ({
            description: item.description,
            quantity: Number(item.quantity) || 1,
          })),
          ...(canPullVisit
            ? {
                serviceRecordId: linkedServiceRecordId,
                sources: aiSources,
              }
            : {}),
        }),
      });
      if (result.notes) {
        setNotes(result.notes);
        showToast("Summary written with AI");
      } else {
        showToast("AI did not return a summary");
      }
    } catch (e) {
      showToast(`AI summary failed: ${e.message}`, "error");
    }
    aiNotesLoadingRef.current = false;
    setAiNotesLoading(false);
  };
  const handleWriteThankYouWithAI = async () => {
    if (aiMessageLoadingRef.current) return;
    const customerName = selectedCustomer
      ? `${selectedCustomer.first_name || ""} ${selectedCustomer.last_name || ""}`.trim()
      : "";
    const serviceType =
      selectedService?.service_type || editInvoice?.service_type || title || "";
    if (!customerName && !serviceType && !emailMessage.trim()) {
      showToast("Select a customer first");
      return;
    }
    aiMessageLoadingRef.current = true;
    setAiMessageLoading(true);
    try {
      const result = await adminFetch("/admin/invoices/email-message/ai", {
        method: "POST",
        body: JSON.stringify({
          customerName,
          serviceType,
          input: emailMessage,
        }),
      });
      if (result.message) {
        setEmailMessage(result.message);
        showToast("Thank-you message written with AI");
      } else {
        showToast("AI did not return a message");
      }
    } catch (e) {
      showToast(`AI message failed: ${e.message}`, "error");
    }
    aiMessageLoadingRef.current = false;
    setAiMessageLoading(false);
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

  // Create-step 3 — recovery after a refused create (nothing was created).
  // A BALANCE_CHANGED refusal keeps the server's figures for this exact
  // form state (the summary shows them; the next Create sends them as
  // approved). Every visit-state conflict (deposit drift, completed,
  // prepaid, already invoiced, repriced) reloads the picker so the summary
  // shows what will actually apply; a visit that left the open list STAYS
  // selected — linkedVisitGone then blocks Create instead of retrying
  // unlinked (or retrying the same 409 forever).
  const recoverFromCreateError = async (e) => {
    showToast(`Error: ${e.message}`);
    const confirmed = confirmedBalanceFromError(e, balanceKey);
    if (confirmed) setConfirmedBalance(confirmed);
    if (!reloadsVisitPickerAfterCreateError(e.code) || !selectedOpenVisit) return;
    try {
      const visits = await loadVisitPicker(selectedCustomer.id);
      if (!visits) return; // the customer changed underneath — the new customer's own load owns the state
      setSelectedOpenVisit((current) => reconcileSelectedOpenVisit(current, visits));
    } catch {
      /* the toast already asks for a reload */
    }
  };

  const handleCreate = async () => {
    if (savingRef.current) return;
    const dueDate = invoiceDueDate();
    const scheduledFor = invoiceScheduledFor();
    const reviewDelay = reviewDelayMinutes();
    const blocker = createInvoiceBlocker({
      selectedCustomer, lineItems, serviceDate, dueDate, sendTiming, scheduledFor, requestReview: reviewRequestActive, reviewDelay, linkedVisitGone, selectedOpenVisit,
    });
    if (blocker) {
      showToast(blocker);
      return;
    }
    savingRef.current = true;
    setActionError("");
    setSaving(true);
    try {
      const body = {
        customerId: selectedCustomer.id,
        serviceRecordId: selectedService?.id || null,
        scheduledServiceId: selectedOpenVisit?.id || null,
        // The PENDING deposit the summary previewed (uncapped — the server
        // caps it at ITS total, which carries tax exemptions and county
        // rates this preview does not): the server refuses the create (409
        // DEPOSIT_CREDIT_CHANGED) when the deposit moved since, so the
        // customer is never sent a balance the operator did not see —
        // nothing is created, nothing is sent.
        // And the BALANCE the operator approved (the server-confirmed one
        // after a BALANCE_CHANGED refusal): the server compares the created
        // row's authoritative total inside the transaction and refuses
        // when the tax/exemption on file makes it differ — nothing created.
        ...openVisitCreateExpectations({ selectedOpenVisit, balanceDue, confirmedBalance, balanceKey }),
        serviceDate,
        lineItems: lineItems
          .filter((i) => i.description && Number(i.unit_price) !== 0)
          .map((i) => ({
            ...i,
            amount: lineAmount(i),
          })),
        notes: notes || null,
        emailMessage: emailMessage || null,
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
          savingRef.current = false;
          setSaving(false);
          return;
        }
      }
      if (sendTiming === "now" && invoice.id && invoice.payer_statement_id) {
        // A per-job NET-terms payer accrued this invoice to its monthly
        // statement (GATE_PAYER_STATEMENTS): statement children are never
        // sent individually — the send endpoint would refuse and the
        // recovery re-read would offer a Resend that always fails (Codex P2 r8).
        showToast(
          `Invoice created: ${invoice.invoice_number} — accrued to the payer's monthly statement, not sent individually`,
        );
        onCreated();
        savingRef.current = false;
        setSaving(false);
        return;
      }
      if (sendTiming === "now" && invoice.id && (invoice.settledByDeposit || invoice.deliveryHeld)) {
        // The linked visit's estimate deposit covered the whole invoice: the
        // server settled it at creation (prepaid) — there is no balance to
        // text a pay link for, and a send would be refused as not sendable.
        // deliveryHeld = covered but NOT settleable right now (Codex P1 r7):
        // still never send (the server refuses it too); the completion
        // settles it, or the operator retries Send later.
        showToast(
          invoice.settledByDeposit
            ? `Invoice created: ${invoice.invoice_number} — fully covered by the estimate deposit, nothing to send`
            : `Invoice created: ${invoice.invoice_number} — fully covered by the estimate deposit but not settled yet (${invoice.deliveryHeld?.reason || invoice.deliveryHeld?.code}); not sent. It settles at the visit's completion, or retry Send later.`,
        );
        onCreated();
        savingRef.current = false;
        setSaving(false);
        return;
      }
      if (sendTiming === "now" && invoice.id) {
        let sendRes;
        try {
          sendRes = await adminFetch(`/admin/invoices/${invoice.id}/send`, {
            method: "POST",
            body: JSON.stringify({
              // A FIRST delivery, never a resend: a linked invoice the
              // visit's completion already texted between the create and
              // this request is reported already_delivered, not sent again.
              firstDelivery: true,
              requestReview: reviewRequestActive,
              reviewDelayMinutes: reviewDelay,
              reviewTiming,
              reviewScheduledFor:
                reviewTiming === "custom" ? reviewCustomAt : null,
            }),
          });
        } catch (sendErr) {
          // The POST /admin/invoices above already persisted the row — a
          // failed send is a POST-create problem. Never leave the builder
          // open with the same form (the outer catch used to, and the next
          // Create click duplicated the invoice + the send).
          // A rejected request also does not prove the send FAILED: the
          // server may have delivered and committed 'sent' before the
          // response was lost. Re-read the persisted row and offer Resend
          // only when it is provably still unsent — anything else (or an
          // unverifiable state) gets no automatic resend prompt, because a
          // resend on a delivered row duplicates customer comms.
          let persisted = null;
          try {
            persisted = await adminFetch(`/admin/invoices/${invoice.id}`);
          } catch {
            persisted = null;
          }
          const disposition = persistedSendDisposition(persisted);
          if (disposition === "unsent") {
            showToast(
              invoiceCreatedSendFailedToast(
                invoice.invoice_number,
                "sent",
                sendErr,
              ),
            );
            onCreated({
              promptResendId: invoice.id,
            });
          } else if (disposition === "committed") {
            showToast(
              `Invoice created: ${invoice.invoice_number} — the send went through (status: ${persisted.status}) despite a network error`,
            );
            onCreated();
          } else {
            showToast(
              `Invoice created: ${invoice.invoice_number} — send state unknown (${sendErr.message}). Check it in the list before resending.`,
            );
            onCreated();
          }
          savingRef.current = false;
          setSaving(false);
          return;
        }
        showToast(invoiceCreatedSendToast(invoice.invoice_number, sendRes));
      } else if (sendTiming !== "draft" && invoice.id) {
        try {
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
        } catch (schedErr) {
          // Post-create failure: the row exists, so the editable builder
          // must never render for it again (a second Create would duplicate
          // it, and stale form edits would drift from the persisted row).
          // Swap to the recovery panel below.
          setRetryScheduleAt(invoiceScheduledFor() || "");
          setPendingScheduleInvoice({
            invoice,
            reason: schedErr.message || "Scheduling failed",
          });
          showToast(
            invoiceCreatedSendFailedToast(
              invoice.invoice_number,
              "scheduled",
              schedErr,
              "Pick a new time to retry, send now, or keep it as a draft.",
            ),
          );
          savingRef.current = false;
          setSaving(false);
          return;
        }
        showToast(`Invoice scheduled: ${invoice.invoice_number}`);
      } else {
        showToast(`Invoice created: ${invoice.invoice_number} (draft)`);
      }
      onCreated();
    } catch (e) {
      await recoverFromCreateError(e);
    }
    savingRef.current = false;
    setSaving(false);
  };

  // Edit mode save — persists only the fields the PUT route allows
  // (title, notes, email_message, due_date, line_items). The server recalculates
  // subtotal, discounts, tax, and total from the line items, so we never send
  // money totals.
  const handleSave = async () => {
    if (savingRef.current) return;
    if (
      !lineItems.some(
        (i) => i._kind !== "discount" && i.description && i.unit_price > 0,
      )
    ) {
      showToast("Add at least one line item");
      return;
    }
    const dueDate = invoiceDueDate();
    if (!dueDate) {
      showToast("Choose a due date");
      return;
    }
    savingRef.current = true;
    setActionError("");
    setSaving(true);
    try {
      const body = {
        title: title || null,
        notes: notes || null,
        email_message: emailMessage || null,
        due_date: dueDate,
      };
      // Only send line_items when they actually changed. An unchanged save
      // (e.g. due-date only) skips the server retotal, so a draft that carries
      // a since-retired discount stays editable for those fields.
      if (JSON.stringify(lineItems) !== editLineItemsBaselineRef.current) {
        body.line_items = lineItems
          .filter((i) => i.description && Number(i.unit_price) !== 0)
          .map((i) => ({
            ...i,
            amount: lineAmount(i),
          }));
      }
      const saved = await adminFetch(`/admin/invoices/${editInvoice.id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      // Delivered-ness comes from the SAVED row, not the list snapshot: a
      // scheduled send can complete while the form is open (the server
      // allows that edit now), and the resend prompt must still fire for it.
      const savedStatus = String(
        saved?.status || editInvoice.status || "",
      ).toLowerCase();
      const deliveredAfterSave = ["sent", "viewed", "overdue"].includes(
        savedStatus,
      );
      // The emailed copy is now stale — hand the parent the id so the list
      // view opens the resend modal for it.
      showToast(
        deliveredAfterSave
          ? `Invoice updated: ${editInvoice.invoice_number} — resend it so the customer sees the new version`
          : `Invoice updated: ${editInvoice.invoice_number || "draft"}`,
      );
      onCreated(
        deliveredAfterSave
          ? {
              promptResendId: editInvoice.id,
            }
          : undefined,
      );
    } catch (e) {
      showToast(`Error: ${e.message}`);
    }
    savingRef.current = false;
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
        <div
          style={{
            minWidth: 0,
          }}
        >
          {" "}
          <h2 className="m-0 text-18 font-medium text-zinc-900">
            {title}
          </h2>{" "}
        </div>{" "}
      </div>
      {action}
    </div>
  );
  const lineRowGrid = (item) => ({
    display: "grid",
    gridTemplateColumns: isMobile
      ? "minmax(0, 1fr) 76px"
      : "minmax(0, 1fr) 84px 132px 44px",
    gap: 8,
    alignItems: "start",
    padding: item._kind === "discount" ? "8px 0 8px 18px" : "12px 0",
    borderTop: "1px solid #E4E4E7",
    background: item._kind === "discount" ? "#F0FDF4" : "transparent",
    borderRadius: item._kind === "discount" ? 8 : 0,
  });
  // Recovery-panel actions: each one targets ONLY the already-persisted row.
  const retryReviewBody = () => ({
    requestReview,
    reviewDelayMinutes: reviewDelayMinutes(),
    reviewTiming,
    reviewScheduledFor: reviewTiming === "custom" ? reviewCustomAt : null,
  });
  const retrySchedule = async () => {
    if (savingRef.current) return;
    const pInv = pendingScheduleInvoice?.invoice;
    if (!pInv || !retryScheduleAt || saving) return;
    savingRef.current = true;
    setActionError("");
    setSaving(true);
    try {
      await adminFetch(`/admin/invoices/${pInv.id}/schedule-send`, {
        method: "POST",
        body: JSON.stringify({
          scheduledFor: retryScheduleAt,
          ...retryReviewBody(),
        }),
      });
      showToast(`Invoice scheduled: ${pInv.invoice_number}`);
      onCreated();
    } catch (err) {
      setPendingScheduleInvoice({
        invoice: pInv,
        reason: err.message,
      });
      showToast(`Still not scheduled: ${err.message}`);
    }
    savingRef.current = false;
    setSaving(false);
  };
  const retrySendNow = async () => {
    if (savingRef.current) return;
    const pInv = pendingScheduleInvoice?.invoice;
    if (!pInv || saving) return;
    savingRef.current = true;
    setActionError("");
    setSaving(true);
    try {
      const res = await adminFetch(`/admin/invoices/${pInv.id}/send`, {
        method: "POST",
        body: JSON.stringify(retryReviewBody()),
      });
      showToast(invoiceCreatedSendToast(pInv.invoice_number, res));
      onCreated();
    } catch (err) {
      // A rejected request does not prove the send FAILED: the server may
      // have delivered and committed 'sent' before the response was lost.
      // Same ambiguous-send check as the initial create path — keep the
      // panel (and its Send now button) only when the row is provably
      // still unsent; anything else re-offers a resend on a delivered row.
      let persisted = null;
      try {
        persisted = await adminFetch(`/admin/invoices/${pInv.id}`);
      } catch {
        persisted = null;
      }
      const disposition = persistedSendDisposition(persisted);
      if (disposition === "unsent") {
        setPendingScheduleInvoice({
          invoice: pInv,
          reason: err.message,
        });
        showToast(`Send failed: ${err.message}`, "error");
      } else if (disposition === "committed") {
        showToast(
          `The send went through for ${pInv.invoice_number} (status: ${persisted.status}) despite a network error`,
        );
        onCreated();
      } else {
        showToast(
          `Send state unknown for ${pInv.invoice_number} (${err.message}). Check it in the list before resending.`,
        );
        onCreated();
      }
    }
    savingRef.current = false;
    setSaving(false);
  };
  const keepAsDraft = async () => {
    if (savingRef.current) return;
    const pInv = pendingScheduleInvoice?.invoice;
    if (!pInv || saving) return;
    savingRef.current = true;
    setActionError("");
    setSaving(true);
    // The schedule request may have COMMITTED even though its response was
    // lost (that's how this panel can appear over an actually-scheduled
    // row). Verify before promising a draft — a false "draft" toast would
    // hide a live scheduled send that will text the customer.
    let persisted = null;
    try {
      persisted = await adminFetch(`/admin/invoices/${pInv.id}`);
    } catch {
      persisted = null;
    }
    savingRef.current = false;
    setSaving(false);
    const status = String(persisted?.status || "").toLowerCase();
    if (status === "scheduled") {
      showToast(
        `Scheduling actually went through — ${pInv.invoice_number} will send as scheduled. Use Send (now) or Void from the list if you don't want that.`,
      );
    } else if (status && status !== "draft") {
      showToast(
        `Invoice ${pInv.invoice_number} is ${persisted.status} — review it in the list`,
      );
    } else if (status === "draft") {
      showToast(
        `Invoice created: ${pInv.invoice_number} (draft) — edit or send it from the list`,
      );
    } else {
      showToast(
        `Invoice created: ${pInv.invoice_number} — state could not be verified, review it in the list before sending`,
      );
    }
    onCreated();
  };
  const primaryActionLabel = editMode
    ? "Save changes"
    : sendTiming === "now"
      ? "Send invoice"
      : sendTiming === "draft"
        ? "Create draft"
        : "Schedule invoice";
  const canAddQueuedAttachments = canAddInvoiceAttachments(queuedAttachments);
  const queuedAttachmentHelpId = "invoice-create-attachments-help";
  const queuedAttachmentStatusId = "invoice-create-attachments-status";
  const summaryRowStyle = (size = 12, weight = 400) => ({
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) max-content",
    gap: 12,
    alignItems: "baseline",
    fontSize: Math.max(14, size),
    fontWeight: Math.min(500, weight),
    color: "#18181B",
    marginBottom: 4,
  });
  const summaryLabelStyle = {
    minWidth: 0,
    overflowWrap: "anywhere",
  };
  const summaryAmountStyle = {
    textAlign: "right",
    whiteSpace: "nowrap",
  };
  if (pendingScheduleInvoice && !editMode) {
    const pInv = pendingScheduleInvoice.invoice;
    return (
      <Card
        style={{
          padding: isMobile ? 14 : 16,
          maxWidth: 560,
        }}
        className="p-4"
      >
        {actionError && (
          <ActionFeedback error className="col-span-full">
            {actionError}
          </ActionFeedback>
        )}
        <div className="text-18 font-medium text-zinc-900">
          Invoice {pInv.invoice_number} created — scheduling failed
        </div>
        <div
          style={{
            marginTop: 6,
            marginBottom: 12,
          }}
          className="text-ink-secondary"
        >
          {pendingScheduleInvoice.reason}
        </div>
        <label
          style={{
            display: "block",
            marginBottom: 12,
          }}
        >
          <span
            style={{
              display: "block",
              marginBottom: 4,
            }}
          >
            New send time
          </span>
          <Input
            type="datetime-local"
            value={retryScheduleAt}
            onChange={(e) => setRetryScheduleAt(e.target.value)}
            disabled={builderBusy}
          />
        </label>
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <Button
            onClick={retrySchedule}
            variant={"primary"}
            onClickCapture={(event) =>
              event.currentTarget.focus({
                preventScroll: true,
              })
            }
            className="min-w-11"
            loading={saving}
            disabled={builderBusy || !retryScheduleAt}
          >
            {"Retry schedule"}
          </Button>
          <Button
            onClick={retrySendNow}
            variant={"secondary"}
            onClickCapture={(event) =>
              event.currentTarget.focus({
                preventScroll: true,
              })
            }
            className="min-w-11"
            disabled={builderBusy}
          >
            Send now
          </Button>
          <Button
            onClick={keepAsDraft}
            variant={"secondary"}
            onClickCapture={(event) =>
              event.currentTarget.focus({
                preventScroll: true,
              })
            }
            className="min-w-11"
            disabled={builderBusy}
          >
            Keep as draft
          </Button>
        </div>
        <div
          style={{
            marginTop: 10,
          }}
          className="text-ink-secondary text-ui-body"
        >
          Need to change the invoice itself? Keep it as a draft, then edit it
          from the list.
        </div>
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-4 items-start text-zinc-900">
      {actionError && (
        <ActionFeedback error className="col-span-full">
          {actionError}
        </ActionFeedback>
      )}{" "}
      <div
        style={{
          display: "grid",
          gap: 12,
          minWidth: 0,
        }}
      >
        {discountsError && (
          <ActionFeedback
            error
            onRetry={() => setDiscountsAttempt((attempt) => attempt + 1)}
          >
            Discounts could not be loaded: {discountsError}
          </ActionFeedback>
        )}
        {serviceRecordsError && (
          <ActionFeedback
            error
            onRetry={() => setServiceRecordsAttempt((attempt) => attempt + 1)}
          >
            Service history could not be loaded: {serviceRecordsError}
          </ActionFeedback>
        )}{" "}
        <Card
          style={{
            padding: isMobile ? 14 : 16,
          }}
          className="p-4"
        >
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
              <div className="text-18 font-medium text-zinc-900">
                {editMode
                  ? `Edit Invoice ${editInvoice.invoice_number || ""}`.trim()
                  : "Invoice builder"}
              </div>{" "}
              {editingDelivered && (
                <div
                  style={{
                    marginTop: 2,
                  }}
                  className="text-ui-body text-ink-secondary"
                >
                  Already sent to the customer — resend after saving so they see
                  the updated version
                </div>
              )}{" "}
            </div>{" "}
          </div>{" "}
        </Card>{" "}
        <Card className="p-4">
          {sectionHeader("Customer")}
          {selectedCustomer ? (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "10px 12px",
                border: "1px solid #18181B",
                flexWrap: "wrap",
                gap: 8,
              }}
              className="bg-white rounded-md"
            >
              {" "}
              <div>
                {" "}
                <span className="text-zinc-900 font-medium">
                  {selectedCustomer.first_name} {selectedCustomer.last_name}
                </span>{" "}
                <span
                  style={{
                    marginLeft: 8,
                  }}
                  className="text-ink-secondary text-ui-body"
                >
                  {selectedCustomer.phone}
                </span>
                {selectedCustomer.waveguard_tier && (
                  <Badge
                    style={{
                      marginLeft: 8,
                    }}
                    className="max-w-full whitespace-normal"
                  >
                    {selectedCustomer.waveguard_tier}
                  </Badge>
                )}
              </div>{" "}
              {!editMode && (
                <Button
                  onClick={() => {
                    setSelectedCustomer(null);
                    setSelectedService(null);
                    setSelectedOpenVisit(null);
                    setCustomerQuery("");
                  }}
                  variant={"secondary"}
                  onClickCapture={(event) =>
                    event.currentTarget.focus({
                      preventScroll: true,
                    })
                  }
                  className="min-w-11"
                  aria-label="Clear selected customer"
                  disabled={builderBusy}
                >
                  x
                </Button>
              )}{" "}
            </div>
          ) : (
            <div
              style={{
                position: "relative",
              }}
            >
              {" "}
              <Field className="min-w-0" label="Find customer">
                <Input
                  value={customerQuery}
                  onChange={(e) => setCustomerQuery(e.target.value)}
                  placeholder="Search by name, phone, or email..."
                  disabled={builderBusy}
                />
              </Field>
              {customers.length > 0 && (
                <div
                  style={{
                    position: "absolute",
                    top: "100%",
                    left: 0,
                    right: 0,
                    border: "1px solid #E4E4E7",
                    zIndex: 10,
                    maxHeight: 200,
                    overflow: "auto",
                    marginTop: 4,
                  }}
                  className="bg-white rounded-md"
                >
                  {customers.map((c) => (
                    <Button
                      key={c.id}
                      onClick={() => {
                        setSelectedCustomer(c);
                        // Drop any visit picked for the previous customer so a
                        // stale service record can't be linked across customers.
                        setSelectedService(null);
                        setSelectedOpenVisit(null);
                        setServiceRecords([]);
                        setCustomers([]);
                        setCustomerQuery("");
                      }}
                      style={{
                        padding: "10px 12px",
                        cursor: "pointer",
                        borderBottom: "1px solid #E4E4E7",
                      }}
                      variant="ghost"
                      className="w-full justify-start text-left whitespace-normal"
                      disabled={builderBusy}
                    >
                      {" "}
                      <span className="text-zinc-900">
                        {c.first_name} {c.last_name}
                      </span>{" "}
                      <span
                        style={{
                          marginLeft: 8,
                        }}
                        className="text-ink-secondary"
                      >
                        {c.phone}
                      </span>
                      {c.waveguard_tier && (
                        <Badge
                          style={{
                            marginLeft: 8,
                          }}
                          className="max-w-full whitespace-normal"
                        >
                          {c.waveguard_tier}
                        </Badge>
                      )}
                    </Button>
                  ))}
                </div>
              )}
              {customerQuery.length >= 2 &&
                (customerSearchLoading ? (
                  <ActionFeedback className="mt-2">
                    Searching customers…
                  </ActionFeedback>
                ) : customerSearchError ? (
                  <ActionFeedback
                    error
                    onRetry={() =>
                      setCustomerSearchAttempt((attempt) => attempt + 1)
                    }
                    className="mt-2"
                  >
                    {customerSearchError}
                  </ActionFeedback>
                ) : customers.length === 0 ? (
                  <ActionFeedback className="mt-2">
                    No customers match this search.
                  </ActionFeedback>
                ) : null)}
            </div>
          )}
        </Card>
        {!editMode && (
          <VisitLinkPanel
            serviceRecords={serviceRecords}
            openVisits={openVisits}
            selectedService={selectedService}
            selectedOpenVisit={selectedOpenVisit}
            linkedVisitGone={linkedVisitGone}
            sectionHeader={sectionHeader}
            disabled={builderBusy}
            onPick={({ record, visit }) => {
              setSelectedService(record);
              setSelectedOpenVisit(visit);
              const picked = record || visit;
              const pickedDate = record?.service_date || visit?.scheduled_date;
              if (pickedDate) setServiceDate(pickedDate);
              if (picked && lineItems.length === 1 && !lineItems[0].description) {
                setLineItems([
                  {
                    ...lineItems[0],
                    _kind: "service",
                    description: picked.service_type,
                    quantity: 1,
                    unit_price: 0,
                  },
                ]);
              }
            }}
          />
        )}
        {!editMode && (
          <Card className="p-4">
            <Field className="min-w-0" label="Service date">
              <Input
                type="date"
                value={serviceDate}
                onChange={(e) => setServiceDate(e.target.value)}
                disabled={builderBusy}
              />
            </Field>{" "}
          </Card>
        )}{" "}
        <Card className="p-4">
          {sectionHeader("Services")}
          {lineItems.map((item, i) => (
            <div key={item.client_id || i} style={lineRowGrid(item)}>
              {" "}
              <div
                style={{
                  position: "relative",
                  minWidth: 0,
                }}
              >
                <Field
                  className="min-w-0"
                  label={item._kind === "discount" ? "Discount" : "Service"}
                >
                  <Input
                    value={item.description}
                    onChange={(e) =>
                      updateLineItem(i, "description", e.target.value)
                    }
                    onFocus={() => {
                      if (item._kind !== "discount") setServiceSearchIdx(i);
                    }}
                    onBlur={(event) => {
                      if (
                        event.relatedTarget &&
                        event.currentTarget.parentElement.parentElement.contains(
                          event.relatedTarget,
                        )
                      )
                        return;
                      setTimeout(() => {
                        setServiceSearchIdx((prev) =>
                          prev === i ? null : prev,
                        );
                      }, 150);
                    }}
                    placeholder={
                      item._kind === "discount" ? "Discount" : "Search services"
                    }
                    readOnly={item._kind === "discount"}
                    disabled={builderBusy}
                  />
                </Field>
                {serviceSearchIdx === i &&
                  (lineItems[i]?.description || "").length >= 2 && (
                    <div
                      style={{
                        position: "absolute",
                        top: "100%",
                        left: 0,
                        right: 0,
                        border: "1px solid #E4E4E7",
                        zIndex: 20,
                        maxHeight: 240,
                        overflow: "auto",
                        marginTop: 4,
                      }}
                      className="bg-white rounded-md"
                    >
                      {serviceSearchLoading ? (
                        <ActionFeedback className="p-3">
                          Searching services…
                        </ActionFeedback>
                      ) : serviceSearchError ? (
                        <ActionFeedback
                          error
                          onRetry={() =>
                            setServiceSearchAttempt((attempt) => attempt + 1)
                          }
                          className="p-3"
                        >
                          {serviceSearchError}
                        </ActionFeedback>
                      ) : serviceResults.length === 0 ? (
                        <div
                          style={{
                            padding: "10px 12px",
                          }}
                          className="text-ink-secondary text-ui-body"
                        >
                          No services match. Check Services catalog.
                        </div>
                      ) : (
                        serviceResults.map((svc) => (
                          <Button
                            key={svc.id}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              pickService(i, svc);
                            }}
                            style={{
                              padding: "10px 12px",
                              cursor: "pointer",
                              borderBottom: "1px solid #E4E4E7",
                              display: "flex",
                              justifyContent: "space-between",
                              gap: 8,
                              alignItems: "center",
                            }}
                            variant="ghost"
                            className="w-full justify-start text-left whitespace-normal"
                            onClick={(event) => {
                              if (event.detail === 0)
                                ((e) => {
                                  e.preventDefault();
                                  pickService(i, svc);
                                })(event);
                            }}
                            disabled={builderBusy}
                          >
                            {" "}
                            <div
                              style={{
                                minWidth: 0,
                                flex: 1,
                              }}
                            >
                              {" "}
                              <div
                                style={{
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                                className="text-zinc-900 font-medium"
                              >
                                {svc.name}
                              </div>
                              {svc.short_name &&
                                svc.short_name !== svc.name && (
                                  <div
                                    style={{
                                      marginTop: 2,
                                    }}
                                    className="text-ink-secondary text-ui-body"
                                  >
                                    {svc.short_name}
                                  </div>
                                )}
                            </div>
                            {svc.base_price != null &&
                              Number(svc.base_price) > 0 && (
                                <span
                                  style={{
                                    whiteSpace: "nowrap",
                                  }}
                                  className="text-zinc-900 text-ui-body"
                                >
                                  ${Number(svc.base_price).toFixed(2)}
                                </span>
                              )}
                          </Button>
                        ))
                      )}
                    </div>
                  )}
              </div>{" "}
              <div>
                <Field className="min-w-0" label="Quantity">
                  <Input
                    type="number"
                    value={item.quantity}
                    onChange={(e) =>
                      updateLineItem(i, "quantity", e.target.value)
                    }
                    min="1"
                    readOnly={item._kind === "discount"}
                    style={{
                      textAlign: "center",
                    }}
                    disabled={builderBusy}
                  />
                </Field>{" "}
              </div>{" "}
              <div
                style={{
                  position: "relative",
                }}
              >
                {" "}
                <Field
                  className="min-w-0"
                  label={item._kind === "discount" ? "Credit ($)" : "Price ($)"}
                >
                  <Input
                    type="number"
                    value={item.unit_price || ""}
                    onChange={(e) =>
                      updateLineItem(i, "unit_price", e.target.value)
                    }
                    placeholder="0.00"
                    step="0.01"
                    readOnly={item._kind === "discount"}
                    style={{
                      paddingLeft: 22,
                    }}
                    disabled={builderBusy}
                  />
                </Field>{" "}
              </div>
              {lineItems.length > 1 && (
                <Button
                  onClick={() => removeLineItem(i)}
                  aria-label="Remove line item"
                  variant={"secondary"}
                  onClickCapture={(event) =>
                    event.currentTarget.focus({
                      preventScroll: true,
                    })
                  }
                  className="min-w-11"
                  disabled={builderBusy}
                >
                  x
                </Button>
              )}
              {item._kind !== "discount" && (
                <div
                  style={{
                    gridColumn: "1 / -1",
                    position: "relative",
                    padding: "0 0 2px",
                  }}
                >
                  <Field className="min-w-0" label="Add a discount">
                    <Input
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
                        discountsLoading
                          ? "Loading discounts…"
                          : discountsError
                            ? "Discounts unavailable"
                            : availableDiscounts.length === 0
                              ? "No invoice discounts are available"
                              : `Search discounts${item.description ? ` for ${item.description}` : ""}...`
                      }
                      disabled={
                        builderBusy ||
                        discountsLoading ||
                        !!discountsError ||
                        availableDiscounts.length === 0
                      }
                    />
                  </Field>
                  {discountSearchIdx === i && (
                    <div
                      style={{
                        position: "absolute",
                        top: "100%",
                        left: 0,
                        right: 0,
                        border: "1px solid #E4E4E7",
                        zIndex: 18,
                        maxHeight: 220,
                        overflow: "auto",
                        marginTop: 4,
                      }}
                      className="bg-white rounded-md"
                    >
                      {matchingDiscounts(i).length === 0 ? (
                        <div
                          style={{
                            padding: "10px 12px",
                          }}
                          className="text-ink-secondary text-ui-body"
                        >
                          No discounts match.
                        </div>
                      ) : (
                        matchingDiscounts(i).map((d) => (
                          <Button
                            key={d.id}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              addDiscountToLine(i, d);
                            }}
                            style={{
                              padding: "10px 12px",
                              cursor: "pointer",
                              borderBottom: "1px solid #E4E4E7",
                              display: "flex",
                              justifyContent: "space-between",
                              gap: 8,
                              alignItems: "center",
                            }}
                            variant="ghost"
                            className="w-full justify-start text-left whitespace-normal"
                            onClick={(event) => {
                              if (event.detail === 0)
                                ((e) => {
                                  e.preventDefault();
                                  addDiscountToLine(i, d);
                                })(event);
                            }}
                            disabled={builderBusy}
                          >
                            {" "}
                            <span
                              style={{
                                minWidth: 0,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              className="text-zinc-900 font-medium"
                            >
                              {d.name}
                            </span>{" "}
                            <span
                              style={{
                                whiteSpace: "nowrap",
                              }}
                              className="text-zinc-900 text-ui-body"
                            >
                              {formatDiscountLabel(d)}
                            </span>{" "}
                          </Button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          <Button
            onClick={addLineItem}
            style={{
              marginTop: 10,
            }}
            variant={"secondary"}
            onClickCapture={(event) =>
              event.currentTarget.focus({
                preventScroll: true,
              })
            }
            className="min-w-11"
            disabled={builderBusy}
          >
            + Add service
          </Button>{" "}
        </Card>{" "}
        {!editMode && (
          <Card className="p-4">
            {sectionHeader("Attachments")}
            <input
              ref={attachmentInputRef}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              onChange={handleQueuedAttachments}
              aria-describedby={`${queuedAttachmentHelpId} ${queuedAttachmentStatusId}`}
              style={{
                display: "none",
              }}
            />
            <div
              id={queuedAttachmentHelpId}
              style={{
                lineHeight: 1.45,
                marginBottom: 12,
              }}
              className="text-ui-body text-ink-secondary"
            >
              {ATTACHMENT_HELP_TEXT}
              <br />
              {ATTACHMENT_VISIBILITY_TEXT}
            </div>
            <Button
              type="button"
              onClick={() => attachmentInputRef.current?.click()}
              aria-describedby={`${queuedAttachmentHelpId} ${queuedAttachmentStatusId}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
              variant={"secondary"}
              onClickCapture={(event) =>
                event.currentTarget.focus({
                  preventScroll: true,
                })
              }
              className="min-w-11"
              disabled={builderBusy || !canAddQueuedAttachments}
            >
              <Upload size={14} strokeWidth={2.2} />
              Add files
            </Button>
            {queuedAttachments.length > 0 ? (
              <div
                style={{
                  display: "grid",
                  gap: 8,
                  marginTop: 12,
                }}
              >
                {queuedAttachments.map((file, idx) => (
                  <div
                    key={`${file.name}-${file.size}-${idx}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(0, 1fr) auto auto",
                      alignItems: "center",
                      gap: 8,
                      padding: "9px 10px",
                      border: "1px solid #E4E4E7",
                    }}
                    className="rounded-md bg-zinc-50"
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
                        }}
                        className="text-ui-body font-medium text-zinc-900"
                      >
                        {file.name}
                      </span>
                    </div>
                    <span
                      style={{
                        whiteSpace: "nowrap",
                      }}
                      className="text-ui-body text-ink-secondary"
                    >
                      {formatFileSize(file.size)}
                    </span>
                    <Button
                      type="button"
                      onClick={() => removeQueuedAttachment(idx)}
                      aria-label={`Remove ${file.name}`}
                      style={{
                        width: 32,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                      variant={"secondary"}
                      onClickCapture={(event) =>
                        event.currentTarget.focus({
                          preventScroll: true,
                        })
                      }
                      className="min-w-11"
                      disabled={builderBusy}
                    >
                      <Trash2 size={15} strokeWidth={2.2} />
                    </Button>
                  </div>
                ))}
                <div
                  id={queuedAttachmentStatusId}
                  role="status"
                  aria-live="polite"
                  className="text-ui-body text-ink-secondary"
                >
                  {invoiceAttachmentLimitLabel(queuedAttachments)}
                </div>
              </div>
            ) : (
              <div
                id={queuedAttachmentStatusId}
                role="status"
                aria-live="polite"
                style={{
                  marginTop: 10,
                }}
                className="text-ui-body text-ink-secondary"
              >
                No files selected.
              </div>
            )}
          </Card>
        )}{" "}
        <Card className="p-4">
          {sectionHeader("Delivery")}
          <div
            style={{
              marginBottom: 14,
            }}
          >
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
            </div>{" "}
            {aiSummaryEnabled && linkedServiceRecordId && (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 14,
                  marginBottom: 8,
                }}
              >
                <span className="text-ui-body text-ink-secondary">
                  Pull from visit:
                </span>
                {[
                  {
                    key: "jobSummary",
                    label: "Job summary",
                  },
                  {
                    key: "forms",
                    label: "Field observations",
                  },
                  {
                    key: "lineItems",
                    label: "Line items",
                  },
                ].map(({ key, label }) => (
                  <label
                    key={key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      cursor: "pointer",
                    }}
                    className="ui-choice-label flex items-center gap-2 text-ui-body text-zinc-900"
                  >
                    <Checkbox
                      checked={aiSources[key]}
                      onChange={(e) =>
                        setAiSources((prev) => ({
                          ...prev,
                          [key]: e.target.checked,
                        }))
                      }
                      disabled={builderBusy}
                    />
                    {label}
                  </label>
                ))}
              </div>
            )}
            <div
              style={{
                position: "relative",
              }}
            >
              <Field className="min-w-0" label="Notes (optional)">
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder=""
                  style={{
                    resize: "vertical",
                  }}
                  disabled={builderBusy}
                />
              </Field>
              <div className="mt-2 flex items-center justify-end gap-2">
                <AiWriteButton
                  disabled={builderBusy}
                  loading={aiNotesLoading}
                  onClick={handleWriteNotesWithAI}
                  title={notes.trim() ? "Rewrite with AI" : "Write with AI"}
                />
                <DictationButton
                  presentation="admin"
                  disabled={builderBusy}
                  onAppend={(t) => {
                    if (!builderBusy)
                      setNotes((prev) => appendDictation(prev, t));
                  }}
                  title="Dictate notes"
                  size={44}
                />
              </div>
            </div>{" "}
          </div>{" "}
          {emailMessageEnabled && (
            <div
              style={{
                marginBottom: 14,
              }}
            >
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
                    display: "block",
                  }}
                  className="text-ui-body text-ink-secondary"
                >
                  Email thank-you (optional)
                </label>{" "}
              </div>{" "}
              <div
                style={{
                  position: "relative",
                }}
              >
                <Field className="min-w-0" label="Email message (optional)">
                  <Textarea
                    value={emailMessage}
                    onChange={(e) =>
                      setEmailMessage(e.target.value.slice(0, 800))
                    }
                    rows={2}
                    placeholder="A short, warm thank-you note for the invoice email."
                    style={{
                      resize: "vertical",
                    }}
                    disabled={builderBusy}
                  />
                </Field>
                <div className="mt-2 flex items-center justify-end gap-2">
                  <AiWriteButton
                    disabled={builderBusy}
                    loading={aiMessageLoading}
                    onClick={handleWriteThankYouWithAI}
                    title={
                      emailMessage.trim() ? "Rewrite with AI" : "Write with AI"
                    }
                  />
                  <DictationButton
                    presentation="admin"
                    disabled={builderBusy}
                    onAppend={(t) =>
                      !builderBusy &&
                      setEmailMessage((prev) => appendDictation(prev, t, 800))
                    }
                    title="Dictate thank-you"
                    size={44}
                  />
                </div>
              </div>{" "}
              <div
                style={{
                  marginTop: 4,
                }}
                className="text-ui-body text-ink-secondary"
              >
                Appears in the invoice email, below the service summary — not on
                the PDF.
              </div>{" "}
            </div>
          )}{" "}
          <div
            style={{
              marginBottom: 14,
            }}
          >
            {" "}
            <div
              style={{
                marginBottom: 6,
              }}
              className="text-ui-body text-ink-secondary"
            >
              {editMode ? "Due date" : "Schedule"}
            </div>{" "}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: isMobile || editMode ? "1fr" : "1fr 1fr",
                gap: 8,
              }}
            >
              {" "}
              {!editMode && (
                <div>
                  {" "}
                  <Field label={<>Send</>} className="min-w-0">
                    <Select
                      value={sendTiming}
                      onChange={(e) => setSendTiming(e.target.value)}
                      disabled={builderBusy}
                    >
                      {" "}
                      <option value="now">Immediately</option>{" "}
                      <option value="tomorrow_8" disabled={!!selectedOpenVisit}>Tomorrow at 8 AM</option>{" "}
                      <option value="custom" disabled={!!selectedOpenVisit}>Custom time</option>{" "}
                      <option value="draft">Save draft</option>{" "}
                    </Select>
                  </Field>{" "}
                  {openVisitSendTimingBlocked(sendTiming, selectedOpenVisit) && (
                    <div className="mt-1 text-ui-caption text-ink-secondary">
                      Linked to an open visit — the completion sends this invoice, so pick Immediately or Save draft.
                    </div>
                  )}
                </div>
              )}{" "}
              <div>
                {" "}
                <Field label={<>Due</>} className="min-w-0">
                  <Select
                    value={dueTiming}
                    onChange={(e) => setDueTiming(e.target.value)}
                    disabled={builderBusy}
                  >
                    {" "}
                    <option value="today">Today</option>{" "}
                    <option value="tomorrow">Tomorrow</option>{" "}
                    <option value="7">In 7 days</option>{" "}
                    <option value="30">In 30 days</option>{" "}
                    <option value="custom">Custom date</option>{" "}
                  </Select>
                </Field>{" "}
              </div>{" "}
            </div>
            {(sendTiming === "custom" || dueTiming === "custom") && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: isMobile || editMode ? "1fr" : "1fr 1fr",
                  gap: 8,
                  marginTop: 8,
                }}
              >
                {!editMode &&
                  (sendTiming === "custom" ? (
                    <Field className="min-w-0" label="Send date and time">
                      <Input
                        type="datetime-local"
                        value={sendCustomAt}
                        onChange={(e) => setSendCustomAt(e.target.value)}
                        disabled={builderBusy}
                      />
                    </Field>
                  ) : (
                    <div />
                  ))}
                {dueTiming === "custom" ? (
                  <Field className="min-w-0" label="Due date">
                    <Input
                      type="date"
                      value={dueCustomDate}
                      onChange={(e) => setDueCustomDate(e.target.value)}
                      disabled={builderBusy}
                    />
                  </Field>
                ) : (
                  <div />
                )}
              </div>
            )}
          </div>{" "}
          {!editMode && (
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
                  marginBottom: reviewRequestActive ? 8 : 0,
                }}
              >
                {" "}
                <Checkbox
                  checked={reviewRequestActive}
                  onChange={(e) => setRequestReview(e.target.checked)}
                  id="review-toggle"
                  label={openVisitReviewRequestBlocked(selectedOpenVisit) ? "Send review request (after the visit completes)" : "Send review request"}
                  disabled={builderBusy || sendTiming === "draft" || openVisitReviewRequestBlocked(selectedOpenVisit)}
                />{" "}
              </div>
              {reviewRequestActive && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
                    gap: 8,
                    paddingLeft: 22,
                  }}
                >
                  {" "}
                  <Field className="min-w-0" label="Review timing">
                    <Select
                      value={reviewTiming}
                      onChange={(e) => setReviewTiming(e.target.value)}
                      disabled={builderBusy || sendTiming === "draft"}
                    >
                      {" "}
                      <option value="now">Now</option>{" "}
                      <option value="120">In 2 hours</option>{" "}
                      <option value="tomorrow_8">Tomorrow at 8 AM</option>{" "}
                      <option value="custom">Custom time</option>{" "}
                    </Select>
                  </Field>
                  {reviewTiming === "custom" && (
                    <Field className="min-w-0" label="Review date and time">
                      <Input
                        type="datetime-local"
                        value={reviewCustomAt}
                        onChange={(e) => setReviewCustomAt(e.target.value)}
                        disabled={builderBusy || sendTiming === "draft"}
                      />
                    </Field>
                  )}
                </div>
              )}
            </div>
          )}{" "}
        </Card>{" "}
      </div>{" "}
      <div
        style={{
          position: isMobile ? "relative" : "sticky",
          top: 20,
          alignSelf: "start",
        }}
      >
        {" "}
        <Card className="p-4">
          {" "}
          <div
            style={{
              marginBottom: 4,
            }}
            className="text-ui-body font-medium text-zinc-900"
          >
            Invoice summary
          </div>{" "}
          <div
            style={{
              marginBottom: 12,
            }}
            className="text-ui-body text-ink-secondary"
          >
            {selectedCustomer
              ? `${selectedCustomer.first_name} ${selectedCustomer.last_name}`
              : "No customer selected"}
          </div>{" "}
          <div
            style={{
              display: "grid",
              gap: 6,
              marginBottom: 14,
            }}
            className="text-ui-body text-zinc-900"
          >
            {" "}
            {!editMode && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                {" "}
                <span className="text-ink-secondary">Send</span>{" "}
                <span>
                  {sendTiming === "now"
                    ? "Immediately"
                    : sendTiming === "draft"
                      ? "Draft"
                      : sendTiming === "tomorrow_8"
                        ? "Tomorrow 8 AM"
                        : "Custom"}
                </span>{" "}
              </div>
            )}{" "}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              {" "}
              <span className="text-ink-secondary">Due</span>{" "}
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
              <span className="text-ink-secondary">Sales tax</span>{" "}
              <span>
                {editMode
                  ? taxRate > 0
                    ? `${(taxRate * 100).toFixed(2).replace(/\.?0+$/, "")}%`
                    : "None"
                  : isCommercial
                    ? "Commercial only"
                    : "None"}
              </span>{" "}
            </div>{" "}
          </div>{" "}
          <Button
            onClick={editMode ? handleSave : handleCreate}
            style={{
              width: "100%",
              marginBottom: 14,
            }}
            onClickCapture={(event) =>
              event.currentTarget.focus({
                preventScroll: true,
              })
            }
            className="min-w-11"
            disabled={builderBusy}
            loading={saving}
            variant="primary"
          >
            {primaryActionLabel}
          </Button>
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
              borderTop: "1px solid #E4E4E7",
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
                borderTop: "2px solid #18181B",
              }}
            >
              {" "}
              <span style={summaryLabelStyle}>Total</span>
              <span style={summaryAmountStyle}>${total.toFixed(2)}</span>{" "}
            </div>
            <LinkedBalanceSummary
              depositCredit={depositCredit}
              balanceDue={balanceDue}
              serverBalance={serverBalance}
              rowStyle={summaryRowStyle}
              labelStyle={summaryLabelStyle}
              amountStyle={summaryAmountStyle}
            />
            {cardCharge.surcharge > 0 && (
              <div
                style={{
                  ...summaryRowStyle(),
                  marginTop: 6,
                }}
              >
                {" "}
                <span style={summaryLabelStyle}>Credit card surcharge</span>
                <span style={summaryAmountStyle}>
                  ${cardCharge.surcharge.toFixed(2)}
                </span>{" "}
              </div>
            )}
          </div>{" "}
        </Card>{" "}
      </div>{" "}
    </div>
  );
}

// ── Follow-up Sequence Panel (per-invoice) ──
function FollowupPanel({ invoiceId, showToast, isMobile }) {
  const busyRef = useRef(false);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState(false);
  const load = useCallback(async () => {
    setReadError(false);
    const d = await adminFetch(`/admin/invoices/${invoiceId}/followup`).catch(
      () => null,
    );
    setData(d);
    setReadError(!d);
  }, [invoiceId]);
  useEffect(() => {
    load();
  }, [load]);
  const act = async (path, body) => {
    if (busyRef.current) return;
    busyRef.current = true;
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
      busyRef.current = false;
      setBusy(false);
    }
  };
  if (readError)
    return (
      <ActionFeedback error onRetry={load} className="my-4">
        Could not load invoice follow-up.
      </ActionFeedback>
    );
  if (!data)
    return (
      <div
        style={{
          marginTop: 10,
        }}
        className="text-ui-body text-ink-secondary"
      >
        Loading follow-up…
      </div>
    );
  const seq = data.sequence;
  const steps = data.steps || [];
  const nextStep = seq ? steps[seq.step_index] : null;
  return (
    <div
      style={{
        marginTop: 12,
        padding: 12,
        background: "#F8FAFC",
        border: "1px solid #E4E4E7",
      }}
      className="rounded-md"
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
        <div className="text-ui-body font-medium text-zinc-900">
          Automated follow-ups
        </div>
        {seq ? (
          <Badge className="max-w-full whitespace-normal">
            {seq.status.replace("_", " ")}
          </Badge>
        ) : (
          <Badge className="max-w-full whitespace-normal">not scheduled</Badge>
        )}
      </div>
      {seq && (
        <div
          style={{
            marginBottom: 10,
            lineHeight: 1.6,
          }}
          className="text-ui-body text-ink-secondary"
        >
          {" "}
          <div>
            Touches sent:{" "}
            <span className="font-medium">{seq.touches_sent}</span>
            of {steps.length}
          </div>
          {nextStep && seq.next_touch_at && seq.status === "active" && (
            <div>
              Next: <span className="font-medium">{nextStep.label}</span>on{" "}
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
      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        {seq && seq.status === "active" && (
          <>
            {" "}
            <Button
              disabled={busy}
              onClick={() => {
                const reason = prompt(
                  'Why pause? (e.g. "customer said they\'ll pay Friday")',
                );
                if (reason !== null)
                  act("pause", {
                    reason,
                  });
              }}
              variant={"secondary"}
              onClickCapture={(event) =>
                event.currentTarget.focus({
                  preventScroll: true,
                })
              }
              className="min-w-11"
            >
              Pause
            </Button>{" "}
            <Button
              disabled={busy}
              onClick={() => {
                if (confirm("Send the next follow-up SMS right now?"))
                  act("send-now");
              }}
              variant={"primary"}
              onClickCapture={(event) =>
                event.currentTarget.focus({
                  preventScroll: true,
                })
              }
              className="min-w-11"
            >
              Send next now
            </Button>{" "}
            <Button
              disabled={busy}
              onClick={() => {
                const reason = prompt(
                  'Why stop? (e.g. "waived", "customer disputed")',
                );
                if (reason !== null)
                  act("stop", {
                    reason,
                  });
              }}
              variant={"secondary"}
              onClickCapture={(event) =>
                event.currentTarget.focus({
                  preventScroll: true,
                })
              }
              className="min-w-11"
            >
              Stop
            </Button>{" "}
          </>
        )}
        {seq && (seq.status === "paused" || seq.status === "autopay_hold") && (
          <>
            {" "}
            <Button
              disabled={busy}
              onClick={() => act("resume")}
              variant={"secondary"}
              onClickCapture={(event) =>
                event.currentTarget.focus({
                  preventScroll: true,
                })
              }
              className="min-w-11"
            >
              Resume
            </Button>{" "}
            <Button
              disabled={busy}
              onClick={() => {
                if (confirm("Send the next follow-up SMS right now?"))
                  act("send-now");
              }}
              variant={"primary"}
              onClickCapture={(event) =>
                event.currentTarget.focus({
                  preventScroll: true,
                })
              }
              className="min-w-11"
            >
              Send now
            </Button>{" "}
          </>
        )}
      </div>{" "}
    </div>
  );
}
