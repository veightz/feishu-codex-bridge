import { spawn, spawnSync } from 'node:child_process';
import * as p from '@clack/prompts';
import { larkCliProfileName } from '../config/paths';
import { resolveAppSecret } from '../config/secret-resolver';
import type { AppConfig } from '../config/schema';

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const BIND_TIMEOUT_MS = 30 * 1000;

const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const MANUAL_INSTALL_HINT = [
  '手动安装命令:',
  `  ${BOLD}npm install -g @larksuite/cli${RESET}`,
  `  ${BOLD}lark-cli config init --name <profile> --app-id <app_id> --brand feishu --app-secret-stdin${RESET}`,
  `  ${BOLD}lark-cli --profile <profile> config strict-mode bot${RESET}`,
  `  ${BOLD}lark-cli --profile <profile> config default-as bot${RESET}`,
  '',
  '完整文档: https://github.com/larksuite/cli',
].join('\n');

export interface PreFlightOptions {
  /** Skip lark-cli auto-install + bind. */
  skipCheckLarkCli?: boolean;
  cfg?: AppConfig;
  // Future: skipCheckXxx?: boolean;
}

export async function preFlightChecks(opts: PreFlightOptions): Promise<void> {
  await checkLarkCli(opts);
  // Future: await checkXxx(opts);
}

async function checkLarkCli(opts: PreFlightOptions): Promise<void> {
  if (opts.skipCheckLarkCli) return;
  let installed = isLarkCliInstalled();

  if (!installed) {
    console.log(
      [
        '',
        'ℹ️  lark-cli 未安装',
        '',
        'lark-cli 是飞书的命令行工具,装上后 agent 可以:',
        '  • 主动发送交互卡片 / 表单',
        '  • 查询日历、文档、待办、OKR、考勤',
        '  • 200+ 飞书 API 命令',
        '',
      ].join('\n'),
    );

    // Non-TTY (daemon / launchd / nohup / CI): don't auto-install — users
    // running headless typically don't expect a long network install to fire
    // under them. Print manual hint and continue startup.
    if (!process.stdin.isTTY) {
      console.log(`(非交互模式,跳过自动安装)\n\n${MANUAL_INSTALL_HINT}\n`);
      return;
    }

    p.intro('Setting up lark-cli');

    // Step 1: install
    const sInstall = p.spinner();
    sInstall.start('Installing lark-cli');
    const installResult = await runCapture(
      'npm',
      ['install', '-g', '@larksuite/cli'],
      INSTALL_TIMEOUT_MS,
    );
    installed = isLarkCliInstalled();
    if (!installResult.success || !installed) {
      sInstall.error('Install failed');
      if (installResult.output.trim()) {
        console.error(installResult.output);
      }
      p.outro('lark-cli 安装未完成');
      printInstallFailedWarning();
      return;
    }
    sInstall.stop('Installed');
  }

  if (!opts.cfg) {
    console.warn('⚠ lark-cli 已安装,但缺少 bridge 配置,跳过 profile 绑定。');
    return;
  }

  await ensureLarkCliProfile(opts.cfg);
  if (!process.stdin.isTTY) return;
  p.outro('Done');
}

async function ensureLarkCliProfile(cfg: AppConfig): Promise<void> {
  const profile = larkCliProfileName();
  const secret = await resolveAppSecret(cfg);
  const profileLabel = `${profile} (${cfg.accounts.app.id})`;

  const sBind = process.stdin.isTTY ? p.spinner() : undefined;
  sBind?.start(`Binding lark-cli profile ${profile}`);

  const initResult = await runCapture(
    'lark-cli',
    [
      'config',
      'init',
      '--name',
      profile,
      '--app-id',
      cfg.accounts.app.id,
      '--brand',
      cfg.accounts.app.tenant,
      '--app-secret-stdin',
    ],
    BIND_TIMEOUT_MS,
    secret,
  );
  if (!initResult.success) {
    sBind?.error('Bind failed');
    printProfileBindFailure(profileLabel, initResult.output);
    return;
  }

  const strictResult = await runCapture(
    'lark-cli',
    ['--profile', profile, 'config', 'strict-mode', 'bot'],
    BIND_TIMEOUT_MS,
  );
  const defaultAsResult = await runCapture(
    'lark-cli',
    ['--profile', profile, 'config', 'default-as', 'bot'],
    BIND_TIMEOUT_MS,
  );
  if (!strictResult.success || !defaultAsResult.success) {
    sBind?.error('Identity setup failed');
    printProfileBindFailure(
      profileLabel,
      [strictResult.output, defaultAsResult.output].filter(Boolean).join('\n'),
    );
    return;
  }

  sBind?.stop(`Bound ${profileLabel}`);
  if (!process.stdin.isTTY) {
    console.log(`✓ lark-cli profile 已绑定: ${profileLabel}`);
  }
}

function printProfileBindFailure(profileLabel: string, output: string): void {
  if (output.trim()) {
    console.log(output);
  }
  console.log(
    [
      `lark-cli profile 自动绑定失败: ${profileLabel}`,
      'Bridge 仍会继续启动,但 agent 调用飞书工具时可能受限。',
      '可稍后手动执行等价的 profile 初始化,不要覆盖其它 bridge 的默认 profile。',
    ].join('\n'),
  );
}

function printInstallFailedWarning(): void {
  console.error(
    [
      '',
      `${BOLD}╔════════════════════════════════════════════════════════════════╗${RESET}`,
      `${BOLD}║  ⚠️  lark-cli 自动安装失败                                     ║${RESET}`,
      `${BOLD}╚════════════════════════════════════════════════════════════════╝${RESET}`,
      '',
      '原因可能是:网络不通 / npm 全局安装无权限 / registry 异常',
      '',
      'Bridge 仍会继续启动,但 agent 工具调用会受限。',
      '请手动执行:',
      '',
      `  ${BOLD}npm install -g @larksuite/cli${RESET}`,
      `  ${BOLD}lark-cli config init --name <profile> --app-id <app_id> --brand feishu --app-secret-stdin${RESET}`,
      `  ${BOLD}lark-cli --profile <profile> config strict-mode bot${RESET}`,
      `  ${BOLD}lark-cli --profile <profile> config default-as bot${RESET}`,
      '',
      '完整文档: https://github.com/larksuite/cli',
      '装完之后无需重启 bridge(它只在启动时检测一次)。',
      '',
    ].join('\n'),
  );
}

function isLarkCliInstalled(): boolean {
  try {
    const result = spawnSync('lark-cli', ['--version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: process.platform === 'win32',
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

interface RunResult {
  success: boolean;
  /** Captured stdout + stderr from the child. Useful only on failure. */
  output: string;
}

/**
 * Run a child process, capture stdout/stderr to a buffer (keeps the
 * surrounding clack spinner UI clean), enforce a timeout. Used for the
 * npm install and lark-cli bind steps in the preflight check.
 */
async function runCapture(
  cmd: string,
  args: string[],
  timeoutMs: number,
  stdin?: string,
): Promise<RunResult> {
  const onWindows = process.platform === 'win32';
  let captured = '';
  let timedOut = false;

  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(cmd, args, {
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      shell: onWindows,
    });
    if (stdin !== undefined) {
      child.stdin?.end(`${stdin}\n`);
    }
    child.stdout?.on('data', (b: Buffer) => {
      captured += b.toString('utf8');
    });
    child.stderr?.on('data', (b: Buffer) => {
      captured += b.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  return { success: !timedOut && exitCode === 0, output: captured };
}
