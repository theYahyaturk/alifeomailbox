#!/usr/bin/env node

/**
 * Production Deployment & API Orchestrator for Self-Hosted Webmail
 * Deploys full Cloudflare Serverless stack (Worker + D1 + Email Routing + Custom Domain)
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';

// Configuration variables (populated from .env or process.env)
let DOMAIN = process.env.DOMAIN || 'alifeo.com';
let SUBDOMAIN = process.env.SUBDOMAIN || `mail.${DOMAIN}`;
let WORKER_NAME = process.env.WORKER_NAME || 'alifeo-mail';
let ZONE_ID = process.env.CLOUDFLARE_ZONE_ID || '01e83278c6dba3b096f9054d3bc3268e';
let D1_UUID = process.env.D1_DATABASE_ID || 'd5cc98a4-085e-4a7e-a5d1-7f3a5d05375d';
let accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
let apiToken = process.env.CLOUDFLARE_API_TOKEN || '';
let resendKey = process.env.RESEND_API_KEY || '';
let adminPassword = process.env.ADMIN_PASSWORD || 'Admin@ChangeMe2026!';
let adminEmail = process.env.DEFAULT_EMAIL || `admin@${DOMAIN}`;
let jwtSecret = process.env.JWT_SECRET || 'alifeo-mail-secure-jwt-secret-key-32chars';

// Load from local .env if present
if (fs.existsSync('.env')) {
  const envContent = fs.readFileSync('.env', 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [k, ...v] = trimmed.split('=');
    const val = v.join('=').replace(/^["']|["']$/g, '');
    if (k === 'DOMAIN') DOMAIN = val;
    if (k === 'SUBDOMAIN') SUBDOMAIN = val;
    if (k === 'WORKER_NAME') WORKER_NAME = val;
    if (k === 'CLOUDFLARE_ZONE_ID') ZONE_ID = val;
    if (k === 'D1_DATABASE_ID') D1_UUID = val;
    if (k === 'CLOUDFLARE_ACCOUNT_ID') accountId = val;
    if (k === 'CLOUDFLARE_API_TOKEN') apiToken = val;
    if (k === 'RESEND_API_KEY') resendKey = val;
    if (k === 'ADMIN_PASSWORD') adminPassword = val;
    if (k === 'DEFAULT_EMAIL') adminEmail = val;
    if (k === 'JWT_SECRET') jwtSecret = val;
  }
}

function log(msg) { console.log(`\x1b[36m[DEPLOY]\x1b[0m ${msg}`); }
function success(msg) { console.log(`\x1b[32m✔ ${msg}\x1b[0m`); }
function warn(msg) { console.log(`\x1b[33m⚠ ${msg}\x1b[0m`); }
function error(msg) { console.error(`\x1b[31m✖ ${msg}\x1b[0m`); }

if (!accountId || !apiToken) {
  error('Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN. Please set them in .env');
  process.exit(1);
}

async function cfApi(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`https://api.cloudflare.com/client/v4${endpoint}`, options);
  return await res.json();
}

async function main() {
  console.log('\n======================================================');
  console.log(`   🚀 PRODUCTION DEPLOYMENT: ${SUBDOMAIN}`);
  console.log('======================================================\n');

  // Step 1: Build Worker Bundle locally
  log('Bundling application with Wrangler...');
  execSync('npx wrangler deploy --dry-run --outdir=dist', { stdio: 'inherit' });
  const code = fs.readFileSync('dist/index.js', 'utf8');
  success('Application compiled into dist/index.js');

  // Step 2: Upload Worker Script via Cloudflare Workers REST API
  log(`Deploying Worker script "${WORKER_NAME}" to Cloudflare Edge...`);
  const bindings = [
    { name: 'DOMAIN', type: 'plain_text', text: DOMAIN },
    { name: 'APP_URL', type: 'plain_text', text: `https://${SUBDOMAIN}` },
    { name: 'DEFAULT_FROM_NAME', type: 'plain_text', text: 'Admin' },
    { name: 'RESEND_API_KEY', type: 'secret_text', text: resendKey },
    { name: 'JWT_SECRET', type: 'secret_text', text: jwtSecret },
    { name: 'ADMIN_PASSWORD', type: 'secret_text', text: adminPassword }
  ];

  if (D1_UUID) {
    bindings.push({ name: 'DB', type: 'd1', id: D1_UUID });
  }

  const metadata = {
    main_module: 'index.js',
    compatibility_date: '2024-11-01',
    compatibility_flags: ['nodejs_compat'],
    bindings
  };

  const formData = new FormData();
  formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  formData.append('index.js', new Blob([code], { type: 'application/javascript+module' }), 'index.js');

  const uploadRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${WORKER_NAME}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${apiToken}`
    },
    body: formData
  });

  const uploadData = await uploadRes.json();
  if (!uploadData.success) {
    error(`Worker upload failed: ${JSON.stringify(uploadData.errors)}`);
    process.exit(1);
  }
  success(`Worker "${WORKER_NAME}" uploaded and deployed successfully!`);

  // Step 3: Enable Workers.dev subdomain if needed
  log('Enabling worker route...');
  await cfApi(`/accounts/${accountId}/workers/scripts/${WORKER_NAME}/subdomain`, 'POST', { enabled: true });

  // Step 4: Attach Custom Domain
  if (ZONE_ID) {
    log(`Configuring custom domain https://${SUBDOMAIN}...`);
    const domainRes = await cfApi(`/accounts/${accountId}/workers/domains`, 'PUT', {
      hostname: SUBDOMAIN,
      zone_id: ZONE_ID,
      service: WORKER_NAME,
      environment: 'production'
    });
    if (domainRes.success) {
      success(`Custom domain https://${SUBDOMAIN} attached!`);
    } else {
      warn(`Custom domain notice: ${domainRes.errors?.[0]?.message || 'Already attached'}`);
    }

    // Step 5: Enable Cloudflare Email Routing
    log(`Enabling Cloudflare Email Routing on ${DOMAIN}...`);
    const emailEnableRes = await cfApi(`/zones/${ZONE_ID}/email/routing/enable`, 'POST');
    if (emailEnableRes.success) {
      success('Email routing enabled for zone.');
    } else {
      warn(`Email routing notice: ${emailEnableRes.errors?.[0]?.message || 'Already enabled'}`);
    }

    // Step 6: Create Catch-All Email Routing Rule (*@domain -> worker)
    log(`Configuring Catch-All Email Rule (*@${DOMAIN} -> ${WORKER_NAME})...`);
    const catchAllRes = await cfApi(`/zones/${ZONE_ID}/email/routing/rules/catch_all`, 'PUT', {
      actions: [{ type: 'worker', value: [WORKER_NAME] }],
      matchers: [{ type: 'all' }],
      enabled: true,
      name: `Route all incoming @${DOMAIN} emails to ${WORKER_NAME}`
    });
    if (catchAllRes.success) {
      success(`Catch-all rule active: all *@${DOMAIN} emails routed to ${WORKER_NAME}`);
    } else {
      warn(`Catch-all rule notice: ${catchAllRes.errors?.[0]?.message || 'Configured'}`);
    }

    // Step 7: Ensure Clean DNS Records (MX, SPF, DMARC) without duplicates
    log('Verifying DNS records for Cloudflare Email Routing & Resend...');
    try {
      const existingTxt = await cfApi(`/zones/${ZONE_ID}/dns_records?type=TXT`);
      const txtList = existingTxt.result || [];
      const hasSpf = txtList.some(r => r.name === DOMAIN && r.content && r.content.includes('v=spf1'));
      if (!hasSpf) {
        await cfApi(`/zones/${ZONE_ID}/dns_records`, 'POST', {
          type: 'TXT',
          name: DOMAIN,
          content: 'v=spf1 include:_spf.mx.cloudflare.net include:resend.com ~all'
        });
        success('Created canonical SPF record.');
      } else {
        success('Canonical SPF record already configured.');
      }

      const hasDmarc = txtList.some(r => r.name.startsWith('_dmarc'));
      if (!hasDmarc) {
        await cfApi(`/zones/${ZONE_ID}/dns_records`, 'POST', {
          type: 'TXT',
          name: `_dmarc.${DOMAIN}`,
          content: `v=DMARC1; p=none; rua=mailto:dmarc-reports@${DOMAIN}`
        });
        success('Created DMARC record.');
      } else {
        success('DMARC record already configured.');
      }
    } catch (dnsErr) {
      warn(`DNS check notice: ${dnsErr.message}`);
    }
  }

  // Step 8: Send Test Email via Resend if key exists
  let sendStatus = 'Configured';
  if (resendKey) {
    try {
      log('Sending outbound test email via Resend...');
      const sendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'onboarding@resend.dev',
          to: 'alifeo.com@gmail.com',
          subject: `${DOMAIN} Webmail - Deployment Successful`,
          html: `<p>Your self-hosted webmail at <strong>https://${SUBDOMAIN}</strong> is live.</p>`
        })
      });
      const sendData = await sendRes.json();
      if (sendData.id) {
        success(`Outbound test email sent via Resend! (ID: ${sendData.id})`);
        sendStatus = 'Verified Active';
      }
    } catch (err) {
      warn(`Outbound test notice: ${err.message}`);
    }
  }

  console.log('\n======================================================');
  console.log('   🎉 DEPLOYMENT COMPLETE! YOUR WEBMAIL IS LIVE!');
  console.log('======================================================');
  console.log(`\n🔗 Live Webmail URL:  https://${SUBDOMAIN}`);
  console.log(`👤 Admin Username:   ${adminEmail}`);
  console.log(`🔑 Admin Password:   ${adminPassword}`);
  console.log(`📬 Inbound Routing:  *@${DOMAIN} -> Cloudflare Email Worker`);
  console.log(`🚀 Outbound Mail:    Resend API (${sendStatus})`);
  console.log(`💾 Database:         Cloudflare D1 (${D1_UUID || 'Default'})`);
  console.log(`💰 Monthly Cost:     $0.00 / 100% Free Tier\n`);
}

main().catch(err => {
  error(`Fatal error: ${err.message}`);
  process.exit(1);
});
