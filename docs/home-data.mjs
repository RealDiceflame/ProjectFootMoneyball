import {classifyInjury} from "./injury-status.mjs";

// Older saved RSS titles may still contain HTML entities. Decode as plain text;
// callers must keep using textContent, never interpret a headline as HTML.
export function headlineText(value) {
  const named = {amp:"&",quot:'"',apos:"'",lt:"<",gt:">",nbsp:"\u00a0",
    lsquo:"‘",rsquo:"’",ldquo:"“",rdquo:"”",ndash:"–",mdash:"—",hellip:"…"};
  let text = String(value || "");
  for (let pass=0; pass<2; pass++) {
    const decoded = text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity,key) => {
      if (key[0] !== "#") return Object.hasOwn(named, key.toLowerCase()) ? named[key.toLowerCase()] : entity;
      const hex = key[1]?.toLowerCase() === "x";
      const point = Number.parseInt(key.slice(hex ? 2 : 1),hex ? 16 : 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point) : entity;
    });
    if (decoded === text) break;
    text = decoded;
  }
  return text.trim();
}

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
  return headlineText(value).toLowerCase().replace(/[’']s\b/g, "").replace(/[.’']/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function playerName(value) {
  return titleWords(value).replace(/(?:\s+(?:jr|sr|ii|iii|iv|v))+$/, "");
}

export function titlePlayers(bundle, title, now = Date.now()) {
  if (!bundle?.reports || typeof bundle.reports !== "object" || Array.isArray(bundle.reports)) return [];
  const reports = Object.values(bundle.reports).filter(row => row && typeof row.player === "string");
  const names = new Map(), seen = new Set(), words = ` ${titleWords(title)} `;
  for (const report of reports) {
    const name = playerName(report.player).replaceAll(" ", "");
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(playerKey(report));
  }
  const injuries = new Map(injuryFeed(bundle, now).filter(row => row.current).map(row => [row.key, row]));
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

export function leagueHeadlineCards(bundle, now = Date.now()) {
  const cards = new Map();
  // Older snapshots can still supply their saved headlines during deployment.
  const items = Array.isArray(bundle?.league_news?.items) ? bundle.league_news.items
    : Object.values(bundle?.reports || {}).flatMap(report => (Array.isArray(report?.events) ? report.events : [])
      .filter(event => event?.category === "Recent news")
      .map(event => ({...event, url: event.source?.url})));
  for (const item of items) {
    if (!item || typeof item.title !== "string" || !item.title.trim()) continue;
    const title = headlineText(item.title);
    if (!title) continue;
    const url = safeSourceUrl(item.url), suppliedTime = item.published_at || item.date;
    const timestamp = typeof suppliedTime === "string" ? suppliedTime : null;
    const date = Date.parse(timestamp);
    if (!url || !["www.espn.com", "espn.com", "sports.yahoo.com"].includes(new URL(url).hostname) || new URL(url).port
        || (Number.isFinite(date) && (date > now + 86400000 || now - date > 7 * 86400000)) || cards.has(url)) continue;
    cards.set(url, {url, title, timestamp: Number.isFinite(date) ? timestamp : null,
      players: titlePlayers(bundle, title, now), source: new URL(url).hostname === "sports.yahoo.com" ? "Yahoo Sports" : "ESPN",
      sortTime: Number.isFinite(date) ? date : 0});
  }
  return [...cards.values()].sort((a, b) => b.sortTime - a.sortTime).slice(0, 50);
}

export function injuryFeed(bundle, now = Date.now()) {
  if (!bundle?.reports || typeof bundle.reports !== "object" || Array.isArray(bundle.reports)) throw new Error("Injury feed unavailable.");
  const seen = new Set(), rows = [];
  for (const report of Object.values(bundle.reports)) {
    if (!report || typeof report.player !== "string" || !report.injury || typeof report.injury !== "object" || Array.isArray(report.injury)) continue;
    const injury = report.injury, key = playerKey(report);
    if (seen.has(key)) continue;
    seen.add(key);
    const event = Array.isArray(report.events) ? report.events.find(row => ["Injury", "Injury history"].includes(row?.category)) : null;
    const status = String(injury.report_status || injury.status || "Status not provided").trim();
    const classification = classifyInjury(report, bundle, now);
    const week = Number.isInteger(injury.week) && injury.week > 0 ? injury.week : null;
    rows.push({
      key, player: report.player, playerId: report.player_id || null, pos: report.pos || "—",
      photoUrl: safePlayerPhoto(report.headshot_url),
      team: report.current_team || report.team || "—", injury: injury.name || "Injury details not supplied",
      status, practice: injury.practice_status || "", risk: classification.risk, week,
      season: injury.season || bundle.season || null, current: classification.current,
      freshness: classification.state, healthStatus: classification.healthStatus, currentnessLabel: classification.label,
      reportLabel: classification.reportLabel, url: safeSourceUrl(event?.source?.url),
    });
  }
  return rows.sort((a, b) => Number(b.current) - Number(a.current) || (b.season || 0) - (a.season || 0)
    || (b.week || 0) - (a.week || 0) || Number(b.risk) - Number(a.risk) || a.player.localeCompare(b.player));
}

export function filterInjuries(rows, query = "", mode = "all") {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(row => (mode !== "risk" || row.risk) && (!needle || [row.player, row.team, row.pos, row.injury, row.status].join(" ").toLocaleLowerCase().includes(needle)));
}

export function snapshotFreshness(value, now = Date.now()) {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > now + 5 * 60000) return {label: "Update time unavailable", stale: true};
  return {label: new Date(time).toLocaleString(undefined, {dateStyle: "medium", timeStyle: "short"}), stale: now - time > 7 * 3600000};
}
