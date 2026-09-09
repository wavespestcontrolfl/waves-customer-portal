import { Button } from "../../../components/ui/Button";
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

const CATEGORY_COLORS = {
  lead_inquiry: D.green,
  customer_request: D.teal,
  complaint: D.red,
  vendor_invoice: D.purple,
  vendor_communication: D.purple,
  scheduling: D.amber,
  review_notification: D.amber,
  regulatory: D.red,
  marketing_newsletter: D.muted,
  internal: D.teal,
  spam: D.red,
  other: D.muted,
};

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

function EmailMessage({ active, email, mailbox, editor }) {
  const {
    selectedEmail,
    thread,
    openEmail,
    handleStar,
    removeEmail,
    handleReclassify,
    handleDownloadAttachment,
  } = mailbox;
  const { drafts } = editor;
  const isSelected = selectedEmail?.id === email.id;
  let extractedData = null;
  try {
    extractedData =
      typeof email.extracted_data === "string"
        ? JSON.parse(email.extracted_data)
        : email.extracted_data || null;
  } catch {
    extractedData = null;
  }
  const category = email.classification;
  const categoryColor = CATEGORY_COLORS[category];
  const categoryLabel = CATEGORY_LABELS[category];
  const autoActionLabel = AUTO_ACTION_LABELS[category];
  const sender = email.from_name || email.from_address;
  const vendorName = extractedData?.vendor_name;
  const readStyle = email.is_read
    ? {
        senderWeight: 400,
        subjectWeight: 400,
        senderColor: D.muted,
        subjectColor: D.muted,
        background: "transparent",
        dot: "transparent",
      }
    : {
        senderWeight: 700,
        subjectWeight: 600,
        senderColor: D.heading,
        subjectColor: D.text,
        background: D.bg + "88",
        dot: D.teal,
      };

  return (
    <div key={email.id}>
      {" "}
      <div
        onClick={() => openEmail(email)}
        style={{
          padding: "14px 20px",
          cursor: "pointer",
          display: "flex",
          gap: 12,
          alignItems: "flex-start",
          borderBottom: `1px solid ${D.border}`,
          background: isSelected ? D.teal + "11" : readStyle.background,
        }}
      >
        {/* Star */}
        <span
          onClick={(e) => handleStar(e, email)}
          style={{
            cursor: "pointer",
            fontSize: 16,
            flexShrink: 0,
            marginTop: 2,
          }}
        >
          {email.is_starred ? "\u2B50" : "\u2606"}
        </span>
        {/* Unread dot */}
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: readStyle.dot,
            flexShrink: 0,
            marginTop: 7,
          }}
        />
        {/* Content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {" "}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 2,
            }}
          >
            {" "}
            <div
              style={{
                fontSize: 13,
                fontWeight: readStyle.senderWeight,
                color: readStyle.senderColor,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {sender}
              {drafts.replies[email.id] && (
                <span style={{ fontSize: 14, marginLeft: 8 }}>Draft</span>
              )}
            </div>{" "}
            <div
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
                flexShrink: 0,
                marginLeft: 8,
              }}
            >
              {/* Category badge */}
              {categoryLabel && (
                <span
                  style={{
                    fontSize: 10,
                    padding: "2px 8px",
                    borderRadius: 4,
                    background: categoryColor + "22",
                    color: categoryColor,
                    fontWeight: 500,
                  }}
                >
                  {categoryLabel}
                </span>
              )}
              <span
                style={{
                  fontSize: 11,
                  color: D.muted,
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {timeAgo(email.received_at)}
              </span>{" "}
            </div>{" "}
          </div>{" "}
          <div
            style={{
              fontSize: 13,
              fontWeight: readStyle.subjectWeight,
              color: readStyle.subjectColor,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              marginBottom: 2,
            }}
          >
            {email.subject || "(no subject)"}
            {email.has_attachments && " \uD83D\uDCCE"}
          </div>{" "}
          <div
            style={{
              display: "flex",
              gap: 6,
              alignItems: "center",
            }}
          >
            {" "}
            <div
              style={{
                fontSize: 12,
                color: D.muted,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
              }}
            >
              {email.snippet}
            </div>
            {vendorName && (
              <span
                style={{
                  fontSize: 10,
                  padding: "2px 8px",
                  borderRadius: 4,
                  background: D.purple + "22",
                  color: D.purple,
                  fontWeight: 500,
                  flexShrink: 0,
                }}
              >
                {vendorName}
              </span>
            )}
          </div>
          {/* Auto-action indicator */}
          {autoActionLabel && (
            <div
              style={{
                fontSize: 11,
                color: categoryColor,
                marginTop: 4,
                opacity: 0.8,
              }}
            >
              {"\u2713"} {autoActionLabel}
            </div>
          )}
        </div>{" "}
      </div>
      {/* Expanded thread view */}
      {isSelected && (
        <div
          style={{
            background: D.bg,
            borderBottom: `1px solid ${D.border}`,
            padding: "20px 24px",
          }}
        >
          {/* Actions */}
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            {[
              {
                label: "Archive",
                icon: "\uD83D\uDCE5",
                action: () => removeEmail(email.id, "archive"),
              },
              {
                label: "Trash",
                icon: "\uD83D\uDDD1\uFE0F",
                action: () => removeEmail(email.id, "trash"),
              },
              {
                label: "Reclassify",
                icon: "\uD83E\uDD16",
                action: () => handleReclassify(email.id),
              },
            ].map((a) => (
              <button
                key={a.label}
                onClick={a.action}
                style={{
                  padding: "5px 12px",
                  fontSize: 12,
                  borderRadius: 6,
                  border: `1px solid ${D.border}`,
                  background: "transparent",
                  color: D.muted,
                  cursor: "pointer",
                }}
              >
                {a.icon} {a.label}
              </button>
            ))}
          </div>
          {/* Classification detail */}
          {extractedData && (
            <div
              style={{
                background: D.card,
                borderRadius: 8,
                padding: "10px 14px",
                border: `1px solid ${D.border}`,
                marginBottom: 16,
                fontSize: 12,
              }}
            >
              {" "}
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                {" "}
                <span style={{ color: D.muted }}>AI classification:</span>{" "}
                <span
                  style={{
                    color: categoryColor,
                    fontWeight: 500,
                  }}
                >
                  {categoryLabel || category}
                </span>
                {[
                  {
                    key: "urgency",
                    value: extractedData.urgency,
                    prefix: "Urgency: ",
                    style: {
                      color: extractedData.urgency === "high" ? D.red : D.amber,
                    },
                  },
                  {
                    key: "person",
                    value: extractedData.person_name,
                    style: { color: D.text },
                  },
                  {
                    key: "phone",
                    value: extractedData.phone,
                    style: {
                      color: D.text,
                      fontFamily: "'JetBrains Mono', monospace",
                    },
                  },
                  {
                    key: "service",
                    value: extractedData.service_interest,
                    style: { color: D.green },
                  },
                  {
                    key: "invoice",
                    value: extractedData.invoice_amount,
                    prefix: "$",
                    style: {
                      color: D.purple,
                      fontFamily: "'JetBrains Mono', monospace",
                    },
                  },
                ]
                  .filter((detail) => detail.value)
                  .map((detail) => (
                    <span key={detail.key} style={detail.style}>
                      {detail.prefix}
                      {detail.value}
                    </span>
                  ))}
              </div>{" "}
            </div>
          )}
          {/* Thread messages */}
          {thread.map((msg) => (
            <div
              key={msg.id}
              style={{
                marginBottom: 16,
                background: D.card,
                borderRadius: 8,
                padding: 16,
                border: `1px solid ${D.border}`,
              }}
            >
              {" "}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 8,
                }}
              >
                {" "}
                <div>
                  {" "}
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: D.heading,
                    }}
                  >
                    {msg.from_name || msg.from_address}
                  </span>{" "}
                  <span
                    style={{
                      fontSize: 12,
                      color: D.muted,
                      marginLeft: 8,
                    }}
                  >
                    &lt;{msg.from_address}&gt;
                  </span>{" "}
                </div>{" "}
                <span
                  style={{
                    fontSize: 11,
                    color: D.muted,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  {new Date(msg.received_at).toLocaleString("en-US", {
                    timeZone: "America/New_York",
                  })}
                </span>{" "}
              </div>
              {msg.to_address && (
                <div
                  style={{
                    fontSize: 11,
                    color: D.muted,
                    marginBottom: 8,
                  }}
                >
                  To: {msg.to_address}
                </div>
              )}
              <EmailBody html={msg.body_html} text={msg.body_text} />
              {msg.attachments?.length > 0 && (
                <div
                  style={{
                    marginTop: 12,
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  {msg.attachments.map((att) => (
                    <a
                      key={att.id}
                      href={`/api/admin/email/message/${msg.id}/attachment/${att.gmail_attachment_id}`}
                      onClick={(event) =>
                        handleDownloadAttachment(event, msg, att)
                      }
                      style={{
                        padding: "6px 12px",
                        background: D.card,
                        border: `1px solid ${D.border}`,
                        borderRadius: 6,
                        fontSize: 12,
                        color: D.teal,
                        textDecoration: "none",
                      }}
                    >
                      {"\uD83D\uDCCE"} {att.filename} (
                      {Math.round((att.size_bytes || 0) / 1024)}
                      KB)
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
          <EmailReply active={active} sender={sender} mailbox={mailbox} editor={editor} />{" "}
        </div>
      )}
    </div>
  );
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
