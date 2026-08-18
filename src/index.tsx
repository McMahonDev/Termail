import React from 'react';
import { render } from 'ink';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { App } from './App.js';
import { migrateLegacySetup, listAccounts, configFileInfo } from './config.js';
import { cacheUsage, clearCache, formatBytes, totalCacheUsage } from './cache.js';
import { CONFIG_DIR, CONFIG_PATH, DATA_DIR } from './paths.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function version() {
  try {
    return JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const HELP = `TerMail — a terminal email client

Usage
  TerMail                     Open the mailbox
  TerMail accounts            Open the account manager
  TerMail clear-cache [what]  Delete cached mail without opening the UI
  TerMail where               Print the config and data locations
  TerMail --version           Print the version
  TerMail --help              This text

clear-cache accepts one of:
  messages      Cached message list and bodies for the active account
  attachments   Downloaded attachments for the active account
  account       Both of the above (default)
  all           Every account's cache

Accounts live in ~/.config/termail/config.json (mode 600) and are managed from
inside the app — press A. Cached mail lives in ~/.local/share/termail.
`;

async function runClearCache(scopeArg: string) {
  const allowed = ['messages', 'attachments', 'account', 'all'];
  const scope = allowed.includes(scopeArg) ? scopeArg : 'account';

  if (scopeArg && !allowed.includes(scopeArg)) {
    process.stderr.write(`Unknown target "${scopeArg}". Expected one of: ${allowed.join(', ')}\n`);
    return 1;
  }

  const { activeAccountId, accounts } = await listAccounts();

  if (scope === 'all') {
    const before = await totalCacheUsage();
    await clearCache(null, 'all');
    process.stdout.write(`Cleared every account's cache (${formatBytes(before)} freed).\n`);
    return 0;
  }

  if (!activeAccountId) {
    process.stderr.write('No account is configured, so there is nothing cached to clear.\n');
    return 1;
  }

  const label = accounts.find((account: any) => account.id === activeAccountId)?.label || activeAccountId;
  const usage = await cacheUsage(activeAccountId);
  const before = scope === 'messages' ? usage.messages : scope === 'attachments' ? usage.attachments : usage.total;

  await clearCache(activeAccountId, scope as 'messages' | 'attachments' | 'account');
  process.stdout.write(`Cleared ${scope} cache for ${label} (${formatBytes(before)} freed).\n`);
  return 0;
}

async function runWhere() {
  const config = await configFileInfo();
  const { accounts, activeAccountId } = await listAccounts();
  const active = accounts.find((account: any) => account.id === activeAccountId);

  process.stdout.write([
    `config dir   ${CONFIG_DIR}`,
    `config file  ${CONFIG_PATH}${config.exists ? ` (mode ${config.mode})` : ' (not created yet)'}`,
    `data dir     ${DATA_DIR}`,
    `accounts     ${accounts.length}${active ? ` (active: ${active.label})` : ''}`,
    `cache size   ${formatBytes(await totalCacheUsage())}`,
    ''
  ].join('\n'));

  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || '';

  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP);
    return;
  }

  if (command === '--version' || command === '-v') {
    process.stdout.write(`${await version()}\n`);
    return;
  }

  if (command === 'clear-cache' || command === '--clear-cache') {
    process.exitCode = await runClearCache((args[1] || '').replace(/^--/, ''));
    return;
  }

  if (command === 'where') {
    process.exitCode = await runWhere();
    return;
  }

  if (command && command !== 'accounts' && command !== '--accounts') {
    process.stderr.write(`Unknown command "${command}". Try TerMail --help\n`);
    process.exitCode = 1;
    return;
  }

  // Folds a pre-TerMail .env and cwd-relative .data/ into the real config and
  // data directories. No-ops once an account exists.
  let startupNotice = '';
  try {
    startupNotice = (await migrateLegacySetup())?.message || '';
  } catch (error) {
    startupNotice = `Legacy import failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (process.stdout.isTTY) {
    // Clear launcher output (npm banners, shell noise) so the TUI starts clean.
    process.stdout.write('\u001bc');
  }

  render(
    <App
      startupNotice={startupNotice}
      initialScreen={command === 'accounts' || command === '--accounts' ? 'accounts' : 'mail'}
    />,
    { exitOnCtrlC: false }
  );
}

await main();
