import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {validGameId,unpackStats,statGroups,statValue,activeStatRows,ID_FIELDS} from "../docs/game-data.mjs";
import {teamLogoUrl} from "../docs/team-logos.mjs";

test("game keys and team logos cannot become arbitrary URLs",()=>{
  assert.equal(validGameId("2026_01_BUF_BAL"),true);
  for(const value of ["../secret","2026/01/BUF/BAL",null,"<img>"])assert.equal(validGameId(value),false);
  assert.match(teamLogoUrl("LA"),/\/lar.png$/);assert.match(teamLogoUrl("WAS"),/\/wsh.png$/);
  assert.equal(teamLogoUrl("../../bad"),null);
});

test("zero, missing, fractional and negative box-score values stay distinct",()=>{
  assert.equal(statValue(null),"—");assert.equal(statValue(0),"0");assert.equal(statValue(-2),"-2");
  assert.equal(statValue(0.5),"0.5");assert.equal(statValue("27;44"),"27;44");
  assert.equal(activeStatRows([{def_sacks:0},{def_sacks:null},{def_sacks:0.5}],["def_sacks"]).length,1);
});

test("each archived game validates and every statistic has a viewable group",()=>{
  const directory=new URL("../docs/data/game_stats/2026/",import.meta.url);
  const files=readdirSync(directory).filter(name=>name!=="index.json");
  assert.ok(files.length>=16);
  for(const file of files){
    const bundle=JSON.parse(readFileSync(new URL(file,directory),"utf8"));
    const rows=unpackStats(bundle,file.slice(0,-5));
    assert.equal(rows.teams.length,2);assert.ok(rows.players.length>0);
    const fields=statGroups(bundle.player_columns).flatMap(([,keys])=>keys);
    assert.equal(fields.length,bundle.player_columns.filter(key=>!ID_FIELDS.has(key)).length);
    assert.equal(new Set(fields).size,fields.length);
    assert.throws(()=>unpackStats(bundle,"2026_01_BAD_KEY"),/Invalid/);
  }
});
