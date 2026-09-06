const TEAM_ALIASES = { LAR: "LA" };

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function enabled(settings, key) {
  return String(settings?.[key] || "Off") === "Include";
}

export function specialTeamRows(payload, settings = {}) {
  if (!payload?.columns || !payload?.rows) return [];
  return payload.rows
    .map(values => Object.fromEntries(payload.columns.map((column, index) => [column, values[index]])))
    .filter(row => row.team && ((row.pos === "K" && enabled(settings, "kickers")) || (row.pos === "DST" && enabled(settings, "defenses"))))
    .map(row => {
      const team = TEAM_ALIASES[String(row.team).toUpperCase()] || String(row.team).toUpperCase();
      const adp = numberOrNull(row.adp);
      return {
        ...row,
        team,
        listed_team: team,
        current_team: team,
        projected_points: null,
        vorp: null,
        market_value: null,
        market_expected_points: null,
        value_vs_adp: null,
        Yahoo: null,
        injury: null,
        is_rookie: false,
        is_special_teams: true,
        draft_tag: "MARKET",
        market_draft_tag: "MARKET",
        adp,
      };
    });
}

export function mergeSpecialTeams(players, specialTeams) {
  const combined = [
    ...(players || []).map((row, index) => ({ ...row, _boardSlot: numberOrNull(row.overall_rank) ?? index + 1, _boardOrder: index })),
    ...(specialTeams || []).map((row, index) => ({ ...row, _boardSlot: numberOrNull(row.adp) ?? Number.MAX_SAFE_INTEGER, _boardOrder: index })),
  ];
  combined.sort((left, right) =>
    left._boardSlot - right._boardSlot
    || Number(Boolean(left.is_special_teams)) - Number(Boolean(right.is_special_teams))
    || left._boardOrder - right._boardOrder
  );
  return combined.map((row, index) => {
    const { _boardSlot, _boardOrder, ...clean } = row;
    clean.overall_rank = index + 1;
    clean.value_vs_adp = clean.is_special_teams || numberOrNull(clean.adp) === null
      ? null
      : numberOrNull(clean.adp) - clean.overall_rank;
    return clean;
  });
}
