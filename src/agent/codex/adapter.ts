import type { ChildProcessByStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { log } from '../../core/logger';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { translateEvent } from './stream-json';

export interface CodexAdapterOptions {
  binary?: string;
  model?: string;
  profile?: string;
  larkCliProfile?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  dangerouslyBypassApprovalsAndSandbox?: boolean;
}

type CodexChild = ChildProcessByStdio<null, Readable, Readable>;

const BRIDGE_INSTRUCTIONS = `# lark-channel-bridge 运行约定

你正在 lark-channel-bridge 里跑：把飞书/Lark 用户消息桥到本地 \`codex\` CLI。

每条 user message 顶部会带一个 \`<bridge_context>\` 块，里面是当前对话的 chat_id、chat 类型和发送者。它对用户不可见，不要照抄。

如果用户引用消息，bridge 会注入 \`<quoted_message>\`；如果消息或引用里有交互卡片，bridge 会注入 \`<interactive_card>\`。回答时围绕用户实际问题处理，不要把这些 XML 标签原样渲染给用户。

如果你用 lark-cli 发可交互卡片，并希望用户点击后回到同一 bridge 会话，按钮 callback value 里放 \`"__bridge_cb": true\`。旧的 \`"__claude_cb": true\` 也能兼容，但新卡片优先使用 \`__bridge_cb\`。
`;

function buildBridgeInstructions(larkCliProfile: string): string {
  return `${BRIDGE_INSTRUCTIONS}

## lark-cli profile

本 bridge 实例绑定的 lark-cli profile 是 \`${larkCliProfile}\`。
任何 lark-cli 调用都必须显式带上这个 profile，例如：
\`lark-cli --profile ${larkCliProfile} im send-card --chat-id <chat_id> --card '<json>'\`

不要使用裸 \`lark-cli ...\`，也不要切换或覆盖全局默认 profile；同一台机器可能同时运行 Claude / Codex 等多个 bridge，每个 bridge 都对应不同的飞书机器人 App。
`;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex';

  private readonly binary: string;
  private readonly model?: string;
  private readonly profile?: string;
  private readonly larkCliProfile: string;
  private readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  private readonly dangerouslyBypassApprovalsAndSandbox: boolean;

  constructor(opts: CodexAdapterOptions = {}) {
    this.binary = opts.binary ?? 'codex';
    this.model = opts.model;
    this.profile = opts.profile;
    this.larkCliProfile = opts.larkCliProfile ?? 'bridge-default';
    this.sandbox = opts.sandbox ?? 'workspace-write';
    this.dangerouslyBypassApprovalsAndSandbox =
      opts.dangerouslyBypassApprovalsAndSandbox === true;
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.binary, ['--version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    const prompt = `${buildBridgeInstructions(this.larkCliProfile)}\n\n${opts.prompt}`;
    const args = this.buildArgs(prompt, opts);
    const child = spawn(this.binary, args, {
      cwd: opts.cwd,
      env: { ...process.env, LARK_CHANNEL: '1', LARK_CLI_PROFILE: this.larkCliProfile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    log.info('agent', 'spawn', {
      agent: this.id,
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model ?? this.model,
    });

    const stderrChunks: Buffer[] = [];
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { agent: this.id, line });
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let runtimeError: Error | null = null;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { agent: this.id, pid: child.pid ?? null, code, signal });
    });

    const stopGraceMs = opts.stopGraceMs ?? 5000;
    return {
      events: createEventStream(child, stderrChunks, () => runtimeError),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', { agent: 'codex', pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                agent: 'codex',
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }

  private buildArgs(prompt: string, opts: AgentRunOptions): string[] {
    const model = opts.model ?? this.model;
    const args = ['exec'];
    args.push('--json');
    args.push('--skip-git-repo-check');
    if (model) args.push('--model', model);
    if (this.profile) args.push('--profile', this.profile);
    if (this.dangerouslyBypassApprovalsAndSandbox) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (!opts.sessionId) {
      args.push('--sandbox', this.sandbox);
    }
    if (opts.sessionId) {
      args.push('resume', opts.sessionId);
    } else if (opts.cwd) {
      args.push('--cd', opts.cwd);
    }
    args.push(prompt);
    return args;
  }
}

async function* createEventStream(
  child: CodexChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn codex: ${err.message}` : 'spawn returned no pid',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      yield* translateEvent(parsed);
    }
  } finally {
    rl.close();
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.once('exit', (code) => resolve(code));
  });

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield { type: 'error', message: `codex exited with code ${exitCode}${detail}` };
  } else if (runtimeError) {
    yield { type: 'error', message: `codex runtime error: ${runtimeError.message}` };
  }
}
