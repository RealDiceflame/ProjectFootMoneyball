// Missing provider values must not become real zero-price quotes.
function numberOrNull(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function formatAmerican(value) {
  const number = numberOrNull(value);
  if (number === null) return "—";
  return number > 0 ? `+${Math.round(number)}` : String(Math.round(number));
}

export function formatLine(row) {
  const number = numberOrNull(row.line);
  if (number === null) return "—";
  if (row.market === "Spread") return number > 0 ? `+${number}` : String(number);
  return String(number);
}

export function formatPrice(row) {
  const contractPrice = numberOrNull(row.contract_price);
  if (row.provider_kind === "exchange" && contractPrice !== null) {
    return `${Math.round(contractPrice)}¢ (≈ ${formatAmerican(row.price)})`;
  }
  return formatAmerican(row.price);
}

export function formatProbability(value) {
  const number = numberOrNull(value);
  if (number === null) return "—";
  const percentage = number * 100;
  return `${percentage < 1 && percentage > 0 ? percentage.toFixed(1) : Math.round(percentage)}%`;
}

export function formatMarketVolume(value) {
  const number = numberOrNull(value);
  if (number === null || number <= 0) return "Volume unavailable";
  return `${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(number)} volume`;
}

export function comparisonColumns(game, market) {
  return market === "Total"
    ? [{ selection: "Over", label: "Over" }, { selection: "Under", label: "Under" }]
    : [
      { selection: game.away, label: game.away_name || game.away },
      { selection: game.home, label: game.home_name || game.home },
    ];
}

export function groupMarketRows(game, market, rows) {
  const columns = comparisonColumns(game, market);
  const providerOrder = { sportsbook: 0, exchange: 1, reference: 2 };
  const providers = new Map();
  [...(rows || [])]
    .sort((left, right) => Number(right.is_best) - Number(left.is_best))
    .forEach(row => {
      if (!providers.has(row.provider_key)) {
        providers.set(row.provider_key, {
          provider: row.provider,
          provider_key: row.provider_key,
          provider_kind: row.provider_kind,
          provider_url: row.provider_url,
          cells: Object.fromEntries(columns.map(column => [column.selection, null])),
        });
      }
      const provider = providers.get(row.provider_key);
      if (Object.hasOwn(provider.cells, row.selection) && provider.cells[row.selection] === null) {
        provider.cells[row.selection] = row;
      }
    });
  return {
    columns,
    providers: [...providers.values()].sort((left, right) =>
      (providerOrder[left.provider_kind] ?? 9) - (providerOrder[right.provider_kind] ?? 9)
      || left.provider.localeCompare(right.provider)),
  };
}

export function flattenGames(games) {
  return (games || []).flatMap(game => (game.rows || []).map(row => ({
    ...row,
    game_id: game.game_id,
    week: game.week,
    kickoff: game.kickoff,
    away: game.away,
    home: game.home,
    away_name: game.away_name,
    home_name: game.home_name,
    matchup: `${game.away} @ ${game.home}`,
  })));
}

export function defaultWeek(weeks) {
  const values = (weeks || []).map(numberOrNull).filter(value => Number.isInteger(value) && value > 0).sort((a, b) => a - b);
  return values.length ? values[0] : null;
}

export function filterOddsRows(rows, { week, market = "ALL", provider = "ALL", search = "" }) {
  const query = String(search).trim().toLocaleLowerCase();
  return rows.filter(row => {
    if (week !== null && Number(row.week) !== Number(week)) return false;
    if (market !== "ALL" && row.market !== market) return false;
    if (provider !== "ALL" && row.provider_key !== provider) return false;
    if (!query) return true;
    return [row.matchup, row.away_name, row.home_name, row.selection, row.provider, row.market]
      .some(value => String(value || "").toLocaleLowerCase().includes(query));
  });
}

export function filterOddsGames(games, { week, market = "ALL", provider = "ALL", search = "" }) {
  const query = String(search).trim().toLocaleLowerCase();
  return (games || []).flatMap(game => {
    if (week !== null && Number(game.week) !== Number(week)) return [];
    const gameMatches = [game.away, game.home, game.away_name, game.home_name, game.stadium, game.roof, game.surface]
      .some(value => String(value || "").toLocaleLowerCase().includes(query));
    const rows = (game.rows || []).filter(row => {
      if (market !== "ALL" && row.market !== market) return false;
      if (provider !== "ALL" && row.provider_key !== provider) return false;
      if (!query || gameMatches) return true;
      return [row.selection, row.provider, row.market]
        .some(value => String(value || "").toLocaleLowerCase().includes(query));
    });
    if ((market !== "ALL" || provider !== "ALL") && !rows.length) return [];
    if (query && !gameMatches && !rows.length) return [];
    return [{ ...game, rows }];
  });
}

export function formatWeather(weather) {
  if (!weather) return "Weather pending";
  const pieces = [weather.summary || "Weather pending"];
  const temperature = numberOrNull(weather.temperature);
  if (temperature !== null) {
    pieces.push(`${Math.round(temperature)}°F`);
  }
  const wind = [weather.wind_direction, weather.wind_speed].filter(Boolean).join(" ");
  if (wind) pieces.push(`Wind ${wind}`);
  return pieces.join(" · ");
}
export function safeOddsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
