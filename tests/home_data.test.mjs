import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {injuryFeed, filterInjuries, safeSourceUrl, snapshotFreshness, safePlayerPhoto, titlePlayers, leagueHeadlineCards} from "../docs/home-data.mjs";
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

const portraitUrl = "https://static.www.nfl.com/image/upload/f_auto,q_auto,w_160,c_fill,g_face/league/example";
const namedReport = (player, status = "Questionable") => ({...report(player, status), headline_name_ambiguous: false, headshot_url: portraitUrl});
const newsBundle = (...players) => ({reports: Object.fromEntries(players.map((player, index) => [index, player]))});

test("preview title matches full names, punctuation, suffixes and multiple players without URL or substring guesses", () => {
  const bundle = newsBundle(namedReport("Lamar Jackson"), namedReport("Derrick Henry"), namedReport("Will Levis"),
    namedReport("A.J. Brown"), namedReport("Brian Thomas Jr."), namedReport("D'Andre Swift"));
  assert.deepEqual(titlePlayers(bundle, "Lamar Jackson’s pass sets up Derrick Henry").map(row => row.player), ["Lamar Jackson", "Derrick Henry"]);
  for (const title of ["Jackson throws a touchdown", "Will Levison scores", "QB scores a touchdown"]) assert.deepEqual(titlePlayers(bundle, title), []);
  for (const title of ["AJ Brown scores", "Brian Thomas runs free", "D’Andre Swift’s touchdown"]) assert.equal(titlePlayers(bundle, title).length, 1, title);
  const preview = titlePlayers(bundle, "Lamar Jackson scores")[0];
  assert.equal(preview.team, "KC"); assert.equal(preview.photoUrl, portraitUrl);
  assert.equal(preview.injury.status, "Questionable"); assert.equal(preview.injury.risk, false);
  assert.equal(preview.injury.reportLabel, "Week 1");
});

test("preview matching fails closed on full-roster ambiguity, duplicate identities and older snapshots", () => {
  const player = namedReport("DeVonta Smith");
  assert.deepEqual(titlePlayers(newsBundle({...player, headline_name_ambiguous: true}), "DeVonta Smith signs"), []);
  assert.deepEqual(titlePlayers(newsBundle({...player, headline_name_ambiguous: undefined}), "DeVonta Smith signs"), []);
  assert.deepEqual(titlePlayers(newsBundle(player, {...player, player: "Devonta Smith", player_id: "defender", pos: "DB"}), "DeVonta Smith signs"), []);
  assert.deepEqual(titlePlayers(newsBundle({...player, player_id: null}), "DeVonta Smith signs"), []);
  assert.equal(titlePlayers(newsBundle(player, player), "DeVonta Smith signs").length, 1);
  assert.deepEqual(titlePlayers(null, "DeVonta Smith signs"), []);
  const unknown = titlePlayers(newsBundle({...player, injury: null}), "DeVonta Smith scores")[0];
  assert.equal(unknown.injury, null);
});

test("portraits permit only the roster image host and preserve safe injury sources", () => {
  assert.equal(safePlayerPhoto(portraitUrl), portraitUrl);
  for (const url of ["http://static.www.nfl.com/photo", "https://static.www.nfl.com.evil.test/photo", "https://evil.test/photo", "data:image/svg+xml,x", "https://user@static.www.nfl.com/photo", null]) assert.equal(safePlayerPhoto(url), null);
  assert.equal(injuryFeed(newsBundle(namedReport("Lamar Jackson")))[0].photoUrl, portraitUrl);
});

test("league previews keep unmatched stories while photos still require names in titles", () => {
  const article = {category: "Recent news", date: "2026-09-13", title: "Lamar Jackson and Derrick Henry practice", source: {url: "https://www.espn.com/nfl/story/_/id/123/original-story"}};
  const player = {...namedReport("Lamar Jackson"), events: [article, article,
    {...article, title: "QB practices", source: {url: "https://www.espn.com/nfl/lamar-jackson"}},
    {...article, date: "2026-08-01", source: {url: "https://www.espn.com/nfl/old"}},
    {...article, date: "2027-01-01", source: {url: "https://www.espn.com/nfl/future"}},
    {...article, source: {url: "https://evil.test/article"}},
    {...article, source: {url: "javascript:alert(1)"}}, null]};
  const cards = leagueHeadlineCards(newsBundle(player, namedReport("Derrick Henry")), Date.parse("2026-09-13T18:00:00Z"));
  assert.equal(cards.length, 2); assert.equal(cards[0].url, article.source.url);
  assert.equal(cards[0].players.length, 2);
  assert.equal(cards[1].title, "QB practices"); assert.equal(cards[1].players.length, 0);
  assert.deepEqual(leagueHeadlineCards(null), []);
});

test("full league feed sorts by publication time, supports unknown dates and caps the scrollable list", () => {
  const item = (index, published_at = "2026-09-13T15:00:00Z") => ({title: `League story ${index}`, url: `https://www.espn.com/nfl/story/${index}`, published_at});
  const items = [item(0), item(1, "2026-09-13T16:00:00Z"), item(2, null), item(0), null];
  const cards = leagueHeadlineCards({league_news: {items}}, Date.parse("2026-09-13T18:00:00Z"));
  assert.deepEqual(cards.map(card => card.title), ["League story 1", "League story 0", "League story 2"]);
  assert.ok(cards.every(card => card.players.length === 0)); assert.equal(cards[2].timestamp, null);
  assert.equal(leagueHeadlineCards({league_news: {items: Array.from({length: 60}, (_, i) => item(i))}}, Date.parse("2026-09-13T18:00:00Z")).length, 50);
  assert.deepEqual(leagueHeadlineCards({league_news: {items: []}, reports: {p: {events: [{category: "Recent news", title: "Old fallback", source: {url: "https://www.espn.com/nfl/story/old"}}]}}}), []);
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
  const sourceSummary = js.slice(js.indexOf("function playerSummary("), js.indexOf("function renderSourcePlayers("));
  assert.match(sourceSummary, /portrait\(player\)/);
  assert.doesNotMatch(sourceSummary, /injury|RISK|home-badge/i);
  assert.match(js.slice(js.indexOf("function renderInjuries(")), /injuryDetails\(body, row\)/);
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const [, id] of js.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.includes(id), id);
  assert.doesNotMatch(html, /manually curated|selected-source-cards|recent-headline-list/);
  assert.match(html, /id="league-news-list"[^>]+tabindex="0"[^>]+role="region"/);
  const css = readFileSync(new URL("../docs/home.css", import.meta.url), "utf8");
  assert.match(css, /\.home-news-scroll\s*\{[^}]*max-height:[^}]*overflow-y: auto/);
  const updates = html.indexOf('aria-labelledby="updates-heading"');
  assert.ok(updates > html.indexOf('aria-labelledby="explore-heading"'));
  assert.ok(updates > html.indexOf('aria-labelledby="highlights-heading"'));
  assert.ok(updates < html.indexOf("</main>"));
  assert.equal(html.slice(updates, html.indexOf("</main>")).match(/<section\b/g), null, "Product updates are the final homepage section");
  assert.doesNotMatch(html, /<script[^>]+src="https:\/\/platform\.x/);
  assert.doesNotMatch(html, /id="load-x-feed"/);
  assert.match(html, /feed loads automatically below/);
  assert.match(js, /loadXFeed\(\);/);
  const rankings = readFileSync(new URL("../docs/rankings.html", import.meta.url), "utf8");
  assert.match(rankings, /id="board-heading"/); assert.match(rankings, /src="app.js/);
});
