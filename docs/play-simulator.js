import {fetchSnapshot, startAutoRefresh} from './auto-refresh.mjs?v=20260927-refresh1';
import {validateSimulationInputs} from './matchup-simulation.mjs?v=20261121-sim1';
import {validateRankingInputs} from './ranking-model.mjs?v=20261120-defenders2';
const $ = id => document.getElementById(id), n = value => Number.isFinite(value) ? value.toFixed(1) : '—';
let inputs, rankings, worker, busy = false, ready = false, selectedGame, signature;
function element(tag, text, className) {const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node;}
function busyState(value) {busy = value; $('sim-run').disabled = value || !ready; $('sim-cancel').hidden = !value; $('sim-form').setAttribute('aria-busy', String(value));}
function initializeWorker() {
  worker?.terminate(); ready = false; busyState(false);
  worker = new Worker(new URL('./matchup-worker.mjs?v=20261121-sim1', import.meta.url), {type: 'module'});
  worker.onmessage = ({data}) => {
    if (data.type === 'ready') {ready = true; busyState(false); $('sim-status').textContent = `Evidence updated ${new Date(inputs.generated_at).toLocaleString()} · ${inputs.coverage.used_games} validated games · ${inputs.coverage.charted_plays.toLocaleString()} charted plays. Ready to simulate.`;}
    if (data.type === 'result') {busyState(false); render(data.result, selectedGame); $('sim-status').textContent = `Finished ${data.result.iterations.toLocaleString()} simulated games. Results use the settings saved when you pressed Simulate.`;}
    if (data.type === 'error') {busyState(false); $('sim-status').textContent = data.message;}
  };
  worker.onerror = () => {ready = false; busyState(false); $('sim-status').textContent = 'The simulation could not run. Reload the page to retry.';};
  worker.postMessage({type: 'prepare', inputs, rankings, now: Date.now()});
}
function roster() {
  const game = inputs?.games.find(game => game.game_id === $('sim-game').value);
  if (!game) return;
  $('sim-roster').replaceChildren(...Object.values(inputs.status.reports).filter(p => [game.home, game.away].includes(p.team) && ['ACT','RES','INA','EXE'].includes(p.status))
    .filter(p => inputs.players[p.player_id] || ['DE','DT','NT','DL','EDGE','LB','ILB','OLB','MLB','CB','DB','S','FS','SS'].includes(p.pos))
    .sort((a,b)=>a.team.localeCompare(b.team)||a.pos.localeCompare(b.pos)||a.player.localeCompare(b.player)).map(p => {
      const label = element('label'), check = document.createElement('input'); check.type = 'checkbox'; check.value = p.player_id;
      label.append(check, document.createTextNode(`${p.team} · ${p.player} (${p.pos})`)); return label;
    }));
}
function table(id, rows) {$(`${id}`).replaceChildren(...rows.map(values => {const tr = element('tr'); tr.append(...values.map(value => element('td', value))); return tr;}));}
function render(result, game) {
  $('sim-results').hidden = false;
  $('sim-result-context').textContent = `${game.away} at ${game.home} · Week ${game.week} · ${result.iterations.toLocaleString()} runs · ${new Date(game.kickoff).toLocaleString()} · ${result.settings.ppr}, TE premium ${result.settings.tePremium}.`;
  $('sim-scorecards').replaceChildren(...[game.away, game.home].map(team => {
    const value = result.teams[team], card = element('article', null, 'sim-card');
    card.append(element('h3', team), element('p', n(value.score.mean), 'sim-score'), element('p', `Mean scoreboard points · middle 80%: ${n(value.score.low)}–${n(value.score.high)}`),
      element('p', `${n(result[team === game.home ? 'home_win_probability' : 'away_win_probability'] * 100)}% win probability · ${n(result.tie_probability * 100)}% tie`),
      element('p', `D/ST: ${n(value.fantasy.mean)} points · ${n(value.stats.def_sacks)} sacks · ${n(value.stats.def_interceptions)} interceptions · ${n(value.stats.fumble_recovery_opp)} recoveries`),
      element('p', `${n(value.stats.pass_calls)} pass calls · ${n(value.stats.run_calls)} run calls · ${n(value.stats.blitzes)} blitzes`)); return card;
  }));
  const env = result.environment;
  $('sim-conditions').textContent = `${game.stadium || 'Stadium unconfirmed'} · ${game.surface || 'Surface unconfirmed'} · roof: ${env.roof}. ${env.indoor ? 'Outdoor weather has no effect.' : `Wind: ${env.wind === null ? 'unknown' : n(env.wind) + ' mph'} · temperature: ${env.temperature === null ? 'unknown' : n(env.temperature) + '°F'}.`} ${env.source === 'kickoff_forecast' ? 'Saved kickoff forecast.' : env.source === 'scenario' ? 'Your scenario settings.' : 'Conditional conditions.'} ${env.notes.join(' ')}`;
  $('sim-coaches').replaceChildren(...Object.entries(result.coaches).map(([team, staff]) => {
    const card = element('article', null, 'sim-card'); card.append(element('h3', `${team} coaching staff`));
    for (const [role, label] of [['head_coach','Head coach'],['offensive_coordinator','Offensive coordinator'],['defensive_coordinator','Defensive coordinator']]) {
      const record = staff.roles?.[role], p = element('p', `${label}: `);
      if (record) {const link = element('a', record.name); if (record.source_url?.startsWith('https://')) link.href = record.source_url; p.append(link);} else p.append('Not listed / unconfirmed'); card.append(p);
    }
    for (const side of ['offense','defense']) {
      const caller = staff.play_callers?.[side], p = element('p', `${side === 'offense' ? 'Offensive' : 'Defensive'} play caller: ${caller ? caller.name || caller.player || 'Verified role' : 'Unconfirmed; job title is not proof'}`);
      if (caller) {const link = element('a', ' · source'); link.href = caller.source_url; p.append(link, ` · effective ${new Date(caller.effective_from).toLocaleDateString()}`);} card.append(p);
    }
    card.append(element('p', `Staff checked ${staff.checked_at ? new Date(staff.checked_at).toLocaleString() : 'unknown'} · ${staff.refresh_status || 'unavailable'}. ${staff.tendency_basis}`)); return card;
  }));
  const offense = result.players.filter(p => ['QB','RB','WR','TE','K'].includes(p.pos)), defense = result.players.filter(p => !['QB','RB','WR','TE','K'].includes(p.pos));
  const role = p => p.out ? 'Excluded / unavailable this week' : p.role_basis || 'Unassigned unit production';
  table('sim-offense', offense.map(p => [p.player,p.team,p.pos,p.role_basis === 'No recent role evidence' ? 'Unrated' : n(p.fantasy.mean), p.role_basis === 'No recent role evidence' ? '—' : `${n(p.fantasy.low)}–${n(p.fantasy.high)}`,n(p.stats.passing_yards),n(p.stats.rushing_yards),n(p.stats.receptions),n(p.stats.receiving_yards),role(p)]));
  table('sim-defense', defense.sort((a,b)=>a.team.localeCompare(b.team)||b.stats.def_sacks-a.stats.def_sacks).map(p => [p.player,p.team,p.pos,n(p.stats.def_sacks),n(p.stats.def_interceptions),n(p.stats.fumble_recovery_opp),n(p.stats.def_tds),role(p)]));
  $('sim-notes').replaceChildren(...result.notes.map(note => element('p', note)));
  $('sim-trace').replaceChildren(...result.trace.map(play => element('li', `${play.offense} vs ${play.defense} · ${play.yards_to_goal} yards to goal · ${play.play_type}${play.blitz ? ' against a blitz' : ''} · ${play.player}: ${play.result}, ${play.yards} yards. ${game.away} ${play.away_score}, ${game.home} ${play.home_score}.`)));
}
$('sim-game').addEventListener('change', roster);
$('sim-form').addEventListener('submit', event => {
  event.preventDefault(); if (!ready || busy) return;
  const game = inputs.games.find(game => game.game_id === $('sim-game').value);
  if (!game || Date.parse(game.kickoff) <= Date.now()) {$('sim-status').textContent = 'This game has started. Select an unstarted game.'; return;}
  const environment = {}, value = id => $(id).value;
  if (value('sim-roof')) environment.roof = value('sim-roof');
  if (value('sim-wind') !== '') environment.wind = Number(value('sim-wind'));
  if (value('sim-temperature') !== '') environment.temperature = Number(value('sim-temperature'));
  selectedGame = {...game}; busyState(true); $('sim-status').textContent = 'Simulating complete games… You can keep using the page or cancel this run.';
  worker.postMessage({type: 'run', game, options: {iterations: Number(value('sim-iterations')), seed: game.game_id,
    settings: {ppr: value('sim-ppr'), tePremium: value('sim-premium')}, environment,
    excluded: [...$('sim-roster').querySelectorAll('input:checked')].map(input => input.value),
    passShift: {[game.away]: Number(value('sim-away-pass')), [game.home]: Number(value('sim-home-pass'))},
    blitzShift: {[game.away]: Number(value('sim-away-blitz')), [game.home]: Number(value('sim-home-blitz'))}}});
});
$('sim-cancel').addEventListener('click', initializeWorker);
startAutoRefresh(async signal => {
  const [next, nextRankings] = await Promise.all([fetchSnapshot('data/simulation_inputs.json', {signal, validate: validateSimulationInputs}), fetchSnapshot('data/ranking_inputs.json', {signal, validate: validateRankingInputs})]);
  const nextSignature = `${next.generated_at}|${nextRankings.generated_at}`;
  if (nextSignature === signature) return;
  inputs = next; rankings = nextRankings; signature = nextSignature;
  const selected = $('sim-game').value, future = inputs.games.filter(game => Date.parse(game.kickoff) > Date.now());
  $('sim-game').replaceChildren(...future.map(game => new Option(`Week ${game.week} · ${game.away} at ${game.home}`, game.game_id)));
  if (future.some(game => game.game_id === selected)) $('sim-game').value = selected;
  roster(); initializeWorker();
}, {canRefresh: () => !busy, timeoutMs: 45000, onError: () => {$('sim-status').textContent = 'Evidence refresh failed. The last loaded inputs are retained; automatic checks will retry.';}});
