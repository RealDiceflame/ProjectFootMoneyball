const WEEK_MS = 7 * 86400000;
const integer = value => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const timestamp = value => typeof value === "string" ? Date.parse(value) : NaN;

// A player's latest report is history until its season/week matches independently
// established schedule context. Missing reports never establish that a player is healthy.
// Callers with an older snapshot can supply {season, generated_at, injury_context:
// {season, expected_week, valid_from, valid_until, teams}} from their schedule.
// Explicit expectedWeek/generatedAt aliases are supported for existing callers.
export function classifyInjury(report, bundle = {}, now = Date.now()) {
  const candidate = report?.injury;
  const injury = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : null;
  const context = bundle?.injury_context || bundle || {};
  const season = integer(injury?.season ?? bundle?.season);
  const week = integer(injury?.week);
  const expectedSeason = integer(context.season ?? bundle?.season);
  const expectedWeek = integer(context.expected_week ?? context.expectedWeek);
  const generated = timestamp(bundle?.generated_at ?? bundle?.generatedAt);
  const starts = timestamp(context.valid_from), ends = timestamp(context.valid_until);
  const hasWindow = context.valid_from != null || context.valid_until != null;
  const validWindow = !hasWindow || (Number.isFinite(starts) && Number.isFinite(ends) && starts <= now && now < ends);
  const freshSnapshot = Number.isFinite(generated) && generated <= now + 5 * 60000 && now - generated <= WEEK_MS;
  const team = report?.current_team || report?.team;
  const teamScheduled = !Array.isArray(context.teams) || context.teams.includes(team);
  const current = Boolean(injury && season && week && season === expectedSeason && week === expectedWeek
    && freshSnapshot && validWindow && teamScheduled && !injury.carried_forward
    && !["unavailable", "behind"].includes(context.status));
  let state = injury ? "unknown" : "unavailable";
  if (current) state = "current";
  else if (injury && season && expectedSeason && (season < expectedSeason || (season === expectedSeason && expectedWeek && week && week < expectedWeek))) state = "historical";
  else if (injury && season && expectedSeason && (season > expectedSeason || (season === expectedSeason && expectedWeek && week && week > expectedWeek))) state = "future";
  else if (injury && ((Number.isFinite(ends) && now >= ends) || (Number.isFinite(generated) && now - generated > WEEK_MS))) state = "historical";
  const status = String(injury?.report_status || injury?.status || "").trim();
  const risk = current && /^(out|doubtful|ir|injured reserve|reserve\/injured)$/i.test(status);
  const reportLabel = week ? `${season ? `${season} · ` : ""}Week ${week}` : "Report week unavailable";
  const label = current ? "Current report" : state === "historical" ? "Historical report · Current health unknown"
    : state === "future" ? "Future report · Current health unknown" : "Current health unknown";
  return {state, current, risk, injury, currentInjury: current ? {...injury, severity: risk ? "risk" : "watch"} : null,
    healthStatus: current ? "reported" : "unknown", reportLabel, label};
}
