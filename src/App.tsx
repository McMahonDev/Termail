import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { startServer } from './server.js';

type Pane = 'folders' | 'messages' | 'preview';
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

type ServerState = {
	online: boolean;
	requests: number;
	uptimeMs: number;
	now: string;
	error: string;
	smtp: {
		configured: boolean;
		connected: boolean;
		from: string | null;
		testTo: string | null;
		error: string;
	};
	imap: {
		configured: boolean;
		connected: boolean;
		error: string;
	};
	store: {
		count: number;
		lastSyncAt: string | null;
	};
};

const DEFAULT_FOLDERS: Folder[] = [
	{ id: 'inbox', name: 'Inbox', unread: 0 },
	{ id: 'starred', name: 'Starred', unread: 0 },
	{ id: 'sent', name: 'Sent', unread: 0 },
	{ id: 'archive', name: 'Archive', unread: 0 }
];

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

function readJson(url: string): Promise<any> {
	return new Promise((resolve, reject) => {
		const request = get(url, (response) => {
			let body = '';
			response.setEncoding('utf8');
			response.on('data', (chunk) => {
				body += chunk;
			});
			response.on('end', () => {
				try {
					resolve(JSON.parse(body));
				} catch (error) {
					reject(error);
				}
			});
		});
		request.on('error', reject);
	});
}

export function App() {
	const { exit } = useApp();
	const { stdout } = useStdout();

	const [activePane, setActivePane] = useState<Pane>('folders');
	const [folders, setFolders] = useState<Folder[]>(DEFAULT_FOLDERS);
	const [messages, setMessages] = useState<Message[]>([]);
	const [folderIndex, setFolderIndex] = useState(0);
	const [messageIndex, setMessageIndex] = useState(0);
	const [query, setQuery] = useState('');
	const [searchMode, setSearchMode] = useState(false);
	const [status, setStatus] = useState('Ready');
	const [serverBaseUrl, setServerBaseUrl] = useState('');
	const [folderScroll, setFolderScroll] = useState(0);
	const [messageScroll, setMessageScroll] = useState(0);
	const [previewScroll, setPreviewScroll] = useState(0);
	const [server, setServer] = useState<ServerState>({
		online: false,
		requests: 0,
		uptimeMs: 0,
		now: '-',
		error: '',
		smtp: {
			configured: false,
			connected: false,
			from: null,
			testTo: null,
			error: ''
		},
		imap: {
			configured: false,
			connected: false,
			error: ''
		},
		store: {
			count: 0,
			lastSyncAt: null
		}
	});

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

	const smtpLabel = !server.smtp.configured
		? 'smtp: not configured (set SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM)'
		: server.smtp.connected
			? `smtp: connected (${server.smtp.from || 'unknown from'})`
			: `smtp: auth failed${server.smtp.error ? ` (${server.smtp.error})` : ''}`;

	const imapLabel = !server.imap.configured
		? 'imap: not configured (set IMAP_HOST/IMAP_USER/IMAP_PASS)'
		: server.imap.connected
			? `imap: connected | cached: ${server.store.count}`
			: `imap: connect failed${server.imap.error ? ` (${server.imap.error})` : ''}`;

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

	const loadMailbox = useCallback(async (baseUrl: string, folderId: string, q: string) => {
		const [folderData, messageData] = await Promise.all([
			readJson(`${baseUrl}/api/mail/folders`),
			readJson(`${baseUrl}/api/mail/messages?folder=${encodeURIComponent(folderId)}&query=${encodeURIComponent(q)}`)
		]);

		if (folderData.ok && Array.isArray(folderData.folders)) {
			setFolders(folderData.folders);
		}
		if (messageData.ok && Array.isArray(messageData.messages)) {
			setMessages(messageData.messages);
			setMessageIndex(0);
			setMessageScroll(0);
		}
	}, []);

	useEffect(() => {
		let closed = false;
		let timer: NodeJS.Timeout | null = null;
		let closeServer: null | (() => Promise<void>) = null;

		const refreshStatus = async (baseUrl: string) => {
			try {
				const data = await readJson(`${baseUrl}/api/status`);
				if (closed) {
					return;
				}
				setServer({
					online: true,
					requests: data.requests,
					uptimeMs: data.uptimeMs,
					now: data.now,
					error: '',
					smtp: data.smtp || {
						configured: false,
						connected: false,
						from: null,
						testTo: null,
						error: ''
					},
					imap: data.imap || {
						configured: false,
						connected: false,
						error: ''
					},
					store: data.store || {
						count: 0,
						lastSyncAt: null
					}
				});
			} catch (error) {
				if (closed) {
					return;
				}
				setServer((prev) => ({
					...prev,
					online: false,
					error: error instanceof Error ? error.message : String(error)
				}));
			}
		};

		void (async () => {
			try {
				const srv = await startServer();
				if (closed) {
					await srv.close();
					return;
				}

				setServerBaseUrl(srv.baseUrl);
				closeServer = srv.close;
				await loadMailbox(srv.baseUrl, 'inbox', '');
				await refreshStatus(srv.baseUrl);

				timer = setInterval(() => {
					void refreshStatus(srv.baseUrl);
				}, 7000);
			} catch (error) {
				if (!closed) {
					setStatus(error instanceof Error ? `Startup failed: ${error.message}` : 'Startup failed');
				}
			}
		})();

		return () => {
			closed = true;
			if (timer) {
				clearInterval(timer);
			}
			if (closeServer) {
				void closeServer();
			}
		};
	}, [loadMailbox]);

	useEffect(() => {
		if (!serverBaseUrl) {
			return;
		}
		void loadMailbox(serverBaseUrl, currentFolder.id, query).catch((error) => {
			setStatus(error instanceof Error ? `Mailbox load failed: ${error.message}` : 'Mailbox load failed');
		});
	}, [currentFolder.id, loadMailbox, query, serverBaseUrl]);

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
			if (folderIndex < prev) {
				return folderIndex;
			}
			if (folderIndex >= prev + listRows) {
				return folderIndex - listRows + 1;
			}
			return prev;
		});
	}, [folderIndex, listRows]);

	useEffect(() => {
		setMessageScroll((prev) => {
			if (messageIndex < prev) {
				return messageIndex;
			}
			if (messageIndex >= prev + listRows) {
				return messageIndex - listRows + 1;
			}
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

	const persistMessagePatch = async (id: string, patch: Record<string, string>) => {
		if (!serverBaseUrl) {
			return;
		}
		const params = new URLSearchParams({ id, ...patch });
		await readJson(`${serverBaseUrl}/api/mail/update?${params.toString()}`);
	};

	const deleteMessageById = async (id: string) => {
		if (!serverBaseUrl) {
			return;
		}
		await readJson(`${serverBaseUrl}/api/mail/delete?id=${encodeURIComponent(id)}`);
	};

	const mutateSelectedMessage = (mutator: (message: Message) => Message, fallback: string) => {
		if (!selectedMessage) {
			setStatus(fallback);
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

		const patch: Record<string, string> = {};
		if (updated.unread !== selectedMessage.unread) {
			patch.unread = String(updated.unread);
		}
		if (updated.starred !== selectedMessage.starred) {
			patch.starred = String(updated.starred);
		}
		if (updated.folder !== selectedMessage.folder) {
			patch.folder = updated.folder;
		}

		if (Object.keys(patch).length > 0) {
			void persistMessagePatch(selectedMessage.id, patch);
		}

		setStatus('Message updated');
	};

	const runSync = async (limit = 200) => {
		if (!serverBaseUrl) {
			setStatus('Sync unavailable: local server not ready');
			return;
		}
		try {
			const data = await readJson(`${serverBaseUrl}/api/mail/sync?limit=${encodeURIComponent(String(limit))}`);
			if (!data.ok) {
				setStatus(data.error ? `Sync failed: ${data.error}` : 'Sync failed');
				return;
			}
			await loadMailbox(serverBaseUrl, currentFolder.id, query);
			setStatus(`Synced ${data.synced || 0} messages (limit ${limit})`);
		} catch (error) {
			setStatus(error instanceof Error ? error.message : String(error));
		}
	};

	const deleteSelectedMessage = async () => {
		if (!selectedMessage) {
			setStatus('No message selected');
			return;
		}

		const id = selectedMessage.id;
		setMessages((current) => current.filter((message) => message.id !== id));
		setMessageIndex((prev) => Math.max(0, Math.min(prev, messages.length - 2)));

		try {
			await deleteMessageById(id);
			setStatus('Message deleted');
			await loadMailbox(serverBaseUrl, currentFolder.id, query);
		} catch (error) {
			setStatus(error instanceof Error ? `Delete failed: ${error.message}` : 'Delete failed');
		}
	};

	const sendSmtpTest = async () => {
		if (!serverBaseUrl) {
			setStatus('SMTP unavailable: local server not ready');
			return;
		}
		try {
			const data = await readJson(`${serverBaseUrl}/api/smtp/send-test`);
			if (!data.ok) {
				setStatus(data.error ? `SMTP error: ${data.error}` : 'SMTP test failed');
				return;
			}
			setStatus(`SMTP test sent to ${data.info?.to || 'recipient'}`);
		} catch (error) {
			setStatus(error instanceof Error ? error.message : String(error));
		}
	};

	const sendQuickMail = async () => {
		if (!serverBaseUrl) {
			setStatus('Send unavailable: local server not ready');
			return;
		}

		const to = process.env.SMTP_TEST_TO || process.env.SMTP_FROM || process.env.SMTP_USER || '';
		if (!to) {
			setStatus('Set SMTP_TEST_TO (or SMTP_FROM) to use quick send');
			return;
		}

		try {
			const subject = encodeURIComponent(`hello-tui manual send ${new Date().toLocaleTimeString()}`);
			const text = encodeURIComponent('This is a manual test message sent from hello-tui.');
			const data = await readJson(`${serverBaseUrl}/api/mail/send?to=${encodeURIComponent(to)}&subject=${subject}&text=${text}`);
			if (!data.ok) {
				setStatus(data.error ? `Send failed: ${data.error}` : 'Send failed');
				return;
			}
			await loadMailbox(serverBaseUrl, currentFolder.id, query);
			setStatus(`Sent email to ${data.info?.to || to}`);
		} catch (error) {
			setStatus(error instanceof Error ? error.message : String(error));
		}
	};

	const openSelectedInBrowser = () => {
		if (!selectedMessage) {
			setStatus('No message selected');
			return;
		}
		if (!serverBaseUrl) {
			setStatus('Server not ready');
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

		if (activePane === 'preview') {
			setPreviewScroll((prev) => clamp(prev + delta, 0, maxPreviewScroll));
		}
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
		if (activePane === 'preview') {
			setPreviewScroll((prev) => clamp(prev + deltaPages * pageSize, 0, maxPreviewScroll));
		}
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

		if (input === 'q') {
			exit();
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
			mutateSelectedMessage((message) => ({ ...message, starred: !message.starred }), 'No message selected');
			return;
		}
		if (input === 'u') {
			mutateSelectedMessage((message) => ({ ...message, unread: !message.unread }), 'No message selected');
			return;
		}
		if (input === 'e') {
			mutateSelectedMessage((message) => ({ ...message, folder: 'archive', unread: false }), 'No message selected');
			return;
		}
		if (input === 'd' || key.delete) {
			void deleteSelectedMessage();
			return;
		}
		if (key.escape) {
			setQuery('');
			setStatus('Search cleared');
		}
	});

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
			setStatus('Focused folders (mouse)');
			const idx = folderScroll + (y - firstListRow);
			if (idx >= 0 && idx < folders.length) {
				setFolderIndex(idx);
			}
			setMessageIndex(0);
			return;
		}

		if (x >= centerStart && x < centerStart + centerWidth) {
			setActivePane('messages');
			setStatus('Focused messages (mouse)');
			const idx = messageScroll + (y - firstListRow);
			if (idx >= 0 && idx < messages.length) {
				setMessageIndex(idx);
			}
			return;
		}

		if (x >= rightStart && x < rightStart + rightWidth) {
			setActivePane('preview');
			setStatus('Focused preview (mouse)');
		}
	}, [centerWidth, folderScroll, folders.length, leftWidth, listRows, messageScroll, messages.length, rightWidth]);

	useEffect(() => {
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			return;
		}

		process.stdout.write('\u001b[?1000h\u001b[?1006h');

		const onData = (chunk: Buffer) => {
			const data = chunk.toString('utf8');
			const mouseEvents = data.matchAll(/\u001b\[<(\d+);(\d+);(\d+)([mM])/g);
			for (const event of mouseEvents) {
				const x = Number(event[2]);
				const y = Number(event[3]);
				const kind = event[4];
				if (kind !== 'M') {
					continue;
				}
				handleMouseClick(x, y);
			}
		};

		process.stdin.on('data', onData);
		return () => {
			process.stdin.off('data', onData);
			process.stdout.write('\u001b[?1000l\u001b[?1006l');
		};
	}, [handleMouseClick]);

	return (
		<Box flexDirection="column" paddingX={1}>
			<Box marginBottom={1} justifyContent="space-between">
				<Text color="cyanBright">mailflow</Text>
				<Text color="gray">
					{currentFolder.name} ({unreadCount} unread) | sync:{server.online ? 'ok' : 'wait'} | pane:{activePane}
				</Text>
			</Box>

			<Text color={server.smtp.connected ? 'green' : 'yellow'}>{smtpLabel}</Text>
			<Text color={server.imap.connected ? 'green' : 'yellow'}>{imapLabel}</Text>

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
						<Text color="gray">No cached messages (press y to sync)</Text>
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
				<Text color="gray">server:req={server.requests} up={Math.floor(server.uptimeMs / 1000)}s</Text>
			</Box>
			<Text color="cyan">click pane | tab pane | j/k move | PgUp/PgDn scroll | / search | y sync(200) | Y deep-sync(1000) | n send | t smtp-test | o open-full | s star | u unread | e archive | d delete | q quit</Text>
		</Box>
	);
}
