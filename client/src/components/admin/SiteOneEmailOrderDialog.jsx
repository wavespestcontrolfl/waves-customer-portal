import { useEffect, useState } from "react";
import {
  ActionFeedback,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

// The Restock tab's "Email order to SiteOne" (GATE_SITEONE_EMAIL_ORDER). It
// fetches the preview when it opens, shows exactly what will go to SiteOne,
// and sends only on Send email. A refusal (409) shows the server's message.
async function siteOneEmailFetch(requestId, method) {
  const res = await fetch(
    `${API_BASE}/admin/inventory/restock-requests/${encodeURIComponent(requestId)}/siteone-email`,
    {
      method,
      headers: {
        Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
        "Content-Type": "application/json",
      },
      ...(method === "POST" ? { body: "{}" } : {}),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

const dollars = (cents) => `$${(cents / 100).toFixed(2)}`;

export default function SiteOneEmailOrderDialog({ request, onClose, onSent }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    siteOneEmailFetch(request.id, "GET")
      .then((data) => {
        if (live) setPreview(data.preview);
      })
      .catch((err) => {
        if (live) setError(err.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [request.id]);

  async function send() {
    setSending(true);
    setError("");
    try {
      const result = await siteOneEmailFetch(request.id, "POST");
      onSent(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open onClose={sending ? undefined : onClose} layer={400} aria-label="Email order to SiteOne">
      <DialogHeader>
        <DialogTitle>Email order to SiteOne</DialogTitle>
        <div className="text-ui-body text-ink-secondary">{request.productName}</div>
      </DialogHeader>
      <DialogBody className="space-y-3 text-ui-body text-zinc-900">
        {error && <ActionFeedback error>{error}</ActionFeedback>}
        {loading && <div className="text-ink-secondary">Loading preview...</div>}
        {preview && (
          <>
            <div>
              <span className="text-ink-secondary">To: </span>
              {preview.to}
              {preview.cc ? (
                <div>
                  <span className="text-ink-secondary">Cc: </span>
                  {preview.cc}
                </div>
              ) : null}
            </div>
            <div>
              <span className="text-ink-secondary">Subject: </span>
              {preview.subject}
            </div>
            <pre className="m-0 whitespace-pre-wrap rounded-md border border-zinc-200 bg-zinc-50 p-3 font-sans text-ui-body">
              {preview.text}
            </pre>
            <div className="font-medium">
              Estimate before tax:{" "}
              {preview.estimateCents != null ? dollars(preview.estimateCents) : "not available"}
            </div>
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose} disabled={sending}>
          Cancel
        </Button>
        <Button type="button" variant="primary" onClick={send} disabled={!preview || sending}>
          {sending ? "Sending..." : "Send email"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
