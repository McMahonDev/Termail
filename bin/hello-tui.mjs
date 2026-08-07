#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'src', 'index.tsx');
const args = ['--import', 'tsx', entry, ...process.argv.slice(2)];
const result = spawnSync(process.execPath, args, { stdio: 'inherit' });

if (result.error) {
	throw result.error;
}

process.exit(result.status ?? 0);
