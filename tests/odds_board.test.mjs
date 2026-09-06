import assert from "node:assert/strict";
import test from "node:test";

import { defaultWeek, filterOddsRows, flattenGames, formatAmerican, formatLine, formatPrice } from "../docs/odds-board.mjs";

const games = [{
  game_id: "2026_01_NE_SEA",
  week: 1,
  kickoff: "2026-09-10T00:20:00+00:00",
  away: "NE",
  home: "SEA",
  away_name: "New England Patriots",
  home_name: "Seattle Seahawks",
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
