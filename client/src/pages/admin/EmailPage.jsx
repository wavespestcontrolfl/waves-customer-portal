import { useOutletContext } from "react-router-dom";
import { Ban, Inbox, Plus, Send } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import EmailComposer from "./email/EmailComposer";
import useEmailInbox from "./email/useEmailInbox";
import useEmailEditor from "./email/useEmailEditor";
import { EmailSummary, EmailInbox, BlockedSenders } from "./email/EmailMailbox";
import { D } from "./email/emailStyles";

export default function EmailPage({ navigation, active }) {
  const { user } = useOutletContext();
  const editor = useEmailEditor(user.id);
  const mailbox = useEmailInbox(active, editor.clearDraftResult);
  const { status, stats, digest, tab, setTab, connecting, handleConnectGmail } =
    mailbox;
  const {
    setShowCompose,
    hasDrafts,
    hasComposeDraft,
    storageError,
    recoveryNotice,
  } = editor;
  // Not connected — show connect card
  if (status && !status.connected) {
    return (
      <div style={{ maxWidth: 1300, margin: "0 auto" }}>
        {" "}
        <AdminCommandHeader
          {...navigation}
          action={{
            label: connecting ? "Connecting..." : "Connect Gmail",
            icon: Send,
            onClick: handleConnectGmail,
            disabled: connecting,
          }}
        />{" "}
        <div
          style={{
            background: D.card,
            borderRadius: 12,
            padding: 40,
            textAlign: "center",
            border: `1px solid ${D.border}`,
            maxWidth: 480,
            margin: "60px auto",
          }}
        >
          {" "}
          <div style={{ fontSize: 48, marginBottom: 16 }}>Email</div>{" "}
          <div
            style={{
              fontSize: 20,
              fontWeight: 500,
              color: D.heading,
              marginBottom: 8,
            }}
          >
            Connect Gmail
          </div>{" "}
          <div
            style={{
              fontSize: 14,
              color: D.muted,
              marginBottom: 24,
              lineHeight: 1.5,
            }}
          >
            Connect your contact@wavespestcontrol.com inbox to view, reply, and
            manage emails directly from the portal.
          </div>{" "}
          <button
            type="button"
            onClick={handleConnectGmail}
            disabled={connecting}
            style={{
              display: "inline-block",
              padding: "12px 32px",
              background: D.teal,
              color: "#fff",
              borderRadius: 8,
              fontSize: 15,
              fontWeight: 500,
              textDecoration: "none",
              border: "none",
              cursor: connecting ? "default" : "pointer",
              opacity: connecting ? 0.6 : 1,
            }}
          >
            {connecting ? "Connecting..." : "Connect Gmail Account"}
          </button>{" "}
        </div>{" "}
      </div>
    );
  }

  if (!status) {
    return (
      <div style={{ maxWidth: 1300, margin: "0 auto" }}>
        {" "}
        <AdminCommandHeader {...navigation} />{" "}
        <div style={{ padding: 40, color: D.muted }}>Loading...</div>{" "}
      </div>
    );
  }

  const emailSections = [
    { key: "inbox", label: "Inbox", Icon: Inbox },
    { key: "blocked", label: "Blocked Senders", Icon: Ban },
  ];
  return (
    <div style={{ maxWidth: 1300, margin: "0 auto" }}>
      {" "}
      <AdminCommandHeader
        {...navigation}
        secondarySections={emailSections}
        secondaryActiveKey={tab}
        onSecondaryChange={setTab}
        secondaryAriaLabel="Email section"
        secondaryNavGridClassName="grid-cols-2"
        action={{
          label: hasComposeDraft ? "Resume draft" : "New Email",
          icon: Plus,
          onClick: () => setShowCompose(true),
        }}
      />
      {(hasDrafts || storageError) && (
        <p
          role={storageError ? "alert" : "status"}
          style={{ fontSize: 14, color: storageError ? D.red : D.muted }}
        >
          {recoveryNotice}
        </p>
      )}
      <EmailSummary stats={stats} digest={digest} />
      {tab === "blocked" && <BlockedSenders mailbox={mailbox} />}
      {tab === "inbox" && <EmailInbox mailbox={mailbox} editor={editor} />}
      <EmailComposer
        active={active}
        editor={editor}
        onSent={mailbox.loadStats}
      />
    </div>
  );
}
