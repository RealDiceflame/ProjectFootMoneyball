import {prepareMatchup, summarize} from "./matchup-model.mjs?v=20260909-labs2";
import {seededRandom} from "./survivor-model.mjs?v=1";

export const DIVISIONS = {
  "AFC East": ["BUF", "MIA", "NE", "NYJ"], "AFC North": ["BAL", "CIN", "CLE", "PIT"],
  "AFC South": ["HOU", "IND", "JAX", "TEN"], "AFC West": ["DEN", "KC", "LAC", "LV"],
  "NFC East": ["DAL", "NYG", "PHI", "WAS"], "NFC North": ["CHI", "DET", "GB", "MIN"],
  "NFC South": ["ATL", "CAR", "NO", "TB"], "NFC West": ["ARI", "LA", "SEA", "SF"],
};
export const TEAM_DIVISION = Object.fromEntries(Object.entries(DIVISIONS).flatMap(([division, teams]) => teams.map(team => [team, division])));
const conference = team => TEAM_DIVISION[team].slice(0, 3);
const pct = results => results.length ? results.reduce((sum, r) => sum + (r.for > r.against ? 1 : r.for === r.against ? .5 : 0), 0) / results.length : null;
const keepBest = (teams, value) => {
  const scores = teams.map(team => value(team));
  if (scores.some(score => score === null || !Number.isFinite(score))) return teams;
  const best = Math.max(...scores);
  return teams.filter((_, i) => Math.abs(scores[i] - best) < 1e-9);
};

// NFL qualification structure; late tiebreakers deliberately simplified and labeled.
export function rankTeams(teams, records, random, division = false) {
  const remaining = [...teams], ordered = [];
  while (remaining.length) {
    let tied = keepBest(remaining, team => pct(records[team].games));
    const overall = tied.length;
    const filters = [];
    if (division || tied.length === 2) filters.push(team => pct(records[team].games.filter(g => tied.includes(g.opponent))));
    else {
      // A cross-division multi-team head-to-head sweep is applicable only to a
      // club that beat or lost to every other tied club, not unequal small samples.
      const sweep = tied.filter(team => tied.filter(other => other !== team).every(other => records[team].games.some(g => g.opponent === other && g.for > g.against)));
      if (sweep.length === 1) tied = sweep;
      else {
        const swept = tied.filter(team => tied.filter(other => other !== team).every(other => records[team].games.some(g => g.opponent === other && g.for < g.against)));
        if (swept.length && swept.length < tied.length) tied = tied.filter(team => !swept.includes(team));
      }
    }
    const divisionPct = team => pct(records[team].games.filter(g => TEAM_DIVISION[g.opponent] === TEAM_DIVISION[team]));
    const conferencePct = team => pct(records[team].games.filter(g => conference(g.opponent) === conference(team)));
    const commonPct = team => {
      const common = records[team].games.filter(g => tied.every(other => records[other].games.some(game => game.opponent === g.opponent)));
      return !division && common.length < 4 ? null : pct(common);
    };
    filters.push(...(division ? [divisionPct, commonPct, conferencePct] : [conferencePct, commonPct]));
    const strength = (team, victories) => {
      const opponents = records[team].games.filter(g => !victories || g.for > g.against).map(g => g.opponent);
      return pct(opponents.flatMap(opponent => records[opponent].games));
    };
    filters.push(team => strength(team, true), team => strength(team, false), team => records[team].pf - records[team].pa);
    for (const criterion of filters) {
      if (tied.length === 1) break;
      const next = keepBest(tied, criterion);
      if (next.length < tied.length && next.length > 1) {
        tied = [rankTeams(next, records, random, division)[0]]; break;
      }
      tied = next;
    }
    const winner = tied.length === 1 ? tied[0] : tied[Math.floor(random() * tied.length)];
    ordered.push(winner); remaining.splice(remaining.indexOf(winner), 1);
    if (!overall) throw new Error("Standings could not be resolved.");
  }
  return ordered;
}

export function playoffSeeds(records, random) {
  const divisions = Object.fromEntries(Object.entries(DIVISIONS).map(([name, teams]) => [name, rankTeams(teams, records, random, true)]));
  const seeds = {};
  for (const conf of ["AFC", "NFC"]) {
    const orders = Object.entries(divisions).filter(([name]) => name.startsWith(conf)).map(([, teams]) => [...teams]);
    const winners = orders.map(order => order.shift());
    seeds[conf] = rankTeams(winners, records, random);
    for (let i = 0; i < 3; i++) {
      const winner = rankTeams(orders.map(order => order[0]).filter(Boolean), records, random)[0];
      seeds[conf].push(winner); orders.find(order => order[0] === winner).shift();
    }
  }
  return {divisions, seeds};
}

export function playPostseason(seeds, draw) {
  const rounds = [], champs = {};
  for (const conf of ["AFC", "NFC"]) {
    const order = seeds[conf], seed = team => order.indexOf(team) + 1;
    const play = (a, b, round) => {
      const [home, away] = seed(a) < seed(b) ? [a, b] : [b, a];
      const score = draw(home, away, false);
      if (score.home === score.away) throw new Error("A playoff game cannot end tied.");
      const winner = score.home > score.away ? home : away;
      rounds.push({conference: conf, round, home, away, home_seed: seed(home), away_seed: seed(away), home_points: score.home, away_points: score.away, winner});
      return winner;
    };
    const alive = [order[0], play(order[1], order[6], "Wild card"), play(order[2], order[5], "Wild card"), play(order[3], order[4], "Wild card")].sort((a, b) => seed(a) - seed(b));
    const finalists = [play(alive[0], alive[3], "Divisional"), play(alive[1], alive[2], "Divisional")];
    champs[conf] = play(...finalists, "Conference championship");
  }
  const score = draw(champs.AFC, champs.NFC, true);
  if (score.home === score.away) throw new Error("The Super Bowl cannot end tied.");
  const champion = score.home > score.away ? champs.AFC : champs.NFC;
  rounds.push({conference: "NFL", round: "Super Bowl", home: champs.AFC, away: champs.NFC, neutral: true, home_points: score.home, away_points: score.away, winner: champion});
  return {rounds, champs, champion};
}

function scoreSummary(counts, n) {
  const entries = [...counts].sort((a, b) => a[0] - b[0]);
  const mean = entries.reduce((sum, [score, count]) => sum + score * count, 0) / n;
  const at = index => { let count = 0; for (const [score, frequency] of entries) { count += frequency; if (count > index) return score; } return entries.at(-1)[0]; };
  return {mean, sd: Math.sqrt(entries.reduce((sum, [score, count]) => sum + (score - mean) ** 2 * count, 0) / n), p10: at(Math.floor((n - 1) * .1)), p90: at(Math.ceil((n - 1) * .9))};
}

export function simulateLeague(data, {trials = 2000, seed = 2026, now = Date.now(), onProgress = () => {}} = {}) {
  if (!Number.isInteger(trials) || trials < 100 || trials > 10000) throw new Error("Choose 100–10,000 season simulations.");
  const teams = data.teams.map(t => t.team);
  if (new Set(teams).size !== 32 || teams.some(team => !TEAM_DIVISION[team]) || data.games.length !== 272) throw new Error("A complete 32-team, 272-game schedule is required.");
  const counts = Object.fromEntries(teams.map(team => [team, 0]));
  const ids = new Set();
  for (const game of data.games) {
    if (ids.has(game.game_id) || !teams.includes(game.home) || !teams.includes(game.away) || game.home === game.away) throw new Error("Invalid or duplicate fixture.");
    ids.add(game.game_id); counts[game.home]++; counts[game.away]++;
  }
  if (Object.values(counts).some(count => count !== 17)) throw new Error("Each team must have 17 scheduled games.");
  const random = seededRandom(seed), cache = new Map();
  const drawPostseason = (home, away, neutral) => {
    const key = `${home}|${away}|${neutral}`;
    if (!cache.has(key)) cache.set(key, prepareMatchup(data, {home, away, neutral}, {now}));
    return cache.get(key).draw(random, true);
  };
  const fixtures = data.games.map(game => {
    const final = game.status === "final" && [game.home_score, game.away_score].every(v => Number.isFinite(v) && v >= 0) && Date.parse(game.kickoff) + 6 * 3600000 <= now;
    // Unresolved/underway games are NOT live forecasts; no partial score is used.
    const unresolved = !final && Date.parse(game.kickoff) <= now;
    const sampler = final ? null : prepareMatchup(data, {...game, game_id: !unresolved && game.model ? game.game_id : undefined}, {now});
    return {game, final, unresolved, sampler, home: new Map(), away: new Map(), homeWins: 0, awayWins: 0, ties: 0};
  });
  const accum = Object.fromEntries(teams.map(team => [team, {wins: [], losses: 0, ties: 0, pf: 0, pa: 0, division: 0, playoffs: 0, bye: 0, conference: 0, champion: 0}]));
  let example;
  for (let trial = 0; trial < trials; trial++) {
    const records = Object.fromEntries(teams.map(team => [team, {wins: 0, losses: 0, ties: 0, pf: 0, pa: 0, games: []}]));
    const sampleGames = [];
    for (const fixture of fixtures) {
      const {game, final} = fixture, score = final ? {home: game.home_score, away: game.away_score} : fixture.sampler.draw(random);
      const h = records[game.home], a = records[game.away];
      h.pf += score.home; h.pa += score.away; a.pf += score.away; a.pa += score.home;
      h.games.push({opponent: game.away, for: score.home, against: score.away}); a.games.push({opponent: game.home, for: score.away, against: score.home});
      if (score.home > score.away) { h.wins++; a.losses++; fixture.homeWins++; }
      else if (score.away > score.home) { a.wins++; h.losses++; fixture.awayWins++; }
      else { h.ties++; a.ties++; fixture.ties++; }
      fixture.home.set(score.home, (fixture.home.get(score.home) || 0) + 1); fixture.away.set(score.away, (fixture.away.get(score.away) || 0) + 1);
      if (!trial) sampleGames.push({game_id: game.game_id, home: score.home, away: score.away});
    }
    const {divisions, seeds} = playoffSeeds(records, random), postseason = playPostseason(seeds, drawPostseason);
    for (const team of teams) {
      const row = records[team], acc = accum[team], conf = conference(team);
      acc.wins.push(row.wins); acc.losses += row.losses; acc.ties += row.ties; acc.pf += row.pf; acc.pa += row.pa;
      acc.division += divisions[TEAM_DIVISION[team]][0] === team; acc.playoffs += seeds[conf].includes(team); acc.bye += seeds[conf][0] === team;
      acc.conference += postseason.champs[conf] === team; acc.champion += postseason.champion === team;
    }
    if (!trial) example = {records: Object.fromEntries(teams.map(team => [team, {...records[team], games: undefined}])), divisions, seeds, postseason, games: sampleGames};
    if (trial % 100 === 0) onProgress(trial / trials);
  }
  return {trials, seed, generated_at: data.generated_at, completed_games: fixtures.filter(f => f.final).length, unresolved_games: fixtures.filter(f => f.unresolved).length,
    teams: teams.map(team => { const acc = accum[team]; return {team, division: TEAM_DIVISION[team], wins: summarize(acc.wins), losses: acc.losses / trials, ties: acc.ties / trials, points_for: acc.pf / trials, points_against: acc.pa / trials,
      division_probability: acc.division / trials, playoff_probability: acc.playoffs / trials, bye_probability: acc.bye / trials, conference_probability: acc.conference / trials, champion_probability: acc.champion / trials}; }),
    games: fixtures.map(f => ({...f.game, model: undefined, market: undefined, final: f.final, unresolved: f.unresolved,
      home_stats: scoreSummary(f.home, trials), away_stats: scoreSummary(f.away, trials), home_win: f.homeWins / trials, away_win: f.awayWins / trials, tie: f.ties / trials})), example};
}
