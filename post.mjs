// schedule.yml のルールに従って X に投稿する。GitHub Actions から呼ばれる。
//
// 環境変数:
//   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET … X API のキー
//   DRY_RUN=true … 投稿せず、予定と本文の確認だけする
//   FORCE=true   … 時刻を待たずに、次の投稿予定をすぐ実行する（テスト用）

import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dateKey } from './holidays.mjs';
import { loadSchedule, occurrences, addDays, label, jstNow, weightedLength } from './rules.mjs';

// 投稿時刻の何分前に起動するか（build.mjs が cron を作るときにも使う）
export const LEAD_MINUTES = 10;
// 起動が遅れた場合、何分後まで投稿するか
export const LATE_LIMIT_MINUTES = 45;

const ME_URL = 'https://api.x.com/2/users/me';
const UPLOAD_URL = 'https://api.x.com/2/media/upload';
const TWEET_URL = 'https://api.x.com/2/tweets';
const HOLIDAY_API = 'https://holidays-jp.github.io/api/v1/date.json';
const KEY_NAMES = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'];

const DRY_RUN = process.env.DRY_RUN === 'true';
const FORCE = process.env.FORCE === 'true';

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

async function main() {
  const today = jstNow().date;
  const { posts } = occurrences(loadSchedule(), addDays(today, -1), addDays(today, 7));
  const due = pickDue(posts);

  if (!due.length) {
    const next = posts.find((p) => p.at.getTime() > Date.now());
    console.log('いま投稿するものはありません。' + (next ? `次の予定: ${label(next.投稿日)} ${next.時刻}（${next.rule.名前}）` : ''));
    return;
  }

  for (const item of due) {
    console.log(`予定: ${label(item.投稿日)} ${item.時刻}  ${item.rule.名前}`);
    console.log(`文字数（X換算）: ${weightedLength(item.本文)}/280${item.画像 ? `　画像: ${item.画像}` : ''}`);
    console.log(`----- 本文 -----\n${item.本文}\n----------------`);
  }

  const missing = KEY_NAMES.filter((name) => !process.env[name]);
  if (DRY_RUN) {
    if (missing.length) console.log(`※未設定のキーがあります: ${missing.join(', ')}`);
    else console.log(`X API の認証OK: @${(await xApi('GET', ME_URL)).data.username} として投稿されます`);
    console.log('DRY_RUN のため投稿しません。');
    return;
  }
  if (missing.length) throw new Error(`X API のキーが設定されていません: ${missing.join(', ')}`);

  const wait = due[0].at.getTime() - Date.now();
  if (wait > 0 && !FORCE) {
    console.log(`${due[0].時刻} まで ${Math.ceil(wait / 60e3)} 分待ちます…`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  for (const item of due) {
    // 法改正などに備え、投稿の直前に公式データ（内閣府の祝日一覧が元）でも確かめる
    if (item.post.祝日なら休む) {
      const holiday = await holidayFromApi(dateKey(item.対象日));
      if (holiday) {
        console.log(`${label(item.対象日)}は${holiday}のため投稿しません（${item.rule.名前}）。`);
        continue;
      }
    }

    let media;
    if (item.画像) {
      const image = await readFile(new URL(`./images/${item.画像}`, import.meta.url));
      const form = new FormData();
      form.append('media', new Blob([image], { type: mediaType(item.画像) }), item.画像);
      form.append('media_category', 'tweet_image');
      media = (await xApi('POST', UPLOAD_URL, form)).data.id;
    }

    const body = JSON.stringify({ text: item.本文, ...(media ? { media: { media_ids: [media] } } : {}) });
    try {
      const posted = await xApi('POST', TWEET_URL, body, 'application/json');
      console.log(`投稿しました（${item.rule.名前}）: https://x.com/i/status/${posted.data.id}`);
    } catch (e) {
      // 同じ内容がすでに投稿されている場合（二重起動など）は、失敗にせず見送る
      if (!/duplicate/i.test(e.message)) throw e;
      console.log(`同じ内容がすでに投稿されているため見送りました（${item.rule.名前}）。`);
    }
  }
}

/** 今このタイミングで投稿すべきものを選ぶ（同じ時刻のものはまとめて返す） */
export function pickDue(posts) {
  if (FORCE) {
    const next = posts.find((p) => p.at.getTime() >= Date.now()) ?? posts.at(-1);
    return next ? posts.filter((p) => p.at.getTime() === next.at.getTime()) : [];
  }
  const now = Date.now();
  const candidates = posts.filter(
    (p) => p.at.getTime() >= now - LATE_LIMIT_MINUTES * 60e3 && p.at.getTime() <= now + (LEAD_MINUTES + 5) * 60e3,
  );
  if (!candidates.length) return [];
  const first = candidates[0].at.getTime();
  return candidates.filter((p) => p.at.getTime() === first);
}

const mediaType = (name) => (/\.png$/i.test(name) ? 'image/png' : /\.gif$/i.test(name) ? 'image/gif' : 'image/jpeg');

async function holidayFromApi(key) {
  try {
    const res = await fetch(HOLIDAY_API, { signal: AbortSignal.timeout(15e3) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json())[key] ?? null;
  } catch (e) {
    console.warn(`祝日APIに接続できませんでした。計算結果だけで判定します（${e.message}）`);
    return null;
  }
}

async function xApi(method, url, body, contentType) {
  const headers = { Authorization: oauthHeader(method, url) };
  if (contentType) headers['Content-Type'] = contentType;
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(60e3) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`X API エラー ${res.status} ${method} ${url}\n${raw}`);
  return JSON.parse(raw);
}

// OAuth 1.0a（ユーザーコンテキスト）の署名。JSON・multipart の本文は署名対象に含めない。
function oauthHeader(method, url) {
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const params = {
    oauth_consumer_key: process.env.X_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: process.env.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  const paramString = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join('&');
  const baseString = [method, enc(url), enc(paramString)].join('&');
  const signingKey = `${enc(process.env.X_API_SECRET)}&${enc(process.env.X_ACCESS_TOKEN_SECRET)}`;
  params.oauth_signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
  return `OAuth ${Object.keys(params).sort().map((k) => `${enc(k)}="${enc(params[k])}"`).join(', ')}`;
}
