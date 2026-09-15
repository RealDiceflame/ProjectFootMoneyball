import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync,readdirSync} from "node:fs";
import * as homeData from "../docs/home-data.mjs";
import * as gameData from "../docs/game-data.mjs";
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
  const context=vm.createContext({...homeData,...gameData,TEAM_NAMES,scoreDisplay,gameConditions,document:doc,location:{search:query},
    URLSearchParams,Date,AbortSignal,setTimeout,clearTimeout,teamMark:()=>new Node("img"),
    setInterval(fn){intervals.push(fn);},...helpers,
    async fetch(url){calls.push(url);const next=responses.shift();if(next instanceof Error)throw next;return {ok:next!==null,status:next===null?404:200,json:async()=>next};}});
  const source=readFileSync(new URL(`../docs/${script}`,import.meta.url),"utf8").replace(/^import[^\n]*\r?\n/gm,"").replace(/^loadXFeed\(\);$/gm,"");
  await new vm.Script(source).runInContext(context);
  await new Promise(resolve=>setImmediate(resolve));
  return {nodes,doc,calls,refresh:()=>intervals[0]()};
}
const news=(time="2026-09-15T12:00:00Z",items=[])=>({generated_at:time,reports:{},league_news:{status:"ok",updated_at:time,attempted_at:time,items}});

test("homepage retains reports through failure, recovers, and pauses hidden polling",async()=>{
  const responses=[news(),new Error("offline"),news("2026-09-15T13:00:00Z")];
  const view=await page("home.js","",responses);
  await view.refresh();assert.match(view.nodes.get("injury-freshness").textContent,/Refresh unavailable/);
  view.doc.hidden=true;await view.refresh();assert.equal(view.calls.length,2);
  view.doc.hidden=false;await view.refresh();
  assert.doesNotMatch(view.nodes.get("injury-freshness").textContent,/Refresh unavailable/);
  assert.equal(view.nodes.get("injury-search").disabled,false);
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
