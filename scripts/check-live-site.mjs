// Read-only checks of public pages and their first-party assets. No provider APIs.
const origin = new URL(process.env.SITE_URL || 'https://outlierbaseline.com/');
const pending = new Set([
  '/', '/stats.html', '/stats.html?view=leaders', '/game.html',
  '/rankings.html', '/special-teams.html', '/values.html', '/projection.html',
  '/survivor.html', '/league.html', '/odds.html', '/data/update_status.json',
  '/data/ranking_inputs.json', '/data/ranking_forecasts.json', '/ranking-model.mjs',
]);
const checked = new Set();
const failures = [];
for (const path of pending) {
  const url = new URL(path, origin);
  if (checked.has(url.href)) continue;
  checked.add(url.href);
  try {
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
        if (response.ok) break;
        throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
    const body = await response.text();
    if (!body.trim()) throw new Error('Empty response');
    if (url.pathname.endsWith('.json')) {
      const data = JSON.parse(body);
      if (!data || typeof data !== 'object') throw new Error('Expected JSON object or array');
      if (url.pathname === '/data/ranking_forecasts.json') {
        if (data.schema_version !== 1 || Object.keys(data.formats || {}).length !== 12 || data.coverage?.teams !== 32)
          throw new Error('Incomplete published ranking forecasts');
        const age = Date.now() - Date.parse(data.generated_at);
        if (!Number.isFinite(age) || age > 36 * 3600000 || age < -300000) throw new Error('Ranking publication is stale or future-dated');
        for (const key of ['archive_checked_at', 'schedule_checked_at']) {
          const sourceAge = Date.now() - Date.parse(data.source_health?.[key]);
          if (!Number.isFinite(sourceAge) || sourceAge > 36 * 3600000 || sourceAge < -300000)
            throw new Error(`Ranking source is stale or undated: ${key}`);
        }
      }
    }
    if (url.pathname === '/' || url.pathname.endsWith('.html')) {
      if (!/<html\b/i.test(body) || !/<main\b/i.test(body)) throw new Error('Expected website HTML with main content');
      for (const match of body.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["']/gi)) {
        const asset = new URL(match[1], url);
        if (asset.origin === origin.origin && /\.(?:css|m?js)$/.test(asset.pathname)) pending.add(asset.href);
      }
    }
    console.log(`PASS ${url.href}`);
  } catch (error) {
    failures.push(`${url.href}: ${error.message}`);
    console.error(`FAIL ${failures.at(-1)}`);
  }
}
console.log(`Checked ${checked.size} public URLs; ${failures.length} failure(s).`);
if (failures.length) process.exitCode = 1;
