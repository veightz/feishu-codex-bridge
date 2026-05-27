import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentId } from '../config/schema';

export interface SessionSummary {
  sessionId: string;
  mtime: number;
  preview: string;
  lineCount: number;
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function claudeProjectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', encodeCwd(cwd));
}

/** Return the most recent `limit` jsonl sessions for the given cwd, newest first. */
export async function listRecentSessions(cwd: string, limit = 5): Promise<SessionSummary[]> {
  return listRecentAgentSessions(cwd, 'claude', limit);
}

export async function listRecentAgentSessions(
  cwd: string,
  agentId: AgentId,
  limit = 5,
): Promise<SessionSummary[]> {
  if (agentId === 'codex') return listRecentCodexSessions(cwd, limit);
  const dir = claudeProjectDir(cwd);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const jsonls = files.filter((f) => f.endsWith('.jsonl'));
  const withStats = await Promise.all(
    jsonls.map(async (f) => {
      const path = join(dir, f);
      try {
        const st = await stat(path);
        return { file: f, path, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    }),
  );

  const sorted = withStats
    .filter((x): x is { file: string; path: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  return Promise.all(
    sorted.map(async (entry) => {
      const sessionId = entry.file.replace(/\.jsonl$/, '');
      const { preview, lineCount } = await summarize(entry.path);
      return { sessionId, mtime: entry.mtime, preview, lineCount };
    }),
  );
}

async function listRecentCodexSessions(cwd: string, limit: number): Promise<SessionSummary[]> {
  const root = join(homedir(), '.codex', 'sessions');
  const files = await walkJsonl(root);
  const withStats = await Promise.all(
    files.map(async (path) => {
      try {
        const st = await stat(path);
        return { path, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const sorted = withStats
    .filter((x): x is { path: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime);
  const out: SessionSummary[] = [];
  for (const entry of sorted) {
    const summary = await summarizeCodex(entry.path, cwd);
    if (!summary) continue;
    out.push({ ...summary, mtime: entry.mtime });
    if (out.length >= limit) break;
  }
  return out;
}

async function walkJsonl(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkJsonl(path));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path);
  }
  return out;
}

async function summarize(path: string): Promise<{ preview: string; lineCount: number }> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream });
  let preview = '';
  let lineCount = 0;
  try {
    for await (const line of rl) {
      lineCount++;
      if (!preview && line.includes('"type":"user"')) {
        try {
          const obj = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
          if (obj.type === 'user' && obj.message) {
            const text = extractUserText(obj.message.content);
            if (text) preview = text.slice(0, 80);
          }
        } catch {
          /* malformed line */
        }
      }
      // reading the whole file is fine — sessions are usually under 10k lines
      if (lineCount > 20_000) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { preview: preview || '(空会话)', lineCount };
}

async function summarizeCodex(
  path: string,
  cwd: string,
): Promise<{ sessionId: string; preview: string; lineCount: number } | null> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream });
  let sessionId = '';
  let sessionCwd = '';
  let preview = '';
  let lineCount = 0;
  try {
    for await (const line of rl) {
      lineCount++;
      try {
        const obj = JSON.parse(line) as {
          type?: string;
          payload?: {
            id?: string;
            cwd?: string;
            type?: string;
            role?: string;
            content?: Array<{ type?: string; text?: string }>;
          };
        };
        if (obj.type === 'session_meta') {
          sessionId = obj.payload?.id ?? '';
          sessionCwd = obj.payload?.cwd ?? '';
          if (sessionCwd && sessionCwd !== cwd) return null;
        } else if (!preview && obj.type === 'response_item' && obj.payload?.role === 'user') {
          preview = extractUserText(obj.payload.content);
        }
      } catch {
        /* malformed line */
      }
      if (lineCount > 20_000) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  if (!sessionId || sessionCwd !== cwd) return null;
  return { sessionId, preview: preview || '(空会话)', lineCount };
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        return (block as { text: string }).text.trim();
      }
    }
  }
  return '';
}

/** Format a relative time like "3 小时前", "昨天", "3 天前". */
export function formatRelTime(mtime: number): string {
  const diffMs = Date.now() - mtime;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day === 1) return '昨天';
  if (day < 30) return `${day} 天前`;
  const mo = Math.floor(day / 30);
  return `${mo} 个月前`;
}
