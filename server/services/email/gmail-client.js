const { google } = require('googleapis');
const db = require('../../models/db');
const logger = require('../logger');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.labels',
];

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );
}

async function getAuthClient() {
  const oauth2 = getOAuth2Client();
  const state = await db('email_sync_state').first();
  if (!state?.refresh_token) return null;

  oauth2.setCredentials({
    refresh_token: state.refresh_token,
    access_token: state.access_token || undefined,
    expiry_date: state.token_expires_at ? new Date(state.token_expires_at).getTime() : undefined,
  });

  // Refresh if expired
  oauth2.on('tokens', async (tokens) => {
    try {
      const updates = {};
      if (tokens.access_token) updates.access_token = tokens.access_token;
      if (tokens.expiry_date) updates.token_expires_at = new Date(tokens.expiry_date);
      if (tokens.refresh_token) updates.refresh_token = tokens.refresh_token;
      if (Object.keys(updates).length > 0) {
        await db('email_sync_state').where('id', state.id).update(updates);
      }
    } catch (e) {
      logger.warn(`[gmail] Token update failed: ${e.message}`);
    }
  });

  return oauth2;
}

function getAuthUrl(state) {
  const oauth2 = getOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
    login_hint: process.env.GMAIL_USER_EMAIL || 'contact@wavespestcontrol.com',
  });
}

async function handleCallback(code) {
  const oauth2 = getOAuth2Client();
  const { tokens } = await oauth2.getToken(code);

  await db('email_sync_state').where('id', 1).update({
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    token_expires_at: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
  });

  logger.info('[gmail] OAuth tokens stored successfully');
  return tokens;
}

async function getGmail() {
  const auth = await getAuthClient();
  if (!auth) throw new Error('Gmail not connected. Please authorize via OAuth.');
  return google.gmail({ version: 'v1', auth });
}

async function listMessages(query = '', maxResults = 50) {
  const gmail = await getGmail();
  const messages = [];
  let pageToken;

  do {
    const remaining = maxResults ? Math.max(maxResults - messages.length, 0) : 500;
    if (remaining === 0) break;
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: Math.min(remaining, 500),
      pageToken,
    });
    messages.push(...(res.data.messages || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken && (!maxResults || messages.length < maxResults));

  return messages;
}

async function getMessage(messageId) {
  const gmail = await getGmail();
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });
  return parseMessage(res.data);
}

function parseMessage(msg) {
  const headers = msg.payload?.headers || [];
  const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

  const fromRaw = getHeader('From');
  const fromMatch = fromRaw ? fromRaw.match(/^"?([^"<]*)"?\s*<?([^>]*)>?$/) : null;
  const fromName = fromMatch && fromMatch[1] ? fromMatch[1].trim() : '';
  const fromAddress = fromMatch && fromMatch[2] ? fromMatch[2].trim() : (fromRaw || '').trim();

  const listUnsubscribe = getHeader('List-Unsubscribe');

  const body = extractBody(msg.payload);
  const attachments = extractAttachments(msg.payload, msg.id);

  return {
    gmail_id: msg.id,
    gmail_thread_id: msg.threadId,
    from_address: fromAddress,
    from_name: fromName,
    to_address: getHeader('To'),
    subject: getHeader('Subject'),
    body_text: body.text,
    body_html: body.html,
    snippet: msg.snippet || '',
    has_attachments: attachments.length > 0,
    label_ids: msg.labelIds || [],
    received_at: new Date(parseInt(msg.internalDate)),
    is_read: !(msg.labelIds || []).includes('UNREAD'),
    is_starred: (msg.labelIds || []).includes('STARRED'),
    list_unsubscribe: listUnsubscribe || null,
    attachments,
    historyId: msg.historyId,
  };
}

function extractBody(payload) {
  let text = '';
  let html = '';

  if (!payload) return { text, html };

  // Direct body on the payload
  if (payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    if (payload.mimeType === 'text/html') html = decoded;
    else text = decoded;
  }

  // Recurse into parts
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data && !text) {
        text = Buffer.from(part.body.data, 'base64url').toString('utf-8');
      } else if (part.mimeType === 'text/html' && part.body?.data && !html) {
        html = Buffer.from(part.body.data, 'base64url').toString('utf-8');
      } else if (part.mimeType?.startsWith('multipart/') && part.parts) {
        const nested = extractBody(part);
        if (!text && nested.text) text = nested.text;
        if (!html && nested.html) html = nested.html;
      }
    }
  }

  return { text, html };
}

function extractAttachments(payload, messageId) {
  const attachments = [];
  if (!payload?.parts) return attachments;

  for (const part of payload.parts) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        gmail_attachment_id: part.body.attachmentId,
        filename: part.filename,
        mime_type: part.mimeType,
        size_bytes: part.body.size || 0,
      });
    }
    // Recurse into nested multipart
    if (part.parts) {
      attachments.push(...extractAttachments(part, messageId));
    }
  }
  return attachments;
}

async function getAttachment(messageId, attachmentId) {
  const gmail = await getGmail();
  const res = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });
  return Buffer.from(res.data.data, 'base64url');
}

function sanitizeHeaderValue(val) {
  if (val == null) return '';
  // Strip CR/LF to prevent header injection (RFC 5322)
  return String(val).replace(/[\r\n]+/g, ' ').trim();
}

function encodeHeaderUtf8(val) {
  // RFC 2047 encoded-word for non-ASCII subject lines
  const safe = sanitizeHeaderValue(val);
  if (/^[\x20-\x7E]*$/.test(safe)) return safe;
  return `=?UTF-8?B?${Buffer.from(safe, 'utf-8').toString('base64')}?=`;
}

async function sendMessage(to, subject, body, threadId = null, inReplyTo = null) {
  const gmail = await getGmail();
  const fromEmail = sanitizeHeaderValue(process.env.GMAIL_USER_EMAIL || 'contact@wavespestcontrol.com');
  const safeTo = sanitizeHeaderValue(to);
  const safeSubject = encodeHeaderUtf8(subject);
  const safeInReplyTo = sanitizeHeaderValue(inReplyTo);

  if (!safeTo) throw new Error('Recipient (to) is required');

  const headers = [
    `From: Waves Pest Control <${fromEmail}>`,
    `To: ${safeTo}`,
    `Subject: ${safeSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
  ];
  if (safeInReplyTo) {
    headers.push(`In-Reply-To: ${safeInReplyTo}`);
    headers.push(`References: ${safeInReplyTo}`);
  }

  const raw = Buffer.from(headers.join('\r\n') + '\r\n\r\n' + body).toString('base64url');

  const params = { userId: 'me', requestBody: { raw } };
  if (threadId) params.requestBody.threadId = threadId;

  const res = await gmail.users.messages.send(params);
  return res.data;
}

async function modifyLabels(messageId, addLabels = [], removeLabels = []) {
  const gmail = await getGmail();
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds: addLabels, removeLabelIds: removeLabels },
  });
}

async function archiveMessage(messageId) {
  return modifyLabels(messageId, [], ['INBOX']);
}

async function trashMessage(messageId) {
  const gmail = await getGmail();
  await gmail.users.messages.trash({ userId: 'me', id: messageId });
}

async function getHistory(startHistoryId) {
  const gmail = await getGmail();
  const res = await gmail.users.history.list({
    userId: 'me',
    startHistoryId,
    historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'],
  });
  return res.data;
}

async function isConnected() {
  const state = await db('email_sync_state').first();
  return !!(state?.refresh_token);
}

module.exports = {
  getAuthUrl,
  handleCallback,
  getAuthClient,
  getGmail,
  listMessages,
  getMessage,
  getAttachment,
  sendMessage,
  modifyLabels,
  archiveMessage,
  trashMessage,
  getHistory,
  isConnected,
};
