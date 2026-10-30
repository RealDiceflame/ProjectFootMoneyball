import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve,extname,sep} from "node:path";
import {historicalStatsFixture} from "./helpers/historical-stats.mjs";
const engines=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||"playwright");
const root=fileURLToPath(new URL("../docs/",import.meta.url));
const fixture=historicalStatsFixture().bundle,gameId=fixture.game.game_id;
let browser,server,base;
before(async()=>{
  server=createServer(async(req,res)=>{
    try{
      const path=resolve(root,`.${decodeURIComponent(new URL(req.url,"http://localhost").pathname)}`);
      if(!path.startsWith(resolve(root)+sep))return res.writeHead(403).end();
      res.setHeader("Content-Type",{".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".json":"application/json"}[extname(path)]||"application/octet-stream");
      res.end(await readFile(path));
    }catch{res.writeHead(404).end();}
  });
  await new Promise(done=>server.listen(0,"127.0.0.1",done));base=`http://127.0.0.1:${server.address().port}`;
  const engine=process.env.BROWSER_ENGINE||"chromium",channel=process.env.BROWSER_CHANNEL||"msedge";
  browser=await engines[engine].launch({headless:true,...(engine==="chromium"&&channel!=="chromium"?{channel}:{})});
});
after(async()=>{await browser?.close();if(server)await new Promise(done=>server.close(done));});
const player=(extra={})=>({pfr_player_id:"SameNa00",player_id:"00-0000001",player_name:"Same Name",position:"OL",team:"OAK",offense_snaps:60,offense_pct:1,defense_snaps:0,defense_pct:0,st_snaps:null,st_pct:null,...extra});
async function open({missing=false,width=1440}={}){
  const context=await browser.newContext({viewport:{width,height:1000}});
  const state={missing,fail:false,requests:0,snaps:{schema_version:1,season:2016,game_id:gameId,updated_at:"2026-10-30T18:00:00Z",players:[player(),player({pfr_player_id:"SameNa01",player_id:null,position:"DL",offense_snaps:0,offense_pct:0,defense_snaps:50,defense_pct:.8}),player({pfr_player_id:"Other00",player_id:"00-0000002",team:"SD",player_name:"QA <img src=x onerror=alert(1)>",st_snaps:31,st_pct:null,data_issues:[{field:"st_pct",source_value:"1.01",reason:"Source percentage exceeds 100%; unavailable"}]})]}};
  await context.route("**/*",route=>{
    const url=new URL(route.request().url());
    if(url.origin!==base)return route.abort();
    if(url.pathname==="/data/scores.json")return route.fulfill({status:404,body:"Unavailable"});
    if(url.pathname===`/data/game_stats/2016/${gameId}.json`)return route.fulfill({json:fixture});
    if(url.pathname===`/data/snap_counts/2016/${gameId}.json`){state.requests++;return state.fail?route.fulfill({status:500,body:"Failed"}):state.missing?route.fulfill({status:404,body:"Not reported"}):route.fulfill({json:state.snaps});}
    return route.continue();
  });
  const page=await context.newPage(),errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.clock.install({time:new Date("2026-10-30T19:00:00Z")});
  await page.goto(`${base}/game.html?game=${gameId}`);
  await page.locator("#game-stats table").first().waitFor();
  return {context,page,state,errors};
}
test("participation includes snap-only players, same names and unlinked IDs with distinct missing/zero values",async()=>{
  const {context,page,errors}=await open();try{
    await page.locator("#game-snaps-tables table").first().waitFor();
    const away=page.locator('#game-snaps [data-side="away"]');
    assert.equal(await away.locator("tbody tr").count(),2);
    assert.match(await away.innerText(),/Same Name · ID unlinked/);
    assert.match(await away.innerText(),/0 · 0%/);assert.match(await away.innerText(),/— · —/);
    assert.match(await page.locator("#game-snaps-status").innerText(),/3 reported players · 2 of 2 teams · 1 NFL IDs unlinked/);
    assert.equal(await page.locator("#game-snaps-tables tbody img").count(),0);
    assert.match(await page.locator('#game-snaps [data-side="home"]').innerText(),/Source issue/);
    assert.match(await page.locator('#game-snaps [data-side="home"]').innerText(),/31 · —/);
    assert.match(await page.locator("#game-snaps-issues").innerText(),/inconsistent source percentage/);
    assert.match(await page.locator(".game-snap-note").filter({hasText:"unknown participation"}).innerText(),/unknown participation/);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
test("optional missing snaps leave box scores intact and refresh independently when available",async()=>{
  const {context,page,state,errors}=await open({missing:true});try{
    await page.waitForFunction(()=>document.querySelector("#game-snaps-status").textContent.includes("not yet available"));
    const before=await page.locator("#game-stats").innerHTML();
    state.missing=false;await page.clock.fastForward(60001);
    await page.locator("#game-snaps-tables table").first().waitFor();
    assert.equal(await page.locator("#game-stats").innerHTML(),before);
    state.snaps.players[0].offense_snaps=61;await page.clock.fastForward(60001);
    await page.waitForFunction(()=>document.querySelector("#game-snaps-tables").textContent.includes("61 · 100%"));
    assert.equal(await page.locator("#game-stats").innerHTML(),before);assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
test("failed, missing or mismatched refresh retains last-good snaps and clears warning after recovery",async()=>{
  const {context,page,state,errors}=await open();try{
    await page.locator("#game-snaps-tables table").first().waitFor();
    const before=await page.locator("#game-snaps-tables").innerHTML();
    const players=structuredClone(state.snaps.players);
    for(const kind of ["fail","missing","mismatch","empty","partial"]){
      state.snaps.players=kind==="empty"?[]:kind==="partial"?players.filter(row=>row.team==="OAK"):players;
      state.fail=kind==="fail";state.missing=kind==="missing";state.snaps.game_id=kind==="mismatch"?"2016_02_OAK_SD":gameId;
      await page.clock.fastForward(60001);
      await page.waitForFunction(()=>document.querySelector("#game-snaps-status").textContent.includes("Refresh unavailable"));
      assert.equal(await page.locator("#game-snaps-tables").innerHTML(),before);
    }
    state.fail=false;state.missing=false;state.snaps.game_id=gameId;state.snaps.players=players;await page.clock.fastForward(60001);
    await page.waitForFunction(()=>!document.querySelector("#game-snaps-status").textContent.includes("Refresh unavailable"));
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
test("participation tables fit a phone viewport and scroll within their accessible regions",async()=>{
  const {context,page,errors}=await open({width:390});try{
    await page.locator("#game-snaps-tables table").first().waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    const region=page.getByRole("region",{name:"Away Oakland Raiders snap counts and percentages"});
    assert.equal(await region.getAttribute("tabindex"),"0");
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
