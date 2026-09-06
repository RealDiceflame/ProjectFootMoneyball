import {
  defaultWeek,
  filterOddsGames,
  flattenGames,
  formatLine,
  formatPrice,
  formatWeather,
} from "./odds-board.mjs?v=20260906-odds2";

const DATA_URL = "./data/nfl_odds.json";
const MARKET_ORDER = ["Moneyline", "Spread", "Total"];

const ui = {
  status: document.querySelector("#odds-status"),
  summary: document.querySelector("#odds-summary"),
  week: document.querySelector("#odds-week"),
  provider: document.querySelector("#odds-provider"),
  search: document.querySelector("#odds-search"),
  markets: document.querySelector("#odds-markets"),
  clear: document.querySelector("#odds-clear"),
  games: document.querySelector("#odds-games"),
  loading: document.querySelector("#odds-loading"),
  empty: document.querySelector("#odds-empty"),
  shell: document.querySelector("#odds-games-shell"),
  connection: document.querySelector("#sportsbook-connection"),
};

const state = { payload: null, rows: [], week: null, market: "ALL", provider: "ALL", search: "" };

function formatKickoff(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time to be announced";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function providerKind(row) {
  return { sportsbook: "Sportsbook", exchange: "Exchange", reference: "Consensus" }[row.provider_kind] || "Source";
}

function selectionName(game, row) {
  if (row.selection === game.away) return game.away_name;
  if (row.selection === game.home) return game.home_name;
  return row.selection;
}

function detail(label, value, className = "") {
  const item = document.createElement("div");
  item.className = `odds-game-detail ${className}`.trim();
  const title = document.createElement("span");
  title.textContent = label;
  const text = document.createElement("strong");
  text.textContent = value;
  item.append(title, text);
  return item;
}

function renderOffer(game, row) {
  const offer = document.createElement("div");
  offer.className = `odds-offer source-${row.provider_kind}${row.is_best ? " best-odds" : ""}`;

  const selection = document.createElement("strong");
  selection.className = "odds-offer-selection";
  selection.textContent = selectionName(game, row);

  const line = document.createElement("span");
  line.className = "odds-offer-line";
  line.textContent = row.market === "Moneyline" ? "Win" : formatLine(row);

  const price = document.createElement("strong");
  price.className = "odds-offer-price";
  price.textContent = formatPrice(row);

  const provider = document.createElement("a");
  provider.className = "odds-offer-provider";
  provider.href = row.provider_url;
  provider.target = "_blank";
  provider.rel = "noopener noreferrer";
  provider.textContent = row.provider;
  provider.title = `${providerKind(row)} — open source`;

  offer.append(selection, line, price, provider);
  if (row.is_best) {
    const badge = document.createElement("span");
    badge.className = "best-badge";
    badge.textContent = "Best";
    offer.append(badge);
  }
  return offer;
}

function renderMarket(game, market, rows) {
  const section = document.createElement("section");
  section.className = "odds-market-block";
  const heading = document.createElement("h3");
  heading.textContent = market;
  const offers = document.createElement("div");
  offers.className = "odds-offers";
  rows
    .sort((left, right) => Number(right.is_best) - Number(left.is_best) || left.selection.localeCompare(right.selection) || left.provider.localeCompare(right.provider))
    .forEach(row => offers.append(renderOffer(game, row)));
  section.append(heading, offers);
  return section;
}

function renderGame(game) {
  const card = document.createElement("article");
  card.className = "odds-game-card";

  const header = document.createElement("header");
  header.className = "odds-game-header";
  const matchup = document.createElement("div");
  const code = document.createElement("p");
  code.className = "eyebrow";
  code.textContent = `${game.away} @ ${game.home}`;
  const title = document.createElement("h2");
  title.textContent = `${game.away_name} at ${game.home_name}`;
  matchup.append(code, title);
  const week = document.createElement("span");
  week.className = "odds-week-badge";
  week.textContent = `Week ${game.week}`;
  header.append(matchup, week);

  const metadata = document.createElement("div");
  metadata.className = "odds-game-details";
  metadata.append(
    detail("Kickoff", formatKickoff(game.kickoff)),
    detail("Stadium", game.stadium || "Venue to be announced"),
    detail("Field", [game.surface, game.roof].filter(Boolean).join(" · ") || "Details pending"),
  );
  const weather = detail("Weather", formatWeather(game.weather), `weather-${game.weather?.status || "pending"}`);
  if (game.weather?.source_url) {
    const value = weather.querySelector("strong");
    const link = document.createElement("a");
    link.href = game.weather.source_url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = value.textContent;
    value.replaceWith(link);
  }
  metadata.append(weather);

  const markets = document.createElement("div");
  markets.className = "odds-market-grid";
  const grouped = new Map(MARKET_ORDER.map(market => [market, []]));
  game.rows.forEach(row => {
    if (!grouped.has(row.market)) grouped.set(row.market, []);
    grouped.get(row.market).push(row);
  });
  [...grouped.entries()].filter(([, rows]) => rows.length).forEach(([market, rows]) => markets.append(renderMarket(game, market, rows)));
  if (!markets.children.length) {
    const pending = document.createElement("p");
    pending.className = "odds-lines-pending";
    pending.textContent = "Lines have not been posted for this matchup yet.";
    markets.append(pending);
  }

  card.append(header, metadata, markets);
  return card;
}

function currentGames() {
  return filterOddsGames(state.payload?.games, state)
    .sort((left, right) => String(left.kickoff).localeCompare(String(right.kickoff)) || left.game_id.localeCompare(right.game_id));
}

function render() {
  const games = currentGames();
  const fragment = document.createDocumentFragment();
  games.forEach(game => fragment.append(renderGame(game)));
  ui.games.replaceChildren(fragment);
  const rows = games.flatMap(game => game.rows);
  const providers = new Set(rows.map(row => row.provider_key)).size;
  ui.summary.textContent = `${games.length} games · ${rows.length} available lines · ${providers} sources`;
  ui.empty.classList.toggle("hidden", games.length !== 0);
}

function populateControls() {
  ui.week.replaceChildren(...state.payload.weeks.map(week => new Option(`Week ${week}`, String(week))));
  if (state.week !== null) ui.week.value = String(state.week);
  const providers = [...new Map(state.rows.map(row => [row.provider_key, row.provider])).entries()]
    .sort((left, right) => left[1].localeCompare(right[1]));
  ui.provider.replaceChildren(new Option("All sources", "ALL"), ...providers.map(([key, name]) => new Option(name, key)));
}

function clearFilters() {
  state.market = "ALL";
  state.provider = "ALL";
  state.search = "";
  ui.provider.value = "ALL";
  ui.search.value = "";
  ui.markets.querySelectorAll("[data-market]").forEach(button => button.classList.toggle("active", button.dataset.market === "ALL"));
  render();
}

async function load() {
  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`Odds request failed (${response.status})`);
    state.payload = await response.json();
    state.rows = flattenGames(state.payload.games);
    state.week = defaultWeek(state.payload.weeks);
    populateControls();
    render();
    const generated = new Date(state.payload.generated_at);
    ui.status.textContent = Number.isNaN(generated.getTime())
      ? "Weekly markets loaded"
      : `Updated ${generated.toLocaleString()}`;
    ui.connection.classList.toggle("connected", state.payload.has_sportsbooks);
    ui.connection.querySelector("strong").textContent = state.payload.has_sportsbooks
      ? "Live sportsbook comparison connected"
      : "Sportsbook comparison awaiting a licensed feed";
    ui.connection.querySelector("div > span").textContent = state.payload.has_sportsbooks
      ? "Best-line badges compare the licensed sportsbook prices currently available."
      : "The schedule, consensus reference, and public Kalshi contracts are live. Direct sportsbook pages are not scraped.";
    ui.loading.classList.add("hidden");
    ui.shell.setAttribute("aria-busy", "false");
  } catch (error) {
    ui.connection.classList.remove("connected");
    ui.connection.querySelector("strong").textContent = "Weekly data could not load";
    ui.connection.querySelector("div > span").textContent = "Refresh once to retry the saved site data. No sportsbook API is called from this page.";
    ui.loading.innerHTML = `<strong>Could not load weekly odds.</strong><span>${error.message}</span>`;
  }
}

ui.week.addEventListener("change", event => { state.week = Number(event.target.value); render(); });
ui.provider.addEventListener("change", event => { state.provider = event.target.value; render(); });
ui.search.addEventListener("input", event => { state.search = event.target.value; render(); });
ui.markets.addEventListener("click", event => {
  const button = event.target.closest("[data-market]");
  if (!button) return;
  state.market = button.dataset.market;
  ui.markets.querySelectorAll("[data-market]").forEach(item => item.classList.toggle("active", item === button));
  render();
});
ui.clear.addEventListener("click", clearFilters);

load();
