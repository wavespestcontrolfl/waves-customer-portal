import { useOutletContext } from "react-router-dom";
import { Ban, Inbox, Mail, Plus, Send } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { UiSurface } from "../../components/ui/UiSurface";
import { Button } from "../../components/ui/Button";
import { ActionFeedback } from "../../components/ui/ActionFeedback";
import EmailComposer from "./email/EmailComposer";
import useEmailInbox from "./email/useEmailInbox";
import useEmailEditor from "./email/useEmailEditor";
import { EmailSummary, EmailInbox, BlockedSenders } from "./email/EmailMailbox";

const EMAIL_SECTIONS = [
  { key: "inbox", label: "Inbox", Icon: Inbox },
  { key: "blocked", label: "Blocked senders", Icon: Ban },
];

export default function EmailPage({ navigation, active }) {
  const { user } = useOutletContext();
  const editor = useEmailEditor(user.id);
  const mailbox = useEmailInbox(active, editor.clearDraftResult);
  const { status, stats, digest, tab, setTab, connecting, handleConnectGmail } = mailbox;
  const { setShowCompose, hasDrafts, hasComposeDraft, storageError, recoveryNotice } = editor;
  const action = status?.connected ? {
    key: "compose",
    label: hasComposeDraft ? "Resume draft" : "New email",
    icon: Plus,
    variant: mailbox.selectedEmail ? "secondary" : "primary",
    onClick: (event) => {
      event.currentTarget.focus({ preventScroll: true });
      setShowCompose(true);
    },
  } : status ? {
    label: connecting ? "Connecting..." : "Connect Gmail",
    icon: Send,
    onClick: handleConnectGmail,
    disabled: connecting,
  } : undefined;

  return <UiSurface density="comfortable" className="mx-auto max-w-[1300px] text-ui-body text-ink-primary">
    <AdminCommandHeader {...navigation} variant="workspace" sticky={false}
      secondarySections={status?.connected ? EMAIL_SECTIONS : []}
      secondaryActiveKey={tab} onSecondaryChange={setTab}
      secondaryAriaLabel="Email section" secondaryNavGridClassName="grid-cols-2" action={action} />
    {!status ? <div className="min-h-64 rounded-md border-hairline border-zinc-200 bg-white p-6" role="status">Loading email…</div>
      : !status.connected ? <div className="mx-auto my-10 max-w-lg rounded-md border-hairline border-zinc-200 bg-white p-6 text-center">
        <Mail size={28} className="mx-auto mb-4 text-ink-secondary" aria-hidden />
        <h2 className="mb-2 text-18 leading-[1.35] font-medium">Connect Gmail</h2>
        <p className="mb-5 text-ink-secondary">Connect your contact@wavespestcontrol.com inbox to view, reply, and manage emails directly from the portal.</p>
        <Button onClick={handleConnectGmail} loading={connecting}>Connect Gmail account</Button>
      </div> : <>
        {(hasDrafts || storageError) && <ActionFeedback error={storageError} className="mb-4">{recoveryNotice}</ActionFeedback>}
        <details open className="group mb-5 rounded-md border-hairline border-zinc-200 bg-white">
          <summary className="u-focus-ring min-h-11 cursor-pointer px-4 py-3 font-medium">Email activity</summary>
          <div className="px-4 pb-1"><EmailSummary stats={stats} digest={digest} /></div>
        </details>
        {tab === "blocked" && <BlockedSenders mailbox={mailbox} />}
        {tab === "inbox" && <EmailInbox active={active} mailbox={mailbox} editor={editor} />}
        <EmailComposer active={active} editor={editor} onSent={mailbox.loadStats} />
      </>}
  </UiSurface>;
}
