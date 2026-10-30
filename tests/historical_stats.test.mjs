import test from "node:test";
import assert from "node:assert/strict";
import {gameTeamName,validGameIdentity,unpackStats} from "../docs/game-data.mjs";
import {statsSummary,statsFreshness,selectedGames,coverageText} from "../docs/stats-data.mjs";
import {historicalStatsFixture} from "./helpers/historical-stats.mjs";

test("historical identities and row partitions preserve OAK, SD and STL without rewriting IDs",()=>{
  const {bundle,summary}=historicalStatsFixture();
  assert.equal(statsSummary(summary,2016),summary);
  assert.equal(validGameIdentity(bundle.game,"2016_01_OAK_SD"),true);
  const rows=unpackStats(bundle,bundle.game.game_id);
  assert.deepEqual(rows.teams.map(row=>row.team),["OAK","SD"]);
  assert.equal(rows.players[0].team,"OAK");
  assert.equal(rows.players[0].passing_tds,0);
  assert.equal(rows.players[0].passing_interceptions,null);
  assert.equal(rows.players[0].def_sacks,0.5);
  assert.equal(validGameIdentity({...bundle.game,game_id:"2016_01_OAK_STL",home:"STL"},"2016_01_OAK_STL"),true);
  assert.equal(validGameIdentity({...bundle.game,home:"LAC"},bundle.game.game_id),false);
  assert.equal(selectedGames(summary,"all").length,1);
});

test("historical franchise display labels do not rename old clubs as current cities",()=>{
  assert.equal(gameTeamName("OAK",2016),"Oakland Raiders");
  assert.equal(gameTeamName("SD",2016),"San Diego Chargers");
  assert.equal(gameTeamName("STL",2016),"St. Louis Rams");
  assert.equal(gameTeamName("WAS",2019),"Washington");
  assert.equal(gameTeamName("WAS",2020),"Washington Football Team");
  assert.equal(gameTeamName("WAS",2021),"Washington Football Team");
  assert.equal(gameTeamName("WAS",2022),"Commanders");
  assert.equal(gameTeamName("BUF",2016),"Bills");
  assert.equal(gameTeamName("BAD",2016),null);
});

test("completed archive age is not a live-feed outage, but future clocks remain invalid",()=>{
  const {summary}=historicalStatsFixture(),now=Date.parse("2026-10-30T12:00:00Z");
  assert.deepEqual(statsFreshness(summary.checked_at,now,{historical:true}),{valid:true,stale:false});
  assert.deepEqual(statsFreshness(summary.checked_at,now),{valid:true,stale:true});
  assert.deepEqual(statsFreshness("2099-01-01T00:00:00Z",now,{historical:true}),{valid:false,stale:true});
  assert.match(coverageText(summary,"all",now),/2016 historical regular-season archive/);
});
