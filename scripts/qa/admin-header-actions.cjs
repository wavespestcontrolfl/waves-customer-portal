'use strict';
/* global document, innerWidth, getComputedStyle */
// Exercise the shared header with real primitives and synthetic actions only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewServer, launchBrowser, evidence, waitForFonts } = require('./browser');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.tmp/admin-header-actions');
const html = `<!doctype html><html class="admin-app"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/index.css"><link rel="stylesheet" href="/src/styles/brand-tokens.css"></head><body><main id="root" class="admin-shell-v2" style="padding:16px"></main><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const React=(await import('/node_modules/.vite/deps/react.js')).default;
const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
const {default:Header}=await import('/src/components/admin/AdminCommandHeader.jsx');
const {UiSurface}=await import('/src/components/ui/UiSurface.jsx');
const {CalendarPlus,Plus,Users}=await import('/node_modules/.vite/deps/lucide-react.js');
const rows=[
 ['Schedule','Add Appointment','legacy','framed'],
 ['Customers','Add Customer','comfortable','workspace'],
 ['Pipeline','New lead','comfortable','workspace','Create estimate'],
 ['Contracts','New template','comfortable','workspace'],
 ['Inventory','Add Product','comfortable','workspace'],
 ['Equipment','Add Equipment','comfortable','workspace'],
 ['Invoices','Create invoice','comfortable','workspace'],
 ['Newsletter','New Campaign','comfortable','workspace'],
 ['Payers','New payer','comfortable','workspace','AR aging'],
 ['Services','Add Service','comfortable','workspace'],
 ['Assessments','Add Assessment','comfortable','workspace'],
 ['Long workspace heading for mobile','Create a longer example record','comfortable','workspace','Supporting action'],
];
function App(){const [message,setMessage]=React.useState('');return React.createElement(React.Fragment,null,
 rows.map(([title,label,density,variant,secondary],index)=>React.createElement(UiSurface,{key:title,density,'data-case':title},React.createElement(Header,{title,variant,icon:Users,sticky:false,actions:[...(secondary?[{label:secondary,variant:'ghost',onClick:()=>setMessage(secondary)}]:[]),{label,icon:index===0?CalendarPlus:Plus,onClick:()=>setMessage(label)}],sections:[{key:'all',label:'All'},{key:'history',label:'History'}],activeKey:'all'}))),React.createElement('output',{'aria-label':'Action result'},message));}
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`;
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { ...evidence(root), passed: false, scenarios: [], errors: [] };
  const server = await previewServer(root);
  let browser;
  try {
    browser = await launchBrowser();
    for (const width of [320, 390, 430, 768, 820, 1024, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
      page.setDefaultTimeout(60000);
      page.on('pageerror', error => report.errors.push(error.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== server.baseUrl || url.pathname.startsWith('/api/')) return route.abort();
        if (url.pathname === '/qa-header-actions') return route.fulfill({ contentType: 'text/html', body: html });
        return route.continue();
      });
      await page.goto(`${server.baseUrl}/qa-header-actions`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Add Appointment', exact: true }).waitFor();
      await waitForFonts(page);
      const metrics = await page.locator('[data-case]').evaluateAll(cases => cases.map(el => {
        const heading = el.querySelector('h1').getBoundingClientRect();
        const group = el.querySelector('.ui-command-heading').getBoundingClientRect();
        const groupStyle = getComputedStyle(el.querySelector('.ui-command-heading'));
        const buttons = [...el.querySelectorAll('.ui-command-action')];
        const primary = buttons[0].getBoundingClientRect();
        return { title: el.dataset.case, headingWidth: heading.width, headingHeight: heading.height, headingTop: heading.top, headingBottom: heading.bottom, headingRight: heading.right, groupRight: group.right - parseFloat(groupStyle.paddingRight),
          primaryLeft: primary.left, primaryRight: primary.right, primaryTop: primary.top, primaryBottom: primary.bottom,
          secondaryTop: buttons[1]?.getBoundingClientRect().top,
          styles: buttons.map(button => { const style = getComputedStyle(button); return { height: button.getBoundingClientRect().height, font: style.fontSize, transform: style.textTransform, radius: style.borderRadius }; }) };
      }));
      for (const row of metrics) {
        assert.ok(row.headingWidth > 24 && row.headingHeight > 0, `${width}: ${row.title} title stays visible and is not sized as an icon`);
        assert.ok(Math.abs(row.groupRight - row.primaryRight) < 2, `${width}: ${row.title} primary must align right`);
        assert.ok(row.styles.every(style => style.height >= 44 && style.font === '14px' && style.transform === 'uppercase' && style.radius === '4px'), JSON.stringify(row));
        if (width < 1024) {
          assert.ok(Math.abs((row.primaryTop + row.primaryBottom) - (row.headingTop + row.headingBottom)) < 2, `${row.title} primary must align with the title center`);
          assert.ok(row.headingRight <= row.primaryLeft, `${row.title} title stays left`);
          if (row.secondaryTop) assert.ok(row.secondaryTop >= row.primaryBottom, `${row.title} secondary follows primary`);
        }
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}: no page overflow`);
      await page.getByRole('button', { name: 'Add Customer', exact: true }).click();
      assert.equal(await page.getByLabel('Action result').textContent(), 'Add Customer');
      await page.getByRole('button', { name: 'Create estimate', exact: true }).click();
      assert.equal(await page.getByLabel('Action result').textContent(), 'Create estimate');
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(output, `headers-${width}.png`), fullPage: true });
      await page.screenshot({ path: path.join(output, `viewport-${width}.png`) });
      report.scenarios.push({ width, headers: metrics.length });
      await page.close();
    }
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await browser?.close();
    await server.close();
  }
  console.log('Header action alignment, typography and interactions passed at seven widths.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
