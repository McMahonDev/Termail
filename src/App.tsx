import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { spawn } from 'node:child_process';
import { startServer } from './server.js';
import {
  isIncomingConfigured,
  isSmtpConfigured,
  protocolLabel,
  listAccounts,
  removeAccount,
  saveAccount,
  setActiveAccount
} from './config.js';
import {
  addSentMessage,
  deleteMessage,
  listFolders,
  listMessages,
  updateMessage,
  upsertMessages,
  listMessageIds
} from './mailStore.js';
import { syncIncoming, verifyIncoming } from './incoming.js';
import { sendSmtpMail, sendSmtpTestMail, verifySmtp } from './smtp.js';
import { clearCache } from './cache.js';
import { AccountsScreen } from './ui/AccountsScreen.js';
import { CacheScreen } from './ui/CacheScreen.js';

type Pane = 'folders' | 'messages' | 'preview';
type Screen = 'mail' | 'accounts' | 'cache';
type Folder = { id: string; name: string; unread: number };
type Message = {
  id: string;
  folder: string;
  from: string;
  to?: string;
  subject: string;
  preview: string;
  when: string;
  unread: boolean;
  starred: boolean;
  date?: string;
  source?: string;
};
type Health = { state: 'unknown' | 'checking' | 'ok' | 'fail' | 'unconfigured'; error: string };

const DEFAULT_FOLDERS: Folder[] = [
  { id: 'inbox', name: 'Inbox', unread: 0 },
  { id: 'starred', name: 'Starred', unread: 0 },
  { id: 'sent', name: 'Sent', unread: 0 },
  { id: 'archive', name: 'Archive', unread: 0 }
];

const UNKNOWN: Health = { state: 'unknown', error: '' };

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function wrapText(text: string, width: number) {
  const safeWidth = Math.max(8, width);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [''];
  }

  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    if (word.length > safeWidth) {
      if (line) {
        lines.push(line);
        line = '';
      }
      for (let i = 0; i < word.length; i += safeWidth) {
        lines.push(word.slice(i, i + safeWidth));
      }
      continue;
    }

    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > safeWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }

  if (line) {
    lines.push(line);
  }

  return lines;
}

function healthColor(health: Health) {
  if (health.state === 'ok') return 'green';
  if (health.state === 'fail') return 'red';
  if (health.state === 'checking') return 'yellow';
  return 'gray';
}

function healthLabel(protocol: string, health: Health) {
  if (health.state === 'ok') return `${protocol}: connected`;
  if (health.state === 'checking') return `${protocol}: checking…`;
  if (health.state === 'unconfigured') return `${protocol}: not configured`;
  if (health.state === 'fail') return `${protocol}: ${health.error || 'connection failed'}`;
  return `${protocol}: —`;
}

type AppProps = { startupNotice?: string; initialScreen?: Screen };

export function App({ startupNotice = '', initialScreen = 'mail' }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [accountsLoaded, setAccountsLoaded] = useState(false);

  const [activePane, setActivePane] = useState<Pane>('folders');
  const [folders, setFolders] = useState<Folder[]>(DEFAULT_FOLDERS);
  const [messages, setMessages] = useState<Message[]>([]);
  const [folderIndex, setFolderIndex] = useState(0);
  const [messageIndex, setMessageIndex] = useState(0);
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState(false);
  const [status, setStatus] = useState(startupNotice || 'Ready');
  const [serverBaseUrl, setServerBaseUrl] = useState('');
  const [folderScroll, setFolderScroll] = useState(0);
  const [messageScroll, setMessageScroll] = useState(0);
  const [previewScroll, setPreviewScroll] = useState(0);
  const [imapHealth, setImapHealth] = useState<Health>(UNKNOWN);
  const [smtpHealth, setSmtpHealth] = useState<Health>(UNKNOWN);
  const [accountHealth, setAccountHealth] = useState<Record<string, { imap?: boolean; smtp?: boolean }>>({});
  const [busy, setBusy] = useState(false);

  // The loopback server outlives account switches, so it reads the current id
  // through a ref instead of capturing it at startup.
  const activeAccountRef = useRef<string | null>(null);
  activeAccountRef.current = activeAccountId;

  // Flipped by Esc during a sync; the sync loop checks it between messages.
  const cancelSyncRef = useRef(false);

  // How many messages a full sync would pull, once counted. A full sync can
  // mean tens of thousands of downloads, so F counts first and asks.
  const [pendingFullSync, setPendingFullSync] = useState<number | null>(null);

  const account = useMemo(
    () => accounts.find((item) => item.id === activeAccountId) || null,
    [accounts, activeAccountId]
  );

  const cols = Math.max(80, stdout?.columns ?? 120);
  const rows = Math.max(24, stdout?.rows ?? 36);
  const leftWidth = Math.max(18, Math.floor(cols * 0.24));
  const centerWidth = Math.max(30, Math.floor(cols * 0.38));
  const rightWidth = Math.max(24, cols - leftWidth - centerWidth - 6);
  const paneHeight = Math.max(10, rows - 9);
  const listRows = Math.max(4, paneHeight - 3);
  const previewRows = listRows;

  const currentFolder = folders[folderIndex] ?? folders[0] ?? DEFAULT_FOLDERS[0];
  const selectedMessage = messages[Math.min(Math.max(messageIndex, 0), Math.max(messages.length - 1, 0))] ?? null;
  const unreadCount = messages.reduce((count, message) => count + (message.unread ? 1 : 0), 0);

  const maxFolderScroll = Math.max(0, folders.length - listRows);
  const maxMessageScroll = Math.max(0, messages.length - listRows);

  const previewLines = useMemo(() => {
    if (!selectedMessage) {
      return ['Select a message to preview'];
    }
    const previewWidth = Math.max(18, rightWidth - 4);
    return [
      `Subject: ${selectedMessage.subject}`,
      `From: ${selectedMessage.from}`,
      `When: ${selectedMessage.when}`,
      `Tags: ${selectedMessage.starred ? 'starred ' : ''}${selectedMessage.unread ? 'unread' : 'read'}`,
      '',
      ...wrapText(selectedMessage.preview, previewWidth)
    ];
  }, [rightWidth, selectedMessage]);

  const maxPreviewScroll = Math.max(0, previewLines.length - previewRows);
  const visibleFolders = folders.slice(folderScroll, folderScroll + listRows);
  const visibleMessages = messages.slice(messageScroll, messageScroll + listRows);
  const visiblePreviewLines = previewLines.slice(previewScroll, previewScroll + previewRows);

  const loadMailbox = useCallback(async (accountId: string | null, folderId: string, q: string, resetSelection = true) => {
    if (!accountId) {
      setFolders(DEFAULT_FOLDERS);
      setMessages([]);
      return;
    }

    const [nextFolders, nextMessages] = await Promise.all([
      listFolders(accountId),
      listMessages(accountId, { folder: folderId, query: q })
    ]);

    setFolders(nextFolders);
    setMessages(nextMessages);
    if (resetSelection) {
      setMessageIndex(0);
      setMessageScroll(0);
    }
  }, []);

  const refreshAccounts = useCallback(async () => {
    const { accounts: nextAccounts, activeAccountId: nextActive } = await listAccounts();
    setAccounts(nextAccounts);
    setActiveAccountId(nextActive);
    setAccountsLoaded(true);
    return { accounts: nextAccounts, activeAccountId: nextActive };
  }, []);

  /**
   * Connection checks open a real socket, so they run when the account changes
   * or when asked for — not on a timer.
   */
  const checkConnections = useCallback(async (target: any) => {
    if (!target) {
      setImapHealth(UNKNOWN);
      setSmtpHealth(UNKNOWN);
      return;
    }

    setImapHealth(isIncomingConfigured(target) ? { state: 'checking', error: '' } : { state: 'unconfigured', error: '' });
    setSmtpHealth(isSmtpConfigured(target) ? { state: 'checking', error: '' } : { state: 'unconfigured', error: '' });

    const [imap, smtp] = await Promise.all([verifyIncoming(target), verifySmtp(target)]);

    if (activeAccountRef.current !== target.id) {
      return;
    }

    setImapHealth(imap.configured
      ? { state: imap.connected ? 'ok' : 'fail', error: imap.error }
      : { state: 'unconfigured', error: imap.error });
    setSmtpHealth(smtp.configured
      ? { state: smtp.connected ? 'ok' : 'fail', error: smtp.error }
      : { state: 'unconfigured', error: smtp.error });
    setAccountHealth((prev) => ({ ...prev, [target.id]: { imap: imap.connected, smtp: smtp.connected } }));
  }, []);

  useEffect(() => {
    let closed = false;
    let closeServer: null | (() => Promise<void>) = null;

    void (async () => {
      try {
        const srv = await startServer(() => activeAccountRef.current);
        if (closed) {
          await srv.close();
          return;
        }
        setServerBaseUrl(srv.baseUrl);
        closeServer = srv.close;
      } catch (error) {
        if (!closed) {
          setStatus(`Browser view unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })();

    void (async () => {
      const { activeAccountId: id } = await refreshAccounts();
      if (closed) {
        return;
      }
      if (!id) {
        setScreen('accounts');
        return;
      }
      await loadMailbox(id, 'inbox', '');
    })();

    return () => {
      closed = true;
      if (closeServer) {
        void closeServer();
      }
    };
  }, [loadMailbox, refreshAccounts]);

  useEffect(() => {
    if (account) {
      void checkConnections(account);
    }
  }, [account?.id, checkConnections]);

  useEffect(() => {
    if (!activeAccountId) {
      return;
    }
    void loadMailbox(activeAccountId, currentFolder.id, query).catch((error) => {
      setStatus(error instanceof Error ? `Mailbox load failed: ${error.message}` : 'Mailbox load failed');
    });
  }, [activeAccountId, currentFolder.id, loadMailbox, query]);

  useEffect(() => {
    setFolderScroll((prev) => clamp(prev, 0, maxFolderScroll));
  }, [maxFolderScroll]);

  useEffect(() => {
    setMessageScroll((prev) => clamp(prev, 0, maxMessageScroll));
  }, [maxMessageScroll]);

  useEffect(() => {
    setPreviewScroll((prev) => clamp(prev, 0, maxPreviewScroll));
  }, [maxPreviewScroll]);

  useEffect(() => {
    setPreviewScroll(0);
  }, [selectedMessage?.id]);

  useEffect(() => {
    setFolderScroll((prev) => {
      if (folderIndex < prev) return folderIndex;
      if (folderIndex >= prev + listRows) return folderIndex - listRows + 1;
      return prev;
    });
  }, [folderIndex, listRows]);

  useEffect(() => {
    setMessageScroll((prev) => {
      if (messageIndex < prev) return messageIndex;
      if (messageIndex >= prev + listRows) return messageIndex - listRows + 1;
      return prev;
    });
  }, [listRows, messageIndex]);

  const cyclePane = () => {
    setActivePane((prev) => {
      if (prev === 'folders') {
        setStatus('Focused messages');
        return 'messages';
      }
      if (prev === 'messages') {
        setStatus('Focused preview');
        return 'preview';
      }
      setStatus('Focused folders');
      return 'folders';
    });
  };

  const mutateSelectedMessage = (mutator: (message: Message) => Message) => {
    if (!selectedMessage || !activeAccountId) {
      setStatus('No message selected');
      return;
    }

    const updated = mutator(selectedMessage);
    setMessages((current) => {
      const next = current.map((message) => (message.id === selectedMessage.id ? updated : message));
      if (updated.folder !== selectedMessage.folder && currentFolder.id !== 'starred' && updated.folder !== currentFolder.id) {
        return next.filter((message) => message.id !== updated.id);
      }
      if (currentFolder.id === 'starred' && !updated.starred) {
        return next.filter((message) => message.id !== updated.id);
      }
      return next;
    });

    const patch: Record<string, unknown> = {};
    if (updated.unread !== selectedMessage.unread) patch.unread = updated.unread;
    if (updated.starred !== selectedMessage.starred) patch.starred = updated.starred;
    if (updated.folder !== selectedMessage.folder) patch.folder = updated.folder;

    if (Object.keys(patch).length > 0) {
      void updateMessage(activeAccountId, selectedMessage.id, patch)
        .then(() => listFolders(activeAccountId).then(setFolders))
        .catch((error: Error) => setStatus(`Update failed: ${error.message}`));
    }

    setStatus('Message updated');
  };

  const runSync = async (limit = 200) => {
    if (!account) {
      setStatus('No account selected — press A to add one');
      return;
    }
    if (!isIncomingConfigured(account)) {
      setStatus(`${protocolLabel(account.incoming.protocol)} is not configured for this account — press A to edit it`);
      return;
    }

    const label = protocolLabel(account.incoming.protocol);
    const scope = Number.isFinite(limit) ? `up to ${limit}` : 'every remaining';
    cancelSyncRef.current = false;
    setBusy(true);
    setStatus(`Syncing ${scope} message${limit === 1 ? '' : 's'} over ${label}… (esc to stop)`);

    try {
      // Both protocols skip what's already cached, so each run continues from
      // where the last one stopped rather than re-reading the same window.
      const existingIds = await listMessageIds(account.id);
      let lastReported = 0;
      const result = await syncIncoming(account, {
        limit,
        existingIds,
        shouldStop: () => cancelSyncRef.current,
        // Each batch is written as it arrives rather than collected into one
        // array and saved at the end. That keeps peak memory flat regardless of
        // how deep the sync goes, and means stopping — or crashing — part-way
        // still leaves everything fetched so far in the cache.
        onBatch: async (batch: any[]) => {
          await upsertMessages(account.id, batch);
        },
        onProgress: (done: number, total: number) => {
          // Rendering on every message would thrash the terminal on a deep sync.
          if (done - lastReported >= 10 || done === total) {
            lastReported = done;
            setStatus(`Syncing ${done}/${total} over ${label}… (esc to stop)`);
          }
        }
      });

      await loadMailbox(account.id, currentFolder.id, query, false);
      setImapHealth({ state: 'ok', error: '' });

      const stopped = cancelSyncRef.current;
      if (result.fetched === 0) {
        setStatus(stopped ? 'Sync stopped' : `Already up to date (${result.total} on server)`);
      } else if (result.remaining > 0) {
        setStatus(`${stopped ? 'Stopped after' : 'Synced'} ${result.fetched} new · ${result.remaining} older still on server — Y for more, F for all`);
      } else {
        setStatus(`Synced ${result.fetched} new · mailbox fully synced (${result.total} total)`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImapHealth({ state: 'fail', error: message });
      setStatus(`Sync failed: ${message}`);
    } finally {
      cancelSyncRef.current = false;
      setBusy(false);
    }
  };

  /**
   * Counts what a full sync would download without downloading any of it —
   * both protocols can list ids far more cheaply than message bodies.
   */
  const countPendingSync = async () => {
    if (!account || !isIncomingConfigured(account)) {
      setStatus(`${account ? protocolLabel(account.incoming.protocol) : 'Incoming mail'} is not configured — press A to edit it`);
      return;
    }

    setBusy(true);
    setStatus('Counting what is left to download…');
    try {
      const existingIds = await listMessageIds(account.id);
      const { remaining, total } = await syncIncoming(account, { limit: 0, existingIds });

      if (remaining === 0) {
        setStatus(`Already up to date (${total} on server)`);
        return;
      }

      setPendingFullSync(remaining);
      setStatus(`Full sync will download ${remaining} of ${total} messages — press F again to start, esc to cancel`);
    } catch (error) {
      setStatus(`Could not count messages: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const deleteSelectedMessage = async () => {
    if (!selectedMessage || !activeAccountId) {
      setStatus('No message selected');
      return;
    }

    const id = selectedMessage.id;
    setMessages((current) => current.filter((message) => message.id !== id));
    setMessageIndex((prev) => clamp(prev, 0, Math.max(0, messages.length - 2)));

    try {
      await deleteMessage(activeAccountId, id);
      setFolders(await listFolders(activeAccountId));
      setStatus('Message deleted');
    } catch (error) {
      setStatus(error instanceof Error ? `Delete failed: ${error.message}` : 'Delete failed');
    }
  };

  const sendSmtpTest = async () => {
    if (!account || !isSmtpConfigured(account)) {
      setStatus('SMTP is not configured for this account — press A to edit it');
      return;
    }

    setBusy(true);
    setStatus('Sending SMTP test…');
    try {
      const info = await sendSmtpTestMail(account);
      setSmtpHealth({ state: 'ok', error: '' });
      setStatus(`SMTP test sent to ${info.to}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSmtpHealth({ state: 'fail', error: message });
      setStatus(`SMTP test failed: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const sendQuickMail = async () => {
    if (!account || !isSmtpConfigured(account)) {
      setStatus('SMTP is not configured for this account — press A to edit it');
      return;
    }

    setBusy(true);
    try {
      const to = account.smtp.from;
      const subject = `TerMail manual send ${new Date().toLocaleTimeString()}`;
      const text = 'This is a manual test message sent from TerMail.';
      const info = await sendSmtpMail(account, { to, subject, text });

      await addSentMessage(account.id, {
        id: `sent-${Date.now()}`,
        from: account.smtp.from,
        to,
        subject,
        preview: text,
        bodyText: text,
        when: new Date().toLocaleString(),
        unread: false,
        starred: false,
        date: new Date().toISOString()
      });

      await loadMailbox(account.id, currentFolder.id, query, false);
      setStatus(`Sent email to ${info.to}`);
    } catch (error) {
      setStatus(error instanceof Error ? `Send failed: ${error.message}` : 'Send failed');
    } finally {
      setBusy(false);
    }
  };

  const openSelectedInBrowser = () => {
    if (!selectedMessage) {
      setStatus('No message selected');
      return;
    }
    if (!serverBaseUrl) {
      setStatus('Browser view is not running');
      return;
    }

    const target = `${serverBaseUrl}/api/mail/render?id=${encodeURIComponent(selectedMessage.id)}`;
    let command = 'xdg-open';
    let args = [target];

    if (process.platform === 'darwin') {
      command = 'open';
    } else if (process.platform === 'win32') {
      command = 'cmd';
      args = ['/c', 'start', '', target];
    }

    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.unref();
      setStatus('Opened full message in browser');
    } catch {
      setStatus('Could not open browser');
    }
  };

  const moveSelection = (delta: number) => {
    if (activePane === 'folders') {
      setFolderIndex((prev) => {
        const len = Math.max(1, folders.length);
        return (prev + delta + len) % len;
      });
      setMessageIndex(0);
      return;
    }

    if (activePane === 'messages') {
      if (messages.length === 0) {
        return;
      }
      setMessageIndex((prev) => (prev + delta + messages.length) % messages.length);
      return;
    }

    setPreviewScroll((prev) => clamp(prev + delta, 0, maxPreviewScroll));
  };

  const movePage = (deltaPages: number) => {
    const pageSize = Math.max(1, listRows - 1);
    if (activePane === 'folders') {
      setFolderIndex((prev) => clamp(prev + deltaPages * pageSize, 0, Math.max(0, folders.length - 1)));
      return;
    }
    if (activePane === 'messages') {
      setMessageIndex((prev) => clamp(prev + deltaPages * pageSize, 0, Math.max(0, messages.length - 1)));
      return;
    }
    setPreviewScroll((prev) => clamp(prev + deltaPages * pageSize, 0, maxPreviewScroll));
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }

    if (searchMode) {
      if (key.escape) {
        setQuery('');
        setSearchMode(false);
        setStatus('Search cleared');
        return;
      }
      if (key.return) {
        setSearchMode(false);
        setStatus(query ? `Search: ${query}` : 'Search cleared');
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((prev) => prev.slice(0, -1));
        setMessageIndex(0);
        return;
      }
      if (!key.ctrl && !key.meta && input.length === 1 && input >= ' ' && input <= '~') {
        setQuery((prev) => prev + input);
        setMessageIndex(0);
      }
      return;
    }

    if (busy) {
      // A long sync stays interruptible; everything else waits.
      if (key.escape && !cancelSyncRef.current) {
        cancelSyncRef.current = true;
        setStatus('Stopping after the current message…');
      }
      return;
    }

    if (input === 'q') {
      exit();
      return;
    }
    if (input === 'A') {
      setScreen('accounts');
      return;
    }
    if (input === 'C') {
      setScreen('cache');
      return;
    }
    if (input === 'r') {
      void checkConnections(account);
      setStatus('Rechecking connections…');
      return;
    }
    if (key.tab) {
      cyclePane();
      return;
    }
    if (key.upArrow || input === 'k') {
      moveSelection(-1);
      return;
    }
    if (key.downArrow || input === 'j') {
      moveSelection(1);
      return;
    }
    if (key.pageUp || (key.ctrl && input === 'u')) {
      movePage(-1);
      return;
    }
    if (key.pageDown || (key.ctrl && input === 'd')) {
      movePage(1);
      return;
    }
    if (input === '/') {
      setSearchMode(true);
      setStatus('Search mode');
      return;
    }
    if (input === 'y') {
      void runSync(200);
      return;
    }
    if (input === 'Y') {
      void runSync(1000);
      return;
    }
    if (input === 'F') {
      if (pendingFullSync !== null) {
        setPendingFullSync(null);
        void runSync(Number.POSITIVE_INFINITY);
      } else {
        void countPendingSync();
      }
      return;
    }
    if (input === 'n') {
      void sendQuickMail();
      return;
    }
    if (input === 't') {
      void sendSmtpTest();
      return;
    }
    if (input === 'o') {
      openSelectedInBrowser();
      return;
    }
    if (input === 's') {
      mutateSelectedMessage((message) => ({ ...message, starred: !message.starred }));
      return;
    }
    if (input === 'u') {
      mutateSelectedMessage((message) => ({ ...message, unread: !message.unread }));
      return;
    }
    if (input === 'e') {
      mutateSelectedMessage((message) => ({ ...message, folder: 'archive', unread: false }));
      return;
    }
    if (input === 'd' || key.delete) {
      void deleteSelectedMessage();
      return;
    }
    if (key.escape) {
      if (pendingFullSync !== null) {
        setPendingFullSync(null);
        setStatus('Full sync cancelled');
        return;
      }
      setQuery('');
      setStatus('Search cleared');
    }
  }, { isActive: screen === 'mail' });

  const handleMouseClick = useCallback((x: number, y: number) => {
    const paneTop = 5;
    const firstListRow = paneTop + 2;
    const paneBottom = firstListRow + listRows - 1;
    if (y < paneTop || y > paneBottom) {
      return;
    }

    const leftStart = 2;
    const centerStart = leftStart + leftWidth + 1;
    const rightStart = centerStart + centerWidth + 1;

    if (x >= leftStart && x < leftStart + leftWidth) {
      setActivePane('folders');
      const idx = folderScroll + (y - firstListRow);
      if (idx >= 0 && idx < folders.length) {
        setFolderIndex(idx);
      }
      setMessageIndex(0);
      return;
    }

    if (x >= centerStart && x < centerStart + centerWidth) {
      setActivePane('messages');
      const idx = messageScroll + (y - firstListRow);
      if (idx >= 0 && idx < messages.length) {
        setMessageIndex(idx);
      }
      return;
    }

    if (x >= rightStart && x < rightStart + rightWidth) {
      setActivePane('preview');
    }
  }, [centerWidth, folderScroll, folders.length, leftWidth, listRows, messageScroll, messages.length, rightWidth]);

  useEffect(() => {
    // Mouse reporting is only enabled on the mail screen: the escape sequences
    // it emits would otherwise reach the account form's key handler as stray
    // Escape presses and cancel the form on every click.
    if (screen !== 'mail' || !process.stdin.isTTY || !process.stdout.isTTY) {
      return;
    }

    process.stdout.write('\u001b[?1000h\u001b[?1006h');

    const onData = (chunk: Buffer) => {
      const data = chunk.toString('utf8');
      for (const event of data.matchAll(/\u001b\[<(\d+);(\d+);(\d+)([mM])/g)) {
        if (event[4] === 'M') {
          handleMouseClick(Number(event[2]), Number(event[3]));
        }
      }
    };

    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
      process.stdout.write('\u001b[?1000l\u001b[?1006l');
    };
  }, [handleMouseClick, screen]);

  if (screen === 'accounts') {
    return (
      <AccountsScreen
        accounts={accounts}
        activeAccountId={activeAccountId}
        accountsLoaded={accountsLoaded}
        status={accountHealth}
        onClose={() => {
          setScreen('mail');
          setStatus('Ready');
        }}
        onSwitch={(id) => {
          void (async () => {
            await setActiveAccount(id);
            const next = await refreshAccounts();
            setFolderIndex(0);
            setQuery('');
            await loadMailbox(id, 'inbox', '');
            const switched = next.accounts.find((item) => item.id === id);
            setStatus(`Switched to ${switched?.label || 'account'}`);
          })();
        }}
        onSave={async (draft) => {
          const saved = await saveAccount(draft);
          const next = await refreshAccounts();
          if (next.activeAccountId === saved.id) {
            await loadMailbox(saved.id, 'inbox', '');
          }
        }}
        onRemove={async (id, alsoCache) => {
          if (alsoCache) {
            await clearCache(id, 'account');
          }
          await removeAccount(id);
          const next = await refreshAccounts();
          await loadMailbox(next.activeAccountId, 'inbox', '');
        }}
        onTest={async (candidate) => {
          const [imap, smtp] = await Promise.all([verifyIncoming(candidate), verifySmtp(candidate)]);
          if (candidate.id) {
            setAccountHealth((prev) => ({ ...prev, [candidate.id]: { imap: imap.connected, smtp: smtp.connected } }));
          }
          if (imap.connected && smtp.connected) {
            return `OK — ${protocolLabel(candidate.incoming.protocol)} and SMTP both connected`;
          }
          const problems = [
            imap.connected ? null : `${protocolLabel(candidate.incoming.protocol)}: ${imap.error || 'not configured'}`,
            smtp.connected ? null : `SMTP: ${smtp.error || 'not configured'}`
          ].filter(Boolean);
          return problems.join(' | ');
        }}
      />
    );
  }

  if (screen === 'cache') {
    return (
      <CacheScreen
        account={account}
        onClose={() => {
          setScreen('mail');
          setStatus('Ready');
        }}
        onClear={async (scope) => {
          await clearCache(activeAccountId, scope);
          await loadMailbox(activeAccountId, currentFolder.id, query);
          setStatus(`Cache cleared (${scope})`);
        }}
      />
    );
  }

  const accountLabel = account
    ? account.label
    : accountsLoaded
      ? 'no account'
      : 'loading…';

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1} justifyContent="space-between">
        <Text color="cyanBright">TerMail</Text>
        <Text color="gray">
          {accountLabel} | {currentFolder.name} ({unreadCount} unread) | pane:{activePane}
        </Text>
      </Box>

      <Text color={healthColor(imapHealth)} wrap="truncate-end">{healthLabel(account ? protocolLabel(account.incoming.protocol).toLowerCase() : 'imap', imapHealth)}</Text>
      <Text color={healthColor(smtpHealth)} wrap="truncate-end">{healthLabel('smtp', smtpHealth)}</Text>

      <Box>
        <Box width={leftWidth} height={paneHeight} borderStyle="round" borderColor={activePane === 'folders' ? 'cyan' : 'gray'} flexDirection="column" paddingX={1}>
          <Text color="yellow">Folders</Text>
          {folderScroll > 0 && <Text color="gray">^ more</Text>}
          {visibleFolders.map((folder, index) => {
            const absoluteIndex = folderScroll + index;
            return (
              <Text key={folder.id} color={absoluteIndex === folderIndex ? 'green' : undefined} wrap="truncate-end">
                {absoluteIndex === folderIndex ? '>' : ' '} {folder.name} ({folder.unread})
              </Text>
            );
          })}
          {folderScroll < maxFolderScroll && <Text color="gray">v more</Text>}
        </Box>

        <Box width={centerWidth} height={paneHeight} marginLeft={1} borderStyle="round" borderColor={activePane === 'messages' ? 'cyan' : 'gray'} flexDirection="column" paddingX={1}>
          <Text color="yellow">Messages</Text>
          {messages.length === 0 ? (
            <Text color="gray">{account ? 'No cached messages (press y to sync)' : 'No account (press A to add one)'}</Text>
          ) : (
            <>
              {messageScroll > 0 && <Text color="gray">^ more</Text>}
              {visibleMessages.map((message, index) => {
                const absoluteIndex = messageScroll + index;
                return (
                  <Text key={message.id} color={absoluteIndex === messageIndex ? 'green' : undefined} wrap="truncate-end">
                    {absoluteIndex === messageIndex ? '>' : ' '} {message.unread ? '●' : '○'} {message.starred ? '★' : ' '} {message.from} - {message.subject}
                  </Text>
                );
              })}
              {messageScroll < maxMessageScroll && <Text color="gray">v more</Text>}
            </>
          )}
        </Box>

        <Box width={rightWidth} height={paneHeight} marginLeft={1} borderStyle="round" borderColor={activePane === 'preview' ? 'cyan' : 'gray'} flexDirection="column" paddingX={1}>
          <Text color="yellow">Preview</Text>
          {previewScroll > 0 && <Text color="gray">^ more</Text>}
          {visiblePreviewLines.map((line, idx) => (
            <Text key={`${previewScroll}-${idx}`} wrap="truncate-end" color={!selectedMessage ? 'gray' : undefined}>{line}</Text>
          ))}
          {previewScroll < maxPreviewScroll && <Text color="gray">v more</Text>}
        </Box>
      </Box>

      <Box marginTop={1} justifyContent="space-between">
        <Text color="gray" wrap="truncate-end">status: {status} | search: {searchMode ? '/' : ''}{query || '(none)'}</Text>
        <Text color="gray">{accounts.length} account{accounts.length === 1 ? '' : 's'}</Text>
      </Box>
      <Text color="cyan" wrap="truncate-end">
        tab pane | j/k move | / search | y sync 200 | Y sync 1000 | F full sync | n send | t smtp-test | o open | s star | u unread | e archive | d delete | A accounts | C clear cache | r recheck | q quit
      </Text>
    </Box>
  );
}
