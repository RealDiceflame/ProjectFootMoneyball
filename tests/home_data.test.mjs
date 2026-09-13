import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {injuryFeed, filterInjuries, safeSourceUrl, snapshotFreshness} from "../docs/home-data.mjs";
import {freshSeed, validSeed, MAX_SEED, exampleTrialIndices} from "../docs/simulation-runs.mjs";

const report = (player, status, week = 1) => ({
  player, player_id: player, pos: "RB", team: "BUF", current_team: "KC",
  injury: {name: "Knee", report_status: status, practice_status: "Limited", week},
  events: [null, {category: "Injury", source: {url: "https://www.espn.com/nfl/team/injuries/_/name/kc"}}],
});
test("injury feed preserves all statuses, current team and report week without overstating risk", () => {
  const reports = ["Questionable", "Probable", "Full Participation in Practice", "Out", "Doubtful", "IR", " Injured Reserve "].map((status, i) => report(String(i), status));
  const rows = injuryFeed({reports: Object.fromEntries(reports.map((r, i) => [i, r]))});
  assert.equal(rows.length, 7); assert.equal(rows.filter(row => row.risk).length, 4);
  assert.ok(rows.every(row => row.team === "KC" && row.reportLabel === "Week 1"));
  assert.equal(filterInjuries(rows, "", "risk").length, 4);
  assert.equal(filterInjuries(rows, " questionable ").length, 1);
  assert.equal(filterInjuries(rows, "knee").length, 7);
  assert.equal(filterInjuries(rows, "BUF").length, 0);
});
test("injuries deduplicate by stable identity and position, sort by report week, and handle missing facts", () => {
  const a = report("Same Name", "Out", 1), b = {...report("Same Name", "Questionable", 2), player_id: "other"};
  const rows = injuryFeed({reports: {a, duplicate: a, b, c: {...a, pos: "QB"}, bad: {player: "Bad", injury: "not an object"}, empty: null}});
  assert.equal(rows.length, 3); assert.equal(rows[0].playerId, "other"); assert.equal(rows[0].week, 2);
  const missing = injuryFeed({reports: {m: {player: "Unknown", injury: {}}}})[0];
  assert.equal(missing.risk, false); assert.equal(missing.url, null);
  assert.equal(missing.reportLabel, "Report week unavailable");
  assert.equal(missing.injury, "Injury details not supplied");
  assert.deepEqual(injuryFeed({reports: {}}), []);
  for (const invalid of [null, {}, {reports: []}, {reports: "bad"}]) assert.throws(() => injuryFeed(invalid), /unavailable/);
});
test("source links accept only HTTPS without embedded credentials", () => {
  assert.equal(safeSourceUrl("https://www.nfl.com/videos/"), "https://www.nfl.com/videos/");
  for (const unsafe of ["javascript:alert(1)", "data:text/html,x", "//x.com", "http://x.com", "https://user:secret@example.com", null, "not-a-url"]) assert.equal(safeSourceUrl(unsafe), null);
});
test("snapshot freshness distinguishes missing, future and overdue dates", () => {
  const now = Date.parse("2026-09-13T12:00:00Z");
  assert.equal(snapshotFreshness("2026-09-13T06:00:00Z", now).stale, false);
  assert.equal(snapshotFreshness("2026-09-12T18:00:00Z", now).stale, true);
  for (const value of ["bad", null, "2026-09-14T00:00:00Z"]) assert.deepEqual(snapshotFreshness(value, now), {label: "Snapshot time unavailable", stale: true});
});
test("fresh seeds are valid and avoid consecutive duplicates while fixed seeds remain explicit", () => {
  for (const word of [0, 1, MAX_SEED, 0xffffffff]) {
    const seed = freshSeed(undefined, () => word);
    assert.ok(validSeed(seed)); assert.notEqual(freshSeed(seed, () => word), seed);
  }
  for (const seed of [0, -1, 1.5, NaN, Infinity, MAX_SEED + 1, "2026"]) assert.equal(validSeed(seed), false);
  assert.equal(validSeed(2026), true);
  assert.throws(() => freshSeed(1, () => -1), /generation failed/);
});
test("example indices cover the full batch without extra random draws", () => {
  for (const trials of [1, 5, 100, 2000, 10000]) {
    const indices = exampleTrialIndices(trials);
    assert.equal(indices.length, Math.min(trials, 20)); assert.equal(indices[0], 0); assert.equal(indices.at(-1), trials - 1);
    assert.equal(new Set(indices).size, indices.length);
    assert.ok(indices.every(index => Number.isInteger(index) && index >= 0 && index < trials));
  }
  assert.throws(() => exampleTrialIndices(0)); assert.throws(() => exampleTrialIndices(5, 0));
});
test("homepage controls and rankings route are wired with unique identifiers", () => {
  const html = readFileSync(new URL("../docs/index.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../docs/home.js", import.meta.url), "utf8");
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const [, id] of js.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.includes(id), id);
  assert.match(html, /manually curated, not a live feed/);
  assert.doesNotMatch(html, /<script[^>]+src="https:\/\/platform\.x/);
  const rankings = readFileSync(new URL("../docs/rankings.html", import.meta.url), "utf8");
  assert.match(rankings, /id="board-heading"/); assert.match(rankings, /src="app.js/);
});
