import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardCheck } from 'lucide-react';
import { request } from './common';

// Today-page card for staff onboarding documents (GATE_STAFF_ONBOARDING_DOCS). It sits in the
// page flow above the route, never over content. Hidden while staff documents are unavailable,
// while the server says onboarding is off, on a failed read, and when nothing is outstanding.
export function outstandingLabel(count) {
  return count === 1 ? 'Sign 1 document to finish setup' : `Sign ${count} documents to finish setup`;
}

// The first outstanding document, opened in the reader. A form or procedure starts the member's
// own record there; nothing is pre-created.
export function onboardingLink(base, visitSearch, item) {
  const params = new URLSearchParams(visitSearch);
  params.set('document', item.document_id);
  params.set('version', item.version_id);
  return `${base}/documents?${params}`;
}

export default function OnboardingCard({ available, base, visitSearch = '' }) {
  const [outstanding, setOutstanding] = useState([]);
  useEffect(() => {
    setOutstanding([]);
    if (!available) return undefined;
    const controller = new AbortController();
    Promise.resolve(request('/onboarding', undefined, controller.signal))
      .then(result => { if (!controller.signal.aborted && result?.enabled === true) setOutstanding(result.documents || []); })
      .catch(() => { if (!controller.signal.aborted) setOutstanding([]); });
    return () => controller.abort();
  }, [available]);
  if (!available || !outstanding.length) return null;
  return <section className="tf-card" data-testid="onboarding-card" aria-label="Finish setup" style={{ marginBottom: 12 }}>
    <div className="tf-card-top"><ClipboardCheck aria-hidden="true" />Finish setup</div>
    <div className="tf-card-main">
      <h2>{outstandingLabel(outstanding.length)}</h2>
      <p className="tf-muted">Next: {outstanding[0].title}</p>
      <div className="tf-actions"><Link className="tf-button tf-primary" to={onboardingLink(base, visitSearch, outstanding[0])}>Open {outstanding[0].title}</Link></div>
    </div>
  </section>;
}
