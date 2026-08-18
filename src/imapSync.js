import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { buildMessage, normalizeAddresses, persistAttachments } from './mailParts.js';

/**
 * ImapFlow reports rejected commands as a flat "Command failed"; the sentence
 * that actually explains why ("You are yet to enable IMAP for your account")
 * arrives separately on responseText. Prefer the server's own words.
 */
function imapError(error) {
  if (!error) {
    return 'Unknown error';
  }

  const detail = String(error.responseText || error.response || '').trim();
  const message = error instanceof Error ? error.message : String(error);

  if (detail && !message.includes(detail)) {
    return detail.replace(/\s*\(Failure\)\s*$/i, '');
  }

  return message;
}

function createClient(account) {
  return new ImapFlow({
    host: account.incoming.host,
    port: account.incoming.port,
    secure: account.incoming.secure,
    logger: false,
    auth: {
      user: account.incoming.user,
      pass: account.incoming.pass
    }
  });
}

export async function verifyImap(account) {
  const client = createClient(account);
  try {
    await client.connect();
    await client.logout();
    return { configured: true, connected: true, error: '' };
  } catch (error) {
    try {
      await client.logout();
    } catch {
      // Already disconnected.
    }
    return { configured: true, connected: false, error: imapError(error) };
  }
}

/** Fetching whole message sources is the expensive part, so ask in batches. */
const FETCH_CHUNK = 50;

/**
 * A UID search is cheap and returns the whole mailbox, so the work is planned
 * the same way as POP3: subtract what's already cached, take the newest `limit`
 * of the rest. That makes a repeat run continue backwards instead of
 * re-downloading the same window, and `limit: Infinity` takes everything.
 *
 * @param {any} account
 * @param {{ limit?: number, existingIds?: Set<string>, onProgress?: (done: number, total: number) => void, shouldStop?: () => boolean }} [options]
 */
export async function syncInbox(account, { limit = 200, existingIds = new Set(), onProgress, shouldStop } = {}) {
  const client = createClient(account);
  const items = [];

  try {
    await client.connect();
    const mailbox = await client.mailboxOpen('INBOX');

    if (!mailbox.exists) {
      await client.logout();
      return { items, total: 0, fetched: 0, remaining: 0 };
    }

    const uids = (await client.search({ all: true }, { uid: true })) || [];
    const candidates = uids.filter((uid) => !existingIds.has(`imap-${uid}`));
    const take = Number.isFinite(limit) ? Math.max(0, limit) : candidates.length;
    // Newest first, so cancelling part-way still leaves the most recent mail.
    const wanted = candidates.slice(Math.max(0, candidates.length - take)).reverse();

    for (let offset = 0; offset < wanted.length && !shouldStop?.(); offset += FETCH_CHUNK) {
      const chunk = wanted.slice(offset, offset + FETCH_CHUNK);

      for await (const message of client.fetch(
        chunk,
        { uid: true, envelope: true, flags: true, internalDate: true, source: true },
        { uid: true }
      )) {
        const parsed = await simpleParser(message.source);
        const id = `imap-${message.uid}`;
        const date = message.internalDate ? new Date(message.internalDate) : new Date();

        items.push(buildMessage({
          id,
          parsed,
          envelope: {
            from: normalizeAddresses(message.envelope?.from || parsed.from?.value || []),
            to: normalizeAddresses(message.envelope?.to || parsed.to?.value || []),
            subject: message.envelope?.subject || parsed.subject || '(no subject)'
          },
          when: date.toLocaleString(),
          date: date.toISOString(),
          unread: !message.flags?.has('\\Seen'),
          starred: Boolean(message.flags?.has('\\Flagged')),
          attachments: await persistAttachments(account.id, id, parsed.attachments || []),
          source: 'imap'
        }));

        onProgress?.(items.length, wanted.length);
      }
    }

    await client.logout();
    return {
      items,
      total: uids.length,
      fetched: items.length,
      remaining: candidates.length - items.length
    };
  } catch (error) {
    try {
      await client.logout();
    } catch {
      // Already disconnected.
    }
    throw new Error(imapError(error));
  }
}
