// schedule.yml のルールに従って X に投稿する（パソコン・GitHub Actions 用）。
// ふだんの定期投稿は Cloudflare が行う。こちらは手動実行と、投稿漏れの点検に使う。
//
// 環境変数:
//   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET … X API のキー
//   DRY_RUN=true    … 投稿せず、予定と本文の確認だけする
//   FORCE=true      … 時刻を待たずに、いまに一番近い回をすぐ投稿する（手動実行）
//   MEDIA_TEST=true … 投稿せず、書き込み権限があるかだけ確かめる
//   WATCHDOG=true   … 投稿せず、投稿漏れがないかだけ確かめる（毎日の点検用）

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { 投稿すべきもの, 祝日か, 投稿漏れ } from './schedule-core.mjs';
import { occurrences, addDays, label, jstNow, weightedLength } from './rules.mjs';
import { loadSchedule } from './schedule-file.mjs';
import { xClient, キーを読む, XApiError } from './x-api.mjs';

// 投稿時刻の何分前に起動するか（build.mjs が cron を作るときにも使う）
export const LEAD_MINUTES = 10;
// 起動が遅れた場合、何分後まで投稿するか
export const LATE_LIMIT_MINUTES = 45;

const DRY_RUN = process.env.DRY_RUN === 'true';
const FORCE = process.env.FORCE === 'true';
const MEDIA_TEST = process.env.MEDIA_TEST === 'true';
const WATCHDOG = process.env.WATCHDOG === 'true';

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

async function main() {
  const today = jstNow().date;
  const { posts } = occurrences(loadSchedule(), addDays(today, -1), addDays(today, 7));

  if (MEDIA_TEST) return await 書き込み権限の確認();
  if (WATCHDOG) return await 投稿漏れの確認(posts);

  const due = 投稿すべきもの(posts, { force: FORCE, lead: LEAD_MINUTES, late: LATE_LIMIT_MINUTES });
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

  if (DRY_RUN) {
    try {
      console.log(`X API の認証OK: @${(await client().me()).data.username} として投稿されます`);
    } catch (e) {
      console.log(`※キーを確認できませんでした: ${e.message.split('\n')[0]}`);
    }
    console.log('DRY_RUN のため投稿しません。');
    return;
  }

  const x = client();
  const wait = due[0].at.getTime() - Date.now();
  if (wait > 0 && !FORCE) {
    console.log(`${due[0].時刻} まで ${Math.ceil(wait / 60e3)} 分待ちます…`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  let 重複 = false;
  for (const item of due) {
    if (await 祝日か(item)) {
      console.log(`${label(item.対象日)}は祝日のため投稿しません（${item.rule.名前}）。`);
      continue;
    }
    try {
      const 媒体ID = item.画像 ? await x.画像をあげる(await 画像を読む(item.画像), item.画像) : null;
      const posted = await x.投稿する(item.本文, 媒体ID);
      console.log(`投稿しました（${item.rule.名前}）: https://x.com/i/status/${posted.id}`);
    } catch (e) {
      if (!(e instanceof XApiError) || !e.重複) throw e;
      console.error(`同じ内容がすでに投稿されているため、X に拒否されました（${item.rule.名前}）。`);
      重複 = true;
    }
  }

  if (重複) {
    throw new Error('同じ内容の投稿が X に拒否されました。本文を少し変えるか、すでに投稿済みでないか確認してください。');
  }
}

// main() はこのファイルを読み込んだ直後に動くので、ここは必ず「function」で書くこと
// （const で書くと、使うときにはまだ用意されておらず動きません）
function client() {
  return xClient(キーを読む(process.env));
}

function 画像を読む(名前) {
  return readFile(new URL(`./images/${名前}`, import.meta.url));
}

/**
 * 投稿できなかった回がないか確かめ、見つかれば失敗として終える
 * （GitHub からメールが届き、気づけるようにするため）。
 */
async function 投稿漏れの確認(posts) {
  const 疑い = 投稿漏れ(posts, LATE_LIMIT_MINUTES);
  if (!疑い.length) {
    console.log('投稿漏れはありません。');
    return;
  }

  const x = client();
  const 投稿済み = await x.最近の投稿((await x.me()).data.id);
  const 漏れ = 疑い.filter((p) => !投稿済み.has(p.本文.trim()));
  if (!漏れ.length) {
    console.log(`過去${疑い.length}件の予定は、すべて投稿済みでした。`);
    return;
  }

  for (const p of 漏れ) console.error(`投稿されていません: ${label(p.投稿日)} ${p.時刻}（${p.rule.名前}）`);
  throw new Error(
    `${漏れ.length}件が投稿されないまま時間切れになりました。` +
      'Run workflow（force にチェック）で手動投稿できます。',
  );
}

/**
 * 投稿せずに、書き込み権限があるかだけを確かめる。
 * 画像のアップロードは書き込み権限がないとできないが、それ自体は公開されない
 * （アップロードした画像は、投稿に使わなければ24時間ほどで消えます）。
 */
async function 書き込み権限の確認() {
  const x = client();
  console.log(`アカウント: @${(await x.me()).data.username}`);

  const 画像 = loadSchedule().flatMap((r) => r.投稿).find((p) => p.画像)?.画像;
  if (!画像) {
    console.log('画像を使う投稿がないため、画像のアップロードは試しませんでした。');
    return;
  }

  const 媒体ID = await x.画像をあげる(await 画像を読む(画像), 画像);
  console.log(`画像 ${画像} のアップロードに成功しました（媒体ID ${媒体ID}）。`);
  console.log('書き込み権限があり、画像つきの投稿ができる状態です。この確認では投稿していません。');
}
