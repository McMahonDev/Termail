import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { cacheUsage, formatBytes, totalCacheUsage } from '../cache.js';
import { DATA_DIR } from '../paths.js';

type Option = {
  scope: 'messages' | 'attachments' | 'account' | 'all';
  label: string;
  detail: string;
};

const OPTIONS: Option[] = [
  { scope: 'messages', label: 'Cached messages', detail: 'Message list and bodies for this account. Attachments stay.' },
  { scope: 'attachments', label: 'Downloaded attachments', detail: 'Attachment files for this account. The message list stays.' },
  { scope: 'account', label: 'Everything for this account', detail: 'Messages and attachments. Login details are kept.' },
  { scope: 'all', label: 'Every account’s cache', detail: 'Wipes the whole data directory. Login details are kept.' }
];

type Props = {
  account: any | null;
  onClear: (scope: Option['scope']) => Promise<void>;
  onClose: () => void;
};

export function CacheScreen({ account, onClear, onClose }: Props) {
  const [index, setIndex] = useState(0);
  const [usage, setUsage] = useState({ messages: 0, attachments: 0, total: 0, all: 0 });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState('');

  const refresh = async () => {
    const [scoped, all] = await Promise.all([cacheUsage(account?.id), totalCacheUsage()]);
    setUsage({ ...scoped, all });
  };

  useEffect(() => {
    void refresh();
  }, [account?.id]);

  const sizeFor = (scope: Option['scope']) => {
    if (scope === 'messages') return usage.messages;
    if (scope === 'attachments') return usage.attachments;
    if (scope === 'account') return usage.total;
    return usage.all;
  };

  const selected = OPTIONS[index];

  useInput((input, key) => {
    if (busy) {
      return;
    }

    if (confirming) {
      if (input === 'y' || key.return) {
        setBusy('Clearing…');
        void onClear(selected.scope).then(async () => {
          await refresh();
          setBusy('');
          setConfirming(false);
          setResult(`Cleared ${selected.label.toLowerCase()}`);
        }).catch((error: Error) => {
          setBusy('');
          setConfirming(false);
          setResult(error.message);
        });
        return;
      }
      setConfirming(false);
      return;
    }

    if (key.escape || input === 'q') {
      onClose();
      return;
    }
    if (key.upArrow || input === 'k') {
      setIndex((prev) => (prev - 1 + OPTIONS.length) % OPTIONS.length);
      setResult('');
      return;
    }
    if (key.downArrow || input === 'j') {
      setIndex((prev) => (prev + 1) % OPTIONS.length);
      setResult('');
      return;
    }
    if (key.return) {
      setConfirming(true);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="cyanBright">Clear local cache</Text>
      <Text color="gray">{account ? `${account.label} · ` : ''}{DATA_DIR}</Text>

      <Box marginTop={1} flexDirection="column">
        {OPTIONS.map((option, position) => (
          <Text key={option.scope} color={position === index ? 'green' : undefined} wrap="truncate-end">
            {position === index ? '>' : ' '} {option.label.padEnd(30)}
            <Text color="gray">{formatBytes(sizeFor(option.scope))}</Text>
          </Text>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text color="gray" wrap="truncate-end">{selected.detail}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {busy ? <Text color="yellow">{busy}</Text> : null}
        {!busy && confirming ? (
          <Text color="redBright">
            Delete {selected.label.toLowerCase()} ({formatBytes(sizeFor(selected.scope))})? y / n
          </Text>
        ) : null}
        {!busy && !confirming && result ? <Text color="green">{result}</Text> : null}
        {!confirming ? <Text color="cyan">j/k choose | enter clear | esc back</Text> : null}
      </Box>
    </Box>
  );
}
