import { useRef, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export default function WebsiteCallbackButton({ token }) {
  const inFlight = useRef(false);
  const [status, setStatus] = useState('idle');
  const requestCall = async () => {
    if (inFlight.current || status === 'requested') return;
    inFlight.current = true;
    setStatus('sending');
    try {
      const response = await fetch(`${API_BASE}/estimates/${encodeURIComponent(token)}/change-request`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'callback' }),
      });
      const result = await response.json();
      if (!response.ok || result.success !== true) throw new Error('request_failed');
      setStatus('requested');
    } catch {
      setStatus('error');
    } finally {
      inFlight.current = false;
    }
  };
  return <div>
    <button className="website-secondary" type="button" onClick={requestCall}
      disabled={status === 'sending' || status === 'requested'}>
      {status === 'sending' ? 'Sending…' : status === 'requested' ? 'Call Requested' : 'Call Me'}
    </button>
    <p role="status" className="website-callback-status">
      {status === 'requested' ? 'We received your callback request.'
        : status === 'error' ? 'Your request didn’t go through. Try again or call Waves below.' : ''}
    </p>
  </div>;
}
