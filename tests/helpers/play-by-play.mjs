export const gameId="2025_01_DAL_PHI";
export function playFixture() {
  const p={play_id:101,order:1,quarter:1,clock:"15:00",drive:1,possession_team:null,defense_team:null,
    down:null,yards_to_go:0,yardline:null,yards_to_goal:null,yards_gained:null,description:"GAME",play_type:null,
    home_score:0,away_score:0,scoring:false,penalty:null,touchdown:null,safety:null,players:[]};
  return {schema_version:1,season:2025,season_type:"REG",game_id:gameId,
    game:{game_id:gameId,week:1,away:"DAL",home:"PHI",away_score:6,home_score:0},
    updated_at:"2026-10-30T23:00:00Z",coverage:{status:"complete",events:4,drives:1,scoring_events:1,missing_clocks:1},
    drives:[{drive:1,start_team:"DAL",result:"Touchdown"}],plays:[p,
      {...p,play_id:90,order:2,clock:null,description:"Penalty: QA <img src=x onerror=alert(1)>",possession_team:"DAL",defense_team:"PHI",play_type:"no_play",penalty:1,yards_gained:0},
      {...p,play_id:80,order:3,quarter:2,clock:"14:00",description:"A runner scores.",possession_team:"DAL",defense_team:"PHI",play_type:"run",down:2,yards_to_go:3,yardline:"PHI 3",yards_to_goal:3,yards_gained:3,away_score:6,scoring:true,touchdown:1,penalty:0,players:[{role:"rusher",player_id:"00-0036997",name:"J.Williams"}]},
      {...p,play_id:110,order:4,quarter:4,clock:"00:00",description:"END GAME",away_score:6}]};
}
