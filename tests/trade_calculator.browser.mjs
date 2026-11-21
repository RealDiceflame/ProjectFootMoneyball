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
async function ready(page){await page.waitForFunction(()=>document.querySelector('#trade-status').textContent.includes('Projections '));}
async function layout(page,width){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Overflow at ${width}px`);}

import {buildSimulationValues} from '../docs/simulation-values.mjs';
const sources=Object.fromEntries(await Promise.all(Object.entries({rankings:'rankings',inputs:'player_value_inputs',history:'player_history',news:'player_news',simulation:'simulation_forecasts'}).map(async([key,file])=>[key,JSON.parse(await readFile(resolve(root,`data/${file}.json`),'utf8'))])));
const board=buildSimulationValues(sources,{}, {now:Math.max(Date.now(),...Object.values(sources).map(s=>Date.parse(s.generated_at)))});
const rated=board.rows.filter(p=>p.pos==='RB'&&Number.isFinite(p.ros_points)&&p.draft_points>0),unknown=board.rows.find(p=>p.ros_points===null);
async function add(page,group,id){await page.locator(`#trade-${group}-picker`).selectOption(id);await page.locator(`#trade-${group}-add`).click();}
test('value-chart links carry player and scoring into a saved trade without altering draft state',async()=>{
 const{page,context,errors}=await open(`values.html?model=simulation&player=${rated[0].player_id}&horizon=dynasty&ppr=Full+PPR&quarterbacks=2QB&tePremium=%2B0.5`);try{
  await page.locator('#values-rows tr').first().waitFor();assert.equal(await page.locator('[data-horizon="dynasty"]').getAttribute('aria-pressed'),'true');
  await page.evaluate(()=>{localStorage.setItem('project-foot-moneyball:drafted:v1','["test|BUF"]');localStorage.setItem('project-foot-moneyball:settings:v1','{"teams":10}');});
  await page.locator('#values-trade-link').click();await ready(page);assert.equal(await page.locator('#trade-horizon').inputValue(),'dynasty');assert.equal(await page.locator('#trade-ppr').inputValue(),'Full PPR');assert.equal(await page.locator('#trade-receive-list li').count(),1);
  await add(page,'give',rated[1].player_id);assert.match(await page.locator('#trade-verdict').textContent(),/projected points above replacement/);
  await page.reload();await ready(page);assert.equal(await page.locator('#trade-give-list li').count(),1);assert.equal(await page.locator('#trade-receive-list li').count(),1);
  assert.equal(await page.evaluate(()=>localStorage.getItem('project-foot-moneyball:drafted:v1')),'["test|BUF"]');assert.equal(await page.evaluate(()=>localStorage.getItem('project-foot-moneyball:settings:v1')),'{"teams":10}');
  const href=await page.locator('#trade-receive-list a').getAttribute('href');assert.match(href,/horizon=dynasty/);assert.match(href,/ppr=Full\+PPR/);
  await page.locator('#trade-ppr').selectOption('Standard');await page.getByRole('button',{name:'Update comparison'}).click();await page.locator('#trade-clear').click();await page.reload();await ready(page);assert.equal(await page.locator('#trade-ppr').inputValue(),'Standard');assert.equal(await page.locator('#trade-receive-list li').count(),0);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
test('uneven trades require roster space and apply explicit drops before calculating lineup impact',async()=>{
 const{page,context,errors}=await open('trade.html');try{
  await ready(page);await add(page,'give',rated[0].player_id);await add(page,'receive',rated[1].player_id);await add(page,'receive',rated[2].player_id);
  assert.match(await page.locator('#trade-spots').textContent(),/1 extra player/);await page.getByText('Starting lineup and bench',{exact:true}).click();
  for(const pos of ['QB','WR','TE','FLEX','SF','bench'])await page.locator(`#trade-${pos}`).fill('0');await page.locator('#trade-RB').fill('1');await page.locator('#trade-rosterComplete').check();
  assert.match(await page.locator('#trade-roster-result').textContent(),/1 more drop/);await page.getByText('Players to drop or add after the trade',{exact:true}).click();await page.locator(`[data-drop="${rated[2].player_id}"]`).check();
  assert.match(await page.locator('#trade-roster-result').textContent(),/before → .* after/);assert.equal(await page.locator('#trade-give-list li').count(),1);assert.equal(await page.locator('#trade-receive-list li').count(),2);
  for(const width of [1440,768,390,320])await layout(page,width);
  if(process.env.TRADE_SCREENSHOTS){await mkdir(process.env.TRADE_SCREENSHOTS,{recursive:true});for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.screenshot({path:resolve(process.env.TRADE_SCREENSHOTS,`trade-${width}.png`),fullPage:true});}}
  await page.locator('#trade-clear').click();assert.equal(await page.locator('#trade-give-list li').count(),0);assert.equal(await page.locator('#trade-receive-list li').count(),0);assert.equal(await page.locator('#trade-drops input').count(),0);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
test('unknown players block the trade verdict and duplicate players cannot be selected twice',async()=>{
 const{page,context,errors}=await open('trade.html');try{
  await ready(page);await add(page,'give',rated[0].player_id);assert.equal(await page.locator(`#trade-receive-picker option[value="${rated[0].player_id}"]`).count(),0);
  await add(page,'receive',unknown.player_id);assert.match(await page.locator('#trade-verdict').textContent(),/no rated projection/);assert.match(await page.locator('#trade-receive-total').textContent(),/— projected points/);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
test('failed refresh retains the selected trade and a later success clears its warning',async()=>{
 const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(20000);try{
  await page.clock.install({time:new Date()});await observeRefreshChecks(page);let bad=false,revision=0;
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==base)return route.abort();if(url.pathname==='/data/update_status.json')return route.fulfill({json:{completed_at:new Date(Date.now()+revision*1000).toISOString()}});if(bad&&url.pathname==='/data/simulation_forecasts.json')return route.fulfill({status:503,body:'Unavailable'});return route.continue();});
  await page.goto(`${base}/trade.html`);await ready(page);await waitForRefreshCheck(page);await add(page,'give',rated[0].player_id);await add(page,'receive',rated[1].player_id);await page.locator('h1').click();const verdict=await page.locator('#trade-verdict').textContent();
  const tick=async()=>{const previous=await completedRefreshChecks(page);revision++;await page.clock.fastForward(60000);await waitForRefreshCheck(page,previous);};
  bad=true;await tick();assert.equal(await page.locator('#trade-error').isVisible(),true);assert.equal(await page.locator('#trade-verdict').textContent(),verdict);
  bad=false;await tick();assert.equal(await page.locator('#trade-error').isVisible(),false);assert.equal(await page.locator('#trade-give-list li').count(),1);assert.equal(await page.locator('#trade-receive-list li').count(),1);
 }finally{await context.close();}
});
