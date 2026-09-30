import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync,readdirSync} from "node:fs";
import * as homeData from "../docs/home-data.mjs";
import * as gameData from "../docs/game-data.mjs";
import * as statsData from "../docs/stats-data.mjs";
import {TEAM_NAMES,scoreDisplay,gameConditions} from "../docs/scores-data.mjs";

class Node {
  constructor(tag="div"){this.tagName=tag;this.children=[];this.events={};this.dataset={};this.value="";this.scrollTop=0;
    this.classList={add(){},remove(){},toggle(){}};}
  set textContent(value){this.text=String(value);this.children=[];}
  get textContent(){return (this.text||"")+this.children.map(child=>child.textContent).join(" ");}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.text="";this.children=children;}
  setAttribute(key,value){this[key]=value;}
  addEventListener(key,fn){this.events[key]=fn;}
  querySelectorAll(){return this.children.filter(child=>child.tagName==="details"&&child.open);}
}
async function page(script,query,responses,helpers={}){
  const nodes=new Map(),intervals=[],calls=[];
  const doc={hidden:false,events:{},getElementById(id){if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);},
    createElement:tag=>new Node(tag),addEventListener(key,fn){this.events[key]=fn;}};
  const context=vm.createContext({...homeData,...gameData,...statsData,TEAM_NAMES,scoreDisplay,gameConditions,document:doc,location:{search:query},
    URLSearchParams,Date,AbortSignal,setTimeout,clearTimeout,teamMark:()=>new Node("img"),
    setInterval(fn){intervals.push(fn);},...helpers,
    async fetch(url){calls.push(url);const next=responses.shift();if(next instanceof Error)throw next;return {ok:next!==null,status:next===null?404:200,json:async()=>next};}});
  const source=readFileSync(new URL(`../docs/${script}`,import.meta.url),"utf8").replace(/^import[^\n]*\r?\n/gm,"").replace(/^loadXFeed\(\);$/gm,"");
  await new vm.Script(source).runInContext(context);
  await new Promise(resolve=>setImmediate(resolve));
  return {nodes,doc,calls,refresh:()=>intervals[0]()};
}
const news=(time="2026-09-15T12:00:00Z",items=[])=>({generated_at:time,reports:{},league_news:{status:"ok",updated_at:time,attempted_at:time,items}});

test("homepage shows decoded quotes while HTML-looking headlines stay inert text", async()=>{
  const title="Player&#39;s &quot;big play&quot; &lt;img src=x onerror=alert(1)&gt;";
  const view=await page("home.js","",[news(undefined,[{title,url:"https://sports.yahoo.com/nfl/article/update.html"}])]);
  const content=view.nodes.get("league-news-list");
  const heading=descendants(content).find(node=>node.tagName==="h3");
  assert.equal(heading.textContent, 'Player\'s "big play" <img src=x onerror=alert(1)>');
  assert.equal(heading.children.length,0);
  assert.equal(descendants(content).filter(node=>["img","script"].includes(node.tagName)).length,0);
});

test("homepage retains reports through failure, recovers, and pauses hidden polling",async()=>{
  const responses=[news(),new Error("offline"),news("2026-09-15T13:00:00Z")];
  const view=await page("home.js","",responses);
  await view.refresh();assert.match(view.nodes.get("injury-freshness").textContent,/Couldn’t refresh · Showing saved data/);
  view.doc.hidden=true;await view.refresh();assert.equal(view.calls.length,2);
  view.doc.hidden=false;await view.refresh();
  assert.doesNotMatch(view.nodes.get("injury-freshness").textContent,/Couldn’t refresh|Showing saved data/);
  assert.equal(view.nodes.get("injury-search").disabled,false);
});

test("homepage repeated outages retain saved timestamps and never duplicate status warnings", async()=>{
  const bundle=news(undefined,[{title:"Saved source story",url:"https://www.espn.com/nfl/story/saved"}]);
  const view=await page("home.js","",[bundle,new Error("offline"),new Error("offline"),bundle]);
  const original=Object.fromEntries(["injury-freshness","league-news-status"].map(id=>[id,view.nodes.get(id).textContent]));
  const stories=view.nodes.get("league-news-list").children;
  for(let attempt=0;attempt<2;attempt++){
    await view.refresh();
    for(const [id,status] of Object.entries(original)) assert.equal(view.nodes.get(id).textContent,`${status} · Couldn’t refresh · Showing saved data`);
    assert.equal(view.nodes.get("league-news-list").children,stories,"A failed refresh preserves rendered source stories");
  }
  await view.refresh();
  for(const [id,status] of Object.entries(original)) assert.equal(view.nodes.get(id).textContent,status);
});

test("homepage distinguishes loaded empty reports from initial failure without inferring health", async()=>{
  const warning="No injury reports available. Missing reports do not mean players are healthy.";
  const empty=await page("home.js","",[news(),new Error("offline")]);
  assert.equal(empty.nodes.get("injury-count").textContent,"0 reports");
  assert.equal(empty.nodes.get("home-injury-list").textContent,warning);
  assert.equal(empty.nodes.get("injury-filter").disabled,false);
  assert.equal(empty.nodes.get("league-news-status").textContent,"News unavailable.");
  await empty.refresh();
  assert.equal(empty.nodes.get("league-news-status").textContent,"News unavailable.","An empty news feed does not claim saved stories during an outage");
  const failed=await page("home.js","",[new Error("offline")]);
  assert.equal(failed.nodes.get("injury-count").textContent,"Reports unavailable");
  assert.equal(failed.nodes.get("injury-freshness").textContent,"Injury reports temporarily unavailable");
  assert.equal(failed.nodes.get("home-injury-list").textContent,warning);
  assert.equal(failed.nodes.get("injury-filter").disabled,true);
  assert.equal(failed.nodes.get("league-news-status").textContent,"News unavailable.");
  assert.doesNotMatch(failed.nodes.get("injury-freshness").textContent,/Showing saved data/);
});

test("homepage invalid news timestamps avoid an Updated prefix and provider failures disclose saved stories", async()=>{
  const bundle=news(undefined,[{title:"Source story",url:"https://www.espn.com/nfl/story/saved"}]);
  bundle.league_news.updated_at="invalid";
  const unavailable={...bundle,league_news:{...bundle.league_news,status:"unavailable",attempted_at:"2026-09-15T13:00:00Z"}};
  const view=await page("home.js","",[bundle,unavailable]);
  assert.equal(view.nodes.get("league-news-status").textContent,"1 story · Update time unavailable · Update delayed");
  assert.doesNotMatch(view.nodes.get("league-news-status").textContent,/Updated (Snapshot|Update) time unavailable/);
  await view.refresh();
  assert.equal(view.nodes.get("league-news-status").textContent,"1 story · Update time unavailable · Update delayed · Couldn’t refresh · Showing saved data");
  assert.match(view.nodes.get("league-news-list").textContent,/Source story/);
});

test("homepage unchanged news refresh preserves rendered stories and reading position",async()=>{
  const bundle=news(undefined,[{title:"Saved lead story",url:"https://www.espn.com/nfl/story/saved-lead"}]);
  const view=await page("home.js","",[bundle,bundle]);
  const content=view.nodes.get("league-news-list"),rendered=content.children;
  content.scrollTop=84;
  await view.refresh();
  assert.equal(content.children,rendered,"Unchanged polling must not rebuild or detach news links");
  assert.equal(content.scrollTop,84,"Unchanged polling keeps the reader's position");
});

test("unchanged news snapshot removes stories once they age out",async()=>{
  let clock=Date.parse("2026-09-15T12:00:00Z");
  const bundle=news("2026-09-15T12:00:00Z",[{title:"Story",url:"https://www.espn.com/nfl/story/1",published_at:"2026-09-09T12:00:00Z"}]);
  const view=await page("home.js","",[bundle,bundle],{leagueHeadlineCards:bundle=>homeData.leagueHeadlineCards(bundle,clock)});
  assert.match(view.nodes.get("league-news-list").textContent,/Story/);
  clock+=2*86400000;await view.refresh();
  assert.doesNotMatch(view.nodes.get("league-news-list").textContent,/Story/);
});

const folder=new URL("../docs/data/game_stats/2026/",import.meta.url);
const file=readdirSync(folder).find(name=>name!=="index.json");
const gameBundle=JSON.parse(readFileSync(new URL(file,folder),"utf8"));
test("archived box score renders despite scoreboard outage",async()=>{
  const view=await page("game.js",`?game=${gameBundle.game.game_id}`,[new Error("scores offline"),gameBundle]);
  assert.match(view.nodes.get("game-stats").textContent,/Player box score/);
  assert.match(view.nodes.get("game-status").textContent,/Some data could not refresh/);
});
test("available score remains visible when box-score request fails",async()=>{
  const view=await page("game.js",`?game=${gameBundle.game.game_id}`,[{games:[gameBundle.game]},new Error("stats offline")]);
  assert.match(view.nodes.get("game-stats").textContent,/Box score temporarily unavailable/);
  assert.ok(view.nodes.get("game-summary").children.length===2);
});

const descendants=node=>node.children.flatMap(child=>[child,...descendants(child)]);

const statsBundle=JSON.parse(readFileSync(new URL("../docs/data/game_stats/2026/summary.json",import.meta.url),"utf8"));
const catalogue={seasons:[2026]};
test("stats page links every available game and leaders respond to week/category changes",async()=>{
  const games=await page("stats.js","",[catalogue,statsBundle]);
  const latestWeek=String(Math.max(...statsBundle.games.filter(game=>game.stats_available).map(game=>game.week)));
  const expected=statsData.selectedGames(statsBundle,latestWeek);
  assert.equal(games.nodes.get("stats-results").children.length,expected.length);
  assert.deepEqual(games.nodes.get("stats-results").children.map(node=>node.href).sort(),expected.map(game=>`game.html?game=${game.game_id}`).sort());
  const view=await page("stats.js","?view=leaders",[catalogue,statsBundle]);
  assert.equal(view.nodes.get("stats-week").value,"all");
  assert.equal(view.nodes.get("stats-category-label").hidden,false);
  assert.match(view.nodes.get("stats-results").textContent,/Passing yards/);
  view.nodes.get("stats-category").value="Defense";view.nodes.get("stats-category").events.change();
  assert.match(view.nodes.get("stats-results").textContent,/Sacks/);
  assert.doesNotMatch(view.nodes.get("stats-results").textContent,/Passing yards/);
  view.nodes.get("stats-week").value=latestWeek;view.nodes.get("stats-week").events.change();
  assert.match(view.nodes.get("stats-status").textContent,new RegExp(`${statsBundle.periods[latestWeek].game_count} game box score`));
  assert.match(view.nodes.get("stats-results").textContent,/Sacks/);
});

test("stats refresh recovers catalogue failure and retains loaded leaders after an outage",async()=>{
  let now=Date.parse("2026-09-15T18:00:00Z");
  class Clock extends Date {static now(){return now;}}
  const view=await page("stats.js","?view=leaders",[new Error("offline"),catalogue,statsBundle,new Error("offline")],{Date:Clock});
  assert.match(view.nodes.get("stats-status").textContent,/temporarily unavailable/);
  now+=300001;await view.refresh();
  assert.deepEqual(view.calls.slice(0,2),["data/game_stats/index.json","data/game_stats/index.json"]);
  assert.match(view.nodes.get("stats-results").textContent,/Passing yards/);
  now+=300001;await view.refresh();
  assert.match(view.nodes.get("stats-status").textContent,/last loaded stats/);
  assert.match(view.nodes.get("stats-results").textContent,/Passing yards/);
  view.doc.hidden=true;now+=300001;await view.refresh();assert.equal(view.calls.length,4);
});
test("player categories stay open and split every row into away/home panels",async()=>{
  const bundle=JSON.parse(readFileSync(new URL("2026_01_NE_SEA.json",folder),"utf8"));
  const {players}=gameData.unpackStats(bundle,bundle.game.game_id);
  const responses=[{games:[bundle.game]},bundle,{games:[bundle.game]},bundle];
  const view=await page("game.js",`?game=${bundle.game.game_id}`,responses);
  const content=view.nodes.get("game-stats");
  assert.equal(descendants(content).filter(node=>node.tagName==="details").length,0);
  for(const [name,keys] of gameData.statGroups(bundle.player_columns)){
    const active=gameData.activeStatRows(players,keys);if(!active.length)continue;
    const category=content.children.find(node=>node.dataset.group===name);
    assert.ok(category,`${name} remains visible`);
    const panels=category.children[1].children;
    assert.deepEqual(panels.map(node=>node.dataset.side),["away","home"]);
    for(const [index,side] of ["away","home"].entries()){
      const panel=panels[index],team=bundle.game[side];
      const expected=active.filter(row=>row.team===team);
      assert.equal(panel.dataset.team,team);
      assert.match(panel.children[0].textContent,new RegExp(TEAM_NAMES[team]));
      const body=descendants(panel).find(node=>node.tagName==="tbody");
      if(!expected.length){assert.match(panel.textContent,/No recorded player stats/);continue;}
      assert.equal(body.children.length,expected.length,`${name}: no ${side} rows lost`);
      expected.forEach((row,i)=>assert.deepEqual(body.children[i].children.map(cell=>cell.textContent),
        [row.player_id?(row.player_display_name||row.player_name||row.player_id):"Uncredited team events",
          row.position||"—",...keys.map(key=>gameData.statValue(row[key]))]));
    }
  }
  assert.match(content.textContent,/Uncredited team events/);
  const previousChildren=content.children;
  await view.refresh();
  assert.equal(content.children,previousChildren,"Unchanged refresh preserves tables and reading position");
});

test("same-name players are not combined and team stats remain fully expanded",async()=>{
  const bundle=structuredClone(gameBundle),nameIndex=bundle.player_columns.indexOf("player_display_name");
  for(const row of bundle.players)row[nameIndex]="Same Name";
  const view=await page("game.js",`?game=${bundle.game.game_id}`,[{games:[bundle.game]},bundle]);
  const content=view.nodes.get("game-stats"),all=content.children.find(node=>node.dataset.group==="teams");
  const body=descendants(all).find(node=>node.tagName==="tbody");
  assert.equal(body.children.length,bundle.team_columns.filter(key=>!gameData.ID_FIELDS.has(key)).length);
  const receiving=content.children.find(node=>node.dataset.group==="Receiving");
  for(const panel of receiving.children[1].children){
    const names=descendants(panel).filter(node=>node.tagName==="tbody")
      .flatMap(node=>node.children.map(row=>row.children[0].textContent));
    assert.ok(names.filter(name=>name==="Same Name").length>1);
  }
  const css=readFileSync(new URL("../docs/game.css",import.meta.url),"utf8");
  const wrapper=css.match(/\.game-table-wrap\s*\{([^}]+)\}/)[1];
  assert.doesNotMatch(wrapper,/max-height|height:/);
  assert.match(css,/@media\(max-width:900px\).*grid-template-columns: minmax\(0,1fr\)/);
});
