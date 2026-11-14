-- D1 Database Schema for Alifeo Webmail
-- Designed for Cloudflare SQLite (D1)

-- 1. Users table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    name TEXT,
    role TEXT DEFAULT 'admin',
    avatar TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Aliases table (Send & receive addresses under @alifeo.com)
CREATE TABLE IF NOT EXISTS aliases (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    address TEXT UNIQUE NOT NULL,
    display_name TEXT,
    is_default INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 3. Emails table
CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    message_id TEXT,
    thread_id TEXT,
    direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
    folder TEXT NOT NULL DEFAULT 'inbox' CHECK(folder IN ('inbox', 'sent', 'drafts', 'trash', 'spam', 'archive')),
    sender TEXT NOT NULL,
    sender_name TEXT,
    recipient TEXT NOT NULL,
    cc TEXT,
    bcc TEXT,
    reply_to TEXT,
    subject TEXT,
    snippet TEXT,
    text_body TEXT,
    html_body TEXT,
    raw_eml_key TEXT,
    is_read INTEGER DEFAULT 0,
    is_starred INTEGER DEFAULT 0,
    has_attachments INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4. Attachments table
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    r2_key TEXT NOT NULL,
    content_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for lightning-fast queries
CREATE INDEX IF NOT EXISTS idx_emails_folder_created ON emails(folder, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_recipient ON emails(recipient);
CREATE INDEX IF NOT EXISTS idx_emails_sender ON emails(sender);
CREATE INDEX IF NOT EXISTS idx_emails_thread_id ON emails(thread_id);
CREATE INDEX IF NOT EXISTS idx_emails_is_read ON emails(is_read);
CREATE INDEX IF NOT EXISTS idx_emails_is_starred ON emails(is_starred);
CREATE INDEX IF NOT EXISTS idx_attachments_email_id ON attachments(email_id);
CREATE INDEX IF NOT EXISTS idx_aliases_user_id ON aliases(user_id);
CREATE INDEX IF NOT EXISTS idx_aliases_address ON aliases(address);

-- Initial seed data for admin user and default aliases
-- Password hash will be properly set via deploy script or /api/auth/setup
INSERT OR IGNORE INTO users (id, email, password_hash, password_salt, name, role)
VALUES (
    'usr_admin_yahya',
    'yahya@alifeo.com',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', -- will be updated on first run/deploy
    'initial_seed_salt',
    'Yahya',
    'admin'
);

INSERT OR IGNORE INTO aliases (id, user_id, address, display_name, is_default)
VALUES 
    ('alias_yahya', 'usr_admin_yahya', 'yahya@alifeo.com', 'Yahya', 1),
    ('alias_support', 'usr_admin_yahya', 'support@alifeo.com', 'Alifeo Support', 0),
    ('alias_contact', 'usr_admin_yahya', 'contact@alifeo.com', 'Alifeo Contact', 0),
    ('alias_admin', 'usr_admin_yahya', 'admin@alifeo.com', 'Alifeo Admin', 0);

