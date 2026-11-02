// 「いま投稿すべきか」「投稿漏れはないか」の判定。
// パソコン（Node）でも Cloudflare でも使う。

import { dateKey } from './holidays.mjs';

const HOLIDAY_API = 'https://holidays-jp.github.io/api/v1/date.json';

/**
 * いま投稿すべき回を選ぶ（同じ時刻のものはまとめて返す）。
 *   早め       … 何分先の予定まで拾うか（時刻ちょうどまで待ってから投稿する）
 *   遅れ上限   … 何分前までの予定なら、遅れてでも投稿するか
 *   force      … 時刻を無視して、いまに一番近い回を選ぶ（手動実行）
 */
export function 投稿すべきもの(posts, { force = false, 早め = 0, 遅れ上限 = 45, now = Date.now() } = {}) {
  if (!posts.length) return [];

  if (force) {
    const 近い = posts.slice().sort((a, b) => Math.abs(a.at - now) - Math.abs(b.at - now))[0];
    return posts.filter((p) => p.at.getTime() === 近い.at.getTime());
  }

  const 候補 = posts.filter((p) => p.at.getTime() >= now - 遅れ上限 * 60e3 && p.at.getTime() <= now + 早め * 60e3);
  if (!候補.length) return [];
  const 最初 = Math.min(...候補.map((p) => p.at.getTime()));
  return 候補.filter((p) => p.at.getTime() === 最初);
}

/**
 * 時間切れで投稿できなかった疑いのある回。
 * 本当に投稿されたかは X に問い合わせて確かめる（呼び出し側の仕事）。
 */
export function 投稿漏れ(posts, 遅れ上限 = 45, now = Date.now()) {
  return posts.filter((p) => p.at.getTime() < now - 遅れ上限 * 60e3 && p.at.getTime() > now - 12 * 3600e3);
}

/**
 * 投稿の直前に、対象日が祝日でないかを公式データ（内閣府の祝日一覧が元）で確かめる。
 * 計算では祝日でなくても、法改正などで変わっている場合に備えるため。
 * 問い合わせに失敗したときは、計算結果を信じてそのまま投稿する。
 */
export async function 祝日か(item) {
  if (!item.post.祝日なら休む) return null;
  try {
    const res = await fetch(HOLIDAY_API, { signal: AbortSignal.timeout(15e3) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json())[dateKey(item.対象日)] ?? null;
  } catch (e) {
    console.warn(`祝日APIに接続できませんでした。計算結果だけで判定します（${e.message}）`);
    return null;
  }
}
