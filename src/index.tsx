import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envCandidates = [
	path.join(process.cwd(), '.env'),
	path.join(packageRoot, '.env'),
	path.join(process.env.HOME || '', '.config', 'hello-tui', '.env')
];

for (const envPath of envCandidates) {
	if (!envPath || !existsSync(envPath)) {
		continue;
	}
	dotenv.config({ path: envPath, override: false });
}

if (process.stdout.isTTY) {
	// Clear any prior launcher output (e.g. npm script banners) for a clean TUI.
	process.stdout.write('\x1bc');
}

render(<App />, { exitOnCtrlC: false });