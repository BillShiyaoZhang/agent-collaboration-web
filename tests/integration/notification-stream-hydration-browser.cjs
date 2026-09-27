// Real NotificationProvider, delayed SSR Template and Next's actual React runtime.
// This asserts the hydration restart cause; the complete Next page has its own gate.
const path = require('node:path'), fs = require('node:fs'), http = require('node:http');
const assert = require('node:assert/strict'), { execFileSync } = require('node:child_process'), { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..'), fixture = path.join(__dirname, 'notification-stream-hydration');
const evidence = path.join(root, 'build/workspace-sync-preview/notification-stream-hydration');
const out = path.join(evidence, 'compiled');
const baselineRevision = '9baaf3e2d66e601563dd685065ed24fa44b61338';
const expectedReactVersion = '19.2.0-canary-0bdb9206-20250818';
const accountId = 'synthetic-notification-account', storageKey = `agent-notifications:v1:${accountId}`;
const deviceId = '11111111-2222-4333-8444-555555555555';
fs.mkdirSync(out, { recursive: true });
const baseline = execFileSync('git', ['-c', 'safe.directory=' + root.replaceAll('\\', '/'), 'show', `${baselineRevision}:src/components/notification-provider.tsx`], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
fs.writeFileSync(path.join(evidence, 'baseline-notification.tsx'), baseline);
const compiled = path.join(root, 'node_modules/next/dist/compiled');
const reactVersion = require(path.join(compiled, 'react')).version;
assert.equal(reactVersion, expectedReactVersion, 'update the harness deliberately when the deployed Next runtime changes');
const runtime = require(path.join(compiled, 'webpack/webpack')); runtime.init();
const webpack = runtime.webpack, { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const report = { baselineRevision, nextVersion: require(path.join(root, 'node_modules/next/package.json')).version,
  reactVersion, candidateSourceSha256: createHash('sha256').update(fs.readFileSync(path.join(root, 'src/components/notification-provider.tsx'))).digest('hex'),
  scope: 'Actual NotificationProvider / delayed SSR Template / restored device permission / explicit opt-out',
  externalRequests: 0, externalBusinessWrites: 0, cases: [] };
let server, browser, unread = 3, revokeResponse, localRevokes = 0;

async function build(variant, target) {
  const config = {
    mode: 'production', target,
    entry: path.join(fixture, target === 'web' ? 'client.tsx.fixture' : 'server.tsx.fixture'),
    output: { path: out, filename: `${variant}-${target}.cjs`, ...(target === 'node' ? { library: { type: 'commonjs2' } } : {}) },
    resolve: { extensions: ['.tsx.fixture', '.tsx', '.ts', '.js', '.json'], modules: [path.join(root, 'node_modules'), 'node_modules'], alias: {
      '@': path.join(root, 'src'), 'react$': path.join(compiled, 'react'),
      'react/jsx-runtime$': path.join(compiled, 'react/jsx-runtime.js'), 'react/jsx-dev-runtime$': path.join(compiled, 'react/jsx-dev-runtime.js'),
      'react-dom$': path.join(compiled, 'react-dom'), 'react-dom/client$': path.join(compiled, 'react-dom/client.js'),
      'react-dom/server$': path.join(compiled, 'react-dom/server.node.js'), 'scheduler$': path.join(compiled, 'scheduler'),
    } },
    module: { rules: [{ test: /\.tsx?(?:\.fixture)?$/, exclude: /node_modules/, use: {
      loader: path.join(fixture, 'ts-loader.cjs'), options: { variant, baselineDir: evidence },
    } }] },
    optimization: { minimize: false }, plugins: [new webpack.DefinePlugin({ 'process.env.NODE_ENV': JSON.stringify('production') })],
  };
  await new Promise((resolve, reject) => {
    const compiler = webpack(config);
    compiler.run((error, stats) => compiler.close(() => {
      if (error) reject(error);
      else if (stats.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })));
      else resolve();
    }));
  });
}

function json(res, value) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (['/old-web.cjs', '/new-web.cjs'].includes(url.pathname)) {
    res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(fs.readFileSync(path.join(out, path.basename(url.pathname)))); return;
  }
  if (url.pathname === '/api/notifications' && req.method === 'GET') {
    json(res, { items: [], unread, pending: 0, before: null, hasMore: false }); return;
  }
  if (url.pathname === '/api/notifications/push' && req.method === 'GET') {
    json(res, { accountId, available: false, subscription: null }); return;
  }
  if (url.pathname === '/api/notifications/push' && req.method === 'POST') {
    let body = ''; req.on('data', data => body += data); req.on('end', () => {
      try {
        const value = JSON.parse(body);
        assert.equal(value.action, 'revoke'); assert.equal(value.deviceId, deviceId);
        localRevokes++; revokeResponse = res; // Deliberately leave the remote acknowledgment pending.
      } catch (error) { report.serverFailure = error.message; res.writeHead(500); res.end(); }
    }); return;
  }
  if (url.pathname === '/' && req.method === 'GET' && ['old', 'new'].includes(url.searchParams.get('variant'))) {
    const variant = url.searchParams.get('variant'), filename = path.join(out, `${variant}-node.cjs`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    delete require.cache[require.resolve(filename)]; require(filename).stream(variant).pipe(res); return;
  }
  res.writeHead(404); res.end();
}

async function runCase(base, variant, restored, explicitEarly = false) {
  unread = 3; localRevokes = 0; revokeResponse = undefined;
  const context = await browser.newContext(); await context.grantPermissions(['notifications']);
  await context.addInitScript(({ storageKey, deviceId, restored }) => {
    localStorage.setItem(storageKey, JSON.stringify({ deviceId, enabled: restored }));
  }, { storageKey, deviceId, restored });
  const page = await context.newPage(), errors = [], requests = [];
  await page.route('**/*', async route => {
    if (!route.request().url().startsWith(base + '/')) { report.externalRequests++; await route.abort(); return; }
    await route.continue();
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push({ method: request.method(), path: new URL(request.url()).pathname }));
  try {
    await page.goto(`${base}/?variant=${variant}`);
    await page.waitForFunction(() => window.__trace?.length > 0);
    await page.waitForTimeout(350);
    const before = await page.evaluate(() => ({ serverTemplateConnected: !!window.__serverTemplate?.isConnected,
      clientReady: !!window.__templateReady, visibleTemplate: !!document.querySelector('[data-template]') }));
    assert.equal(before.clientReady, false);
    assert.equal(before.serverTemplateConnected, variant === 'new', 'background publication must preserve the exact SSR node');
    const versions = await page.evaluate(() => ({ server: window.__serverReactVersion, client: window.__clientReactVersion }));
    assert.equal(versions.server, expectedReactVersion); assert.equal(versions.client, expectedReactVersion);
    if (explicitEarly) {
      unread = 5;
      await page.getByRole('button', { name: 'Explicit refresh notifications', exact: true }).click();
      await page.locator('[data-live-unread]').filter({ hasText: /^5$/ }).waitFor({ timeout: 2000 });
      assert.equal(await page.evaluate(() => !!window.__templateReady), false);
      // A MouseEvent is truthy. If mistaken for background=true, this update
      // waits for Template and the immediate count assertion above fails.
    }
    await page.evaluate(() => window.__releaseTemplate());
    await page.locator('[data-current]').filter({ hasText: explicitEarly ? /^5$/ : /^3$/ }).waitFor();
    await page.locator('[data-enabled]').filter({ hasText: String(restored) }).waitFor();
    await page.locator('[data-permission]').filter({ hasText: 'granted' }).waitFor();
    const result = { variant, restored, explicitEarly, before, versions, latestUnreadApplied: true, restoredGrantApplied: true,
      explicitEventRefreshBeforeTemplateReady: explicitEarly || undefined };
    if (!restored) {
      await page.getByRole('button', { name: 'Explicit enable notifications', exact: true }).click();
      await page.locator('[data-enabled]').filter({ hasText: 'true' }).waitFor();
      result.explicitEnableApplied = true;
    }
    await page.getByRole('button', { name: 'Explicit disable notifications', exact: true }).click();
    await page.locator('[data-enabled]').filter({ hasText: 'false' }).waitFor();
    await page.waitForFunction(({ storageKey }) => JSON.parse(localStorage.getItem(storageKey)).enabled === false, { storageKey });
    // Observe the pending POST without waiting for its response: opt-out is local and immediate.
    for (let attempts = 0; !revokeResponse && attempts < 100; attempts++) await page.waitForTimeout(10);
    assert.ok(revokeResponse && !revokeResponse.writableEnded, 'local opt-out must precede the remote revoke acknowledgment');
    assert.equal(localRevokes, 1); json(revokeResponse, { ok: true }); revokeResponse = undefined;
    result.explicitDisableBeforeRevokeAck = true;
    unread = explicitEarly ? 7 : 5;
    await page.getByRole('button', { name: 'Explicit refresh notifications', exact: true }).click();
    await page.locator('[data-current]').filter({ hasText: explicitEarly ? /^7$/ : /^5$/ }).waitFor();
    result.explicitEventRefreshApplied = true;
    result.serverTemplatePreserved = await page.evaluate(() => !!window.__serverTemplate?.isConnected);
    if (variant === 'new' && !explicitEarly) assert.equal(result.serverTemplatePreserved, true);
    result.trace = await page.evaluate(() => window.__trace);
    result.recoverable = await page.evaluate(() => window.__recoverable); result.errors = errors; result.requests = requests;
    assert.deepEqual(result.recoverable, []); assert.deepEqual(errors, []);
    report.cases.push(result); console.log(JSON.stringify({ variant, restored, explicitEarly, before, versions,
      explicitDisableBeforeRevokeAck: true, latestUnreadApplied: true, explicitEventRefreshApplied: true }));
  } finally {
    if (revokeResponse && !revokeResponse.writableEnded) json(revokeResponse, { ok: true });
    revokeResponse = undefined; await context.close();
  }
}

async function main() {
  for (const variant of ['old', 'new']) { await build(variant, 'node'); await build(variant, 'web'); }
  server = http.createServer((req, res) => {
    try { handle(req, res); } catch (error) { report.serverFailure = error.message; res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  report.port = server.address().port; assert.ok(![3061, 3062, 3063].includes(report.port));
  const base = `http://127.0.0.1:${report.port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  for (const restored of [false, true]) for (const variant of ['old', 'new']) await runCase(base, variant, restored);
  await runCase(base, 'new', false, true);
  assert.equal(report.externalRequests, 0); assert.equal(report.serverFailure, undefined);
  report.passed = true; console.log('PASS_NOTIFICATION_STREAM_HYDRATION 5/5');
}
main().catch(error => { console.error(error.stack); report.failure = error.message; process.exitCode = 1; }).finally(async () => {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2));
});
