const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const routePath = path.resolve(__dirname, "../../src/app/docs/source/[repo]/[...path]/route.ts");
const compiled = ts.transpileModule(fs.readFileSync(routePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  fileName: routePath,
});
const routeModule = new Module(routePath, module);
routeModule.filename = routePath;
routeModule.paths = Module._nodeModulePaths(path.dirname(routePath));
routeModule._compile(compiled.outputText, routePath);
const route = routeModule.exports;

function context(repo, ...segments) {
  return { params: Promise.resolve({ repo, path: segments }) };
}

test("Next documentation source serves only published Markdown and never inherited repository names", { concurrency: false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-comm-docs-test-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-comm-private-test-"));
  const linkedFile = path.join(root, "deploy", "users", "linked.md");
  const previousRoot = process.env.DOCS_SOURCE_ROOT;
  process.env.DOCS_SOURCE_ROOT = root;
  try {
    for (const [repo, file, body] of [
      ["deploy", "users/README.md", "# User guide\n"],
      ["platform", "guides/API.md", "# API guide\n"],
      ["sdk", "architecture/PROTOCOL_V2.md", "# Protocol\n"],
      ["deploy", "testing/RETEST_PLAN_2026-09-24.md", "# Private history\n"],
      ["sdk", "architecture/CAPABILITY_SKILL_MAP.md", "# Private map\n"],
    ]) {
      const target = path.join(root, repo, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    }

    for (const [repo, segments, expected] of [
      ["deploy", ["users", "README.md"], "# User guide\n"],
      ["platform", ["guides", "API.md"], "# API guide\n"],
      ["sdk", ["architecture", "PROTOCOL_V2.md"], "# Protocol\n"],
    ]) {
      const response = await route.GET(new Request("https://example.invalid/docs/source"), context(repo, ...segments));
      assert.equal(response.status, 200, `${repo}/${segments.join("/")}`);
      assert.match(response.headers.get("content-type"), /^text\/plain/i);
      assert.equal(await response.text(), expected);
    }

    const head = await route.HEAD(new Request("https://example.invalid/docs/source"), context("deploy", "users", "README.md"));
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    for (const [repo, segments] of [
      ["deploy", ["testing", "RETEST_PLAN_2026-09-24.md"]],
      ["sdk", ["architecture", "CAPABILITY_SKILL_MAP.md"]],
      ["deploy", ["users", "..", "README.md"]],
      ["deploy", ["users", "private.txt"]],
      ["toString", ["README.md"]],
      ["__proto__", ["README.md"]],
      ["web", ["operations", "missing.md"]],
    ]) {
      const response = await route.GET(new Request("https://example.invalid/docs/source"), context(repo, ...segments));
      assert.equal(response.status, 404, `${repo}/${segments.join("/")}`);
    }

    const privateFile = path.join(outside, "private.md");
    fs.writeFileSync(privateFile, "# Must stay private\n");
    try {
      fs.symlinkSync(privateFile, linkedFile, "file");
      const response = await route.GET(new Request("https://example.invalid/docs/source"), context("deploy", "users", "linked.md"));
      assert.equal(response.status, 404, "published path must not follow a symlink outside the docs root");
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
      t.diagnostic(`symlink escape case skipped: ${error.code}`);
    }
  } finally {
    if (previousRoot === undefined) delete process.env.DOCS_SOURCE_ROOT;
    else process.env.DOCS_SOURCE_ROOT = previousRoot;
    fs.rmSync(linkedFile, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
