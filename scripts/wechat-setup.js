#!/usr/bin/env node

/**
 * WeChat QR Login Setup for Orb.
 *
 * Usage: node scripts/wechat-setup.js
 *
 * Connects to iLink Bot API, displays a QR code, and waits for the user
 * to scan with WeChat. On success, saves credentials to ~/.orb/wechat/.
 *
 * After setup, add the account_id to config.json under adapters.wechat.
 */

import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const EP_GET_BOT_QR = 'ilink/bot/get_bot_qrcode';
const EP_GET_QR_STATUS = 'ilink/bot/get_qrcode_status';

const QR_TIMEOUT_MS = 35_000;
const TOTAL_TIMEOUT_S = 480;
const MAX_REFRESH = 3;

function credentialDir() {
  const dir = join(homedir(), '.orb', 'wechat');
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function apiGet(baseUrl, endpoint, timeoutMs) {
  const url = `${baseUrl.replace(/\/$/, '')}/${endpoint}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: {
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': String((2 << 16) | (2 << 8) | 0),
      },
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function saveCredentials(accountId, token, baseUrl, userId) {
  const payload = {
    token,
    base_url: baseUrl,
    user_id: userId,
    saved_at: new Date().toISOString(),
  };
  const path = join(credentialDir(), `${accountId}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  try {
    chmodSync(path, 0o600);
  } catch {}
  return path;
}

async function main() {
  console.log('\n=== Orb WeChat Setup ===\n');

  // Step 1: Get QR code
  let qrResp;
  try {
    qrResp = await apiGet(ILINK_BASE_URL, `${EP_GET_BOT_QR}?bot_type=3`, QR_TIMEOUT_MS);
  } catch (err) {
    console.error(`Failed to fetch QR code: ${err.message}`);
    process.exit(1);
  }

  let qrcodeValue = qrResp.qrcode || '';
  const qrcodeUrl = qrResp.qrcode_img_content || '';

  if (!qrcodeValue) {
    console.error('QR response missing qrcode value');
    process.exit(1);
  }

  console.log('请使用微信扫描以下二维码：');
  if (qrcodeUrl) console.log(`\n${qrcodeUrl}\n`);

  // Try rendering QR in terminal
  try {
    const { default: QRCode } = await import('qrcode-terminal');
    QRCode.generate(qrcodeUrl || qrcodeValue, { small: true });
  } catch {
    console.log('（安装 qrcode-terminal 可在终端显示二维码）');
  }

  // Step 2: Poll for scan status
  const deadline = Date.now() + TOTAL_TIMEOUT_S * 1000;
  let currentBaseUrl = ILINK_BASE_URL;
  let refreshCount = 0;

  while (Date.now() < deadline) {
    let statusResp;
    try {
      statusResp = await apiGet(
        currentBaseUrl,
        `${EP_GET_QR_STATUS}?qrcode=${qrcodeValue}`,
        QR_TIMEOUT_MS,
      );
    } catch (err) {
      if (err.name === 'AbortError') {
        await sleep(1000);
        continue;
      }
      console.warn(`QR poll error: ${err.message}`);
      await sleep(1000);
      continue;
    }

    const status = statusResp.status || 'wait';

    if (status === 'wait') {
      process.stdout.write('.');
    } else if (status === 'scaned') {
      console.log('\n已扫码，请在微信里确认...');
    } else if (status === 'scaned_but_redirect') {
      const redirectHost = statusResp.redirect_host || '';
      if (redirectHost) {
        currentBaseUrl = `https://${redirectHost}`;
      }
    } else if (status === 'expired') {
      refreshCount++;
      if (refreshCount > MAX_REFRESH) {
        console.log('\n二维码多次过期，请重新执行登录。');
        process.exit(1);
      }
      console.log(`\n二维码已过期，正在刷新... (${refreshCount}/${MAX_REFRESH})`);
      try {
        const newQr = await apiGet(ILINK_BASE_URL, `${EP_GET_BOT_QR}?bot_type=3`, QR_TIMEOUT_MS);
        qrcodeValue = newQr.qrcode || '';
        if (newQr.qrcode_img_content) console.log(newQr.qrcode_img_content);
      } catch (err) {
        console.error(`QR refresh failed: ${err.message}`);
        process.exit(1);
      }
    } else if (status === 'confirmed') {
      const accountId = statusResp.ilink_bot_id || '';
      const token = statusResp.bot_token || '';
      const baseUrl = statusResp.baseurl || ILINK_BASE_URL;
      const userId = statusResp.ilink_user_id || '';

      if (!accountId || !token) {
        console.error('\nQR confirmed but credential payload was incomplete');
        process.exit(1);
      }

      const savedPath = saveCredentials(accountId, token, baseUrl, userId);

      console.log(`\n✅ 微信连接成功！`);
      console.log(`   Account ID: ${accountId}`);
      console.log(`   Credentials saved to: ${savedPath}`);
      console.log(`\n下一步：在 config.json 中添加 wechat adapter 配置：`);
      console.log(`{`);
      console.log(`  "adapters": {`);
      console.log(`    "wechat": {`);
      console.log(`      "enabled": true,`);
      console.log(`      "accountId": "${accountId}",`);
      console.log(`      "token": "\${WECHAT_TOKEN}",`);
      console.log(`      "dmPolicy": "allowlist",`);
      console.log(`      "allowedUsers": ["<wechat_user_id>"]`);
      console.log(`    }`);
      console.log(`  }`);
      console.log(`}`);
      console.log(`\n并在 .env 中设置: WECHAT_TOKEN=${token}`);
      process.exit(0);
    }

    await sleep(1000);
  }

  console.log('\n微信登录超时。');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(`Setup failed: ${err.message}`);
  process.exit(1);
});
