import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_DIR_NAME = 'termail';

function xdg(envVar, fallbackSegments) {
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.startsWith('/')) {
    return join(fromEnv, APP_DIR_NAME);
  }
  return join(homedir(), ...fallbackSegments, APP_DIR_NAME);
}

/** ~/.config/termail — credentials and preferences. */
export const CONFIG_DIR = xdg('XDG_CONFIG_HOME', ['.config']);

/** ~/.local/share/termail — cached mail and attachments. */
export const DATA_DIR = xdg('XDG_DATA_HOME', ['.local', 'share']);

export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

/** Everything cached for one account lives under a single directory. */
export function accountDataDir(accountId) {
  return join(DATA_DIR, 'accounts', accountId);
}

export function accountCachePath(accountId) {
  return join(accountDataDir(accountId), 'mail-cache.json');
}

export function accountAttachmentsDir(accountId) {
  return join(accountDataDir(accountId), 'attachments');
}

/** Message bodies, one file each, kept out of the index that stays in memory. */
export function accountBodiesDir(accountId) {
  return join(accountDataDir(accountId), 'bodies');
}

export const ACCOUNTS_ROOT = join(DATA_DIR, 'accounts');
