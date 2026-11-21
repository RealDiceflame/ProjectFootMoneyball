import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {buildSimulationValues,SIMULATION_VALUE_VERSION} from '../docs/simulation-values.mjs';
import {buildSimulationBoard} from '../docs/simulation-rankings.mjs';import {recordPlayerValues} from '../scripts/record_player_values.mjs';
const files={rankings:'rankings',history:'player_history',news:'player_news',inputs:'player_value_inputs',simulation:'simulation_forecasts'};
const sources=Object.fromEntries(await Promise.all(Object.entries(files).map(async([key,name])=>[key,JSON.parse(await readFile(new URL(`../docs/data/${name}.json`,import.meta.url),'utf8'))])));
const now=Math.max(...Object.values(sources).map(s=>Date.parse(s.generated_at)))+1000;
test('value projections equal the simulation ranking points across scoring formats',()=>{
 for(const ppr of ['Standard','Half PPR','Full PPR'])for(const tePremium of ['None','+0.5']){
  const settings={ppr,tePremium},board=buildSimulationValues(sources,settings,{now});
  for(const horizon of ['draft','ros']){const ranking=new Map(buildSimulationBoard(sources.simulation,[],settings,{horizon,now}).rows.map(p=>[p.player_id,p]));
   for(const p of board.rows){const expected=ranking.get(p.player_id);if(horizon==='ros'&&!expected.forecast_games.length)continue;assert.equal(p[`${horizon}_points`],expected.projected_points);}
  }
  assert.ok(board.rows.some(p=>p.draft_index===null&&p.ros_index===null));assert.ok(board.rows.some(p=>p.draft_index===10000));
 }
});
test('dynasty is explicitly a conditional extrapolation and kickoff removes the matching ROS game',()=>{
 const board=buildSimulationValues(sources,{}, {now});const player=board.rows.find(p=>p.ros_points>0&&p.forecast_games.length);
 assert.ok(Math.abs(player.dynasty_points-(player.ros_points+.85*player.future_year_points[0]+.85**2*player.future_year_points[1]))<.02);
 const first=sources.simulation.games.find(g=>Date.parse(g.kickoff)>now);const after=buildSimulationValues(sources,{}, {now:Date.parse(first.kickoff)+1});
 const affected=after.rows.find(p=>p.team===first.home&&p.draft_points>0);assert.ok(!affected.forecast_games.some(g=>g.week===first.week));
 assert.match(board.assumptions.join(' '),/future|Future/);
});
test('simulation history has its own real dated capture and preserves original history',async t=>{
 const root=await mkdtemp(join(tmpdir(),'simulation-value-history-'));t.after(()=>rm(root,{recursive:true,force:true}));const data=join(root,'docs/data');await mkdir(data,{recursive:true});
 for(const[key,name]of Object.entries(files))await writeFile(join(data,`${name}.json`),JSON.stringify(sources[key]));
 await mkdir(join(data,'player_values'));await writeFile(join(data,'player_values/index.json'),'original history');
 const result=await recordPlayerValues(root,{now,simulation:true});assert.equal(await readFile(join(data,'player_values/index.json'),'utf8'),'original history');
 const manifest=JSON.parse(await readFile(join(data,'simulation_values/index.json'),'utf8'));assert.equal(manifest.model_version,SIMULATION_VALUE_VERSION);assert.equal(manifest.snapshots.length,1);
 const capture=JSON.parse(await readFile(join(data,`simulation_values/${result.date}.json`),'utf8'));assert.match(capture.cadence,/America\/New_York/);assert.equal(Object.keys(capture.formats).length,12);
 assert.ok(Object.values(capture.formats).every(f=>f.columns.includes('draft_index')));assert.match(capture.evidence.simulation.sha256,/^[a-f0-9]{64}$/);
 await assert.rejects(recordPlayerValues(root,{now:now-1,simulation:true}),/backdated/);
});
