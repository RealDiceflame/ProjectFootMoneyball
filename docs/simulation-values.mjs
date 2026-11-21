import {buildValueBoard, normalizeValueSettings, valueFormatKey} from './player-values.mjs?v=20261121-values2';
import {buildSimulationBoard, validateSimulationForecasts} from './simulation-rankings.mjs?v=20261121-sim1';
export const SIMULATION_VALUE_VERSION = 'simulation-value-v1';
const finite = Number.isFinite, round = value => finite(value) ? Math.round(value*100)/100 : null;
const positions = ['QB','RB','WR','TE'];
export function buildSimulationValues(sources, settings={}, {now=Date.now()}={}) {
  const simulation=sources.simulation;
  if (!validateSimulationForecasts(simulation) || simulation.season!==sources.inputs?.season || Date.parse(simulation.generated_at)>now+300000)
    throw new Error('Matching simulation projections are unavailable. Select the original model or retry after the next update.');
  const s=normalizeValueSettings(settings), original=buildValueBoard(sources,s,{now}), observed=new Map(original.rows.map(row=>[row.player_id,row]));
  const season=buildSimulationBoard(simulation,[],s,{horizon:'draft',now}), ros=buildSimulationBoard(simulation,[],s,{horizon:'ros',now});
  const remaining=new Map(ros.rows.map(row=>[row.player_id,row]));
  const rows=season.rows.filter(row=>positions.includes(row.pos)).map(full=>{
    const observedRow=observed.get(full.player_id), base=observedRow?.pos===full.pos?observedRow:{}, current=remaining.get(full.player_id), known=finite(full.projected_points);
    const factors=base.future_age_factors||[1,1], year1=known?full.projected_points*factors[0]:null, year2=year1===null?null:year1*factors[1];
    const games=current?.forecast_games||[], points=known?(games.length?current.projected_points:0):null;
    return {...base,player_id:full.player_id,player:full.player,pos:full.pos,team:full.team,
      projected_ppg:full.projected_ppg,draft_points:full.projected_points,draft_games:full.projection_expected_games,
      ros_points:points,remaining_games:games.length,available_games:games.filter(g=>!g.out).length,
      dynasty_points:points===null?null:round(points+.85*year1+.85**2*year2),future_year_points:[round(year1),round(year2)],
      forecast_games:games,confidence:full.confidence,notes:[...(base.notes||[]).filter(n=>!n.startsWith('No usable recent-season prior')),
        'Projection points come from the shared matchup simulator. Current observed scores remain actual recorded results.',
        'Draft is a conditional full-season outlook using current roles. Dynasty adds two age-adjusted full-season scenarios; future coaches, opponents and roles are not simulated.',
        ...(!base.future_age_factors?['No matching age evidence; future-season age multipliers remain neutral.']:[]),
        ...(!known?['No observed simulation role; this player remains unrated.']:[])]};
  });
  const replacement={}, depths={QB:s.quarterbacks==='2QB'?25:13,RB:25,WR:37,TE:13};
  for(const pos of positions){const group=rows.filter(p=>p.pos===pos&&finite(p.projected_ppg)).sort((a,b)=>b.projected_ppg-a.projected_ppg);const player=group[Math.min(depths[pos]-1,group.length-1)];replacement[pos]={depth:depths[pos],ppg:player?Math.max(0,player.projected_ppg):null,player_id:player?.player_id||null,population:group.length,limited:group.length<depths[pos]};}
  for(const row of rows){const baseline=replacement[row.pos].ppg;
    row.ros_surplus=row.ros_points===null||baseline===null?null:round(row.ros_points-baseline*row.remaining_games);
    row.draft_surplus=row.draft_points===null||baseline===null?null:round(row.draft_points-baseline*row.draft_games);
    row.dynasty_surplus=row.ros_surplus===null?null:round(row.ros_surplus+.85*(row.future_year_points[0]-baseline*17)+.85**2*(row.future_year_points[1]-baseline*17));
  }
  for(const horizon of ['draft','ros','dynasty']){
    const max=Math.max(0,...rows.map(p=>p[`${horizon}_surplus`]??0));
    for(const row of rows)row[`${horizon}_index`]=row[`${horizon}_surplus`]===null?null:max?Math.round(10000*Math.max(0,row[`${horizon}_surplus`])/max):0;
    [...rows].sort((a,b)=>(b[`${horizon}_surplus`]??-Infinity)-(a[`${horizon}_surplus`]??-Infinity)||a.player.localeCompare(b.player)).forEach((p,i)=>{p[`rank_${horizon}`]=p[`${horizon}_surplus`]===null?null:i+1;});
  }
  return {...original,model_version:SIMULATION_VALUE_VERSION,format_key:valueFormatKey(s),rows,replacement,simulation_generated_at:simulation.generated_at,
    simulation_stale:now-Date.parse(simulation.evidence_generated_at)>48*3600000,
    assumptions:['Experimental simulation projections; improved accuracy has not been established.',
      'The value index compares projected points above the same fixed 12-team replacement reference. Indices are not additive trade prices.',
      'ROS uses only unstarted games. Draft uses current roles across the full schedule. Missing roles remain unrated.',
      'Dynasty combines simulated ROS with two conditional full seasons, age-adjusted and discounted by 0.85 and 0.85². Future roles, coaches and schedules are unknown.',
      'Simulation value history is recorded separately from the original model. Past simulation values are never invented.']};
}
