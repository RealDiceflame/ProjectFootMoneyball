import {build} from 'esbuild';
import {readFile, mkdir, writeFile, copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {configErrors, securityHeaders} from '../src/policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(resolve(root, 'config.json'), 'utf8'));
// Disabled previews may omit setup values, but never accept a privileged key.
if (config.publishableKey && !/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey)) throw new Error('Only a public publishable key belongs in this build.');
if (config.enabled && configErrors(config).length) throw new Error(configErrors(config).join('\n'));
const output = resolve(root, 'dist');
await mkdir(output, {recursive: true});
await build({entryPoints: [resolve(root, 'src/app.mjs')], outfile: resolve(output, 'app.js'), bundle: true, minify: true, sourcemap: false, target: ['es2022'], format: 'esm', define: {__ACCOUNT_CONFIG__: JSON.stringify(config)}, legalComments: 'linked'});
for (const file of ['index.html', 'styles.css', 'robots.txt', '404.html']) await copyFile(resolve(root, 'public', file), resolve(output, file));
await writeFile(resolve(output, '_headers'), '/*\n' + Object.entries(securityHeaders).map(([name, value]) => `  ${name}: ${value}`).join('\n') + '\n');
console.log(`Account site built. Public signup ${config.enabled ? 'enabled (requires verified server configuration)' : 'disabled'}.`);
