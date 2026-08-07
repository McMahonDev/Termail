import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { syncInbox, verifyImap } from './imapSync.js';
import {
  addSentMessage,
  deleteMessage,
  getMessageById,
  getStoreSummary,
  listFolders,
  listMessages,
  updateMessage,
  upsertMessages
} from './mailStore.js';
import { sendSmtpMail, sendSmtpTestMail, verifySmtp } from './smtp.js';

export async function startServer() {
  const state = {
    requests: 0,
    startedAt: Date.now()
  };

  let baseUrl = '';
  const attachmentsRoot = join(process.cwd(), '.data', 'attachments');

  function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', baseUrl || 'http://127.0.0.1');

    try {
      if (url.pathname === '/api/status') {
        state.requests += 1;
        const smtp = await verifySmtp();
        const imap = await verifyImap();
        const store = await getStoreSummary();

        sendJson(res, 200, {
          ok: true,
          requests: state.requests,
          uptimeMs: Date.now() - state.startedAt,
          now: new Date().toISOString(),
          smtp,
          imap,
          store
        });
        return;
      }

      if (url.pathname === '/api/mail/folders') {
        const folders = await listFolders();
        sendJson(res, 200, { ok: true, folders });
        return;
      }

      if (url.pathname === '/api/mail/messages') {
        const folder = url.searchParams.get('folder') || 'inbox';
        const query = url.searchParams.get('query') || '';
        const messages = await listMessages({ folder, query });
        sendJson(res, 200, { ok: true, messages });
        return;
      }

      if (url.pathname === '/api/mail/message') {
        const id = url.searchParams.get('id') || '';
        if (!id) {
          sendJson(res, 400, { ok: false, error: 'Missing id' });
          return;
        }
        const message = await getMessageById(id);
        if (!message) {
          sendJson(res, 404, { ok: false, error: 'Message not found' });
          return;
        }
        sendJson(res, 200, { ok: true, message });
        return;
      }

      if (url.pathname === '/api/mail/attachment') {
        const id = url.searchParams.get('id') || '';
        const cid = (url.searchParams.get('cid') || '').replace(/[<>]/g, '');
        const fileName = url.searchParams.get('file') || '';
        if (!id) {
          sendJson(res, 400, { ok: false, error: 'Missing id' });
          return;
        }

        const message = await getMessageById(id);
        if (!message) {
          sendJson(res, 404, { ok: false, error: 'Message not found' });
          return;
        }

        const attachments = Array.isArray(message.attachments) ? message.attachments : [];
        let attachment = null;
        if (cid) {
          attachment = attachments.find((item) => item.cid && item.cid === cid) || null;
        }
        if (!attachment && fileName) {
          attachment = attachments.find((item) => item.filename === fileName) || null;
        }
        if (!attachment) {
          sendJson(res, 404, { ok: false, error: 'Attachment not found' });
          return;
        }

        const relativePath = normalize(String(attachment.path || ''));
        if (!relativePath || relativePath.startsWith('..')) {
          sendJson(res, 400, { ok: false, error: 'Invalid attachment path' });
          return;
        }

        const absolutePath = join(attachmentsRoot, relativePath);
        const bytes = await readFile(absolutePath);
        res.writeHead(200, {
          'content-type': attachment.contentType || 'application/octet-stream',
          'content-disposition': `${attachment.contentDisposition === 'inline' ? 'inline' : 'attachment'}; filename="${attachment.filename || 'attachment'}"`
        });
        res.end(bytes);
        return;
      }

      if (url.pathname === '/api/mail/render') {
        const id = url.searchParams.get('id') || '';
        if (!id) {
          sendJson(res, 400, { ok: false, error: 'Missing id' });
          return;
        }

        const message = await getMessageById(id);
        if (!message) {
          sendJson(res, 404, { ok: false, error: 'Message not found' });
          return;
        }

        const attachments = Array.isArray(message.attachments) ? message.attachments : [];
        const cidMap = new Map();
        for (const attachment of attachments) {
          if (attachment.cid) {
            const renderedUrl = `${baseUrl}/api/mail/attachment?id=${encodeURIComponent(id)}&cid=${encodeURIComponent(attachment.cid)}`;
            cidMap.set(attachment.cid, renderedUrl);
          }
        }

        let htmlBody = message.bodyHtml || '';
        if (!htmlBody && message.bodyText) {
          const escaped = String(message.bodyText)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
          htmlBody = `<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace">${escaped}</pre>`;
        }

        htmlBody = htmlBody.replace(/src=["']cid:([^"']+)["']/gi, (full, cidValue) => {
          const key = String(cidValue || '').replace(/[<>]/g, '');
          const mapped = cidMap.get(key);
          return mapped ? `src="${mapped}"` : full;
        });

        const attachmentList = attachments
          .filter((item) => item.contentDisposition !== 'inline')
          .map((item) => {
            const href = `${baseUrl}/api/mail/attachment?id=${encodeURIComponent(id)}&file=${encodeURIComponent(item.filename || '')}`;
            return `<li><a href="${href}">${item.filename || 'attachment'}</a> (${item.contentType || 'application/octet-stream'})</li>`;
          })
          .join('');

        const page = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${String(message.subject || '(no subject)').replace(/</g, '&lt;')}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 24px; }
      .meta { color: #444; margin-bottom: 16px; }
      .attachments { margin-top: 24px; }
      img { max-width: 100%; height: auto; }
    </style>
  </head>
  <body>
    <h1>${String(message.subject || '(no subject)').replace(/</g, '&lt;')}</h1>
    <div class="meta">From: ${String(message.from || '').replace(/</g, '&lt;')}<br />To: ${String(message.to || '').replace(/</g, '&lt;')}<br />When: ${String(message.when || '').replace(/</g, '&lt;')}</div>
    <div>${htmlBody || '<em>No body</em>'}</div>
    ${attachmentList ? `<div class="attachments"><h2>Attachments</h2><ul>${attachmentList}</ul></div>` : ''}
  </body>
</html>`;

        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page);
        return;
      }

      if (url.pathname === '/api/mail/sync') {
        const rawLimit = Number(url.searchParams.get('limit') || process.env.IMAP_SYNC_LIMIT || '200');
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 2000) : 200;
        const synced = await syncInbox({ limit });
        await upsertMessages(synced);
        const summary = await getStoreSummary();
        sendJson(res, 200, {
          ok: true,
          synced: synced.length,
          summary
        });
        return;
      }

      if (url.pathname === '/api/mail/send') {
        const to = url.searchParams.get('to') || '';
        const subject = url.searchParams.get('subject') || '(no subject)';
        const text = url.searchParams.get('text') || '';
        const info = await sendSmtpMail({ to, subject, text });

        await addSentMessage({
          id: `sent-${Date.now()}`,
          from: process.env.SMTP_FROM || process.env.SMTP_USER || 'you',
          to,
          subject,
          preview: text.slice(0, 220),
          when: new Date().toLocaleString(),
          unread: false,
          starred: false,
          date: new Date().toISOString()
        });

        sendJson(res, 200, { ok: true, info });
        return;
      }

      if (url.pathname === '/api/mail/update') {
        const id = url.searchParams.get('id') || '';
        if (!id) {
          sendJson(res, 400, { ok: false, error: 'Missing id' });
          return;
        }
        const patch = {};
        if (url.searchParams.has('unread')) {
          patch.unread = url.searchParams.get('unread') === 'true';
        }
        if (url.searchParams.has('starred')) {
          patch.starred = url.searchParams.get('starred') === 'true';
        }
        if (url.searchParams.has('folder')) {
          patch.folder = url.searchParams.get('folder');
        }

        await updateMessage(id, patch);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === '/api/mail/delete') {
        const id = url.searchParams.get('id') || '';
        if (!id) {
          sendJson(res, 400, { ok: false, error: 'Missing id' });
          return;
        }
        const result = await deleteMessage(id);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (url.pathname === '/api/smtp/status') {
        const smtp = await verifySmtp();
        sendJson(res, 200, { ok: true, smtp });
        return;
      }

      if (url.pathname === '/api/smtp/send-test') {
        const to = url.searchParams.get('to') || undefined;
        const info = await sendSmtpTestMail({
          to,
          subject: 'hello-tui SMTP test',
          text: `SMTP test sent from hello-tui at ${new Date().toISOString()}.`
        });
        sendJson(res, 200, { ok: true, info });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    })
  };
}