import test from "node:test";
import assert from "node:assert/strict";
import {validatePlayByPlay,selectedPlays,playSituation,quarterLabel} from "../docs/play-by-play-data.mjs";
import {playFixture,gameId} from "./helpers/play-by-play.mjs";

test("play IDs never reorder events, null/zero survive, and scoring/period filters compose",()=>{
  const data=validatePlayByPlay(playFixture(),gameId);
  assert.deepEqual(selectedPlays(data).map(p=>p.play_id),[101,90,80,110]);
  assert.equal(data.plays[0].yards_gained,null);assert.equal(data.plays[1].yards_gained,0);
  assert.equal(selectedPlays(data,{view:"scoring",quarter:"2"}).length,1);
  assert.equal(selectedPlays(data,{view:"scoring",quarter:"1"}).length,0);
  assert.equal(playSituation(data.plays[2]),"2nd & 3 · PHI 3");
  assert.equal(quarterLabel(5),"OT");
});
test("valid overtime can end before its clock reaches zero",()=>{
  const data=playFixture();data.plays.at(-1).quarter=5;data.plays.at(-1).clock="03:36";
  assert.equal(validatePlayByPlay(data,gameId),data);
});
test("invalid identity, source order, incomplete endings and invalid values are rejected",()=>{
  const changes=[d=>d.game_id="2025_02_DAL_PHI",d=>d.game.home="BUF",d=>d.season_type="POST",d=>d.plays.pop(),
    d=>d.plays[1].play_id=101,d=>d.plays[1].order=1,d=>d.plays[2].scoring=false,d=>d.game.away_score=7,
    d=>d.plays[1].clock="16:00",d=>d.plays[2].down=2.5,d=>d.plays[2].yards_gained=NaN,
    d=>d.plays[2].players[0].player_id="bad",d=>d.coverage.events=1,d=>d.drives=[],d=>d.plays[0].description=""];
  for(const change of changes){const data=playFixture();change(data);assert.throws(()=>validatePlayByPlay(data,gameId));}
});
