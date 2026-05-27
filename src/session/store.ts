import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentId } from '../config/schema';
import { paths } from '../config/paths';
import { log } from '../core/logger';

export interface AgentSessionEntry {
  sessionId?: string;
  cwd?: string;
  /** Last bridge turn known to this native session. */
  updatedAt?: number;
}

export interface TranscriptTurn {
  agentId: AgentId;
  user: string;
  assistant: string;
  updatedAt: number;
}

export interface SessionEntry {
  /** May be absent if the entry was created by /timeout before any run
   * recorded a session id. Treat absence as "no resumable session". */
  sessionId?: string;
  /** Pinned cwd for the resumable session. Absent for the same reason. */
  cwd?: string;
  /** Active agent override for this scope. Undefined means follow config default. */
  activeAgentId?: AgentId;
  /** Per-agent native session/thread ids. */
  agents?: Partial<Record<AgentId, AgentSessionEntry>>;
  /** Bridge-owned short transcript used when switching to an agent with no native session yet. */
  transcript?: TranscriptTurn[];
  updatedAt: number;
  /** Per-scope idle-timeout override (minutes). 0 = explicitly off for this
   * scope, undefined = follow global default. /new clears conversation
   * state, so this resets to "follow global" when the user starts a new session. */
  idleTimeoutMinutes?: number;
}

type SessionMap = Record<string, SessionEntry>;

export class SessionStore {
  private data: SessionMap = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = paths.sessionsFile) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const raw = JSON.parse(text) as Record<string, Partial<SessionEntry>>;
      this.data = {};
      for (const [chatId, entry] of Object.entries(raw)) {
        if (!entry || typeof entry.updatedAt !== 'number') continue;
        // Drop entries without a `cwd`/`sessionId` pair *unless* there's
        // some other persisted state worth keeping (e.g. an idle-timeout
        // override). Resuming a session whose cwd we don't know about
        // would make the native agent resume from the wrong place, so
        // resume keys still need the full pair; but a bare timeout
        // override is fine on its own.
        const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : undefined;
        const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined;
        const activeAgentId =
          entry.activeAgentId === 'claude' || entry.activeAgentId === 'codex'
            ? entry.activeAgentId
            : undefined;
        const agents = normalizeAgents(entry.agents, sessionId, cwd);
        const transcript = normalizeTranscript(entry.transcript);
        const idleTimeoutMinutes =
          typeof entry.idleTimeoutMinutes === 'number' ? entry.idleTimeoutMinutes : undefined;
        const hasSession = Object.values(agents).some((x) => x?.sessionId && x.cwd);
        if (!hasSession && idleTimeoutMinutes === undefined && !activeAgentId && transcript.length === 0) continue;
        this.data[chatId] = {
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          ...(activeAgentId ? { activeAgentId } : {}),
          ...(Object.keys(agents).length > 0 ? { agents } : {}),
          ...(transcript.length > 0 ? { transcript } : {}),
          updatedAt: entry.updatedAt,
          ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}),
        };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  /**
   * Return the session id for this chat if it was created in the given cwd.
   * Sessions recorded in a different cwd are stale — native CLIs generally
   * expect to resume from the working directory where the session started.
   */
  resumeFor(chatId: string, cwd: string): string | undefined {
    return this.resumeForAgent(chatId, cwd, 'claude');
  }

  resumeForAgent(chatId: string, cwd: string, agentId: AgentId): string | undefined {
    const entry = this.data[chatId];
    if (!entry) return undefined;
    const scoped = entry.agents?.[agentId];
    if (scoped) {
      if (scoped.cwd !== cwd) return undefined;
      return scoped.sessionId;
    }
    if (agentId !== 'claude') return undefined;
    if (entry.cwd !== cwd) return undefined;
    return entry.sessionId;
  }

  getRaw(chatId: string): SessionEntry | undefined {
    return this.data[chatId];
  }

  set(chatId: string, sessionId: string, cwd: string): void {
    this.setForAgent(chatId, 'claude', sessionId, cwd);
  }

  setForAgent(chatId: string, agentId: AgentId, sessionId: string, cwd: string): void {
    // Preserve idleTimeoutMinutes across run starts — it's a per-scope
    // preference, not per-run-instance state. /new (clear) wipes it.
    const prev = this.data[chatId];
    const agents: Partial<Record<AgentId, AgentSessionEntry>> = {
      ...(prev?.agents ?? {}),
      [agentId]: { sessionId, cwd, updatedAt: prev?.agents?.[agentId]?.updatedAt ?? Date.now() },
    };
    this.data[chatId] = {
      ...(agentId === 'claude' ? { sessionId, cwd } : legacyFromAgents(agents)),
      ...(prev?.activeAgentId ? { activeAgentId: prev.activeAgentId } : {}),
      agents,
      ...(prev?.transcript ? { transcript: prev.transcript } : {}),
      updatedAt: Date.now(),
      ...(prev?.idleTimeoutMinutes !== undefined
        ? { idleTimeoutMinutes: prev.idleTimeoutMinutes }
        : {}),
    };
    this.schedulePersist();
  }

  getActiveAgentId(chatId: string, defaultAgentId: AgentId): AgentId {
    return this.data[chatId]?.activeAgentId ?? defaultAgentId;
  }

  setActiveAgentId(chatId: string, agentId: AgentId): void {
    const prev = this.data[chatId];
    this.data[chatId] = {
      ...(prev ?? { updatedAt: Date.now() }),
      activeAgentId: agentId,
      updatedAt: Date.now(),
    };
    this.schedulePersist();
  }

  clearActiveAgentId(chatId: string): void {
    const prev = this.data[chatId];
    if (!prev?.activeAgentId) return;
    const { activeAgentId: _, ...rest } = prev;
    this.data[chatId] = { ...rest, updatedAt: Date.now() };
    this.schedulePersist();
  }

  appendTurn(chatId: string, agentId: AgentId, user: string, assistant: string): void {
    const prev = this.data[chatId];
    const turn: TranscriptTurn = {
      agentId,
      user: truncate(user, 4000),
      assistant: truncate(assistant, 4000),
      updatedAt: Date.now(),
    };
    const transcript = [...(prev?.transcript ?? []), turn].slice(-8);
    const agents: Partial<Record<AgentId, AgentSessionEntry>> = { ...(prev?.agents ?? {}) };
    const native = agents[agentId];
    if (native) agents[agentId] = { ...native, updatedAt: turn.updatedAt };
    this.data[chatId] = {
      ...(prev ?? { updatedAt: Date.now() }),
      ...(Object.keys(agents).length > 0 ? { agents } : {}),
      transcript,
      updatedAt: Date.now(),
    };
    this.schedulePersist();
  }

  transcriptPrompt(chatId: string, afterUpdatedAt = 0): string {
    const transcript = this.data[chatId]?.transcript?.filter((t) => t.updatedAt > afterUpdatedAt);
    if (!transcript || transcript.length === 0) return '';
    const body = transcript
      .map((t, i) => {
        return [
          `## Turn ${i + 1} (${t.agentId})`,
          `User:\n${t.user}`,
          `Assistant:\n${t.assistant}`,
        ].join('\n');
      })
      .join('\n\n');
    return `<bridge_transcript>\n${body}\n</bridge_transcript>\n\n`;
  }

  clear(chatId: string): void {
    if (!(chatId in this.data)) return;
    const activeAgentId = this.data[chatId]?.activeAgentId;
    if (activeAgentId) {
      this.data[chatId] = { activeAgentId, updatedAt: Date.now() };
    } else {
      delete this.data[chatId];
    }
    this.schedulePersist();
  }

  /** Per-scope idle-timeout override. `undefined` means no override set. */
  getIdleTimeoutMinutes(chatId: string): number | undefined {
    return this.data[chatId]?.idleTimeoutMinutes;
  }

  setIdleTimeoutMinutes(chatId: string, minutes: number): void {
    const clamped = Math.min(Math.max(Math.floor(minutes), 0), 120);
    const prev = this.data[chatId];
    this.data[chatId] = {
      ...(prev ?? { updatedAt: Date.now() }),
      idleTimeoutMinutes: clamped,
      updatedAt: Date.now(),
    };
    this.schedulePersist();
  }

  /** Remove the override so this scope falls back to the global default.
   * Returns true if something was actually removed. */
  clearIdleTimeoutOverride(chatId: string): boolean {
    const prev = this.data[chatId];
    if (!prev || prev.idleTimeoutMinutes === undefined) return false;
    const { idleTimeoutMinutes: _, ...rest } = prev;
    this.data[chatId] = { ...rest, updatedAt: Date.now() };
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      })
      .catch((err: unknown) => {
        log.fail('session', err, { step: 'persist' });
      });
  }
}

function normalizeAgents(
  raw: unknown,
  legacySessionId: string | undefined,
  legacyCwd: string | undefined,
): Partial<Record<AgentId, AgentSessionEntry>> {
  const agents: Partial<Record<AgentId, AgentSessionEntry>> = {};
  if (raw && typeof raw === 'object') {
    for (const id of ['claude', 'codex'] as AgentId[]) {
      const entry = (raw as Record<string, unknown>)[id];
      if (!entry || typeof entry !== 'object') continue;
      const sessionId =
        typeof (entry as { sessionId?: unknown }).sessionId === 'string'
          ? (entry as { sessionId: string }).sessionId
          : undefined;
      const cwd =
        typeof (entry as { cwd?: unknown }).cwd === 'string'
          ? (entry as { cwd: string }).cwd
          : undefined;
      const updatedAt =
        typeof (entry as { updatedAt?: unknown }).updatedAt === 'number'
          ? (entry as { updatedAt: number }).updatedAt
          : undefined;
      if (sessionId && cwd) {
        agents[id] = { sessionId, cwd, ...(updatedAt !== undefined ? { updatedAt } : {}) };
      }
    }
  }
  if (!agents.claude && legacySessionId && legacyCwd) {
    agents.claude = { sessionId: legacySessionId, cwd: legacyCwd };
  }
  return agents;
}

function normalizeTranscript(raw: unknown): TranscriptTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x): TranscriptTurn | null => {
      if (!x || typeof x !== 'object') return null;
      const rec = x as Partial<TranscriptTurn>;
      if ((rec.agentId !== 'claude' && rec.agentId !== 'codex') || typeof rec.user !== 'string') {
        return null;
      }
      return {
        agentId: rec.agentId,
        user: rec.user,
        assistant: typeof rec.assistant === 'string' ? rec.assistant : '',
        updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : Date.now(),
      };
    })
    .filter((x): x is TranscriptTurn => x !== null)
    .slice(-8);
}

function legacyFromAgents(
  agents: Partial<Record<AgentId, AgentSessionEntry>>,
): Pick<SessionEntry, 'sessionId' | 'cwd'> {
  const claude = agents.claude;
  return claude?.sessionId && claude.cwd ? { sessionId: claude.sessionId, cwd: claude.cwd } : {};
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
