import React, { useState } from 'react';
import { Download } from 'lucide-react';
import { Button, Input, Select, Card, CardHeader, CardTitle, CardBody, UiSurface } from '../ui';
import { BID_FORM_PROFILES, formatLineBasis } from '@proposal-bid';

export default function ProposalBidForm({ buildings, onDownload, disabled }) {
  const [template, setTemplate] = useState('north_port_pr27_02');
  const [pageNumber, setPageNumber] = useState(15);
  const [file, setFile] = useState(null);
  const [mapping, setMapping] = useState({});
  const [details, setDetails] = useState({ companyName: 'Waves Pest Control, LLC', authorizedName: '', shippingMethod: '', leadTime: '', comments: '', ocipDeduct: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const profile = BID_FORM_PROFILES[template];
  const lines = buildings.flatMap((building) => building.lineItems.filter((line) => line.description.trim()).map((line) => ({ ...line, building: building.name })));
  const download = async () => {
    setError(''); setBusy(true);
    try {
      if (!file) throw new Error('Choose the original bid-form PDF.');
      if (file.size > 12 * 1024 * 1024) throw new Error('The PDF must be 12 MB or smaller.');
      const activeMapping = Object.fromEntries(lines.map((line) => [line.id, mapping[line.id] || '']));
      await onDownload({ file, template, pageNumber, mapping: activeMapping, details });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <UiSurface as={Card}>
    <CardHeader><CardTitle>Required bid form</CardTitle></CardHeader>
    <CardBody className="space-y-4 text-14">
      <p className="text-zinc-600">Fill a supported original form with saved proposal prices. The download retains every page of the uploaded PDF. Review the completed form and finish signatures, dates, and attestations before submission.</p>
      <label className="block">Form layout<Select disabled={busy || disabled} value={template} onChange={(e) => { setTemplate(e.target.value); setPageNumber(BID_FORM_PROFILES[e.target.value].page); setMapping({}); }}>
        {Object.entries(BID_FORM_PROFILES).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
      </Select></label>
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px] gap-3">
        <label className="block min-w-0">Original PDF<Input type="file" accept="application/pdf,.pdf" className="w-full min-w-0" disabled={busy || disabled} onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
        <label>Form page<Input type="number" min="1" max="100" step="1" value={pageNumber} disabled={busy || disabled} onChange={(e) => setPageNumber(e.target.value)} /></label>
      </div>
      <p className="text-zinc-600">Set a fixed Valid through date in Commercial terms that meets the bid’s price hold. {profile.minimumValidThrough ? `For North Port Addendum No. 1, use ${new Date(`${profile.minimumValidThrough}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })} or later (90 days after the amended September 22 deadline).` : 'Cove requires a 90-day hold; confirm the submission date when setting the end date.'}</p>
      <p className="text-zinc-600">Use One-time frequency for every quoted line and map each line to a form row. {template === 'cove_termite' ? 'Square-foot lines supply the SF breakdown; count each treated area once. Base-bid row prices include any quoted tax.' : 'Product lines use lb or gal; application lines use acres. Each of those rows must share a single unit price. The quote total is limited to $34,999.99.'}</p>
      {lines.map((line) => <label key={line.id} className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-center border-b border-hairline border-zinc-100 pb-2">
        <span>{line.building} · {line.description}<span className="block text-zinc-600">{formatLineBasis(line)}</span></span>
        <Select aria-label={`Form row for ${line.description}`} disabled={busy || disabled} value={mapping[line.id] || ''} onChange={(e) => setMapping((prev) => ({ ...prev, [line.id]: e.target.value }))}>
          <option value="">Choose form row</option>
          {Object.entries(profile.rows).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </Select>
      </label>)}
      {template === 'north_port_pr27_02' ? <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {[['companyName', 'Company name'], ['authorizedName', 'Authorized person’s printed name'], ['shippingMethod', 'Shipping method'], ['leadTime', 'Delivery lead time'], ['comments', 'Quoter comments']].map(([key, label]) => <label key={key}>{label}<Input value={details[key]} maxLength={key === 'comments' ? 120 : 80} disabled={busy || disabled} onChange={(e) => setDetails((prev) => ({ ...prev, [key]: e.target.value }))} /></label>)}
      </div> : <label className="block max-w-xs">OCIP deduct alternate (enter 0 if none)<Input type="number" min="0" step="0.01" value={details.ocipDeduct} disabled={busy || disabled} onChange={(e) => setDetails((prev) => ({ ...prev, ocipDeduct: e.target.value }))} /></label>}
      {error && <p role="alert" className="text-alert-fg">{error}</p>}
      <Button variant="secondary" disabled={busy || disabled || !file || !lines.length} onClick={download}><Download size={15} /> {busy ? 'Preparing form…' : 'Download filled bid form'}</Button>
    </CardBody>
  </UiSurface>;
}
