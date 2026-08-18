import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { accountBodiesDir, accountCachePath } from './paths.js';
import { safePart } from './mailParts.js';

/**
 * Bump when the on-disk shape changes. v1 kept bodyText/bodyHtml inline in the
 * index; v2 moves them to one file per message. loadStore migrates v1 in place.
 */
const STORE_VERSION = 2;

/**
 * The index is held in memory per account and written through on mutation, so
 * it has to stay small: message bodies (HTML especially) are the bulk of a real
 * mailbox — 85% of a 200MB cache measured here — and they are only ever read
 * one at a time by the render endpoint. Keeping them out of the index is what
 * makes a full sync survivable: it caps both the resident set and, critically,
 * the size of the single string JSON.stringify has to materialise on every
 * write. V8 refuses to build a string over ~512MB, so an inline-body index is
 * on a collision course with a hard limit that no --max-old-space-size raises.
 */
const loaded = new Map();

function emptyStore() {
  return { version: STORE_VERSION, messages: [], deletedIds: [], lastSyncAt: null };
}

/**
 * safePart alone can map two distinct ids onto one filename (POP3 UIDLs are
 * arbitrary printable bytes), so a hash of the untouched id disambiguates, and
 * its first byte shards the directory to keep it from growing to one flat
 * directory of a hundred thousand entries.
 */
function bodyPath(accountId, id) {
  const digest = createHash('sha1').update(String(id)).digest('hex');
  return join(accountBodiesDir(accountId), digest.slice(0, 2), `${safePart(id, 'message')}-${digest.slice(0, 8)}.json`);
}

async function writeBody(accountId, id, bodyText, bodyHtml) {
  const path = bodyPath(accountId, id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ bodyText: bodyText || '', bodyHtml: bodyHtml || '' }), 'utf8');
}

async function readBody(accountId, id) {
  try {
    const parsed = JSON.parse(await readFile(bodyPath(accountId, id), 'utf8'));
    return { bodyText: parsed.bodyText || '', bodyHtml: parsed.bodyHtml || '' };
  } catch {
    // A missing or unreadable body is not worth failing a render over; the
    // index entry still carries the headers and the preview.
    return { bodyText: '', bodyHtml: '' };
  }
}

async function removeBody(accountId, id) {
  await rm(bodyPath(accountId, id), { force: true });
}

/**
 * Reads are deliberately strict about failure. Writes go through this same
 * in-memory copy, so treating an unreadable file as "empty" would mean the next
 * sync happily persists that emptiness over a cache holding thousands of
 * messages. Only a genuinely absent file counts as empty; anything else stops
 * the caller rather than quietly discarding mail.
 */
async function loadStore(accountId) {
  if (!accountId) {
    return emptyStore();
  }
  if (loaded.has(accountId)) {
    return loaded.get(accountId);
  }

  const path = accountCachePath(accountId);
  let raw;

  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      const store = emptyStore();
      loaded.set(accountId, store);
      return store;
    }
    // A cache written by a version that stored bodies inline can outgrow the
    // ~512MB ceiling V8 puts on a single string, and readFile hits it as a bare
    // RangeError with no code. Say what it actually is rather than passing on
    // "Invalid string length".
    if (error instanceof RangeError || /Invalid string length/i.test(error?.message || '')) {
      throw new Error(
        `The mail cache at ${path} is larger than the 512MB a single read can hold. `
        + 'Press C to clear cached messages, then y to re-sync — the new format keeps '
        + 'bodies in separate files and will not hit this again.'
      );
    }
    throw new Error(`Could not read the mail cache at ${path}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Keep the bytes. They may be recoverable by hand, and overwriting them
    // would turn a readable-file problem into permanent data loss.
    const preserved = `${path}.corrupt-${Date.now()}`;
    await rename(path, preserved);
    throw new Error(
      `The mail cache could not be parsed and was preserved at ${preserved}. Press y to re-sync.`
    );
  }
  raw = null;

  const store = {
    version: Number(parsed.version) || 1,
    messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    deletedIds: Array.isArray(parsed.deletedIds) ? parsed.deletedIds : [],
    lastSyncAt: parsed.lastSyncAt || null
  };
  parsed = null;

  if (store.version < STORE_VERSION) {
    await migrateBodiesOut(accountId, store);
  }

  loaded.set(accountId, store);
  return store;
}

/**
 * One-time move of inline bodies to their own files. Each entry is stripped as
 * soon as its body is written so the strings become collectable while the walk
 * is still running — the whole point is not to need headroom for two copies of
 * a mailbox at once.
 */
async function migrateBodiesOut(accountId, store) {
  for (const message of store.messages) {
    if (message.bodyText || message.bodyHtml) {
      await writeBody(accountId, message.id, message.bodyText, message.bodyHtml);
    }
    // Unconditional, so a migrated index has the same shape as a freshly
    // synced one whether or not the message had a body to move.
    delete message.bodyText;
    delete message.bodyHtml;
  }

  store.version = STORE_VERSION;
  await persist(accountId, store);
}

async function persist(accountId, store) {
  const path = accountCachePath(accountId);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  // No indent: nothing reads this by eye, and the whitespace is pure cost in
  // both the file and the transient string this has to build.
  await writeFile(tempPath, JSON.stringify(store), 'utf8');
  await rename(tempPath, path);
  loaded.set(accountId, store);
}

/** Called after the cache is cleared or an account is removed. */
export function forgetAccount(accountId) {
  if (accountId) {
    loaded.delete(accountId);
  } else {
    loaded.clear();
  }
}

/** Index entries carry everything the list and preview panes draw — no bodies. */
function normalizeMessage(input) {
  return {
    id: input.id,
    folder: input.folder || 'inbox',
    from: input.from || 'Unknown',
    to: input.to || '',
    subject: input.subject || '(no subject)',
    preview: input.preview || '',
    when: input.when || '',
    unread: Boolean(input.unread),
    starred: Boolean(input.starred),
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    date: input.date || new Date().toISOString(),
    source: input.source || 'local'
  };
}

function sortMessages(messages) {
  return [...messages].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export async function upsertMessages(accountId, items) {
  const store = await loadStore(accountId);
  const deleted = new Set(store.deletedIds || []);
  const map = new Map(store.messages.map((msg) => [msg.id, msg]));

  for (const item of items) {
    if (deleted.has(item.id)) {
      continue;
    }

    const normalized = normalizeMessage(item);
    await writeBody(accountId, normalized.id, item.bodyText, item.bodyHtml);

    // A resync must not clobber local state the user set since the last sync.
    const existing = map.get(normalized.id);
    if (existing) {
      normalized.folder = existing.folder;
      normalized.starred = existing.starred;
      normalized.unread = existing.unread;
    }

    map.set(normalized.id, normalized);
  }

  store.messages = sortMessages(Array.from(map.values()));
  store.lastSyncAt = new Date().toISOString();
  await persist(accountId, store);
  return store;
}

export async function addSentMessage(accountId, item) {
  const store = await loadStore(accountId);
  const normalized = normalizeMessage({ ...item, folder: 'sent', source: 'local' });
  await writeBody(accountId, normalized.id, item.bodyText, item.bodyHtml);
  store.messages = sortMessages([normalized, ...store.messages]);
  await persist(accountId, store);
  return normalized;
}

export async function listMessages(accountId, { folder = 'inbox', query = '', limit = 500 } = {}) {
  const store = await loadStore(accountId);
  const q = query.trim().toLowerCase();

  let messages = folder === 'starred'
    ? store.messages.filter((msg) => msg.starred)
    : store.messages.filter((msg) => msg.folder === folder);

  if (q) {
    messages = messages.filter((msg) =>
      msg.subject.toLowerCase().includes(q)
      || msg.from.toLowerCase().includes(q)
      || msg.preview.toLowerCase().includes(q)
    );
  }

  return sortMessages(messages).slice(0, limit);
}

export async function listFolders(accountId) {
  const store = await loadStore(accountId);
  const base = [
    { id: 'inbox', name: 'Inbox' },
    { id: 'starred', name: 'Starred' },
    { id: 'sent', name: 'Sent' },
    { id: 'archive', name: 'Archive' }
  ];

  return base.map((folder) => {
    const unread = folder.id === 'starred'
      ? store.messages.filter((msg) => msg.starred && msg.unread).length
      : store.messages.filter((msg) => msg.folder === folder.id && msg.unread).length;
    return { ...folder, unread };
  });
}

export async function updateMessage(accountId, id, patch) {
  const store = await loadStore(accountId);
  store.messages = store.messages.map((msg) => (msg.id === id ? { ...msg, ...patch } : msg));
  await persist(accountId, store);
}

/** The one read that needs a body, so it is the only one that pays for one. */
export async function getMessageById(accountId, id) {
  const store = await loadStore(accountId);
  const message = store.messages.find((msg) => msg.id === id);
  if (!message) {
    return null;
  }
  return { ...message, ...(await readBody(accountId, id)) };
}

export async function deleteMessage(accountId, id) {
  const store = await loadStore(accountId);
  const messages = store.messages.filter((msg) => msg.id !== id);
  const deleted = messages.length !== store.messages.length;

  store.messages = messages;
  // Remembered so the next sync doesn't pull the message straight back in.
  store.deletedIds = Array.from(new Set([...(store.deletedIds || []), id]));
  await persist(accountId, store);
  await removeBody(accountId, id);

  return { deleted };
}

/**
 * POP3 has no way to fetch just headers, so a sync asks for this first and
 * skips re-downloading anything already held locally.
 */
export async function listMessageIds(accountId) {
  const store = await loadStore(accountId);
  return new Set([...store.messages.map((msg) => msg.id), ...(store.deletedIds || [])]);
}

export async function getStoreSummary(accountId) {
  const store = await loadStore(accountId);
  return {
    count: store.messages.length,
    unread: store.messages.filter((msg) => msg.unread).length,
    deletedIds: (store.deletedIds || []).length,
    lastSyncAt: store.lastSyncAt
  };
}
