import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {scoreboardGames, defaultScoreWeek, scoreDisplay, scoreboardStale, gameConditions} from "../docs/scores-data.mjs";
const game = {game_id:"2026_01_BUF_BAL",week:1,home:"BAL",away:"BUF",gameday:"2026-09-13",kickoff:"2026-09-13T17:00:00Z",home_score:0,away_score:14};
const now = Date.parse("2026-09-13T18:00:00Z");

test("reported scores preserve zero, never infer final/live, and leave missing or future scores blank", () => {
  assert.deepEqual(scoreDisplay(game, now), {label:"Reported score",home:"0",away:"14"});
  assert.deepEqual(scoreDisplay({...game, home_score:null}, now), {label:"Awaiting score",home:"—",away:"—"});
  assert.equal(scoreDisplay(game, now-2*3600000).label, "Scheduled");
  assert.equal(scoreDisplay(game, now-2*3600000).home, "—");
  for (const invalid of [-1, NaN, Infinity, 1.5, "0"]) assert.equal(scoreDisplay({...game,home_score:invalid},now).home,"—");
  assert.equal(scoreDisplay({...game,kickoff:null},now).label,"Time TBD");
});
test("week choice switches exactly one day before the next kickoff", () => {
  const next = {...game,game_id:"next",week:2,gameday:"2026-09-17",kickoff:"2026-09-18T00:15:00Z"};
  assert.equal(defaultScoreWeek([game,next],now),1);
  assert.equal(defaultScoreWeek([game,next],Date.parse("2026-09-15T00:00:00Z")),1);
  assert.equal(defaultScoreWeek([game,next],Date.parse("2026-09-16T00:15:00Z")),1);
  assert.equal(defaultScoreWeek([game,next],Date.parse("2026-09-17T00:14:59Z")),1);
  assert.equal(defaultScoreWeek([game,next],Date.parse("2026-09-17T00:15:00Z")),2);
  assert.equal(defaultScoreWeek([],now),null);
});
test("bad rows do not break the board and stale checks use game windows", () => {
  const bundle = {season:2026,checked_at:"2026-09-13T17:45:00Z",games:[game,game,null,{...game,game_id:"bad",home:"not-a-team"}]};
  assert.equal(scoreboardGames(bundle).length,1);
  assert.equal(scoreboardStale(bundle,now),false);
  assert.equal(scoreboardStale({...bundle,checked_at:"2026-09-13T16:00:00Z"},now),true);
  assert.equal(scoreboardStale({...bundle,checked_at:"2026-09-14T17:00:00Z"},now),true);
  assert.throws(()=>scoreboardGames({}),/unavailable/);
});
test("homepage uses the user's exact headline, compact footer and independent score module", () => {
  const html = readFileSync(new URL("../docs/index.html",import.meta.url),"utf8");
  assert.match(html, /Be an Outlier\.<br><em>Know your Baseline\.<\/em>/);
  assert.doesNotMatch(html, /Saved data ·|class="home-start"|class="home-intro"/);
  assert.match(html, /<footer data-compact="true">/);
  assert.match(html, /<summary>Sources &amp; privacy<\/summary>/);
  assert.match(html, /src="scores.js\?/);
  const js=readFileSync(new URL("../docs/scores.js",import.meta.url),"utf8");
  assert.match(js,/fetch\("data\/scores.json"/);
  assert.match(js,/document.hidden/);
  assert.doesNotMatch(js,/api[_-]?key|api\.the-odds-api|api\.espn/i);
  const data=JSON.parse(readFileSync(new URL("../docs/data/scores.json",import.meta.url),"utf8"));
  assert.equal(scoreboardGames(data).length,272);
});

test("all selected-week games wrap into rows without an inner scrolling region", () => {
  const css=readFileSync(new URL("../docs/home.css",import.meta.url),"utf8");
  const grid=css.match(/\.home-score-grid\s*\{([^}]+)\}/)[1];
  assert.match(grid,/grid-template-columns: repeat\(auto-fit/);
  assert.doesNotMatch(grid,/overflow|max-height|grid-auto-flow/);
  const html=readFileSync(new URL("../docs/index.html",import.meta.url),"utf8");
  assert.doesNotMatch(html,/scroll horizontally/);
});

test("venue and weather labels separate forecasts from reported game conditions", () => {
  const base={...game, city:"Baltimore, MD", stadium:"M&T Bank Stadium", roof:"outdoors"};
  assert.equal(gameConditions(base,now).location,"Baltimore, MD");
  assert.equal(gameConditions({...base,city:null},now).location,"M&T Bank Stadium");
  assert.equal(gameConditions(base,now).weather,"Game weather unavailable");
  assert.match(gameConditions({...base,weather:{status:"schedule",temperature:0,wind_speed:"0 mph"}},now).weather,/Reported game weather · 0°F · Wind 0 mph/);
  const forecast={status:"forecast",temperature:72,summary:"Sunny",checked_at:"2026-09-13T16:00:00Z"};
  assert.match(gameConditions({...base,weather:forecast},now).weather,/^Pre-game forecast/);
  assert.match(gameConditions({...base,weather:forecast},now-2*3600000).weather,/^Kickoff forecast/);
  assert.match(gameConditions({...base,kickoff:"2026-09-15T17:00:00Z",weather:forecast},now+86400000).weather,/^Earlier kickoff forecast/);
  assert.equal(gameConditions({...base,roof:"dome"},now).weather,"Indoors / roof closed");
  assert.equal(gameConditions({...base,roof:"dome",stadium_id:"LAX01"},now).weather,"Covered, open-sided stadium");
  assert.doesNotMatch(gameConditions({...base,roof:"retractable"},now).weather,/Indoors/);
});
