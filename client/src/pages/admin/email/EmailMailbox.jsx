import EmailReply from "./EmailReply";
import { D } from "./emailStyles";

function buildSandboxedEmailHtml(html) {
  return `<!doctype html>
<html> <head> <base target="_blank"> <meta charset="utf-8"> <style>body { margin: 0; padding: 0; color: #27272A; font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow-wrap: anywhere; }
      img { max-width: 100%; height: auto; }
      table { max-width: 100%; }
      a { color: #18181B; }
    </style> </head> <body>${html || ""}</body>
</html>`;
}

function EmailBody({ html, text }) {
  if (html) {
    return (
      <iframe
        title="Email body"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        srcDoc={buildSandboxedEmailHtml(html)}
        style={{
          width: "100%",
          height: 360,
          border: "none",
          background: "transparent",
        }}
      />
    );
  }

  return (
    <div
      style={{
        fontSize: 13,
        color: D.text,
        lineHeight: 1.6,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {text || ""}
    </div>
  );
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
  const d = new Date(dateStr);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function EmailSummary({ stats, digest }) {
  return (
    <>
      {/* Daily digest card */}
      {digest && digest.total_received > 0 && (
        <div
          style={{
            background: D.card,
            borderRadius: 10,
            padding: "14px 20px",
            border: `1px solid ${D.border}`,
            marginBottom: 16,
            display: "flex",
            gap: 24,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {" "}
          <div style={{ fontSize: 13, fontWeight: 500, color: D.heading }}>
            Today
          </div>{" "}
          <div style={{ fontSize: 12, color: D.muted }}>
            {" "}
            <span
              style={{
                color: D.text,
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {digest.total_received}
            </span>{" "}
            received
          </div>
          {[
            {
              label: "leads created",
              value: digest.leads_created,
              color: D.green,
            },
            {
              label: "spam quarantined",
              value: digest.spam_quarantined ?? digest.spam_blocked,
              color: D.red,
            },
            {
              label: "invoices",
              value: digest.invoices_processed,
              color: D.purple,
            },
            {
              label: "domains blocked",
              value: digest.domains_blocked_today,
              color: D.amber,
            },
          ]
            .filter((item) => item.value > 0)
            .map((item) => (
              <div key={item.label} style={{ fontSize: 12, color: item.color }}>
                {" "}
                <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  {item.value}
                </span>
                {item.label}
              </div>
            ))}
        </div>
      )}
      {/* Stats bar */}
      {stats && (
        <div style={{ display: "flex", gap: 16, marginBottom: 20 }}>
          {[
            {
              label: "Unread",
              value: stats.unread,
              color: stats.unread > 0 ? D.red : D.muted,
            },
            { label: "Today", value: stats.today, color: D.teal },
            { label: "Vendor", value: stats.vendor, color: D.purple },
            { label: "Total", value: stats.total, color: D.muted },
          ].map((s) => (
            <div
              key={s.label}
              style={{
                background: D.card,
                borderRadius: 8,
                padding: "12px 20px",
                border: `1px solid ${D.border}`,
                flex: 1,
              }}
            >
              {" "}
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  color: s.color,
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {s.value}
              </div>{" "}
              <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>
                {s.label}
              </div>{" "}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function BlockedSenders({ mailbox }) {
  const { blocked, blockInput, setBlockInput, handleBlock, handleUnblock } =
    mailbox;
  return (
    <div>
      {/* Block input */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {" "}
        <input
          value={blockInput}
          onChange={(e) => setBlockInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleBlock()}
          placeholder="Block domain or email (e.g. spammer.com or bad@example.com)"
          style={{
            flex: 1,
            padding: "10px 14px",
            background: D.card,
            border: `1px solid ${D.border}`,
            borderRadius: 8,
            color: D.text,
            fontSize: 13,
            outline: "none",
          }}
        />{" "}
        <button
          onClick={handleBlock}
          style={{
            padding: "10px 20px",
            background: D.red,
            color: "#fff",
            border: "none",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          Block
        </button>{" "}
      </div>
      {/* Blocked list */}
      <div
        style={{
          background: D.card,
          borderRadius: 12,
          border: `1px solid ${D.border}`,
          overflow: "hidden",
        }}
      >
        {blocked.length === 0 ? (
          <div
            style={{
              padding: 40,
              textAlign: "center",
              color: D.muted,
              fontSize: 14,
            }}
          >
            No blocked senders
          </div>
        ) : (
          blocked.map((b) => (
            <div
              key={b.id}
              style={{
                padding: "12px 20px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                borderBottom: `1px solid ${D.border}`,
              }}
            >
              {" "}
              <div>
                {" "}
                <div
                  style={{
                    fontSize: 13,
                    color: D.heading,
                    fontWeight: 500,
                  }}
                >
                  {b.domain || b.email_address}
                </div>{" "}
                <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>
                  {b.reason}{" "}
                  {b.blocked_count > 0 &&
                    `\u2014 ${b.blocked_count} emails caught`}
                  <span style={{ marginLeft: 8 }}>
                    {timeAgo(b.created_at)}
                  </span>{" "}
                </div>{" "}
              </div>{" "}
              <button
                onClick={() => handleUnblock(b.id)}
                style={{
                  padding: "5px 14px",
                  fontSize: 11,
                  borderRadius: 6,
                  border: `1px solid ${D.border}`,
                  background: "transparent",
                  color: D.muted,
                  cursor: "pointer",
                }}
              >
                Unblock
              </button>{" "}
            </div>
          ))
        )}
      </div>{" "}
    </div>
  );
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
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
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
