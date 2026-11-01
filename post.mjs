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
const MEDIA_TEST = process.env.MEDIA_TEST === 'true';

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

async function main() {
  if (MEDIA_TEST) return await 書き込み権限の確認();

  const today = jstNow().date;
  const { posts } = occurrences(loadSchedule(), addDays(today, -1), addDays(today, 7));
  const due = pickDue(posts);

  if (!due.length) {
    const next = posts.find((p) => p.at.getTime() > Date.now());
    console.log('いま投稿するものはありません。' + (next ? `次の予定: ${label(next.投稿日)} ${next.時刻}（${next.rule.名前}）` : ''));
    return await 投稿漏れの確認(posts);
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

  let 重複 = false;
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
      // 同じ内容がすでに投稿されている場合は、X に拒否されて投稿されない。
      // 途中で止めず残りの投稿は続けるが、気づけるように最後に失敗として終える。
      if (!/duplicate/i.test(e.message)) throw e;
      console.error(`同じ内容がすでに投稿されているため、X に拒否されました（${item.rule.名前}）。`);
      重複 = true;
    }
  }

  if (重複) {
    throw new Error('同じ内容の投稿が X に拒否されました。本文を少し変えるか、すでに投稿済みでないか確認してください。');
  }
}

/**
 * 起動が遅れるなどで投稿できなかった回がないか確かめ、見つかれば失敗として終える
 * （GitHub からメールが届き、気づけるようにするため）。
 * X に問い合わせるのは、投稿漏れの疑いがあるときだけ（問い合わせにも費用がかかるため）。
 */
async function 投稿漏れの確認(posts) {
  const 今 = Date.now();
  const 疑い = posts.filter(
    (p) => p.at.getTime() < 今 - LATE_LIMIT_MINUTES * 60e3 && p.at.getTime() > 今 - 12 * 3600e3,
  );
  if (!疑い.length || DRY_RUN || KEY_NAMES.some((name) => !process.env[name])) return;

  const 投稿済み = await 最近の投稿();
  const 漏れ = 疑い.filter((p) => !投稿済み.has(p.本文.trim()));
  if (!漏れ.length) {
    console.log(`${疑い.length}件の過去の予定は、すでに投稿済みでした。`);
    return;
  }

  for (const p of 漏れ) console.error(`投稿されていません: ${label(p.投稿日)} ${p.時刻}（${p.rule.名前}）`);
  throw new Error(
    `${漏れ.length}件が投稿されないまま時間切れになりました。` +
      'GitHub の定期実行が遅れた可能性があります。必要なら Run workflow から手動で投稿してください。',
  );
}

/** 直近の自分の投稿の本文を集める */
async function 最近の投稿() {
  const me = await xApi('GET', ME_URL);
  const url = `https://api.x.com/2/users/${me.data.id}/tweets?max_results=10&exclude=replies,retweets`;
  const res = await xApi('GET', url);
  return new Set((res.data ?? []).map((t) => t.text.trim()));
}

/**
 * 投稿せずに、書き込み権限があるかだけを確かめる。
 * 画像のアップロードは書き込み権限がないとできないが、それ自体は公開されない
 * （アップロードした画像は、投稿に使わなければ24時間ほどで消えます）。
 */
async function 書き込み権限の確認() {
  const missing = KEY_NAMES.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`X API のキーが設定されていません: ${missing.join(', ')}`);

  const me = await xApi('GET', ME_URL);
  console.log(`アカウント: @${me.data.username}`);

  const 画像 = loadSchedule().flatMap((r) => r.投稿).find((p) => p.画像)?.画像;
  if (!画像) {
    console.log('画像を使う投稿がないため、画像のアップロードは試しませんでした。');
    return;
  }

  const image = await readFile(new URL(`./images/${画像}`, import.meta.url));
  const form = new FormData();
  form.append('media', new Blob([image], { type: mediaType(画像) }), 画像);
  form.append('media_category', 'tweet_image');
  const media = await xApi('POST', UPLOAD_URL, form);

  console.log(`画像 ${画像} のアップロードに成功しました（媒体ID ${media.data.id}）。`);
  console.log('書き込み権限があり、画像つきの投稿ができる状態です。この確認では投稿していません。');
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

// main() はこのファイルを読み込んだ直後に動くので、ここは必ず「function」で書くこと
// （const で書くと、使うときにはまだ用意されておらず動きません）
function mediaType(name) {
  if (/\.png$/i.test(name)) return 'image/png';
  if (/\.gif$/i.test(name)) return 'image/gif';
  return 'image/jpeg';
}

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

// OAuth 1.0a（ユーザーコンテキスト）の署名。
// URL のクエリは署名に含める決まり。JSON・multipart の本文は含めない。
function oauthHeader(method, url) {
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const oauth = {
    oauth_consumer_key: process.env.X_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: process.env.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };

  const baseString = 署名のもと(method, url, oauth);
  const signingKey = `${enc(process.env.X_API_SECRET)}&${enc(process.env.X_ACCESS_TOKEN_SECRET)}`;
  oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  return `OAuth ${Object.keys(oauth).sort().map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(', ')}`;
}

/** 署名のもとになる文字列。URL のクエリは署名に含め、URL 自体はクエリを除いた形で使う。 */
export function 署名のもと(method, url, oauthParams) {
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const { origin, pathname, searchParams } = new URL(url);
  const すべて = { ...oauthParams, ...Object.fromEntries(searchParams) };
  const paramString = Object.keys(すべて).sort().map((k) => `${enc(k)}=${enc(すべて[k])}`).join('&');
  return [method, enc(origin + pathname), enc(paramString)].join('&');
}
