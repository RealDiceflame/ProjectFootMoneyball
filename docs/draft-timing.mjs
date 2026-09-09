// Descriptive cost-of-waiting comparisons, not a roster-aware draft optimizer.
const POSITIONS = ["QB", "RB", "WR", "TE"];
export const TIMING_RULES = Object.freeze({minimumDrop: 10, minimumYears: 5,
  minimumObservations: 10, minimumPlayers: 5, consistency: 2 / 3, tiePoints: 5});

const average = numbers => numbers.length ? numbers.reduce((sum, n) => sum + n, 0) / numbers.length : null;
const number = value => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const distinctPlayers = rows => new Set(rows.map(row => row.identity)).size;

function groupByYear(rows) {
  const result = new Map();
  for (const row of rows) {
    if (!result.has(row.season)) result.set(row.season, []);
    result.get(row.season).push(row.points);
  }
  return result;
}

export function draftTiming(rows, {teams = 12, historical = false, waitRounds = 1, maximumRound = 15} = {}) {
  const teamCount = number(teams);
  if (!(teamCount > 0) || !Number.isInteger(waitRounds) || waitRounds < 1 || waitRounds > 2 || !Number.isInteger(maximumRound) || maximumRound < 1) throw new Error("Invalid draft timing settings");
  const groups = new Map(), seen = new Set();
  for (const row of rows || []) {
    const points = number(row[historical ? "actual_points" : "projected_points"]), adp = number(row.adp);
    const season = historical ? number(row.season) : 0;
    const identity = row.player_id || (row.player ? `${row.player.toLocaleLowerCase()}|${row.pos}` : null);
    if (points === null || !(adp > 0) || !identity || !POSITIONS.includes(row.pos) || (historical && !Number.isInteger(season))) continue;
    const round = Math.ceil(adp / teamCount), key = `${season}|${identity}`;
    if (round < 1 || round > maximumRound || seen.has(key)) continue;
    seen.add(key);
    const group = `${round}|${row.pos}`;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({identity, season, points});
  }
  const comparisons = [];
  for (let round = 1; round <= maximumRound; round++) {
    for (const pos of POSITIONS) {
      const laterRound = round + waitRounds;
      const current = groups.get(`${round}|${pos}`) || [], later = groups.get(`${laterRound}|${pos}`) || [];
      const base = {round, later_round: laterRound, pos, historical, priority: false, signal: false,
        current_count: current.length, later_count: later.length, years: 0, declining_years: 0,
        drop: null, now_mean: null, later_mean: null};
      if (laterRound > maximumRound) { comparisons.push({...base, status: "beyond_map"}); continue; }
      if (!current.length || !later.length) { comparisons.push({...base, status: "missing"}); continue; }
      let now = current, next = later, drops = [];
      if (historical) {
        const a = groupByYear(current), b = groupByYear(later);
        const common = [...a.keys()].filter(year => b.has(year));
        now = current.filter(row => common.includes(row.season));
        next = later.filter(row => common.includes(row.season));
        drops = common.map(year => average(a.get(year)) - average(b.get(year)));
        base.years = common.length;
        base.declining_years = drops.filter(drop => drop > 0).length;
        base.now_mean = average(common.map(year => average(a.get(year))));
        base.later_mean = average(common.map(year => average(b.get(year))));
      } else {
        base.now_mean = average(now.map(row => row.points));
        base.later_mean = average(next.map(row => row.points));
      }
      base.current_count = now.length; base.later_count = next.length;
      base.drop = base.now_mean === null || base.later_mean === null ? null : base.now_mean - base.later_mean;
      const enough = !historical || (base.years >= TIMING_RULES.minimumYears && now.length >= TIMING_RULES.minimumObservations
        && next.length >= TIMING_RULES.minimumObservations && distinctPlayers(now) >= TIMING_RULES.minimumPlayers && distinctPlayers(next) >= TIMING_RULES.minimumPlayers);
      const consistent = !historical || base.declining_years / base.years >= TIMING_RULES.consistency;
      const meaningful = base.drop !== null && base.drop >= TIMING_RULES.minimumDrop;
      base.signal = enough && consistent && meaningful;
      comparisons.push({...base, status: !enough ? "limited" : base.signal ? "drop" : meaningful ? "mixed" : "flexible"});
    }
  }
  const rounds = [];
  for (let round = 1; round <= maximumRound; round++) {
    const cells = comparisons.filter(c => c.round === round);
    const candidates = cells.filter(c => c.signal).sort((a, b) => b.drop - a.drop);
    const priorities = candidates.filter(c => candidates[0].drop - c.drop <= TIMING_RULES.tiePoints);
    priorities.forEach(c => { c.priority = true; });
    rounds.push({round, later_round: round + waitRounds, cells, priorities: priorities.map(c => c.pos)});
  }
  const positions = POSITIONS.map(pos => {
    const eligible = comparisons.filter(c => c.pos === pos && c.signal).sort((a, b) => b.drop - a.drop || a.round - b.round);
    return {pos, largest_drop: eligible[0] || null,
      target_rounds: comparisons.filter(c => c.pos === pos && c.priority).map(c => c.round)};
  });
  return {historical, wait_rounds: waitRounds, rules: TIMING_RULES, rounds, positions};
}
