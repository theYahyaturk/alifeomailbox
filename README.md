# 📬 Alifeo Mailbox — 100% Free Self-Hosted Custom Domain Webmail

A lightweight, blazing-fast, Gmail-style self-hosted webmail application built on **Cloudflare Serverless (Workers + D1 + Email Routing)** and **Resend Free API**.

Deploy your own complete custom domain email service (e.g. `mail.yourdomain.com` for `you@yourdomain.com`) with **zero server costs ($0/month)**, **zero third-party branding**, and a **fully responsive mobile PWA UI**.

---

## ✨ Features

- ⚡ **100% Free Tier Forever:** Runs entirely within Cloudflare Workers, Cloudflare D1 (SQLite), Cloudflare Email Routing, and Resend Free Tier ($0/month).
- 🚫 **Zero Third-Party Branding:** Clean, modern webmail UI with no watermarks, footers, or "Sent via..." tags.
- 📱 **Mobile Responsive App UI:** Bottom app navigation bar, slide-out drawer, mobile compose floating action button (FAB), and smooth swipe/view modes.
- 👥 **Multi-User & Multi-Mailbox:** Admin can create isolated accounts for team members (e.g., `khalid@yourdomain.com`, `support@yourdomain.com`) with custom passwords and separate inboxes.
- 📥 **Inbound Email Processing:** Built-in Cloudflare Email Worker powered by `postal-mime` to capture incoming emails, parse MIME parts, and store them directly in Cloudflare D1.
- 📤 **Outbound Deliverability:** Integrated with Resend API for high deliverability with DKIM, SPF, and DMARC.
- 🔒 **Zero Server Maintenance:** Pure serverless architecture with global edge distribution (sub-50ms latency worldwide).

---

## 🏗️ Architecture

```
Incoming Mail (*@yourdomain.com)
       │
       ▼
Cloudflare Email Routing (MX)
       │
       ▼
Cloudflare Email Worker (postal-mime)
       │
       ▼
Cloudflare D1 (SQLite Database)
       ▲
       │
Cloudflare Worker (Hono API + Webmail UI at mail.yourdomain.com)
       │
       ▼ Outbound Emails
  Resend API (POST https://api.resend.com/emails)
```

---

## 🚀 Quick Setup Guide (5 Minutes)

### 1. Prerequisites

Before deploying, ensure you have:
1. **Node.js 18+** installed on your machine.
2. A free **Cloudflare Account** with your domain added to Cloudflare DNS.
3. A free **Resend API Key** from [resend.com](https://resend.com).

---

### 2. Clone and Install

```bash
git clone https://github.com/theYahyaturk/alifeomailbox.git
cd alifeomailbox
npm install
```

---

### 3. Create Cloudflare D1 Database

Run the following command to create your free SQLite database on Cloudflare:

```bash
npx wrangler d1 create mail-db
```

Copy the generated `database_id` and initialize the schema:

```bash
npx wrangler d1 execute mail-db --file=./schema.sql
```

---

### 4. Configure Environment (`.env`)

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Fill in your configuration:

```ini
# Cloudflare Credentials
CLOUDFLARE_ACCOUNT_ID="your_cloudflare_account_id"
CLOUDFLARE_API_TOKEN="your_cloudflare_api_token"
CLOUDFLARE_ZONE_ID="your_domain_zone_id"
D1_DATABASE_ID="your_d1_database_uuid"

# Domain Settings
DOMAIN="yourdomain.com"
SUBDOMAIN="mail.yourdomain.com"
WORKER_NAME="my-webmail"

# Email Delivery & Security
RESEND_API_KEY="re_xxxxxxxxxxxxxxxxx"
JWT_SECRET="generate_a_random_32_character_string"
ADMIN_PASSWORD="ChooseYourAdminPassword123!"
DEFAULT_EMAIL="admin@yourdomain.com"
```

---

### 5. Deploy with One Command

Run the automated orchestrator script:

```bash
node deploy.mjs
```

**This script automatically:**
1. Bundles the frontend and backend using Wrangler.
2. Deploys the Worker to Cloudflare Edge.
3. Binds the custom domain `https://mail.yourdomain.com`.
4. Enables Cloudflare Email Routing for your domain.
5. Configures catch-all rule (`*@yourdomain.com` -> Worker).
6. Sets up required DNS records (MX, SPF, DMARC).
7. Sends a test email to verify outbound deliverability.

---

## 📂 Project Structure

```
├── deploy.mjs            # Production deployment orchestrator (REST API)
├── package.json          # Project dependencies & scripts
├── schema.sql            # D1 SQLite database schema (users, emails, aliases)
├── wrangler.toml         # Cloudflare Worker configuration
└── src/
    ├── crypto.ts         # PBKDF2 password hashing & HMAC-SHA256 JWT
    ├── email-handler.ts  # Inbound email parser (postal-mime -> D1)
    ├── index.ts          # Hono backend REST API & route handlers
    ├── logoi-base64.ts   # Embedded app icon & favicon
    ├── resend.ts         # Outbound Resend email client
    ├── types.ts          # TypeScript interfaces & bindings
    └── ui/
        └── html.ts       # Responsive single-page webmail app
```

---

## 👥 Adding Team Mailboxes

1. Sign in to your webmail at `https://mail.yourdomain.com` using your admin credentials.
2. In the left sidebar, click **Team Mailboxes** (visible only to admins).
3. Enter the user's name, email local part (e.g., `khalid`), password, and role (`user`).
4. The team member can now immediately sign in at `https://mail.yourdomain.com` with their isolated inbox.

---

## 🛡️ Security & Privacy

- **Isolated Inboxes:** Regular users only see emails addressed to their specific mailbox.
- **Outbound Restrictions:** Users can only send emails from their verified mailbox address.
- **Cryptographic Hashing:** Passwords hashed with PBKDF2 (100,000 iterations + salt).
- **Stateless Tokens:** HMAC-SHA256 JWT sessions stored securely in HttpOnly cookies and auth headers.

---

## 📜 License

MIT License &copy; 2026 Yahya Turk & Alifeo. Free for personal and commercial use.
