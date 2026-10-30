// Synthetic historical fixtures; never published as real NFL observations.
export function historicalStatsFixture() {
  const season=2016, game_id="2016_01_OAK_SD", updated_at="2020-01-01T12:00:00Z";
  const game={game_id,week:1,away:"OAK",home:"SD",kickoff:"2016-09-11T17:00:00Z",away_score:35,home_score:34,stats_available:true};
  const team_columns=["game_id","season","season_type","team","passing_yards","rushing_yards","def_sacks"];
  const player_columns=["game_id","season","season_type","team","player_id","player_display_name","position","passing_yards","passing_tds","passing_interceptions","def_sacks"];
  const bundle={schema_version:1,season,season_type:"REG",historical:true,updated_at,game,
    team_columns,teams:[[game_id,season,"REG","OAK",400,80,0.5],[game_id,season,"REG","SD",300,100,1]],
    player_columns,players:[[game_id,season,"REG","OAK","00-0000001","Archive Quarterback","QB",400,0,null,0.5]]};
  const metrics=[{key:"passing_yards",label:"Passing yards",group:"Passing"}];
  const period=()=>({game_count:1,game_ids:[game_id],leaders:{passing_yards:[
    {player_id:"00-0000001",player:"Archive Quarterback",position:"QB",teams:["OAK"],value:400,rank:1},
  ]}});
  const summary={schema_version:1,season,season_type:"REG",historical:true,checked_at:updated_at,
    games:[game],metrics,periods:{all:period(),1:period()}};
  return {bundle,summary};
}
