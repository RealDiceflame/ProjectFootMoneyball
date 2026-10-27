// Browser contracts for saved stats, deep links, outages and keyboard continuity.
// Requests are confined to local fixtures; provider uptime is not part of these checks.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve, extname, sep} from "node:path";
import {defaultStatsWeek, selectedGames} from "../docs/stats-data.mjs";

const engines=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root=fileURLToPath(new URL("../docs/",import.meta.url));
let browser,server,base,source,now,week;
before(async()=>{
  source=JSON.parse(await readFile(resolve(root,"data/game_stats/2026/summary.json"),"utf8"));
  now=Date.parse(source.checked_at)+3600000; week=defaultStatsWeek(source);
  server=createServer(async(request,response)=>{
    try{
      const path=resolve(root,`.${new URL(request.url,"http://localhost").pathname}`);
      if(!path.startsWith(resolve(root)+sep)){response.writeHead(403).end();return;}
      response.setHeader("Content-Type",{".html":"text/html",".css":"text/css",".js":"text/javascript",".mjs":"text/javascript",".json":"application/json"}[extname(path)]||"application/octet-stream");
      response.end(await readFile(path));
    }catch{response.writeHead(404).end();}
  });
  await new Promise(done=>server.listen(0,"127.0.0.1",done));base=`http://127.0.0.1:${server.address().port}`;
  const engine=process.env.BROWSER_ENGINE||"chromium",channel=process.env.BROWSER_CHANNEL||"msedge";
  browser=await engines[engine].launch({headless:true,...(engine==="chromium"&&channel!=="chromium"?{channel}:{})});
});
after(async()=>{await browser?.close();if(server)await new Promise(done=>server.close(done));});

async function open(query="",{extraSeason=false,snapshot=source}={}){
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:"en-US"});
  const state={unavailable:false,requests:0},errors=[];
  await context.route("**/*",async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==base)return route.abort();
    if(url.pathname==="/data/game_stats/index.json")return route.fulfill({json:{schema_version:1,seasons:extraSeason?[2026,2025]:[2026],current_season:2026}});
    if(url.pathname.endsWith("/summary.json")){
      state.requests++;
      return state.unavailable||url.pathname.includes("/2025/")
        ?route.fulfill({status:503,body:"Unavailable"}):route.fulfill({json:snapshot});
    }
    return route.continue();
  });
  const page=await context.newPage();page.setDefaultTimeout(10000);
  page.on("pageerror",error=>errors.push(error.message));
  await page.clock.install({time:new Date(now)});
  await page.goto(`${base}/stats.html${query}`);
  await page.locator('#stats-results[aria-busy="false"]').waitFor();
  await page.locator(".lab-navigation").waitFor();
  return {context,page,state,errors};
}
const value=(page,id)=>page.locator(`#${id}`).inputValue();

test("stats overview and contextual leaders agree with the selected saved games",async()=>{
  const {context,page,errors}=await open();
  try{
    const games=selectedGames(source,week,now),count=source.periods[week].game_count;
    assert.equal(await value(page,"stats-week"),week);
    assert.equal(await page.locator("#stats-results .stats-game").count(),games.length);
    const overview=await page.locator("#stats-overview dd").allTextContents();
    assert.equal(overview[0],String(games.length));assert.equal(overview[1],String(count));
    assert.match(await page.locator("#stats-results-heading").innerText(),new RegExp(`Week ${week}`));
    const expected=source.periods[week].leaders.passing_yards[0];
    const spotlight=page.locator(".stats-spotlight").filter({has:page.getByText("Passing yards",{exact:true})});
    assert.match(await spotlight.innerText(),new RegExp(expected.player.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
    assert.equal(await spotlight.locator(".stats-spotlight-value").innerText(),`${expected.value.toLocaleString("en-US")} yards`);
    const href=await spotlight.getByRole("link").getAttribute("href"),link=new URL(href,base);
    assert.equal(link.searchParams.get("category"),"Passing");assert.equal(link.searchParams.get("week"),week);
    for(const game of games)assert.equal(await page.locator(`a[href="game.html?game=${game.game_id}"]`).count(),1);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test("leader categories and periods survive reloads and switching views",async()=>{
  const {context,page,errors}=await open("?view=leaders&season=2026&week=all&category=Fantasy");
  try{
    assert.equal(await value(page,"stats-category"),"Fantasy");
    assert.equal(await page.getByRole("table",{name:"Top 10 · Fantasy points · PPR",exact:true}).count(),1);
    const table=page.getByRole("table",{name:"Top 10 · Fantasy points · PPR",exact:true});
    assert.equal(await table.locator("thead th").last().innerText(),"Points");
    assert.equal(await table.locator("tbody tr").first().locator("td").last().innerText(),source.periods.all.leaders.fantasy_points_ppr[0].value.toLocaleString("en-US",{maximumFractionDigits:2}));
    await page.locator("#stats-week").selectOption(week);
    assert.equal(new URL(page.url()).searchParams.get("week"),week);
    await page.reload();await page.locator('#stats-results[aria-busy="false"]').waitFor();
    assert.equal(await value(page,"stats-week"),week);assert.equal(await value(page,"stats-category"),"Fantasy");
    await page.locator("#view-games").click();await page.locator(".stats-game").first().waitFor();
    await page.locator("#view-leaders").click();await page.locator("#stats-results table").first().waitFor();
    assert.equal(await value(page,"stats-week"),week);assert.equal(await value(page,"stats-category"),"Fantasy");
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test("weeks without archived results remove prior leaders instead of inventing zero production",async()=>{
  // Deliberately omit week18 coverage so this boundary still runs after the season ends.
  const snapshot=structuredClone(source),emptyWeek=18;
  for(const game of snapshot.games.filter(game=>game.week===emptyWeek)){
    game.stats_available=false;game.home_score=null;game.away_score=null;
  }
  snapshot.periods[emptyWeek]={game_count:0,game_ids:[],leaders:Object.fromEntries(snapshot.metrics.map(metric=>[metric.key,[]]))};
  snapshot.periods.all.game_ids=snapshot.games.filter(game=>game.stats_available).map(game=>game.game_id);
  snapshot.periods.all.game_count=snapshot.periods.all.game_ids.length;
  const {context,page,errors}=await open("",{snapshot});
  try{
    await page.locator("#stats-week").selectOption(String(emptyWeek));
    assert.equal(await page.locator("#stats-results .stats-game").count(),0);
    assert.equal(await page.locator("#stats-context .stats-spotlight").count(),0);
    assert.match(await page.locator("#stats-results").innerText(),/No published game results/);
    assert.equal((await page.locator("#stats-overview dd").allTextContents())[1],"0");
    assert.match(await page.locator("#stats-context").innerText(),/No passing, rushing or receiving leaders/);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test("refresh preserves focused results and retains outage warnings until data recovers",async()=>{
  const {context,page,state,errors}=await open();
  try{
    const game=page.locator(".stats-game").first();await game.focus();
    await game.evaluate(element=>element.dataset.continuity="keep");
    let response=page.waitForResponse(url=>url.url().endsWith("/summary.json"));
    await page.clock.fastForward(300001);await response;
    await page.waitForFunction(()=>document.querySelector("#stats-status").textContent!=="Loading stats…");
    assert.equal(await game.getAttribute("data-continuity"),"keep");
    assert.equal(await game.evaluate(element=>element===document.activeElement),true);
    state.unavailable=true;response=page.waitForResponse(url=>url.url().endsWith("/summary.json"));
    await page.clock.fastForward(300001);await response;
    await page.waitForFunction(()=>document.querySelector("#stats-status").textContent.includes("Refresh unavailable"));
    await page.locator("#stats-week").selectOption("all");
    assert.match(await page.locator("#stats-status").innerText(),/Refresh unavailable/);
    state.unavailable=false;response=page.waitForResponse(url=>url.url().endsWith("/summary.json"));
    await page.clock.fastForward(300001);await response;
    await page.waitForFunction(()=>!document.querySelector("#stats-status").textContent.includes("Refresh unavailable")&&!document.querySelector("#stats-status").textContent.includes("Loading"));
    assert.equal(await value(page,"stats-week"),"all");assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test("unavailable seasons clear previous context and source notes open from the sidebar",async()=>{
  const {context,page,errors}=await open("",{extraSeason:true});
  try{
    await page.locator('.stats-data-note a[href="#stats-source-notes"]').click();
    assert.equal(await page.locator("#stats-source-notes").evaluate(element=>element.open),true);
    assert.equal(await page.locator("#stats-source-notes summary").evaluate(element=>element===document.activeElement),true);
    await page.locator("#stats-season").selectOption("2025");
    await page.waitForFunction(()=>document.querySelector("#stats-status").textContent.includes("temporarily unavailable"));
    assert.equal(await page.locator("#stats-results .stats-game").count(),0);
    assert.equal(await page.locator("#stats-context .stats-spotlight").count(),0);
    assert.equal(await page.locator("#stats-overview dd").count(),0);
    assert.equal(await page.locator("#stats-week").isDisabled(),true);
    for(const id of ["view-games","view-leaders"]){
      const href=await page.locator(`#${id}`).getAttribute("href");
      assert.equal(new URL(href,base).searchParams.get("season"),"2025","View links cannot silently reopen the previous season after an outage");
    }
    await page.locator("#stats-season").selectOption("2026");await page.locator(".stats-game").first().waitFor();
    assert.equal(await page.locator("#stats-context .stats-spotlight").count(),3);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
