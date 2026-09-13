'use strict';
/* global localStorage, document, innerWidth, getComputedStyle */
// Actual route, synthetic duplicates only. Every merge/dismiss/revert is mocked.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {previewServer,launchBrowser,evidence,waitForFonts}=require('./browser');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'.tmp/admin-duplicates-foundation');
async function main(){
 fs.mkdirSync(output,{recursive:true});
 const report={...evidence(root),passed:false,scenarios:[],errors:[],unmatched:[]};
 const server=await previewServer(root),browser=await launchBrowser();
 try{
  for(const width of [390,820,1440]){
   let fail=false,empty=false,accept=false;
   const writes=[],prompts=[];
   const customer=(id,name)=>({id,first_name:'Fixture',last_name:name,address_line1:'100 Example Street',city:'Example City',zip:'00000',email:'fixture@example.invalid',created_at:new Date().toISOString(),pipeline_stage:'lead'});
   const winner=customer('qa-keep','Keep');
   const group={phone10:'9415550199',winner,candidates:[{customer:customer('qa-merge','Duplicate'),tier:'green',reasons:[]},{customer:{...customer('qa-property','Property'),address_line1:'200 Example Street'},tier:'yellow',reasons:['address_conflict']},{customer:customer('qa-distinct','Distinct'),tier:'red',reasons:['name_conflict']}]};
   const merge={journalId:'qa-journal',winnerId:winner.id,winnerName:'Fixture Keep',loserName:'Fixture Prior',createdAt:new Date().toISOString(),performedBy:'Fixture operator',tier:'green',revertible:true};
   const context=await browser.newContext({viewport:{width,height:1000},hasTouch:width<1440,timezoneId:'America/New_York',serviceWorkers:'block'}),page=await context.newPage();
   page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(60000);await page.routeWebSocket('**/*',s=>s.close());
   page.on('pageerror',e=>report.errors.push(e.message));
   page.on('dialog',async d=>{prompts.push(d.message());if(accept)await d.accept();else await d.dismiss();});
   await page.addInitScript(()=>{localStorage.setItem('waves_admin_token','synthetic-token');localStorage.setItem('waves_admin_user',JSON.stringify({id:'qa-admin',name:'Fixture operator',role:'admin'}));});
   await page.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url()),key=`${req.method()} ${u.pathname}`;let status=200,body;
    if(u.origin!==server.baseUrl||u.pathname.startsWith('/socket.io'))return route.abort();
    if(!u.pathname.startsWith('/api/'))return route.continue();
    if(key==='GET /api/admin/auth/me')body={id:'qa-admin',name:'Fixture operator',role:'admin'};
    else if(key==='GET /api/admin/feature-flags')body={flags:{}};
    else if(u.pathname.endsWith('/unread-count'))body={count:0,conversations:0};
    else if(key==='POST /api/admin/usage/track')body={ok:true};
    else if(key==='GET /api/admin/customer-duplicates'){status=fail?503:200;body=fail?{error:'Synthetic load failure'}:{groups:empty?[]:[group]};}
    else if(key==='GET /api/admin/customer-duplicates/merges')body={merges:[merge]};
    else if(req.method()==='POST'&&u.pathname.startsWith('/api/admin/customer-duplicates/')){writes.push({key,body:req.postDataJSON()});body=u.pathname.endsWith('/link-as-property')?{propertyLinked:false}:u.pathname.endsWith('/revert')?{skipped:['qa-history']}:{ok:true};}
    else{report.unmatched.push(key);status=404;body={error:'Unmatched synthetic fixture'};}
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   });
   await page.goto(`${server.baseUrl}/admin/customers/duplicates`,{waitUntil:'domcontentloaded'});
   const mergeButton=page.getByRole('button',{name:'Merge into kept',exact:true});await mergeButton.waitFor();await waitForFonts(page);
   assert.equal(await mergeButton.count(),1);assert.equal(await page.getByRole('button',{name:'Merge + keep address',exact:true}).count(),1);
   const controls=await page.locator('main .ui-surface button').evaluateAll(els=>els.filter(e=>e.getClientRects().length).map(e=>({name:e.textContent,height:e.getBoundingClientRect().height,font:parseFloat(getComputedStyle(e).fontSize)})));
   assert.ok(controls.every(c=>c.height>=43&&c.font>=14),JSON.stringify(controls));
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await page.screenshot({path:path.join(output,`groups-${width}.png`),fullPage:true});
   await mergeButton.click();assert.equal(writes.length,0);assert.match(prompts.at(-1),/Fixture Duplicate into Fixture Keep/);
   accept=true;await mergeButton.click();await page.getByRole('status').filter({hasText:'Merged'}).waitFor();
   assert.deepEqual(writes.at(-1),{key:'POST /api/admin/customer-duplicates/merge',body:{winnerId:'qa-keep',loserId:'qa-merge'}});
   await page.getByRole('button',{name:'Merge + keep address',exact:true}).click();
   await page.getByRole('alert').filter({hasText:'address could NOT be saved'}).waitFor();
   assert.deepEqual(writes.at(-1),{key:'POST /api/admin/customer-duplicates/link-as-property',body:{winnerId:'qa-keep',loserId:'qa-property'}});
   await page.getByRole('button',{name:'Not a duplicate',exact:true}).last().click();await page.getByRole('status').filter({hasText:'Dismissed'}).waitFor();
   assert.deepEqual(writes.at(-1),{key:'POST /api/admin/customer-duplicates/dismiss',body:{customerIdA:'qa-keep',customerIdB:'qa-distinct'}});
   await page.getByRole('button',{name:'Undo merge',exact:true}).click();await page.getByRole('alert').filter({hasText:'1 item(s) could not be restored'}).waitFor();
   assert.deepEqual(writes.at(-1),{key:'POST /api/admin/customer-duplicates/merges/qa-journal/revert',body:{}});
   fail=true;await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('alert').filter({hasText:'Synthetic load failure'}).waitFor();
   fail=false;empty=true;await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText('No duplicate customers pending review.').waitFor();
   await page.screenshot({path:path.join(output,`empty-${width}.png`),fullPage:true});
   report.scenarios.push({width,controls,confirmationCancellation:true,mergePayload:true,addressConflictGuard:true,partialResultFeedback:true,dismissAndRevert:true,readRecovery:true});
   await context.setOffline(true);await context.close();
  }
  assert.deepEqual(report.unmatched,[]);assert.deepEqual(report.errors,[]);report.passed=true;
 }finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));try{await browser.close();}finally{await server.close();}}
 console.log(JSON.stringify({passed:report.passed,scenarios:report.scenarios.length,output}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
