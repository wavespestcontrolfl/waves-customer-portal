/** READ-ONLY offline SMS sizing; all personalization is synthetic. No sends. */
const fs = require('fs');
const path = require('path');
const { catalogue } = require('./sms-template-audit-2026-09-07-reproduce.cjs');
const { normalizeGsmPunctuation } = require('../../server/services/messaging/gsm-normalize');
const { stripSmsUrlScheme } = require('../../server/services/messaging/sms-link-policy');
const { countSegments } = require('../../server/services/messaging/segment-counter');
const { formatSmsTemplateVars } = require('../../server/utils/sms-time-format');
const { OUTREACH_TEMPLATES, renderOutreachBody } = require('../../server/services/review-outreach-templates');
const { _SWAPS: copySwaps } = require('../../server/models/migrations/20260907000070_shorten_long_sms_templates');
const originalBodies = new Map(copySwaps.map(([key, before]) => [key, before]));
const base = 'https://portal.wavespestcontrol.com';
const short = `${base}/l/abcdefghjk`;
// Same length and shape as an invoice-number/date-prefixed short code;
// these are synthetic placeholders, never live invoice identifiers.
const invoiceShort = `${base}/l/xxxxxxxxxxxxx-0915-abcdefghjk`;
const vars = {
  prep_label:'Pest Control', prep_url:`${base}/prep/${'a'.repeat(32)}`,
  first_name:'Testname', account_first_name:'Testname', recipient_first_name:'Testname', referee_name:'Testname', referrer_name:'Testname',
  first:'Testname', name:'Testname', tech:'Tech', tech_name:'Tech',
  service_type:'Quarterly Pest Control', service:'Pest Control', service_label:'Quarterly Pest Control', service_name:'Lawn Care', invoice_title:'Quarterly Pest Control',
  date:'September 15', day:'Tuesday', service_date:'September 15', start_date:'September 15', charge_date:'September 15', effective_date:'September 15, 2026',
  first_visit_date:'September 15', visit_date:'September 15', resume_date:'October 15', term_end:'September 15, 2026', expires_at:'September 30', new_expiry:'September 30', exp_date:'09/2026',
  time:'09:00', window:'between 9:00 AM and 11:00 AM', window_text:' between 9:00 AM and 11:00 AM', when:'today', service_timing:'tomorrow',
  amount:'100.00', amount_text:' for $100.00', deposit_amount:'50', reward_amount:'$25', bonus_amount:'$25', count:'3', invoice_number:'X'.repeat(13), last_four:'4242', card_brand:'Visa',
  waveguard_tier:'Silver', new_tier:'Silver', next_tier:'Gold', tier_label:'Silver', milestone_level:'Silver', autopay_label:'Waves auto-pay',
  renewal_label:'annual protection', urgency:'ends soon', category:'re-service', response_time:'1 business day', project_type:'termite', overall_score:'85',
  coverage_summary:'12 months of service', property_address:'100 Example Street', scope:'recurring appointments',
  remaining:'Your lawn and mosquito services', summary:'Your pest control service is paused.', reference:'DEMO1234',
  hook_text:'It is time to plan your next pest treatment', custom_message:'Rain has delayed our route today.', weather_lead:'rain is expected', weather_phrase:'rain',
  new_option:'Tuesday, September 15, 9:00 AM - 11:00 AM',
  appointment_line:`Everything about your visit: ${short}\n\n`, reschedule_line:`Reschedule here: ${short}\n\n`, track_clause:`Track live: ${short}\n\n`, eta_line:'About 15 minutes away.\n\n',
  link_clause:` Details: ${short}`, receipt_line:`\n\nReceipt: ${invoiceShort}`, service_date_clause:' on September 15', date_line:' on September 15', first_visit_clause:' Your first visit is September 15.',
  address_clause:'', alt_clause:'', better_day_clause:'', callback_clause:'', cancel_fee_line:'', card_hold_policy_line:'', card_line:'', charge_note:'', delta_line:'', efficacy_clause:'', forecast_clause:'', last_service_sentence:'', past_due_line:'', tip_line:'',
  billing_url:`${base}/billing`, portal_url:short, report_url:short, price_change_url:short, quote_url:short, estimate_url:short, booking_url:short, referral_link:short, secure_link:`${base}/secure/${'a'.repeat(22)}`,
  pay_link:invoiceShort, pay_url:invoiceShort, receipt_url:invoiceShort, update_card_url:`${base}/billing`, review_url:short, google_review_url:'https://g.page/r/abcdefghijklmnop/review',
};
const expanded = {
  ...vars, first_name:'Longtestname', account_first_name:'Longtestname', recipient_first_name:'Longtestname', referee_name:'Longtestname', referrer_name:'Longtestname', first:'Longtestname', name:'Longtestname',
  service_type:'Quarterly Pest Control & Lawn Care', service:'Pest Control & Mosquito Control', service_label:'Quarterly Pest Control & Lawn Care', invoice_title:'Quarterly Pest Control & Lawn Care',
  card_line:' on Visa ending in 4242',
  cancel_fee_line:'$50 fee only for last-minute cancels or no-shows. ',
  card_hold_policy_line:'\n\nYour card on file holds this visit - cancel free until September 14 at 9:00 AM. After that, a $50 fee applies only if you cancel or no one is home. Rescheduling is always free.',
  past_due_line:'Your account also has a previous balance of $100.00. Please take care of it before your next service.',
  address_clause:' at your property', alt_clause:' Reply if another day works better.', better_day_clause:' This should give the treatment time to dry.', efficacy_clause:' This timing helps the treatment work.', forecast_clause:' We will watch the forecast and keep you posted.',
  callback_clause:' when convenient', charge_note:' (no additional charge today)', delta_line:', up 5 points', tip_line:' Keep mowing at the recommended height.', last_service_sentence:' Your last covered service is September 10.',
};
// A shortener failure passes through the original tokenized URL. This
// separate scenario illustrates sensitivity, not a universal maximum.
const longLinks = {...expanded};
for (const k of ['portal_url','report_url','price_change_url','quote_url','estimate_url','booking_url','referral_link','secure_link','pay_link','pay_url','receipt_url','review_url']) {
  const route = {pay_url:'pay',pay_link:'pay',receipt_url:'receipt',report_url:'reports',secure_link:'secure'}[k] || 'estimate';
  longLinks[k] = `${base}/${route}/${'a'.repeat(64)}`;
}
longLinks.appointment_line = `Everything about your visit: ${base}/appt/${'a'.repeat(64)}\n\n`;
longLinks.reschedule_line = `Reschedule here: ${base}/reschedule/${'a'.repeat(64)}\n\n`;
longLinks.track_clause = `Track live: ${base}/track/${'a'.repeat(64)}\n\n`;
longLinks.receipt_line = `\n\nReceipt: ${longLinks.receipt_url}`;
longLinks.link_clause = ` Details: ${base}/reschedule/${'a'.repeat(64)}`;
const oldStrip = body => body.replace(/https:\/\/(?=(?:portal\.wavespestcontrol\.com|waves-customer-portal-production\.up\.railway\.app)(?:[/\s]|$))/g,'');
function render(body, values) {
  const formatted = formatSmsTemplateVars(values);
  return body.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_,key) => {
    if (!(key in formatted)) throw Error('Missing sample variable '+key);
    return formatted[key];
  });
}
function describe(raw, templatePath, originalRaw = raw) {
  const tidy = s => templatePath ? s.replace(/\n{3,}/g,'\n\n').trim() : s;
  const before = normalizeGsmPunctuation(tidy(templatePath ? oldStrip(originalRaw) : originalRaw));
  const after = normalizeGsmPunctuation(tidy(stripSmsUrlScheme(raw)));
  return { before:countSegments(before), after:countSegments(after), beforeText:before, afterText:after, savedCharacters:before.length-after.length };
}
function dist(rows, scenario, state) {
  return rows.reduce((out,row) => { const n=row[scenario][state].segmentCount; out[n]=(out[n]||0)+1; return out; },{});
}
(async()=>{
  const model=await catalogue();
  const rows=model.templates.map(t=>({key:t.template_key, category:t.category, source:t._bodySource||t._source, sourceEnabled:t.is_active, scope:'sms_templates', template:t.body,
    standard:describe(render(t.body,vars),true,render(originalBodies.get(t.template_key)||t.body,vars)), expanded:describe(render(t.body,expanded),true,render(originalBodies.get(t.template_key)||t.body,expanded)), fallback:describe(render(t.body,longLinks),true,render(originalBodies.get(t.template_key)||t.body,longLinks))}));
  const outreach=OUTREACH_TEMPLATES.map(t=>({key:t.id,category:'review-outreach',scope:'code-registry',source:'server/services/review-outreach-templates.js',template:t.body,
    standard:describe(renderOutreachBody(t.body,vars),false), expanded:describe(renderOutreachBody(t.body,expanded),false),fallback:describe(renderOutreachBody(t.body,longLinks),false)}));
  const summary={templates:rows.length,sourceEnabled:rows.filter(r=>r.sourceEnabled).length,outreachTemplates:outreach.length};
  for (const [scope,set] of Object.entries({library:rows,enabled:rows.filter(r=>r.sourceEnabled),outreach})) {
    summary[scope]={};
    for(const scenario of ['standard','expanded','fallback']) summary[scope][scenario]={before:dist(set,scenario,'before'),after:dist(set,scenario,'after')};
  }
  const result={asOf:'2026-09-07',scope:'OFFLINE SOURCE MODEL, NOT LIVE DATABASE OR SENT-MESSAGE COUNTS',summary,variables:{standard:vars,expanded,fallback:longLinks},rows,outreach};
  const evidenceDir = path.resolve(__dirname, '../../.tmp/sms-audit');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'),JSON.stringify(result,null,2)+'\n');
  const quote=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
  const csv=[['scope','template_key','category','source_enabled','standard_segments_current','standard_segments_after','expanded_segments_current','expanded_segments_after','fallback_segments_current','fallback_segments_after','standard_slots_current','standard_characters_saved','source','standard_render_current','standard_render_after']];
  for(const r of [...rows,...outreach]) csv.push([r.scope,r.key,r.category,r.sourceEnabled,r.standard.before.segmentCount,r.standard.after.segmentCount,r.expanded.before.segmentCount,r.expanded.after.segmentCount,r.fallback.before.segmentCount,r.fallback.after.segmentCount,r.standard.before.gsmSlotCount,r.standard.savedCharacters,r.source,r.standard.beforeText,r.standard.afterText]);
  fs.writeFileSync(path.join(__dirname,'sms-template-audit-2026-09-07.csv'),csv.map(row=>row.map(quote).join(',')).join('\n')+'\n');
  console.log(JSON.stringify(summary,null,2));
  console.log('3+ STANDARD',rows.filter(r=>r.standard.before.segmentCount>=3).map(r=>({key:r.key,before:r.standard.before.segmentCount,after:r.standard.after.segmentCount,slots:r.standard.before.gsmSlotCount,sourceEnabled:r.sourceEnabled})));
  console.log('3+ EXPANDED',rows.filter(r=>r.expanded.before.segmentCount>=3).map(r=>({key:r.key,segments:r.expanded.before.segmentCount,slots:r.expanded.before.gsmSlotCount,sourceEnabled:r.sourceEnabled})));
  console.log('OUTREACH IMPROVEMENTS',outreach.filter(r=>r.standard.before.segmentCount!==r.standard.after.segmentCount).map(r=>r.key));
})().catch(e=>{console.error(e);process.exitCode=1;});
