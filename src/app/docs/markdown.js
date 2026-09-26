// Shared published-document rules and the existing escaped Markdown renderer.
// Keep the published paths aligned with deploy/nginx/nginx.conf.
const repositories = {
  deploy: { prefix: '', github: 'agent-collaboration-deploy', label: { zh: '项目与部署', en: 'Project and deployment' } },
  web: { prefix: 'agent-collaboration-web/', github: 'agent-collaboration-web', label: { zh: 'Web', en: 'Web' } },
  platform: { prefix: 'agent-comm-platform/', github: 'agent-comm-platform', label: { zh: 'Platform', en: 'Platform' } },
  sdk: { prefix: 'agent-comm-platform/agent-comm/', github: 'agent-comm', label: { zh: 'SDK / Runtime', en: 'SDK / Runtime' } }
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function validKey(value) {
  if (!/^(deploy|web|platform|sdk)\/[\w./-]+\.md$/.test(value || '')) return false;
  return value.split('/').every(part => part && part !== '.' && part !== '..');
}
function published(repo, file) {
  if (file === 'README.md') return true;
  if (repo === 'deploy') {
    if (/^(users|agents|developers|architecture|operations|maintenance)\//.test(file)) return true;
    return ['testing/TEST_STRATEGY.md', 'testing/TEST_EXECUTION_GUIDE.md', 'testing/TWO_AGENT_HITL_RUNBOOK.md'].includes(file);
  }
  if (repo === 'web') return /^(architecture|operations)\//.test(file);
  if (repo === 'platform') return /^(architecture|guides)\//.test(file);
  if (file === 'architecture/CAPABILITY_SKILL_MAP.md') return false;
  return /^(architecture|guides)\//.test(file);
}
function virtualFile(key) {
  const slash = key.indexOf('/');
  return `${repositories[key.slice(0, slash)].prefix}docs/${key.slice(slash + 1)}`;
}
function keyForVirtual(path) {
  const mappings = [
    ['sdk', 'agent-comm-platform/agent-comm/docs/'],
    ['platform', 'agent-comm-platform/docs/'],
    ['web', 'agent-collaboration-web/docs/'],
    ['deploy', 'docs/']
  ];
  for (const [repo, prefix] of mappings) {
    if (path.startsWith(prefix)) {
      const file = path.slice(prefix.length);
      if (published(repo, file) && validKey(`${repo}/${file}`)) return `${repo}/${file}`;
    }
  }
  return null;
}
function githubForVirtual(path, fragment = '') {
  let repo = 'deploy';
  for (const candidate of ['sdk', 'web', 'platform']) {
    if (path.startsWith(repositories[candidate].prefix)) { repo = candidate; break; }
  }
  const relative = path.slice(repositories[repo].prefix.length);
  return `https://github.com/BillShiyaoZhang/${repositories[repo].github}/blob/main/${relative.split('/').map(encodeURIComponent).join('/')}${fragment}`;
}
function readerHref(key, fragment = '') {
  return `/docs/?path=${encodeURIComponent(key)}${fragment}`;
}
function resolveLink(href, currentKey, image = false) {
  try {
    const value = href.trim();
    if (!value) return null;
    if (value.startsWith('#')) return image ? null : value;
    if (/^(https?:|mailto:)/i.test(value)) {
      const url = new URL(value);
      if (!image && url.hostname === 'github.com') {
        const match = url.pathname.match(/^\/BillShiyaoZhang\/(agent-collaboration-deploy|agent-collaboration-web|agent-comm-platform|agent-comm)\/blob\/main\/(.+\.md)$/);
        if (match) {
          const repo = Object.keys(repositories).find(name => repositories[name].github === match[1]);
          const file = decodeURIComponent(match[2]);
          const key = keyForVirtual(`${repositories[repo].prefix}${file}`);
          if (key) return readerHref(key, url.hash);
        }
      }
      return url.href;
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) return null;
    if (value.startsWith('/')) return value;
    const base = `https://workspace.invalid/${virtualFile(currentKey)}`;
    const target = new URL(value, base);
    const workspacePath = decodeURIComponent(target.pathname.slice(1));
    const key = keyForVirtual(workspacePath);
    if (key) return image ? `/docs/source/${key}` : readerHref(key, target.hash);
    return githubForVirtual(workspacePath, target.hash);
  } catch (_) { return null; }
}

function formattedText(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/\b_([^_\n]+)_\b/g, '<em>$1</em>');
}
function linkToken(value, start) {
  const image = value[start] === '!';
  const open = start + (image ? 1 : 0);
  if (value[open] !== '[') return null;
  let depth = 1, end = open + 1;
  for (; end < value.length; end++) {
    if (value[end] === '\\') { end++; continue; }
    if (value[end] === '[') depth++;
    if (value[end] === ']' && --depth === 0) break;
  }
  if (end >= value.length || value[end + 1] !== '(') return null;
  let level = 1, close = end + 2;
  for (; close < value.length; close++) {
    if (value[close] === '\\') { close++; continue; }
    if (value[close] === '(') level++;
    if (value[close] === ')' && --level === 0) break;
  }
  if (close >= value.length) return null;
  return { image, label: value.slice(open + 1, end), href: value.slice(end + 2, close).trim(), next: close + 1 };
}
function renderInline(value, currentKey) {
  let html = '', plain = '';
  const flush = () => { html += formattedText(plain); plain = ''; };
  for (let index = 0; index < value.length;) {
    if (value[index] === '`') {
      const run = value.slice(index).match(/^`+/)[0];
      const close = value.indexOf(run, index + run.length);
      if (close !== -1) {
        flush();
        html += `<code>${escapeHtml(value.slice(index + run.length, close))}</code>`;
        index = close + run.length;
        continue;
      }
    }
    if (value[index] === '[' || (value[index] === '!' && value[index + 1] === '[')) {
      const token = linkToken(value, index);
      if (token) {
        const target = resolveLink(token.href, currentKey, token.image);
        if (target) {
          flush();
          html += token.image
            ? `<img src="${escapeHtml(target)}" alt="${escapeHtml(token.label)}" loading="lazy">`
            : `<a href="${escapeHtml(target)}">${renderInline(token.label, currentKey)}</a>`;
          index = token.next;
          continue;
        }
      }
    }
    plain += value[index++];
  }
  flush();
  return html;
}
function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = []; let cell = '', escaped = false, inCode = false;
  for (const character of trimmed) {
    if (escaped) { cell += character; escaped = false; continue; }
    if (character === '\\') { escaped = true; cell += character; continue; }
    if (character === '`') inCode = !inCode;
    if (character === '|' && !inCode) { cells.push(cell.trim()); cell = ''; }
    else cell += character;
  }
  cells.push(cell.trim());
  return cells;
}
function tableDelimiter(line) {
  return splitTableRow(line).every(cell => /^:?-{3,}:?$/.test(cell));
}
function listMatch(line) {
  return line.match(/^(\s{0,3})([-+*]|\d+[.)])\s+(.*)$/);
}
function slug(value, counts) {
  const text = value.replace(/!?(\[([^\]]+)\]\([^)]*\))/g, '$2').replace(/[`*_~]/g, '').normalize('NFKC').toLowerCase();
  const base = text.replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
  const count = counts.get(base) || 0;
  counts.set(base, count + 1);
  return count ? `${base}-${count}` : base;
}
function renderMarkdown(markdown, currentKey, counts = new Map()) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  const isBlock = line => /^\s{0,3}(?:#{1,6}\s|>|`{3,}|~{3,}|(?:[-*_]\s*){3,}$)/.test(line) || !!listMatch(line);
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})([^`]*)$/);
    if (fence) {
      const marker = fence[1][0], length = fence[1].length;
      const language = fence[2].trim().split(/\s+/)[0].replace(/[^\w-]/g, '');
      const code = []; index++;
      while (index < lines.length && !new RegExp(`^\\s{0,3}${marker}{${length},}\\s*$`).test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index++;
      output.push(`<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level} id="${escapeHtml(slug(heading[2], counts))}">${renderInline(heading[2], currentKey)}</h${level}>`);
      index++; continue;
    }
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { output.push('<hr>'); index++; continue; }
    if (line.trimStart().startsWith('>')) {
      const quote = [];
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^\s{0,3}>\s?/, ''));
      output.push(`<blockquote>${renderMarkdown(quote.join('\n'), currentKey, counts)}</blockquote>`);
      continue;
    }
    if (index + 1 < lines.length && line.includes('|') && tableDelimiter(lines[index + 1])) {
      const headers = splitTableRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) rows.push(splitTableRow(lines[index++]));
      output.push(`<div class="table-scroll"><table><thead><tr>${headers.map(cell => `<th>${renderInline(cell, currentKey)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((_, cell) => `<td>${renderInline(row[cell] || '', currentKey)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const firstItem = listMatch(line);
    if (firstItem) {
      const ordered = /^\d/.test(firstItem[2]);
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      while (index < lines.length) {
        const item = listMatch(lines[index]);
        if (!item || /^\d/.test(item[2]) !== ordered || item[1].length !== firstItem[1].length) break;
        const body = [item[3]]; index++;
        while (index < lines.length) {
          const next = lines[index];
          const nextItem = listMatch(next);
          if (nextItem && nextItem[1].length === firstItem[1].length) break;
          if (!next.trim() && (index + 1 === lines.length || !/^\s{2,}\S/.test(lines[index + 1]))) break;
          if (next.trim() && !/^\s{2,}/.test(next)) break;
          body.push(next.replace(/^\s{2,}/, '')); index++;
        }
        items.push(`<li>${renderMarkdown(body.join('\n'), currentKey, counts)}</li>`);
        if (index < lines.length && !lines[index].trim()) { index++; if (!listMatch(lines[index] || '')) break; }
      }
      output.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    const paragraph = [line.trim()]; index++;
    while (index < lines.length && lines[index].trim() && !isBlock(lines[index]) && !(index + 1 < lines.length && lines[index].includes('|') && tableDelimiter(lines[index + 1]))) paragraph.push(lines[index++].trim());
    output.push(`<p>${renderInline(paragraph.join(' '), currentKey)}</p>`);
  }
  return output.join('\n');
}


export { repositories, validKey, published, virtualFile, githubForVirtual, renderMarkdown };
