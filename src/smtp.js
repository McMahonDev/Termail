import nodemailer from 'nodemailer';
import { isSmtpConfigured } from './config.js';

function createTransport(account) {
  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: {
      user: account.smtp.user,
      pass: account.smtp.pass
    }
  });
}

export async function verifySmtp(account) {
  if (!account) {
    return { configured: false, connected: false, from: null, error: 'No account selected' };
  }
  if (!isSmtpConfigured(account)) {
    return {
      configured: false,
      connected: false,
      from: account.smtp.from || null,
      error: 'SMTP host, user, password, and from address are required'
    };
  }

  try {
    await createTransport(account).verify();
    return { configured: true, connected: true, from: account.smtp.from, error: '' };
  } catch (error) {
    return {
      configured: true,
      connected: false,
      from: account.smtp.from,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function sendSmtpMail(account, { to, subject, text }) {
  if (!account || !isSmtpConfigured(account)) {
    throw new Error('SMTP is not configured for this account.');
  }
  if (!to) {
    throw new Error('Recipient is required.');
  }

  const info = await createTransport(account).sendMail({
    from: account.smtp.from,
    to,
    subject: subject || '(no subject)',
    text: text || ''
  });

  return {
    accepted: info.accepted,
    rejected: info.rejected,
    messageId: info.messageId,
    response: info.response,
    to
  };
}

export async function sendSmtpTestMail(account, { to } = {}) {
  const recipient = to || account?.smtp?.from;
  if (!recipient) {
    throw new Error('No recipient set for the test message.');
  }

  return sendSmtpMail(account, {
    to: recipient,
    subject: 'TerMail SMTP test',
    text: `SMTP test sent from TerMail at ${new Date().toISOString()}.`
  });
}
