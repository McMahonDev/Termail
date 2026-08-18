import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { AccountForm } from './AccountForm.js';

type Props = {
  accounts: any[];
  activeAccountId: string | null;
  accountsLoaded: boolean;
  status: Record<string, { imap?: boolean; smtp?: boolean; error?: string }>;
  onSwitch: (id: string) => void;
  onSave: (account: any) => Promise<void>;
  onRemove: (id: string, alsoCache: boolean) => Promise<void>;
  onTest: (account: any) => Promise<string>;
  onClose: () => void;
};

export function AccountsScreen({ accounts, activeAccountId, accountsLoaded, status, onSwitch, onSave, onRemove, onTest, onClose }: Props) {
  const [mode, setMode] = useState<'list' | 'form' | 'confirm'>('list');
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState('');
  const [removeCache, setRemoveCache] = useState(true);

  const selected = accounts[Math.min(index, Math.max(0, accounts.length - 1))] || null;

  // Accounts arrive asynchronously, so neither of these can be decided in a
  // useState initializer — on the first render the list is still empty.
  const autoOpenedForm = useRef(false);
  useEffect(() => {
    if (accountsLoaded && accounts.length === 0 && !autoOpenedForm.current) {
      autoOpenedForm.current = true;
      setEditing(null);
      setMode('form');
    }
  }, [accountsLoaded, accounts.length]);

  const syncedSelection = useRef(false);
  useEffect(() => {
    if (!accountsLoaded || syncedSelection.current || accounts.length === 0) {
      return;
    }
    syncedSelection.current = true;
    setIndex(Math.max(0, accounts.findIndex((account) => account.id === activeAccountId)));
  }, [accountsLoaded, accounts, activeAccountId]);

  useInput((input, key) => {
    if (busy) {
      return;
    }

    if (mode === 'confirm') {
      if (key.escape || input === 'n') {
        setMode('list');
        return;
      }
      if (input === 'c') {
        setRemoveCache((prev) => !prev);
        return;
      }
      if (input === 'y' || key.return) {
        const target = selected;
        if (!target) {
          setMode('list');
          return;
        }
        setBusy('Removing…');
        void onRemove(target.id, removeCache).then(() => {
          setBusy('');
          setResult(`Removed ${target.label}`);
          setIndex(0);
          setMode('list');
        });
      }
      return;
    }

    if (key.escape) {
      onClose();
      return;
    }
    if (accounts.length === 0) {
      if (input === 'a') {
        setEditing(null);
        setResult('');
        setMode('form');
      }
      return;
    }
    if (key.upArrow || input === 'k') {
      setIndex((prev) => (prev - 1 + accounts.length) % accounts.length);
      return;
    }
    if (key.downArrow || input === 'j') {
      setIndex((prev) => (prev + 1) % accounts.length);
      return;
    }
    if (key.return) {
      if (selected && selected.id !== activeAccountId) {
        onSwitch(selected.id);
        setResult(`Switched to ${selected.label}`);
      }
      return;
    }
    if (input === 'a') {
      setEditing(null);
      setResult('');
      setMode('form');
      return;
    }
    if (input === 'e' && selected) {
      setEditing(selected);
      setResult('');
      setMode('form');
      return;
    }
    if ((input === 'x' || key.delete) && selected) {
      setRemoveCache(true);
      setMode('confirm');
      return;
    }
    if (input === 't' && selected) {
      setBusy(`Testing ${selected.label}…`);
      void onTest(selected).then((message) => {
        setBusy('');
        setResult(message);
      });
    }
  }, { isActive: mode !== 'form' });

  if (mode === 'form') {
    return (
      <AccountForm
        account={editing}
        busy={busy}
        result={result}
        onCancel={() => {
          setResult('');
          if (accounts.length === 0) {
            onClose();
          } else {
            setMode('list');
          }
        }}
        onTest={(account) => {
          setBusy('Testing connection…');
          void onTest(account).then((message) => {
            setBusy('');
            setResult(message);
          });
        }}
        onSave={(account) => {
          setBusy('Saving…');
          void onSave(account).then(() => {
            setBusy('');
            setResult(`Saved ${account.label}`);
            setMode('list');
          }).catch((error: Error) => {
            setBusy('');
            setResult(error.message);
          });
        }}
      />
    );
  }

  if (mode === 'confirm' && selected) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="redBright">Remove account</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>{selected.label} — {selected.email || 'no address'}</Text>
          <Text color="gray">Credentials for this account are deleted from the config file.</Text>
          <Text>
            <Text color="gray">Cached mail: </Text>
            <Text color={removeCache ? 'red' : 'yellow'}>{removeCache ? 'delete too' : 'keep on disk'}</Text>
            <Text color="gray"> (press c to toggle)</Text>
          </Text>
        </Box>
        <Box marginTop={1}>
          {busy ? <Text color="yellow">{busy}</Text> : <Text color="cyan">y remove | n cancel | c toggle cache</Text>}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="cyanBright">Accounts</Text>

      {accounts.length === 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">No accounts configured.</Text>
          <Text color="gray">Press a to add one — TerMail can't reach a mailbox until you do.</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {accounts.map((account, position) => {
            const isActive = account.id === activeAccountId;
            const health = status[account.id] || {};
            const marks = [
              health.imap === undefined ? null : `imap ${health.imap ? 'ok' : 'fail'}`,
              health.smtp === undefined ? null : `smtp ${health.smtp ? 'ok' : 'fail'}`
            ].filter(Boolean).join(' · ');

            return (
              <Text key={account.id} color={position === index ? 'green' : undefined} wrap="truncate-end">
                {position === index ? '>' : ' '} {isActive ? '●' : '○'} {account.label}
                <Text color="gray">
                  {account.email && account.email !== account.label ? `  ${account.email}` : ''}
                  {isActive ? '  (active)' : ''}
                  {marks ? `  ${marks}` : ''}
                </Text>
              </Text>
            );
          })}
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        {busy ? <Text color="yellow">{busy}</Text> : null}
        {!busy && result ? <Text color={/fail|error|refused/i.test(result) ? 'red' : 'green'} wrap="truncate-end">{result}</Text> : null}
        <Text color="cyan">
          {accounts.length === 0
            ? 'a add | esc back'
            : 'j/k move | enter switch | a add | e edit | x remove | t test | esc back'}
        </Text>
      </Box>
    </Box>
  );
}
