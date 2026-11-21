import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {observeRefreshChecks,waitForRefreshCheck,completedRefreshChecks} from './helpers/refresh-clock.mjs';
const engines=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../docs/',import.meta.url));
let browser,server,base;
before(async()=>{
 server=createServer(async(req,res)=>{try{const path=resolve(root,`.${decodeURIComponent(new URL(req.url,'http://localhost').pathname)}`);if(!path.startsWith(resolve(root)+sep))return res.writeHead(403).end();res.setHeader('Content-Type',{'.html':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json'}[extname(path)]||'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404).end();}});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));base=`http://127.0.0.1:${server.address().port}`;
 const engine=process.env.BROWSER_ENGINE||'chromium',channel=process.env.BROWSER_CHANNEL||'msedge';browser=await engines[engine].launch({headless:true,...(engine==='chromium'&&channel!=='chromium'?{channel}:{})});
});
after(async()=>{await browser?.close();if(server)await new Promise(done=>server.close(done));});
async function open(path){const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());await page.goto(`${base}/${path}`);return{context,page,errors};}
async function ready(page){await page.locator('#draft-candidates tr').first().waitFor();}
async function layout(page,width){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Overflow at ${width}px`);}

test('simulation value chart uses its own history, supports all horizons, and links scoring to the calculator',async()=>{
 const{context,page,errors}=await open('values.html?model=simulation&ppr=Full+PPR&quarterbacks=2QB&tePremium=%2B0.5');try{
  await page.locator('#values-rows tr').first().waitFor();await page.waitForFunction(()=>!document.querySelector('#values-history-note').textContent.includes('Checking'));
  assert.match(await page.locator('#values-model-version').textContent(),/simulation-value-v1/,await page.locator('#values-error').textContent());assert.equal(await page.locator('#values-ppr').inputValue(),'Full PPR');
  assert.ok(await page.locator('#values-rows tr').count()>100);assert.equal(await page.locator('#values-forecast-panel').isVisible(),true);
  assert.ok(Number(await page.locator('#values-history-chart svg').getAttribute('data-points'))>=1);if(await page.locator('#values-forecast-chart svg').count())assert.ok(Number(await page.locator('#values-forecast-chart svg').getAttribute('data-points'))>0);else assert.match(await page.locator('#values-forecast-chart').textContent(),/No rated unstarted games/);
  const histories=[];page.on('request',request=>{if(request.url().includes('/data/player_values/'))histories.push(request.url());});
  for(const horizon of ['draft','dynasty','ros']){await page.locator(`[data-horizon="${horizon}"]`).click();assert.match(await page.locator('#values-history-context').innerText(),/Same-model/);}
  assert.equal(histories.length,0);const href=await page.locator('#values-draft-link').getAttribute('href');assert.match(href,/ppr=Full\+PPR/);assert.match(href,/quarterbacks=2QB/);
  for(const width of [1440,390,320])await layout(page,width);
  if(process.env.DRAFT_SCREENSHOTS){await mkdir(process.env.DRAFT_SCREENSHOTS,{recursive:true});await page.setViewportSize({width:1440,height:1000});await page.locator('#values-player-content').screenshot({path:resolve(process.env.DRAFT_SCREENSHOTS,'simulation-values.png')});}
  await page.locator('#values-model').selectOption('original');await page.waitForFunction(()=>document.querySelector('#values-model-version').textContent.includes('production-value-v1'));
  assert.equal(await page.locator('[data-horizon="draft"]').isDisabled(),true);assert.equal(await page.locator('#values-forecast-panel').isVisible(),false);assert.ok(histories.length>0);
  await page.locator('#values-model').selectOption('simulation');await page.waitForFunction(()=>document.querySelector('#values-model-version').textContent.includes('simulation-value-v1'));
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('draft roster, taken marks, rankings and reload stay in sync without changing league settings',async()=>{
 const{context,page,errors}=await open('draft.html');try{
  await ready(page);const settingsKey='project-foot-moneyball:settings:v1';await page.evaluate(key=>localStorage.setItem(key,JSON.stringify({teams:10,ppr:'Full PPR'})),settingsKey);
  const rankings=await context.newPage();rankings.setDefaultTimeout(20000);await rankings.goto(`${base}/rankings.html?model=simulation&horizon=draft`);await rankings.locator('[data-draft-key]').first().waitFor();
  const button=page.locator('#draft-candidates [data-pick]').first(),id=await button.getAttribute('data-pick');const name=(await button.getAttribute('aria-label')).replace(/^Draft /,'').replace(/ to my team$/,'');
  await button.click();assert.equal(await page.locator('#draft-roster article').count(),1);await rankings.getByRole('button',{name:`Undo drafted: ${name}`,exact:true}).waitFor();
  const settingsBefore=await page.evaluate(key=>localStorage.getItem(key),settingsKey);await page.reload();await ready(page);assert.equal(await page.locator('#draft-roster article').count(),1);
  await rankings.getByRole('button',{name:`Undo drafted: ${name}`,exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('#draft-roster article').length===0);
  await page.locator('#draft-player').selectOption(id);await page.locator('#draft-other').click();assert.equal(await page.locator('#draft-roster article').count(),0);await rankings.getByRole('button',{name:`Undo drafted: ${name}`,exact:true}).waitFor();
  await page.locator('#draft-mine').click();assert.equal(await page.locator('#draft-roster article').count(),1);await page.locator('#draft-reset').click();await page.getByRole('button',{name:'Keep my draft'}).click();assert.equal(await page.locator('#draft-roster article').count(),1);
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),settingsKey),settingsBefore);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('draft settings change snake turns and roster slots, with usable phone layouts',async()=>{
 const{context,page,errors}=await open('draft.html?ppr=Full+PPR&quarterbacks=2QB&tePremium=%2B0.5');try{
  await ready(page);assert.equal(await page.locator('#draft-ppr').inputValue(),'Full PPR');assert.equal(await page.locator('#draft-QB').inputValue(),'2');
  await page.locator('#draft-teams').fill('10');await page.locator('#draft-slot').fill('10');await page.locator('#draft-current').fill('10');await page.getByRole('button',{name:'Update calculation'}).click();assert.match(await page.locator('#draft-turn').innerText(),/pick 10 · then pick 11/);
  await page.locator('#draft-order').selectOption('linear');await page.getByRole('button',{name:'Update calculation'}).click();assert.match(await page.locator('#draft-turn').innerText(),/pick 10 · then pick 20/);
  await page.getByText('Starting lineup and bench',{exact:true}).click();await page.locator('#draft-SF').fill('1');await page.locator('#draft-DST').fill('1');await page.getByRole('button',{name:'Update calculation'}).click();
  assert.match(await page.locator('#draft-candidates a').first().getAttribute('href'),/ppr=Full\+PPR/);
  for(const width of [1440,768,390,320])await layout(page,width);
  if(process.env.DRAFT_SCREENSHOTS){await mkdir(process.env.DRAFT_SCREENSHOTS,{recursive:true});for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.screenshot({path:resolve(process.env.DRAFT_SCREENSHOTS,`draft-${width}.png`),fullPage:true});}}
  await page.reload();await ready(page);assert.equal(await page.locator('#draft-SF').inputValue(),'1');assert.equal(await page.locator('#draft-DST').inputValue(),'1');
  await page.evaluate(()=>{const key='outlierbaseline:draft-calculator:v1',saved=JSON.parse(localStorage.getItem(key));saved.season=2000;localStorage.setItem(key,JSON.stringify(saved));});await page.reload();await ready(page);assert.match(await page.locator('#draft-error').innerText(),/2000/);await page.locator('#draft-reset').click();await page.getByRole('button',{name:'Start new draft',exact:true}).click();assert.equal(await page.locator('#draft-error').isVisible(),false);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});

test('a failed projection refresh retains the draft and clears the warning on recovery',async()=>{
 const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(20000);try{
  await page.clock.install({time:new Date()});await observeRefreshChecks(page);let bad=false,revision=0;
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==base)return route.abort();if(url.pathname==='/data/update_status.json')return route.fulfill({json:{completed_at:new Date(Date.now()+revision*1000).toISOString()}});if(bad&&url.pathname==='/data/simulation_forecasts.json')return route.fulfill({status:503,body:'Unavailable'});return route.continue();});
  await page.goto(`${base}/draft.html`);await ready(page);await waitForRefreshCheck(page);await page.locator('#draft-candidates [data-pick]').first().click();await page.locator('h1').click();
  const tick=async()=>{const previous=await completedRefreshChecks(page);revision++;await page.clock.fastForward(60000);await waitForRefreshCheck(page,previous);};
  bad=true;await tick();assert.equal(await page.locator('#draft-error').isVisible(),true);assert.equal(await page.locator('#draft-roster article').count(),1);
  bad=false;await tick();assert.equal(await page.locator('#draft-error').isVisible(),false);assert.equal(await page.locator('#draft-roster article').count(),1);
 }finally{await context.close();}
});
