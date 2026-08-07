import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const STORE_PATH = join(process.cwd(), '.data', 'mail-cache.json');

const EMPTY_STORE = {
  messages: [],
  deletedIds: [],
  lastSyncAt: null
};

async function readStore() {
  try {
    const raw = await readFile(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      deletedIds: Array.isArray(parsed.deletedIds) ? parsed.deletedIds : [],
      lastSyncAt: parsed.lastSyncAt || null
    };
  } catch {
    return { ...EMPTY_STORE };
  }
}

async function writeStore(store) {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
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

export async function upsertMessages(items) {
  const store = await readStore();
  const deleted = new Set(store.deletedIds || []);
  const map = new Map(store.messages.map((msg) => [msg.id, msg]));

  for (const item of items) {
    const normalized = normalizeMessage(item);
    if (deleted.has(normalized.id)) {
      continue;
    }
    map.set(normalized.id, normalized);
  }

  store.messages = sortMessages(Array.from(map.values()));
  store.lastSyncAt = new Date().toISOString();
  await writeStore(store);
  return store;
}

export async function addSentMessage(item) {
  const store = await readStore();
  const normalized = normalizeMessage({ ...item, folder: 'sent', source: 'local' });
  store.messages = sortMessages([normalized, ...store.messages]);
  await writeStore(store);
  return normalized;
}

export async function listMessages({ folder = 'inbox', query = '' } = {}) {
  const store = await readStore();
  const q = query.trim().toLowerCase();

  let messages;
  if (folder === 'starred') {
    messages = store.messages.filter((msg) => msg.starred);
  } else {
    messages = store.messages.filter((msg) => msg.folder === folder);
  }

  if (q) {
    messages = messages.filter((msg) =>
      msg.subject.toLowerCase().includes(q)
      || msg.from.toLowerCase().includes(q)
      || msg.preview.toLowerCase().includes(q)
    );
  }

  return sortMessages(messages).slice(0, 200);
}

export async function listFolders() {
  const store = await readStore();
  const base = [
    { id: 'inbox', name: 'Inbox' },
    { id: 'starred', name: 'Starred' },
    { id: 'sent', name: 'Sent' },
    { id: 'archive', name: 'Archive' }
  ];

  return base.map((folder) => {
    let unread;
    if (folder.id === 'starred') {
      unread = store.messages.filter((msg) => msg.starred && msg.unread).length;
    } else {
      unread = store.messages.filter((msg) => msg.folder === folder.id && msg.unread).length;
    }
    return { ...folder, unread };
  });
}

export async function updateMessage(id, patch) {
  const store = await readStore();
  store.messages = store.messages.map((msg) => (msg.id === id ? { ...msg, ...patch } : msg));
  await writeStore(store);
}

export async function getMessageById(id) {
  const store = await readStore();
  return store.messages.find((msg) => msg.id === id) || null;
}

export async function deleteMessage(id) {
  const store = await readStore();
  const before = store.messages.length;
  store.messages = store.messages.filter((msg) => msg.id !== id);
  store.deletedIds = Array.from(new Set([...(store.deletedIds || []), id]));
  const deleted = before !== store.messages.length;
  await writeStore(store);
  return { deleted };
}

export async function getStoreSummary() {
  const store = await readStore();
  return {
    count: store.messages.length,
    lastSyncAt: store.lastSyncAt
  };
}
