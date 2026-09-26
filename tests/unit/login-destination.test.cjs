const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const ts = require("typescript");

const filename = path.resolve(__dirname, "../../src/lib/auth/login-destination.ts");
const loaded = new Module(filename, module);
loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { safeLoginDestination } = loaded.exports;

test("login destinations reject executable schemes, external URLs and browser slash tricks", () => {
  for (const input of [
    "javascript:alert(document.domain)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>",
    "https://attacker.example/", "http://attacker.example/", "//attacker.example/", "///attacker.example/",
    "/\\attacker.example/", "/dashboard\\../\\attacker.example", "\n//attacker.example", "/\t/attacker.example/",
    " javascript:alert(1)", "https://internal.invalid/dashboard", "dashboard/agents", "", null, undefined,
  ]) assert.equal(safeLoginDestination(input), "/dashboard", String(input));
});

test("login preserves legitimate internal destinations, query values and fragments", () => {
  for (const input of ["/", "/dashboard", "/dashboard/agents", "/dashboard/agents/abc?view=inbox#latest", "/dashboard?query=https%3A%2F%2Fexample.com"]) {
    assert.equal(safeLoginDestination(input), input);
  }
  assert.equal(safeLoginDestination("/dashboard/../dashboard/agents"), "/dashboard/agents");
});
