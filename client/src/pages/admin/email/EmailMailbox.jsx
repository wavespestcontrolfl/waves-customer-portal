import { Archive, Check, Paperclip, Sparkles, Star, Trash2 } from "lucide-react";
import { cn } from "../../../components/ui/cn";
import { Button, buttonStyles } from "../../../components/ui/Button";
import { Field } from "../../../components/ui/Field";
import { Input } from "../../../components/ui/Input";
import EmailReply from "./EmailReply";
import { D } from "./emailStyles";

function buildSandboxedEmailHtml(html) {
  return `<!doctype html>
<html><head><base target="_blank"><meta charset="utf-8"><style>
body { margin: 0; padding: 0; color: #27272A; font: 14px/1.6 Roboto, system-ui, sans-serif; overflow-wrap: anywhere; }
img { max-width: 100%; height: auto; } table { max-width: 100%; } a { color: #18181B; }
</style></head><body>${html || ""}</body></html>`;
}

function EmailBody({ html, text }) {
  if (html) return <iframe title="Email body" sandbox="allow-popups allow-popups-to-escape-sandbox"
    srcDoc={buildSandboxedEmailHtml(html)} className="h-[360px] w-full border-0 bg-transparent" />;
  return <div className="whitespace-pre-wrap break-words text-ui-body text-ink-primary">{text || ""}</div>;
}



const CATEGORY_LABELS = {
  lead_inquiry: "Lead",
  customer_request: "Customer",
  complaint: "Complaint",
  vendor_invoice: "Invoice",
  vendor_communication: "Vendor",
  scheduling: "Scheduling",
  review_notification: "Review",
  regulatory: "Regulatory",
  marketing_newsletter: "Newsletter",
  internal: "Internal",
  spam: "Spam",
  other: "Other",
};

const AUTO_ACTION_LABELS = {
  lead_inquiry: "Lead created",
  spam: "Blocked & trashed",
  marketing_newsletter: "Unsubscribed",
  vendor_invoice: "Expense logged",
  complaint: "Flagged urgent",
};

function timeAgo(dateStr) {
  const date = new Date(dateStr), seconds = (Date.now() - date) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function EmailSummary({ stats, digest }) {
  return <div className="mb-5 space-y-3">
    {digest && digest.total_received > 0 && <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border-hairline border-zinc-200 bg-white p-4 text-ui-body text-ink-secondary">
      <span className="font-medium text-ink-primary">Today</span>
      <span><span className="u-nums text-ink-primary">{digest.total_received}</span> received</span>
      {[
        { label: "leads created", value: digest.leads_created },
        { label: "spam quarantined", value: digest.spam_quarantined ?? digest.spam_blocked },
        { label: "invoices", value: digest.invoices_processed },
        { label: "domains blocked", value: digest.domains_blocked_today },
      ].filter((item) => item.value > 0).map((item) => <span key={item.label}><span className="u-nums text-ink-primary">{item.value}</span> {item.label}</span>)}
    </div>}
    {stats && <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {[
        { label: "Unread", value: stats.unread }, { label: "Today", value: stats.today },
        { label: "Vendor", value: stats.vendor }, { label: "Total", value: stats.total },
      ].map((item) => <div key={item.label} className="rounded-md border-hairline border-zinc-200 bg-white p-4">
        <dt className="text-ui-caption text-ink-secondary">{item.label}</dt>
        <dd className="u-nums mt-1 text-18 leading-[1.35] font-medium">{item.value ?? "—"}</dd>
      </div>)}
    </dl>}
  </div>;
}

export function BlockedSenders({ mailbox }) {
  const { blocked, blockInput, setBlockInput, handleBlock, handleUnblock } = mailbox;
  return <section aria-label="Blocked senders" className="space-y-4">
    <div className="flex flex-wrap items-end gap-2 rounded-md border-hairline border-zinc-200 bg-white p-4">
      <Field label="Domain or email to block" className="min-w-0 flex-1">
        <Input value={blockInput} onChange={(event) => setBlockInput(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && handleBlock()}
          placeholder="example.com or name@example.com" />
      </Field>
      <Button variant="danger" onClick={handleBlock}>Block</Button>
    </div>
    <div className="overflow-hidden rounded-md border-hairline border-zinc-200 bg-white">
      {blocked.length === 0 ? <p className="p-8 text-center text-ink-secondary">No blocked senders</p>
        : <ul>{blocked.map((entry) => <li key={entry.id} className="flex items-start justify-between gap-3 border-b-hairline border-zinc-200 p-4 last:border-b-0">
          <div className="min-w-0 break-words">
            <p className="font-medium">{entry.domain || entry.email_address}</p>
            <p className="mt-1 text-ui-caption text-ink-secondary">{entry.reason}{entry.blocked_count > 0 && ` — ${entry.blocked_count} emails caught`} <span className="u-nums">{timeAgo(entry.created_at)}</span></p>
          </div>
          <Button variant="secondary" onClick={() => handleUnblock(entry.id)} className="shrink-0">Unblock</Button>
        </li>)}</ul>}
    </div>
  </section>;
}

function emailDetails(email) {
  try { return typeof email.extracted_data === "string" ? JSON.parse(email.extracted_data) : email.extracted_data || null; }
  catch { return null; }
}

function EmailMessage({ active, email, mailbox, editor }) {
  const { selectedEmail, thread, openEmail, handleStar, removeEmail, handleReclassify, handleDownloadAttachment } = mailbox;
  const isSelected = selectedEmail?.id === email.id;
  const extractedData = emailDetails(email);
  const category = email.classification, categoryLabel = CATEGORY_LABELS[category], autoActionLabel = AUTO_ACTION_LABELS[category];
  const sender = email.from_name || email.from_address;
  return <div>
    <div className={cn("flex border-b-hairline border-zinc-200", isSelected ? "bg-zinc-100" : "bg-white hover:bg-zinc-50")}>
      <Button variant="ghost" onClick={(event) => handleStar(event, email)} aria-label={`${email.is_starred ? "Unstar" : "Star"} ${email.subject || "email"}`} aria-pressed={Boolean(email.is_starred)} className="m-1 shrink-0 self-start px-3">
        <Star size={18} fill={email.is_starred ? "currentColor" : "none"} aria-hidden />
      </Button>
      <button type="button" onClick={() => openEmail(email)} aria-pressed={isSelected}
        className="u-focus-ring min-w-0 flex-1 appearance-none border-0 bg-transparent px-3 py-4 text-left text-ui-body">
        <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className={cn("min-w-0 truncate", !email.is_read && "font-medium")}>
            {!email.is_read && <span className="mr-2 inline-block h-2 w-2 rounded-full bg-zinc-900" aria-label="Unread" />}{sender}
            {editor.drafts.replies[email.id] && <span className="ml-2 text-ink-secondary">Draft</span>}
          </span>
          <span className="flex flex-wrap items-center gap-2 text-ui-caption text-ink-secondary">
            {categoryLabel && <span className="rounded-sm border-hairline border-zinc-300 px-2">{categoryLabel}</span>}
            <span className="u-nums">{timeAgo(email.received_at)}</span>
          </span>
        </span>
        <span className={cn("mt-1 flex items-center gap-2", !email.is_read && "font-medium")}>
          <span className="truncate">{email.subject || "(no subject)"}</span>{email.has_attachments && <Paperclip size={16} className="shrink-0" aria-label="Has attachments" />}
        </span>
        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-ink-secondary">
          <span className="min-w-0 flex-1 truncate">{email.snippet}</span>
          {extractedData?.vendor_name && <span>{extractedData.vendor_name}</span>}
        </span>
        {autoActionLabel && <span className="mt-1 flex items-center gap-1 text-ui-caption text-ink-secondary"><Check size={14} aria-hidden />{autoActionLabel}</span>}
      </button>
    </div>
    {isSelected && <div className="space-y-4 border-b-hairline border-zinc-200 bg-zinc-50 p-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => removeEmail(email.id, "archive")} className="gap-2"><Archive size={16} aria-hidden />Archive</Button>
        <Button variant="secondary" onClick={() => removeEmail(email.id, "trash")} className="gap-2"><Trash2 size={16} aria-hidden />Trash</Button>
        <Button variant="secondary" onClick={() => handleReclassify(email.id)} className="gap-2"><Sparkles size={16} aria-hidden />Reclassify</Button>
      </div>
      {extractedData && <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-md border-hairline border-zinc-200 bg-white p-4 text-ui-body">
        <span className="text-ink-secondary">AI classification:</span><span className="font-medium">{categoryLabel || category}</span>
        {[
          { key: "urgency", value: extractedData.urgency, prefix: "Urgency: ", alert: extractedData.urgency === "high" },
          { key: "person", value: extractedData.person_name }, { key: "phone", value: extractedData.phone },
          { key: "service", value: extractedData.service_interest }, { key: "invoice", value: extractedData.invoice_amount, prefix: "$" },
        ].filter((detail) => detail.value).map((detail) => <span key={detail.key} className={cn("break-words", detail.alert && "text-alert-fg")}>{detail.prefix}{detail.value}</span>)}
      </div>}
      {thread.map((message) => <article key={message.id} className="rounded-md border-hairline border-zinc-200 bg-white p-4">
        <div className="mb-2 flex flex-wrap justify-between gap-x-4 gap-y-1">
          <div className="min-w-0 break-words"><span className="font-medium">{message.from_name || message.from_address}</span> <span className="text-ink-secondary">&lt;{message.from_address}&gt;</span></div>
          <span className="u-nums text-ui-caption text-ink-secondary">{new Date(message.received_at).toLocaleString("en-US", { timeZone: "America/New_York" })}</span>
        </div>
        {message.to_address && <p className="mb-3 break-words text-ui-caption text-ink-secondary">To: {message.to_address}</p>}
        <EmailBody html={message.body_html} text={message.body_text} />
        {message.attachments?.length > 0 && <div className="mt-3 flex flex-wrap gap-2">
          {message.attachments.map((attachment) => <a key={attachment.id}
            href={`/api/admin/email/message/${message.id}/attachment/${attachment.gmail_attachment_id}`}
            onClick={(event) => handleDownloadAttachment(event, message, attachment)}
            className={buttonStyles({ variant: "secondary", density: "comfortable", className: "max-w-full gap-2 whitespace-normal break-words text-left" })}>
            <Paperclip size={16} className="shrink-0" aria-hidden /><span>{attachment.filename} ({Math.round((attachment.size_bytes || 0) / 1024)} KB)</span>
          </a>)}
        </div>}
      </article>)}
      <EmailReply active={active} sender={sender} mailbox={mailbox} editor={editor} />
    </div>}
  </div>;
}

export function EmailInbox({ active, mailbox, editor }) {
  const {
    stats,
    total,
    visibleEmails,
    filter,
    setFilter,
    search,
    setSearch,
    page,
    setPage,
    showArchived,
    setShowArchived,
  } = mailbox;
  const counts = stats || {};
  const firstPage = page === 1;
  const lastPage = page >= Math.ceil(total / 50);
  const filters = [
    { key: "all", label: "All", count: counts.total },
    { key: "unread", label: "Unread", count: counts.unread },
    { key: "starred", label: "Starred", count: counts.starred },
    { key: "leads", label: "Leads", color: D.green },
    { key: "invoices", label: "Invoices", color: D.purple },
    { key: "customer", label: "Customer", color: D.teal },
    { key: "complaints", label: "Complaints", color: D.red },
    { key: "vendor", label: "Vendor", count: counts.vendor },
  ];
  return (
    <>
      {/* Filter bar */}
      <div
        className="tab-pill-scroll"
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 12,
          alignItems: "center",
          flexWrap: "nowrap",
          overflowX: "auto",
          whiteSpace: "nowrap",
          WebkitOverflowScrolling: "touch",
        }}
      >
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => {
              setFilter(f.key);
              setPage(1);
            }}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              border: "none",
              flexShrink: 0,
              background:
                filter === f.key ? (f.color || D.teal) + "22" : "transparent",
              color: filter === f.key ? f.color || D.teal : D.muted,
            }}
          >
            {f.label}
            {f.count != null ? ` (${f.count})` : ""}
          </button>
        ))}
        <button
          onClick={() => {
            setShowArchived(!showArchived);
            setPage(1);
          }}
          style={{
            padding: "6px 14px",
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 500,
            cursor: "pointer",
            border: "none",
            flexShrink: 0,
            background: showArchived ? D.amber + "22" : "transparent",
            color: showArchived ? D.amber : D.muted,
          }}
        >
          Archived
        </button>{" "}
      </div>
      <div style={{ marginBottom: 16 }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search emails..."
          style={{
            padding: "8px 14px",
            background: D.card,
            border: `1px solid ${D.border}`,
            borderRadius: 8,
            color: D.text,
            fontSize: 13,
            width: "100%",
            maxWidth: 360,
            boxSizing: "border-box",
            outline: "none",
          }}
        />{" "}
      </div>
      {/* Email list */}
      <div
        style={{
          background: D.card,
          borderRadius: 12,
          border: `1px solid ${D.border}`,
          overflow: "hidden",
        }}
      >
        {visibleEmails.length === 0 ? (
          <div
            style={{
              padding: 40,
              textAlign: "center",
              color: D.muted,
              fontSize: 14,
            }}
          >
            No emails found
          </div>
        ) : (
          visibleEmails.map((email) => (
            <EmailMessage
              active={active}
              key={email.id}
              email={email}
              mailbox={mailbox}
              editor={editor}
            />
          ))
        )}
      </div>
      {/* Pagination */}
      {total > 50 && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: 8,
            marginTop: 16,
          }}
        >
          {" "}
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={firstPage}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              fontSize: 12,
              border: `1px solid ${D.border}`,
              background: "transparent",
              color: firstPage ? D.muted : D.text,
              cursor: firstPage ? "default" : "pointer",
            }}
          >
            Previous
          </button>{" "}
          <span style={{ padding: "6px 14px", fontSize: 12, color: D.muted }}>
            Page {page} of {Math.ceil(total / 50)}
          </span>{" "}
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={lastPage}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              fontSize: 12,
              border: `1px solid ${D.border}`,
              background: "transparent",
              color: lastPage ? D.muted : D.text,
              cursor: lastPage ? "default" : "pointer",
            }}
          >
            Next
          </button>{" "}
        </div>
      )}
    </>
  );
}
