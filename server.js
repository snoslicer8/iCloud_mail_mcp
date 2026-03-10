'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const express = require('express');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const { z } = require('zod');

// ── Config ────────────────────────────────────────────────────────────────────
const IMAP_HOST = 'imap.mail.me.com';
const IMAP_PORT = 993;
const SMTP_HOST = 'smtp.mail.me.com';
const SMTP_PORT = 587;
const DEFAULT_MAILBOX = 'INBOX';
const PAGE_SIZE = 20;
const MAX_PAGE = 100;
const CHAR_LIMIT = 50000;

// ── IMAP helpers ──────────────────────────────────────────────────────────────
function imapConfig() {
  const user = process.env.ICLOUD_EMAIL;
  const pass = process.env.ICLOUD_APP_PASSWORD;
  if (!user || !pass) throw new Error('ICLOUD_EMAIL and ICLOUD_APP_PASSWORD must be set');
  return { host: IMAP_HOST, port: IMAP_PORT, auth: { user, pass }, secure: true, logger: false };
}

async function withClient(fn) {
  const client = new ImapFlow(imapConfig());
  await client.connect();
  try { return await fn(client); } finally { await client.logout(); }
}

function addrList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(a => a && a.address).map(a => ({ name: a.name || undefined, address: a.address }));
}

function addr(raw) {
  if (Array.isArray(raw) && raw.length > 0) return { name: raw[0].name || undefined, address: raw[0].address || '' };
  return { address: '' };
}

function hasAttach(bs) {
  if (!bs) return false;
  if (bs.disposition === 'attachment') return true;
  if (Array.isArray(bs.childNodes)) return bs.childNodes.some(hasAttach);
  return false;
}

function buildMsg(msg, mailbox) {
  const env = msg.envelope || {};
  
  // Extract text from bodyParts Map if it exists
  let body = '';
  if (msg.bodyParts && msg.bodyParts.has('text')) {
    body = msg.bodyParts.get('text').toString();
  }

  return {
    uid: msg.uid || 0,
    messageId: env.messageId || '',
    subject: env.subject || '(no subject)',
    from: addr(env.from),
    to: addrList(env.to),
    cc: addrList(env.cc),
    date: env.date instanceof Date ? env.date.toISOString() : new Date().toISOString(),
    snippet: body.replace(/\s+/g, ' ').trim().slice(0, 200),
    body: body || undefined,
    flags: Array.isArray(msg.flags) ? [...msg.flags] : [],
    mailbox,
    hasAttachments: hasAttach(msg.bodyStructure),
  };
}

function truncate(s) {
  return s.length <= CHAR_LIMIT ? s : s.slice(0, CHAR_LIMIT) + '\n\n[...truncated]';
}

function fmtAddr(a) {
  return a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '';
}

function fmtMsg(msg, full = false) {
  const lines = [
    `UID: ${msg.uid}`,
    `Subject: ${msg.subject}`,
    `From: ${fmtAddr(msg.from)}`,
    `To: ${(msg.to || []).map(fmtAddr).join(', ')}`,
    ...(msg.cc && msg.cc.length ? [`CC: ${msg.cc.map(fmtAddr).join(', ')}`] : []),
    `Date: ${msg.date}`,
    `Flags: ${(msg.flags || []).join(', ') || 'none'}`,
    `Attachments: ${msg.hasAttachments}`,
  ];
  if (full && msg.body) lines.push('', '--- Body ---', msg.body);
  else if (msg.snippet) lines.push(`Snippet: ${msg.snippet}`);
  return lines.join('\n');
}

function ok(str) { return { content: [{ type: 'text', text: str }] }; }

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new McpServer({ name: 'icloud-mail-mcp-server', version: '1.0.0' });

server.registerTool('icloud_list_mailboxes', {
  title: 'List iCloud Mailboxes',
  description: 'List all folders in the iCloud Mail account.',
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  const result = await withClient(async c => {
    const list = [];
    for await (const mb of c.list()) list.push(mb.path);
    return list;
  });
  return ok(result.join('\n') || 'No mailboxes found');
});

server.registerTool('icloud_mailbox_status', {
  title: 'Get Mailbox Status',
  description: 'Get message counts (total, unread, recent) for a mailbox.',
  inputSchema: z.object({ mailbox: z.string().default(DEFAULT_MAILBOX) }).strict(),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ mailbox }) => {
  const s = await withClient(c => c.status(mailbox, { messages: true, unseen: true, recent: true }));
  return ok(`Mailbox: ${mailbox}\nTotal: ${s.messages || 0}\nUnread: ${s.unseen || 0}\nRecent: ${s.recent || 0}`);
});

server.registerTool('icloud_list_messages', {
  title: 'List Recent iCloud Messages',
  description: 'Fetch recent messages from a mailbox, newest first.',
  inputSchema: z.object({
    mailbox: z.string().default(DEFAULT_MAILBOX),
    limit: z.number().int().min(1).max(MAX_PAGE).default(PAGE_SIZE),
    unread_only: z.boolean().default(false),
  }).strict(),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ mailbox, limit, unread_only }) => {
  const result = await withClient(async c => {
    await c.mailboxOpen(mailbox);
    const uids = await c.search(unread_only ? { unseen: true } : { all: true }, { uid: true });
    const pageUids = [...uids].sort((a, b) => b - a).slice(0, limit);
    if (!pageUids.length) return { messages: [], total: uids.length };
    const messages = [];
    for await (const msg of c.fetch(pageUids, { uid: true, envelope: true, flags: true, bodyStructure: true, bodyParts: ['text'] }, { uid: true })) {
      messages.push(buildMsg(msg, mailbox));
    }
    return { messages, total: uids.length };
  });
  if (!result.messages.length) return ok('No messages found.');
  const header = `${result.total} total | showing ${result.messages.length}`;
  return ok(truncate(`${header}\n\n${result.messages.map(m => fmtMsg(m)).join('\n\n---\n\n')}`));
});

server.registerTool('icloud_search_messages', {
  title: 'Search iCloud Messages',
  description: 'Search messages by subject, body, or sender.',
  inputSchema: z.object({
    query: z.string().min(1),
    mailbox: z.string().default(DEFAULT_MAILBOX),
    limit: z.number().int().min(1).max(MAX_PAGE).default(PAGE_SIZE),
    offset: z.number().int().min(0).default(0),
  }).strict(),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ query, mailbox, limit, offset }) => {
  const result = await withClient(async c => {
    await c.mailboxOpen(mailbox);
    const uids = await c.search({ or: [{ subject: query }, { body: query }, { from: query }] }, { uid: true });
    const pageUids = [...uids].sort((a, b) => b - a).slice(offset, offset + limit);
    if (!pageUids.length) return { messages: [], total: uids.length };
    const messages = [];
    for await (const msg of c.fetch(pageUids, { uid: true, envelope: true, flags: true, bodyStructure: true, bodyParts: ['text'] }, { uid: true })) {
      messages.push(buildMsg(msg, mailbox));
    }
    return { messages, total: uids.length, hasMore: uids.length > offset + limit };
  });
  if (!result.messages.length) return ok(`No messages found matching "${query}"`);
  const header = `${result.total} matches | showing ${result.messages.length}${result.hasMore ? ' | more available' : ''}`;
  return ok(truncate(`${header}\n\n${result.messages.map(m => fmtMsg(m)).join('\n\n---\n\n')}`));
});

server.registerTool('icloud_get_message', {
  title: 'Get Full iCloud Message',
  description: 'Fetch the complete content of a message by UID, including full body.',
  inputSchema: z.object({
    uid: z.number().int().positive(),
    mailbox: z.string().default(DEFAULT_MAILBOX),
  }).strict(),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ uid, mailbox }) => {
  const msg = await withClient(async c => {
    await c.mailboxOpen(mailbox);
    let found = null;
    for await (const m of c.fetch([uid], { uid: true, envelope: true, flags: true, bodyStructure: true, bodyParts: ['text'] }, { uid: true })) {
      found = buildMsg(m, mailbox); break;
    }
    return found;
  });
  if (!msg) return ok(`Message UID ${uid} not found in ${mailbox}`);
  return ok(truncate(fmtMsg(msg, true)));
});

server.registerTool('icloud_send_mail', {
  title: 'Send Email via iCloud',
  description: 'Send an email from the iCloud Mail account.',
  inputSchema: z.object({
    to: z.union([z.string().email(), z.array(z.string().email())]),
    subject: z.string().min(1),
    body: z.string().min(1),
    html: z.string().optional(),
    cc: z.union([z.string().email(), z.array(z.string().email())]).optional(),
    bcc: z.union([z.string().email(), z.array(z.string().email())]).optional(),
    reply_to: z.string().email().optional(),
    in_reply_to: z.string().optional(),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ to, subject, body, html, cc, bcc, reply_to, in_reply_to }) => {
  const user = process.env.ICLOUD_EMAIL;
  const pass = process.env.ICLOUD_APP_PASSWORD;
  const transporter = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: false, requireTLS: true, auth: { user, pass } });
  const join = v => Array.isArray(v) ? v.join(', ') : v;
  const result = await transporter.sendMail({ from: "brady@landgrenclan.com", to: join(to), cc: cc ? join(cc) : undefined, bcc: bcc ? join(bcc) : undefined, subject, text: body, html, replyTo: reply_to, inReplyTo: in_reply_to });
  return ok(`Email sent.\nMessage-ID: ${result.messageId || 'sent'}`);
});

server.registerTool('icloud_move_message', {
  title: 'Move iCloud Message',
  description: 'Move a message from one mailbox to another.',
  inputSchema: z.object({
    uid: z.number().int().positive(),
    from_mailbox: z.string(),
    to_mailbox: z.string(),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ uid, from_mailbox, to_mailbox }) => {
  await withClient(async c => { await c.mailboxOpen(from_mailbox); await c.messageMove([uid], to_mailbox, { uid: true }); });
  return ok(`Message UID ${uid} moved from ${from_mailbox} to ${to_mailbox}`);
});

server.registerTool('icloud_delete_message', {
  title: 'Delete iCloud Message',
  description: 'Move a message to Trash.',
  inputSchema: z.object({
    uid: z.number().int().positive(),
    mailbox: z.string().default(DEFAULT_MAILBOX),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, async ({ uid, mailbox }) => {
  await withClient(async c => { await c.mailboxOpen(mailbox); await c.messageDelete([uid], { uid: true }); });
  return ok(`Message UID ${uid} deleted from ${mailbox}`);
});

server.registerTool('icloud_mark_message', {
  title: 'Mark iCloud Message',
  description: 'Set read/unread or flagged/unflagged status on a message.',
  inputSchema: z.object({
    uid: z.number().int().positive(),
    mailbox: z.string().default(DEFAULT_MAILBOX),
    flag: z.enum(['read', 'unread', 'flagged', 'unflagged']),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ uid, mailbox, flag }) => {
  await withClient(async c => {
    await c.mailboxOpen(mailbox);
    if (flag === 'read') await c.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
    else if (flag === 'unread') await c.messageFlagsRemove([uid], ['\\Seen'], { uid: true });
    else if (flag === 'flagged') await c.messageFlagsAdd([uid], ['\\Flagged'], { uid: true });
    else await c.messageFlagsRemove([uid], ['\\Flagged'], { uid: true });
  });
  return ok(`Message UID ${uid} marked as ${flag}`);
});

// ── HTTP Server ───────────────────────────────────────────────────────────────
function requireToken(req, res, next) {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) { res.status(500).json({ error: 'MCP_AUTH_TOKEN not set' }); return; }
  const auth = req.headers['authorization'] || '';
  if (auth.slice(7) !== expected) { res.status(401).json({ error: 'Unauthorized' }); return; }
  next();
}

const app = express();
app.use(express.json());

app.use((req, _res, next) => {
  console.log(`${req.method} ${req.path}`, JSON.stringify(req.headers));
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok', server: 'icloud-mail-mcp-server' }));

app.post('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const port = parseInt(process.env.PORT || '3456');

// OAuth discovery endpoints — required by Claude.ai even for authless servers
app.get('/.well-known/oauth-authorization-server', (_req, res) => {
  const base = 'https://landgren-nas.tail8ad7c0.ts.net:10000';
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
  });
});

app.post('/oauth/register', (_req, res) => {
  res.status(201).json({
    client_id: 'claude-' + Math.random().toString(36).slice(2),
    client_secret_expires_at: 0,
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  });
});

app.get('/oauth/authorize', (req, res) => {
  const { redirect_uri, state } = req.query;
  res.redirect(`${redirect_uri}?code=ok&state=${state}`);
});

app.post('/oauth/token', (_req, res) => {
  res.json({
    access_token: 'open-' + Math.random().toString(36).slice(2),
    token_type: 'Bearer',
    expires_in: 86400,
  });
});

app.listen(port, () => console.log(`icloud-mail-mcp running on :${port}`));
