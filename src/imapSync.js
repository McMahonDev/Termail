import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ATTACHMENTS_ROOT = join(process.cwd(), '.data', 'attachments');

function parsePort(raw, fallback) {
  const port = Number(raw);
  if (!Number.isFinite(port) || port <= 0) {
    return fallback;
  }
  return port;
}

export function getImapConfig() {
  const host = process.env.IMAP_HOST || '';
  const port = parsePort(process.env.IMAP_PORT || '993', 993);
  const user = process.env.IMAP_USER || '';
  const pass = process.env.IMAP_PASS || '';
  const secure = String(process.env.IMAP_SECURE || '').toLowerCase() !== 'false';

  return {
    configured: Boolean(host && user && pass),
    host,
    port,
    secure,
    user,
    pass
  };
}

export async function verifyImap() {
  const config = getImapConfig();
  if (!config.configured) {
    return {
      configured: false,
      connected: false,
      error: 'Missing IMAP_HOST / IMAP_USER / IMAP_PASS'
    };
  }

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    logger: false,
    auth: {
      user: config.user,
      pass: config.pass
    }
  });

  try {
    await client.connect();
    await client.logout();
    return { configured: true, connected: true, error: '' };
  } catch (error) {
    try {
      await client.logout();
    } catch {
      // ignore
    }
    return {
      configured: true,
      connected: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function normalizeAddresses(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return '';
  }
  return list
    .map((entry) => entry.name || entry.address || '')
    .filter(Boolean)
    .join(', ');
}

function safePart(value, fallback = 'part') {
  const cleaned = String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

async function persistAttachments(messageId, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  const messageDir = safePart(messageId, 'message');
  const saved = [];

  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const filename = safePart(attachment.filename || `attachment-${index + 1}`);
    const relativePath = join(messageDir, `${index + 1}-${filename}`);
    const absolutePath = join(ATTACHMENTS_ROOT, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, attachment.content);

    const cid = String(attachment.contentId || '').replace(/[<>]/g, '');
    saved.push({
      filename: attachment.filename || `attachment-${index + 1}`,
      contentType: attachment.contentType || 'application/octet-stream',
      contentDisposition: attachment.contentDisposition || 'attachment',
      size: Number(attachment.size || 0),
      cid,
      path: relativePath
    });
  }

  return saved;
}

export async function syncInbox({ limit = 30 } = {}) {
  const config = getImapConfig();
  if (!config.configured) {
    throw new Error('IMAP is not configured. Set IMAP_HOST, IMAP_USER, IMAP_PASS.');
  }

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    logger: false,
    auth: {
      user: config.user,
      pass: config.pass
    }
  });

  const items = [];

  try {
    await client.connect();
    const mailbox = await client.mailboxOpen('INBOX');

    if (!mailbox.exists) {
      return [];
    }

    const start = Math.max(1, mailbox.exists - limit + 1);
    const range = `${start}:${mailbox.exists}`;

    for await (const message of client.fetch(range, {
      uid: true,
      envelope: true,
      flags: true,
      internalDate: true,
      source: true
    })) {
      const parsed = await simpleParser(message.source);
      const text = (parsed.text || parsed.html || '').replace(/\s+/g, ' ').trim();
      const preview = text.slice(0, 220);
      const messageId = `imap-${message.uid}`;
      const attachments = await persistAttachments(messageId, parsed.attachments || []);

      items.push({
        id: messageId,
        folder: 'inbox',
        from: normalizeAddresses(message.envelope?.from || parsed.from?.value || []),
        to: normalizeAddresses(message.envelope?.to || parsed.to?.value || []),
        subject: message.envelope?.subject || parsed.subject || '(no subject)',
        preview,
        bodyText: parsed.text || '',
        bodyHtml: typeof parsed.html === 'string' ? parsed.html : '',
        attachments,
        when: message.internalDate ? message.internalDate.toLocaleString() : '',
        unread: !message.flags?.has('\\Seen'),
        starred: Boolean(message.flags?.has('\\Flagged')),
        date: message.internalDate ? message.internalDate.toISOString() : new Date().toISOString(),
        source: 'imap'
      });
    }

    await client.logout();
    return items;
  } catch (error) {
    try {
      await client.logout();
    } catch {
      // ignore
    }
    throw error;
  }
}
