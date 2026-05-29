import type { AppConfig, AgentId } from '../config/schema';
import { getDefaultAgentId } from '../config/schema';
import { larkCliProfileName } from '../config/paths';
import { ClaudeAdapter } from './claude/adapter';
import { CodexAdapter } from './codex/adapter';
import type { AgentAdapter } from './types';

export class AgentRegistry {
  private readonly agents: Record<AgentId, AgentAdapter>;
  private readonly cfg: AppConfig;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    const larkCliProfile = larkCliProfileName();
    this.agents = {
      claude: new ClaudeAdapter({ ...cfg.agent?.claude, larkCliProfile }),
      codex: new CodexAdapter({ ...cfg.agent?.codex, larkCliProfile }),
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
