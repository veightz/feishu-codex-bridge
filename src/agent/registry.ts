import type { AppConfig, AgentId } from '../config/schema';
import { getDefaultAgentId } from '../config/schema';
import { ClaudeAdapter } from './claude/adapter';
import { CodexAdapter } from './codex/adapter';
import type { AgentAdapter } from './types';

export class AgentRegistry {
  private readonly agents: Record<AgentId, AgentAdapter>;
  private readonly cfg: AppConfig;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    this.agents = {
      claude: new ClaudeAdapter(cfg.agent?.claude),
      codex: new CodexAdapter(cfg.agent?.codex),
    };
  }

  getDefaultId(): AgentId {
    return getDefaultAgentId(this.cfg);
  }

  get(id: AgentId): AgentAdapter {
    return this.agents[id];
  }

  resolve(id: AgentId | undefined): AgentAdapter {
    return this.get(id ?? this.getDefaultId());
  }

  list(): Array<{ id: AgentId; adapter: AgentAdapter; isDefault: boolean }> {
    return (Object.keys(this.agents) as AgentId[]).map((id) => ({
      id,
      adapter: this.agents[id],
      isDefault: id === this.getDefaultId(),
    }));
  }
}

export function isAgentId(value: string): value is AgentId {
  return value === 'claude' || value === 'codex';
}
