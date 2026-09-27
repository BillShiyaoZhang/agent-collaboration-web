const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

function load(relative, dependencies = {}) {
  const filename = path.resolve(__dirname, relative), loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : Module.prototype.require.call(loaded, name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, filename);
  return loaded.exports;
}
const link = ({ children, ...props }) => React.createElement("a", props, children);
const support = load("../../src/lib/shared/support-email.ts");
const copy = load("../../src/app/privacy/privacy-copy.ts");
const navigation = load("../../src/components/public/public-navigation.tsx", {
  "next/link": link, "./public-navigation.css": {}, "@/lib/shared/support-email": support,
});
const { PrivacyDocument } = load("../../src/app/privacy/privacy-content.tsx", {
  "next/link": link, "./privacy-copy": copy, "@/components/public/public-navigation": navigation,
  "@/lib/shared/support-email": support,
});

test("both policy languages render readable sections and complete keyboard destinations without a session", () => {
  const ids = language => copy.privacyCopy[language].sections.map(section => section.id);
  assert.deepEqual(ids("zh"), ids("en"));
  for (const language of ["zh", "en"]) {
    const html = renderToStaticMarkup(React.createElement(PrivacyDocument, { language }));
    assert.match(html, /<main id="main"[^>]*tabindex="-1"/);
    assert.match(html, new RegExp(`lang="${language === "zh" ? "zh-CN" : "en"}"`));
    for (const id of ids(language)) {
      assert.match(html, new RegExp(`href="#${id}"`));
      assert.match(html, new RegExp(`id="${id}"[^>]*tabindex="-1"`));
    }
    assert.match(html, /href="\/dashboard\/settings"/);
    assert.match(html, /href="https:\/\/github.com\/BillShiyaoZhang\/agent-collaboration-deploy\/issues"/);
    assert.match(html, /href="mailto:support@agent-communication.online"/);
  }
});

test("privacy contact uses a validated optional public address", () => {
  const render = supportEmail => renderToStaticMarkup(React.createElement(PrivacyDocument, { language: "en", supportEmail }));
  assert.match(render("support@example.invalid"), /href="mailto:support@example.invalid"/);
  assert.doesNotMatch(render("support@example.invalid"), /mailto:support@agent-communication.online/);
  assert.doesNotMatch(render("support@example.invalid?bcc=other@example.invalid"), /mailto:support@example.invalid/);
  assert.match(render("support@example.invalid?bcc=other@example.invalid"), /mailto:support@agent-communication.online/);
});

test("public navigation and both footer languages expose the policy and mark its current page", () => {
  for (const language of ["zh", "en"]) {
    const header = renderToStaticMarkup(React.createElement(navigation.PublicNavigation, { current: "privacy", language, onLanguageChange: () => {} }));
    const footer = renderToStaticMarkup(React.createElement(navigation.PublicFooter, { language }));
    assert.match(header, /href="\/privacy" aria-current="page"/);
    assert.match(footer, /href="\/privacy"/);
  }
});

test('both public content standards languages provide readable rules and exact review/report destinations', () => {
 const community = load('../../src/app/community/community-copy.ts');
 const { CommunityDocument } = load('../../src/app/community/community-content.tsx', { 'next/link': link, './community-copy': community, '@/components/public/public-navigation': navigation, '@/lib/shared/support-email': support });
 for (const language of ['zh','en']) {
  const html = renderToStaticMarkup(React.createElement(CommunityDocument, { language }));
  assert.match(html, /<main id="main"[^>]*tabindex="-1"/); assert.match(html, /href="\/dashboard\/content-review"/); assert.match(html, /href="\/dashboard\/reports"/); assert.match(html, /href="\/privacy"/);
  for(const section of community.communityCopy[language].sections) { assert.ok(html.includes('href="#'+section.id+'"')); assert.ok(html.includes('id="'+section.id+'"')); }
 }
 assert.deepEqual(community.communityCopy.zh.sections.map(section=>section.id),community.communityCopy.en.sections.map(section=>section.id));
});
