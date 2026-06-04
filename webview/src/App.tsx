import React, { useEffect, useReducer, useRef, useState, useCallback } from 'react';
import {
  History, SquarePen, Plus, Slash, Zap, ChevronDown, ChevronRight,
  ArrowUp, Square, X, Pencil, Trash2, Loader2,
  Settings, Upload, AtSign, Bot, ListTree, Check, ArrowLeft, ArrowRight,
  Terminal, RefreshCw, Copy, CircleCheck, Circle, CircleDot, CircleSlash,
  CornerDownRight,
} from 'lucide-react';
import './app.css';
import { renderMarkdown } from './markdown';

/*
 * Editor-tab chat surface.
 *
 * Visual model mirrors the Claude Code webview (title bar with history + new
 * chat, centered brand, centered empty state, bottom composer with a rounded
 * focus ring and circular send button) and the transcript "propagation" style
 * (dot-gutter steps, collapsed Thinking rows, tool calls with expandable
 * IN/OUT). Two intentional differences from Claude Code:
 *   - colors come from VS Code theme tokens (see app.css) per the webview UX
 *     guidelines, so the focus ring + send button are the workbench blue/white
 *     accent rather than a fixed orange;
 *   - "Thinking" rows are click-to-expand.
 *
 * It talks to the same host (sidebar.ts) over the existing message protocol, so
 * the conversation stays in sync with the sidebar view. The reducer below is
 * the important part for session switching: clearMessages / agentReset /
 * historyReplay reset and rebuild the transcript exactly the way media/chat.js
 * does, including suppressing the extension primer turn during replay.
 */

// ---------- host bridge ----------

declare const acquireVsCodeApi: () => { postMessage: (m: unknown) => void };
let vscode: { postMessage: (m: unknown) => void };
try {
  vscode = acquireVsCodeApi();
} catch {
  vscode = { postMessage: (m: unknown) => console.log('[vscode stub]', m) };
}

// Delegated clicks inside rendered markdown (assistant text, plan bodies):
// Copy-code buttons, file-ref links (open in editor), external links — mirrors
// the sidebar's document click handler so behavior matches exactly. Module-level
// because it only touches the vscode bridge, so every markdown surface shares it.
function handleMarkdownClick(e: React.MouseEvent<HTMLElement>): void {
  const target = e.target as HTMLElement;
  const copyBtn = target.closest('.code-copy-btn') as HTMLElement | null;
  if (copyBtn) {
    e.preventDefault();
    const codeEl = copyBtn.parentElement?.querySelector('pre code') as HTMLElement | null;
    const text = codeEl ? codeEl.innerText : '';
    navigator.clipboard?.writeText(text).then(() => {
      const label = copyBtn.querySelector('.code-copy-label');
      const prev = label?.textContent ?? '';
      if (label) label.textContent = 'Copied';
      copyBtn.classList.add('copied');
      setTimeout(() => { if (label) label.textContent = prev; copyBtn.classList.remove('copied'); }, 1500);
    });
    return;
  }
  const a = target.closest('a[href]') as HTMLAnchorElement | null;
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href') || '';
  if (/^https?:\/\//i.test(href)) {
    vscode.postMessage({ type: 'openUrl', url: href });
  } else if (/^[a-zA-Z]:[\\/]/.test(href) || href.startsWith('\\\\') || !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    vscode.postMessage({ type: 'openFile', path: href });
  }
}

function baseName(p: string): string {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || 'plan.md';
}

// Copy-to-clipboard with brief "Copied" feedback on the clicked button.
function copyWithFeedback(text: string, btn: HTMLElement) {
  navigator.clipboard?.writeText(text).then(() => {
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  });
}

// ---------- types ----------

interface Img { dataUrl: string; name?: string }
interface Chip { id: string; relPath: string; path: string; hidden?: boolean }
interface QueuedMsg { text: string; chips: Chip[]; images: Img[] }
interface SessionEntry {
  id: string;
  displayName: string;
  rawSummary?: string;
  numMessages: number;
  updatedAt: number;
}

type Item =
  | { kind: 'user'; id: string; text: string; images?: Img[]; chips?: Chip[] }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'thought'; id: string; text: string; open: boolean; live: boolean }
  | { kind: 'tool'; id: string; toolCallId?: string; raw: any; open: boolean }
  | { kind: 'error'; id: string; text: string }
  | { kind: 'permission'; id: string; reqId: string | number; title: string; diff: ToolDiff | null; options: { name: string; kind?: string; optionId: string }[]; chosen?: string }
  | { kind: 'plan'; id: string; reqId: string | number; plan: string; planPath?: string; planName?: string; verdict?: string }
  | { kind: 'planHistory'; id: string; text: string; verdict?: string; planPath?: string; planName?: string }
  | { kind: 'planNotice'; id: string; text: string }
  | { kind: 'sessionContext'; id: string }
  | { kind: 'question'; id: string; reqId: string | number; question: string; options: { label: string; description?: string; optionId?: string }[]; multiSelect?: boolean; answered?: string[] };

const VERDICT_LABEL: Record<string, string> = { approved: 'Approved', rejected: 'Rejected', abandoned: 'Cancelled' };

// The host replays its own primer prompt (and grok's ack) when loading a
// session; both are plumbing the user never typed, so hide them on replay.
const PRIMER_PATTERN = /^\s*\[grok-build-vscode primer v\d+\]/;
const PLAN_MARKER_PATTERN = /^\s*\[Plan (approved|rejected|cancelled)\]\s*/i;

// ---------- tool-call display helpers (ported from media/chat.js) ----------

function toolName(call: any): string { return call?.tool || call?.name || call?.title || ''; }
function rawInput(call: any): Record<string, any> { return call?.rawInput || call?.input || {}; }
function toolFilePath(call: any): string {
  const r = rawInput(call);
  return r.target_file || r.filePath || r.file_path || r.path || (Array.isArray(r.paths) ? r.paths[0] : '') || '';
}
function prettyPath(p: string): string {
  if (!p) return '';
  if (p === '.' || p === './') return 'root folder';
  return p.split('/').pop() || p;
}
function cap(s: string): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// grok identifies its tools via rawInput.variant ("Grep", "TodoWrite", "Read"…),
// while tool/name/title may carry the raw query or pattern. Prefer the variant
// for classifying; fall back to the tool/name field. Lowercased for matching.
function toolKey(call: any): string {
  const v = rawInput(call).variant;
  if (typeof v === 'string' && v) return v.toLowerCase();
  return toolName(call).toLowerCase();
}

// grok's write/edit family (write_file, edit, str_replace, multiedit…). Shared by
// the heading/label logic and by groupItems, which pulls these out of the generic
// tool group so each file change renders as its own diff card.
const EDIT_TOOL_RE = /^(write|write_file|file_write|edit|edit_file|search_replace|searchreplace|str_replace|multiedit)$/;
function isEditCall(call: any): boolean {
  return call?.kind === 'edit' || EDIT_TOOL_RE.test(toolKey(call));
}

function toolHeading(call: any): string {
  const n = toolKey(call);
  if (call?.kind === 'read' || /^(read|read_file|file_read|list_dir|list_directory|listdir|ls)$/.test(n)) return 'Read';
  if (isEditCall(call)) return 'Edit';
  if (call?.kind === 'execute' || /^(bash|execute|run_command|run_terminal_command|shell|run_bash)$/.test(n)) return 'Bash';
  if (/^(web_search|search_web|websearch)$/.test(n)) return 'Search';
  if (/^(web_fetch|webfetch)$/.test(n)) return 'Fetch';
  if (/^(grep|ripgrep|search_files)$/.test(n)) return 'Grep';
  // Prefer a clean variant label ("List", "Glob") over a title that may be the
  // raw search pattern grok stuffs into the title field.
  const v = rawInput(call).variant;
  if (typeof v === 'string' && v) return v;
  return toolName(call) ? cap(toolName(call)) : 'Tool';
}

function toolDesc(call: any): string {
  const r = rawInput(call);
  const key = toolKey(call);
  // Search tools: the pattern/query is the meaningful summary, not the path.
  if (/^(grep|ripgrep|search_files)$/.test(key) && r.pattern) return String(r.pattern);
  const fp = toolFilePath(call);
  const cmd = r.command || r.cmd;
  if (fp) {
    const base = prettyPath(fp);
    const isRead = /^(read|read_file|file_read)$/.test(key);
    if (isRead && r.offset != null && r.limit != null) {
      return `${base} (lines ${r.offset}-${Number(r.offset) + Number(r.limit) - 1})`;
    }
    return base;
  }
  if (cmd) return String(cmd);
  if (r.query) return String(r.query);
  if (r.pattern) return String(r.pattern);
  if (r.url) return String(r.url);
  const t = call?.title;
  return t && t !== toolName(call) ? t : '';
}

// ---------- todo (TodoWrite) helpers ----------

type TodoStatus = 'completed' | 'in_progress' | 'pending' | 'cancelled';
interface TodoEntry { id?: string; content: string; status: TodoStatus }

// Shared extractor so isTodoCall and rendering agree on what counts as a
// TodoWrite (input variant/todos, or output TodosUpdated, or name match).
function getTodoList(call: any): TodoEntry[] | null {
  // Output side (authoritative merged state from the tool) may carry the list
  // under TodosUpdated.todos (or bare todos). Fall back to input.
  const out = call?.rawOutput ?? call?.output;
  const fromOut = out?.TodosUpdated?.todos ?? out?.todos;
  if (Array.isArray(fromOut)) return fromOut as TodoEntry[];
  const r = rawInput(call);
  if (Array.isArray(r?.todos)) return r.todos as TodoEntry[];
  return null;
}

// Treat anything that carries TodoWrite data (by variant, explicit todos list,
// or output payload) or whose tool name mentions "todo" as a todo list for
// special rendering + last-revision collapsing.
function isTodoCall(call: any): boolean {
  if (getTodoList(call) !== null) return true;
  const r = rawInput(call);
  if (r?.variant === 'TodoWrite') return true;
  const n = toolName(call).toLowerCase();
  return /todo/.test(n);
}

// grok has no first-class subagent construct over ACP — a delegation surfaces as
// an ordinary tool_call named "task" carrying { subagent_type, description,
// prompt, isolation }. Key on subagent_type (unambiguous) so we don't misfire on
// a grep/search whose *pattern* merely contains the word "subagent".
function isSubagentCall(call: any): boolean {
  const r = rawInput(call);
  if (r && typeof r.subagent_type === 'string') return true;
  const n = toolName(call).toLowerCase();
  return (n === 'task' || n === 'subagent' || n === 'agent') && typeof r?.prompt === 'string';
}

function extractTodos(call: any): TodoEntry[] {
  return getTodoList(call) ?? [];
}

// Present-tense label for the in-progress tool-group header (ported from
// media/chat.js inProgressLabel) — e.g. "Reading sidebar.ts", "Running command".
function inProgressLabel(call: any): string {
  const name = toolKey(call);
  const fp = toolFilePath(call);
  if (isSubagentCall(call)) {
    const t = rawInput(call).subagent_type;
    return typeof t === 'string' && t ? `Running subagent (${t})` : 'Running subagent';
  }
  if (/^(list_dir|list_directory|listdir|ls)$/.test(name)) return fp ? `Listing ${prettyPath(fp)}` : 'Listing files';
  if (/^(read|read_file|file_read)$/.test(name) || call?.kind === 'read') return fp ? `Reading ${prettyPath(fp)}` : 'Reading file';
  if (/^(web_search|search_web|websearch)$/.test(name)) return 'Searching web';
  if (/^(web_fetch|webfetch)$/.test(name)) return 'Fetching page';
  if (/^(grep|ripgrep|search_files)$/.test(name)) return 'Searching code';
  if (isEditCall(call)) return fp ? `Editing ${prettyPath(fp)}` : 'Editing file';
  if (/^(bash|execute|run_command|run_terminal_command|shell|run_bash)$/.test(name) || call?.kind === 'execute') return 'Running command';
  const v = rawInput(call).variant;
  if (typeof v === 'string' && v) return `Running ${v}`;
  return toolName(call) ? `Running ${toolName(call)}` : 'Running tool';
}

function toolInput(call: any): string {
  const r = rawInput(call);
  if (r.command || r.cmd) return String(r.command || r.cmd);
  const keys = Object.keys(r);
  if (!keys.length) return '';
  if (keys.length === 1 && typeof r[keys[0]] === 'string') return r[keys[0]];
  try { return JSON.stringify(r, null, 2); } catch { return ''; }
}

function toolOutput(call: any): string {
  const c = call?.content;
  if (Array.isArray(c)) {
    const texts = c.map((it: any) => {
      if (typeof it === 'string') return it;
      if (it?.type === 'diff') {
        const oldN = (it.oldText || '').split('\n').length;
        const newN = (it.newText || '').split('\n').length;
        return `${it.path || ''}  (${oldN} → ${newN} lines)`;
      }
      return it?.text || it?.content?.text || '';
    }).filter(Boolean);
    if (texts.length) return texts.join('\n');
  }
  if (typeof call?.rawOutput === 'string') return call.rawOutput;
  if (call?.rawOutput) { try { return JSON.stringify(call.rawOutput, null, 2); } catch { /* ignore */ } }
  return '';
}

// Pull the {path, oldText, newText} diff a write/edit tool reports in its
// content array (the host forwards it verbatim from grok's tool result).
interface ToolDiff { path: string; oldText: string; newText: string }
function toolDiff(call: any): ToolDiff | null {
  const c = call?.content;
  if (!Array.isArray(c)) return null;
  for (const it of c) {
    if (it?.type === 'diff' && (it.oldText != null || it.newText != null)) {
      return { path: it.path || toolFilePath(call), oldText: it.oldText || '', newText: it.newText || '' };
    }
  }
  return null;
}

// Minimal LCS line diff → unified rows, so Edit cards render the Claude Code
// look (context lines plus red removals / green additions) instead of a flat
// before/after dump. O(n·m) is fine for the small hunks tools touch.
type DiffRow = { type: 'ctx' | 'add' | 'del'; text: string };
function computeLineDiff(oldText: string, newText: string): DiffRow[] {
  const a = oldText.replace(/\n$/, '').split('\n');
  const b = newText.replace(/\n$/, '').split('\n');
  const n = a.length, m = b.length;
  // LCS table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ type: 'ctx', text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { rows.push({ type: 'del', text: a[i] }); i++; }
    else { rows.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) { rows.push({ type: 'del', text: a[i] }); i++; }
  while (j < m) { rows.push({ type: 'add', text: b[j] }); j++; }
  return rows;
}

// ---------- transcript reducer ----------

interface TState {
  items: Item[];
  seq: number;
  replaying: boolean;
  suppress: boolean;        // suppress the primer turn during replay
  activeAssistant: string | null;
  activeThought: string | null;
  activeUser: string | null;
  diffs: Record<string, ToolDiff>;   // pending tool diffs by toolCallId (for permission cards)
}

const INITIAL: TState = {
  items: [], seq: 0, replaying: false, suppress: false,
  activeAssistant: null, activeThought: null, activeUser: null, diffs: {},
};

type Action =
  | { t: 'reset' }
  | { t: 'replay'; active: boolean }
  | { t: 'agentReset' }
  | { t: 'messageChunk'; text: string }
  | { t: 'thoughtChunk'; text: string }
  | { t: 'userChunk'; text: string }
  | { t: 'userMessage'; text: string; images?: Img[]; chips?: Chip[] }
  | { t: 'toolCall'; call: any }
  | { t: 'toolUpdate'; call: any }
  | { t: 'commit' }
  | { t: 'error'; text: string }
  | { t: 'toggle'; id: string }
  | { t: 'permission'; req: any }
  | { t: 'permissionResolved'; id: string; chosen: string }
  | { t: 'plan'; req: any }
  | { t: 'planResolved'; id: string; verdict: string }
  | { t: 'planHistory'; text: string; verdict?: string; planPath?: string; planName?: string }
  | { t: 'planNotice'; text: string }
  | { t: 'sessionContext' }
  | { t: 'question'; req: any }
  | { t: 'questionAnswered'; id: string; answered: string[] };

// Finalize the in-flight agent turn: stamp the live thought as committed,
// settle any tool still showing a running spinner (in case the final
// toolCallUpdate never arrives), and drop the active-element handles.
function commitTurn(s: TState): TState {
  const items = s.items.map((it) => {
    if (it.kind === 'thought' && it.id === s.activeThought) return { ...it, live: false };
    if (it.kind === 'tool') {
      const st = it.raw?.status;
      if (st && st !== 'completed' && st !== 'failed') return { ...it, raw: { ...it.raw, status: 'completed' } };
    }
    return it;
  });
  return { ...s, items, activeAssistant: null, activeThought: null, activeUser: null };
}

function reducer(s: TState, a: Action): TState {
  switch (a.t) {
    case 'reset':
      return { ...INITIAL, seq: s.seq };

    case 'replay':
      if (a.active) return { ...s, replaying: true, suppress: false };
      return { ...commitTurn(s), replaying: false, suppress: false };

    case 'agentReset': {
      // Drop the in-flight agent bubble (used after Reject to suppress a leaked
      // false-approval response); keep prior thoughts/tools intact.
      const items = s.activeAssistant ? s.items.filter((it) => it.id !== s.activeAssistant) : s.items;
      return { ...s, items, activeAssistant: null, activeThought: null };
    }

    case 'messageChunk': {
      if (s.suppress) return s;
      const cur = s.activeAssistant && s.items.find((it) => it.id === s.activeAssistant);
      if (cur && cur.kind === 'assistant') {
        return {
          ...s,
          activeUser: null,
          items: s.items.map((it) => (it.id === s.activeAssistant ? { ...it, text: (it as any).text + a.text } : it)),
        };
      }
      const id = `a${s.seq}`;
      return {
        ...s, seq: s.seq + 1, activeAssistant: id, activeUser: null,
        items: [...s.items, { kind: 'assistant', id, text: a.text }],
      };
    }

    case 'thoughtChunk': {
      if (s.suppress) return s;
      const cur = s.activeThought && s.items.find((it) => it.id === s.activeThought);
      if (cur && cur.kind === 'thought') {
        return {
          ...s,
          activeUser: null,
          items: s.items.map((it) => (it.id === s.activeThought ? { ...it, text: (it as any).text + a.text } : it)),
        };
      }
      const id = `t${s.seq}`;
      return {
        ...s, seq: s.seq + 1, activeThought: id, activeUser: null,
        items: [...s.items, { kind: 'thought', id, text: a.text, open: false, live: true }],
      };
    }

    case 'userChunk': {
      // Replayed user prompt. Commit any in-flight agent turn, then accumulate.
      let st = (s.activeAssistant || s.activeThought) ? commitTurn(s) : s;
      let text = a.text;
      if (!st.activeUser) {
        if (st.replaying && PRIMER_PATTERN.test(text)) {
          return { ...st, suppress: true };
        }
        st = { ...st, suppress: false };
        const mk = PLAN_MARKER_PATTERN.exec(text);
        if (mk) {
          const rest = text.slice(mk[0].length);
          if (!rest.trim()) return st;   // marker-only verdict: render nothing
          text = rest;
        }
        const id = `u${st.seq}`;
        return {
          ...st, seq: st.seq + 1, activeUser: id,
          items: [...st.items, { kind: 'user', id, text }],
        };
      }
      if (st.suppress) return st;
      return { ...st, items: st.items.map((it) => (it.id === st.activeUser ? { ...it, text: (it as any).text + text } : it)) };
    }

    case 'userMessage': {
      // Live send echoed by the host. Commit any in-flight turn, then add it.
      const st = (s.activeAssistant || s.activeThought) ? commitTurn(s) : s;
      const id = `u${st.seq}`;
      return {
        ...st, seq: st.seq + 1, activeUser: null, suppress: false,
        items: [...st.items, { kind: 'user', id, text: a.text, images: a.images, chips: a.chips }],
      };
    }

    case 'toolCall': {
      if (s.suppress) return s;
      const id = `k${s.seq}`;
      return {
        ...s, seq: s.seq + 1,
        items: [...s.items, { kind: 'tool', id, toolCallId: a.call?.toolCallId, raw: a.call, open: false }],
      };
    }

    case 'toolUpdate': {
      if (s.suppress) return s;
      const tcid = a.call?.toolCallId;
      if (!tcid) return s;
      const d = toolDiff(a.call);
      const diffs = d ? { ...s.diffs, [tcid]: d } : s.diffs;
      return {
        ...s,
        diffs,
        items: s.items.map((it) => {
          if (it.kind !== 'tool' || it.toolCallId !== tcid) return it;
          const merged = { ...it.raw, ...a.call, content: a.call?.content ?? it.raw?.content };
          return { ...it, raw: merged };
        }),
      };
    }

    case 'commit':
      return commitTurn(s);

    case 'error': {
      const st = commitTurn(s);
      const id = `e${st.seq}`;
      return { ...st, seq: st.seq + 1, items: [...st.items, { kind: 'error', id, text: a.text }] };
    }

    case 'toggle':
      return {
        ...s,
        items: s.items.map((it) =>
          it.id === a.id && (it.kind === 'thought' || it.kind === 'tool') ? { ...it, open: !it.open } : it),
      };

    case 'permission': {
      if (s.suppress) return s;
      // Commit the in-flight turn so grok's post-approval continuation streams
      // into a NEW bubble BELOW the card, not back into the bubble above it.
      const st = commitTurn(s);
      const req = a.req || {};
      const tcid = req.toolCall?.toolCallId;
      const id = `p${st.seq}`;
      return {
        ...st, seq: st.seq + 1,
        items: [...st.items, {
          kind: 'permission', id,
          reqId: req.id,
          title: req.toolCall?.title || `permission: ${req.toolCall?.kind || 'tool'}`,
          diff: (tcid && st.diffs[tcid]) || null,
          options: req.options || [],
        }],
      };
    }

    case 'permissionResolved':
      return {
        ...s,
        items: s.items.map((it) => (it.kind === 'permission' && it.id === a.id ? { ...it, chosen: a.chosen } : it)),
      };

    case 'plan': {
      const st = commitTurn(s);
      const req = a.req || {};
      const id = `pl${st.seq}`;
      return {
        ...st, seq: st.seq + 1,
        items: [...st.items, {
          kind: 'plan', id, reqId: req.id, plan: req.plan || '', planPath: req.planPath, planName: req.planName,
        }],
      };
    }

    case 'planResolved':
      return {
        ...s,
        items: s.items.map((it) => (it.kind === 'plan' && it.id === a.id ? { ...it, verdict: a.verdict } : it)),
      };

    case 'planHistory': {
      const id = `ph${s.seq}`;
      return {
        ...s, seq: s.seq + 1,
        items: [...s.items, { kind: 'planHistory', id, text: a.text, verdict: a.verdict, planPath: a.planPath, planName: a.planName }],
      };
    }

    case 'planNotice': {
      const id = `pn${s.seq}`;
      return { ...s, seq: s.seq + 1, items: [...s.items, { kind: 'planNotice', id, text: a.text }] };
    }

    case 'sessionContext': {
      const id = `sc${s.seq}`;
      return { ...s, seq: s.seq + 1, items: [...s.items, { kind: 'sessionContext', id }] };
    }

    case 'question': {
      const st = commitTurn(s);
      const req = a.req || {};
      const id = `q${st.seq}`;
      return {
        ...st, seq: st.seq + 1,
        items: [...st.items, {
          kind: 'question', id, reqId: req.id,
          question: req.question || '', options: req.options || [], multiSelect: !!req.multiSelect,
        }],
      };
    }

    case 'questionAnswered':
      return {
        ...s,
        items: s.items.map((it) => (it.kind === 'question' && it.id === a.id ? { ...it, answered: a.answered } : it)),
      };

    default:
      return s;
  }
}

// ---------- small components ----------

function GrokMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M2.30047 8.77631L12.0474 23H16.3799L6.63183 8.77631H2.30047ZM6.6285 16.6762L2.29492 23H6.63072L8.79584 19.8387L6.6285 16.6762ZM17.3709 1L9.88007 11.9308L12.0474 15.0944L21.7067 1H17.3709ZM18.1555 7.76374V23H21.7067V2.5818L18.1555 7.76374Z" />
    </svg>
  );
}

// Mode menu — icon + label + description, ported 1:1 from media/chat.js MODE_META
// (the old sidebar's icons were Lucide glyphs, so the lucide-react components
// here are the same artwork). Keyed by the wire mode id.
type ModeId = 'agent' | 'plan' | 'yolo';
const MODE_META: Record<ModeId, { Icon: React.ComponentType<any>; label: string; desc: string }> = {
  agent: {
    Icon: Bot,
    label: 'Agent mode',
    desc: 'Grok acts directly, asking approval only for changes it judges sensitive',
  },
  plan: {
    Icon: ListTree,
    label: 'Plan mode',
    desc: 'Grok explores and proposes a plan; file writes and commands are blocked until you approve it',
  },
  yolo: {
    Icon: Zap,
    label: 'YOLO',
    desc: 'Grok will automatically approve all permission requests',
  },
};

// Reasoning-effort ladder, mirrored from media/chat.js. Empty string = "default"
// (let grok decide); each named level forwards as --reasoning-effort.
const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const EFFORT_TOOLTIPS: Record<string, string> = {
  none: 'None — no extra reasoning',
  minimal: 'Minimal — least reasoning',
  low: 'Low — fast, lightweight reasoning',
  medium: 'Medium — balanced',
  high: 'High — deeper reasoning',
  xhigh: 'XHigh — deepest reasoning, slowest',
};

const toK = (n: number) => `${Math.round(n / 1000)}K`;
const truncate = (s: string, max: number) => (s.length > max ? s.slice(0, max) + '…' : s);

const STATUS_VERBS = ['Working', 'Thinking', 'Pondering', 'Crunching', 'Reticulating', 'Combobulating'];

function relTime(ts: number): string {
  if (!ts) return '';
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

const DIFF_COLLAPSE_ROWS = 8;

// The edit-card diff body: a unified, syntax-neutral colored diff (context +
// red removals + green additions) with a "Click to expand" affordance, plus an
// "open diff preview →" link that hands the full before/after to the host's diff
// editor. Mirrors the Claude Code look the user referenced.
function DiffBody({ diff, open, onToggle }: { diff: ToolDiff; open: boolean; onToggle: () => void }) {
  // LCS is O(n·m); a full-file rewrite would build a multi-million-cell table on
  // the render thread and freeze the webview. Past this budget, skip the inline
  // colored diff and show only a summary + the "open diff preview" link.
  const oldN = diff.oldText ? diff.oldText.split('\n').length : 0;
  const newN = diff.newText ? diff.newText.split('\n').length : 0;
  const rows = oldN * newN > 120000 ? null : computeLineDiff(diff.oldText, diff.newText);
  const added = rows ? rows.filter((r) => r.type === 'add').length : 0;
  const removed = rows ? rows.filter((r) => r.type === 'del').length : 0;
  const summary = !rows
    ? `${oldN} → ${newN} lines`
    : added && !removed ? `Added ${added} line${added === 1 ? '' : 's'}`
      : removed && !added ? `Removed ${removed} line${removed === 1 ? '' : 's'}`
        : `+${added} −${removed} lines`;
  const collapsible = !!rows && rows.length > DIFF_COLLAPSE_ROWS;
  const shown = rows ? (open || !collapsible ? rows : rows.slice(0, DIFF_COLLAPSE_ROWS)) : [];
  return (
    <div className="tool-diff">
      <div className="tool-diff-summary">{summary}</div>
      {rows && (
      <div
        className={`tool-diff-code${collapsible && !open ? ' collapsed' : ''}`}
        onClick={collapsible ? onToggle : undefined}
        style={collapsible ? { cursor: 'pointer' } : undefined}
      >
        {shown.map((r, i) => (
          <span key={i} className={`diff-line diff-${r.type}`}>{r.text || ' '}</span>
        ))}
        {collapsible && !open && <div className="diff-fade"><span>Click to expand</span></div>}
      </div>
      )}
      <button
        className="preview-link"
        onClick={(e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'openDiff', path: diff.path, oldText: diff.oldText, newText: diff.newText });
        }}
      >
        open diff preview <ArrowRight size={11} aria-hidden="true" />
      </button>
    </div>
  );
}

function ToolRow({ item, onToggle }: { item: Extract<Item, { kind: 'tool' }>; onToggle: () => void }) {
  const call = item.raw;
  const heading = toolHeading(call);
  const desc = toolDesc(call);
  const diff = toolDiff(call);
  const input = toolInput(call);
  const output = toolOutput(call);
  const running = call?.status && call.status !== 'completed' && call.status !== 'failed';
  // A diff renders its own colored body; otherwise fall back to IN/OUT text.
  const hasBody = Boolean(diff || input || output);
  return (
    <div className="tool">
      <button
        className={`tool-head${item.open ? ' open' : ''}`}
        onClick={hasBody ? onToggle : undefined}
        aria-expanded={item.open}
        style={hasBody ? undefined : { cursor: 'default' }}
      >
        {hasBody ? <ChevronRight className="tool-chevron" size={13} aria-hidden="true" /> : <span style={{ width: 13 }} />}
        <span className="tool-name">{heading}</span>
        {desc && <span className="tool-desc">{desc}</span>}
        {running && <Loader2 className="tool-spinner" size={12} aria-hidden="true" />}
      </button>
      {diff ? (
        <DiffBody diff={diff} open={item.open} onToggle={onToggle} />
      ) : (
        item.open && hasBody && (
          <div className="tool-body">
            {input && (
              <div className="tool-io-row">
                <span className="io-label">in</span>
                <div className="tool-io">{input}</div>
              </div>
            )}
            {output && (
              <div className="tool-io-row">
                <span className="io-label">out</span>
                <div className="tool-io">{output}</div>
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}

// Renders a subagent delegation (grok's "task" tool) as a distinct card showing
// the subagent type + description up front, with the prompt/result tucked behind
// the expander — rather than a generic "Task" tool dumping raw JSON.
function SubagentCard({ item, onToggle }: { item: Extract<Item, { kind: 'tool' }>; onToggle: () => void }) {
  const call = item.raw;
  const r = rawInput(call);
  const type = typeof r.subagent_type === 'string' ? r.subagent_type : '';
  const desc = (typeof r.description === 'string' && r.description) || '';
  const prompt = typeof r.prompt === 'string' ? r.prompt : '';
  const output = toolOutput(call);
  const running = call?.status && call.status !== 'completed' && call.status !== 'failed';
  const hasBody = Boolean(prompt || output);
  return (
    <div className={`subagent-card${item.open ? ' open' : ''}`}>
      <button
        className="subagent-head"
        onClick={hasBody ? onToggle : undefined}
        aria-expanded={item.open}
        style={hasBody ? undefined : { cursor: 'default' }}
      >
        {hasBody ? <ChevronRight className="tool-chevron" size={13} aria-hidden="true" /> : <span style={{ width: 13 }} />}
        <Bot size={14} className="subagent-icon" aria-hidden="true" />
        <span className="subagent-title">Subagent</span>
        {type && <span className="subagent-type">{type}</span>}
        {desc && <span className="subagent-desc">{desc}</span>}
        {running && <Loader2 className="tool-spinner" size={12} aria-hidden="true" />}
      </button>
      {item.open && hasBody && (
        <div className="subagent-body">
          {prompt && (
            <div className="tool-io-row"><span className="io-label">task</span><div className="tool-io">{prompt}</div></div>
          )}
          {output && (
            <div className="tool-io-row"><span className="io-label">out</span><div className="tool-io">{output}</div></div>
          )}
        </div>
      )}
    </div>
  );
}

// Renders a grok todo list as a real checklist with per-item status icons,
// instead of a raw tool card. Driven by the TodoWrite tool's todos array.
function TodoCard({ todos }: { todos: TodoEntry[] }) {
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="todo-card">
      <div className="todo-card-head">
        <ListTree size={13} aria-hidden="true" />
        <span className="todo-card-title">Todos</span>
        <span className="todo-card-count">{done}/{todos.length}</span>
      </div>
      <ul className="todo-list">
        {todos.map((t, i) => {
          const Icon = t.status === 'completed' ? CircleCheck
            : t.status === 'in_progress' ? CircleDot
              : t.status === 'cancelled' ? CircleSlash
                : Circle;
          return (
            <li key={t.id || i} className={`todo-item todo-${t.status}`}>
              <Icon size={14} className="todo-icon" aria-hidden="true" />
              <span className="todo-text">{t.content}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// A run of consecutive tool calls collapses into one expandable bubble (like the
// old sidebar's tool-group). Header shows a summary; expanding reveals each tool
// row, which itself can expand to show IN/OUT or a diff.
function ToolGroup({
  tools, open, onToggleGroup, onToggleTool,
}: {
  tools: Extract<Item, { kind: 'tool' }>[];
  open: boolean;
  onToggleGroup: () => void;
  onToggleTool: (id: string) => void;
}) {
  const running = tools.some((t) => t.raw?.status && t.raw.status !== 'completed' && t.raw.status !== 'failed');
  const last = tools[tools.length - 1];
  // While running, mirror the active tool's present-tense label; once settled,
  // summarize the batch ("3 tools" or the single tool's heading + target).
  const label = running
    ? inProgressLabel(last.raw)
    : tools.length === 1
      ? `${toolHeading(tools[0].raw)}${toolDesc(tools[0].raw) ? ' · ' + toolDesc(tools[0].raw) : ''}`
      : `${tools.length} tools`;
  return (
    <div className={`tool-group${open ? ' open' : ''}`}>
      <button className="tool-group-head" onClick={onToggleGroup} aria-expanded={open}>
        <ChevronRight className="tool-chevron" size={13} aria-hidden="true" />
        <span className="tool-group-label">{label}</span>
        {running && <Loader2 className="tool-spinner" size={12} aria-hidden="true" />}
      </button>
      {open && (
        <div className="tool-group-body">
          {tools.map((t) => <ToolRow key={t.id} item={t} onToggle={() => onToggleTool(t.id)} />)}
        </div>
      )}
    </div>
  );
}

function PlanFileLink({ planPath, planName }: { planPath?: string; planName?: string }) {
  if (!planPath) return null;
  return (
    <div className="plan-tools">
      <a
        className="file-ref-link plan-file-link"
        href={planPath}
        title={planPath}
        onClick={(e) => { e.preventDefault(); vscode.postMessage({ type: 'openFile', path: planPath }); }}
      >
        <code>{planName || baseName(planPath)}</code>
      </a>
    </div>
  );
}

// session/request_permission → allow-always / allow-once / reject card, with a
// diff preview link when the pending tool is an edit. Ported from chat.js.
function PermissionCard({ item, onResolve }: { item: Extract<Item, { kind: 'permission' }>; onResolve: (chosen: string) => void }) {
  const { diff } = item;
  return (
    <div className={`card permission${item.chosen ? ' resolved' : ''}`}>
      <div className="card-title">{item.title}</div>
      {diff && (
        <>
          <div className="card-subtitle">
            {diff.path} — {diff.oldText.split('\n').length} → {diff.newText.split('\n').length} lines
          </div>
          <button
            className="preview-link"
            onClick={() => vscode.postMessage({ type: 'openDiff', path: diff.path, oldText: diff.oldText, newText: diff.newText })}
          >
            open diff preview <ArrowRight size={11} aria-hidden="true" />
          </button>
        </>
      )}
      {/* Once a choice is made the buttons collapse to a single compact line. */}
      {!item.chosen ? (
        <div className="card-actions">
          {item.options.map((opt) => (
            <button
              key={opt.optionId}
              className={`card-btn${opt.kind === 'allow_once' ? ' primary' : ''}${opt.kind === 'reject_once' ? ' danger' : ''}`}
              onClick={() => { vscode.postMessage({ type: 'permissionAnswer', requestId: item.reqId, optionId: opt.optionId }); onResolve(opt.name); }}
            >
              {opt.name}
            </button>
          ))}
        </div>
      ) : (
        <div className="card-chosen"><Check size={12} aria-hidden="true" /> {item.chosen}</div>
      )}
    </div>
  );
}

// grok's ask_user_question tool → an interactive multiple-choice card. Picking
// an option answers the elicitation request (single-select resolves immediately;
// multi-select accumulates and submits). Collapses to the chosen answer(s).
function QuestionCard({ item, onAnswer }: {
  item: Extract<Item, { kind: 'question' }>;
  onAnswer: (selections: { label: string; optionId?: string }[]) => void;
}) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const answered = !!item.answered;
  const submit = (idxs: number[]) => {
    const selections = idxs.map((i) => ({ label: item.options[i].label, optionId: item.options[i].optionId }));
    onAnswer(selections);
  };
  return (
    <div className={`card question${answered ? ' resolved' : ''}`}>
      <div className="card-title">{item.question}</div>
      {!answered ? (
        <>
          <div className="question-options">
            {item.options.map((opt, i) => {
              const on = picked.has(i);
              return (
                <button
                  key={i}
                  className={`question-option${on ? ' picked' : ''}`}
                  onClick={() => {
                    if (item.multiSelect) {
                      setPicked((prev) => {
                        const next = new Set(prev);
                        next.has(i) ? next.delete(i) : next.add(i);
                        return next;
                      });
                    } else {
                      submit([i]);
                    }
                  }}
                >
                  {item.multiSelect && <span className={`question-check${on ? ' on' : ''}`}>{on ? <Check size={11} aria-hidden="true" /> : null}</span>}
                  <span className="question-option-body">
                    <span className="question-option-label">{opt.label}</span>
                    {opt.description && <span className="question-option-desc">{opt.description}</span>}
                  </span>
                </button>
              );
            })}
          </div>
          {item.multiSelect && (
            <div className="card-actions">
              <button className="card-btn primary" disabled={picked.size === 0} onClick={() => submit([...picked].sort((a, b) => a - b))}>
                Submit{picked.size ? ` (${picked.size})` : ''}
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="card-chosen"><Check size={12} aria-hidden="true" /> {item.answered!.join(', ')}</div>
      )}
    </div>
  );
}

// x.ai/exit_plan_mode → Approve & implement / Reject / Cancel, with an optional
// comment box and the rendered plan markdown. Verdict collapses to one label.
function PlanCard({ item, onResolve }: { item: Extract<Item, { kind: 'plan' }>; onResolve: (verdict: string) => void }) {
  const [feedback, setFeedback] = useState('');
  const resolved = !!item.verdict;
  const decide = (verdict: string) => {
    const comment = feedback.trim();
    vscode.postMessage({ type: 'exitPlanAnswer', requestId: item.reqId, verdict, ...(comment ? { comment } : {}) });
    onResolve(verdict);
  };
  return (
    <div className={`card plan${resolved ? ' resolved' : ''}`}>
      <div className="card-title">Plan ready for review</div>
      <div className="card-subtitle">Nothing has been written yet. Approve, reject with feedback, or cancel to leave plan mode.</div>
      <PlanFileLink planPath={item.planPath} planName={item.planName} />
      <div
        className="plan-body md"
        onClick={handleMarkdownClick}
        dangerouslySetInnerHTML={{ __html: item.plan ? renderMarkdown(item.plan) : '(empty plan)' }}
      />
      {!resolved && (
        <>
          <textarea
            className="plan-feedback"
            rows={2}
            placeholder="Optional comment — Grok decides what to do with it"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div className="card-actions">
            <button className="card-btn primary" onClick={() => decide('approved')}>Approve &amp; implement</button>
            <button className="card-btn" onClick={() => decide('rejected')}>Reject</button>
            <button className="card-btn secondary" onClick={() => decide('abandoned')}>Cancel</button>
          </div>
        </>
      )}
      {resolved && <div className={`plan-verdict-label plan-verdict-${item.verdict}`}>{VERDICT_LABEL[item.verdict!] ?? 'Resolved'}</div>}
    </div>
  );
}

// Read-only plan card for resumed sessions (recovered plan.md + persisted verdict).
function PlanHistoryCard({ item }: { item: Extract<Item, { kind: 'planHistory' }> }) {
  const vlabel = item.verdict ? VERDICT_LABEL[item.verdict] : undefined;
  return (
    <div className="card plan plan-history">
      <div className="card-title">Plan from this session</div>
      <div className="card-subtitle">
        {vlabel ? `Restored from the previous session — you ${vlabel.toLowerCase()} this plan.` : 'Restored from the previous session.'}
      </div>
      <PlanFileLink planPath={item.planPath} planName={item.planName} />
      <div
        className="plan-body md"
        onClick={handleMarkdownClick}
        dangerouslySetInnerHTML={{ __html: item.text ? renderMarkdown(item.text) : '(empty plan)' }}
      />
      {vlabel && <div className={`plan-verdict-label plan-verdict-${item.verdict}`}>{vlabel}</div>}
    </div>
  );
}

// First-run guidance when the CLI is missing or unauthenticated. Ported from
// chat.js showOnboarding — the install command, "open terminal & run", and
// re-check actions all post to the existing host handlers.
function OnboardingPanel({ state, platform }: { state: string; platform: string }) {
  if (state === 'missing-cli') {
    const installCmd = platform === 'win32'
      ? 'irm https://x.ai/cli/install.ps1 | iex'
      : 'curl -fsSL https://x.ai/cli/install.sh | bash';
    return (
      <div className="onb">
        <p className="onb-heading">Install the Grok CLI</p>
        <div className="onb-cmd">
          <code>{installCmd}</code>
          <button className="onb-copy" title="Copy" onClick={(e) => copyWithFeedback(installCmd, e.currentTarget)}>
            <Copy size={12} aria-hidden="true" />
          </button>
        </div>
        <button className="onb-action" onClick={() => vscode.postMessage({ type: 'runInstallCmd' })}>
          <Terminal size={13} aria-hidden="true" /> Open terminal &amp; run
        </button>
        <button className="onb-action onb-secondary" onClick={() => vscode.postMessage({ type: 'recheckConnection' })}>
          <RefreshCw size={13} aria-hidden="true" /> Re-check connection
        </button>
      </div>
    );
  }
  if (state === 'auth-required') {
    return (
      <div className="onb">
        <p className="onb-heading">Sign in to continue</p>
        <p className="onb-desc"><strong>SuperGrok Heavy subscription</strong> — required for the <em>Grok Build</em> entitlement.</p>
        <button className="onb-action" onClick={() => vscode.postMessage({ type: 'runGrokLogin' })}>
          <Terminal size={13} aria-hidden="true" /> Open terminal &amp; run <code>grok /login</code>
        </button>
        <p className="onb-or">or</p>
        <p className="onb-desc">
          <strong>API key</strong> — pay per token. Get a key at{' '}
          <a href="https://console.x.ai" onClick={(e) => { e.preventDefault(); vscode.postMessage({ type: 'openUrl', url: 'https://console.x.ai' }); }}>console.x.ai</a>,
          then add it to your shell or a workspace <code>.env</code>:
        </p>
        <div className="onb-cmd">
          <code>XAI_API_KEY=your-key-here</code>
          <button className="onb-copy" title="Copy" onClick={(e) => copyWithFeedback('XAI_API_KEY=', e.currentTarget)}>
            <Copy size={12} aria-hidden="true" />
          </button>
        </div>
        <button className="onb-action onb-secondary" onClick={() => vscode.postMessage({ type: 'recheckConnection' })}>
          <RefreshCw size={13} aria-hidden="true" /> Re-check connection
        </button>
      </div>
    );
  }
  return null;
}

// Isolates transcript rendering so a single malformed message can't take down
// the whole webview (and the composer with it) — the user can always keep typing.
class TranscriptBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(e: unknown) { return { error: (e as Error)?.message || String(e) }; }
  render() {
    if (this.state.error) {
      return (
        <div className="error-text" style={{ padding: '12px 16px' }}>
          The transcript hit a rendering error and was hidden so you can keep working.
          <br /><span style={{ opacity: 0.7, fontSize: 12 }}>{this.state.error}</span>
        </div>
      );
    }
    return this.props.children;
  }
}

// Collapse runs of consecutive tool items into grouped entries; everything else
// passes through as a single entry. Keeps the render loop declarative.
type RenderEntry =
  | { kind: 'toolGroup'; tools: Extract<Item, { kind: 'tool' }>[] }
  | { kind: 'todo'; tool: Extract<Item, { kind: 'tool' }> }
  | { kind: 'subagent'; tool: Extract<Item, { kind: 'tool' }> }
  | { kind: 'edit'; tool: Extract<Item, { kind: 'tool' }> }
  | { kind: 'single'; item: Exclude<Item, { kind: 'tool' }> };

const isGroupableTool = (it: Item): it is Extract<Item, { kind: 'tool' }> =>
  it.kind === 'tool' && !isTodoCall(it.raw) && !isSubagentCall(it.raw) && !isEditCall(it.raw);

function groupItems(items: Item[]): RenderEntry[] {
  const out: RenderEntry[] = [];
  // grok emits a fresh TodoWrite call (new id) on every revision (or new list),
  // each carrying the full current list (via input or output). Render only the
  // latest (non-superseded) so the checklist updates in place instead of
  // stacking or leaving old completed lists visible after a new list starts.
  let lastTodo = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === 'tool' && isTodoCall((items[i] as Extract<Item, { kind: 'tool' }>).raw)) lastTodo = i;
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // Todo updates render as their own checklist card, never folded into a group.
    if (it.kind === 'tool' && isTodoCall(it.raw)) {
      if (i === lastTodo) out.push({ kind: 'todo', tool: it });
      continue;
    }
    // Subagent delegations get their own card too, not folded into a tool group.
    if (it.kind === 'tool' && isSubagentCall(it.raw)) {
      out.push({ kind: 'subagent', tool: it });
      continue;
    }
    // Edits surface as standalone diff cards, never buried inside a "16 tools" batch.
    if (it.kind === 'tool' && isEditCall(it.raw)) {
      out.push({ kind: 'edit', tool: it });
      continue;
    }
    if (isGroupableTool(it)) {
      const tools: Extract<Item, { kind: 'tool' }>[] = [];
      while (i < items.length && isGroupableTool(items[i])) {
        tools.push(items[i] as Extract<Item, { kind: 'tool' }>);
        i++;
      }
      i--;
      out.push({ kind: 'toolGroup', tools });
    } else {
      out.push({ kind: 'single', item: items[i] as Exclude<Item, { kind: 'tool' }> });
    }
  }
  return out;
}

// ---------- app ----------

function App() {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const [input, setInput] = useState('');
  const [images, setImages] = useState<Img[]>([]);
  const [chips, setChips] = useState<Chip[]>([]);
  const [mode, setMode] = useState<'agent' | 'plan' | 'yolo'>('agent');
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  // Messages typed while Grok is busy (or the session is still starting) are
  // queued here and flushed one-at-a-time as each turn finishes.
  const [queued, setQueued] = useState<QueuedMsg[]>([]);
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [onboarding, setOnboarding] = useState<string | null>(null);
  const [onbPlatform, setOnbPlatform] = useState('');
  const [useCtrlEnter, setUseCtrlEnter] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [gearOpen, setGearOpen] = useState(false);
  const [gearView, setGearView] = useState<'main' | 'models'>('main');
  const [addOpen, setAddOpen] = useState(false);
  const [bannerOpen, setBannerOpen] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [titleEditing, setTitleEditing] = useState(false);
  // Host-pushed active-session name; a fallback for the titlebar while the
  // session isn't yet in the disk-driven `sessions` list (see postActiveTitle).
  const [titleOverride, setTitleOverride] = useState<{ id: string; name: string } | null>(null);
  const [verbIdx, setVerbIdx] = useState(0);

  // model / effort / token-usage state (fed by the host: session, modelChanged,
  // initialState, agentEnd meta)
  const [models, setModels] = useState<{ modelId: string; name?: string; totalContextTokens?: number; agentType?: string }[]>([]);
  const [currentModelId, setCurrentModelId] = useState<string | null>(null);
  const [effort, setEffort] = useState('');
  const [contextWindow, setContextWindow] = useState(200000);
  const [tokensUsed, setTokensUsed] = useState(0);

  // slash commands + transient "processing" dots (plan verdict / summarize waits)
  const [commands, setCommands] = useState<{ name: string; description?: string }[]>([]);
  const [slashItems, setSlashItems] = useState<{ name: string; description?: string }[]>([]);
  const [slashActive, setSlashActive] = useState(0);
  // @-mention file picker: full workspace list + the current filtered/visible slice
  const [projectFiles, setProjectFiles] = useState<string[]>([]);
  const [mentionItems, setMentionItems] = useState<string[]>([]);
  const [mentionActive, setMentionActive] = useState(0);
  const [processing, setProcessing] = useState(false);
  const planQueueRef = useRef<{ text: string; verdict?: string; planPath?: string; planName?: string }[]>([]);
  // Messages typed while the session is still locked (initializing on new session
  // or tab) are held here. We flush them via the idle effect without ever putting
  // them in the visible `queued` list, so the queued bar never appears for the
  // first prompt in a fresh session.
  const startupQueueRef = useRef<QueuedMsg[]>([]);
  // Which consecutive-tool groups are expanded, keyed by the group's first item id.
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (id: string) => setOpenGroups((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const hasContent = state.items.length > 0;

  // Auto-scroll to the newest content, but ONLY when the user is already near
  // the bottom. Expanding/collapsing a tool or thought up the transcript must
  // not yank the view down — so if they've scrolled up to read, we leave them.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.items, busy]);

  // Cycle the working-status verb while busy (cosmetic, like Claude Code).
  useEffect(() => {
    if (!busy) return;
    const h = setInterval(() => setVerbIdx((i) => (i + 1) % STATUS_VERBS.length), 2200);
    return () => clearInterval(h);
  }, [busy]);

  useEffect(() => { if (renamingId) renameInputRef.current?.focus(); }, [renamingId]);
  useEffect(() => { if (titleEditing) { titleInputRef.current?.focus(); titleInputRef.current?.select(); } }, [titleEditing]);

  // ---------- host → webview ----------
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case 'clearMessages':
          dispatch({ t: 'reset' });
          setBusy(false); setLocked(false); setProcessing(false); setQueued([]);
          setTitleOverride(null);
          startupQueueRef.current = [];
          planQueueRef.current = [];
          break;
        case 'agentReset':
          dispatch({ t: 'agentReset' });
          break;
        case 'historyReplay':
          dispatch({ t: 'replay', active: !!msg.active });
          if (!msg.active) {
            // Replay finished: flush any plan-history cards the host queued.
            for (const p of planQueueRef.current) dispatch({ t: 'planHistory', text: p.text, verdict: p.verdict, planPath: p.planPath, planName: p.planName });
            planQueueRef.current = [];
          }
          break;
        case 'agentStart':
          setOnboarding(null);
          setBusy(true);
          break;
        case 'messageChunk':
          setOnboarding(null); setProcessing(false);
          dispatch({ t: 'messageChunk', text: msg.text || '' });
          break;
        case 'thoughtChunk':
          setProcessing(false);
          dispatch({ t: 'thoughtChunk', text: msg.text || '' });
          break;
        case 'userMessageChunk':
          dispatch({ t: 'userChunk', text: msg.text || '' });
          break;
        case 'userMessage':
          setOnboarding(null); setProcessing(false);
          dispatch({ t: 'userMessage', text: msg.text || '', images: msg.images, chips: msg.chips });
          break;
        case 'toolCall':
          setProcessing(false);
          dispatch({ t: 'toolCall', call: msg.call });
          break;
        case 'toolCallUpdate':
          dispatch({ t: 'toolUpdate', call: msg.call });
          break;
        case 'promptComplete':
          dispatch({ t: 'commit' });
          if (msg.meta?.totalTokens) setTokensUsed(msg.meta.totalTokens);
          break;
        case 'agentEnd':
          setBusy(false); setLocked(false); setProcessing(false);
          if (msg.meta?.totalTokens) setTokensUsed(msg.meta.totalTokens);
          break;
        case 'agentError':
          dispatch({ t: 'error', text: msg.text || 'Something went wrong' });
          setBusy(false); setLocked(false); setProcessing(false);
          setQueued([]);
          startupQueueRef.current = [];
          break;
        case 'exit':
          dispatch({ t: 'error', text: `Grok exited (code ${msg.code}). Start a new session to restart.` });
          setBusy(false); setLocked(false); setProcessing(false);
          setQueued([]);
          startupQueueRef.current = [];
          break;
        case 'setBusy':
          setBusy(!!msg.value);
          setLocked(!!msg.value && !!msg.locked);
          break;
        case 'modeChanged':
          if (msg.modeId) setMode(msg.modeId);
          break;
        case 'openModePopover':
          setHistoryOpen(false); setGearOpen(false); setAddOpen(false);
          setModeMenuOpen(true);
          break;
        case 'modelChanged':
          if (msg.modelId) setCurrentModelId(msg.modelId);
          if (msg.totalContextTokens) setContextWindow(msg.totalContextTokens);
          break;
        case 'chips':
          setChips(msg.chips || []);
          break;
        case 'sessions':
          setSessions(msg.entries || []);
          setActiveSessionId(msg.activeId || null);
          break;
        case 'sessionTitle':
          if (msg.id && msg.name) setTitleOverride({ id: msg.id, name: msg.name });
          break;
        case 'session': {
          setOnboarding(null);
          if (msg.sessionId) setActiveSessionId(msg.sessionId);
          if (Array.isArray(msg.models)) setModels(msg.models);
          if (msg.currentModelId) setCurrentModelId(msg.currentModelId);
          const m = (msg.models || []).find((x: any) => x.modelId === msg.currentModelId);
          if (m?.totalContextTokens) setContextWindow(m.totalContextTokens);
          setTokensUsed(0);
          break;
        }
        case 'initialState':
          setUseCtrlEnter(!!msg.useCtrlEnter);
          if (typeof msg.effort === 'string') setEffort(msg.effort);
          break;
        case 'commandsUpdate':
          setCommands(msg.commands || []);
          break;
        case 'projectFiles':
          setProjectFiles(msg.files || []);
          break;
        case 'permissionRequest':
          setProcessing(false);
          dispatch({ t: 'permission', req: msg.req });
          break;
        case 'userQuestion':
          setProcessing(false);
          dispatch({ t: 'question', req: msg.req });
          break;
        case 'exitPlanRequest':
          setProcessing(false);
          dispatch({ t: 'plan', req: msg.req });
          break;
        case 'planHistory':
          dispatch({ t: 'planHistory', text: msg.text, verdict: msg.verdict, planPath: msg.planPath, planName: msg.planName });
          break;
        case 'planHistoryQueue':
          planQueueRef.current = msg.plans || [];
          break;
        case 'planNotice':
          dispatch({ t: 'planNotice', text: msg.text || '' });
          break;
        case 'planBlocked':
          dispatch({ t: 'planNotice', text: msg.kind === 'terminal' ? `Plan mode blocked a command: ${msg.target}` : `Plan mode blocked a write to ${msg.target}` });
          break;
        case 'planProcessing':
        case 'summarizing':
          setProcessing(true);
          break;
        case 'sessionContext':
          setProcessing(false);
          dispatch({ t: 'sessionContext' });
          break;
        case 'initialized':
          setOnboarding(null);
          break;
        case 'onboarding':
          setOnboarding(msg.state || null);
          if (msg.platform) setOnbPlatform(msg.platform);
          break;
        default:
          break;
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'ready' });
    vscode.postMessage({ type: 'listProjectFiles' });
    return () => window.removeEventListener('message', handler);
  }, []);

  // Close popovers on outside interaction / Escape.
  useEffect(() => {
    if (!historyOpen && !modeMenuOpen && !gearOpen && !addOpen) return;
    const close = () => {
      setHistoryOpen(false); setModeMenuOpen(false); setGearOpen(false); setAddOpen(false);
      setGearView('main'); setRenamingId(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey); };
  }, [historyOpen, modeMenuOpen, gearOpen, addOpen]);

  // ---------- composer ----------
  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 240) + 'px';
  }, []);

  useEffect(() => { autoGrow(); }, [input, autoGrow]);

  const addImageFiles = useCallback((files: File[]) => {
    files.filter((f) => f.type.startsWith('image/')).forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setImages((prev) => [...prev, { dataUrl: ev.target?.result as string, name: file.name || 'image.png' }]);
      };
      reader.readAsDataURL(file);
    });
  }, []);

  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) { e.preventDefault(); addImageFiles(files); }
  }, [addImageFiles]);

  useEffect(() => {
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

  // Actually hand a payload to the host and mark the surface busy.
  const dispatchSend = (msg: QueuedMsg) => {
    vscode.postMessage({
      type: 'send',
      text: msg.text,
      chips: msg.chips,
      images: msg.images.length ? msg.images.map((i) => ({ dataUrl: i.dataUrl, name: i.name })) : undefined,
    });
    setBusy(true);
  };

  const send = () => {
    const text = input.trim();
    if (!text && images.length === 0) return;
    const msg: QueuedMsg = { text, chips, images };
    // Always clear the composer so the user can keep typing the next message.
    setInput('');
    setImages([]);
    setSlashItems([]);
    setMentionItems([]);
    // Busy (a turn is running) or locked (session still starting) → queue it and
    // let the flush effect send it once the surface is free. Otherwise send now.
    if (busy || locked) {
      if (locked) {
        // Hold in a non-visual startup buffer (plus render guard below) so the
        // queued UI does not appear as a result of text entered into a new
        // session (while the init lock is active).
        startupQueueRef.current = [...startupQueueRef.current, msg];
        return;
      }
      setQueued((q) => [...q, msg]);
      return;
    }
    dispatchSend(msg);
  };

  // Flush the next queued message as soon as the surface goes idle. dispatchSend
  // sets busy=true again, so messages drain one-per-turn rather than all at once.
  useEffect(() => {
    if (busy || locked) return;
    // Drain startup-buffered messages (typed during new-session lock) first.
    // These were never added to the visual `queued` state, and the render also
    // guards with `!locked`, so the queued bar does not appear as a result of
    // text entered into a new session.
    if (startupQueueRef.current.length > 0) {
      const [next, ...rest] = startupQueueRef.current;
      startupQueueRef.current = rest;
      dispatchSend(next);
      return;
    }
    if (queued.length === 0) return;
    const [next, ...rest] = queued;
    setQueued(rest);
    dispatchSend(next);
  }, [busy, locked, queued]);

  const updateSlash = (value: string, caret: number) => {
    const m = value.slice(0, caret).match(/(?:^|\n)\/(\S*)$/);
    if (!m) { setSlashItems([]); return; }
    const q = m[1].toLowerCase();
    setSlashItems(commands.filter((c) => c.name.toLowerCase().startsWith(q)));
    setSlashActive(0);
  };

  const pickSlash = (cmd: { name: string }) => {
    setInput((val) => val.replace(/(?:^|\n)\/(\S*)$/, (full) => (full.startsWith('\n') ? `\n/${cmd.name} ` : `/${cmd.name} `)));
    setSlashItems([]);
    textareaRef.current?.focus();
  };

  // @-mention: typing "@partial" filters the workspace file list inline.
  const updateMention = (value: string, caret: number) => {
    const m = value.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/);
    if (!m) { setMentionItems([]); return; }
    const q = m[1].toLowerCase();
    const matches = projectFiles
      .filter((f) => f.toLowerCase().includes(q))
      .sort((a, b) => {
        // prefer matches on the basename, then shorter paths
        const ab = a.toLowerCase().split('/').pop()!.startsWith(q) ? 0 : 1;
        const bb = b.toLowerCase().split('/').pop()!.startsWith(q) ? 0 : 1;
        return ab - bb || a.length - b.length;
      })
      .slice(0, 50);
    setMentionItems(matches);
    setMentionActive(0);
  };

  // Selecting a file adds it as a context chip and strips the "@token" the user
  // typed (this extension references files via chips, not inline @paths).
  const pickMention = (file: string) => {
    setInput((val) => val.replace(/(^|\s)@([^\s@]*)$/, '$1'));
    vscode.postMessage({ type: 'mentionPath', path: file });
    setMentionItems([]);
    textareaRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionItems.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionActive((i) => (i + 1) % mentionItems.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionActive((i) => (i - 1 + mentionItems.length) % mentionItems.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionItems[mentionActive]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMentionItems([]); return; }
    }
    if (slashItems.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashActive((i) => (i + 1) % slashItems.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashActive((i) => (i - 1 + slashItems.length) % slashItems.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSlash(slashItems[slashActive]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setSlashItems([]); return; }
    }
    const enterSends = useCtrlEnter ? (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) : (e.key === 'Enter' && !e.shiftKey);
    if (enterSends) { e.preventDefault(); send(); }
  };

  const sendOrStop = () => {
    if (busy) { if (!locked) vscode.postMessage({ type: 'cancel' }); return; }
    send();
  };

  const newChat = () => {
    dispatch({ t: 'reset' });
    setBusy(false); setLocked(false); setQueued([]); setTitleOverride(null);
    startupQueueRef.current = [];
    vscode.postMessage({ type: 'newSession' });
  };

  // Prefer the disk-driven displayName (which respects grok's own summary); fall
  // back to the host-pushed override only until the session shows up in the list.
  const activeTitle =
    sessions.find((s) => s.id === activeSessionId)?.displayName ||
    (titleOverride && titleOverride.id === activeSessionId ? titleOverride.name : '') ||
    'New chat';
  const sendDisabled = locked || (!busy && !input.trim() && images.length === 0);

  const closeMenus = () => {
    setHistoryOpen(false); setModeMenuOpen(false); setGearOpen(false); setAddOpen(false); setGearView('main');
  };

  const toggleHistory = (e: React.MouseEvent) => {
    e.stopPropagation();
    closeMenus();
    setHistoryOpen((open) => {
      if (!open) vscode.postMessage({ type: 'listSessions' });
      return !open;
    });
  };

  const toggleGear = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !gearOpen;
    closeMenus();
    setGearView('main');
    setGearOpen(next);
  };

  const toggleAdd = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !addOpen;
    closeMenus();
    setAddOpen(next);
  };

  const toggleMode = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !modeMenuOpen;
    closeMenus();
    setModeMenuOpen(next);
  };

  // Toggle an effort level: clicking the active level clears back to default.
  const pickEffort = (level: string) => {
    const next = effort === level ? '' : level;
    setEffort(next);
    vscode.postMessage({ type: 'setEffort', level: next });
  };

  const gearAction = (msg: Record<string, unknown>) => { vscode.postMessage(msg); closeMenus(); };

  const currentModelLabel = currentModelId || 'grok-build';
  const effortIdx = EFFORT_LEVELS.indexOf(effort as typeof EFFORT_LEVELS[number]);
  // --reasoning-effort only bites on grok's own agents. The Cursor-routed agent
  // (Composer) ignores it entirely — reasoningTokens stays 0 at every level
  // (verified: research/effort-behavior-probe*.cjs), mirroring NON_PLAN_AGENTS in
  // src/plan-gate.ts. Keep the control honest: don't offer a live dial that does nothing.
  const currentAgentType = models.find((m) => m.modelId === currentModelId)?.agentType;
  const effortSupported = (currentAgentType ?? '').toLowerCase() !== 'cursor';
  const modeMeta = MODE_META[mode] || MODE_META.agent;   // never crash on an unknown mode id

  // Token-usage donut geometry (r=5 ring, like the sidebar's updateDonut).
  const donutPct = Math.min(100, Math.round((tokensUsed / contextWindow) * 100));
  const donutCirc = 2 * Math.PI * 5;
  const donutColor = donutPct > 90
    ? 'var(--vscode-charts-red, #f48771)'
    : donutPct > 70
      ? 'var(--vscode-charts-yellow, #d7ba7d)'
      : 'var(--vscode-charts-green, #4ec9b0)';

  return (
    <div className="app">
      {/* title bar */}
      <header className="titlebar">
        {titleEditing && activeSessionId ? (
          <input
            ref={titleInputRef}
            className="titlebar-rename"
            defaultValue={activeTitle}
            aria-label="Rename session"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                vscode.postMessage({ type: 'renameSession', id: activeSessionId, name: (e.target as HTMLInputElement).value });
                setTitleEditing(false);
              } else if (e.key === 'Escape') {
                setTitleEditing(false);
              }
            }}
            onBlur={(e) => {
              vscode.postMessage({ type: 'renameSession', id: activeSessionId, name: e.target.value });
              setTitleEditing(false);
            }}
          />
        ) : (
          <button
            className="titlebar-title"
            title={activeSessionId ? 'Rename session' : 'Session history'}
            onClick={(e) => { e.stopPropagation(); if (activeSessionId) { setHistoryOpen(false); setModeMenuOpen(false); setTitleEditing(true); } else { toggleHistory(e); } }}
          >
            {activeTitle}
          </button>
        )}
        <div className="titlebar-actions">
          <button className="icon-btn" title="History" aria-label="Session history" onClick={toggleHistory}>
            <History size={16} aria-hidden="true" />
          </button>
          <button className="icon-btn" title="New chat" aria-label="New chat" onClick={newChat}>
            <SquarePen size={16} aria-hidden="true" />
          </button>

          {historyOpen && (
            <div className="popover from-titlebar" onClick={(e) => e.stopPropagation()}>
              {sessions.length === 0 && <div className="popover-empty">No saved sessions yet.</div>}
              {sessions.map((s) => (
                <div className="popover-item-row" key={s.id}>
                  {renamingId === s.id ? (
                    <input
                      ref={renameInputRef}
                      className="popover-item"
                      defaultValue={s.displayName}
                      style={{ flex: 1 }}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') {
                          vscode.postMessage({ type: 'renameSession', id: s.id, name: (e.target as HTMLInputElement).value });
                          setRenamingId(null);
                        } else if (e.key === 'Escape') { setRenamingId(null); }
                      }}
                      onBlur={(e) => {
                        vscode.postMessage({ type: 'renameSession', id: s.id, name: e.target.value });
                        setRenamingId(null);
                      }}
                    />
                  ) : (
                    <button
                      className={`popover-item${s.id === activeSessionId ? ' active' : ''}`}
                      style={{ flex: 1 }}
                      onClick={() => { vscode.postMessage({ type: 'resumeSession', id: s.id }); setHistoryOpen(false); }}
                      title={s.rawSummary || s.displayName}
                    >
                      <div className="popover-item-title">{s.displayName}</div>
                      <div className="popover-item-desc">
                        {s.numMessages} message{s.numMessages === 1 ? '' : 's'}{s.updatedAt ? ` · ${relTime(s.updatedAt)}` : ''}
                      </div>
                    </button>
                  )}
                  <button className="icon-btn" title="Rename" aria-label="Rename session" onClick={(e) => { e.stopPropagation(); setRenamingId(s.id); }}>
                    <Pencil size={13} aria-hidden="true" />
                  </button>
                  <button className="icon-btn" title="Delete" aria-label="Delete session" onClick={(e) => { e.stopPropagation(); vscode.postMessage({ type: 'deleteSession', id: s.id, name: s.displayName }); }}>
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </header>

      {/* conversation */}
      <main className="conversation" ref={scrollRef}>
        <TranscriptBoundary key={activeSessionId || 'none'}>
        {!hasContent ? (
          <>
            <div className="brand">
              <GrokMark className="brand-mark" />
              <span className="brand-name">Grok Build</span>
            </div>
            <div className="empty-state">
              <GrokMark className="empty-glyph" />
              <p className="empty-tagline">// TODO: Everything. Let&apos;s start.</p>
              {onboarding && <OnboardingPanel state={onboarding} platform={onbPlatform} />}
            </div>
          </>
        ) : (
          <div className="messages">
            {groupItems(state.items).map((entry) => {
              if (entry.kind === 'toolGroup') {
                const gid = entry.tools[0].id;
                return (
                  <div className="turn" key={gid}>
                    <div className="turn-gutter"><span className="turn-dot tone-tool" /></div>
                    <div className="turn-body">
                      <ToolGroup
                        tools={entry.tools}
                        open={openGroups.has(gid)}
                        onToggleGroup={() => toggleGroup(gid)}
                        onToggleTool={(id) => dispatch({ t: 'toggle', id })}
                      />
                    </div>
                  </div>
                );
              }
              if (entry.kind === 'todo') {
                const todos = extractTodos(entry.tool.raw);
                // Stable key (not the per-revision call id) so the single card
                // updates in place as grok revises the list.
                return (
                  <div className="turn" key="todo-card">
                    <div className="turn-gutter"><span className="turn-dot tone-info" /></div>
                    <div className="turn-body">
                      {todos.length ? <TodoCard todos={todos} /> : <ToolGroup tools={[entry.tool]} open onToggleGroup={() => {}} onToggleTool={(id) => dispatch({ t: 'toggle', id })} />}
                    </div>
                  </div>
                );
              }
              if (entry.kind === 'subagent') {
                return (
                  <div className="turn" key={entry.tool.id}>
                    <div className="turn-gutter"><span className="turn-dot tone-info" /></div>
                    <div className="turn-body">
                      <SubagentCard item={entry.tool} onToggle={() => dispatch({ t: 'toggle', id: entry.tool.id })} />
                    </div>
                  </div>
                );
              }
              if (entry.kind === 'edit') {
                return (
                  <div className="turn" key={entry.tool.id}>
                    <div className="turn-gutter"><span className="turn-dot tone-tool" /></div>
                    <div className="turn-body">
                      <ToolRow item={entry.tool} onToggle={() => dispatch({ t: 'toggle', id: entry.tool.id })} />
                    </div>
                  </div>
                );
              }
              const it = entry.item;
              if (it.kind === 'user') {
                return (
                  <div className="user-bubble" key={it.id}>
                    {it.images && it.images.length > 0 && (
                      <div className="bubble-images">
                        {it.images.map((img, i) => <img key={i} src={img.dataUrl} alt={img.name || 'attachment'} />)}
                      </div>
                    )}
                    {it.text}
                  </div>
                );
              }
              if (it.kind === 'permission') {
                return <PermissionCard key={it.id} item={it} onResolve={(c) => dispatch({ t: 'permissionResolved', id: it.id, chosen: c })} />;
              }
              if (it.kind === 'plan') {
                return <PlanCard key={it.id} item={it} onResolve={(v) => dispatch({ t: 'planResolved', id: it.id, verdict: v })} />;
              }
              if (it.kind === 'planHistory') {
                return <PlanHistoryCard key={it.id} item={it} />;
              }
              if (it.kind === 'planNotice') {
                return (
                  <div className="plan-notice" key={it.id}>
                    <ListTree size={14} aria-hidden="true" /><span>{it.text}</span>
                  </div>
                );
              }
              if (it.kind === 'sessionContext') {
                return <div className="session-context-banner" key={it.id}>Context from previous session applied</div>;
              }
              return (
                <div className="turn" key={it.id}>
                  <div className="turn-gutter"><span className={`turn-dot${it.kind === 'question' ? ' tone-info' : ''}`} /></div>
                  <div className="turn-body">
                    {it.kind === 'assistant' && (
                      <div
                        className="assistant-text md"
                        onClick={handleMarkdownClick}
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(it.text) }}
                      />
                    )}
                    {it.kind === 'error' && <div className="error-text">{it.text}</div>}
                    {it.kind === 'question' && (
                      <QuestionCard
                        item={it}
                        onAnswer={(selections) => {
                          vscode.postMessage({ type: 'answerQuestion', requestId: it.reqId, selections });
                          dispatch({ t: 'questionAnswered', id: it.id, answered: selections.map((s) => s.label) });
                        }}
                      />
                    )}
                    {it.kind === 'thought' && (
                      <>
                        <button
                          className={`thinking-row${it.open ? ' open' : ''}`}
                          onClick={() => dispatch({ t: 'toggle', id: it.id })}
                          aria-expanded={it.open}
                        >
                          <ChevronRight className="thinking-chevron" size={13} aria-hidden="true" />
                          <span>{it.live ? 'Thinking…' : 'Thought'}</span>
                        </button>
                        {it.open && <div className="thinking-content">{it.text}</div>}
                      </>
                    )}
                  </div>
                </div>
              );
            })}

            {busy && (
              <div className="status-line">
                <GrokMark className="status-star" />
                <span>{STATUS_VERBS[verbIdx]}…</span>
              </div>
            )}
            {processing && !busy && (
              <div className="plan-processing" aria-label="Grok is processing">
                <span className="plan-processing-dots"><span /><span /><span /></span>
              </div>
            )}
          </div>
        )}
        </TranscriptBoundary>
        <div ref={endRef} />
      </main>

      {/* bottom dock: banner + chips + previews + composer */}
      <div className="dock">
        {bannerOpen && (
          <div className="banner">
            <span>Configure models, effort, and behavior in</span>
            <a onClick={() => vscode.postMessage({ type: 'openGlobalConfig' })}>Settings.</a>
            <button className="banner-close" aria-label="Dismiss" onClick={() => setBannerOpen(false)}>
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        )}

        {images.length > 0 && (
          <div className="previews">
            {images.map((img, i) => (
              <div className="preview" key={i}>
                <img src={img.dataUrl} alt={img.name || 'image'} />
                <button className="preview-remove" aria-label="Remove image" onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}>
                  <X size={11} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}

        {queued.length > 0 && !locked && (
          <div className="queued">
            {queued.map((q, i) => (
              <div className="queued-item" key={i}>
                <CornerDownRight size={12} className="queued-icon" aria-hidden="true" />
                <span className="queued-text">{q.text || `${q.images.length} image${q.images.length === 1 ? '' : 's'}`}</span>
                <button
                  className="queued-remove"
                  aria-label="Remove queued message"
                  title="Remove queued message"
                  onClick={() => setQueued((prev) => prev.filter((_, j) => j !== i))}
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div
          className="composer"
          onDrop={(e) => { e.preventDefault(); addImageFiles(Array.from(e.dataTransfer.files)); }}
          onDragOver={(e) => e.preventDefault()}
        >
          {mentionItems.length > 0 && (
            <div className="slash-popover mention-popover" onMouseDown={(e) => e.preventDefault()}>
              {mentionItems.map((file, i) => (
                <div
                  key={file}
                  className={`slash-item${i === mentionActive ? ' active' : ''}`}
                  onMouseEnter={() => setMentionActive(i)}
                  onClick={() => pickMention(file)}
                >
                  <div className="slash-name">{file.split('/').pop()}</div>
                  <div className="slash-desc">{file}</div>
                </div>
              ))}
            </div>
          )}
          {slashItems.length > 0 && (
            <div className="slash-popover" onMouseDown={(e) => e.preventDefault()}>
              {slashItems.map((cmd, i) => (
                <div
                  key={cmd.name}
                  className={`slash-item${i === slashActive ? ' active' : ''}`}
                  onMouseEnter={() => setSlashActive(i)}
                  onClick={() => pickSlash(cmd)}
                >
                  <div className="slash-name">/{cmd.name}</div>
                  {cmd.description && <div className="slash-desc">{cmd.description}</div>}
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="composer-input"
            value={input}
            rows={1}
            placeholder={busy ? 'Grok is working…' : 'Ask Grok anything…'}
            onChange={(e) => {
              setInput(e.target.value);
              const caret = e.target.selectionStart || 0;
              updateSlash(e.target.value, caret);
              updateMention(e.target.value, caret);
            }}
            onKeyDown={onKeyDown}
            aria-label="Message Grok"
          />
          <div className="composer-toolbar">
            <div className="composer-toolbar-left" style={{ position: 'relative' }}>
              <button className="icon-btn" title="Add context" aria-label="Add context" onClick={toggleAdd} aria-haspopup="menu" aria-expanded={addOpen}>
                <Plus size={16} aria-hidden="true" />
              </button>
              <button
                className="icon-btn"
                title="Slash commands"
                aria-label="Slash commands"
                onClick={() => { setInput((v) => (v ? v + ' /' : '/')); setSlashItems(commands); setSlashActive(0); textareaRef.current?.focus(); }}
              >
                <Slash size={15} aria-hidden="true" />
              </button>
              <button className="icon-btn" title="Settings" aria-label="Settings" onClick={toggleGear} aria-haspopup="menu" aria-expanded={gearOpen}>
                <Settings size={15} aria-hidden="true" />
              </button>
              <span className="donut" title={`${tokensUsed.toLocaleString()} / ${contextWindow.toLocaleString()} tokens`}>
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <circle cx="7" cy="7" r="5" fill="none" stroke="var(--vscode-editorWidget-border, var(--vscode-panel-border))" strokeWidth="2" />
                  <circle
                    cx="7" cy="7" r="5" fill="none" stroke={donutColor} strokeWidth="2" strokeLinecap="round"
                    strokeDasharray={`${(donutPct / 100) * donutCirc} ${donutCirc}`}
                    transform="rotate(-90 7 7)"
                  />
                </svg>
                <span className="donut-label">{toK(tokensUsed)}/{toK(contextWindow)}</span>
              </span>

              {/* file-context chips render inline in the toolbar */}
              {chips.filter((c) => !c.hidden).map((c) => (
                <span className="chip" key={c.id} title={c.path}>
                  <span className="chip-label">{c.relPath.split('/').pop()}</span>
                  <button className="chip-remove" aria-label="Remove" onClick={() => vscode.postMessage({ type: 'removeChip', id: c.id })}>
                    <X size={11} aria-hidden="true" />
                  </button>
                </span>
              ))}

              {/* + menu */}
              {addOpen && (
                <div className="popover from-composer-left" onClick={(e) => e.stopPropagation()}>
                  <button className="menu-item" onClick={() => gearAction({ type: 'pickFile' })}>
                    <Upload size={14} className="menu-item-icon" aria-hidden="true" /><span>Upload from computer</span>
                  </button>
                  <button
                    className="menu-item"
                    onClick={() => {
                      closeMenus();
                      setInput((v) => (v ? v + ' @' : '@'));
                      setMentionItems(projectFiles.slice(0, 50));
                      setMentionActive(0);
                      textareaRef.current?.focus();
                    }}
                  >
                    <AtSign size={14} className="menu-item-icon" aria-hidden="true" /><span>Add context</span>
                  </button>
                </div>
              )}

              {/* gear / settings menu */}
              {gearOpen && (
                <div className="popover from-composer-left gear-popover" onClick={(e) => e.stopPropagation()}>
                  {gearView === 'main' ? (
                    <>
                      <div className="popover-section popover-section-first">Model and Effort</div>
                      <div className="model-effort-row">
                        <button
                          className="model-name-btn"
                          title={`${currentModelLabel} — click to change`}
                          onClick={(e) => { e.stopPropagation(); setGearView('models'); }}
                        >
                          <span className="model-name-label">{truncate(currentModelLabel, 16)}</span>
                          <ChevronRight size={12} aria-hidden="true" />
                        </button>
                        <span
                          className={`effort-dots${effortSupported ? '' : ' unsupported'}`}
                          title={effortSupported ? undefined : `${currentModelLabel} ignores reasoning effort`}
                        >
                          {EFFORT_LEVELS.map((id, i) => (
                            <button
                              key={id}
                              className={`effort-dot${i <= effortIdx && effortSupported ? ' active' : ''}`}
                              title={effortSupported ? EFFORT_TOOLTIPS[id] : `Reasoning effort isn't supported by ${currentModelLabel}`}
                              aria-label={`Reasoning effort: ${id}`}
                              disabled={!effortSupported}
                              onClick={(e) => { e.stopPropagation(); if (effortSupported) pickEffort(id); }}
                            />
                          ))}
                        </span>
                      </div>

                      <div className="popover-section">Session</div>
                      <button className="menu-item" onClick={() => gearAction({ type: 'send', text: '/compact', chips: [] })}><span>Compact conversation</span></button>
                      <button className="menu-item" onClick={() => gearAction({ type: 'openInEditor' })}><span>Open in Editor Tab</span></button>

                      <div className="popover-section">Config</div>
                      <button className="menu-item" onClick={() => gearAction({ type: 'openGlobalConfig' })}><span>Open global config</span><span className="popover-external">↗</span></button>
                      <button className="menu-item" onClick={() => gearAction({ type: 'openProjectConfig' })}><span>Open project config</span><span className="popover-external">↗</span></button>
                      <button className="menu-item" onClick={() => gearAction({ type: 'runMcpList' })}><span>MCP servers</span><span className="popover-external">↗</span></button>

                      <div className="popover-section">Debug</div>
                      <button className="menu-item" onClick={() => gearAction({ type: 'showLogs' })}><span>Show extension logs</span></button>
                    </>
                  ) : (
                    <>
                      <button className="menu-item menu-back" onClick={(e) => { e.stopPropagation(); setGearView('main'); }}>
                        <ArrowLeft size={13} aria-hidden="true" /><span>Model</span>
                      </button>
                      {(models.length ? models : [{ modelId: currentModelLabel, name: currentModelLabel }]).map((m) => (
                        <button
                          key={m.modelId}
                          className={`menu-item${m.modelId === currentModelId ? ' active' : ''}`}
                          title={m.modelId}
                          onClick={() => gearAction({ type: 'setModel', modelId: m.modelId })}
                        >
                          <span className="menu-item-label">{truncate(m.name || m.modelId, 28)}</span>
                          {m.modelId === currentModelId && <Check size={13} className="popover-check" aria-hidden="true" />}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="composer-toolbar-right" style={{ position: 'relative' }}>
              <button
                className={`mode-pill${mode === 'plan' ? ' plan-active' : ''}${mode === 'yolo' ? ' yolo-active' : ''}`}
                title="Change mode"
                onClick={toggleMode}
                aria-haspopup="menu"
                aria-expanded={modeMenuOpen}
              >
                {React.createElement(modeMeta.Icon, { size: 13, 'aria-hidden': true })}
                <span>{modeMeta.label}</span>
                <ChevronDown size={13} aria-hidden="true" />
              </button>
              {modeMenuOpen && (
                <div className="popover from-composer mode-popover" onClick={(e) => e.stopPropagation()}>
                  {(['agent', 'plan', 'yolo'] as ModeId[]).map((m) => {
                    const meta = MODE_META[m];
                    const active = m === mode;
                    return (
                      <button
                        key={m}
                        className={`menu-item mode-item${active ? ' active' : ''}`}
                        onClick={() => { vscode.postMessage({ type: 'setMode', modeId: m }); closeMenus(); }}
                      >
                        {React.createElement(meta.Icon, { size: 15, className: 'mode-item-icon', 'aria-hidden': true })}
                        <span className="mode-item-body">
                          <span className="mode-item-label">{meta.label}</span>
                          <span className="mode-item-desc">{meta.desc}</span>
                        </span>
                        {active && <Check size={14} className="popover-check" aria-hidden="true" />}
                      </button>
                    );
                  })}
                </div>
              )}
              <button
                className={`send-btn${busy && !locked ? ' stop' : ''}`}
                onClick={sendOrStop}
                disabled={sendDisabled}
                title={busy ? (locked ? 'Initializing…' : 'Stop') : 'Send'}
                aria-label={busy ? 'Stop' : 'Send message'}
              >
                {busy && !locked ? <Square size={12} aria-hidden="true" /> : <ArrowUp size={15} aria-hidden="true" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
