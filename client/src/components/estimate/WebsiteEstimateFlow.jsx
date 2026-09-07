import { useEffect, useRef, useState } from 'react';
import { perApplicationNetForFrequency } from './PriceCard';
import './website-estimate.css';

const CADENCE_NAMES = { 4: 'Quarterly', 6: 'Bi-Monthly', 9: 'Seasonal', 12: 'Monthly' };
const CADENCE_COUNTS = { quarterly: 4, bimonthly: 6, bi_monthly: 6, monthly: 12, seasonal9: 9 };
const money = value => Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

function applicationCount(frequency) {
  return Number(frequency?.visitsPerYear || frequency?.perServiceTreatments?.[0]?.visitsPerYear)
    || CADENCE_COUNTS[frequency?.key] || null;
}

export function WebsiteEstimateFrame({ title, timer, children }) {
  const frameRef = useRef(null);
  useEffect(() => {
    if (window.parent === window || !document.referrer) return undefined;
    let origin;
    try { origin = new URL(document.referrer).origin; } catch { return undefined; }
    const reportHeight = () => window.parent.postMessage({
      type: 'waves:estimate-height', height: Math.ceil(frameRef.current?.getBoundingClientRect().height || 700),
    }, origin);
    const observer = new ResizeObserver(reportHeight);
    if (frameRef.current) observer.observe(frameRef.current);
    reportHeight();
    window.parent.postMessage({ type: 'waves:estimate-step' }, origin);
    return () => observer.disconnect();
  }, [title]);
  return (
    <section ref={frameRef} className={`website-estimate${new URLSearchParams(window.location.search).get('embed') === '1' ? ' website-estimate-embedded' : ''}`} aria-label={title || 'Your estimate'}>
      <div className="website-estimate-content">
        <div className="website-progress" aria-hidden="true" />
        {timer ? <div className="website-timer">{timer}</div> : null}
        {title ? <h2 tabIndex={-1}>{title}</h2> : null}
        {children}
      </div>
    </section>
  );
}

// Presentation over the existing estimate selections and booking components.
// Every amount, frequency, slot, consent, and payment action comes from the
// canonical estimate page; this component creates no API or Stripe requests.
export default function WebsiteEstimateFlow({
  services, selected, onFrequencyChange, lockedSection, oneTime,
  oneTimeBreakdown, combinedFrequency, fees, bookingContent, reviewContent,
  reviewing, busy, timer, phone, phoneHref, canBook, error, callbackContent,
}) {
  const cadenceSections = oneTime ? [] : services.filter(section => (
    section.isRecurring && section.frequencies?.length > 1 && !lockedSection(section)
  ));
  const [step, setStep] = useState(0);
  const rootRef = useRef(null);
  const quoteStep = cadenceSections.length;
  const showingQuote = step === quoteStep;
  const cadence = cadenceSections[step];
  const title = reviewing ? 'Confirm Your Booking'
    : step > quoteStep ? 'Schedule Your Service'
      : showingQuote ? 'Your Quote' : `How often for ${cadence.label}?`;

  useEffect(() => {
    rootRef.current?.querySelector('h2')?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [title]);

  const priceRows = oneTime ? []
    : services.filter(section => section.isRecurring).map(section => {
      const frequency = section.frequencies?.find(item => item.key === selected[section.key]) || section.frequencies?.[0];
      const combinedRow = combinedFrequency?.perServiceTreatments?.find(item => item.service === section.key);
      const count = Number(combinedRow?.visitsPerYear) || applicationCount(frequency);
      const amount = combinedRow
        ? perApplicationNetForFrequency({ perServiceTreatments: [combinedRow] })
        : perApplicationNetForFrequency(frequency);
      return {
        key: section.key,
        label: `${CADENCE_NAMES[count] || frequency?.label || 'Recurring'} ${section.label} Service`,
        amount, unit: 'per application', cadence: `${count}x /yr`,
      };
    });

  priceRows.push(...(oneTimeBreakdown?.items || [])
    .filter(item => !fees.some(fee => fee.service && fee.service === item.service))
    .map((item, index) => ({
      key: `${item.service || item.label}-${index}`,
      label: item.kind === 'discount' ? item.label : `One-Time ${item.label || 'Service'}`,
      amount: item.amount, unit: item.kind === 'included' ? 'Included' : '',
    })));
  const fullyPriced = priceRows.length > 0 && priceRows.every(row => row.amount != null && Number.isFinite(Number(row.amount)));

  return (
    <div ref={rootRef}>
      <WebsiteEstimateFrame title={title} timer={reviewing ? timer : null}>
        {reviewing ? <div className="website-booking">{reviewContent}</div> : step > quoteStep ? (
          <div className="website-booking">
            {bookingContent}
            <button className="website-link" disabled={busy} onClick={() => setStep(quoteStep)}>← Back to Quote</button>
          </div>
        ) : showingQuote ? (
          <>
            {priceRows.map(row => (
              <div className="website-price-row" key={row.key}>
                <h3>{row.label.replace(/\bService Service\b/g, 'Service')}</h3>
                <strong>{row.amount != null && Number.isFinite(Number(row.amount)) ? money(row.amount) : 'We’ll confirm your price'}</strong>
                <small>{row.cadence}</small>
                {row.unit ? <span>{row.unit}</span> : null}
              </div>
            ))}
            {fees.map(fee => (
              <div className="website-fee-note" key={fee.service || fee.label}>
                <strong>{money(fee.amount)} {fee.service === 'waveguard_setup' ? 'one-time WaveGuard membership fee' : fee.label}</strong>
                <span>Added to your first application.</span>
                {fee.waivedWithPrepay ? <span>Waived when you prepay for the year.</span> : null}
              </div>
            ))}
            {canBook && fullyPriced ? <button className="website-primary" onClick={() => setStep(quoteStep + 1)}>Book My Service →</button>
              : <p>Our team will contact you to arrange your service.</p>}
            <div className="website-contact-actions">
              {callbackContent}
              <a className="website-secondary" href={phoneHref} aria-label={`Call Waves at ${phone}`}>Call Waves</a>
            </div>
            {quoteStep > 0 ? <button className="website-link" onClick={() => setStep(quoteStep - 1)}>← Change Frequency</button> : null}
          </>
        ) : cadence ? (
          <>
            <div className="website-cadences">
              {cadence.frequencies.map(frequency => (
                <button key={frequency.key} aria-pressed={selected[cadence.key] === frequency.key}
                  onClick={() => { onFrequencyChange(cadence.key, frequency.key); setStep(value => value + 1); }}>
                  <strong>{CADENCE_NAMES[applicationCount(frequency)] || frequency.label}</strong>
                  {applicationCount(frequency) ? <span>{applicationCount(frequency)}x /yr</span> : null}
                </button>
              ))}
            </div>
            {step > 0 ? <button className="website-link" onClick={() => setStep(value => value - 1)}>← Back</button> : null}
          </>
        ) : null}
        {!reviewing ? error : null}
      </WebsiteEstimateFrame>
    </div>
  );
}
