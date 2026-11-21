import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {prepareSimulation, simulateGame, runMatchup, gameEnvironment} from '../docs/matchup-simulation.mjs';
import {buildSimulationBoard} from '../docs/simulation-rankings.mjs';
const read = name => JSON.parse(readFileSync(new URL(`../docs/data/${name}.json`, import.meta.url)));
const inputs = read('simulation_inputs'), ranking = read('ranking_inputs'), now = Date.parse(inputs.generated_at);
const prepared = prepareSimulation(inputs, ranking, {now}), game = inputs.games.find(g=>Date.parse(g.kickoff)>now);
test('one physical play produces consistent player, team and opposing defense totals', () => {
  let overtime = 0;
  for (let seed=0;seed<120;seed++) {
    const result=simulateGame(prepared,game,{seed}); overtime+=result.overtime;
    for (const [team,row] of Object.entries(result.teams)) {
      const people=result.players.filter(p=>p.team===team), total=k=>people.reduce((sum,p)=>sum+p[k],0);
      const opponent=result.teams[team===game.home?game.away:game.home];
      for (const key of ['passing_yards','passing_tds','passing_interceptions','rushing_yards','rushing_tds','receiving_yards','receiving_tds','receptions','completions','pass_attempts','carries','targets','sacks_taken','fumbles_lost_total','def_sacks','def_interceptions','fumble_recovery_opp','def_tds','extra_points','field_goals','passing_2pt_conversions','receiving_2pt_conversions']) assert.equal(total(key),row[key],`${seed} ${team} ${key}`);
      assert.equal(row.passing_yards,row.receiving_yards); assert.equal(row.completions,row.receptions);
      assert.equal(row.passing_interceptions,opponent.def_interceptions); assert.equal(row.fumbles_lost_total,opponent.fumble_recovery_opp);
      assert.equal(row.sacks_taken,opponent.def_sacks); assert.equal(row.points_allowed,opponent.points);
      assert.equal(row.points,6*(row.passing_tds+row.rushing_tds+row.def_tds+row.special_teams_tds)+3*row.field_goals+row.extra_points+2*(row.passing_2pt_conversions+row.rushing_2pt_conversions+row.def_safeties+row.def_2pt_made));
    }
  }
  assert.ok(overtime>0,'sample exercises overtime');
});
test('seed reproducibility and game ranges are deterministic',()=>{
  const a=runMatchup(prepared,game,{iterations:100,seed:'repeat'}), b=runMatchup(prepared,game,{iterations:100,seed:'repeat'});
  assert.deepEqual(a,b); assert.equal(a.home_win_probability+a.away_win_probability+a.tie_probability,1);
  assert.ok(a.players.filter(p=>!p.fantasy).length>20);
  for(const p of a.players.filter(p=>p.fantasy)) assert.ok(p.fantasy.low<=p.fantasy.median&&p.fantasy.median<=p.fantasy.high);
});
test('closed roofs ignore weather, stale forecasts are unknown, overrides are explicit',()=>{
  const indoor=gameEnvironment({...game,roof:'closed'},now,{wind:50,temperature:-10});
  assert.equal(indoor.wind,null); assert.ok(!indoor.keys.some(k=>k.startsWith('wind:')||k.startsWith('temperature:')));
  const stale=gameEnvironment({...game,roof:'outdoors',weather:{...game.weather,captured_at:'2020-01-01',checked_at:'2020-01-01'},weather_checked_at:'2020-01-01'},now);
  assert.equal(stale.wind,null); assert.equal(stale.source,'conditional');
  const custom=gameEnvironment(game,now,{roof:'outdoors',wind:25,temperature:30});
  assert.ok(custom.keys.includes('wind:high')); assert.ok(custom.keys.includes('temperature:cold'));
  const a=runMatchup(prepared,game,{iterations:100,environment:{roof:'closed',wind:0}});
  const b=runMatchup(prepared,game,{iterations:100,environment:{roof:'closed',wind:70}});
  assert.deepEqual(a.teams,b.teams);
});
test('scenario exclusions remove offensive and defensive player production',()=>{
  const baseline=runMatchup(prepared,game,{iterations:100}), qb=baseline.players.find(p=>p.pos==='QB'&&p.stats.pass_attempts>0), defender=baseline.players.find(p=>p.stats.def_sacks>0&&!p.player_id.startsWith('UNASSIGNED'));
  const changed=runMatchup(prepared,game,{iterations:100,excluded:[qb.player_id,defender.player_id]});
  assert.equal(changed.players.find(p=>p.player_id===qb.player_id).stats.pass_attempts,0);
  assert.equal(changed.players.find(p=>p.player_id===defender.player_id).stats.def_sacks,0);
  assert.ok(changed.players.find(p=>p.player_id===qb.player_id).out);
  const more=runMatchup(prepared,game,{iterations:100,passShift:{[game.home]:.3}});
  assert.ok(more.teams[game.home].stats.pass_calls>baseline.teams[game.home].stats.pass_calls);
});
test('future or stale evidence cannot be labeled a current simulation',()=>{
  assert.throws(()=>prepareSimulation(inputs,ranking,{now:now-86400000}),/future/);
  assert.throws(()=>prepareSimulation(inputs,ranking,{now:now+3*86400000}),/stale|older/);
});
test('saved rankings share scoring, exclude started games, keep unknown roles unrated',()=>{
  const data=read('simulation_forecasts'), at=Date.parse(data.generated_at), settings={ppr:'Full PPR',tePremium:'+0.5',defenses:'Include',kickers:'Include',teams:12,quarterbacks:'1QB'};
  for(const horizon of ['draft','weekly','ros']) {
    const board=buildSimulationBoard(data,[],settings,{horizon,now:at});
    assert.ok(board.rows.length>400); assert.equal(board.rows.filter(p=>p.pos==='DST').length,32);
    assert.ok(board.rows.some(p=>p.confidence==='No recent role evidence'&&p.projected_points===null));
  }
  const first=data.games[0], board=buildSimulationBoard(data,[],settings,{horizon:'weekly',week:first.week,now:Date.parse(first.kickoff)+1});
  assert.equal(board.rows.find(p=>p.player_id===`DST:${first.home}`).projected_points,null);
});
