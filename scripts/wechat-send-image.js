#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  API_TIMEOUT_MS,
  EP_GET_UPLOAD_URL,
  EP_SEND_MESSAGE,
  ILINK_BASE_URL,
  ITEM_IMAGE,
  MAX_UPLOAD_FILE_BYTES,
  MEDIA_IMAGE,
  MSG_STATE_FINISH,
  MSG_TYPE_BOT,
  SESSION_EXPIRED_ERRCODE,
  WECHAT_CDN_BASE_URL,
  aesPaddedSize,
  apiPost,
  assertOkIlinkResponse,
  cdnUpload,
  cdnUploadUrl,
  detectImageMime,
  encryptAes128Ecb,
  loadCredentials,
} from '../src/adapters/wechat.js';

function usage() {
  return 'Usage: node ~/Orb/scripts/wechat-send-image.js <recipient-userId> <abs-image-path> [--account <accountId>]';
}

function credentialDir() {
  return join(homedir(), '.orb', 'wechat');
}

function parseArgs(argv) {
  const positional = [];
  let accountId = '';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--account') {
      accountId = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--account=')) {
      accountId = arg.slice('--account='.length);
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    positional.push(arg);
  }

  const [recipientUserId, imagePath] = positional;
  if (!recipientUserId || !imagePath || positional.length > 2) {
    throw new Error(usage());
  }
  return { recipientUserId, imagePath, accountId };
}

function listCredentialAccountIds() {
  const dir = credentialDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .filter((name) => !name.endsWith('.context-tokens.json'))
    .filter((name) => !name.endsWith('.sync.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

function resolveAccountId(requestedAccountId) {
  if (requestedAccountId) return requestedAccountId;
  const accountIds = listCredentialAccountIds();
  if (accountIds.length === 0) {
    throw new Error(`no WeChat credential JSON found in ${credentialDir()}`);
  }
  return accountIds[0];
}

function readContextToken(accountId, userId) {
  const path = join(credentialDir(), `${accountId}.context-tokens.json`);
  if (!existsSync(path)) return null;
  try {
    const tokens = JSON.parse(readFileSync(path, 'utf-8'));
    return tokens?.[userId] || null;
  } catch {
    return null;
  }
}

function readImage(imagePath) {
  if (!isAbsolute(imagePath)) throw new Error(`image path must be absolute: ${imagePath}`);

  let stat;
  try {
    stat = statSync(imagePath);
  } catch (err) {
    throw new Error(`cannot read image ${imagePath}: ${err.message}`);
  }

  if (!stat.isFile()) throw new Error(`image path is not a file: ${imagePath}`);
  if (stat.size <= 0) throw new Error(`image file is empty: ${imagePath}`);
  if (stat.size > MAX_UPLOAD_FILE_BYTES) {
    throw new Error(`image exceeds ${MAX_UPLOAD_FILE_BYTES} bytes: ${imagePath}`);
  }

  const plaintext = readFileSync(imagePath);
  const mime = detectImageMime(plaintext.subarray(0, 16));
  if (!mime) throw new Error('only PNG/JPEG images are supported');
  return { plaintext, mime };
}

function buildImageMessage({ recipientUserId, clientId, encryptedQueryParam, aesKeyForApi, ciphertextLength, contextToken }) {
  const message = {
    from_user_id: '',
    to_user_id: recipientUserId,
    client_id: clientId,
    message_type: MSG_TYPE_BOT,
    message_state: MSG_STATE_FINISH,
    item_list: [{
      type: ITEM_IMAGE,
      image_item: {
        media: {
          encrypt_query_param: encryptedQueryParam,
          aes_key: aesKeyForApi,
          encrypt_type: 1,
        },
        mid_size: ciphertextLength,
      },
    }],
  };
  if (contextToken) message.context_token = contextToken;
  return message;
}

async function sendImage({ recipientUserId, imagePath, accountId }) {
  const creds = loadCredentials(accountId);
  if (!creds?.token) throw new Error(`missing WeChat token for account ${accountId}`);

  const baseUrl = (creds.base_url || ILINK_BASE_URL).replace(/\/$/, '');
  const token = creds.token;
  const { plaintext, mime } = readImage(imagePath);
  const filekey = randomBytes(16).toString('hex');
  const aesKey = randomBytes(16);
  const rawfilemd5 = createHash('md5').update(plaintext).digest('hex');
  const ciphertext = encryptAes128Ecb(plaintext, aesKey);

  const uploadResp = await apiPost(baseUrl, EP_GET_UPLOAD_URL, {
    filekey,
    media_type: MEDIA_IMAGE,
    to_user_id: recipientUserId,
    rawsize: plaintext.length,
    rawfilemd5,
    filesize: aesPaddedSize(plaintext.length),
    no_need_thumb: true,
    aeskey: aesKey.toString('hex'),
  }, token, API_TIMEOUT_MS);
  assertOkIlinkResponse(uploadResp, 'getuploadurl');

  const uploadFullUrl = String(uploadResp.upload_full_url || '');
  const uploadParam = String(uploadResp.upload_param || '');
  const uploadUrl = uploadFullUrl || (uploadParam ? cdnUploadUrl(WECHAT_CDN_BASE_URL, uploadParam, filekey) : '');
  if (!uploadUrl) {
    throw new Error(`getuploadurl returned no upload URL: ${JSON.stringify(uploadResp).slice(0, 300)}`);
  }

  const encryptedQueryParam = await cdnUpload(uploadUrl, ciphertext);
  const aesKeyForApi = Buffer.from(aesKey.toString('hex'), 'ascii').toString('base64');
  const clientId = `orb-wx-${randomUUID().replace(/-/g, '')}`;
  const messageArgs = {
    recipientUserId,
    clientId,
    encryptedQueryParam,
    aesKeyForApi,
    ciphertextLength: ciphertext.length,
  };
  let contextToken = readContextToken(accountId, recipientUserId);

  let resp = await apiPost(baseUrl, EP_SEND_MESSAGE, {
    msg: buildImageMessage({ ...messageArgs, contextToken }),
  }, token, API_TIMEOUT_MS);
  const ret = resp?.ret ?? 0;
  const errcode = resp?.errcode ?? 0;
  if ((ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE) && contextToken) {
    contextToken = null;
    resp = await apiPost(baseUrl, EP_SEND_MESSAGE, {
      msg: buildImageMessage({ ...messageArgs, contextToken }),
    }, token, API_TIMEOUT_MS);
  }
  assertOkIlinkResponse(resp, 'sendmessage');

  return {
    ok: true,
    to: recipientUserId,
    account: accountId,
    file: basename(imagePath),
    mime,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const accountId = resolveAccountId(args.accountId);
  const result = await sendImage({ ...args, accountId });
  console.log(JSON.stringify({ ok: true, to: result.to }));
}

main().catch((err) => {
  console.error(`wechat-send-image: ${err.message}`);
  process.exitCode = 1;
});
