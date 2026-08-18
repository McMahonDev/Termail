import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ACCOUNTS_ROOT, accountAttachmentsDir, accountBodiesDir, accountCachePath, accountDataDir } from './paths.js';
import { forgetAccount } from './mailStore.js';

async function dirSize(path) {
  let total = 0;
  let entries;

  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(child);
    } else {
      try {
        total += (await stat(child)).size;
      } catch {
        // Vanished between readdir and stat; nothing to count.
      }
    }
  }

  return total;
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

export function formatBytes(bytes) {
  if (!bytes) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

/** Per-account disk usage, split so the clear-cache screen can show what each option frees. */
export async function cacheUsage(accountId) {
  if (!accountId) {
    return { messages: 0, attachments: 0, total: 0 };
  }

  // The index and the per-message body files are one thing to the user, so
  // they are reported — and cleared — together.
  const messages = (await fileSize(accountCachePath(accountId))) + (await dirSize(accountBodiesDir(accountId)));
  const attachments = await dirSize(accountAttachmentsDir(accountId));
  return { messages, attachments, total: messages + attachments };
}

export async function totalCacheUsage() {
  return dirSize(ACCOUNTS_ROOT);
}

/**
 * `scope` picks how much goes:
 *   'messages'    — the cached message list only; attachments survive
 *   'attachments' — downloaded attachment files only
 *   'account'     — everything cached for this account
 *   'all'         — every account's cache
 * Credentials are never touched here; removing an account is a separate action.
 */
export async function clearCache(accountId, scope = 'account') {
  if (scope === 'all') {
    await rm(ACCOUNTS_ROOT, { recursive: true, force: true });
    forgetAccount(null);
    return { scope, cleared: true };
  }

  if (!accountId) {
    return { scope, cleared: false, error: 'No account selected' };
  }

  if (scope === 'messages') {
    await rm(accountCachePath(accountId), { force: true });
    await rm(accountBodiesDir(accountId), { recursive: true, force: true });
  } else if (scope === 'attachments') {
    await rm(accountAttachmentsDir(accountId), { recursive: true, force: true });
  } else {
    await rm(accountDataDir(accountId), { recursive: true, force: true });
  }

  forgetAccount(accountId);
  return { scope, cleared: true };
}
