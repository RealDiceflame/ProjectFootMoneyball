import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,existsSync} from "node:fs";
import {statsSummary,defaultStatsWeek,selectedGames,coverageText,periodOverview,periodSpotlights,statsFreshness,metricUnit} from "../docs/stats-data.mjs";
const source=JSON.parse(readFileSync(new URL("../docs/data/game_stats/2026/summary.json",import.meta.url),"utf8"));

function fixture() {
  const game=(week,away,home,available,score)=>({game_id:`2026_0${week}_${away}_${home}`,week,away,home,
    kickoff:`2026-09-${week===1?'10':'17'}T00:20:00Z`,stats_available:available,
    home_score:score,away_score:score});
  const games=[game(1,'NE','SEA',true,14),game(2,'BUF','MIA',true,21),
    game(2,'NYJ','BAL',false,17),game(2,'CHI','GB',false,null)];
  const row=(id,value,rank)=>({player_id:id,player:id,teams:['NE'],position:'QB',value,rank});
  const leaders={passing_yards:[row('one',300,1),row('two',300,1),row('three',250,3)]};
  const period=ids=>({game_count:ids.length,game_ids:ids,leaders:structuredClone(leaders)});
  return {schema_version:1,season:2026,season_type:'REG',checked_at:'2026-09-18T00:00:00Z',games,
    metrics:[{key:'passing_yards',label:'Passing yards',group:'Passing'}],
    periods:{all:period(games.slice(0,2).map(g=>g.game_id)),
      1:period([games[0].game_id]),2:period([games[1].game_id])}};
}

test('period overview separates archived, reported pending, and unplayed games',()=>{
  const summary=statsSummary(fixture(),2026),now=Date.parse('2026-09-18T12:00:00Z');
  const week=periodOverview(summary,'2',now),season=periodOverview(summary,'all',now);
  assert.equal(week.archived,1);
  assert.equal(week.pending,1);
  assert.equal(week.published,2);
  assert.deepEqual(week.weeks,[2]);
  assert.equal(season.archived,2);
  assert.equal(season.pending,1);
  assert.deepEqual(season.weeks,[1,2]);
  assert.equal(periodOverview(summary,'3',now).archived,0);
});

test('spotlights retain every saved joint leader and never invent absent categories',()=>{
  const summary=fixture();
  const cards=periodSpotlights(summary,'2');
  assert.equal(cards.length,1);
  assert.equal(cards[0].metric.key,'passing_yards');
  assert.deepEqual(cards[0].rows.map(row=>[row.player_id,row.value,row.rank]),[['one',300,1],['two',300,1]]);
  assert.deepEqual(periodSpotlights(summary,'3'),[]);
  summary.periods[2].leaders.passing_yards=[];
  assert.deepEqual(periodSpotlights(summary,'2'),[]);
});

test('archive validation rejects missing weekly coverage and conflicting game metadata',()=>{
  const missing=fixture();delete missing.periods[2];
  assert.throws(()=>statsSummary(missing,2026),/coverage/i);
  for(const change of [{week:3},{home:'DAL'},{away:'SF'}]) {
    const mismatch=fixture();Object.assign(mismatch.games[0],change);
    assert.throws(()=>statsSummary(mismatch,2026),/identity/i);
  }
});

test('archive freshness rejects future clocks and flags overdue checks',()=>{
  const now=Date.parse('2026-09-18T12:00:00Z');
  assert.deepEqual(statsFreshness(new Date(now).toISOString(),now),{valid:true,stale:false});
  assert.deepEqual(statsFreshness(new Date(now-8*3600000).toISOString(),now),{valid:true,stale:true});
  assert.deepEqual(statsFreshness(new Date(now+10*60000).toISOString(),now),{valid:false,stale:true});
  assert.deepEqual(statsFreshness('not a date',now),{valid:false,stale:true});
});

test('stat units distinguish distances, fractional sacks and fantasy points',()=>{
  assert.equal(metricUnit({key:'fg_long'}),'Yards');
  assert.equal(metricUnit({key:'receiving_yards'}),'Yards');
  assert.equal(metricUnit({key:'def_sacks'}),'Sacks');
  assert.equal(metricUnit({key:'fantasy_points_ppr'}),'Points');
});

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
