import FollowThroughCards from '../follow-through/FollowThroughCards';
import RescheduleProposalCards from '../follow-through/RescheduleProposalCards';

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

export default function TechFollowThroughCards(props) {
  return <>
    {/* A technician gets no customer calls: no "Open call" link. */}
    <RescheduleProposalCards pollMs={TECH_POLL_MS} ui={fieldUi} openCall={false} />
    <FollowThroughCards pollMs={TECH_POLL_MS} {...props} ui={fieldUi} openCall={false} />
  </>;
}
