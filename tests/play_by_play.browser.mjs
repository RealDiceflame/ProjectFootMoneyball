import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve,extname,sep} from "node:path";
import {playFixture,gameId} from "./helpers/play-by-play.mjs";
const engines=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||"playwright");
const root=fileURLToPath(new URL("../docs/",import.meta.url));
let browser,server,base,bundle;
before(async()=>{
  bundle=JSON.parse(await readFile(resolve(root,`data/game_stats/2025/${gameId}.json`),"utf8"));
  bundle.game.away_score=6;bundle.game.home_score=0;
  server=createServer(async(req,res)=>{
    try{const path=resolve(root,`.${decodeURIComponent(new URL(req.url,"http://localhost").pathname)}`);
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
async function open({width=1440,missing=false}={}) {
  const context=await browser.newContext({viewport:{width,height:1000}}),state={data:playFixture(),missing,fail:false};
  await context.route("**/*",route=>{
    const url=new URL(route.request().url());if(url.origin!==base)return route.abort();
    if(url.pathname.startsWith("/data/play_by_play/"))return state.fail?route.fulfill({status:500,body:"Failed"}):state.missing?route.fulfill({status:404,body:"Missing"}):route.fulfill({json:state.data});
    if(url.pathname.startsWith("/data/game_stats/"))return route.fulfill({json:bundle});
    if(url.pathname==="/data/scores.json"||url.pathname.startsWith("/data/snap_counts/"))return route.fulfill({status:404,body:"Missing"});
    return route.continue();
  });
  const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.clock.install({time:new Date("2026-10-30T23:30:00Z")});
  await page.goto(`${base}/game.html?game=${gameId}`);
  await page.locator("#game-stats table").first().waitFor();
  return {page,context,state,errors};
}
test("drive expansion, chronological events, scoring and period filters work without rendering source HTML",async()=>{
  const {page,context,errors}=await open();try{
    await page.locator(".pbp-drive summary").click();
    assert.deepEqual(await page.locator(".pbp-event").evaluateAll(nodes=>nodes.map(n=>n.dataset.playId)),["101","90","80","110"]);
    assert.match(await page.locator("#pbp-events").innerText(),/Clock unavailable/);
    assert.equal(await page.locator("#pbp-events img").count(),0);
    await page.getByLabel("View",{exact:true}).selectOption("scoring");
    assert.equal(await page.locator(".pbp-event").count(),1);
    assert.match(await page.locator(".pbp-event").innerText(),/DAL 6 – PHI 0/);
    await page.getByLabel("Period",{exact:true}).selectOption("1");assert.match(await page.locator("#pbp-events").innerText(),/No events match/);
    await page.getByLabel("Period",{exact:true}).selectOption("2");assert.equal(await page.locator(".pbp-event").count(),1);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
test("missing optional plays do not hide box scores and a later refresh fills the viewer",async()=>{
  const {page,context,state,errors}=await open({missing:true});try{
    await page.waitForFunction(()=>document.querySelector("#pbp-status").textContent.includes("not yet published"));
    const stats=await page.locator("#game-stats").innerHTML();
    state.missing=false;await page.clock.fastForward(60001);await page.locator(".pbp-drive").waitFor();
    assert.equal(await page.locator("#game-stats").innerHTML(),stats);assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
test("failed or incomplete refresh keeps the last good events and active filters",async()=>{
  const {page,context,state,errors}=await open();try{
    await page.locator(".pbp-drive summary").click();
    const good=structuredClone(state.data),before=await page.locator("#pbp-events").innerHTML();
    for(const kind of ["fail","missing","wrong_game","empty","removed_event"]){
      state.data=structuredClone(good);state.fail=kind==="fail";state.missing=kind==="missing";
      if(kind==="wrong_game")state.data.game_id="2025_02_DAL_PHI";
      if(kind==="empty")state.data.plays=[];
      if(kind==="removed_event"){state.data.plays.splice(1,1);state.data.coverage.events--;state.data.coverage.missing_clocks=0;}
      await page.clock.fastForward(60001);
      await page.waitForFunction(()=>document.querySelector("#pbp-status").textContent.includes("Refresh unavailable"));
      assert.equal(await page.locator("#pbp-events").innerHTML(),before);
    }
    state.data=good;state.fail=false;state.missing=false;await page.clock.fastForward(60001);
    await page.waitForFunction(()=>!document.querySelector("#pbp-status").textContent.includes("Refresh unavailable"));assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
test("phone viewer stays within viewport and keyboard can expand drives",async()=>{
  const {page,context,state,errors}=await open({width:390});try{
    const summary=page.locator(".pbp-drive summary");await summary.waitFor();await summary.focus();await page.keyboard.press("Enter");
    assert.equal(await page.locator(".pbp-drive").getAttribute("open"),"");
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    state.data.plays.at(-1).quarter=5;state.data.plays.at(-1).clock="03:36";await page.clock.fastForward(60001);
    await page.getByLabel("View",{exact:true}).selectOption("all");await page.getByLabel("Period",{exact:true}).selectOption("5");
    await page.waitForFunction(()=>document.querySelector("#pbp-events").textContent.includes("OT · 03:36"));assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
