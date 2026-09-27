import test from "node:test";
import assert from "node:assert/strict";
import {classifyInjury} from "../docs/injury-status.mjs";
import {injuryFeed, filterInjuries, titlePlayers} from "../docs/home-data.mjs";

const now = Date.parse("2026-09-27T15:00:00Z");
const report = (season = 2026, week = 3, status = "Out") => ({player: "Example Runner", player_id: "1", team: "BUF", pos: "RB",
  headline_name_ambiguous: false, injury: {season, week, name: "Knee", status, report_status: status}, events: []});
const bundle = {season: 2026, generated_at: "2026-09-27T12:00:00Z", injury_context: {season: 2026, expected_week: 3,
  valid_from: "2026-09-22T04:00:00Z", valid_until: "2026-09-29T04:00:00Z", teams: ["BUF", "KC"], status: "current"}};

test("only this season's expected report week can carry a current risk", () => {
  for (const [season, week, state] of [[2025, 18, "historical"], [2026, 2, "historical"], [2026, 4, "future"], [2027, 1, "future"]]) {
    const result = classifyInjury(report(season, week), bundle, now);
    assert.equal(result.state, state); assert.equal(result.currentInjury, null); assert.equal(result.risk, false);
    assert.equal(result.healthStatus, "unknown"); assert.match(result.label, /Current health unknown/);
    assert.equal(result.reportLabel, `${season} · Week ${week}`);
  }
  const result = classifyInjury(report(), bundle, now);
  assert.equal(result.current, true); assert.equal(result.risk, true); assert.equal(result.healthStatus, "reported");
});

test("Questionable, Probable and practice-only reports never become Risk", () => {
  for (const status of ["Questionable", "Probable", "Limited Participation", "Full Participation", ""]) {
    const result = classifyInjury(report(2026, 3, status), bundle, now);
    assert.equal(result.current, true); assert.equal(result.risk, false); assert.equal(result.currentInjury.severity, "watch");
  }
});

test("schedule week expires at its boundary and old snapshots cannot recertify a report", () => {
  assert.equal(classifyInjury(report(), bundle, Date.parse("2026-09-29T03:59:59Z")).current, true);
  assert.equal(classifyInjury(report(), bundle, Date.parse("2026-09-29T04:00:00Z")).current, false);
  assert.equal(classifyInjury(report(), bundle, Date.parse("2026-09-22T03:59:59Z")).current, false);
  assert.equal(classifyInjury(report(), {...bundle, generated_at: "2026-09-20T14:59:59Z"}, now).current, false);
  assert.equal(classifyInjury(report(), {...bundle, generated_at: "2026-09-28T00:00:00Z"}, now).current, false);
  assert.equal(classifyInjury({...report(), team: "NYJ"}, bundle, now).current, false, "A bye team does not keep an old report current");
});

test("older formats are safe without metadata and accept independent expected-week context", () => {
  const old = report(); delete old.injury.season;
  const saved = {season: 2026, generated_at: bundle.generated_at};
  assert.equal(classifyInjury(old, saved, now).current, false);
  assert.equal(classifyInjury(old, {...saved, expectedWeek: 3}, now).current, true);
  assert.equal(classifyInjury(old, {season: 2026, generatedAt: bundle.generated_at, expectedWeek: 3}, now).current, true);
  assert.equal(classifyInjury(old, {season: 2026, expectedWeek: 3}, now).current, false);
  assert.equal(classifyInjury(old, {...saved, expectedWeek: 4}, now).state, "historical");
  assert.equal(classifyInjury(report(), {...bundle, generated_at: null}, now).risk, false);
});

test("missing or incomplete source coverage stays unknown and retained reports remain history", () => {
  assert.equal(classifyInjury({injury: null}, bundle, now).healthStatus, "unknown");
  assert.equal(classifyInjury({injury: []}, bundle, now).current, false);
  for (const status of ["behind", "unavailable"]) {
    assert.equal(classifyInjury(report(), {...bundle, injury_context: {...bundle.injury_context, status}}, now).current, false);
  }
  assert.equal(classifyInjury({...report(), injury: {...report().injury, carried_forward: true}}, bundle, now).risk, false);
});

test("homepage preserves historical reports but excludes their badges and Risk filter", () => {
  const historical = report(2026, 2), current = {...report(), player: "Current Runner", player_id: "2"};
  const saved = {...bundle, reports: {historical, current}};
  const rows = injuryFeed(saved, now);
  assert.equal(rows.length, 2); assert.equal(rows[0].player, "Current Runner");
  assert.equal(rows[1].freshness, "historical"); assert.match(rows[1].currentnessLabel, /Current health unknown/);
  assert.equal(filterInjuries(rows, "", "risk").length, 1);
  assert.equal(titlePlayers(saved, "Example Runner practices", now)[0].injury, null);
});
