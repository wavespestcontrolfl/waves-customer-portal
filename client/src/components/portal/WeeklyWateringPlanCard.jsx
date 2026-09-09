import { useEffect, useRef, useState } from 'react';
import api from '../../utils/api';
import { COLORS as B, FONTS } from '../../theme-brand';
import { formatETDateOnly, etDatetimeLocalToISO } from '../../lib/timezone';

const cardStyle = {
  padding: 24, borderRadius: 12, border: '1px solid #E7E2D7',
  background: B.white, color: B.glassNavy, fontFamily: FONTS.ui,
  fontSize: 16, lineHeight: 1.55, scrollMarginTop: 'calc(90px + env(safe-area-inset-top, 0px))',
};

export default function WeeklyWateringPlanCard({ customerId, targetCustomerId, onOpenProperty, pending = false, refreshKey = 0 }) {
  const [data, setData] = useState(null);
  const cardRef = useRef(null);
  const scrolledTarget = useRef(null);
  useEffect(() => {
    let cancelled = false;
    let requestId = 0;
    const load = () => {
      const currentRequest = ++requestId;
      setData(null);
      if (pending || document.visibilityState === 'hidden') return;
      api.getWateringPlan().then((result) => {
        if (!cancelled && currentRequest === requestId) setData(result);
      }).catch(() => {
        if (!cancelled && currentRequest === requestId) setData(null);
      });
    };
    load();
    // Returning to an open app must revalidate moves, edits and policy/gate
    // changes. Hiding the document also retires any response still in flight.
    document.addEventListener('visibilitychange', load);
    window.addEventListener('focus', load);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', load);
      window.removeEventListener('focus', load);
    };
  }, [customerId, pending, refreshKey]);

  useEffect(() => {
    if (!data?.plan) return undefined;
    const end = new Date(etDatetimeLocalToISO(`${data.plan.validThrough}T23:59`)).getTime() + 60000;
    const timer = setTimeout(() => setData({ available: true, plan: null }), Math.max(0, end - Date.now()));
    return () => clearTimeout(timer);
  }, [data]);

  useEffect(() => {
    if (!targetCustomerId || !data?.available || pending || scrolledTarget.current === targetCustomerId) return;
    cardRef.current?.scrollIntoView?.({ behavior: 'auto', block: 'start' });
    scrolledTarget.current = targetCustomerId;
  }, [targetCustomerId, data, pending]);

  if (!data?.available || pending) return null;
  // A push may belong to a different property than the last one opened in
  // the app. Never show that selected property's instructions under the tap.
  if (targetCustomerId && String(targetCustomerId) !== String(customerId)) {
    return (
      <section ref={cardRef} data-glass="card" style={cardStyle} aria-label="Watering plan property">
        <h2 style={{ fontSize: 20, margin: '0 0 8px' }}>This plan is for another property</h2>
        <p style={{ margin: '0 0 16px' }}>Open the property this notification belongs to before following its watering plan.</p>
        {onOpenProperty ? (
          <button type="button" data-glass-accent="" onClick={onOpenProperty} style={{
            border: '1px solid #D8D0C0', borderRadius: 8, padding: '12px 16px',
            minHeight: 44, background: '#fff', color: B.glassNavy, fontSize: 16, cursor: 'pointer',
          }}>Open this property</button>
        ) : <p style={{ margin: 0 }}>Choose the matching property from your account menu.</p>}
      </section>
    );
  }

  const plan = data.plan;
  return (
    <section ref={cardRef} data-glass="card" style={cardStyle} aria-label="This week's watering plan">
      <h2 style={{ fontSize: 20, margin: '0 0 8px' }}>This week's watering plan</h2>
      {!plan ? <p style={{ margin: 0 }}>A current plan isn't available yet. Keep your irrigation details below up to date for your weekly check-in.</p> : (
        <>
          <div style={{ fontSize: 14, color: B.grayDark, marginBottom: 16 }}>
            Through {formatETDateOnly(plan.validThrough, { weekday: 'long', month: 'short', day: 'numeric' })}
          </div>
          <p style={{ margin: '0 0 16px' }}>{plan.summary}</p>
          <div style={{ background: '#FFF8E5', borderLeft: `4px solid ${B.gold}`, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{plan.title}</div>
            <div>{plan.instruction}</div>
          </div>
          {plan.note && <p>{plan.note}</p>}
          {plan.forecast && <p>{plan.forecast}</p>}
          {plan.restrictionNote && <p style={{ color: B.grayDark }}>{plan.restrictionNote}</p>}
          <p style={{ color: B.grayDark }}>Follow your latest service report for any watering-in required after treatment.</p>
          <h3 style={{ fontSize: 18, margin: '24px 0 12px' }}>Helpful guides from the Waves blog</h3>
          <ul style={{ paddingLeft: 20, margin: 0 }}>
            {plan.guides.map((guide) => (
              <li key={guide.url} style={{ marginBottom: 12 }}>
                <a href={guide.url} target="_blank" rel="noopener noreferrer" style={{ color: B.glassNavy, textDecoration: 'underline' }}>{guide.label}</a>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
