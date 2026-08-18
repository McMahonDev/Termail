import { isIncomingConfigured, protocolLabel } from './config.js';
import { syncInbox, verifyImap } from './imapSync.js';
import { syncPop, verifyPop } from './popSync.js';

/**
 * One entry point for reading mail, so the UI never branches on protocol.
 * IMAP and POP3 differ in what they can offer: IMAP carries server-side
 * read/flagged state, POP3 carries none, so anything downloaded over POP3
 * arrives unread and the local cache is the only record of state after that.
 */
export async function verifyIncoming(account) {
  if (!account) {
    return { configured: false, connected: false, error: 'No account selected', protocol: 'imap' };
  }
  if (!isIncomingConfigured(account)) {
    return {
      configured: false,
      connected: false,
      protocol: account.incoming.protocol,
      error: `${protocolLabel(account.incoming.protocol)} host, user, and password are required`
    };
  }

  const result = account.incoming.protocol === 'pop3'
    ? await verifyPop(account)
    : await verifyImap(account);

  return { ...result, protocol: account.incoming.protocol };
}

/**
 * Returns { items, total, fetched, remaining } — `remaining` being how many
 * messages on the server still aren't cached, which is what lets the UI say
 * whether another pass would find anything.
 *
 * @param {any} account
 * @param {{ limit?: number, existingIds?: Set<string>, onProgress?: (done: number, total: number) => void, shouldStop?: () => boolean }} [options]
 */
export async function syncIncoming(account, options = {}) {
  if (!account) {
    throw new Error('No account selected. Press A to add one.');
  }
  if (!isIncomingConfigured(account)) {
    throw new Error(`${protocolLabel(account.incoming.protocol)} is not configured for this account.`);
  }

  return account.incoming.protocol === 'pop3'
    ? syncPop(account, options)
    : syncInbox(account, options);
}
