import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, extname, sep} from 'node:path';
const engines=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright'), root=fileURLToPath(new URL('../docs/',import.meta.url));
let server,browser,base,now;
before(async()=>{
  now=Math.max(...await Promise.all(['simulation_inputs','simulation_forecasts'].map(async name=>Date.parse(JSON.parse(await readFile(resolve(root,`data/${name}.json`),'utf8')).generated_at))))+1000;
  server=createServer(async(request,response)=>{
    try {const path=resolve(root,`.${decodeURIComponent(new URL(request.url,'http://localhost').pathname)}`);
      if(!path.startsWith(resolve(root)+sep)){response.writeHead(403).end();return;}
      response.setHeader('Content-Type',{'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json'}[extname(path)]||'application/octet-stream');response.end(await readFile(path));
    }catch{response.writeHead(404).end();}
  });await new Promise(done=>server.listen(0,'127.0.0.1',done));base=`http://127.0.0.1:${server.address().port}`;
  const engine=process.env.BROWSER_ENGINE||'chromium',channel=process.env.BROWSER_CHANNEL||'msedge';
  browser=await engines[engine].launch({headless:true,...(engine==='chromium'&&channel!=='chromium'?{channel}:{})});
});
after(async()=>{await browser?.close();if(server)await new Promise(done=>server.close(done));});
test('matchup lab runs in a worker, explains conditions and coaches, and fits mobile',async()=>{
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(at=>{Date.now=()=>at;},now);
  await page.goto(`${base}/matchup.html`);
  await page.waitForFunction(()=>!document.querySelector('#sim-run').disabled,{},{timeout:45000});
  await page.selectOption('#sim-iterations','200');
  await page.locator('summary').filter({hasText:'Change the scenario'}).click();
  await page.selectOption('#sim-roof','closed');await page.fill('#sim-wind','40');
  await page.click('#sim-run');
  await page.waitForFunction(()=>!document.querySelector('#sim-results').hidden,{},{timeout:45000});
  assert.match(await page.locator('#sim-conditions').textContent(),/Outdoor weather has no effect/);
  assert.equal(await page.locator('#sim-scorecards .sim-card').count(),2);
  assert.ok(await page.locator('#sim-offense tr').count()>15);assert.ok(await page.locator('#sim-defense tr').count()>20);
  assert.match(await page.locator('#sim-coaches').textContent(),/Offensive coordinator/);
  assert.match(await page.locator('#sim-coaches').textContent(),/play caller: Unconfirmed/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await mkdir('artifacts/layout/simulation',{recursive:true});await page.screenshot({path:'artifacts/layout/simulation/mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);await context.close();
});
test('simulation rankings switch all horizons and scoring without losing draft marks',async()=>{
  const context=await browser.newContext(),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(at=>{Date.now=()=>at;},now);
  await page.goto(`${base}/rankings.html?model=simulation&horizon=weekly&defenses=Include`);
  await page.waitForFunction(()=>document.querySelectorAll('#table-body tr').length>400,{},{timeout:45000});
  assert.match(await page.locator('#board-summary').textContent(),/OB Play Simulation/);
  const button=page.locator('[data-draft-key]').first();const label=await button.getAttribute('aria-label');await button.click();
  for(const horizon of ['draft','ros','weekly']) {await page.selectOption('#ranking-horizon',horizon);assert.match(await page.locator('#board-summary').textContent(),/1 drafted/);}
  await page.selectOption('#ppr','Full PPR');assert.match(await page.locator('#ranking-model-note').textContent(),/shared game simulation/);
  await page.locator('[data-intel-key]').first().click();assert.match(await page.locator('#intel-body').textContent(),/Experimental|simulation/);
  assert.deepEqual(errors,[]);assert.ok(label);await context.close();
});
