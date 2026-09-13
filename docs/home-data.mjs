export function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function injuryFeed(bundle) {
  if (!bundle?.reports || typeof bundle.reports !== "object" || Array.isArray(bundle.reports)) throw new Error("Injury feed unavailable.");
  const seen = new Set(), rows = [];
  for (const report of Object.values(bundle.reports)) {
    if (!report || typeof report.player !== "string" || !report.injury || typeof report.injury !== "object" || Array.isArray(report.injury)) continue;
    const injury = report.injury, key = report.player_id ? `${report.player_id}|${report.pos}` : `${report.player}|${report.pos}|${report.team}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const event = Array.isArray(report.events) ? report.events.find(row => row?.category === "Injury") : null;
    const status = String(injury.report_status || injury.status || "Status not provided").trim();
    // Practice participation and Questionable/Probable alone do not mean RISK.
    const risk = /^(out|doubtful|ir|injured reserve|reserve\/injured)$/i.test(status);
    const week = Number.isInteger(injury.week) && injury.week > 0 ? injury.week : null;
    rows.push({
      key, player: report.player, playerId: report.player_id || null, pos: report.pos || "—",
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
