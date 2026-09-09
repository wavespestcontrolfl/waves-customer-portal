import { D } from "./emailStyles";

export default function EmailSendOutcome({ attempt, onResolve }) {
  if (!attempt || attempt.status === "running") return null;
  const accepted = attempt.status === "provider_accepted";
  return <div role="alert" style={{ padding: 12, marginTop: 8, fontSize: 14, color: D.text, border: `1px solid ${D.border}`, borderRadius: 6 }}>
    <p style={{ margin: "0 0 8px" }}>{accepted
      ? "Gmail accepted this email. Do not send it again."
      : "Email outcome unknown. Check the connected Gmail account’s Sent folder before deciding whether to retry."}</p>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {(accepted ? [["sent", "Dismiss accepted send"]] : [["sent", "I checked Sent: it was sent"], ["not_sent", "I checked Sent: it was not sent"]]).map(([outcome, label]) =>
        <button key={outcome} type="button" onClick={() => onResolve(outcome)}
          style={{ padding: "10px 12px", minHeight: 44, fontSize: 14, border: `1px solid ${D.border}`, borderRadius: 6, background: D.bg, color: D.text, cursor: "pointer" }}>{label}</button>)}
    </div>
  </div>;
}
