import {calculateDraft,draftKey} from './draft-calculator.mjs?v=20261121-draft1';
import {buildSimulationBoard,validateSimulationForecasts} from './simulation-rankings.mjs?v=20261121-sim1';
import {applyPersonalAdp} from './adp-import.mjs?v=20261105-no-mfl1';
import {DRAFT_ALIASES_KEY,validDraftAliases,migrateDraftedKeys,toggleDraftedKey,columnarDraftRows} from './draft-identity.mjs?v=20260927-refresh1';
import {fetchSnapshot,startAutoRefresh} from './auto-refresh.mjs?v=20260927-refresh1';
import {validateRankings} from './snapshot-validation.mjs?v=20260927-refresh1';
const $=id=>document.getElementById(`draft-${id}`), KEY='outlierbaseline:draft-calculator:v1', TAKEN='project-foot-moneyball:drafted:v1', PERSONAL='outlierbaseline:personal-adp:v1';
const read=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}};
const save=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{$('error').textContent='This browser cannot save changes. The calculator still works until you close the page.';$('error').hidden=false;}};
const saved=read(KEY,{}), legacy=read('project-foot-moneyball:settings:v1',{}), params=new URLSearchParams(location.search);
let simulation,rankings,rows=[],result,rosterIds=new Set(Array.isArray(saved.rosterIds)?saved.rosterIds:[]),taken=new Set(Array.isArray(read(TAKEN,[]))?read(TAKEN,[]):[]),aliases=validDraftAliases(read(DRAFT_ALIASES_KEY,[])),lastSignature='';
const initial=saved.settings||{};
for(const [id,fallback] of Object.entries({teams:legacy.teams||12,slot:1,order:'snake',current:'',horizon:'draft',ppr:legacy.ppr||'Half PPR',premium:legacy.tePremium==='+0.5'?'+0.5':'Off',opponents:'adp',QB:legacy.quarterbacks==='2QB'?2:1,RB:2,WR:3,TE:1,FLEX:1,SF:0,K:legacy.kickers==='Include'?1:0,DST:legacy.defenses==='Include'?1:0,bench:6}))$(id).value=initial[id]??fallback;
if(['Standard','Half PPR','Full PPR'].includes(params.get('ppr')))$('ppr').value=params.get('ppr');
if(params.get('quarterbacks'))$('QB').value=params.get('quarterbacks')==='2QB'?2:1;
if(params.has('tePremium'))$('premium').value=params.get('tePremium')==='+0.5'?'+0.5':'Off';
const ids=['teams','slot','order','current','horizon','ppr','premium','opponents','QB','RB','WR','TE','FLEX','SF','K','DST','bench'];
const currentSettings=()=>Object.fromEntries(ids.map(id=>[id,$(id).value]));
const persist=()=>save(KEY,{schema_version:1,season:simulation?.season,settings:currentSettings(),rosterIds:[...rosterIds]});
const node=(tag,text,className)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;if(className)el.className=className;return el;};
const n=value=>Number.isFinite(value)?value.toLocaleString(undefined,{maximumFractionDigits:1}):'—';
function scoring(){return {teams:Number($('teams').value),quarterbacks:Number($('QB').value)+Number($('SF').value)>1?'2QB':'1QB',ppr:$('ppr').value,tePremium:$('premium').value,kickers:'Include',defenses:'Include'};}
function marketRows(){
 const s=scoring(),ppr={'Standard':'standard','Half PPR':'half_ppr','Full PPR':'full_ppr'}[s.ppr],qb=s.quarterbacks.toLowerCase();
 const format=s.tePremium==='+0.5'?(ppr==='half_ppr'?(qb==='1qb'?'te_premium_half_ppr':'2qb_te_premium_half_ppr'):`${qb}_te_premium_${ppr}`):`${qb}_${ppr}`;
 const arrays=rankings.boards[`${s.teams}team_${format}`]||Object.values(rankings.boards)[0];
 return arrays.map(values=>Object.fromEntries(rankings.columns.map((key,i)=>[key,values[i]])));
}
function renderPicker(){const selected=$('player').value||params.get('player'),query=$('search').value.trim().toLowerCase();const visible=rows.filter(p=>`${p.player} ${p.team} ${p.pos}`.toLowerCase().includes(query)).sort((a,b)=>a.player.localeCompare(b.player));$('player').replaceChildren(...visible.map(p=>new Option(`${p.player} · ${p.pos} · ${p.team}${rosterIds.has(p.player_id)?' · my team':taken.has(draftKey(p))?' · taken':''}`,p.player_id)));if(visible.some(p=>p.player_id===selected))$('player').value=selected;for(const id of ['mine','other','undo'])$(id).disabled=!visible.length;}
function render(){
 if(!simulation||!rankings)return;
 const base=marketRows(), settings=scoring();
 rows=buildSimulationBoard(simulation,base,settings,{horizon:$('horizon').value}).rows;
 if(!rows.length)throw Error('Simulation projections are unavailable or future-dated.');
 const personal=read(PERSONAL,null);if(personal?.entries?.length)rows=applyPersonalAdp(rows,personal).rows;
 const migrated=migrateDraftedKeys(taken,columnarDraftRows(rankings),rows,aliases);
 if(JSON.stringify([...taken].sort())!==JSON.stringify([...migrated.drafted].sort())){taken=migrated.drafted;save(TAKEN,[...taken]);}
 if(JSON.stringify(aliases)!==JSON.stringify(migrated.aliases)){aliases=migrated.aliases;save(DRAFT_ALIASES_KEY,aliases);}
 const takenIds=rows.filter(p=>taken.has(draftKey(p))).map(p=>p.player_id),knownKeys=new Set(rows.map(draftKey));
 const linked=new Set(aliases.filter(group=>group.some(key=>knownKeys.has(key))).flat()),unmatched=[...taken].filter(key=>!knownKeys.has(key)&&!linked.has(key));
 const slots=Object.fromEntries(['QB','RB','WR','TE','FLEX','SF','K','DST'].map(pos=>[pos,Number($(pos).value)]));
 const raw={teams:Number($('teams').value),slot:Number($('slot').value),order:$('order').value,slots,bench:Number($('bench').value),currentPick:$('current').value?Number($('current').value):takenIds.length+unmatched.length+1,opponents:$('opponents').value};
 result=calculateDraft(rows,[...rosterIds],takenIds,raw);
 $('turn').textContent=`Your turn: pick ${result.your_pick}${result.next_pick?` · then pick ${result.next_pick}`:''}`;
 $('context').textContent=`${simulation.season} · ${$('horizon').value==='draft'?'Full-season current-role scenario':'Unstarted remaining games'} · ${settings.ppr} · ${result.settings.teams} teams · ${result.settings.order==='snake'?'snake':'same-order'} draft. ${result.before_pick.length} assumed selections before your turn; ${result.between_picks} between your next two picks.`;
 $('summary').replaceChildren(...[['My roster',`${result.roster.length}/${result.capacity}`],['Modeled starter points',n(result.lineup.points)],['Rated players available',result.available.length]].map(([label,value])=>{const el=node('article',label);el.append(node('strong',String(value)));return el;}));
 $('before').textContent=result.before_pick.map(p=>p.player).join(' · ')||'You are on the clock in this scenario.';
 $('caveat').textContent=`${result.missing_adp} available players have no market ADP. ${result.unrated} players have no rated projection.${result.unknown_roster?` ${result.unknown_roster} roster players have unknown projections; modeled lineup points are incomplete.`:''}${unmatched.length?` ${unmatched.length} saved taken marks cannot be matched to the current player list; adjust the overall pick if needed.`:''}${personal?.entries?.length?' Your imported ADP is in use.':''}`;
 $('candidates').replaceChildren(...result.recommendations.slice(0,20).map(rec=>{const p=rec.player,tr=node('tr'),name=node('td');if(['QB','RB','WR','TE'].includes(p.pos)){const link=node('a',p.player);link.href=`values.html?${new URLSearchParams({model:'simulation',player:p.player_id,ppr:settings.ppr,quarterbacks:settings.quarterbacks,tePremium:settings.tePremium==='+0.5'?'+0.5':'None'})}`;name.append(link);}else name.append(node('strong',p.player));name.append(node('small',p.team));tr.append(name,...[p.pos,n(p.projected_points),n(p.adp),n(rec.lineup_gain),n(rec.wait_drop),n(rec.score),rec.next_player?.player||'No further pick'].map(value=>node('td',value)));const action=node('td'),button=node('button','Add to my team');button.type='button';button.dataset.pick=p.player_id;button.setAttribute('aria-label',`Draft ${p.player} to my team`);action.append(button);tr.append(action);return tr;}));
 $('empty').hidden=!!result.recommendations.length;$('empty').textContent=result.roster.length>=result.capacity?'Your roster is full. Return a player to the pool or change roster slots.':'No eligible rated candidates remain in this scenario.';
 $('roster-note').textContent='Starting assignments maximize projected points within your slots. Bench players and unknown projections remain visible.';
 const assigned=new Map(result.lineup.assignments.filter(a=>a.player).map(a=>[a.player.player_id,a.slot]));
 $('roster').replaceChildren(...result.roster.map(p=>{const el=node('article');el.append(node('strong',p.player),node('p',`${p.pos} · ${p.team} · ${assigned.get(p.player_id)||'Bench / unassigned'}`),node('p',`${n(p.projected_points)} projected points`));const button=node('button','Return to pool','button secondary');button.type='button';button.dataset.undo=p.player_id;el.append(button);return el;}));
 $('notes').replaceChildren(...result.notes.map(note=>node('li',note)));
 $('status').textContent=`Projections updated ${new Date(simulation.generated_at).toLocaleString()} · ${simulation.iterations} simulations per fixture · saved locally.${Date.now()-Date.parse(simulation.evidence_generated_at)>48*3600000?' Evidence is older than 48 hours; showing the last saved projections.':''}`;
 if(saved.season&&saved.season!==simulation.season){$('error').textContent=`Your saved draft began in ${saved.season}. Review it or use Start a new draft for ${simulation.season}.`;$('error').hidden=false;}
 renderPicker();
}
function pick(id,owner){const player=rows.find(p=>p.player_id===id);if(!player)return;const key=draftKey(player);
 if(owner==='mine'&&!rosterIds.has(id)&&result.roster.length>=result.capacity){$('pick-message').textContent='Your roster is full. Change its size or return a player first.';return;}
 if(owner==='undo'){rosterIds.delete(id);if(taken.has(key))taken=toggleDraftedKey(taken,key,aliases);}
 else{if(!taken.has(key))taken=toggleDraftedKey(taken,key,aliases);if(owner==='mine')rosterIds.add(id);else rosterIds.delete(id);}
 save(TAKEN,[...taken]);persist();render();$('pick-message').textContent=`${player.player}: ${owner==='mine'?'added to your team':owner==='undo'?'returned to the pool':'marked taken by another team'}.`;
}
$('settings').addEventListener('submit',event=>{event.preventDefault();if(Number($('slot').value)>Number($('teams').value)){$('error').textContent='Your draft position cannot exceed the number of teams.';$('error').hidden=false;return;}try{$('error').hidden=true;render();persist();}catch(error){$('error').textContent=error.message;$('error').hidden=false;}});
$('search').addEventListener('input',renderPicker);
for(const owner of ['mine','other','undo'])$(owner).addEventListener('click',()=>pick($('player').value,owner));
$('candidates').addEventListener('click',event=>{const button=event.target.closest('[data-pick]');if(button)pick(button.dataset.pick,'mine');});
$('roster').addEventListener('click',event=>{const button=event.target.closest('[data-undo]');if(button)pick(button.dataset.undo,'undo');});
$('reset').addEventListener('click',()=>$('reset-dialog').showModal());
$('reset-dialog').addEventListener('close',()=>{if($('reset-dialog').returnValue!=='confirm')return;rosterIds.clear();taken.clear();saved.season=simulation?.season;$('error').hidden=true;$('current').value='';save(TAKEN,[]);persist();render();});
window.addEventListener('storage',event=>{if([TAKEN,DRAFT_ALIASES_KEY,PERSONAL,KEY].includes(event.key)){
  taken=new Set(Array.isArray(read(TAKEN,[]))?read(TAKEN,[]):[]);aliases=validDraftAliases(read(DRAFT_ALIASES_KEY,[]));const storedIds=read(KEY,{}).rosterIds;rosterIds=new Set(Array.isArray(storedIds)?storedIds:[]);
  if(event.key===TAKEN){rosterIds=new Set([...rosterIds].filter(id=>{const p=rows.find(p=>p.player_id===id);return p&&taken.has(draftKey(p));}));persist();}
  try{render();}catch{}
}});
let clockSignature='';
startAutoRefresh(async signal=>{const [next,data]=await Promise.all([fetchSnapshot('data/simulation_forecasts.json',{signal,validate:validateSimulationForecasts}),fetchSnapshot('data/rankings.json',{signal,validate:validateRankings})]);if(next.season!==data.projection_season)throw Error('Projection and market seasons differ.');if(Date.parse(next.generated_at)>Date.now()+300000)throw Error('Projection capture is future-dated.');const signature=`${next.generated_at}|${data.generated_at}`;simulation=next;rankings=data;const recovered=!$('error').hidden;$('error').hidden=true;if(signature!==lastSignature||recovered){render();lastSignature=signature;}},{canRefresh:()=>!document.querySelector('dialog[open]')&&!document.activeElement?.matches('input,select'),onCheck:()=>{
  if(!simulation)return;const next=JSON.stringify([simulation.games.filter(g=>Date.parse(g.kickoff)>Date.now()).map(g=>g.game_id),Date.now()-Date.parse(simulation.evidence_generated_at)>48*3600000]);if(next!==clockSignature){clockSignature=next;render();}
},onError:error=>{$('error').textContent=`Refresh unavailable. ${error.message} Last loaded data is retained.`;$('error').hidden=false;}});
