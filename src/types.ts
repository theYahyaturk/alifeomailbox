import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

export interface Env {
  DB: D1Database;
  ATTACHMENTS_BUCKET: R2Bucket;
  RESEND_API_KEY: string;
  JWT_SECRET: string;
  ADMIN_PASSWORD?: string;
  DOMAIN?: string;
  APP_URL?: string;
  DEFAULT_FROM_NAME?: string;
}

export interface User {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  name: string | null;
  role: 'admin' | 'user';
  avatar?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Alias {
  id: string;
  user_id: string;
  address: string;
  display_name: string | null;
  is_default: number;
  created_at: string;
}

export interface EmailRecord {
  id: string;
  message_id: string | null;
  thread_id: string | null;
  direction: 'inbound' | 'outbound';
  folder: 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive';
  sender: string;
  sender_name: string | null;
  recipient: string;
  cc: string | null;
  bcc: string | null;
  reply_to: string | null;
  subject: string | null;
  snippet: string | null;
  text_body: string | null;
  html_body: string | null;
  raw_eml_key: string | null;
  is_read: number;
  is_starred: number;
  has_attachments: number;
  created_at: string;
}

export interface AttachmentRecord {
  id: string;
  email_id: string;
  filename: string;
  content_type: string;
  size: number;
  r2_key: string;
  content_id: string | null;
  created_at: string;
}

export interface SendEmailPayload {
  from: string;
  from_name?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  reply_to?: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    content: string; // Base64
    content_type?: string;
  }>;
}

export interface JWTPayload {
  sub: string;
  email: string;
  role: string;
  exp: number;
  iat: number;
}

