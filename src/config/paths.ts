import { homedir } from 'node:os';
import { join } from 'node:path';

const baseAppDir = join(homedir(), '.lark-channel');
let currentInstance: string | undefined;
let appDir = baseAppDir;

export const paths = {
  get appDir() { return appDir; },
  get cacheDir() { return appDir; },
  get configFile() { return join(appDir, 'config.json'); },
  get sessionsFile() { return join(appDir, 'sessions.json'); },
  get workspacesFile() { return join(appDir, 'workspaces.json'); },
  get processesFile() { return join(baseAppDir, 'processes.json'); },
  get secretsFile() { return join(appDir, 'secrets.enc'); },
  get keystoreSaltFile() { return join(appDir, '.keystore.salt'); },
  /**
   * Thin shell wrapper that lark-cli (and other openclaw-exec-protocol
   * consumers) invoke to resolve secrets from the bridge's encrypted store.
   * Written user-owned and non-symlinked so it passes lark-cli's
   * AssertSecurePath audit on machines where `node` is a Homebrew/Volta
   * symlink or root-owned (`/usr/bin/node`). Wrapper internals do the
   * `node ... secrets get` invocation; lark-cli only audits the wrapper.
   */
  get secretsGetterScript() { return join(appDir, 'secrets-getter'); },
  get mediaDir() { return join(appDir, 'media'); },
};

export function configureInstance(instance: string | undefined): void {
  const normalized = normalizeInstance(instance);
  currentInstance = normalized;
  appDir = normalized ? join(baseAppDir, 'instances', normalized) : baseAppDir;
}

export function getInstance(): string | undefined {
  return currentInstance;
}

export function instanceSuffix(): string {
  return currentInstance ? `.${currentInstance}` : '';
}

export function larkCliProfileName(): string {
  return currentInstance ? `bridge-${currentInstance}` : 'bridge-default';
}

function normalizeInstance(instance: string | undefined): string | undefined {
  const value = instance?.trim();
  if (!value || value === 'default') return undefined;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/.test(value)) {
    throw new Error('instance 只能包含字母、数字、下划线和中划线，且长度不超过 41');
  }
  return value;
}

/**
 * Pre-0.1.11 paths (XDG-style). Kept here only so the `migrate` command
 * can detect and move data out of the old location. Don't reference these
 * anywhere in the runtime.
 */
export const legacyPaths = {
  appDir: join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'lark-channel-bridge',
  ),
  cacheDir: join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
    'lark-channel-bridge',
  ),
};
