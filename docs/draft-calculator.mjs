// Transparent two-pick scenarios, not calibrated opponent-pick probabilities.
export const DRAFT_CALCULATOR_VERSION='draft-calculator-v1';
const POSITIONS=['QB','RB','WR','TE','K','DST'], FLEX=['RB','WR','TE'];
const finite=Number.isFinite, sum=values=>values.reduce((a,b)=>a+b,0);
export const draftKey=row=>`${String(row.player).trim().toLowerCase()}|${String(row.listed_team||row.team||'').trim().toUpperCase()}`;
export function normalizeDraftSettings(value={}){
  const integer=(x,fallback,min,max)=>Number.isInteger(Number(x))&&Number(x)>=min&&Number(x)<=max?Number(x):fallback;
  const teams=integer(value.teams,12,4,20), slots={};
  for(const pos of [...POSITIONS,'FLEX','SF'])slots[pos]=integer(value.slots?.[pos],{QB:1,RB:2,WR:3,TE:1,K:0,DST:0,FLEX:1,SF:0}[pos],0,pos==='FLEX'||pos==='SF'?3:4);
  if(!sum(Object.values(slots))||sum(Object.values(slots))>16)throw Error('Choose between 1 and 16 starting slots.');
  return {teams,slot:integer(value.slot,1,1,teams),order:value.order==='linear'?'linear':'snake',slots,bench:integer(value.bench,6,0,15),
    currentPick:integer(value.currentPick,1,1,1000),opponents:value.opponents==='projection'?'projection':'adp',benchWeight:.15};
}
export function ownPick(round,teams,slot,order='snake'){return (round-1)*teams+(order==='snake'&&round%2===0?teams-slot+1:slot);}
export function nextOwnPick(current,settings){let round=Math.floor((current-1)/settings.teams)+1;let pick=ownPick(round,settings.teams,settings.slot,settings.order);if(pick<current)pick=ownPick(++round,settings.teams,settings.slot,settings.order);return {pick,round};}
export function bestLineup(roster,slots){
  const available=[...new Map(roster.filter(p=>finite(p.projected_points)).map(p=>[p.player_id,p])).values()].sort((a,b)=>b.projected_points-a.projected_points||a.player_id.localeCompare(b.player_id));
  const used=new Set(), assignments=[];
  for(const slot of [...POSITIONS,'FLEX','SF'])for(let i=0;i<(slots[slot]||0);i++){
    const eligible=p=>slot==='FLEX'?FLEX.includes(p.pos):slot==='SF'?['QB',...FLEX].includes(p.pos):p.pos===slot;
    const player=available.find(p=>!used.has(p.player_id)&&eligible(p));if(player)used.add(player.player_id);
    assignments.push({slot,player:player||null});
  }
  return {points:sum(assignments.map(s=>s.player?.projected_points||0)),assignments,bench:available.filter(p=>!used.has(p.player_id))};
}
export function calculateDraft(players,rosterIds=[],takenIds=[],rawSettings={}){
  const settings=normalizeDraftSettings(rawSettings), all=[...new Map(players.filter(p=>p.player_id&&POSITIONS.includes(p.pos)).map(p=>[p.player_id,p])).values()];
  const rated=all.filter(p=>finite(p.projected_points)), byId=new Map(all.map(p=>[p.player_id,p])), roster=[...new Set(rosterIds)].map(id=>byId.get(id)).filter(Boolean);
  const taken=new Set([...takenIds,...rosterIds]), capacity=sum(Object.values(settings.slots))+settings.bench;
  const leagueSlots=Object.fromEntries(Object.entries(settings.slots).map(([pos,count])=>[pos,count*settings.teams]));
  const starters=bestLineup(rated,leagueSlots), used=new Set(starters.assignments.map(s=>s.player?.player_id).filter(Boolean));
  const replacement=Object.fromEntries(POSITIONS.map(pos=>[pos,Math.max(0,...rated.filter(p=>p.pos===pos&&!used.has(p.player_id)).map(p=>p.projected_points))]));
  const canUse=p=>settings.slots[p.pos]>0||FLEX.includes(p.pos)&&settings.slots.FLEX>0||['QB',...FLEX].includes(p.pos)&&settings.slots.SF>0;
  const available=rated.filter(p=>!taken.has(p.player_id)&&canUse(p));
  const surplus=p=>p.projected_points-replacement[p.pos];
  const marketOrder=(a,b)=>settings.opponents==='adp'?(finite(a.adp)&&a.adp>0?a.adp:Infinity)-(finite(b.adp)&&b.adp>0?b.adp:Infinity)||surplus(b)-surplus(a)||a.player_id.localeCompare(b.player_id):surplus(b)-surplus(a)||a.player_id.localeCompare(b.player_id);
  const score=list=>{const lineup=bestLineup(list,settings.slots);return {lineup,value:sum(lineup.assignments.map(slot=>slot.player?surplus(slot.player):0))+settings.benchWeight*sum(lineup.bench.map(p=>Math.max(0,surplus(p))))};};
  const current=score(roster), turn=nextOwnPick(settings.currentPick,settings), next=ownPick(turn.round+1,settings.teams,settings.slot,settings.order);
  const before=[...available].sort(marketOrder).slice(0,Math.max(0,turn.pick-settings.currentPick)), beforeIds=new Set(before.map(p=>p.player_id));
  const atTurn=available.filter(p=>!beforeIds.has(p.player_id)), gap=next-turn.pick-1;
  const shortlist=POSITIONS.flatMap(pos=>atTurn.filter(p=>p.pos===pos).sort((a,b)=>b.projected_points-a.projected_points||a.player_id.localeCompare(b.player_id)).slice(0,10));
  const recommendations=[];
  if(roster.length<capacity&&turn.round<=capacity)for(const candidate of shortlist){
    const selected=[...roster,candidate], first=score(selected), removed=[...atTurn].filter(p=>p.player_id!==candidate.player_id).sort(marketOrder).slice(0,gap), removedIds=new Set(removed.map(p=>p.player_id));
    const later=atTurn.filter(p=>p.player_id!==candidate.player_id&&!removedIds.has(p.player_id));
    const nextCandidates=POSITIONS.map(pos=>later.filter(p=>p.pos===pos).sort((a,b)=>b.projected_points-a.projected_points||a.player_id.localeCompare(b.player_id))[0]).filter(Boolean);
    const choices=roster.length+1<capacity&&turn.round<capacity?nextCandidates.map(player=>({player,...score([...selected,player])})):[];
    choices.sort((a,b)=>b.value-a.value||a.player.player_id.localeCompare(b.player.player_id));const best=choices[0];
    const waitRemoved=new Set([...atTurn].sort(marketOrder).slice(0,gap).map(p=>p.player_id));
    const waitSame=atTurn.filter(p=>p.pos===candidate.pos&&!waitRemoved.has(p.player_id)).sort((a,b)=>b.projected_points-a.projected_points)[0];
    recommendations.push({player:candidate,lineup_gain:first.lineup.points-current.lineup.points,score:(best?.value??first.value)-current.value,
      next_player:best?.player||null,wait_drop:best&&waitSame?Math.max(0,candidate.projected_points-waitSame.projected_points):null,
      remains_in_wait_scenario:!waitRemoved.has(candidate.player_id)});
  }
  recommendations.sort((a,b)=>b.score-a.score||b.lineup_gain-a.lineup_gain||a.player.player.localeCompare(b.player.player));
  return {version:DRAFT_CALCULATOR_VERSION,settings,roster,lineup:current.lineup,replacement,capacity,your_pick:turn.pick,next_pick:turn.round<capacity?next:null,
    before_pick:before,between_picks:gap,recommendations,available,unrated:all.filter(p=>!finite(p.projected_points)&&!taken.has(p.player_id)).length,
    missing_adp:available.filter(p=>!finite(p.adp)||p.adp<=0).length,unknown_roster:roster.filter(p=>!finite(p.projected_points)).length,
    notes:['Uses the same saved simulation points as the rankings. Projection accuracy remains experimental.',
      'Compares starter points above the league replacement reference after this pick and one later pick. Bench surplus receives a transparent 15% weight; it is a planning rule, not an injury model.',
      'Opponent picks follow the selected scenario. ADP is an average, not an availability probability; missing ADP follows known ADP, ordered by projection surplus.',
      'Evaluates up to ten highest-projected available players per position. Empty starter slots contribute zero; unknown projections remain unrated.',
      'The 0–10,000 player value index is never added into the draft calculation. No multi-year pick trade or auction pricing is implied.']};
}
