import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {scoreboardGames, defaultScoreWeek, scoreDisplay, scoreboardStale} from "../docs/scores-data.mjs";
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
test("week choice retains the NFL week through Monday and switches two days before the next kickoff", () => {
  const next = {...game,game_id:"next",week:2,gameday:"2026-09-17",kickoff:"2026-09-18T00:15:00Z"};
  assert.equal(defaultScoreWeek([game,next],now),1);
  assert.equal(defaultScoreWeek([game,next],Date.parse("2026-09-15T00:00:00Z")),1);
  assert.equal(defaultScoreWeek([game,next],Date.parse("2026-09-16T00:15:00Z")),2);
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
