const db = require('../../models/db');
const TWILIO_NUMBERS = require('../../config/twilio-numbers');
const { NETWORK_DOMAINS, HUB_DOMAINS } = require('../../utils/normalize-url');
const { SPOKE_DOMAIN_TO_SOURCE_NAME, MAIN_SITE_NAME } = require('../lead-source-resolver');

// Per-site rollup: inbound calls (call_log, attributed via the tracking-number
// config) + leads (leads ⋈ lead_sources, attributed via the same canonical
// domain→source-name map the webhook resolver writes with). Calls and leads
// that don't belong to a fleet domain are NOT dropped — they surface in
// nonSiteLines / otherSources / unattributed so the columns always reconcile
// against raw table counts.

const DAY_MS = 24 * 60 * 60 * 1000;

// leads.first_contact_channel='call' rows were created FROM inbound calls, so
// "calls" and "callLeads" overlap by design — calls is volume, callLeads is
// how many of them became qualified pipeline entries.

const SOURCE_NAME_TO_DOMAIN = (() => {
  const map = { [MAIN_SITE_NAME]: 'wavespestcontrol.com' };
  for (const [domain, name] of Object.entries(SPOKE_DOMAIN_TO_SOURCE_NAME)) map[name] = domain;
  return map;
})();

function last10(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// Index every configured Twilio number by its last 10 digits.
// `lead_sources.twilio_phone_number` formats vary historically, and call_log
// rows predating toE164 normalization exist — last-10 matching covers both.
// Domain attribution intentionally uses getLeadSourceFromNumber (domain
// tracking takes precedence over location-line identity for shared numbers
// like the LWR GBP line that also serves hub city pages).
function buildNumberIndex() {
  const index = new Map();
  const register = (entry) => {
    const key = last10(entry.number);
    if (!key || index.has(key)) return;
    const attribution = TWILIO_NUMBERS.getLeadSourceFromNumber(entry.number);
    index.set(key, {
      number: entry.number,
      label: entry.label || entry.domain || entry.formatted || entry.number,
      domain: attribution.domain || null,
    });
  };
  TWILIO_NUMBERS.allNumbers.forEach(register);
  register(TWILIO_NUMBERS.mainLine);
  return index;
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function emptySite(domain) {
  const sourceName = SPOKE_DOMAIN_TO_SOURCE_NAME[domain] || '';
  return {
    domain,
    kind: HUB_DOMAINS.has(domain) ? 'hub' : 'spoke',
    lane: sourceName.startsWith('Spoke Lawn') || domain === 'waveslawncare.com' ? 'lawn' : 'pest',
    calls: 0,
    missedCalls: 0,
    leads: 0,
    formLeads: 0,
    callLeads: 0,
    won: 0,
  };
}

// Pure assembly — exercised directly by tests.
// callRows: [{ to_phone, calls, missed }]
// leadRows: [{ source_id, source_name, source_domain, leads, form_leads, call_leads, won }]
function assembleRollup({ callRows = [], leadRows = [] }) {
  const sites = new Map(NETWORK_DOMAINS.map((d) => [d, emptySite(d)]));
  const numberIndex = buildNumberIndex();
  const nonSiteLines = new Map();
  const otherSources = [];
  const unattributed = { leads: 0, formLeads: 0, callLeads: 0, won: 0 };

  for (const row of callRows) {
    const calls = toInt(row.calls);
    const missed = toInt(row.missed);
    const entry = numberIndex.get(last10(row.to_phone));
    const site = entry?.domain ? sites.get(entry.domain) : null;
    if (site) {
      site.calls += calls;
      site.missedCalls += missed;
    } else {
      const label = entry?.label || `Unrecognized ${row.to_phone || 'number'}`;
      const line = nonSiteLines.get(label) || { label, number: entry?.number || row.to_phone || null, calls: 0, missedCalls: 0 };
      line.calls += calls;
      line.missedCalls += missed;
      nonSiteLines.set(label, line);
    }
  }

  for (const row of leadRows) {
    const counts = {
      leads: toInt(row.leads),
      formLeads: toInt(row.form_leads),
      callLeads: toInt(row.call_leads),
      won: toInt(row.won),
    };
    const domain = SOURCE_NAME_TO_DOMAIN[row.source_name]
      || (row.source_domain && sites.has(row.source_domain) ? row.source_domain : null);
    if (domain) {
      const site = sites.get(domain);
      site.leads += counts.leads;
      site.formLeads += counts.formLeads;
      site.callLeads += counts.callLeads;
      site.won += counts.won;
    } else if (!row.source_id) {
      unattributed.leads += counts.leads;
      unattributed.formLeads += counts.formLeads;
      unattributed.callLeads += counts.callLeads;
      unattributed.won += counts.won;
    } else {
      otherSources.push({ name: row.source_name, ...counts });
    }
  }

  const siteList = [...sites.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'hub' ? -1 : 1;
    const volume = (b.calls + b.leads) - (a.calls + a.leads);
    return volume !== 0 ? volume : a.domain.localeCompare(b.domain);
  });
  const nonSiteList = [...nonSiteLines.values()].sort((a, b) => b.calls - a.calls);
  otherSources.sort((a, b) => b.leads - a.leads);

  const totals = {
    calls: siteList.reduce((s, x) => s + x.calls, 0) + nonSiteList.reduce((s, x) => s + x.calls, 0),
    missedCalls: siteList.reduce((s, x) => s + x.missedCalls, 0) + nonSiteList.reduce((s, x) => s + x.missedCalls, 0),
    siteCalls: siteList.reduce((s, x) => s + x.calls, 0),
    leads: siteList.reduce((s, x) => s + x.leads, 0) + otherSources.reduce((s, x) => s + x.leads, 0) + unattributed.leads,
    siteLeads: siteList.reduce((s, x) => s + x.leads, 0),
    won: siteList.reduce((s, x) => s + x.won, 0) + otherSources.reduce((s, x) => s + x.won, 0) + unattributed.won,
  };

  return { sites: siteList, nonSiteLines: nonSiteList, otherSources, unattributed, totals };
}

class SiteRollup {
  assembleRollup(input) {
    return assembleRollup(input);
  }

  async getRollup(days = 30) {
    const d = Math.min(365, Math.max(1, parseInt(days, 10) || 30));
    // Bind a real Date — a naive ISO string in a timestamptz WHERE shifts the
    // window by the UTC offset.
    const since = new Date(Date.now() - d * DAY_MS);

    const callRows = await db('call_log')
      .where('direction', 'inbound')
      .where('created_at', '>=', since)
      .groupBy('to_phone')
      .select('to_phone')
      .count('* as calls')
      .select(db.raw("count(*) filter (where status in ('no-answer','busy','failed','canceled')) as missed"));

    const leadRows = await db('leads as l')
      .leftJoin('lead_sources as ls', 'l.lead_source_id', 'ls.id')
      .where('l.first_contact_at', '>=', since)
      .groupBy('ls.id', 'ls.name', 'ls.domain')
      .select('ls.id as source_id', 'ls.name as source_name', 'ls.domain as source_domain')
      .count('* as leads')
      .select(db.raw("count(*) filter (where l.first_contact_channel = 'form') as form_leads"))
      .select(db.raw("count(*) filter (where l.first_contact_channel = 'call') as call_leads"))
      .select(db.raw("count(*) filter (where l.status = 'won') as won"));

    return { days: d, since: since.toISOString(), ...assembleRollup({ callRows, leadRows }) };
  }
}

module.exports = new SiteRollup();
