#!/usr/bin/env node

// TerMail ships its TypeScript source and compiles on load through tsx, so
// there's no build step to keep in sync. tsx is registered in-process rather
// than by spawning a child: a TUI wants to own stdin/stdout directly, and a
// wrapper process would swallow signals and resize events.
import { register } from 'tsx/esm/api';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

register();
await import(pathToFileURL(join(here, '..', 'src', 'index.tsx')).href);
