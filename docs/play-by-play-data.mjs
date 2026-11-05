import {validGameIdentity} from "./game-data.mjs?v=20261030-historical1";
const integer=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max;
const optionalNumber=(v,min,max)=>v===null||integer(v,min,max);
const optionalText=v=>v===null||(typeof v==="string"&&v.length<=12000);
export const quarterLabel=q=>q===5?"OT":`Q${q}`;

export function validatePlayByPlay(data,id) {
  const fail=()=>{throw new Error("Invalid play-by-play snapshot");};
  if(!data||data.schema_version!==1||data.season!==2025||data.season_type!=="REG"||data.game_id!==id||!id.startsWith("2025_")||!validGameIdentity(data.game,id))fail();
  const game=data.game,teams=[game.away,game.home];
  if(!integer(game.home_score,0,200)||!integer(game.away_score,0,200)||!Array.isArray(data.plays)||!data.plays.length||data.plays.length>1000||!Array.isArray(data.drives)||!data.drives.length)fail();
  const ids=new Set(),drives=new Map();
  for(const drive of data.drives){
    if(!drive||!integer(drive.drive,1,100)||drives.has(drive.drive)||!(drive.start_team===null||teams.includes(drive.start_team))||!optionalText(drive.result))fail();
    drives.set(drive.drive,drive);
  }
  let order=0,quarter=1,driveNumber=1,home=0,away=0,scoring=0,missing=0;
  const usedDrives=new Set();
  for(const p of data.plays){
    if(!p||!integer(p.play_id,1,100000)||ids.has(p.play_id)||!integer(p.order,1,100000)||p.order<=order||!integer(p.quarter,1,5)||p.quarter<quarter||!integer(p.drive,1,100)||p.drive<driveNumber||!drives.has(p.drive))fail();
    if(!(p.clock===null||(typeof p.clock==="string"&&/^(?:[0-9]|[0-5][0-9]):[0-5][0-9]$/.test(p.clock)&&Number(p.clock.split(":")[0])*60+Number(p.clock.split(":")[1])<=900)))fail();
    if(!optionalNumber(p.down,1,4)||!integer(p.yards_to_go,0,100)||!optionalNumber(p.yards_to_goal,0,100)||!optionalNumber(p.yards_gained,-100,100)||!optionalText(p.yardline)||!optionalText(p.play_type)||typeof p.description!=="string"||!p.description||p.description.length>12000)fail();
    if(![p.possession_team,p.defense_team].every(t=>t===null||teams.includes(t))||(p.possession_team&&p.possession_team===p.defense_team))fail();
    if(!integer(p.home_score,home,200)||!integer(p.away_score,away,200)||typeof p.scoring!=="boolean"||((p.home_score+p.away_score!==home+away)!==p.scoring)||![p.penalty,p.touchdown,p.safety].every(v=>optionalNumber(v,0,1)))fail();
    if(!Array.isArray(p.players)||p.players.length>3)fail();
    const roles=new Set();
    for(const player of p.players){
      if(!player||!["passer","rusher","receiver"].includes(player.role)||roles.has(player.role)||!(player.player_id===null||/^00-\d{7}$/.test(player.player_id))||!optionalText(player.name))fail();
      roles.add(player.role);
    }
    ids.add(p.play_id);usedDrives.add(p.drive);order=p.order;quarter=p.quarter;driveNumber=p.drive;home=p.home_score;away=p.away_score;
    scoring+=Number(p.scoring);missing+=Number(p.clock===null);
  }
  const last=data.plays.at(-1),coverage=data.coverage;
  if(home!==game.home_score||away!==game.away_score||last.quarter<4||last.clock===null||(last.quarter===4&&last.clock!=="00:00")||last.description!=="END GAME"||usedDrives.size!==drives.size||coverage?.status!=="complete"||coverage.events!==data.plays.length||coverage.drives!==drives.size||coverage.scoring_events!==scoring||coverage.missing_clocks!==missing)fail();
  return data;
}

export function selectedPlays(data,{quarter="all",view="drives"}={}) {
  return data.plays.filter(p=>(quarter==="all"||String(p.quarter)===quarter)&&(view!=="scoring"||p.scoring));
}

export function playSituation(play) {
  const down=play.down===null?null:`${["","1st","2nd","3rd","4th"][play.down]} & ${play.yards_to_go}`;
  return [down,play.yardline].filter(Boolean).join(" · ")||"Field position unavailable";
}
