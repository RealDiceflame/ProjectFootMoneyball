import {simulateLeague} from "./league-model.mjs?v=20260909-labs2";
self.onmessage = event => {
  try {
    const result = simulateLeague(event.data.data, {...event.data.options, onProgress: progress => self.postMessage({progress})});
    self.postMessage({result});
  } catch (error) { self.postMessage({error: error.message}); }
};
