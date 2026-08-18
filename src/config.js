import { chmod, mkdir, readFile, rename, writeFile, cp, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { CONFIG_DIR, CONFIG_PATH, accountDataDir } from './paths.js';

const CONFIG_VERSION = 1;

/**
 * Host settings for the providers people actually use, so adding an account is
 * "pick provider, type email + app password" rather than filling in six fields
 * from a support page.
 */
export const PROVIDER_PRESETS = [
  {
    id: 'gmail',
    name: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    pop3: { host: 'pop.gmail.com', port: 995, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    note: 'Requires an app password (myaccount.google.com/apppasswords).'
  },
  {
    id: 'outlook',
    name: 'Outlook / Microsoft 365',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    pop3: { host: 'outlook.office365.com', port: 995, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    note: 'Requires an app password when MFA is on.'
  },
  {
    id: 'icloud',
    name: 'iCloud Mail',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    pop3: { host: 'imap.mail.me.com', port: 995, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    note: 'Requires an app-specific password from appleid.apple.com. IMAP only.'
  },
  {
    id: 'fastmail',
    name: 'Fastmail',
    imap: { host: 'imap.fastmail.com', port: 993, secure: true },
    pop3: { host: 'pop.fastmail.com', port: 995, secure: true },
    smtp: { host: 'smtp.fastmail.com', port: 465, secure: true },
    note: 'Create an app password with mail read+send scope.'
  },
  {
    id: 'yahoo',
    name: 'Yahoo Mail',
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    pop3: { host: 'pop.mail.yahoo.com', port: 995, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    note: 'Requires an app password from Yahoo account security.'
  },
  {
    id: 'zoho',
    name: 'Zoho Mail',
    imap: { host: 'imappro.zoho.com', port: 993, secure: true },
    pop3: { host: 'poppro.zoho.com', port: 995, secure: true },
    smtp: { host: 'smtppro.zoho.com', port: 587, secure: false },
    note: 'IMAP must be switched on in Zoho settings; POP3 works without that.'
  },
  {
    id: 'custom',
    name: 'Other / custom server',
    imap: { host: '', port: 993, secure: true },
    pop3: { host: '', port: 995, secure: true },
    smtp: { host: '', port: 587, secure: false },
    note: 'Enter your provider’s incoming and SMTP details by hand.'
  }
];

export const INCOMING_PROTOCOLS = ['imap', 'pop3'];

export function protocolLabel(protocol) {
  return protocol === 'pop3' ? 'POP3' : 'IMAP';
}

export function getPreset(id) {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) || PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
}

const EMPTY_CONFIG = {
  version: CONFIG_VERSION,
  activeAccountId: null,
  accounts: []
};

function toPort(value, fallback) {
  const port = Number(value);
  return Number.isFinite(port) && port > 0 ? Math.floor(port) : fallback;
}

function toBool(value, fallback) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return String(value).toLowerCase() === 'true';
}

/** Fill in every field so the rest of the app never has to guard on shape. */
export function normalizeAccount(input = {}) {
  // Accounts written before POP3 support stored incoming settings under `imap`.
  const incoming = input.incoming || input.imap || {};
  const smtp = input.smtp || {};
  const email = input.email || incoming.user || smtp.user || '';
  const protocol = INCOMING_PROTOCOLS.includes(incoming.protocol) ? incoming.protocol : 'imap';
  const defaultPort = protocol === 'pop3' ? 995 : 993;

  return {
    id: input.id || `acc_${randomUUID().slice(0, 8)}`,
    label: input.label || email || 'Untitled account',
    email,
    provider: input.provider || 'custom',
    incoming: {
      protocol,
      host: incoming.host || '',
      port: toPort(incoming.port, defaultPort),
      secure: toBool(incoming.secure, true),
      user: incoming.user || email,
      pass: incoming.pass || ''
    },
    smtp: {
      host: smtp.host || '',
      port: toPort(smtp.port, 587),
      secure: toBool(smtp.secure, toPort(smtp.port, 587) === 465),
      user: smtp.user || email,
      pass: smtp.pass || '',
      from: smtp.from || email
    },
    createdAt: input.createdAt || new Date().toISOString()
  };
}

export function isIncomingConfigured(account) {
  return Boolean(account?.incoming?.host && account?.incoming?.user && account?.incoming?.pass);
}

export function isSmtpConfigured(account) {
  return Boolean(account?.smtp?.host && account?.smtp?.user && account?.smtp?.pass && account?.smtp?.from);
}

export async function readConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const accounts = Array.isArray(parsed.accounts) ? parsed.accounts.map(normalizeAccount) : [];
    const activeAccountId = accounts.some((account) => account.id === parsed.activeAccountId)
      ? parsed.activeAccountId
      : accounts[0]?.id || null;

    return { version: CONFIG_VERSION, activeAccountId, accounts };
  } catch {
    return { ...EMPTY_CONFIG, accounts: [] };
  }
}

export async function writeConfig(config) {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const payload = {
    version: CONFIG_VERSION,
    activeAccountId: config.activeAccountId || null,
    accounts: (config.accounts || []).map(normalizeAccount)
  };

  // Write through a temp file so a crash mid-write can't truncate a config that
  // holds the only copy of someone's app passwords.
  const tempPath = `${CONFIG_PATH}.tmp`;
  await writeFile(tempPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, CONFIG_PATH);
  await chmod(CONFIG_PATH, 0o600);
  return payload;
}

export async function getActiveAccount() {
  const config = await readConfig();
  if (!config.activeAccountId) {
    return null;
  }
  return config.accounts.find((account) => account.id === config.activeAccountId) || null;
}

export async function listAccounts() {
  const config = await readConfig();
  return { accounts: config.accounts, activeAccountId: config.activeAccountId };
}

export async function saveAccount(input) {
  const config = await readConfig();
  const account = normalizeAccount(input);
  const index = config.accounts.findIndex((existing) => existing.id === account.id);

  if (index >= 0) {
    config.accounts[index] = account;
  } else {
    config.accounts.push(account);
  }

  if (!config.activeAccountId) {
    config.activeAccountId = account.id;
  }

  await writeConfig(config);
  return account;
}

export async function removeAccount(id) {
  const config = await readConfig();
  config.accounts = config.accounts.filter((account) => account.id !== id);
  if (config.activeAccountId === id) {
    config.activeAccountId = config.accounts[0]?.id || null;
  }
  await writeConfig(config);
  return config;
}

export async function setActiveAccount(id) {
  const config = await readConfig();
  if (!config.accounts.some((account) => account.id === id)) {
    throw new Error('Unknown account');
  }
  config.activeAccountId = id;
  await writeConfig(config);
  return config;
}

/**
 * Pre-TerMail installs kept credentials in a .env and mail in a cwd-relative
 * `.data/`. Both break once the binary is on PATH and run from anywhere, so the
 * first launch folds them into the real config and data directories.
 */
function legacyEnvCandidates() {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  return [
    join(process.cwd(), '.env'),
    join(packageRoot, '.env'),
    join(process.env.HOME || '', '.config', 'hello-tui', '.env'),
    join(process.env.HOME || '', '.config', 'termail', '.env')
  ];
}

function legacyDataCandidates() {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  return [join(process.cwd(), '.data'), join(packageRoot, '.data')];
}

function accountFromEnv(env) {
  if (!env.IMAP_HOST && !env.SMTP_HOST) {
    return null;
  }

  const email = env.SMTP_FROM || env.SMTP_USER || env.IMAP_USER || '';
  const smtpPort = toPort(env.SMTP_PORT, 587);

  return normalizeAccount({
    label: email || 'Imported account',
    email,
    provider: 'custom',
    incoming: {
      protocol: 'imap',
      host: env.IMAP_HOST || '',
      port: toPort(env.IMAP_PORT, 993),
      secure: toBool(env.IMAP_SECURE, true),
      user: env.IMAP_USER || email,
      pass: env.IMAP_PASS || ''
    },
    smtp: {
      host: env.SMTP_HOST || '',
      port: smtpPort,
      secure: toBool(env.SMTP_SECURE, smtpPort === 465),
      user: env.SMTP_USER || email,
      pass: env.SMTP_PASS || '',
      from: email
    }
  });
}

async function migrateLegacyCache(accountId) {
  const target = accountDataDir(accountId);
  if (existsSync(join(target, 'mail-cache.json'))) {
    return null;
  }

  for (const legacyDir of legacyDataCandidates()) {
    if (!existsSync(join(legacyDir, 'mail-cache.json'))) {
      continue;
    }

    await mkdir(dirname(target), { recursive: true });
    try {
      // Same filesystem: instant, and leaves nothing behind to re-migrate.
      await rename(legacyDir, target);
      return { from: legacyDir, to: target, moved: true };
    } catch {
      // Different filesystem (or in use): copy and leave the original alone.
      try {
        await cp(legacyDir, target, { recursive: true });
        return { from: legacyDir, to: target, moved: false };
      } catch {
        return null;
      }
    }
  }

  return null;
}

/**
 * Runs once, before the UI mounts. Returns a short line describing what it did
 * so the status bar can say so, or null when there was nothing to migrate.
 */
export async function migrateLegacySetup() {
  const config = await readConfig();
  if (config.accounts.length > 0) {
    return null;
  }

  for (const envPath of legacyEnvCandidates()) {
    if (!envPath || !existsSync(envPath)) {
      continue;
    }

    let parsed;
    try {
      parsed = dotenv.parse(await readFile(envPath, 'utf8'));
    } catch {
      continue;
    }

    const account = accountFromEnv(parsed);
    if (!account) {
      continue;
    }

    await saveAccount(account);
    const cache = await migrateLegacyCache(account.id);
    return {
      account,
      envPath,
      cache,
      message: `Imported ${account.label} from ${envPath}${cache ? ` (+ cached mail ${cache.moved ? 'moved' : 'copied'})` : ''}`
    };
  }

  return null;
}

/** Used by the doctor/status output so we can show real numbers, not guesses. */
export async function configFileInfo() {
  try {
    const info = await stat(CONFIG_PATH);
    return {
      path: CONFIG_PATH,
      exists: true,
      mode: (info.mode & 0o777).toString(8).padStart(3, '0'),
      size: info.size
    };
  } catch {
    return { path: CONFIG_PATH, exists: false, mode: null, size: 0 };
  }
}
