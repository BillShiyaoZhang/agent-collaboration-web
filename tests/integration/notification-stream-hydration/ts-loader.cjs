const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

module.exports = function(source) {
  const { variant, baselineDir } = this.getOptions();
  if (variant === 'old' && this.resourcePath.replaceAll('\\', '/').endsWith('/components/notification-provider.tsx')) {
    source = fs.readFileSync(path.join(baselineDir, 'baseline-notification.tsx'), 'utf8');
  }
  // The candidate is the actual production source. Do not rewrite its setters.
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
};
