import nodemailer from 'nodemailer';

function parsePort(raw) {
  const port = Number(raw);
  if (!Number.isFinite(port) || port <= 0) {
    return 587;
  }
  return port;
}

export function getSmtpConfig() {
  const host = process.env.SMTP_HOST || '';
  const port = parsePort(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;
  const from = process.env.SMTP_FROM || user || '';
  const testTo = process.env.SMTP_TEST_TO || from || '';

  const configured = Boolean(host && user && pass && from);

  return {
    configured,
    host,
    port,
    user,
    pass,
    secure,
    from,
    testTo
  };
}

function createTransport(config) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass
    }
  });
}

export async function verifySmtp() {
  const config = getSmtpConfig();
  if (!config.configured) {
    return {
      configured: false,
      connected: false,
      from: config.from || null,
      testTo: config.testTo || null,
      error: 'Missing SMTP_HOST / SMTP_USER / SMTP_PASS / SMTP_FROM'
    };
  }

  const transport = createTransport(config);
  try {
    await transport.verify();
    return {
      configured: true,
      connected: true,
      from: config.from,
      testTo: config.testTo,
      error: ''
    };
  } catch (error) {
    return {
      configured: true,
      connected: false,
      from: config.from,
      testTo: config.testTo,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function sendSmtpTestMail({ subject, text, to }) {
  const config = getSmtpConfig();
  if (!config.configured) {
    throw new Error('SMTP is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM.');
  }

  const recipient = to || config.testTo;
  if (!recipient) {
    throw new Error('No recipient set. Configure SMTP_TEST_TO or pass a to address.');
  }

  const transport = createTransport(config);
  const info = await transport.sendMail({
    from: config.from,
    to: recipient,
    subject,
    text
  });

  return {
    accepted: info.accepted,
    rejected: info.rejected,
    messageId: info.messageId,
    response: info.response,
    to: recipient
  };
}

export async function sendSmtpMail({ to, subject, text }) {
  const config = getSmtpConfig();
  if (!config.configured) {
    throw new Error('SMTP is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM.');
  }
  if (!to) {
    throw new Error('Recipient is required.');
  }

  const transport = createTransport(config);
  const info = await transport.sendMail({
    from: config.from,
    to,
    subject,
    text
  });

  return {
    accepted: info.accepted,
    rejected: info.rejected,
    messageId: info.messageId,
    response: info.response,
    to
  };
}
