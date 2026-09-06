import {
  defaultWeek,
  filterOddsGames,
  flattenGames,
  formatMarketVolume,
  formatLine,
  formatPrice,
  formatProbability,
  formatWeather,
  groupMarketRows,
} from "./odds-board.mjs?v=20260906-odds3";

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
  predictionMarkets: document.querySelector("#prediction-markets"),
  predictionSummary: document.querySelector("#prediction-summary"),
  predictionEmpty: document.querySelector("#prediction-empty"),
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

function renderLineCell(market, row) {
  const cell = document.createElement("div");
  cell.className = `odds-line-cell source-${row?.provider_kind || "missing"}${row?.is_best ? " best-odds" : ""}`;
  if (!row) {
    cell.classList.add("odds-line-missing");
    cell.textContent = "—";
    return cell;
  }
  const line = document.createElement("strong");
  line.textContent = market === "Moneyline" ? formatPrice(row) : formatLine(row);
  const price = document.createElement("span");
  price.textContent = market === "Moneyline" ? "To win" : formatPrice(row);
  cell.append(line, price);
  if (row.is_best) {
    const badge = document.createElement("span");
    badge.className = "best-badge";
    badge.textContent = "Best";
    cell.append(badge);
  }
  return cell;
}

function renderMarket(game, market, rows) {
  const section = document.createElement("section");
  section.className = "odds-market-block";
  const heading = document.createElement("h3");
  heading.textContent = market;
  const scroll = document.createElement("div");
  scroll.className = "odds-comparison-scroll";
  const table = document.createElement("div");
  table.className = "odds-comparison-table";
  table.setAttribute("role", "table");
  table.setAttribute("aria-label", `${market} comparison`);
  const { columns, providers } = groupMarketRows(game, market, rows);

  const head = document.createElement("div");
  head.className = "odds-comparison-row odds-comparison-head";
  head.setAttribute("role", "row");
  ["Sportsbook / source", ...columns.map(column => column.label)].forEach(label => {
    const cell = document.createElement("span");
    cell.setAttribute("role", "columnheader");
    cell.textContent = label;
    head.append(cell);
  });
  table.append(head);

  providers.forEach(providerRow => {
    const row = document.createElement("div");
    row.className = "odds-comparison-row";
    row.setAttribute("role", "row");
    const source = document.createElement("a");
    source.className = "odds-comparison-provider";
    source.href = providerRow.provider_url;
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    const name = document.createElement("strong");
    name.textContent = providerRow.provider;
    const kind = document.createElement("span");
    kind.textContent = providerKind(providerRow);
    source.append(name, kind);
    row.append(source, ...columns.map(column => renderLineCell(market, providerRow.cells[column.selection])));
    table.append(row);
  });
  scroll.append(table);
  section.append(heading, scroll);
  return section;
}

function renderTeam(code, name, logoUrl) {
  const team = document.createElement("div");
  team.className = "odds-team";
  const mark = document.createElement("span");
  mark.className = "odds-team-mark";
  mark.textContent = code;
  if (logoUrl) {
    const image = document.createElement("img");
    image.src = logoUrl;
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("load", () => mark.classList.add("has-logo"));
    image.addEventListener("error", () => image.remove());
    mark.prepend(image);
  }
  const label = document.createElement("span");
  const fullName = document.createElement("strong");
  fullName.textContent = name;
  const abbreviation = document.createElement("small");
  abbreviation.textContent = code;
  label.append(fullName, abbreviation);
  team.append(mark, label);
  return team;
}

function renderGame(game) {
  const card = document.createElement("article");
  card.className = "odds-game-card";

  const header = document.createElement("header");
  header.className = "odds-game-header";
  const matchup = document.createElement("div");
  matchup.className = "odds-matchup-teams";
  matchup.append(
    renderTeam(game.away, game.away_name, game.away_logo_url),
    Object.assign(document.createElement("span"), { className: "odds-at", textContent: "at" }),
    renderTeam(game.home, game.home_name, game.home_logo_url),
  );
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

function renderPredictionMarket(market) {
  const card = document.createElement("a");
  card.className = "prediction-card";
  card.href = market.url;
  card.target = "_blank";
  card.rel = "noopener noreferrer";
  const heading = document.createElement("h3");
  heading.textContent = market.title;
  const outcomes = document.createElement("div");
  outcomes.className = "prediction-outcomes";
  (market.contracts || []).forEach(contract => {
    const row = document.createElement("div");
    const label = document.createElement("span");
    label.textContent = contract.label;
    const price = document.createElement("strong");
    price.textContent = formatProbability(contract.probability);
    row.append(label, price);
    outcomes.append(row);
  });
  const meta = document.createElement("div");
  meta.className = "prediction-meta";
  const source = document.createElement("strong");
  source.textContent = "Polymarket ↗";
  const volume = document.createElement("span");
  volume.textContent = formatMarketVolume(market.volume);
  meta.append(source, volume);
  card.append(heading, outcomes, meta);
  return card;
}

function renderPredictionMarkets() {
  const markets = state.payload?.prediction_markets || [];
  ui.predictionMarkets.replaceChildren(...markets.map(renderPredictionMarket));
  ui.predictionSummary.textContent = markets.length
    ? `${markets.length} active NFL markets · probabilities reflect current contract prices`
    : "No active NFL prediction markets are available in the saved update.";
  ui.predictionEmpty.classList.toggle("hidden", markets.length !== 0);
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
    renderPredictionMarkets();
    render();
    const generated = new Date(state.payload.generated_at);
    ui.status.textContent = Number.isNaN(generated.getTime())
      ? "Weekly markets loaded"
      : `Updated ${generated.toLocaleString()}`;
    const sportsbookFeed = state.payload.sources?.sportsbooks?.name || "licensed feed";
    ui.connection.classList.toggle("connected", state.payload.has_sportsbooks);
    ui.connection.querySelector("strong").textContent = state.payload.has_sportsbooks
      ? `${sportsbookFeed} comparison connected`
      : "Sportsbook comparison awaiting a licensed feed";
    ui.connection.querySelector("div > span").textContent = state.payload.has_sportsbooks
      ? "The Odds API is primary; SportsGameOdds takes over automatically when the primary feed is unavailable."
      : "The schedule, consensus, Kalshi, and public Polymarket cards are live. Add either licensed sportsbook API key to activate book-by-book rows.";
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
