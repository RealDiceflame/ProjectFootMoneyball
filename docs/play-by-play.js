import {validGameId,gameSnapshotTime} from "./game-data.mjs?v=20261030-historical1";
import {validatePlayByPlay,selectedPlays,quarterLabel,playSituation} from "./play-by-play-data.mjs?v=20261030-pbp1";
const $=id=>document.getElementById(id);
const el=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
const gameId=new URLSearchParams(location.search).get("game");
let last=null,busy=false,lastAttempt=0,signature=null;

function eventCard(p,game) {
  const item=el("li",undefined,`pbp-event${p.scoring?" pbp-scoring":""}`);
  item.dataset.playId=String(p.play_id);
  const heading=el("div",undefined,"pbp-event-heading");
  heading.append(el("strong",`${quarterLabel(p.quarter)} · ${p.clock??"Clock unavailable"}`),
    el("span",`${game.away} ${p.away_score} – ${game.home} ${p.home_score}`,"pbp-score"));
  const tags=[p.possession_team,playSituation(p)];
  if(p.scoring)tags.push("Scoring play");
  if(p.penalty===1)tags.push("Penalty");
  if(p.play_type==="no_play")tags.push("No play / stoppage");
  item.append(heading,el("p",tags.filter(Boolean).join(" · "),"pbp-context"),el("p",p.description,"pbp-description"));
  return item;
}

function renderEvents() {
  if(!last)return;
  const quarter=$("pbp-quarter").value,view=$("pbp-view").value;
  const plays=selectedPlays(last,{quarter,view}),content=$("pbp-events");
  const opened=new Set([...content.querySelectorAll("details[open]")].map(n=>n.dataset.drive));
  $("pbp-filter-status").textContent=`${plays.length} ${view==="scoring"?"scoring events":"recorded events"}${quarter!=="all"?` in ${quarterLabel(Number(quarter))}`:" in the game"}`;
  if(!plays.length){content.replaceChildren(el("p","No events match these filters.","pbp-empty"));return;}
  if(view!=="drives"){
    const list=el("ol",undefined,"pbp-list");list.append(...plays.map(p=>eventCard(p,last.game)));content.replaceChildren(list);return;
  }
  const nodes=[];
  for(const drive of last.drives){
    const events=plays.filter(p=>p.drive===drive.drive);if(!events.length)continue;
    const details=el("details",undefined,"pbp-drive");details.dataset.drive=String(drive.drive);
    if(opened.has(String(drive.drive)))details.open=true;
    const summary=el("summary");
    summary.append(el("span",`Drive ${drive.drive} · ${drive.start_team??"Team unavailable"}`,"pbp-drive-title"),
      el("span",drive.result??"Result unavailable","pbp-drive-result"),el("small",`${events.length} recorded events${quarter!=="all"?" in this period":""}`));
    const list=el("ol",undefined,"pbp-list");list.append(...events.map(p=>eventCard(p,last.game)));details.append(summary,list);nodes.push(details);
  }
  content.replaceChildren(...nodes);
}

function render(data,failed) {
  const status=$("pbp-status");status.classList.toggle("stale",failed);
  if(!data){
    status.textContent=failed?"Play-by-play could not load. Try again shortly.":"Play-by-play is not yet published for this game.";
    $("pbp-controls").hidden=true;$("pbp-events").replaceChildren();$("pbp-download").hidden=true;return;
  }
  $("pbp-controls").hidden=false;$("pbp-download").hidden=false;
  $("pbp-download").href=`data/play_by_play/2025/${gameId}.json`;
  $("pbp-download").download=`${gameId}-plays.json`;
  const stamp=gameSnapshotTime(data.updated_at);
  status.textContent=`2025 regular-season archive · ${data.plays.length} recorded events · ${data.drives.length} drives · `+
    (stamp.valid?`Snapshot ${new Date(data.updated_at).toLocaleString()}`:"Snapshot time unavailable")+
    (failed?" · Refresh unavailable; showing the last successful snapshot":"");
  if(!stamp.valid)status.classList.add("stale");
  const next=JSON.stringify([data.plays,data.drives]);
  if(signature!==next){signature=next;renderEvents();}
}

async function load() {
  if(busy||document.hidden)return;
  if(!validGameId(gameId)||!gameId.startsWith("2025_")){
    $("pbp-status").textContent="Play-by-play currently covers the 2025 regular season. Choose a 2025 game from NFL stats.";
    $("pbp-controls").hidden=true;return;
  }
  busy=true;lastAttempt=Date.now();
  try{
    const response=await fetch(`data/play_by_play/2025/${gameId}.json`,{cache:"no-store",signal:AbortSignal.timeout(15000)});
    if(response.status===404&&!last){render(null,false);return;}
    if(!response.ok)throw new Error("Play archive unavailable");
    const next=validatePlayByPlay(await response.json(),gameId);
    // An incomplete replacement must not erase a previously displayed event.
    if(last){const ids=new Set(next.plays.map(p=>p.play_id));if(last.plays.some(p=>!ids.has(p.play_id)))throw new Error("Play archive regressed");}
    last=next;render(last,false);
  }catch{render(last,true);}finally{busy=false;}
}
$("pbp-quarter").addEventListener("change",renderEvents);
$("pbp-view").addEventListener("change",renderEvents);
setInterval(load,60000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&Date.now()-lastAttempt>=60000)load();});
load();
