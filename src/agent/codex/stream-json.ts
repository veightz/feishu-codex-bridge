import type { AgentEvent } from '../types';

interface CodexRawEvent {
  type?: string;
  thread_id?: string;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  item?: {
    id?: string;
    type?: string;
    text?: string;
    message?: string;
    name?: string;
    command?: string | string[];
    arguments?: unknown;
    input?: unknown;
    output?: unknown;
    status?: string;
  };
}

export function* translateEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as CodexRawEvent;

  if (evt.type === 'thread.started') {
    yield { type: 'system', sessionId: evt.thread_id };
    return;
  }

  if ((evt.type === 'item.completed' || evt.type === 'item.updated') && evt.item) {
    yield* translateItem(evt.type, evt.item);
    return;
  }

  if (evt.type === 'turn.completed') {
    if (evt.usage) {
      yield {
        type: 'usage',
        inputTokens: evt.usage.input_tokens,
        outputTokens: evt.usage.output_tokens,
      };
    }
    yield { type: 'done' };
    return;
  }

  if (evt.type === 'error' && typeof evt.item?.message === 'string') {
    yield { type: 'error', message: evt.item.message };
  }
}

function* translateItem(type: string, item: NonNullable<CodexRawEvent['item']>): Generator<AgentEvent> {
  const id = item.id ?? `${item.type ?? 'item'}-${Math.random().toString(36).slice(2)}`;

  if (item.type === 'agent_message' && item.text) {
    yield { type: 'text', delta: item.text };
    return;
  }

  if (item.type === 'reasoning') {
    const text = item.text ?? item.message;
    if (text) yield { type: 'thinking', delta: text };
    return;
  }

  if (item.type === 'error' && item.message) {
    // Codex may emit non-fatal warnings (for example config deprecations)
    // as item-level "error" records and then continue the turn. Only the
    // top-level `type: "error"` event is terminal for the bridge.
    yield { type: 'thinking', delta: `⚠ ${item.message}\n` };
    return;
  }

  const toolName = toolDisplayName(item);
  if (!toolName) return;

  if (type === 'item.updated' && item.status !== 'completed' && item.status !== 'failed') {
    yield { type: 'tool_use', id, name: toolName, input: toolInput(item) };
    return;
  }

  yield { type: 'tool_use', id, name: toolName, input: toolInput(item) };
  yield {
    type: 'tool_result',
    id,
    output: stringifyOutput(item.output ?? item.message ?? item.status ?? ''),
    isError: item.status === 'failed',
  };
}

function toolDisplayName(item: NonNullable<CodexRawEvent['item']>): string | undefined {
  switch (item.type) {
    case 'command_execution':
      return 'Command';
    case 'mcp_tool_call':
      return item.name ? `MCP:${item.name}` : 'MCP';
    case 'file_change':
      return 'FileChange';
    case 'web_search':
      return 'WebSearch';
    default:
      return undefined;
  }
}

function toolInput(item: NonNullable<CodexRawEvent['item']>): unknown {
  if (item.command) return { command: Array.isArray(item.command) ? item.command.join(' ') : item.command };
  if (item.arguments) return item.arguments;
  if (item.input) return item.input;
  return {};
}

function stringifyOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
