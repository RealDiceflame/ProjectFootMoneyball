import assert from "node:assert/strict";
import test from "node:test";

import {
  comparisonColumns,
  defaultWeek,
  filterOddsGames,
  filterOddsRows,
  flattenGames,
  formatAmerican,
  formatLine,
  formatMarketVolume,
  formatPrice,
  formatProbability,
  formatWeather,
  groupMarketRows,
} from "../docs/odds-board.mjs";

const games = [{
  game_id: "2026_01_NE_SEA",
  week: 1,
  kickoff: "2026-09-10T00:20:00+00:00",
  away: "NE",
  home: "SEA",
  away_name: "New England Patriots",
  home_name: "Seattle Seahawks",
  stadium: "Lumen Field",
  roof: "outdoors",
  surface: "fieldturf",
  weather: { summary: "Mostly sunny", temperature: 68, wind_speed: "8 mph", wind_direction: "NW" },
  rows: [
    { provider: "DraftKings", provider_key: "draftkings", provider_kind: "sportsbook", market: "Spread", selection: "NE", line: 3.5, price: -110 },
    { provider: "Kalshi", provider_key: "kalshi", provider_kind: "exchange", market: "Moneyline", selection: "SEA", line: null, price: -170, contract_price: 63 },
  ],
}];

test("formats sportsbook lines and exchange contract prices", () => {
  assert.equal(formatAmerican(145), "+145");
  assert.equal(formatAmerican(-110), "-110");
  assert.equal(formatLine({ market: "Spread", line: 3.5 }), "+3.5");
  assert.equal(formatPrice(games[0].rows[1]), "63¢ (≈ -170)");
});

test("flattens games and filters by week, market, provider, and search", () => {
  const rows = flattenGames(games);
  assert.equal(rows[0].matchup, "NE @ SEA");
  assert.equal(filterOddsRows(rows, { week: 1, market: "Spread", provider: "ALL", search: "Patriots" }).length, 1);
  assert.equal(filterOddsRows(rows, { week: 1, market: "ALL", provider: "kalshi", search: "" }).length, 1);
  assert.equal(filterOddsRows(rows, { week: 2, market: "ALL", provider: "ALL", search: "" }).length, 0);
});

test("chooses the first upcoming week", () => {
  assert.equal(defaultWeek([4, 2, 3]), 2);
  assert.equal(defaultWeek([]), null);
});

test("filters complete game blocks while preserving matching lines", () => {
  assert.equal(filterOddsGames(games, { week: 1, market: "ALL", provider: "ALL", search: "Lumen" }).length, 1);
  const kalshi = filterOddsGames(games, { week: 1, market: "ALL", provider: "kalshi", search: "" });
  assert.equal(kalshi.length, 1);
  assert.deepEqual(kalshi[0].rows.map(row => row.provider_key), ["kalshi"]);
  assert.equal(filterOddsGames(games, { week: 1, market: "Total", provider: "ALL", search: "" }).length, 0);
});

test("formats kickoff weather as a compact game detail", () => {
  assert.equal(formatWeather(games[0].weather), "Mostly sunny · 68°F · Wind NW 8 mph");
  assert.equal(formatWeather({ summary: "Indoor venue", temperature: null }), "Indoor venue");
  assert.equal(formatWeather(null), "Weather pending");
});

test("groups each provider into horizontal away and home comparison cells", () => {
  const moneylineRows = [
    { provider: "DraftKings", provider_key: "draftkings", provider_kind: "sportsbook", market: "Moneyline", selection: "SEA", price: -170 },
    { provider: "DraftKings", provider_key: "draftkings", provider_kind: "sportsbook", market: "Moneyline", selection: "NE", price: 150 },
    { provider: "Market consensus", provider_key: "nflverse", provider_kind: "reference", market: "Moneyline", selection: "SEA", price: -180 },
  ];
  const grouped = groupMarketRows(games[0], "Moneyline", moneylineRows);
  assert.deepEqual(grouped.columns, comparisonColumns(games[0], "Moneyline"));
  assert.deepEqual(grouped.columns.map(column => column.selection), ["NE", "SEA"]);
  assert.equal(grouped.providers[0].provider, "DraftKings");
  assert.equal(grouped.providers[0].cells.NE.price, 150);
  assert.equal(grouped.providers[0].cells.SEA.price, -170);
  assert.equal(grouped.providers[1].cells.NE, null);
});

test("formats prediction-market probabilities and volume", () => {
  assert.equal(formatProbability(0.647), "65%");
  assert.equal(formatProbability(0.0035), "0.4%");
  assert.equal(formatMarketVolume(415785), "$415.8K volume");
});

test("missing provider numbers stay unavailable instead of becoming zero", () => {
  for (const value of [null, undefined, "", "  ", false, true, NaN, Infinity, "-"]) {
    assert.equal(formatAmerican(value), "—");
    assert.equal(formatProbability(value), "—");
    assert.equal(formatLine({market: "Spread", line: value}), "—");
    assert.equal(formatPrice({provider_kind: "exchange", contract_price: value, price: -110}), "-110");
    assert.equal(formatWeather({summary: "Cloudy", temperature: value}), "Cloudy");
  }
  assert.equal(formatPrice({provider_kind: "exchange", contract_price: null, price: null}), "—");
  assert.equal(formatProbability(0), "0%");
  assert.equal(formatProbability("0.25"), "25%");
  assert.equal(formatAmerican("145"), "+145");
  assert.equal(formatLine({market: "Spread", line: 0}), "0");
  assert.equal(formatPrice({provider_kind: "exchange", contract_price: 0, price: null}), "0¢ (≈ —)");
  assert.equal(formatWeather({summary: "Cold", temperature: "0"}), "Cold · 0°F");
});

test("week selection ignores absent values and invalid week numbers", () => {
  assert.equal(defaultWeek([null, undefined, "", " ", false, true, NaN, Infinity, -1, 0, 1.5, "3", 5]), 3);
  assert.equal(defaultWeek([null, "", 0]), null);
});
