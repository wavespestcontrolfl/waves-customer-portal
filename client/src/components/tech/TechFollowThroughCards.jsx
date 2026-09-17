import FollowThroughCards from '../follow-through/FollowThroughCards';
import RescheduleProposalCards from '../follow-through/RescheduleProposalCards';

const D = { card: '#1e293b', border: '#334155', text: '#e2e8f0', muted: '#94a3b8', teal: '#0ea5e9', red: '#fca5a5' };
const ui = {
  Card: ({ children }) => <article style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, padding: 16, color: D.text, fontSize: 14 }} className="space-y-2">{children}</article>,
  Text: ({ children, tone }) => <p style={{ margin: 0, fontSize: tone === 'title' ? 16 : 14, lineHeight: 1.5,
    color: tone === 'alert' ? D.red : tone === 'muted' ? D.muted : D.text,
    ...(tone === 'title' ? { fontFamily: "'Montserrat', sans-serif", fontWeight: 700 } : {}) }}>{children}</p>,
  Button: ({ secondary, disabled, ...props }) => <button {...props} type="button" disabled={disabled} style={{ minHeight: 44, padding: '8px 14px', fontSize: 14,
    border: `1px solid ${secondary ? D.border : D.teal}`, borderRadius: 6, background: secondary ? D.card : D.teal,
    color: '#fff', opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' }} />,
  Select: (props) => <select {...props} style={{ minHeight: 44, maxWidth: '100%', padding: '8px 10px', fontSize: 14, background: D.card, color: D.text, border: `1px solid ${D.border}`, borderRadius: 6 }} />,
  Link: (props) => <a {...props} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, color: D.text, fontSize: 14, textDecoration: 'underline' }} />,
};

const fieldUi = {
  Card: ({ children }) => <article className="tf-card tf-card-main space-y-2">{children}</article>,
  Text: ({ children, tone }) => <p className={tone === 'alert' ? 'tf-alert tf-error' : tone === 'muted' ? 'tf-muted' : undefined}>{tone === 'title' ? <strong>{children}</strong> : children}</p>,
  Button: ({ secondary, ...props }) => <button {...props} type="button" className={`tf-button${secondary ? '' : ' tf-primary'}`} />,
  Select: (props) => <select {...props} className="tf-button max-w-full" />,
  Link: (props) => <a {...props} className="tf-button" />,
};

// A fleet of tech tabs must not each run the ledger's fulfillment refresh
// twice a minute; the field poll is slow and window focus still refreshes.
const TECH_POLL_MS = 5 * 60 * 1000;

export default function TechFollowThroughCards({ fieldWorkspace = false, ...props }) {
  const selectedUi = fieldWorkspace ? fieldUi : ui;
  return <>
    <RescheduleProposalCards pollMs={TECH_POLL_MS} ui={selectedUi} />
    <FollowThroughCards pollMs={TECH_POLL_MS} {...props} ui={selectedUi} />
  </>;
}
