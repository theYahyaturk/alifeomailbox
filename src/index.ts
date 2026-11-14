import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { ExecutionContext, ForwardableEmailMessage } from '@cloudflare/workers-types';
import type { Env, JWTPayload, SendEmailPayload } from './types';
import { hashPassword, verifyPassword, signJWT, verifyJWT } from './crypto';
import { handleIncomingEmail } from './email-handler';
import { sendEmailViaResend } from './resend';
import { renderLoginPage, renderWebmailApp } from './ui/html';
import { LOGOI_BASE64 } from './logoi-base64';

const app = new Hono<{ Bindings: Env; Variables: { user: JWTPayload } }>();

// Auth Helper
async function authenticateRequest(c: any): Promise<JWTPayload | null> {
  const secret = c.env.JWT_SECRET || 'alifeo-mail-secure-jwt-secret-key-32chars';
  const cookieToken = getCookie(c, 'session_token');
  const authHeader = c.req.header('Authorization');
  const token = cookieToken || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);

  if (!token) return null;
  return await verifyJWT(token, secret);
}

// -------------------------------------------------------------
// UI & Asset Routes
// -------------------------------------------------------------
function serveLogoiPng() {
  const binaryString = atob(LOGOI_BASE64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const contentType = isJpeg ? 'image/jpeg' : 'image/png';
  return new Response(bytes.buffer, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400, immutable'
    }
  });
}

app.get('/logoi.png', () => serveLogoiPng());
app.get('/logoi.jpg', () => serveLogoiPng());
app.get('/favicon.ico', () => serveLogoiPng());
app.get('/apple-touch-icon.png', () => serveLogoiPng());
app.get('/apple-touch-icon-precomposed.png', () => serveLogoiPng());

app.get('/manifest.json', (c) => {
  return c.json({
    name: 'Alifeo Mail',
    short_name: 'Alifeo Mail',
    description: 'Custom domain webmail for Alifeo',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#084328',
    icons: [
      {
        src: '/logoi.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable'
      }
    ]
  });
});

app.get('/login', (c) => {
  return c.html(renderLoginPage());
});

app.get('/', async (c) => {
  const user = await authenticateRequest(c);
  if (!user) {
    return c.redirect('/login');
  }
  return c.html(renderWebmailApp());
});

// -------------------------------------------------------------
// Authentication Endpoints
// -------------------------------------------------------------
app.post('/api/auth/login', async (c) => {
  try {
    const { email, password } = await c.req.json<{ email?: string; password?: string }>();
    if (!email || !password) {
      return c.json({ success: false, error: 'Email and password required' }, 400);
    }

    const cleanEmail = email.trim().toLowerCase();
    const user = await c.env.DB.prepare(
      'SELECT * FROM users WHERE email = ? LIMIT 1'
    ).bind(cleanEmail).first<any>();

    if (!user) {
      return c.json({ success: false, error: 'User not found' }, 401);
    }

    // Check password
    let passwordMatches = false;

    // Allow bootstrap with ADMIN_PASSWORD env secret if initial seed
    if (c.env.ADMIN_PASSWORD && password === c.env.ADMIN_PASSWORD) {
      passwordMatches = true;
      // Automatically update stored PBKDF2 hash to the active admin password
      const newCredentials = await hashPassword(password);
      await c.env.DB.prepare(
        'UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?'
      ).bind(newCredentials.hash, newCredentials.salt, user.id).run();
    } else {
      passwordMatches = await verifyPassword(password, user.password_hash, user.password_salt);
    }

    if (!passwordMatches) {
      return c.json({ success: false, error: 'Invalid password' }, 401);
    }

    const jwtSecret = c.env.JWT_SECRET || 'alifeo-mail-secure-jwt-secret-key-32chars';
    const token = await signJWT(
      { sub: user.id, email: user.email, role: user.role },
      jwtSecret
    );

    setCookie(c, 'session_token', token, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 7 * 24 * 60 * 60 // 7 days
    });

    return c.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        avatar: user.avatar
      }
    });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

app.post('/api/auth/logout', (c) => {
  deleteCookie(c, 'session_token', { path: '/' });
  return c.json({ success: true });
});

// Middleware for Protected API routes
app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/auth/login')) {
    return next();
  }

  const user = await authenticateRequest(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('user', user);
  return next();
});

app.get('/api/auth/me', async (c) => {
  const jwtUser = c.get('user');
  const user = await c.env.DB.prepare(
    'SELECT id, email, name, role, avatar, created_at FROM users WHERE id = ?'
  ).bind(jwtUser.sub).first<any>();

  let aliases = await c.env.DB.prepare(
    'SELECT id, address, display_name, is_default FROM aliases WHERE user_id = ? ORDER BY is_default DESC, address ASC'
  ).bind(jwtUser.sub).all<any>();

  let aliasList = aliases.results || [];
  // Ensure the primary email address is ALWAYS present in alias list
  const hasUserEmail = aliasList.some(a => a.address.toLowerCase() === user.email.toLowerCase());
  if (!hasUserEmail) {
    aliasList = [
      { id: 'primary_' + user.id, user_id: user.id, address: user.email, display_name: user.name || user.email.split('@')[0], is_default: 1 },
      ...aliasList
    ];
  }

  return c.json({
    user,
    aliases: aliasList
  });
});

app.post('/api/user/avatar', async (c) => {
  const jwtUser = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const avatar = body.avatar; // base64 string or null/empty to remove

  if (avatar && typeof avatar !== 'string') {
    return c.json({ error: 'Invalid avatar data' }, 400);
  }

  // Size limit: max 500KB
  if (avatar && avatar.length > 500000) {
    return c.json({ error: 'Avatar image too large. Max size 500KB.' }, 400);
  }

  await c.env.DB.prepare(
    'UPDATE users SET avatar = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).bind(avatar || null, jwtUser.sub).run();

  return c.json({ success: true, avatar: avatar || null });
});

// -------------------------------------------------------------
// Emails Management Endpoints
// -------------------------------------------------------------
app.get('/api/emails', async (c) => {
  const jwtUser = c.get('user');
  const folder = c.req.query('folder') || 'inbox';
  const alias = c.req.query('alias');
  const search = c.req.query('search')?.trim();
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
  const offset = (page - 1) * limit;

  // Retrieve user's authorized addresses (their email + all user aliases)
  const userAliases = await c.env.DB.prepare(
    'SELECT address FROM aliases WHERE user_id = ?'
  ).bind(jwtUser.sub).all<any>();
  const userAddresses = [jwtUser.email.toLowerCase(), ...(userAliases.results || []).map(a => a.address.toLowerCase())];

  let query = 'SELECT id, message_id, thread_id, direction, folder, sender, sender_name, recipient, cc, subject, snippet, is_read, is_starred, has_attachments, created_at FROM emails WHERE ';
  const params: any[] = [];

  if (folder === 'starred') {
    query += 'is_starred = 1 AND folder != "trash"';
  } else {
    query += 'folder = ?';
    params.push(folder);
  }

  // Mailbox isolation: users only see their own emails
  if (jwtUser.role !== 'admin' || alias || c.req.query('all') !== 'true') {
    if (alias) {
      const cleanAlias = alias.toLowerCase().trim();
      query += ' AND (recipient = ? OR sender = ? OR recipient LIKE ? OR cc LIKE ?)';
      params.push(cleanAlias, cleanAlias, `%${cleanAlias}%`, `%${cleanAlias}%`);
    } else {
      const orClauses = userAddresses.map(() => '(recipient = ? OR sender = ? OR recipient LIKE ? OR cc LIKE ?)');
      query += ` AND (${orClauses.join(' OR ')})`;
      for (const addr of userAddresses) {
        params.push(addr, addr, `%${addr}%`, `%${addr}%`);
      }
    }
  }

  if (search) {
    query += ' AND (subject LIKE ? OR sender LIKE ? OR snippet LIKE ? OR text_body LIKE ?)';
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern, searchPattern, searchPattern);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const emails = await c.env.DB.prepare(query).bind(...params).all<any>();

  // Unread count in Inbox for current user
  let unreadQuery = 'SELECT COUNT(*) as count FROM emails WHERE folder = "inbox" AND is_read = 0';
  const unreadParams: any[] = [];
  if (jwtUser.role !== 'admin' || c.req.query('all') !== 'true') {
    const orClauses = userAddresses.map(() => '(recipient = ? OR recipient LIKE ? OR cc LIKE ?)');
    unreadQuery += ` AND (${orClauses.join(' OR ')})`;
    for (const addr of userAddresses) {
      unreadParams.push(addr, `%${addr}%`, `%${addr}%`);
    }
  }
  const unreadCountRow = await c.env.DB.prepare(unreadQuery).bind(...unreadParams).first<{ count: number }>();

  return c.json({
    emails: emails.results || [],
    unreadCount: unreadCountRow?.count || 0,
    page,
    limit
  });
});

app.get('/api/emails/:id', async (c) => {
  const id = c.req.param('id');
  const email = await c.env.DB.prepare(
    'SELECT * FROM emails WHERE id = ?'
  ).bind(id).first<any>();

  if (!email) {
    return c.json({ error: 'Email not found' }, 404);
  }

  // Mark as read automatically
  if (!email.is_read) {
    await c.env.DB.prepare('UPDATE emails SET is_read = 1 WHERE id = ?').bind(id).run();
    email.is_read = 1;
  }

  const attachments = await c.env.DB.prepare(
    'SELECT id, filename, content_type, size, created_at FROM attachments WHERE email_id = ?'
  ).bind(id).all<any>();

  return c.json({
    email,
    attachments: attachments.results || []
  });
});

// Stream Attachment from R2
app.get('/api/emails/:id/attachments/:attId', async (c) => {
  const { id, attId } = c.req.param();

  const attachment = await c.env.DB.prepare(
    'SELECT * FROM attachments WHERE id = ? AND email_id = ?'
  ).bind(attId, id).first<any>();

  if (!attachment) {
    return c.text('Attachment not found', 404);
  }

  // 1. Deliver directly from D1 database storage if present
  if (attachment.data) {
    const binaryString = atob(attachment.data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const headers = new Headers();
    headers.set('Content-Type', attachment.content_type || 'application/octet-stream');
    headers.set('Content-Disposition', `inline; filename="${attachment.filename}"`);
    return new Response(bytes.buffer, { headers });
  }

  // 2. Fallback to R2 bucket if configured
  if (c.env.ATTACHMENTS_BUCKET && attachment.r2_key) {
    const object = await c.env.ATTACHMENTS_BUCKET.get(attachment.r2_key);
    if (object) {
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('Content-Type', attachment.content_type || 'application/octet-stream');
      headers.set('Content-Disposition', `inline; filename="${attachment.filename}"`);
      headers.set('etag', object.httpEtag);
      return new Response(object.body, { headers });
    }
  }

  return c.text('Attachment storage is not configured', 404);
});

// Stream Raw .EML from R2
app.get('/api/emails/:id/raw', async (c) => {
  const id = c.req.param('id');
  const email = await c.env.DB.prepare(
    'SELECT raw_eml_key, subject FROM emails WHERE id = ?'
  ).bind(id).first<any>();

  if (!email || !email.raw_eml_key) {
    return c.text('Raw email not found', 404);
  }

  if (!c.env.ATTACHMENTS_BUCKET) {
    return c.text('Raw email storage is not configured', 404);
  }

  const object = await c.env.ATTACHMENTS_BUCKET.get(email.raw_eml_key);
  if (!object) {
    return c.text('Raw email file not found in storage', 404);
  }

  const headers = new Headers();
  headers.set('Content-Type', 'message/rfc822');
  headers.set('Content-Disposition', `attachment; filename="${id}.eml"`);

  return new Response(object.body, { headers });
});

// Send Email via Resend
app.post('/api/emails/send', async (c) => {
  const payload = await c.req.json<SendEmailPayload>();

  if (!payload.from || !payload.to || !payload.subject) {
    return c.json({ success: false, error: 'From, To, and Subject are required' }, 400);
  }

  // Validate from address domain
  const configuredDomain = c.env.DOMAIN || 'alifeo.com';
  if (!payload.from.toLowerCase().endsWith(`@${configuredDomain}`)) {
    return c.json({
      success: false,
      error: `Sender address must end with @${configuredDomain}`
    }, 400);
  }

  // Authorize sender: users can only send from their own assigned mailbox
  const jwtUser = c.get('user');
  const userAliases = await c.env.DB.prepare(
    'SELECT address FROM aliases WHERE user_id = ?'
  ).bind(jwtUser.sub).all<any>();
  const allowedAddresses = [jwtUser.email.toLowerCase(), ...(userAliases.results || []).map(a => a.address.toLowerCase())];

  if (!allowedAddresses.includes(payload.from.toLowerCase()) && jwtUser.role !== 'admin') {
    return c.json({
      success: false,
      error: `You are not authorized to send from ${payload.from}. You can only send from your assigned mailbox (${jwtUser.email}).`
    }, 403);
  }

  if (!c.env.RESEND_API_KEY) {
    return c.json({ success: false, error: 'RESEND_API_KEY is not configured' }, 500);
  }

  // Send via Resend API
  const resendResult = await sendEmailViaResend(payload, c.env.RESEND_API_KEY);
  if (!resendResult.success) {
    return c.json({ success: false, error: resendResult.error }, 500);
  }

  const emailId = crypto.randomUUID();
  const now = new Date().toISOString();
  const toStr = Array.isArray(payload.to) ? payload.to.join(', ') : payload.to;
  const ccStr = payload.cc ? (Array.isArray(payload.cc) ? payload.cc.join(', ') : payload.cc) : null;
  const bccStr = payload.bcc ? (Array.isArray(payload.bcc) ? payload.bcc.join(', ') : payload.bcc) : null;
  const snippet = (payload.text || '').replace(/\s+/g, ' ').slice(0, 160);
  const hasAttachments = payload.attachments && payload.attachments.length > 0 ? 1 : 0;

  // 1. FIRST save to emails table in 'sent' folder (Parent record MUST exist before attachments!)
  await c.env.DB.prepare(`
    INSERT INTO emails (
      id, message_id, thread_id, direction, folder,
      sender, sender_name, recipient, cc, bcc, reply_to,
      subject, snippet, text_body, html_body,
      is_read, is_starred, has_attachments, created_at
    ) VALUES (?, ?, ?, 'outbound', 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
  `).bind(
    emailId,
    resendResult.messageId || null,
    resendResult.messageId || emailId,
    payload.from.toLowerCase(),
    payload.from_name || c.env.DEFAULT_FROM_NAME || 'Yahya',
    toStr,
    ccStr,
    bccStr,
    payload.reply_to || null,
    payload.subject,
    snippet,
    payload.text || '',
    payload.html || '',
    hasAttachments,
    now
  ).run();

  // 2. THEN save attachments to R2 & DB if present
  if (payload.attachments && payload.attachments.length > 0) {
    for (const att of payload.attachments) {
      try {
        const attId = crypto.randomUUID();
        const safeFilename = att.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const r2Key = `attachments/${emailId}/${attId}_${safeFilename}`;
        const cleanBase64 = att.content.replace(/^data:[^;]+;base64,/, '').trim();
        
        // Decode Base64 to binary
        const binaryString = atob(cleanBase64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        if (c.env.ATTACHMENTS_BUCKET) {
          try {
            await c.env.ATTACHMENTS_BUCKET.put(r2Key, bytes.buffer, {
              httpMetadata: { contentType: att.content_type || 'application/octet-stream' }
            });
          } catch (r2Err) {
            console.warn('[R2 Warning on send]', r2Err);
          }
        }

        await c.env.DB.prepare(`
          INSERT INTO attachments (id, email_id, filename, content_type, size, r2_key, data, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(attId, emailId, att.filename, att.content_type || 'application/octet-stream', bytes.length, r2Key, cleanBase64, now).run();
      } catch (attErr) {
        console.error('[Error saving outbound attachment]', attErr);
      }
    }
  }

  return c.json({
    success: true,
    messageId: resendResult.messageId,
    emailId
  });
});

// Toggle Starred
app.post('/api/emails/:id/star', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare(`
    UPDATE emails SET is_starred = CASE WHEN is_starred = 1 THEN 0 ELSE 1 END WHERE id = ?
  `).bind(id).run();
  return c.json({ success: true });
});

// Move to Trash or Permanently Delete
app.post('/api/emails/:id/trash', async (c) => {
  const id = c.req.param('id');
  const email = await c.env.DB.prepare('SELECT folder, raw_eml_key FROM emails WHERE id = ?').bind(id).first<any>();

  if (!email) {
    return c.json({ error: 'Email not found' }, 404);
  }

  if (email.folder === 'trash') {
    if (c.env.ATTACHMENTS_BUCKET) {
      const attachments = await c.env.DB.prepare('SELECT r2_key FROM attachments WHERE email_id = ?').bind(id).all<any>();
      if (attachments.results) {
        for (const att of attachments.results) {
          await c.env.ATTACHMENTS_BUCKET.delete(att.r2_key);
        }
      }
      if (email.raw_eml_key) {
        await c.env.ATTACHMENTS_BUCKET.delete(email.raw_eml_key);
      }
    }

    // Delete records from DB
    await c.env.DB.prepare('DELETE FROM emails WHERE id = ?').bind(id).run();
    return c.json({ success: true, deleted: true });
  } else {
    // Move to trash folder
    await c.env.DB.prepare('UPDATE emails SET folder = "trash" WHERE id = ?').bind(id).run();
    return c.json({ success: true, movedToTrash: true });
  }
});

// Aliases Management
app.get('/api/aliases', async (c) => {
  const jwtUser = c.get('user');
  const aliases = await c.env.DB.prepare(
    'SELECT * FROM aliases WHERE user_id = ? ORDER BY is_default DESC, address ASC'
  ).bind(jwtUser.sub).all<any>();
  return c.json({ aliases: aliases.results || [] });
});

app.post('/api/aliases', async (c) => {
  const jwtUser = c.get('user');
  if (jwtUser.role !== 'admin') {
    return c.json({ success: false, error: 'Only administrators can create new addresses or aliases' }, 403);
  }

  const { address, display_name } = await c.req.json<{ address?: string; display_name?: string }>();

  if (!address) {
    return c.json({ success: false, error: 'Address required' }, 400);
  }

  const cleanAddress = address.trim().toLowerCase();
  const configuredDomain = c.env.DOMAIN || 'alifeo.com';
  if (!cleanAddress.endsWith(`@${configuredDomain}`)) {
    return c.json({ success: false, error: `Alias must end with @${configuredDomain}` }, 400);
  }

  const aliasId = `alias_${crypto.randomUUID().slice(0, 8)}`;
  try {
    await c.env.DB.prepare(`
      INSERT INTO aliases (id, user_id, address, display_name, is_default, created_at)
      VALUES (?, ?, ?, ?, 0, datetime('now'))
    `).bind(aliasId, jwtUser.sub, cleanAddress, display_name || null).run();

    return c.json({ success: true, alias: { id: aliasId, address: cleanAddress, display_name } });
  } catch (err: any) {
    return c.json({ success: false, error: 'Alias already exists or invalid' }, 400);
  }
});

// -------------------------------------------------------------
// User / Mailbox Management (Admin Only)
// -------------------------------------------------------------
app.get('/api/users', async (c) => {
  const jwtUser = c.get('user');
  if (jwtUser.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403);
  }

  const users = await c.env.DB.prepare(
    'SELECT id, email, name, role, created_at FROM users ORDER BY created_at ASC'
  ).all<any>();

  return c.json({ users: users.results || [] });
});

app.post('/api/users', async (c) => {
  try {
    const jwtUser = c.get('user');
    if (jwtUser.role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const { email, password, name, role } = await c.req.json<{
      email?: string;
      password?: string;
      name?: string;
      role?: 'admin' | 'user';
    }>();

    if (!email || !password) {
      return c.json({ success: false, error: 'Email and password are required' }, 400);
    }

    const cleanEmail = email.trim().toLowerCase();
    const configuredDomain = c.env.DOMAIN || 'alifeo.com';
    if (!cleanEmail.endsWith(`@${configuredDomain}`)) {
      return c.json({
        success: false,
        error: `Mailbox email must end with @${configuredDomain}`
      }, 400);
    }

    if (password.length < 6) {
      return c.json({ success: false, error: 'Password must be at least 6 characters' }, 400);
    }

    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(cleanEmail).first();
    if (existing) {
      return c.json({ success: false, error: 'A user with this email already exists' }, 400);
    }

    const userId = `usr_${crypto.randomUUID().slice(0, 8)}`;
    const { hash, salt } = await hashPassword(password);
    const now = new Date().toISOString();
    const userRole = role === 'admin' ? 'admin' : 'user';

    // Create user
    await c.env.DB.prepare(`
      INSERT INTO users (id, email, password_hash, password_salt, name, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(userId, cleanEmail, hash, salt, name || null, userRole, now, now).run();

    // Upsert or assign primary alias for this user
    const existingAlias = await c.env.DB.prepare('SELECT id FROM aliases WHERE address = ?').bind(cleanEmail).first();
    if (existingAlias) {
      await c.env.DB.prepare('UPDATE aliases SET user_id = ?, display_name = ?, is_default = 1 WHERE address = ?').bind(userId, name || null, cleanEmail).run();
    } else {
      const aliasId = `alias_${crypto.randomUUID().slice(0, 8)}`;
      await c.env.DB.prepare(`
        INSERT INTO aliases (id, user_id, address, display_name, is_default, created_at)
        VALUES (?, ?, ?, ?, 1, ?)
      `).bind(aliasId, userId, cleanEmail, name || null, now).run();
    }

    return c.json({
      success: true,
      user: {
        id: userId,
        email: cleanEmail,
        name: name || null,
        role: userRole,
        created_at: now
      }
    });
  } catch (err: any) {
    return c.json({ success: false, error: err.message || String(err) }, 500);
  }
});

app.delete('/api/users/:id', async (c) => {
  const jwtUser = c.get('user');
  if (jwtUser.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403);
  }

  const id = c.req.param('id');
  if (id === jwtUser.sub) {
    return c.json({ success: false, error: 'You cannot delete your own admin account' }, 400);
  }

  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

app.post('/api/users/:id/password', async (c) => {
  const jwtUser = c.get('user');
  if (jwtUser.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403);
  }

  const id = c.req.param('id');
  const { password } = await c.req.json<{ password?: string }>();
  if (!password || password.length < 6) {
    return c.json({ success: false, error: 'Password must be at least 6 characters' }, 400);
  }

  const { hash, salt } = await hashPassword(password);
  await c.env.DB.prepare(
    'UPDATE users SET password_hash = ?, password_salt = ?, updated_at = datetime("now") WHERE id = ?'
  ).bind(hash, salt, id).run();

  return c.json({ success: true });
});

// -------------------------------------------------------------
// Cloudflare Worker Unified Export (Fetch + Email Handler)
// -------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    return handleIncomingEmail(message, env, ctx);
  }
};

