import {compareTrade} from './trade-calculator.mjs?v=20261121-trade1';
import {buildSimulationValues} from './simulation-values.mjs?v=20261121-values2';
import {validateSimulationForecasts} from './simulation-rankings.mjs?v=20261121-sim1';
import {validateValueInputs} from './value-input-validation.mjs?v=20261121-trade1';
import {validateRankings,validateHistory,validateReports} from './snapshot-validation.mjs?v=20260927-refresh1';
import {fetchSnapshot,startAutoRefresh,preserveView} from './auto-refresh.mjs?v=20260927-refresh1';

const $=id=>document.getElementById(`trade-${id}`), KEY='outlierbaseline:trade-calculator:v1';
const read=()=>{try{const value=JSON.parse(localStorage.getItem(KEY));return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}};
const saved=read(), params=new URLSearchParams(location.search), groups=['give','receive','retained','adds'];
const safeIds=value=>Array.isArray(value)?[...new Set(value.filter(id=>typeof id==='string'&&id.length<100))].slice(0,60):[];
const selections=Object.fromEntries([...groups,'drops'].map(key=>[key,safeIds(saved[key])]));
const defaults={horizon:'ros',quarterbacks:'1QB',ppr:'Half PPR',tePremium:'None',QB:1,RB:2,WR:3,TE:1,FLEX:1,SF:0,bench:6};
for(const[key,value]of Object.entries(defaults))$(key).value=saved.settings?.[key]??value;
for(const[key,allowed]of Object.entries({horizon:['draft','ros','dynasty'],quarterbacks:['1QB','2QB'],ppr:['Standard','Half PPR','Full PPR'],tePremium:['None','+0.5']})){
 if(!allowed.includes($(key).value))$(key).value=defaults[key];if(allowed.includes(params.get(key)))$(key).value=params.get(key);
}
$('rosterComplete').checked=saved.rosterComplete===true;
const requestedPlayer=params.get('player');if(requestedPlayer&&!selections.give.includes(requestedPlayer)&&!selections.receive.includes(requestedPlayer)){
 selections.retained=selections.retained.filter(id=>id!==requestedPlayer);selections.adds=selections.adds.filter(id=>id!==requestedPlayer);selections.receive.push(requestedPlayer);
}
// Consume incoming chart settings once; reloading must respect later edits/removals.
for(const key of ['player','horizon','quarterbacks','ppr','tePremium'])params.delete(key);
history.replaceState(null,'',`${location.pathname}${params.size?`?${params}`:''}${location.hash}`);
let sources,board,rows=[],lastClock='',season=saved.season;
const n=value=>Number.isFinite(value)?value.toLocaleString(undefined,{maximumFractionDigits:1}):'—';
const signed=value=>Number.isFinite(value)?`${value>0?'+':''}${n(value)}`:'—';
const node=(tag,text,className)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;if(className)el.className=className;return el;};
const settings=()=>Object.fromEntries(Object.keys(defaults).map(key=>[key,$(key).value]));
const persist=()=>{try{localStorage.setItem(KEY,JSON.stringify({schema_version:1,season:season??board?.season,settings:settings(),...selections,rosterComplete:$('rosterComplete').checked}));$('storage-note').hidden=true;}catch{$('storage-note').textContent='This browser cannot save the comparison. You can still use it until the page closes.';$('storage-note').hidden=false;}};
const find=id=>rows.find(p=>p.player_id===id)||{player_id:id,player:'Player unavailable in this season',pos:'?',team:''};
function picker(group){
 const select=$(`${group}-picker`),selected=select.value,query=$(`${group}-search`).value.trim().toLowerCase();
 const used=new Set(groups.flatMap(key=>selections[key]));
 const options=rows.filter(p=>!used.has(p.player_id)&&`${p.player} ${p.team} ${p.pos}`.toLowerCase().includes(query)).sort((a,b)=>a.player.localeCompare(b.player));
 select.replaceChildren(...options.map(p=>new Option(`${p.player} · ${p.pos} · ${p.team}${p[`${$('horizon').value}_points`]===null?' · unrated':''}`,p.player_id)));
 if(options.some(p=>p.player_id===selected))select.value=selected;$(`${group}-add`).disabled=!options.length||(['give','receive'].includes(group)&&selections[group].length>=8);
}
function list(group){
 const horizon=$('horizon').value,s=settings();
 $(`${group}-list`).replaceChildren(...selections[group].map(id=>{const p=find(id),li=node('li'),body=node('div'),link=node('a',p.player);
  link.href=`values.html?${new URLSearchParams({model:'simulation',player:id,horizon,ppr:s.ppr,quarterbacks:s.quarterbacks,tePremium:s.tePremium})}`;
  body.append(link,node('small',`${p.pos} · ${p.team||'Team unknown'} · ${n(p[`${horizon}_points`])} projected points`),node('small',`${signed(p[`${horizon}_surplus`])} above replacement`));
  const button=node('button','Remove');button.type='button';button.dataset.remove=id;button.dataset.group=group;button.setAttribute('aria-label',`Remove ${p.player} from ${group}`);li.append(body,button);return li;}));
}
function render(){
 if(!board)return;rows=board.rows;const s=settings(),horizon=s.horizon;
 for(const group of groups){list(group);picker(group);}
 const postIds=[...new Set([...selections.retained,...selections.receive])];selections.drops=selections.drops.filter(id=>postIds.includes(id));
 $('drops').replaceChildren(...postIds.map(id=>{const p=find(id),label=node('label',null,'trade-check'),input=node('input');input.type='checkbox';input.dataset.drop=id;input.checked=selections.drops.includes(id);label.append(input,document.createTextNode(p.player));return label;}));
 const result=compareTrade(board,{...selections,horizon,rosterComplete:$('rosterComplete').checked,slots:Object.fromEntries(['QB','RB','WR','TE','FLEX','SF'].map(pos=>[pos,$(pos).value])),bench:$('bench').value});
 for(const group of ['give','receive']){const side=result[group];$(`${group}-total`).textContent=side.count?`${side.count} player${side.count===1?'':'s'} · ${n(side.points)} projected points · ${signed(side.surplus)} above replacement`:'No players selected.';}
 $('verdict').textContent=result.edge===null?result.issues.join(' '):result.edge===0?'The packages have equal projected points above replacement.':`${result.edge>0?'You receive':'You give'} ${n(Math.abs(result.edge))} more projected points above replacement.`;
 const extra=result.extra_roster_spots;
 $('spots').textContent=!result.give.count||!result.receive.count?'':extra>0?`You receive ${extra} extra player${extra===1?'':'s'}. You need that many free spots or matching drops; use the roster check below.`:extra<0?`This deal opens ${-extra} roster spot${extra===-1?'':'s'}. An available-player addition can change the result; none is assumed automatically.`:'The trade exchanges the same number of players.';
 $('outlook-note').textContent=horizon==='dynasty'?'Dynasty totals are conditional three-year production, with discounted age-adjusted future seasons. They are not future market prices.':horizon==='draft'?'Full season applies current roles across the schedule. It is not a projection of next year’s unknown roster.':'Only unstarted regular-season games are included. Upcoming availability remains conditional.';
 const roster=result.roster,container=$('roster-result');container.replaceChildren();
 if(!roster)container.append(node('p','Add your remaining players and check the box to calculate your roster impact. Package totals alone do not establish a two-for-one trade’s effect on your starters.'));
 else if(roster.issues.length)container.append(node('p',roster.issues.join(' '),'values-warning'));
 else{container.append(node('p',horizon==='ros'?'Best projected weekly starters, summed over remaining games:':'Illustrative starting lineup across the selected horizon:'),node('strong',`${n(roster.before_points)} before → ${n(roster.after_points)} after (${signed(roster.gain)} points)`),node('p',`${roster.before.length} → ${roster.after.length} players held · ${roster.capacity} roster spots · ${roster.open_spots} open afterward. Bench players do not contribute starter points.`));}
 $('status').textContent=`${board.season} · Shared matchup simulation · Projections ${new Date(board.simulation_generated_at).toLocaleString()} · Comparison saved on this browser.${board.simulation_stale?' Evidence is older than 48 hours; showing the last saved projections.':''}`;
 $('season-note').hidden=!season||season===board.season;$('season-note').textContent=`This comparison began in ${season}. Review its players for ${board.season}, or clear it to start again. Missing players remain unavailable.`;
}
function rebuild(){if(!sources)return;const next=buildSimulationValues(sources,settings());board=next;preserveView(render);}
function act(callback){try{callback();rebuild();persist();$('action-note').textContent='Comparison updated.';}catch(error){$('action-note').textContent=error.message;$('verdict').textContent='Correct the settings to recalculate this comparison.';$('roster-result').replaceChildren(node('p',error.message,'values-warning'));}}
for(const group of groups){$(`${group}-search`).addEventListener('input',()=>picker(group));$(`${group}-add`).addEventListener('click',()=>act(()=>{const id=$(`${group}-picker`).value;if(id&&!groups.some(key=>selections[key].includes(id))&&(!['give','receive'].includes(group)||selections[group].length<8))selections[group].push(id);}));}
document.addEventListener('click',event=>{const button=event.target.closest('[data-remove]');if(button)act(()=>{selections[button.dataset.group]=selections[button.dataset.group].filter(id=>id!==button.dataset.remove);});});
$('drops').addEventListener('change',event=>{const id=event.target.dataset.drop;if(id)act(()=>{selections.drops=event.target.checked?[...new Set([...selections.drops,id])]:selections.drops.filter(value=>value!==id);});});
$('settings').addEventListener('submit',event=>{event.preventDefault();act(()=>{});});
for(const id of ['QB','RB','WR','TE','FLEX','SF','bench','rosterComplete'])$(id).addEventListener('change',()=>act(()=>{}));
$('clear').addEventListener('click',()=>act(()=>{for(const key of [...groups,'drops'])selections[key]=[];$('rosterComplete').checked=false;season=board?.season;}));
startAutoRefresh(async signal=>{
 const files={rankings:['rankings',validateRankings],inputs:['player_value_inputs',validateValueInputs],history:['player_history',validateHistory],news:['player_news',validateReports],simulation:['simulation_forecasts',validateSimulationForecasts]};
 const entries=await Promise.all(Object.entries(files).map(async([key,[file,validate]])=>[key,await fetchSnapshot(`data/${file}.json`,{signal,validate})]));
 const next=Object.fromEntries(entries);if(next.rankings.projection_season!==next.inputs.season)throw Error('The player and game snapshots belong to different seasons.');
 if(Object.values(next).some(value=>!Number.isFinite(Date.parse(value.generated_at))||Date.parse(value.generated_at)>Date.now()+300000))throw Error('A source capture is missing its date or is future-dated.');
 const calculated=buildSimulationValues(next,settings());sources=next;board=calculated;if(!season)season=board.season;$('error').hidden=true;preserveView(render);persist();
},{canRefresh:()=>!document.activeElement?.matches('input,select'),onCheck:()=>{
 if(!sources)return;const signature=JSON.stringify([sources.simulation.games.filter(g=>Date.parse(g.kickoff)>Date.now()).map(g=>g.game_id),Date.now()-Date.parse(sources.simulation.evidence_generated_at)>48*3600000]);if(signature!==lastClock){rebuild();lastClock=signature;}
},onError:error=>{$('error').textContent=`Refresh unavailable. ${error.message}${board?' The last loaded projections and your selections are retained.':' Your saved selections will load when projections recover.'}`;$('error').hidden=false;}});
