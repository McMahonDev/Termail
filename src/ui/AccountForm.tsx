import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PROVIDER_PRESETS, getPreset, protocolLabel } from '../config.js';
import { Field, applyKey, inputState } from './TextInput.js';
import type { InputState } from './TextInput.js';

type FieldKey =
  | 'label' | 'email' | 'password'
  | 'protocol'
  | 'inHost' | 'inPort' | 'inUser' | 'inPass'
  | 'smtpHost' | 'smtpPort' | 'smtpUser' | 'smtpPass' | 'smtpFrom';

type Values = Record<Exclude<FieldKey, 'protocol'>, InputState>;

const BASIC_FIELDS: FieldKey[] = ['label', 'email', 'password'];
const ADVANCED_FIELDS: FieldKey[] = [
  'protocol', 'inHost', 'inPort', 'inUser', 'inPass',
  'smtpHost', 'smtpPort', 'smtpUser', 'smtpPass', 'smtpFrom'
];

const FIELD_LABELS: Record<FieldKey, string> = {
  label: 'Name',
  email: 'Email',
  password: 'Password',
  protocol: 'Incoming',
  inHost: 'Host',
  inPort: 'Port',
  inUser: 'User',
  inPass: 'Password',
  smtpHost: 'SMTP host',
  smtpPort: 'SMTP port',
  smtpUser: 'SMTP user',
  smtpPass: 'SMTP pass',
  smtpFrom: 'From'
};

const MASKED = new Set<FieldKey>(['password', 'inPass', 'smtpPass']);

function valuesFromAccount(account: any): Values {
  const preset = getPreset(account?.provider || 'custom');
  const protocol = account?.incoming?.protocol || 'imap';
  const presetIncoming = protocol === 'pop3' ? preset.pop3 : preset.imap;
  const sharedPass = account?.incoming?.pass && account.incoming.pass === account?.smtp?.pass
    ? account.incoming.pass
    : '';

  return {
    label: inputState(account?.label || ''),
    email: inputState(account?.email || ''),
    password: inputState(sharedPass),
    inHost: inputState(account?.incoming?.host || presetIncoming.host),
    inPort: inputState(String(account?.incoming?.port ?? presetIncoming.port)),
    inUser: inputState(account?.incoming?.user || account?.email || ''),
    inPass: inputState(account?.incoming?.pass || ''),
    smtpHost: inputState(account?.smtp?.host || preset.smtp.host),
    smtpPort: inputState(String(account?.smtp?.port ?? preset.smtp.port)),
    smtpUser: inputState(account?.smtp?.user || account?.email || ''),
    smtpPass: inputState(account?.smtp?.pass || ''),
    smtpFrom: inputState(account?.smtp?.from || account?.email || '')
  };
}

/** Implicit TLS on the classic ports; STARTTLS everywhere else. */
function secureForPort(port: number) {
  return port === 993 || port === 995 || port === 465;
}

export function buildAccount(values: Values, provider: string, protocol: string, existing: any) {
  const email = values.email.value.trim();
  const inPort = Number(values.inPort.value) || (protocol === 'pop3' ? 995 : 993);
  const smtpPort = Number(values.smtpPort.value) || 587;

  return {
    id: existing?.id,
    createdAt: existing?.createdAt,
    provider,
    label: values.label.value.trim() || email || 'Untitled account',
    email,
    incoming: {
      protocol,
      host: values.inHost.value.trim(),
      port: inPort,
      secure: secureForPort(inPort),
      user: values.inUser.value.trim() || email,
      pass: values.inPass.value
    },
    smtp: {
      host: values.smtpHost.value.trim(),
      port: smtpPort,
      secure: secureForPort(smtpPort),
      user: values.smtpUser.value.trim() || email,
      pass: values.smtpPass.value,
      from: values.smtpFrom.value.trim() || email
    }
  };
}

type Props = {
  account?: any;
  busy?: string;
  result?: string;
  onCancel: () => void;
  onSave: (account: any) => void;
  onTest: (account: any) => void;
};

export function AccountForm({ account, busy, result, onCancel, onSave, onTest }: Props) {
  const editing = Boolean(account?.id);
  const [step, setStep] = useState<'provider' | 'fields'>(editing ? 'fields' : 'provider');
  const [providerIndex, setProviderIndex] = useState(() =>
    Math.max(0, PROVIDER_PRESETS.findIndex((preset) => preset.id === (account?.provider || 'gmail')))
  );
  const [provider, setProvider] = useState<string>(account?.provider || 'gmail');
  const [protocol, setProtocol] = useState<string>(account?.incoming?.protocol || 'imap');
  const [values, setValues] = useState<Values>(() => valuesFromAccount(account));
  const [showAdvanced, setShowAdvanced] = useState(() => (account?.provider || 'custom') === 'custom');
  const [focus, setFocus] = useState(0);
  const [touched, setTouched] = useState<Set<FieldKey>>(new Set());

  const visibleFields = useMemo(
    () => (showAdvanced ? [...BASIC_FIELDS, ...ADVANCED_FIELDS] : BASIC_FIELDS),
    [showAdvanced]
  );
  const activeField = visibleFields[Math.min(focus, visibleFields.length - 1)];

  const applyPreset = (presetId: string) => {
    const preset = getPreset(presetId);
    const incoming = protocol === 'pop3' ? preset.pop3 : preset.imap;
    setProvider(presetId);
    setValues((prev) => ({
      ...prev,
      inHost: touched.has('inHost') ? prev.inHost : inputState(incoming.host),
      inPort: touched.has('inPort') ? prev.inPort : inputState(String(incoming.port)),
      smtpHost: touched.has('smtpHost') ? prev.smtpHost : inputState(preset.smtp.host),
      smtpPort: touched.has('smtpPort') ? prev.smtpPort : inputState(String(preset.smtp.port))
    }));
    setShowAdvanced(presetId === 'custom');
    setStep('fields');
    setFocus(0);
  };

  /** Switching protocol swaps in that protocol's host and port from the preset. */
  const toggleProtocol = () => {
    const next = protocol === 'imap' ? 'pop3' : 'imap';
    const incoming = next === 'pop3' ? getPreset(provider).pop3 : getPreset(provider).imap;
    setProtocol(next);
    setValues((prev) => ({
      ...prev,
      inHost: touched.has('inHost') ? prev.inHost : inputState(incoming.host),
      inPort: touched.has('inPort') ? prev.inPort : inputState(String(incoming.port))
    }));
  };

  useInput((input, key) => {
    if (busy) {
      return;
    }

    if (step === 'provider') {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.upArrow) {
        setProviderIndex((prev) => (prev - 1 + PROVIDER_PRESETS.length) % PROVIDER_PRESETS.length);
        return;
      }
      if (key.downArrow) {
        setProviderIndex((prev) => (prev + 1) % PROVIDER_PRESETS.length);
        return;
      }
      if (key.return) {
        applyPreset(PROVIDER_PRESETS[providerIndex].id);
      }
      return;
    }

    if (key.escape) {
      onCancel();
      return;
    }
    if (key.ctrl && input === 's') {
      onSave(buildAccount(values, provider, protocol, account));
      return;
    }
    if (key.ctrl && input === 't') {
      onTest(buildAccount(values, provider, protocol, account));
      return;
    }
    if (key.ctrl && input === 'o') {
      setShowAdvanced((prev) => !prev);
      return;
    }

    // The protocol row is a toggle, not a text field.
    if (activeField === 'protocol') {
      if (key.leftArrow || key.rightArrow || input === ' ') {
        toggleProtocol();
        return;
      }
    }

    if (key.tab || key.downArrow || (key.return && focus < visibleFields.length - 1)) {
      setFocus((prev) => (prev + 1) % visibleFields.length);
      return;
    }
    if (key.upArrow) {
      setFocus((prev) => (prev - 1 + visibleFields.length) % visibleFields.length);
      return;
    }
    if (key.return) {
      onSave(buildAccount(values, provider, protocol, account));
      return;
    }
    if (activeField === 'protocol') {
      return;
    }

    const next = applyKey(values[activeField as keyof Values], input, key);
    if (!next) {
      return;
    }

    setValues((prev) => {
      const updated = { ...prev, [activeField]: next };

      // Typing the address or password once fills the per-protocol fields, so
      // the common case is three fields instead of twelve.
      if (activeField === 'email') {
        if (!touched.has('inUser')) updated.inUser = inputState(next.value);
        if (!touched.has('smtpUser')) updated.smtpUser = inputState(next.value);
        if (!touched.has('smtpFrom')) updated.smtpFrom = inputState(next.value);
      }
      if (activeField === 'password') {
        if (!touched.has('inPass')) updated.inPass = inputState(next.value);
        if (!touched.has('smtpPass')) updated.smtpPass = inputState(next.value);
      }

      return updated;
    });

    if (ADVANCED_FIELDS.includes(activeField)) {
      setTouched((prev) => new Set(prev).add(activeField));
    }
  });

  if (step === 'provider') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="cyanBright">Add account — choose a provider</Text>
        <Text color="gray">Presets fill in the server details for you.</Text>
        <Box marginTop={1} flexDirection="column">
          {PROVIDER_PRESETS.map((preset, index) => (
            <Text key={preset.id} color={index === providerIndex ? 'green' : undefined}>
              {index === providerIndex ? '>' : ' '} {preset.name}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text color="gray" wrap="truncate-end">{PROVIDER_PRESETS[providerIndex].note}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color="cyan">↑/↓ choose | enter continue | esc cancel</Text>
        </Box>
      </Box>
    );
  }

  const preset = getPreset(provider);
  const presetIncoming = protocol === 'pop3' ? preset.pop3 : preset.imap;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="cyanBright">{editing ? `Edit ${account.label}` : `New ${preset.name} account`}</Text>
      <Text color="gray">{preset.note}</Text>

      <Box marginTop={1} flexDirection="column">
        {BASIC_FIELDS.map((fieldKey) => (
          <Field
            key={fieldKey}
            label={FIELD_LABELS[fieldKey]}
            state={values[fieldKey as keyof Values]}
            focused={activeField === fieldKey}
            mask={MASKED.has(fieldKey)}
            placeholder={fieldKey === 'label' ? 'optional' : undefined}
          />
        ))}
      </Box>

      {showAdvanced ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">Incoming mail</Text>
          <Text>
            <Text color={activeField === 'protocol' ? 'cyan' : 'gray'}>{'Incoming:'.padEnd(14)}</Text>
            <Text color={protocol === 'imap' ? 'green' : 'gray'} inverse={activeField === 'protocol' && protocol === 'imap'}>IMAP</Text>
            <Text color="gray"> / </Text>
            <Text color={protocol === 'pop3' ? 'green' : 'gray'} inverse={activeField === 'protocol' && protocol === 'pop3'}>POP3</Text>
            {activeField === 'protocol' ? <Text color="gray">   ←/→ or space to switch</Text> : null}
          </Text>
          {(['inHost', 'inPort', 'inUser', 'inPass'] as FieldKey[]).map((fieldKey) => (
            <Field
              key={fieldKey}
              label={FIELD_LABELS[fieldKey]}
              state={values[fieldKey as keyof Values]}
              focused={activeField === fieldKey}
              mask={MASKED.has(fieldKey)}
            />
          ))}
          <Box marginTop={1}>
            <Text color="yellow">Outgoing mail</Text>
          </Box>
          {(['smtpHost', 'smtpPort', 'smtpUser', 'smtpPass', 'smtpFrom'] as FieldKey[]).map((fieldKey) => (
            <Field
              key={fieldKey}
              label={FIELD_LABELS[fieldKey]}
              state={values[fieldKey as keyof Values]}
              focused={activeField === fieldKey}
              mask={MASKED.has(fieldKey)}
            />
          ))}
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color="gray">
            {protocolLabel(protocol)} {presetIncoming.host}:{presetIncoming.port} · SMTP {preset.smtp.host}:{preset.smtp.port} — ctrl-o to change
          </Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        {busy ? <Text color="yellow">{busy}</Text> : null}
        {!busy && result ? <Text color={result.startsWith('OK') ? 'green' : 'red'} wrap="truncate-end">{result}</Text> : null}
        <Text color="cyan">
          tab/↑↓ field | ctrl-s save | ctrl-t test | ctrl-o {showAdvanced ? 'hide' : 'show'} servers | esc cancel
        </Text>
      </Box>
    </Box>
  );
}
