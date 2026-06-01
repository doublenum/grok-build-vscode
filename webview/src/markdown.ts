/*
 * Markdown → HTML renderer, ported verbatim from media/chat.js so the editor-tab
 * view formats assistant messages exactly like the sidebar: fenced code blocks
 * with a Copy button, inline `diff` fences with colored lines, GFM tables,
 * nested lists, headings, bold/italic, links, and clickable file-ref links.
 *
 * Output is a trusted HTML string (the agent's text is escaped before any markup
 * is added) consumed via dangerouslySetInnerHTML; clicks on .code-copy-btn /
 * a.file-ref-link / external links are handled by a delegated handler in App.tsx.
 */

const FILE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'mdx', 'toml', 'yml', 'yaml',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'xml', 'svg',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp',
  'cs', 'php', 'lua', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'txt', 'lock', 'env', 'ini', 'cfg', 'conf', 'gitignore', 'dockerignore',
  'vue', 'svelte', 'astro', 'sql', 'prisma', 'graphql', 'gql',
]);

export function looksLikeFileRef(s: string): boolean {
  if (!s || s.length > 200) return false;
  const core = s.replace(/[:#].*$/, '');
  if (/[\s"'`<>|&;]/.test(core)) return false;
  const m = core.match(/\.([A-Za-z0-9]+)$/);
  if (!m) return false;
  return FILE_EXTS.has(m[1].toLowerCase());
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const COPY_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>' +
  '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

function renderDiffCode(code: string): string {
  const lines = code.replace(/\n+$/, '').split('\n');
  const body = lines.map((ln) => {
    let cls = 'diff-line';
    if (/^@@/.test(ln)) cls += ' diff-hunk';
    else if (/^(\+\+\+|---|diff |index )/.test(ln)) cls += ' diff-meta';
    else if (ln[0] === '+') cls += ' diff-add';
    else if (ln[0] === '-') cls += ' diff-del';
    return `<span class="${cls}">${escapeHtml(ln) || '&nbsp;'}</span>`;
  }).join('');
  return `<code class="diff-code">${body}</code>`;
}

export function renderMarkdown(raw: string): string {
  const codeBlocks: string[] = [];
  let s = raw.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = codeBlocks.length;
    const isDiff = lang === 'diff';
    const inner = isDiff
      ? renderDiffCode(code)
      : `<code>${escapeHtml(code).trimEnd()}</code>`;
    codeBlocks.push(
      `<div class="code-block${isDiff ? ' diff' : ''}">` +
        '<button class="code-copy-btn" type="button" title="Copy code">' +
          `<span class="code-copy-glyph">${COPY_ICON}</span>` +
          '<span class="code-copy-label">Copy code</span>' +
        '</button>' +
        `<pre>${inner}</pre>` +
      '</div>',
    );
    return `\x00B${i}\x00`;
  });

  function inline(t: string): string {
    let s = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Stash code spans and links as placeholders BEFORE running emphasis, so a
    // literal "*" inside something like `research/*.cjs` or `plan-*` can't pair
    // with another "*" downstream and wrap the text between them in runaway <em>.
    const stash: string[] = [];
    const keep = (html: string) => `\x00C${stash.push(html) - 1}\x00`;
    s = s
      .replace(/`([^`\n]+)`/g, (_, code) => {
        if (looksLikeFileRef(code)) {
          const safe = code.replace(/"/g, '&quot;');
          return keep(`<a href="${safe}" class="file-ref-link"><code>${code}</code></a>`);
        }
        return keep(`<code>${code}</code>`);
      })
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
        const safe = url.replace(/"/g, '&quot;');
        return keep(`<a href="${safe}">${text}</a>`);
      })
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
      .replace(/\x00C(\d+)\x00/g, (_, i) => stash[+i]);
    return s;
  }

  // GFM tables: header row | separator row (|---|---|) | data rows
  const tables: string[] = [];
  {
    const isTableRow = (l: string) => /^\s*\|.+\|\s*$/.test(l);
    const isSep = (l: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(l);
    const splitRow = (l: string) =>
      l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const srcLines = s.split('\n');
    const kept: string[] = [];
    let i = 0;
    while (i < srcLines.length) {
      if (i + 1 < srcLines.length && isTableRow(srcLines[i]) && isSep(srcLines[i + 1])) {
        const headers = splitRow(srcLines[i]);
        const sepCells = splitRow(srcLines[i + 1]);
        if (headers.length === sepCells.length) {
          const aligns = sepCells.map((c) => {
            const L = c.startsWith(':'), R = c.endsWith(':');
            return L && R ? 'center' : R ? 'right' : L ? 'left' : '';
          });
          const rows: string[][] = [];
          let j = i + 2;
          while (j < srcLines.length && isTableRow(srcLines[j])) {
            const cells = splitRow(srcLines[j]);
            while (cells.length < headers.length) cells.push('');
            rows.push(cells.slice(0, headers.length));
            j++;
          }
          const styleFor = (k: number) => aligns[k] ? ` style="text-align:${aligns[k]}"` : '';
          let html = '<div class="md-table-wrap"><table><thead><tr>';
          headers.forEach((h, k) => { html += `<th${styleFor(k)}>${inline(h)}</th>`; });
          html += '</tr></thead><tbody>';
          for (const row of rows) {
            html += '<tr>';
            row.forEach((c, k) => { html += `<td${styleFor(k)}>${inline(c)}</td>`; });
            html += '</tr>';
          }
          html += '</tbody></table></div>';
          const idx = tables.length;
          tables.push(html);
          kept.push(`\x00T${idx}\x00`);
          i = j;
          continue;
        }
      }
      kept.push(srcLines[i]);
      i++;
    }
    s = kept.join('\n');
  }

  // Expand inline numbered lists: "1. A 2. B 3. C" on one line → separate lines
  function expandInline(line: string): string[] {
    if (!/^\s*\d+\. /.test(line)) return [line];
    const indent = line.match(/^(\s*)/)![1];
    const parts = line.trim().split(/(?<=\S)\s+(?=\d+\. )/);
    if (parts.length <= 1) return [line];
    const nums = parts.map((p) => parseInt(p.match(/^(\d+)\./)?.[1] ?? '0'));
    const sequential = nums.every((n, i) => n === i + 1);
    return sequential ? parts.map((p) => indent + p) : [line];
  }

  const rawLines = s.split('\n');
  const lines: string[] = [];
  for (const ln of rawLines) lines.push(...expandInline(ln));

  let out = '';
  let stack: { tag: 'ul' | 'ol'; indent: number; liOpen: boolean }[] = [];
  let pendingBreak = false;
  let lastWasBlock = false;
  let lastPara = false;

  function closeLiAt(i: number) {
    if (stack[i].liOpen) { out += '</li>'; stack[i].liOpen = false; }
  }
  function closeFrom(depth: number) {
    for (let i = stack.length - 1; i >= depth; i--) {
      closeLiAt(i);
      out += `</${stack[i].tag}>`;
    }
    stack = stack.slice(0, depth);
  }

  for (const line of lines) {
    if (!line.trim()) {
      if (stack.length === 0 && !lastWasBlock) pendingBreak = true;
      lastPara = false;
      continue;
    }
    lastWasBlock = false;

    const tm = line.trim().match(/^\x00T(\d+)\x00$/);
    if (tm) {
      closeFrom(0);
      out += `\x00T${tm[1]}\x00`;
      lastWasBlock = true;
      lastPara = false;
      pendingBreak = false;
      continue;
    }

    const hm = line.match(/^(#{1,3}) (.+)$/);
    if (hm) {
      closeFrom(0);
      out += `<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`;
      lastWasBlock = true;
      lastPara = false;
      pendingBreak = false;
      continue;
    }

    const lm = line.match(/^( *)([-*]|\d+\.) (.+)$/);
    if (lm) {
      const indent = lm[1].length;
      const isOl = /\d/.test(lm[2][0]);
      const tag: 'ul' | 'ol' = isOl ? 'ol' : 'ul';
      const content = lm[3];

      while (stack.length > 0 && stack[stack.length - 1].indent > indent) {
        closeLiAt(stack.length - 1);
        out += `</${stack[stack.length - 1].tag}>`;
        stack.pop();
      }

      if (stack.length === 0 || stack[stack.length - 1].indent < indent) {
        out += `<${tag}>`;
        stack.push({ tag, indent, liOpen: false });
      } else {
        closeLiAt(stack.length - 1);
        if (stack[stack.length - 1].tag !== tag) {
          out += `</${stack[stack.length - 1].tag}><${tag}>`;
          stack[stack.length - 1].tag = tag;
        }
      }

      out += `<li>${inline(content)}`;
      stack[stack.length - 1].liOpen = true;
      lastPara = false;
      pendingBreak = false;
      continue;
    }

    closeFrom(0);
    if (pendingBreak) { out += '<br><br>'; pendingBreak = false; }
    else if (lastPara) out += '<br>';
    out += inline(line);
    lastPara = true;
  }

  closeFrom(0);
  return out
    .replace(/\x00B(\d+)\x00/g, (_, i) => codeBlocks[+i])
    .replace(/\x00T(\d+)\x00/g, (_, i) => tables[+i]);
}
