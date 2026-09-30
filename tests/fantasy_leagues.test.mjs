import test from "node:test";
import assert from "node:assert/strict";
import {existsSync, readFileSync, readdirSync} from "node:fs";
import {DEFAULT_ROSTER, TEAM_COUNTS, createLeague, updateLeague, validateLeague, validateStore, emptyStore, parseBackup, importCopies, rosterSummary} from "../archive/fantasy-platform-prototype/web/fantasy-leagues.mjs";

const settings = {name: "Sunday league", season: 2026, team_count: 12, scoring: {ppr: 0.5, te_premium: 0.5, passing_td: 4}, roster: {...DEFAULT_ROSTER}};
let sequence = 0;
const options = {id: () => `test-${++sequence}`, now: "2026-09-13T12:00:00Z"};
const make = () => createLeague(structuredClone(settings), options);

test("create each supported league size with unique teams and stable settings", () => {
  for (const count of TEAM_COUNTS) {
    const league = createLeague({...settings, team_count: count}, options);
    assert.equal(league.teams.length, count);
    assert.equal(new Set(league.teams.map(team => team.id)).size, count);
    assert.equal(league.teams.at(-1).name, `Team ${count}`);
    assert.equal(league.provider, "outlierbaseline"); assert.equal(league.status, "setup");
    assert.deepEqual(league.scoring, settings.scoring);
    assert.deepEqual(validateLeague(league), league);
  }
});

test("edits preserve identity, creation date and team IDs without mutating the source", () => {
  const league = make(), original = structuredClone(league);
  const edited = updateLeague(league, {...settings, name: "New name", teams: league.teams.map((team, i) => ({...team, name: `New ${i}`}))}, "2026-09-14T12:00:00Z");
  assert.equal(edited.id, league.id); assert.equal(edited.created_at, league.created_at);
  assert.notEqual(edited.updated_at, league.updated_at);
  assert.deepEqual(edited.teams.map(team => team.id), league.teams.map(team => team.id));
  assert.deepEqual(league, original);
  assert.throws(() => updateLeague(league, {...settings, team_count: 8}), /team count/);
});

test("invalid scoring, counts, slot limits, names, identities and partial objects fail", () => {
  const invalid = [
    league => { league.team_count = 11; }, league => { league.scoring.ppr = 2; },
    league => { league.roster.QB = 0; }, league => { league.roster.BN = -1; },
    league => { league.roster.FLEX = 1.5; }, league => { league.roster.TE = "1"; },
    league => { league.scoring.te_premium = null; }, league => { league.name = " "; },
    league => { league.season = 2101; }, league => { league.teams.pop(); },
    league => { league.teams[1].name = " team 1 "; }, league => { league.teams[1].id = league.teams[0].id; },
    league => { league.id = "../../file"; }, league => { league.provider = "sleeper"; },
    league => { league.status = "active"; }, league => { league.created_at = "bad date"; },
  ];
  for (const mutate of invalid) { const league = make(); mutate(league); assert.throws(() => validateLeague(league)); }
  for (const value of [null, {}, {provider: "outlierbaseline", status: "setup"}]) assert.throws(() => validateLeague(value));
});

test("backups round-trip; copies never overwrite or share identities", () => {
  const league = make(), store = {...emptyStore(), leagues: [league]};
  const imported = importCopies(store, parseBackup(JSON.stringify(store)), options);
  assert.equal(imported.leagues.length, 2); assert.deepEqual(imported.leagues[0], league);
  assert.notEqual(imported.leagues[1].id, league.id);
  assert.equal(imported.leagues[1].name, "Sunday league (copy)");
  const originalIds = new Set(league.teams.map(team => team.id));
  assert.ok(imported.leagues[1].teams.every(team => !originalIds.has(team.id)));
  assert.equal(store.leagues.length, 1);
});

test("unsupported or oversized backups cannot silently replace saved setups", () => {
  assert.throws(() => parseBackup("{"), /valid JSON/);
  assert.throws(() => parseBackup("x".repeat(1024 * 1024 + 1)), /1 MB/);
  assert.throws(() => parseBackup(JSON.stringify({...emptyStore(), schema_version: 2})), /version 1/);
  const league = make();
  assert.throws(() => validateStore({...emptyStore(), leagues: [league, league]}), /unique/);
  const full = {...emptyStore(), leagues: Array.from({length: 30}, make)};
  assert.equal(validateStore(full).leagues.length, 30);
  assert.throws(() => importCopies(full, {...emptyStore(), leagues: [make()]}, options), /30/);
});

test("roster totals exclude bench and IR from starters; unknown properties are not imported", () => {
  assert.deepEqual(rosterSummary(DEFAULT_ROSTER), {starters: 9, bench: 6, reserve: 1, total: 16});
  const league = make();
  assert.equal(validateLeague({...league, token: "must-not-persist"}).token, undefined);
  assert.equal(validateLeague({...league, scoring: {...league.scoring, unknown: 123}}).scoring.unknown, undefined);
});

test("all public site pages use the same cache-busted navigation without prototype links", () => {
  const root = new URL("../docs/", import.meta.url);
  const pages = readdirSync(root).filter(name => name.endsWith(".html"));
  assert.equal(pages.length, 10);
  for (const page of pages) {
    const html = readFileSync(new URL(page, root), "utf8");
    assert.match(html, /site-nav.js\?v=20260930-no-leagues1/); assert.match(html, /site-nav.css\?v=20260928-layout1/);
    assert.doesNotMatch(html, /(?:href|src)\s*=\s*["'][^"']*(?:fantasy\.(?:html|js|css)|fantasy-leagues\.mjs)/i, page);
    assert.doesNotMatch(html, /My leagues|Your league starts here|Try a local league setup/i, page);
  }
  const navigation = readFileSync(new URL("site-nav.js", root), "utf8");
  assert.doesNotMatch(navigation, /fantasy\.html|My leagues/i);
  for (const file of ["fantasy.html", "fantasy.js", "fantasy.css", "fantasy-leagues.mjs"]) {
    assert.equal(existsSync(new URL(file, root)), false, `${file} must stay outside the published docs tree`);
    assert.equal(existsSync(new URL(`../archive/fantasy-platform-prototype/web/${file}`, import.meta.url)), true, `${file} remains archived`);
  }
});

test("the archived prototype retains its explicit limitations and unique element IDs", () => {
  const html = readFileSync(new URL("../archive/fantasy-platform-prototype/web/fantasy.html", import.meta.url), "utf8");
  assert.match(html, /Browser-only prototype/); assert.match(html, /not playable, shared leagues/);
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
});
