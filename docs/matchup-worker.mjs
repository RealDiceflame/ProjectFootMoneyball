import {prepareSimulation, runMatchup} from './matchup-simulation.mjs?v=20261121-sim1';
let prepared;
self.onmessage = ({data}) => {
  try {
    if (data.type === 'prepare') {prepared = prepareSimulation(data.inputs, data.rankings, {now: data.now}); self.postMessage({type: 'ready'});}
    else {
      prepared = prepareSimulation(prepared.inputs, prepared.rankingInputs, {now: Date.now()});
      self.postMessage({type: 'result', result: runMatchup(prepared, data.game, data.options)});
    }
  } catch (error) {self.postMessage({type: 'error', message: error.message});}
};
