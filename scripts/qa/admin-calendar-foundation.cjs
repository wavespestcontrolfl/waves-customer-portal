'use strict';
/* global document, localStorage, innerWidth, getComputedStyle */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {previewServer,launchBrowser,evidence,waitForFonts}=require('./browser');
const root=path.resolve(__dirname,'../..');
const output=path.join(root,'.tmp/admin-calendar-foundation');
const html=`<!doctype html><html class="admin-app"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/index.css"><link rel="stylesheet" href="/src/styles/brand-tokens.css"></head><body><main id="root" class="admin-shell-v2" style="padding:16px"></main><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const React=(await import('/node_modules/.vite/deps/react.js')).default;
const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
const Page=(await import('/src/pages/admin/ContentCalendar.jsx')).default;
createRoot(document.getElementById('root')).render(React.createElement(Page));
</script></body></html>`;
async function main(){
 fs.mkdirSync(output,{recursive:true});
 const report={...evidence(root),passed:false,requests:[],errors:[],unmatched:[],scenarios:[]};
 const server=await previewServer(root,process.env.ADMIN_UI_PREVIEW_URL),browser=await launchBrowser();
 try{
  for(const width of [390,1440]){
   const context=await browser.newContext({viewport:{width,height:900},hasTouch:width===390,serviceWorkers:'block'});
   const page=await context.newPage();page.setDefaultTimeout(20000);
   page.on('pageerror',e=>report.errors.push(e.message));await page.routeWebSocket('**/*',s=>s.close());
   await page.addInitScript(()=>localStorage.setItem('waves_admin_token','synthetic-token'));
   let fixtureDate;
   await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==server.baseUrl)return route.abort();
    if(url.pathname==='/qa-calendar')return route.fulfill({contentType:'text/html',body:html});
    if(!url.pathname.startsWith('/api/'))return route.continue();
    report.requests.push({width,path:url.pathname,method:request.method(),body:request.postDataJSON()});
    let body;
    if(url.pathname==='/api/admin/content/calendar'){
     fixtureDate=url.searchParams.get('start').slice(0,7)+'-12';
     body={calendar:[{title:'Synthetic scheduled blog',type:'blog',scheduledDate:fixtureDate,status:'scheduled'},{title:'Synthetic social post',type:'social',scheduledDate:fixtureDate,status:'scheduled',platforms:['facebook']}]};
    }else if(url.pathname==='/api/admin/content/blog')body={posts:[{id:'draft-1',title:'Synthetic draft'}]};
    else if(request.method()==='POST'&&['/api/admin/content/schedule-blog/draft-1','/api/admin/content/schedule-social'].includes(url.pathname))body={};
    else{report.unmatched.push(url.pathname);return route.abort();}
    return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
   });
   await page.goto(`${server.baseUrl}/qa-calendar`);
   const day=page.getByRole('button',{name:/12, .*2 scheduled items/});await day.waitFor();await waitForFonts(page);
   async function capture(name){
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'overflow '+name);
    const controls=await page.locator('button,input:not([type=checkbox]),select').evaluateAll(nodes=>nodes.filter(n=>n.getBoundingClientRect().width>0).map(n=>({height:n.getBoundingClientRect().height,font:parseFloat(getComputedStyle(n).fontSize)})));
    assert.ok(controls.every(c=>c.height>=44&&c.font>=14),JSON.stringify(controls));
    await page.screenshot({path:path.join(output,`${name}-${width}.png`),fullPage:true});report.scenarios.push({name,width});
   }
   await capture('calendar');await day.click();await page.getByRole('button',{name:'Schedule Blog'}).waitFor();await capture('selected-day');
   await page.getByRole('button',{name:'Schedule Blog'}).click();await page.getByRole('option',{name:'Synthetic draft'}).waitFor({state:'attached'});
   await page.getByLabel('Draft',{exact:true}).selectOption('draft-1');await capture('blog-dialog');
   await page.getByRole('dialog').getByRole('button',{name:'Schedule',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
   assert.deepEqual(report.requests.filter(r=>r.path.endsWith('/schedule-blog/draft-1')).at(-1).body,{publishAt:`${fixtureDate}T09:00:00`,autoShareSocial:true});
   await page.getByRole('button',{name:'Schedule Social'}).click();await page.getByLabel('Title',{exact:true}).fill(' Synthetic social ');await capture('social-dialog');
   await page.getByRole('dialog').getByRole('button',{name:'Schedule',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
   assert.deepEqual(report.requests.filter(r=>r.path.endsWith('/schedule-social')).at(-1).body,{title:'Synthetic social',description:'',link:'',scheduledFor:`${fixtureDate}T09:00:00`,platforms:[]});
   await context.close();
  }
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.unmatched,[]);report.passed=true;
 }finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();await server.close();}
 console.log('Calendar desktop/mobile scheduling checks passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
