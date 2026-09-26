const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const markdownUrl = pathToFileURL(path.resolve(__dirname, "../../src/app/docs/markdown.js")).href;

test("published documentation keys follow the public guide allowlist", async () => {
  const { validKey, published, virtualFile } = await import(markdownUrl);
  for (const key of ["deploy/README.md", "deploy/users/README.md", "web/operations/DEPLOYMENT.md", "platform/guides/API.md", "sdk/guides/README.md"]) {
    assert.equal(validKey(key), true, key);
    const slash = key.indexOf("/");
    assert.equal(published(key.slice(0, slash), key.slice(slash + 1)), true, key);
  }
  assert.equal(virtualFile("platform/guides/API.md"), "agent-comm-platform/docs/guides/API.md");
  for (const key of ["deploy/../.env.md", "deploy/%2e%2e/README.md", "deploy//README.md", "javascript:alert(1)"]) {
    assert.equal(validKey(key), false, key);
  }
  for (const [repo, file] of [["deploy", "testing/RETEST_PLAN_2026-09-24.md"], ["sdk", "architecture/CAPABILITY_SKILL_MAP.md"], ["web", "internal/SECRETS.md"]]) {
    assert.equal(published(repo, file), false, `${repo}/${file}`);
  }
});

test("Markdown escapes active HTML and sends published relative links through the app reader", async () => {
  const { renderMarkdown } = await import(markdownUrl);
  const html = renderMarkdown([
    "# Guide <script>alert(1)</script>",
    "",
    "[Agent guide](../agents/README.md)",
    "[Unsafe](javascript:alert(1))",
    "![Unsafe image](data:image/svg+xml,<svg/onload=alert(1)>)",
    "",
    "```html",
    "<img src=x onerror=alert(1)>",
    "```",
  ].join("\n"), "deploy/users/README.md");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /href="\/docs\/\?path=deploy%2Fagents%2FREADME\.md"/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script|<img src=x|href="javascript:|src="data:/i);
});
