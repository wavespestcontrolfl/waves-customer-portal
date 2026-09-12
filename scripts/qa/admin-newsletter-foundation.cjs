'use strict';
/* global document, localStorage, innerWidth, getComputedStyle, window */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, evidence, waitForFonts } = require('./browser');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/admin-newsletter-foundation');
const html = `<!doctype html><html class="admin-app"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/index.css"><link rel="stylesheet" href="/src/styles/brand-tokens.css"></head><body><main id="root" class="admin-shell-v2" style="padding:16px"></main><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
const React = (await import('/node_modules/.vite/deps/react.js')).default;
const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
const Page = (await import('/src/pages/admin/NewsletterPage.jsx')).default;
const source = await (await fetch('/src/pages/admin/NewsletterPage.jsx')).text();
const routerPath = source.match(/from \"([^\"]*react-router-dom[^\"]*)\"/)[1];
const { BrowserRouter } = await import(routerPath);
createRoot(document.getElementById('root')).render(React.createElement(BrowserRouter, null, React.createElement(Page)));
</script></body></html>`;
async function main(){
 fs.mkdirSync(output,{recursive:true});const report={...evidence(root),passed:false,requests:[],unmatched:[],errors:[]};const server=await previewServer(root,process.env.ADMIN_UI_PREVIEW_URL),browser=await launchBrowser();
 try{for(const width of [1440,390,820]){
  // Playwright's service-worker blocking injection throws inside the sandboxed email iframe.
  // This fixture has no worker registration; all requests remain intercepted.
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'allow'}),page=await context.newPage();page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(60000);page.on('pageerror',e=>report.errors.push(e.message));await page.routeWebSocket('**/*',socket=>socket.close());await page.addInitScript(()=>{if(window !== window.top)return;localStorage.setItem('waves_admin_token','synthetic-token');localStorage.setItem('waves_admin_user',JSON.stringify({role:'admin',email:'operator@example.invalid'}));});
  const plan={id:'plan-1',weekOf:'2035-01-01',topic:'Synthetic topic',homeownerMinuteTopic:'Synthetic tip',status:'planned',eventIds:[]};
  const event={id:'event-1',title:'Synthetic community event',startAt:'2035-01-02T16:00:00Z',city:'Fixture town',freshnessStatus:'fresh',adminStatus:'pending',compositeScore:90,sourceUrl:'https://example.invalid/event'};
  await page.route('**/*',async route=>{const request=route.request(),url=new URL(request.url()),p=url.pathname;
   if(url.origin!==server.baseUrl)return route.abort();if(p==='/qa-newsletter')return route.fulfill({contentType:'text/html',body:html});if(!p.startsWith('/api/'))return route.continue();
   report.requests.push({width,path:p,method:request.method(),body:request.postDataJSON()});let body;
   if(p==='/api/admin/usage/track')body={};
   else if(p==='/api/admin/auth/me')body={email:'operator@example.invalid'};
   else if(p==='/api/admin/newsletter/sends')body=request.method()==='POST'?{send:{id:'draft-1'}}:{sends:[],counts:{sent:0},aggregate:{}};
   else if(p==='/api/admin/newsletter/subscribers/import'&&request.method()==='POST')body={inserted:1,skipped:0};
   else if(p==='/api/admin/newsletter/subscribers/subscriber-1'&&request.method()==='DELETE')body={};
   else if(p==='/api/admin/newsletter/subscribers')body={subscribers:[{id:'subscriber-1',email:'avery@example.invalid',first_name:'Avery',last_name:'Example',status:'active',source:'manual',subscribed_at:'2035-01-01T12:00:00Z',tags:[]}],counts:{active:3,total:3}};
   else if(p==='/api/admin/newsletter/tags')body={tags:[]};
   else if(p==='/api/admin/newsletter/quizzes')body={quizzes:[]};
   else if(p==='/api/admin/newsletter/segment-preview')body={count:3};
   else if(p==='/api/admin/newsletter/sends/latest-autopilot')body={send:null};
   else if(p==='/api/admin/newsletter/sends/draft-1')body={};
   else if(p==='/api/admin/newsletter/sends/draft-1/validate')body={errors:[],warnings:[]};
   else if(p==='/api/admin/newsletter/calendar')body={calendar:[plan],currentWeek:'2035-01-01'};
   else if(p==='/api/admin/newsletter/calendar/plan-1'){Object.assign(plan,request.postDataJSON());body={};}
   else if(p==='/api/admin/newsletter/events'||p==='/api/admin/newsletter/events/inbox')body={events:[event],counts:{pending:1}};
   else if(p==='/api/admin/newsletter/events/sources')body={sources:[]};
   else if(p==='/api/admin/newsletter/events/event-1'){Object.assign(event,request.postDataJSON());body={};}
   if(body===undefined){report.unmatched.push(request.method()+' '+p);return route.abort();}return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  async function open(tab){await page.goto(`${server.baseUrl}/qa-newsletter?tab=${tab}&keep=yes`,{waitUntil:"domcontentloaded"});await page.getByRole('heading',{name:'Newsletter',exact:true}).waitFor();await waitForFonts(page);}
  async function capture(name){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'overflow '+name);await page.screenshot({path:path.join(output,`${name}-${width}.png`),fullPage:true,animations:"disabled"});}
  await open('dashboard');await page.getByText('Synthetic community event',{exact:true}).first().waitFor();await capture('dashboard');
  await open('calendar');const topic=page.getByPlaceholder('Add topic...');await topic.fill('Edited topic');await topic.blur();await page.getByText('Calendar saved.',{exact:true}).waitFor();assert.deepEqual(report.requests.filter(r=>r.path.endsWith('/calendar/plan-1')).at(-1).body,{topic:'Edited topic',homeownerMinuteTopic:'Synthetic tip'});await capture('calendar');
  await open('compose');await page.getByPlaceholder('e.g. Florida spring pest alert — what to watch for').fill('Synthetic subject');await page.getByPlaceholder('<h1>Subject line</h1><p>Your newsletter content here. The unsubscribe footer is appended automatically.</p>').fill('<p>Synthetic body</p>');for(const name of ['All active','Any']) {
   const button=page.getByRole('button',{name,exact:true});assert.equal(await button.getAttribute('aria-pressed'),'true');
   assert.equal(await button.evaluate(n=>getComputedStyle(n).color),'rgb(255, 255, 255)');
  }await capture('compose');
  await page.getByRole('button',{name:'Send To Audience',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.waitFor();assert.ok(await dialog.getByRole('button',{name:'Send to all'}).isDisabled());await dialog.getByPlaceholder('SEND').fill('SEND');assert.ok(await dialog.getByRole('button',{name:'Send to all'}).isEnabled());await capture('confirmation');await dialog.getByRole('button',{name:'Cancel',exact:true}).click();assert.ok(!report.requests.some(r=>r.path.endsWith('/send')));
  await open('history');await page.getByText(/No campaigns|No sends|No newsletters/i).first().waitFor();await capture('history');
  await open('subscribers');await page.getByText('avery@example.invalid',{exact:true}).waitFor();await capture('subscribers');
  await page.getByRole('button',{name:'Add Subscriber',exact:true}).click();const addDialog=page.getByRole('dialog');await addDialog.getByRole('heading',{name:'Add subscriber',exact:true}).waitFor();await addDialog.getByLabel('Email address').fill('fixture@example.invalid');await capture('add-subscriber-dialog');await addDialog.getByRole('button',{name:'Cancel',exact:true}).click();assert.ok(!report.requests.some(r=>r.path.endsWith('/subscribers')&&r.method==='POST'));
  const fileInput=page.locator('input[type="file"][aria-label="Existing opt-in consent"]');const importWritesBefore=report.requests.filter(r=>r.path.endsWith('/subscribers/import')&&r.method==='POST').length;const waitForImportDialog=async()=>{const heading=page.getByRole('dialog').getByRole('heading',{name:'Import subscribers?',exact:true}),error=page.getByText(/^Import failed:/);await Promise.race([heading.waitFor(),error.waitFor().then(async()=>{throw new Error(await error.textContent());})]);};await fileInput.setInputFiles({name:'subscribers.csv',mimeType:'text/csv',buffer:Buffer.from('email,first_name,last_name\nimport@example.invalid,Import,Reader')});let importDialog=page.getByRole('dialog');await waitForImportDialog();await importDialog.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(report.requests.filter(r=>r.path.endsWith('/subscribers/import')&&r.method==='POST').length,importWritesBefore);
  await fileInput.setInputFiles({name:'subscribers.csv',mimeType:'text/csv',buffer:Buffer.from('email,first_name,last_name\nimport@example.invalid,Import,Reader')});importDialog=page.getByRole('dialog');await waitForImportDialog();const importRequest=page.waitForRequest(r=>new URL(r.url()).pathname.endsWith('/subscribers/import')&&r.method()==='POST');await page.keyboard.press('Enter');await importRequest;
  const deletesBefore=report.requests.filter(r=>r.method==='DELETE').length;await page.getByRole('button',{name:'Unsubscribe',exact:true}).first().click();let unsubscribeDialog=page.getByRole('dialog');await unsubscribeDialog.getByRole('heading',{name:'Unsubscribe subscriber?',exact:true}).waitFor();await capture('unsubscribe-dialog');await unsubscribeDialog.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(report.requests.filter(r=>r.method==='DELETE').length,deletesBefore);
  await page.getByRole('button',{name:'Unsubscribe',exact:true}).first().click();unsubscribeDialog=page.getByRole('dialog');await unsubscribeDialog.getByRole('heading',{name:'Unsubscribe subscriber?',exact:true}).waitFor();const deleteRequest=page.waitForRequest(r=>new URL(r.url()).pathname.endsWith('/subscribers/subscriber-1')&&r.method()==='DELETE');await page.keyboard.press('Enter');await deleteRequest;

  await open('events');await page.getByText('Synthetic community event',{exact:true}).waitFor();await page.getByRole('button',{name:'Approve',exact:true}).click();await page.getByRole('cell',{name:'approved',exact:true}).waitFor();assert.deepEqual(report.requests.filter(r=>r.path.endsWith('/events/event-1')).at(-1).body,{adminStatus:'approved'});await capture('events');await context.close();
 }assert.deepEqual(report.errors,[]);assert.deepEqual(report.unmatched,[]);report.passed=true;}finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();await server.close();}
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.unmatched,[]);console.log('Newsletter desktop/mobile fixture checks passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
