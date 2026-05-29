import { Command } from 'commander';
import { basename } from 'node:path';
import pkg from '../../package.json';
import { runMigrate } from './commands/migrate';
import { runKillCli, runPs } from './commands/ps';
import {
  runSecretsGet,
  runSecretsList,
  runSecretsRemove,
  runSecretsSet,
} from './commands/secrets';
import { configureInstance } from '../config/paths';
import {
  runServiceRestart,
  runServiceStart,
  runServiceStatus,
  runServiceStop,
  runServiceUnregister,
} from './commands/service';
import { runStart } from './commands/start';

const program = new Command();

program
  .name(basename(process.argv[1] ?? 'lark-channel-bridge', '.mjs'))
  .description('Bridge Feishu/Lark messenger with local CLI coding agents')
  .version(pkg.version, '-v, --version');

// === process-level commands (work directly on bridge processes) ===

program
  .command('run')
  .description('Run the bridge in the foreground (was `start` in older versions)')
  .option('-c, --config <path>', 'path to config file')
  .option('--instance <name>', 'named bridge instance (separate config/session/service)')
  .option('--skip-check-lark-cli', 'skip lark-cli pre-flight check (auto-install + bind)')
  .action(async (opts: { config?: string; instance?: string; skipCheckLarkCli?: boolean }) => {
    configureInstance(opts.instance);
    await runStart(opts);
  });

program
  .command('ps')
  .description('List running bridge processes on this machine')
  .action(() => {
    runPs();
  });

program
  .command('kill <target>')
  .description('Kill a running bridge process by short id or list index (SIGTERM, then SIGKILL after 2s). Was `stop <target>` in older versions.')
  .action(async (target: string) => {
    await runKillCli(target);
  });

// === service-level commands (OS-managed daemon: launchd/systemd/schtasks) ===

program
  .command('start')
  .description('Install (if needed) and start the bridge as an OS-managed daemon')
  .option('--instance <name>', 'named bridge instance (separate config/session/service)')
  .option('--skip-check-lark-cli', 'skip lark-cli pre-flight check (auto-install + bind)')
  .action(async (opts: { instance?: string; skipCheckLarkCli?: boolean }) => {
    configureInstance(opts.instance);
    await runServiceStart(opts);
  });

program
  .command('stop')
  .description('Stop the OS-managed daemon (unload from launchd; plist stays)')
  .option('--instance <name>', 'named bridge instance')
  .action(async (opts: { instance?: string }) => {
    configureInstance(opts.instance);
    await runServiceStop();
  });

program
  .command('restart')
  .description('Restart the OS-managed daemon')
  .option('--instance <name>', 'named bridge instance')
  .action(async (opts: { instance?: string }) => {
    configureInstance(opts.instance);
    await runServiceRestart();
  });

program
  .command('status')
  .description('Show OS service status (pid, last exit, log paths)')
  .option('--instance <name>', 'named bridge instance')
  .action(async (opts: { instance?: string }) => {
    configureInstance(opts.instance);
    await runServiceStatus();
  });

program
  .command('unregister')
  .description('Remove the OS service registration (bootout + delete plist)')
  .option('--instance <name>', 'named bridge instance')
  .action(async (opts: { instance?: string }) => {
    configureInstance(opts.instance);
    await runServiceUnregister();
  });

const secrets = program
  .command('secrets')
  .description('Manage the bridge\'s encrypted secret keystore (~/.lark-channel/secrets.enc)');

secrets
  .command('get')
  .description('Exec-provider protocol: read JSON request from stdin, write JSON response to stdout. Used by bridge-managed lark-cli profiles.')
  .option('--instance <name>', 'named bridge instance')
  .action(async (opts: { instance?: string }) => {
    configureInstance(opts.instance);
    await runSecretsGet();
  });

secrets
  .command('set')
  .description('Encrypt and store an App Secret. Prompts for the secret without echoing.')
  .requiredOption('--app-id <id>', 'App ID (e.g. cli_xxxxxxxxxxxx)')
  .option('--instance <name>', 'named bridge instance')
  .action(async (opts: { appId: string; instance?: string }) => {
    configureInstance(opts.instance);
    await runSecretsSet(opts.appId);
  });

secrets
  .command('list')
  .description('List the IDs of secrets in the encrypted keystore (no secrets shown)')
  .option('--instance <name>', 'named bridge instance')
  .action(async (opts: { instance?: string }) => {
    configureInstance(opts.instance);
    await runSecretsList();
  });

secrets
  .command('remove')
  .description('Delete an entry from the encrypted keystore')
  .requiredOption('--app-id <id>', 'App ID to remove')
  .option('--instance <name>', 'named bridge instance')
  .action(async (opts: { appId: string; instance?: string }) => {
    configureInstance(opts.instance);
    await runSecretsRemove(opts.appId);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
