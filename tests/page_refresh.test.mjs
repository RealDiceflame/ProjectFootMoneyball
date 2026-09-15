import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync,readdirSync} from "node:fs";
import * as homeData from "../docs/home-data.mjs";
import * as gameData from "../docs/game-data.mjs";
import {TEAM_NAMES,scoreDisplay} from "../docs/scores-data.mjs";

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
  const context=vm.createContext({...homeData,...gameData,TEAM_NAMES,scoreDisplay,document:doc,location:{search:query},
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
