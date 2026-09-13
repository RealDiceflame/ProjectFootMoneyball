export function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function safePlayerPhoto(value) {
  const url = safeSourceUrl(value);
  // Reuse the roster portraits already used in rankings; never fetch arbitrary images.
  return url && new URL(url).hostname === "static.www.nfl.com" ? url : null;
}

function playerKey(report) {
  return report.player_id ? `${report.player_id}|${report.pos}` : `${report.player}|${report.pos}|${report.team}`;
}

function titleWords(value) {
  return String(value || "").toLowerCase().replace(/[’']s\b/g, "").replace(/[.’']/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function playerName(value) {
  return titleWords(value).replace(/(?:\s+(?:jr|sr|ii|iii|iv|v))+$/, "");
}

export function titlePlayers(bundle, title) {
  if (!bundle?.reports || typeof bundle.reports !== "object" || Array.isArray(bundle.reports)) return [];
  const reports = Object.values(bundle.reports).filter(row => row && typeof row.player === "string");
  const names = new Map(), seen = new Set(), words = ` ${titleWords(title)} `;
  for (const report of reports) {
    const name = playerName(report.player).replaceAll(" ", "");
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(playerKey(report));
  }
  const injuries = new Map(injuryFeed(bundle).map(row => [row.key, row]));
  return reports.flatMap(report => {
    const name = playerName(report.player), key = playerKey(report);
    // Fail closed on old snapshots or full-roster collisions (including defensive players).
    if (report.headline_name_ambiguous !== false || !report.player_id || seen.has(key)
        || !name.includes(" ") || names.get(name.replaceAll(" ", "")).size !== 1
        || !words.includes(` ${name} `)) return [];
    seen.add(key);
    return [{key, player: report.player, playerId: report.player_id, pos: report.pos || "—",
      team: report.current_team || report.team || "—", photoUrl: safePlayerPhoto(report.headshot_url),
      injury: injuries.get(key) || null}];
  });
}

export function recentHeadlineCards(bundle, now = Date.now()) {
  const cards = new Map();
  for (const report of Object.values(bundle?.reports || {})) {
    for (const event of Array.isArray(report?.events) ? report.events : []) {
      if (event?.category !== "Recent news" || typeof event.title !== "string") continue;
      const url = safeSourceUrl(event.source?.url), date = Date.parse(event.date);
      // Only the existing ESPN news source is automated. Curated sources are separate.
      if (!url || !["www.espn.com", "espn.com"].includes(new URL(url).hostname)
          || !Number.isFinite(date) || date > now + 86400000 || now - date > 7 * 86400000 || cards.has(url)) continue;
      const players = titlePlayers(bundle, event.title);
      if (players.length) cards.set(url, {url, title: event.title, date: event.date, players, source: "ESPN · NEWS"});
    }
  }
  return [...cards.values()].sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || a.title.localeCompare(b.title)).slice(0, 4);
}

export function injuryFeed(bundle) {
  if (!bundle?.reports || typeof bundle.reports !== "object" || Array.isArray(bundle.reports)) throw new Error("Injury feed unavailable.");
  const seen = new Set(), rows = [];
  for (const report of Object.values(bundle.reports)) {
    if (!report || typeof report.player !== "string" || !report.injury || typeof report.injury !== "object" || Array.isArray(report.injury)) continue;
    const injury = report.injury, key = playerKey(report);
    if (seen.has(key)) continue;
    seen.add(key);
    const event = Array.isArray(report.events) ? report.events.find(row => row?.category === "Injury") : null;
    const status = String(injury.report_status || injury.status || "Status not provided").trim();
    // Practice participation and Questionable/Probable alone do not mean RISK.
    const risk = /^(out|doubtful|ir|injured reserve|reserve\/injured)$/i.test(status);
    const week = Number.isInteger(injury.week) && injury.week > 0 ? injury.week : null;
    rows.push({
      key, player: report.player, playerId: report.player_id || null, pos: report.pos || "—",
      photoUrl: safePlayerPhoto(report.headshot_url),
      team: report.current_team || report.team || "—", injury: injury.name || "Injury details not supplied",
      status, practice: injury.practice_status || "", risk, week,
      reportLabel: week ? `Week ${week}` : "Report week unavailable", url: safeSourceUrl(event?.source?.url),
    });
  }
  return rows.sort((a, b) => (b.week || 0) - (a.week || 0) || Number(b.risk) - Number(a.risk) || a.player.localeCompare(b.player));
}

export function filterInjuries(rows, query = "", mode = "all") {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(row => (mode !== "risk" || row.risk) && (!needle || [row.player, row.team, row.pos, row.injury, row.status].join(" ").toLocaleLowerCase().includes(needle)));
}

export function snapshotFreshness(value, now = Date.now()) {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > now + 5 * 60000) return {label: "Snapshot time unavailable", stale: true};
  return {label: new Date(time).toLocaleString(undefined, {dateStyle: "medium", timeStyle: "short"}), stale: now - time > 7 * 3600000};
}
