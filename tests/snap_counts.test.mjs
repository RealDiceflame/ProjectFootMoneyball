import {test} from "node:test";
import assert from "node:assert/strict";
import {validateSnapCounts, snapRowsForTeam, snapValue} from "../docs/snap-data.mjs";
const gameId="2016_01_OAK_SD";
const row=(extra={})=>({pfr_player_id:"SameNa00",player_id:"00-0000001",player_name:"Same Name",position:"OL",team:"OAK",offense_snaps:65,offense_pct:1,defense_snaps:0,defense_pct:0,st_snaps:null,st_pct:null,...extra});
const bundle=(players=[row(),row({team:"SD",pfr_player_id:"Other00",player_id:"00-0000002"})])=>({schema_version:1,season:2016,game_id:gameId,updated_at:"2026-10-30T18:00:00Z",players});
test("snap counts retain same-name people, unlinked linemen, zero and unknown participation",()=>{
  const b=bundle([row(),row({pfr_player_id:"SameNa01",player_id:null,position:"DL",offense_snaps:0,offense_pct:0,defense_snaps:51,defense_pct:.85}),row({team:"SD",pfr_player_id:"Other00",player_id:"00-0000002"})]);
  assert.equal(validateSnapCounts(b,gameId),b);
  assert.equal(snapRowsForTeam(b,"OAK").length,2);
  assert.equal(snapValue(0,0),"0 · 0%");
  assert.equal(snapValue(null,null),"— · —");
  assert.equal(snapValue(51,.855),"51 · 85.5%");
});
test("snap sidecars reject wrong games, seasons, teams and duplicate source/canonical identities",()=>{
  for(const mutate of [
    b=>b.players=[],b=>b.players.splice(1),b=>b.game_id="2016_02_OAK_SD",b=>b.season=2025,b=>b.updated_at="invalid",
    b=>b.players[0].team="LV",b=>b.players[0].pfr_player_id="../bad",
    b=>b.players[0].player_id="other",b=>b.players.push({...b.players[0]}),
    b=>b.players.push({...b.players[0],pfr_player_id:"Other00"}),
  ]){const b=bundle();mutate(b);assert.throws(()=>validateSnapCounts(b,gameId));}
});
test("snap sidecars reject malformed statistics instead of showing misleading participation",()=>{
  for(const extra of [{offense_snaps:301},{offense_snaps:-1},{offense_snaps:1.5},{offense_snaps:"65"},{offense_pct:100},{offense_pct:NaN},{offense_pct:"1"},{offense_snaps:0,offense_pct:1},{offense_snaps:undefined},{st_pct:undefined}]){
    assert.throws(()=>validateSnapCounts(bundle([row(extra),row({team:"SD",pfr_player_id:"Other00",player_id:"00-0000002"})]),gameId));
  }
});
test("team partitioning and opportunity ordering never modify source rows or merge names",()=>{
  const players=[row({pfr_player_id:"B00",player_id:null,team:"SD"}),row({pfr_player_id:"A00",player_id:null,offense_snaps:1,offense_pct:.01}),row()];
  const copy=structuredClone(players);
  assert.deepEqual(snapRowsForTeam(bundle(players),"OAK").map(p=>p.pfr_player_id),["SameNa00","A00"]);
  assert.deepEqual(players,copy);
});

test("PFR identities retain source punctuation without accepting paths or markup",()=>{
  for(const id of ["WattT.00","Ya-SRo00","AndeC.00","Cox_Mi20","O'ShJa00","ReedD'00","Ta'aAl00"]){
    const b=bundle();b.players[0].pfr_player_id=id;
    assert.equal(validateSnapCounts(b,gameId).players[0].pfr_player_id,id);
  }
  for(const id of ["../bad","<script>","a/b","a\\b","a".repeat(33),""]){
    const b=bundle();b.players[0].pfr_player_id=id;
    assert.throws(()=>validateSnapCounts(b,gameId));
  }
});

test("source percentage issues preserve counts and explain null without trusting arbitrary issue payloads",()=>{
  const b=bundle();b.players[0].st_snaps=31;b.players[0].st_pct=null;
  const issue={field:"st_pct",source_value:"1.01",reason:"Source percentage exceeds 100%; unavailable"};
  b.players[0].data_issues=[issue];
  assert.equal(validateSnapCounts(b,gameId).players[0].st_snaps,31);
  assert.equal(snapValue(31,null),"31 · —");
  for(const payload of [null,{},[null],[{...issue,field:"player_id"}],[{...issue,source_value:1.01}],[{...issue,reason:""}]]){
    const invalid=structuredClone(b);invalid.players[0].data_issues=payload;
    assert.throws(()=>validateSnapCounts(invalid,gameId));
  }
  b.players[0].st_pct=1;
  assert.throws(()=>validateSnapCounts(b,gameId));
});
