import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { accountAttachmentsDir } from './paths.js';
import { getMessageById } from './mailStore.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A loopback server that exists for one reason: rendering a full HTML message
 * (with its inline images) in a real browser when the TUI can't. Mailbox reads
 * and writes go straight to the store — they no longer round-trip through here.
 *
 * `getAccountId` is a callback rather than a value because the active account
 * can change while the server is up.
 */
export async function startServer(getAccountId) {
  let baseUrl = '';

  function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', baseUrl || 'http://127.0.0.1');
    const accountId = getAccountId();

    try {
      if (!accountId) {
        sendJson(res, 409, { ok: false, error: 'No active account' });
        return;
      }

      const id = url.searchParams.get('id') || '';

      if (url.pathname === '/api/mail/attachment') {
        if (!id) {
          sendJson(res, 400, { ok: false, error: 'Missing id' });
          return;
        }

        const message = await getMessageById(accountId, id);
        if (!message) {
          sendJson(res, 404, { ok: false, error: 'Message not found' });
          return;
        }

        const cid = (url.searchParams.get('cid') || '').replace(/[<>]/g, '');
        const fileName = url.searchParams.get('file') || '';
        const attachments = Array.isArray(message.attachments) ? message.attachments : [];

        const attachment = (cid && attachments.find((item) => item.cid && item.cid === cid))
          || (fileName && attachments.find((item) => item.filename === fileName))
          || null;

        if (!attachment) {
          sendJson(res, 404, { ok: false, error: 'Attachment not found' });
          return;
        }

        // Attachment paths come from parsed mail, so confirm the resolved path
        // is still inside this account's attachment directory before reading.
        const root = accountAttachmentsDir(accountId);
        const absolutePath = resolve(root, String(attachment.path || ''));
        const contained = relative(root, absolutePath);
        if (!contained || contained.startsWith('..') || resolve(root, contained) !== absolutePath) {
          sendJson(res, 400, { ok: false, error: 'Invalid attachment path' });
          return;
        }

        res.writeHead(200, {
          'content-type': attachment.contentType || 'application/octet-stream',
          'content-disposition': `${attachment.contentDisposition === 'inline' ? 'inline' : 'attachment'}; filename="${(attachment.filename || 'attachment').replace(/"/g, '')}"`
        });
        res.end(await readFile(absolutePath));
        return;
      }

      if (url.pathname === '/api/mail/render') {
        if (!id) {
          sendJson(res, 400, { ok: false, error: 'Missing id' });
          return;
        }

        const message = await getMessageById(accountId, id);
        if (!message) {
          sendJson(res, 404, { ok: false, error: 'Message not found' });
          return;
        }

        const attachments = Array.isArray(message.attachments) ? message.attachments : [];
        const cidMap = new Map();
        for (const attachment of attachments) {
          if (attachment.cid) {
            cidMap.set(
              attachment.cid,
              `${baseUrl}/api/mail/attachment?id=${encodeURIComponent(id)}&cid=${encodeURIComponent(attachment.cid)}`
            );
          }
        }

        let htmlBody = message.bodyHtml || '';
        if (!htmlBody && message.bodyText) {
          htmlBody = `<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace">${escapeHtml(message.bodyText)}</pre>`;
        }

        htmlBody = htmlBody.replace(/src=["']cid:([^"']+)["']/gi, (full, cidValue) => {
          const mapped = cidMap.get(String(cidValue || '').replace(/[<>]/g, ''));
          return mapped ? `src="${mapped}"` : full;
        });

        const attachmentList = attachments
          .filter((item) => item.contentDisposition !== 'inline')
          .map((item) => {
            const href = `${baseUrl}/api/mail/attachment?id=${encodeURIComponent(id)}&file=${encodeURIComponent(item.filename || '')}`;
            return `<li><a href="${href}">${escapeHtml(item.filename || 'attachment')}</a> <span class="type">${escapeHtml(item.contentType || 'application/octet-stream')}</span></li>`;
          })
          .join('');

        const page = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(message.subject || '(no subject)')}</title>
    <style>
      :root { color-scheme: light dark; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0 auto; max-width: 52rem; padding: 24px; line-height: 1.5; }
      h1 { font-size: 1.5rem; margin: 0 0 12px; }
      .meta { color: #666; font-size: 0.875rem; margin-bottom: 24px; border-bottom: 1px solid #8884; padding-bottom: 16px; }
      .attachments { margin-top: 32px; border-top: 1px solid #8884; padding-top: 16px; }
      .type { color: #888; font-size: 0.8125rem; }
      img { max-width: 100%; height: auto; }
      pre { overflow-x: auto; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(message.subject || '(no subject)')}</h1>
    <div class="meta">
      From: ${escapeHtml(message.from)}<br />
      To: ${escapeHtml(message.to)}<br />
      When: ${escapeHtml(message.when)}
    </div>
    <div>${htmlBody || '<em>No body</em>'}</div>
    ${attachmentList ? `<div class="attachments"><h2>Attachments</h2><ul>${attachmentList}</ul></div>` : ''}
  </body>
</html>`;

        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page);
        return;
      }

      sendJson(res, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  return {
    baseUrl,
    close: () => new Promise((resolveClose, reject) => {
      server.close((err) => (err ? reject(err) : resolveClose()));
    })
  };
}
