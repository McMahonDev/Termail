import net from 'node:net';
import tls from 'node:tls';
import { simpleParser } from 'mailparser';
import { buildMessage, persistAttachments } from './mailParts.js';

const CRLF = '\r\n';
const TERMINATOR = Buffer.from('\r\n.\r\n');
const DEFAULT_TIMEOUT = 30000;

/**
 * A minimal POP3 client. The protocol is small enough that a dependency would
 * cost more than it saves, but two details are easy to get wrong and matter
 * here: multi-line responses end with a lone "." on its own line, and any data
 * line that genuinely starts with "." is sent doubled and has to be unstuffed
 * before the bytes reach the parser.
 */
class Pop3Client {
  constructor(socket) {
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.closed = false;
    this.attach(socket);
  }

  /**
   * Also used after a STLS upgrade: the plaintext socket's listeners have to go,
   * or the raw bytes get fed to the parser alongside the decrypted ones.
   */
  attach(socket) {
    if (this.socket) {
      this.socket.removeListener('data', this.onData);
      this.socket.removeListener('error', this.onError);
      this.socket.removeListener('close', this.onClose);
    }

    this.socket = socket;
    this.onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    };
    this.onError = (error) => this.fail(error);
    this.onClose = () => {
      this.closed = true;
      this.fail(new Error('Connection closed by server'));
    };

    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  fail(error) {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
  }

  drain() {
    if (!this.pending) {
      return;
    }

    const headerEnd = this.buffer.indexOf(CRLF);
    if (headerEnd === -1) {
      return;
    }

    const statusLine = this.buffer.subarray(0, headerEnd).toString('utf8');
    if (statusLine.startsWith('-ERR')) {
      this.buffer = this.buffer.subarray(headerEnd + 2);
      const pending = this.pending;
      this.pending = null;
      pending.reject(new Error(statusLine.replace(/^-ERR\s*/, '') || 'Server rejected the command'));
      return;
    }

    if (!this.pending.multiline) {
      this.buffer = this.buffer.subarray(headerEnd + 2);
      const pending = this.pending;
      this.pending = null;
      pending.resolve({ status: statusLine, data: Buffer.alloc(0) });
      return;
    }

    // Start the search at the CRLF that closed the status line so an empty body
    // ("+OK\r\n.\r\n") is still recognised.
    const end = this.buffer.indexOf(TERMINATOR, headerEnd);
    if (end === -1) {
      return;
    }

    const body = this.buffer.subarray(headerEnd + 2, end + 2);
    this.buffer = this.buffer.subarray(end + TERMINATOR.length);

    const pending = this.pending;
    this.pending = null;
    pending.resolve({ status: statusLine, data: unstuff(body) });
  }

  send(command, multiline = false) {
    if (this.closed) {
      return Promise.reject(new Error('Connection closed'));
    }

    return new Promise((resolve, reject) => {
      this.pending = { multiline, resolve, reject };
      if (command !== null) {
        this.socket.write(command + CRLF);
      }
      // A response may already be sitting in the buffer (the greeting).
      this.drain();
    });
  }

  greeting() {
    return this.send(null, false);
  }

  async quit() {
    try {
      await this.send('QUIT');
    } catch {
      // Server may just close the socket; nothing useful to report.
    }
    this.socket.destroy();
  }
}

function unstuff(body) {
  // Per RFC 1939 a leading "." on any data line is transmitted as "..".
  const text = body.toString('binary').replace(/\r\n\.\./g, '\r\n.').replace(/^\.\./, '.');
  return Buffer.from(text, 'binary');
}

function openSocket({ host, port, secure, timeout }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });

    const onError = (error) => {
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(timeout, () => onError(new Error(`Timed out connecting to ${host}:${port}`)));
    socket.once('error', onError);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      socket.off('error', onError);
      socket.setTimeout(timeout);
      resolve(socket);
    });
  });
}

async function login(account) {
  const { host, port, secure, user, pass } = account.incoming;
  const socket = await openSocket({ host, port, secure, timeout: DEFAULT_TIMEOUT });
  const client = new Pop3Client(socket);

  await client.greeting();

  if (!secure) {
    // Opportunistic upgrade on port 110. A server that doesn't do STLS answers
    // "-ERR", which leaves the connection perfectly usable — so that case falls
    // through to plaintext. But once the server has said +OK it is waiting to
    // speak TLS, and a failed handshake leaves a socket that can't be used for
    // anything; that has to surface as a real error rather than a later,
    // baffling "connection closed".
    const stlsAccepted = await client.send('STLS').then(() => true, () => false);

    if (stlsAccepted) {
      try {
        const upgraded = tls.connect({ socket, servername: host });
        await new Promise((resolve, reject) => {
          upgraded.once('secureConnect', resolve);
          upgraded.once('error', reject);
        });
        upgraded.setTimeout(DEFAULT_TIMEOUT);
        client.attach(upgraded);
      } catch (error) {
        socket.destroy();
        throw new Error(`STLS upgrade to ${host} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  try {
    await client.send(`USER ${user}`);
    await client.send(`PASS ${pass}`);
  } catch (error) {
    await client.quit();
    throw error;
  }

  return client;
}

export async function verifyPop(account) {
  let client;
  try {
    client = await login(account);
    await client.send('STAT');
    await client.quit();
    return { configured: true, connected: true, error: '' };
  } catch (error) {
    if (client) {
      await client.quit();
    }
    return {
      configured: true,
      connected: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** UIDL gives each message an id that survives across sessions. */
function parseUidl(data) {
  return data
    .toString('utf8')
    .split(CRLF)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [num, uid] = line.split(/\s+/);
      return { num: Number(num), uid };
    })
    .filter((entry) => Number.isFinite(entry.num) && entry.uid);
}

/**
 * POP3 can't fetch headers separately, so every new message is a full download.
 * UIDL lists the whole mailbox in one cheap command, so the work is planned up
 * front: subtract what's already cached, then take the newest `limit` of what's
 * left. Running it again therefore walks further back rather than re-fetching
 * the same window, and `limit: Infinity` takes everything.
 *
 * @param {any} account
 * @param {{ limit?: number, existingIds?: Set<string>, onProgress?: (done: number, total: number) => void, shouldStop?: () => boolean }} [options]
 */
export async function syncPop(account, { limit = 200, existingIds = new Set(), onProgress, shouldStop } = {}) {
  const client = await login(account);
  const items = [];

  try {
    const listing = parseUidl((await client.send('UIDL', true)).data);
    const candidates = listing.filter((entry) => !existingIds.has(`pop-${entry.uid}`));
    const take = Number.isFinite(limit) ? Math.max(0, limit) : candidates.length;
    // Newest first, so a run that's cancelled part-way still leaves the most
    // recent mail in the cache rather than a random middle slice.
    const wanted = candidates.slice(Math.max(0, candidates.length - take)).reverse();

    for (const entry of wanted) {
      if (shouldStop?.()) {
        break;
      }

      const id = `pop-${entry.uid}`;
      const { data } = await client.send(`RETR ${entry.num}`, true);
      const parsed = await simpleParser(data);
      const date = parsed.date instanceof Date ? parsed.date : new Date();

      items.push(buildMessage({
        id,
        parsed,
        when: date.toLocaleString(),
        date: date.toISOString(),
        // POP3 carries no flags, so anything newly downloaded counts as unread
        // and local state takes over from there.
        unread: true,
        starred: false,
        attachments: await persistAttachments(account.id, id, parsed.attachments || []),
        source: 'pop3'
      }));

      onProgress?.(items.length, wanted.length);
    }

    await client.quit();
    return {
      items,
      total: listing.length,
      fetched: items.length,
      remaining: candidates.length - items.length
    };
  } catch (error) {
    await client.quit();
    throw error;
  }
}
