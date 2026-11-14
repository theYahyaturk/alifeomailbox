import PostalMime from 'postal-mime';
import type { ForwardableEmailMessage, ExecutionContext } from '@cloudflare/workers-types';
import type { Env } from './types';

export async function handleIncomingEmail(
  message: ForwardableEmailMessage,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  const emailId = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    // 1. Read raw RFC822 email buffer
    const rawBuffer = await new Response(message.raw).arrayBuffer();

    // 2. Backup raw .eml in Cloudflare R2
    const rawEmlKey = `raw/${emailId}.eml`;
    await env.ATTACHMENTS_BUCKET.put(rawEmlKey, rawBuffer, {
      httpMetadata: { contentType: 'message/rfc822' },
      customMetadata: {
        from: message.from,
        to: message.to,
        timestamp: now
      }
    });

    // 3. Parse MIME with postal-mime
    const parser = new PostalMime();
    const parsed = await parser.parse(rawBuffer);

    const senderEmail = parsed.from?.address || message.from;
    const senderName = parsed.from?.name || null;
    const recipientEmail = message.to || (parsed.to && parsed.to[0]?.address) || 'yahya@alifeo.com';

    const cc = parsed.cc ? parsed.cc.map(c => c.address).filter(Boolean).join(', ') : null;
    const bcc = parsed.bcc ? parsed.bcc.map(b => b.address).filter(Boolean).join(', ') : null;
    const replyTo = parsed.replyTo ? parsed.replyTo.map(r => r.address).filter(Boolean).join(', ') : null;

    const subject = parsed.subject || '(No Subject)';
    const textBody = parsed.text || '';
    const htmlBody = parsed.html || (textBody ? `<pre style="font-family: inherit; white-space: pre-wrap;">${escapeHtml(textBody)}</pre>` : '');
    
    // Snippet preview (first ~160 chars)
    const rawSnippet = (textBody || extractTextFromHtml(htmlBody) || '').replace(/\s+/g, ' ').trim();
    const snippet = rawSnippet.slice(0, 160);

    const hasAttachments = parsed.attachments && parsed.attachments.length > 0 ? 1 : 0;
    const threadId = parsed.messageId || emailId;

    // 4. Process and store attachments in R2 and D1
    if (parsed.attachments && parsed.attachments.length > 0) {
      for (const att of parsed.attachments) {
        const attachmentId = crypto.randomUUID();
        const safeFilename = (att.filename || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_');
        const r2Key = `attachments/${emailId}/${attachmentId}_${safeFilename}`;
        const contentType = att.mimeType || 'application/octet-stream';
        let size = 0;
        if (typeof att.content === 'string') {
          size = new TextEncoder().encode(att.content).length;
        } else if (att.content instanceof Uint8Array) {
          size = att.content.byteLength;
        } else if (att.content && 'byteLength' in att.content) {
          size = (att.content as ArrayBuffer).byteLength;
        }

        // Store attachment binary in R2
        await env.ATTACHMENTS_BUCKET.put(r2Key, att.content, {
          httpMetadata: { contentType }
        });

        // Insert into attachments table
        await env.DB.prepare(`
          INSERT INTO attachments (id, email_id, filename, content_type, size, r2_key, content_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          attachmentId,
          emailId,
          att.filename || 'attachment',
          contentType,
          size,
          r2Key,
          att.contentId || null,
          now
        ).run();
      }
    }

    // 5. Ensure recipient alias exists for user filtering
    const matchingUser = await env.DB.prepare('SELECT id FROM users WHERE email = ? LIMIT 1').bind(recipientEmail.toLowerCase()).first<{ id: string }>();
    const targetUser = matchingUser || await env.DB.prepare('SELECT id FROM users WHERE role = "admin" LIMIT 1').first<{ id: string }>();
    if (targetUser) {
      const aliasExists = await env.DB.prepare('SELECT id FROM aliases WHERE address = ?').bind(recipientEmail.toLowerCase()).first();
      if (!aliasExists) {
        const aliasId = `alias_${crypto.randomUUID().slice(0, 8)}`;
        const localPart = recipientEmail.split('@')[0];
        const displayName = localPart.charAt(0).toUpperCase() + localPart.slice(1);
        await env.DB.prepare(`
          INSERT INTO aliases (id, user_id, address, display_name, is_default, created_at)
          VALUES (?, ?, ?, ?, 0, ?)
        `).bind(aliasId, targetUser.id, recipientEmail.toLowerCase(), displayName, now).run();
      }
    }

    // 6. Save email into D1 emails table
    await env.DB.prepare(`
      INSERT INTO emails (
        id, message_id, thread_id, direction, folder,
        sender, sender_name, recipient, cc, bcc, reply_to,
        subject, snippet, text_body, html_body, raw_eml_key,
        is_read, is_starred, has_attachments, created_at
      ) VALUES (?, ?, ?, 'inbound', 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
    `).bind(
      emailId,
      parsed.messageId || null,
      threadId,
      senderEmail,
      senderName,
      recipientEmail.toLowerCase(),
      cc,
      bcc,
      replyTo,
      subject,
      snippet,
      textBody,
      htmlBody,
      rawEmlKey,
      hasAttachments,
      now
    ).run();

  } catch (error: any) {
    console.error(`[Email Handler Error for ID ${emailId}]:`, error);
    // Don't re-throw unless critical so Cloudflare does not bounce transiently if DB succeeded partially
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function extractTextFromHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .trim();
}
