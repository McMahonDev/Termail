import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { accountAttachmentsDir } from './paths.js';

export function normalizeAddresses(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return '';
  }
  return list
    .map((entry) => entry.name || entry.address || '')
    .filter(Boolean)
    .join(', ');
}

/** Message ids become directory names, so strip anything a path can't hold. */
export function safePart(value, fallback = 'part') {
  const cleaned = String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

export async function persistAttachments(accountId, messageId, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  const root = accountAttachmentsDir(accountId);
  const messageDir = safePart(messageId, 'message');
  const saved = [];

  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const filename = safePart(attachment.filename || `attachment-${index + 1}`);
    const relativePath = join(messageDir, `${index + 1}-${filename}`);
    const absolutePath = join(root, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, attachment.content);

    saved.push({
      filename: attachment.filename || `attachment-${index + 1}`,
      contentType: attachment.contentType || 'application/octet-stream',
      contentDisposition: attachment.contentDisposition || 'attachment',
      size: Number(attachment.size || 0),
      cid: String(attachment.contentId || '').replace(/[<>]/g, ''),
      path: relativePath
    });
  }

  return saved;
}

/** Shared shape for a synced message, whatever protocol fetched it. */
export function buildMessage({ id, parsed, envelope = {}, when, date, unread, starred, attachments, source }) {
  const text = (parsed.text || parsed.html || '').replace(/\s+/g, ' ').trim();

  return {
    id,
    folder: 'inbox',
    from: envelope.from || normalizeAddresses(parsed.from?.value || []),
    to: envelope.to || normalizeAddresses(parsed.to?.value || []),
    subject: envelope.subject || parsed.subject || '(no subject)',
    preview: text.slice(0, 220),
    bodyText: parsed.text || '',
    bodyHtml: typeof parsed.html === 'string' ? parsed.html : '',
    attachments,
    when,
    unread,
    starred,
    date,
    source
  };
}
