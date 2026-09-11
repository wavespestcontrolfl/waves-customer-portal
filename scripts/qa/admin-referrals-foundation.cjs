'use strict';
/* global document, localStorage, innerWidth, getComputedStyle */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, evidence, waitForFonts } = require('./browser');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/admin-referrals-foundation');
const html = `<!doctype html><html class="admin-app"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/index.css"><link rel="stylesheet" href="/src/styles/brand-tokens.css"></head><body><main id="root" class="admin-shell-v2" style="padding:16px"></main><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
const React = (await import('/node_modules/.vite/deps/react.js')).default;
const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
const Page = (await import('/src/pages/admin/ReferralsPage.jsx')).default;
createRoot(document.getElementById('root')).render(React.createElement(Page));
</script></body></html>`;
async function main() {
 fs.mkdirSync(output,{recursive:true});
 const report={...evidence(root),passed:false,requests:[],unmatched:[],errors:[]};
 const server=await previewServer(root,process.env.ADMIN_UI_PREVIEW_URL),browser=await launchBrowser();
 try {
  for(const width of [1440,390,820]) {
   let enrollFailure=true;
   const referral={id:'ref-1',referral_first_name:'Avery',referral_last_name:'Example',referral_phone:'2025550100',referral_email:'avery@example.invalid',promoter_name:'Morgan Example',source:'admin',status:'pending',referral_notes:'Synthetic referral'};
   const promoter={id:'prom-1',first_name:'Morgan',last_name:'Example',customer_phone:'2025550101',total_clicks:8,total_referrals_converted:1,total_referrals_sent:2,total_earned_cents:3000,click_balance_cents:100,referral_balance_cents:2000,clicki_referral_link:'https://example.invalid/ref/fixture'};
   const payout={id:'pay-1',first_name:'Morgan',last_name:'Example',amount_cents:2000,method:'account_credit',status:'pending'};
   const context=await browser.newContext({viewport:{width,height:900},hasTouch:width<1440,serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(60000);
   page.on('pageerror',e=>report.errors.push(e.message));await page.routeWebSocket('**/*',socket=>socket.close());
   await page.addInitScript(()=>localStorage.setItem('waves_admin_token','synthetic-token'));
   await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),endpoint=url.pathname.replace('/api/admin/referrals','');
    if(url.origin!==server.baseUrl)return route.abort();
    if(url.pathname==='/qa-referrals')return route.fulfill({contentType:'text/html',body:html});
    if(!url.pathname.startsWith('/api/'))return route.continue();
    report.requests.push({width,path:url.pathname,method:request.method(),body:request.postDataJSON()});
    let body,status=200;
    if(request.method()==='GET') {
      body=endpoint==='/stats'?{activePromoters:1,totalReferrals:1,convertedReferrals:0,pendingReferrals:1,totalClicks:8,totalReferralRewards:2000,totalClickRewards:100,totalPaidOut:0,pendingPayouts:1}:endpoint==='/promoters'?{promoters:[promoter]}:endpoint==='/queue'?{referrals:[referral]}:endpoint==='/payouts'?{payouts:[payout]}:undefined;
    } else if(endpoint==='/enroll') {status=enrollFailure?503:200;body=enrollFailure?{error:'Synthetic outage'}:{promoter};}
    else if(endpoint==='/submit')body={};
    else if(endpoint==='/ref-1/status'){referral.status=request.postDataJSON().status;body={};}
    else if(endpoint==='/payouts/pay-1/approve'){payout.status='applied';body={};}
    if(body===undefined){report.unmatched.push(url.pathname);return route.abort();}
    return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   });
   await page.goto(`${server.baseUrl}/qa-referrals`,{waitUntil:"domcontentloaded"});await page.getByText('Recent Referrals',{exact:true}).waitFor();await waitForFonts(page);
   async function capture(name){
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'overflow '+name);
    const controls=await page.locator('button,input').evaluateAll(nodes=>nodes.filter(n=>n.getBoundingClientRect().width>0).map(n=>({height:n.getBoundingClientRect().height,font:parseFloat(getComputedStyle(n).fontSize)})));
    assert.ok(controls.every(c=>c.height>=44&&c.font>=14),JSON.stringify(controls));
    await page.screenshot({path:path.join(output,`${name}-${width}.png`),fullPage:true,animations:"disabled"});
   }
   await capture('dashboard');
   await page.getByRole('button',{name:'Queue (1)',exact:true}).click();await capture('queue');
   const values={'Promoter phone':'2025550101','First name *':'Taylor','Last name':'Example','Phone *':'2025550102','Email':'taylor@example.invalid','Address':'Synthetic location','Notes':'Synthetic test'};
   for(const [label,value] of Object.entries(values))await page.getByLabel(label,{exact:true}).fill(value);
   await Promise.all([page.waitForResponse(r=>r.url().endsWith('/submit')),page.getByRole('button',{name:'Submit Referral',exact:true}).click()]);
   assert.deepEqual(report.requests.filter(r=>r.path.endsWith('/submit')).at(-1).body,{promoterPhone:values['Promoter phone'],referralFirstName:'Taylor',referralLastName:'Example',referralPhone:'2025550102',referralEmail:'taylor@example.invalid',referralAddress:'Synthetic location',referralNotes:'Synthetic test',source:'admin'});
   await page.getByRole('button',{name:'Contacted',exact:true}).click();await page.getByRole('button',{name:'Convert',exact:true}).waitFor();
   await page.getByRole('button',{name:'Convert',exact:true}).click();await page.getByText('converted',{exact:true}).waitFor();
   await page.getByRole('button',{name:'Promoters',exact:true}).click();assert.equal(await page.getByRole('link',{name:'Copy',exact:true}).getAttribute('href'),promoter.clicki_referral_link);await capture('promoters');
   await page.getByRole('button',{name:'Payouts',exact:true}).click();await capture('payouts');
   await Promise.all([page.waitForResponse(r=>r.url().endsWith('/approve')),page.getByRole('button',{name:'Approve',exact:true}).click()]);assert.deepEqual(report.requests.filter(r=>r.path.endsWith('/approve')).at(-1).body,{});await page.getByText('applied',{exact:true}).waitFor();
   await page.getByRole('button',{name:'Enroll',exact:true}).click();
   for(const [label,value] of Object.entries({'First name *':'Taylor','Last name':'Example','Phone *':'2025550102','Email':'taylor@example.invalid'}))await page.getByLabel(label,{exact:true}).fill(value);
   await page.getByRole('button',{name:'Enroll Promoter',exact:true}).click();await page.getByText('Error: HTTP 503',{exact:true}).waitFor();assert.equal(await page.getByLabel('First name *',{exact:true}).inputValue(),'Taylor');await capture('enroll-error');enrollFailure=false;
   await page.getByRole('button',{name:'Enroll Promoter',exact:true}).click();await page.getByText(`Enrolled! Link: ${promoter.clicki_referral_link}`,{exact:true}).waitFor();assert.deepEqual(report.requests.filter(r=>r.path.endsWith('/enroll')).at(-1).body,{customerPhone:'2025550102',customerEmail:'taylor@example.invalid',firstName:'Taylor',lastName:'Example'});
   await context.close();
  }
  assert.deepEqual(report.unmatched,[]);assert.deepEqual(report.errors,[]);report.passed=true;
 }finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();await server.close();}
 console.log('Referral desktop/mobile actions and payload checks passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
