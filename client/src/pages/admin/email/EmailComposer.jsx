import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import useIsMobile from "../../../hooks/useIsMobile";
import useModalFocus from "../../../hooks/useModalFocus";
import { adminFetch } from "./emailApi";
import { X } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { Field } from "../../../components/ui/Field";
import { Input } from "../../../components/ui/Input";
import { Textarea } from "../../../components/ui/Textarea";
import { ActionFeedback } from "../../../components/ui/ActionFeedback";
import { useUiDensity } from "../../../components/ui/UiSurface";
import { cn } from "../../../components/ui/cn";
import EmailQuickLinks from "../../../components/admin/EmailQuickLinks";
import { appendStaticLinkClause } from "../../../lib/composerLinks";

import EmailSendOutcome from "./EmailSendOutcome";

export default function EmailComposer({ active, editor, onSent }) {
  const {
    composeForm,
    setComposeForm,
    showCompose,
    setShowCompose,
    composeSending,
    storageError,
    recoveryNotice,
    handleComposeSend,
  } = editor;
  const isMobile = useIsMobile();
  const density = useUiDensity();
  const close = () => {
    if (!composeSending) setShowCompose(false);
  };
  const composeRef = useModalFocus(active && showCompose, close);
  const [toResults, setToResults] = useState([]);
  const [toSearching, setToSearching] = useState(false);
  const [toDropdownOpen, setToDropdownOpen] = useState(false);
  const toFieldRef = useRef(null);
  const sendDisabled =
    composeSending || Boolean(editor.sendAttempts.compose) || !composeForm.to.trim() || !composeForm.body.trim();

  // Debounced customer lookup for the "To" field. Searches by name or
  // partial email via the customers list endpoint and keeps only matches
  // that actually have an email on file (the only ones we can send to).
  useEffect(() => {
    if (!active || !showCompose) return undefined;
    const q = composeForm.to.trim();
    if (q.length < 2) {
      setToResults([]);
      setToSearching(false);
      return undefined;
    }
    let cancelled = false;
    setToSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await adminFetch(
          `/api/admin/customers?search=${encodeURIComponent(q)}&limit=8`,
        );
        const d = await r.json();
        if (cancelled) return;
        setToResults((d.customers || []).filter((c) => c.email));
        setToSearching(false);
      } catch {
        if (cancelled) return;
        setToResults([]);
        setToSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [active, composeForm.to, showCompose]);

  // Dismiss the customer dropdown on an outside click/tap.
  useEffect(() => {
    if (!toDropdownOpen) return undefined;
    const handle = (e) => {
      if (toFieldRef.current && !toFieldRef.current.contains(e.target)) {
        setToDropdownOpen(false);
      }
    };
    document.addEventListener("pointerdown", handle, true);
    return () => document.removeEventListener("pointerdown", handle, true);
  }, [toDropdownOpen]);

  const handleSelectCustomer = (customer) => {
    setComposeForm((f) => ({ ...f, to: customer.email }));
    setToDropdownOpen(false);
    setToResults([]);
  };

  // Keep a guide send and its outcome mounted while the email channel is
  // hidden. The compose focus trap and Quick Links sheet follow visibility.
  const visible = active && showCompose;
  return createPortal(
    <div hidden={!visible} data-ui-density={density}
      className={cn("fixed inset-0 z-[1000] items-center justify-center bg-zinc-900/30", visible ? "flex" : "hidden", !isMobile && "p-4")}
      onClick={(event) => { event.stopPropagation(); close(); }}>
      <div onClick={(event) => event.stopPropagation()} role="dialog" ref={composeRef} aria-modal="true" aria-labelledby="email-compose-title"
        className={cn("flex w-full max-w-xl flex-col border-hairline border-zinc-200 bg-white text-ui-body text-ink-primary",
          isMobile ? "box-border h-full max-w-none" : "max-h-full rounded-md")}
        style={isMobile ? {
          paddingTop: "env(safe-area-inset-top, 0px)", paddingBottom: "env(safe-area-inset-bottom, 0px)",
          paddingLeft: "env(safe-area-inset-left, 0px)", paddingRight: "env(safe-area-inset-right, 0px)",
        } : undefined}>
        <div className="flex shrink-0 items-center justify-between gap-3 border-b-hairline border-zinc-200 px-4 py-3">
          <h2 id="email-compose-title" className="text-18 leading-[1.35] font-medium">New email</h2>
          <Button variant="ghost" onClick={close} disabled={composeSending} aria-label="Close"><X size={20} aria-hidden /></Button>
        </div>
        <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain p-4">
          <div ref={toFieldRef} className="relative">
            <Field id="email-compose-to" label="To" required>
              <Input type="email" value={composeForm.to} onChange={(event) => {
                setComposeForm((form) => ({ ...form, to: event.target.value })); setToDropdownOpen(true);
              }} onFocus={() => setToDropdownOpen(true)} placeholder="Search a customer or type an email…" autoComplete="off" />
            </Field>
            {toDropdownOpen && composeForm.to.trim().length >= 2 && <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-60 overflow-y-auto rounded-md border-hairline border-zinc-200 bg-white">
              {toSearching && toResults.length === 0 ? <p className="p-3 text-ink-secondary" role="status">Searching…</p>
                : toResults.length === 0 ? <p className="p-3 text-ink-secondary">No matching customers with an email</p>
                : toResults.map((customer) => <button key={customer.id} type="button" onClick={() => handleSelectCustomer(customer)}
                    className="u-focus-ring block min-h-11 w-full appearance-none border-0 border-b-hairline border-zinc-200 bg-white px-3 py-2 text-left text-ui-body hover:bg-zinc-50">
                    <span className="block truncate font-medium">{[customer.firstName, customer.lastName].filter(Boolean).join(" ") || customer.companyName || "Customer"}</span>
                    <span className="block truncate text-ink-secondary">{customer.email}</span>
                  </button>)}
            </div>}
          </div>
          <Field id="email-compose-subject" label="Subject">
            <Input value={composeForm.subject} onChange={(event) => setComposeForm((form) => ({ ...form, subject: event.target.value }))} />
          </Field>
          <Field id="email-compose-body" label="Message" required>
            <Textarea rows={8} value={composeForm.body} onChange={(event) => setComposeForm((form) => ({ ...form, body: event.target.value }))} />
          </Field>
          {!composeSending && <EmailSendOutcome attempt={editor.sendAttempts.compose} onResolve={outcome => editor.reconcileSend("compose", outcome)} />}
          {editor.sendFeedback.compose && <ActionFeedback error={editor.sendFeedback.compose.error}>{editor.sendFeedback.compose.message}</ActionFeedback>}
          <ActionFeedback error={storageError}>{recoveryNotice}</ActionFeedback>
          <EmailQuickLinks active={visible} recipient={composeForm.to} disabled={composeSending}
            onInsert={(link) => setComposeForm((form) => ({ ...form, body: appendStaticLinkClause(form.body, link) }))} />
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t-hairline border-zinc-200 px-4 py-3">
          <Button variant="secondary" onClick={close} disabled={composeSending}>Close</Button>
          <Button variant="ghost" disabled={composeSending} onClick={() => {
            setComposeForm(() => ({ to: "", subject: "", body: "" })); setShowCompose(false);
          }}>Discard draft</Button>
          <Button onClick={() => handleComposeSend(onSent)} loading={composeSending} disabled={sendDisabled}>Send</Button>
        </div>
      </div>
    </div>, document.body,
  );
}
