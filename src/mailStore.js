import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { accountCachePath } from './paths.js';

const EMPTY_STORE = {
  messages: [],
  deletedIds: [],
  lastSyncAt: null
};

/**
 * The cache file grows into the tens of megabytes on a real mailbox. The UI now
 * calls this module directly on every keystroke, so the parsed store is held in
 * memory per account and written through on mutation.
 */
const loaded = new Map();

function emptyStore() {
  return { messages: [], deletedIds: [], lastSyncAt: null };
}

async function loadStore(accountId) {
  if (!accountId) {
    return emptyStore();
  }
  if (loaded.has(accountId)) {
    return loaded.get(accountId);
  }

  let store;
  try {
    const parsed = JSON.parse(await readFile(accountCachePath(accountId), 'utf8'));
    store = {
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      deletedIds: Array.isArray(parsed.deletedIds) ? parsed.deletedIds : [],
      lastSyncAt: parsed.lastSyncAt || null
    };
  } catch {
    store = emptyStore();
  }

  loaded.set(accountId, store);
  return store;
}

async function persist(accountId, store) {
  const path = accountCachePath(accountId);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, JSON.stringify(store, null, 2), 'utf8');
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
    bodyText: input.bodyText || '',
    bodyHtml: input.bodyHtml || '',
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
    const normalized = normalizeMessage(item);
    if (deleted.has(normalized.id)) {
      continue;
    }

    // A resync must not clobber local state the user set since the last sync.
    const existing = map.get(normalized.id);
    if (existing) {
      normalized.folder = existing.folder;
      normalized.starred = existing.starred;
      normalized.unread = existing.unread;
    }

    map.set(normalized.id, normalized);
  }

  const next = {
    ...store,
    messages: sortMessages(Array.from(map.values())),
    lastSyncAt: new Date().toISOString()
  };

  await persist(accountId, next);
  return next;
}

export async function addSentMessage(accountId, item) {
  const store = await loadStore(accountId);
  const normalized = normalizeMessage({ ...item, folder: 'sent', source: 'local' });
  await persist(accountId, { ...store, messages: sortMessages([normalized, ...store.messages]) });
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
  await persist(accountId, {
    ...store,
    messages: store.messages.map((msg) => (msg.id === id ? { ...msg, ...patch } : msg))
  });
}

export async function getMessageById(accountId, id) {
  const store = await loadStore(accountId);
  return store.messages.find((msg) => msg.id === id) || null;
}

export async function deleteMessage(accountId, id) {
  const store = await loadStore(accountId);
  const messages = store.messages.filter((msg) => msg.id !== id);
  const deleted = messages.length !== store.messages.length;

  await persist(accountId, {
    ...store,
    messages,
    // Remembered so the next sync doesn't pull the message straight back in.
    deletedIds: Array.from(new Set([...(store.deletedIds || []), id]))
  });

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
