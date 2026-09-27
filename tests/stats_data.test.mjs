import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,existsSync} from "node:fs";
import {statsSummary,defaultStatsWeek,selectedGames,coverageText} from "../docs/stats-data.mjs";
const source=JSON.parse(readFileSync(new URL("../docs/data/game_stats/2026/summary.json",import.meta.url),"utf8"));

test("saved stats cover published games, defaults and every linked box score",()=>{
  const data=statsSummary(source,2026);
  const available = data.games.filter(game=>game.stats_available);
  assert.equal(defaultStatsWeek(data),String(Math.max(1,...available.map(game=>game.week))));
  assert.equal(defaultStatsWeek(data,true),"all");
  for(const game of available)assert.ok(existsSync(new URL(`../docs/data/game_stats/2026/${game.game_id}.json`,import.meta.url)));
  assert.ok(coverageText(data,"all").includes(`${available.length} game box score`));
  const week = defaultStatsWeek(data);
  assert.ok(selectedGames(data,week).every(game=>String(game.week)===week));
});

test("a reported score without stats stays visible and is marked pending",()=>{
  const data=structuredClone(source), game={...data.games[0],stats_available:false};
  data.games=[game]; data.periods[String(game.week)]={game_count:0};
  game.home_score=21;game.away_score=14;
  const now=Date.parse(game.kickoff)+4*3600000;
  assert.ok(selectedGames(data,String(game.week),now).includes(game));
  assert.match(coverageText(data,String(game.week),now),/0 game box scores · 1 reported game awaiting stats/);
});

test("malformed seasons, identities and leaders cannot render a false snapshot",()=>{
  assert.throws(()=>statsSummary(source,2025));
  const invalid=structuredClone(source);invalid.games[0].game_id="../private";
  assert.throws(()=>statsSummary(invalid,2026));
  const bad=structuredClone(source);bad.periods.all.leaders.passing_yards[0].value=null;
  assert.throws(()=>statsSummary(bad,2026));
  const duplicate=structuredClone(source);duplicate.games.push(duplicate.games[0]);
  assert.throws(()=>statsSummary(duplicate,2026));
  const incomplete=structuredClone(source);incomplete.periods.all.game_ids[0]="2026_02_BUF_BAL";
  assert.throws(()=>statsSummary(incomplete,2026),/coverage/);
});
