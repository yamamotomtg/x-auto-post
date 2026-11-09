// Cloudflare で1分ごとに動き、時刻になった投稿を X に出す。
//
// 投稿内容（schedule.yml と画像）は GitHub から読み取るので、
// 管理画面で編集して「GitHubへ反映」すれば、ここを触らなくても反映されます。

import { parseSchedule, occurrences, addDays, label, jstNow } from './rules.mjs';
import { 投稿すべきもの, 祝日か, 記録の目印 } from './schedule-core.mjs';
import { xClient, キーを読む, XApiError } from './x-api.mjs';

// 同じ回を二度投稿しないための記録。
// 下の Set は、Cloudflare が同じ処理を使い回している間しか残りません。
// 作り直されると空になってしまうため、本命は KV（env.POSTED）への記録です。
const 覚えた = new Set();
const 記録の保存期間 = 2 * 24 * 3600; // 秒。2日たてば消えてよい
// 読み取った schedule.yml を覚えておき、変わっていなければ読み直さない
let 覚えている = { text: null, rules: [] };

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(実行(env, controller.scheduledTime));
  },

  // ブラウザで開くと、次の投稿予定を確認できる（公開されている内容のみ）
  async fetch(request, env) {
    // 投稿漏れの点検（GitHub Actions）がここを読み、出たはずの回の記録があるか確かめる
    if (new URL(request.url).pathname === '/records') {
      return Response.json(await 記録一覧(env));
    }
    try {
      const rules = await ルールを取る(env);
      const today = jstNow().date;
      const { posts, skipped } = occurrences(rules, today, addDays(today, 14));
      const 行 = (p, 印 = '') => `${label(p.投稿日)} ${p.時刻}  ${p.rule.名前}${印}`;
      const text = [
        `現在（日本時間）: ${new Date(Date.now() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16)}`,
        '',
        '■ 今後2週間の投稿予定',
        ...posts.map((p) => '  ' + 行(p)),
        '',
        '■ 投稿しない回',
        ...skipped.map((p) => '  ' + 行(p, `  … ${p.理由}`)),
      ].join('\n');
      return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    } catch (e) {
      return new Response(`設定を読み取れませんでした: ${e.message}`, { status: 500 });
    }
  },
};

async function 実行(env, now = Date.now()) {
  const rules = await ルールを取る(env);
  const today = jstNow(now).date;
  const { posts } = occurrences(rules, addDays(today, -1), addDays(today, 2));

  // 1分ごとに動くので、拾う幅も1分にする。
  // 幅を広げると同じ回が複数回の実行に引っかかり、そのぶん投稿されてしまう
  const due = 投稿すべきもの(posts, { 早め: 0, 遅れ上限: 1, now });
  if (!due.length) return;

  const x = xClient(キーを読む(env));
  for (const item of due) {
    const 目印 = 記録の目印(item);
    if (await 済んでいる(env, 目印)) continue;

    const 祝日 = await 祝日か(item);
    if (祝日) {
      console.log(`${label(item.対象日)}は${祝日}のため投稿しません（${item.rule.名前}）`);
      await 記録する(env, 目印, '祝日のため見送り');
      continue;
    }

    // 投稿より先に記録する。1分ごとに動くので、記録が遅れると二重投稿になる
    await 記録する(env, 目印, '投稿中');
    try {
      const 媒体ID = item.画像 ? await x.画像をあげる(await 画像を取る(env, item.画像), item.画像) : null;
      const posted = await x.投稿する(item.本文, 媒体ID);
      await 記録する(env, 目印, `投稿済み ${posted.id}`);
      console.log(`投稿しました（${item.rule.名前}）: https://x.com/i/status/${posted.id}`);
    } catch (e) {
      if (e instanceof XApiError && e.重複) {
        console.log(`同じ内容がすでに投稿されているため見送りました（${item.rule.名前}）`);
        continue;
      }
      await 消す(env, 目印); // 次の実行でやり直せるようにする
      console.error(`投稿に失敗しました（${item.rule.名前}）: ${e.message}`);
      throw e;
    }
  }
}

/** その回をすでに投稿したか（KV が使えないときは、せめて記憶だけで判断する） */
async function 済んでいる(env, 目印) {
  if (覚えた.has(目印)) return true;
  if (!env.POSTED) return false;
  const 記録 = await env.POSTED.get(目印);
  if (記録) 覚えた.add(目印);
  return Boolean(記録);
}

async function 記録する(env, 目印, 状態) {
  覚えた.add(目印);
  if (env.POSTED) await env.POSTED.put(目印, 状態, { expirationTtl: 記録の保存期間 });
}

async function 消す(env, 目印) {
  覚えた.delete(目印);
  if (env.POSTED) await env.POSTED.delete(目印);
}

/** 残っている記録をすべて返す（2日たったものは自動で消えます） */
async function 記録一覧(env) {
  if (!env.POSTED) return {};
  const { keys } = await env.POSTED.list();
  const 組 = await Promise.all(keys.map(async (k) => [k.name, await env.POSTED.get(k.name)]));
  return Object.fromEntries(組);
}

async function ルールを取る(env) {
  const res = await fetch(env.SCHEDULE_URL, { cf: { cacheTtl: 30, cacheEverything: true } });
  if (!res.ok) throw new Error(`schedule.yml を読み取れません（HTTP ${res.status}）`);
  const text = await res.text();
  if (text !== 覚えている.text) 覚えている = { text, rules: parseSchedule(text) };
  return 覚えている.rules;
}

async function 画像を取る(env, 名前) {
  const res = await fetch(env.IMAGE_BASE + encodeURIComponent(名前), { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) throw new Error(`画像 ${名前} を読み取れません（HTTP ${res.status}）`);
  return new Uint8Array(await res.arrayBuffer());
}
