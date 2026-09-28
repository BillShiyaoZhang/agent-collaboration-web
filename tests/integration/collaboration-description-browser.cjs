const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const fixture = path.join(__dirname, 'collaboration-description');
const output = path.join(root, 'build/workspace-sync-preview/collaboration-description');
const compiled = path.join(root, 'node_modules/next/dist/compiled');
const runtime = require(path.join(compiled, 'webpack/webpack'));
runtime.init();
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const webpack = runtime.webpack;
const key = (agent, urn) => `${agent}\0${urn}`;

async function build() {
  fs.mkdirSync(output, { recursive: true });
  const config = {
    mode: 'production', target: 'web', entry: path.join(fixture, 'client.tsx.fixture'),
    output: { path: output, filename: 'test.js' },
    resolve: { extensions: ['.tsx.fixture', '.ts.fixture', '.tsx', '.ts', '.js', '.json'],
      modules: [path.join(root, 'node_modules'), 'node_modules'], alias: {
        '@': path.join(root, 'src'),
        'next/link$': path.join(__dirname, 'content-review-version/link.tsx.fixture'),
        'react$': path.join(compiled, 'react'),
        'react/jsx-runtime$': path.join(compiled, 'react/jsx-runtime.js'),
        'react-dom$': path.join(compiled, 'react-dom'),
        'react-dom/client$': path.join(compiled, 'react-dom/client.js'),
        'scheduler$': path.join(compiled, 'scheduler'),
      } },
    module: { rules: [{ test: /\.tsx?(?:\.fixture)?$/, exclude: /node_modules/,
      use: { loader: path.join(__dirname, 'content-review-version/ts-loader.cjs'), options: { variant: 'new' } } }] },
    optimization: { minimize: false },
    plugins: [new webpack.DefinePlugin({ 'process.env.NODE_ENV': JSON.stringify('production') })],
  };
  await new Promise((resolve, reject) => {
    const compiler = webpack(config);
    compiler.run((error, stats) => compiler.close(() => error ? reject(error) : stats.hasErrors()
      ? reject(new Error(stats.toString({ all: false, errors: true }))) : resolve()));
  });
}

async function main() {
  await build();
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<div id="root"></div><script>window.process={env:{NODE_ENV:"production"}}</script><script src="/test.js"></script>'); }
    else if (req.url === '/test.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(fs.readFileSync(path.join(output, 'test.js'))); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
    await page.goto(base + '/');
    const select = page.getByRole('combobox', { name: '合作对象' });
    try { await select.waitFor({ timeout: 5000 }); }
    catch (error) { throw new Error(`GoalWorkflow did not render: ${JSON.stringify({ errors, body: (await page.locator('body').innerText()).slice(0, 500) })}`, { cause: error }); }
    assert.equal(await select.isDisabled(), true);
    const calls = () => page.evaluate(() => window.__harness.calls());
    await page.waitForFunction(() => window.__harness.calls().length === 1);
    for (let generation = 1; generation <= 4; generation++) {
      await page.evaluate(() => window.__harness.rerender());
      await page.waitForFunction(expected => window.__harness.generation === expected, generation);
    }
    assert.deepEqual(await calls(), [key('agent-a', 'urn:console:a')], 'Changing callback references must not restart describe');
    await page.evaluate(k => window.__harness.resolve(k, ['prepare_task', 'prepare_collaboration', 'dispatch']), key('agent-a', 'urn:console:a'));
    await page.waitForFunction(() => !document.querySelector('select[aria-label="合作对象"]').disabled);
    assert.equal(await select.isDisabled(), false, 'Real three-action description enables peer selection');
    await page.evaluate(() => window.__harness.setScope({ permission: false }));
    await page.waitForFunction(() => document.querySelector('select[aria-label="合作对象"]').disabled);
    assert.equal(await select.isDisabled(), true, 'Permission revocation hides previous actions');
    await page.evaluate(() => window.__harness.setScope({ permission: true }));
    await page.waitForFunction(() => window.__harness.calls().length === 2);
    assert.equal(await select.isDisabled(), true, 'Permission restoration requires a new description');
    await page.evaluate(() => window.__harness.setScope({ agent: 'agent-b', urn: 'urn:console:b' }));
    await page.waitForFunction(() => window.__harness.calls().length === 3);
    assert.equal(await select.isDisabled(), true, 'Agent switch cannot show prior agent actions');
    await page.evaluate(k => window.__harness.resolve(k, ['prepare_task', 'prepare_collaboration', 'dispatch']), key('agent-a', 'urn:console:a'));
    assert.equal(await select.isDisabled(), true, 'Late response from former agent is ignored');
    await page.evaluate(k => window.__harness.resolve(k, ['prepare_task', 'prepare_collaboration', 'dispatch']), key('agent-b', 'urn:console:b'));
    await page.waitForFunction(() => !document.querySelector('select[aria-label="合作对象"]').disabled);
    assert.equal(await select.isDisabled(), false);
    await page.evaluate(() => window.__harness.setScope({ policy: false }));
    await page.waitForFunction(() => document.querySelector('select[aria-label="合作对象"]').disabled);
    assert.equal(await select.isDisabled(), true, 'Policy revocation hides actions');
    await page.evaluate(() => window.__harness.setScope({ policy: true }));
    await page.waitForFunction(() => window.__harness.calls().length === 4);
    assert.equal(await select.isDisabled(), true, 'Policy restoration requires fresh description');
    await page.evaluate(() => window.__harness.setScope({ urn: 'urn:console:c' }));
    await page.waitForFunction(() => window.__harness.calls().length === 5);
    assert.equal(await select.isDisabled(), true, 'A different Console identity cannot reuse prior actions');
    await page.evaluate(k => window.__harness.resolve(k, ['prepare_task', 'prepare_collaboration', 'dispatch']), key('agent-b', 'urn:console:c'));
    await page.waitForFunction(() => !document.querySelector('select[aria-label="合作对象"]').disabled);
    assert.equal(await select.isDisabled(), false);
    await page.evaluate(() => window.__harness.setScope({ agent: 'agent-c', urn: 'urn:console:d' }));
    await page.waitForFunction(() => window.__harness.calls().length === 6);
    await page.evaluate(() => window.__harness.setScope({ agent: 'agent-b', urn: 'urn:console:c' }));
    await page.waitForFunction(() => window.__harness.calls().length === 7);
    assert.equal(await select.isDisabled(), true, 'Switching back cannot resurrect a settled description');
    await page.evaluate(k => window.__harness.resolve(k, ['prepare_task', 'prepare_collaboration', 'dispatch']), key('agent-c', 'urn:console:d'));
    assert.equal(await select.isDisabled(), true, 'An abandoned identity cannot enable the returned identity');
    await page.evaluate(k => window.__harness.resolve(k, ['prepare_task', 'prepare_collaboration', 'dispatch']), key('agent-b', 'urn:console:c'));
    await page.waitForFunction(() => !document.querySelector('select[aria-label="合作对象"]').disabled);
    assert.equal(await select.isDisabled(), false);
    assert.deepEqual(errors, []);
    console.log('PASS_COLLABORATION_DESCRIPTION_BROWSER 14 assertions, 0 page errors');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
