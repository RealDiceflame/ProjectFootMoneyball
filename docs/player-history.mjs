export function normalizeHistoryName(value) {
  const parts = String(value || "").toLocaleLowerCase().match(/[a-z0-9]+/g) || [];
  if (["jr", "sr", "ii", "iii", "iv", "v"].includes(parts.at(-1))) parts.pop();
  return parts.join("");
}

export function historyKey(player) {
  const playerId = String(player?.player_id || "").trim();
  if (playerId && !["-", "nan", "none"].includes(playerId.toLocaleLowerCase())) return `id:${playerId}`;
  return `name:${normalizeHistoryName(player?.player)}|${String(player?.pos || "").toUpperCase()}`;
}

export function historyRows(bundle, player) {
  const record = bundle?.players?.[historyKey(player)];
  if (!record?.seasons?.length || !bundle?.columns?.length) return [];
  return record.seasons.map(values => Object.fromEntries(
    bundle.columns.map((column, index) => [column, values[index]]),
  ));
}

export function fantasyPoints(stats, settings) {
  const basePpr = { Standard: 0, "Half PPR": 0.5, "Full PPR": 1 }[settings?.ppr] ?? 0.5;
  const tePremium = stats?.pos === "TE" && settings?.tePremium === "+0.5" ? 0.5 : 0;
  const number = key => Number(stats?.[key]) || 0;
  return (
    number("passing_yards") * 0.04
    + number("passing_tds") * 4
    - number("passing_interceptions") * 2
    + number("rushing_yards") * 0.1
    + number("rushing_tds") * 6
    + number("receptions") * (basePpr + tePremium)
    + number("receiving_yards") * 0.1
    + number("receiving_tds") * 6
    - number("fumbles_total") * 2
  );
}
