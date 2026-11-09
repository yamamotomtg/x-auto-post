// 仕組み全体の点検。 実行: node test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dateKey, holidaysOf } from './holidays.mjs';
import { occurrences, utcDate, instantOf, label } from './rules.mjs';
import { loadSchedule } from './schedule-file.mjs';
import { inspect } from './build.mjs';
import { 投稿すべきもの } from './schedule-core.mjs';
import { 署名のもと } from './x-api.mjs';

const SAMPLE = fileURLToPath(new URL('./tests/schedule-sample.yml', import.meta.url));
let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message.split('\n')[0]}`);
  }
};
const at = (y, m, d, hh, mm) => instantOf(utcDate(y, m, d), hh, mm).getTime();
const withNow = (ms, fn) => {
  const real = Date.now;
  Date.now = () => ms;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
};

const rules = loadSchedule(SAMPLE);
const nov = occurrences(rules, utcDate(2026, 11, 1), utcDate(2026, 11, 30));
const find = (list, m, d, time) => list.filter((p) => p.投稿日.getUTCDate() === d && p.投稿日.getUTCMonth() + 1 === m && p.時刻 === time);

console.log('\n■ ルールの展開');
await test('日曜21時と月曜11時に投稿予定がある', () => {
  assert.equal(find(nov.posts, 11, 1, '21:00').length, 1);
  assert.equal(find(nov.posts, 11, 2, '11:00').length, 1);
});
await test('{{対象日}}が置き換わる', () => {
  assert.equal(find(nov.posts, 11, 1, '21:00')[0].本文, '明日11月2日(月)は16時から、10枚までです。');
});
await test('祝日の月曜（11/23 勤労感謝の日）は前夜も当日も投稿しない', () => {
  assert.equal(find(nov.posts, 11, 22, '21:00').length, 0);
  assert.equal(find(nov.posts, 11, 23, '11:00').length, 0);
  assert.equal(find(nov.skipped, 11, 23, '11:00').length, 1);
});
await test('祝日でも「祝日なら休む」を書いていないルールは投稿する（11/3 文化の日）', () => {
  assert.equal(find(nov.posts, 11, 3, '10:00').length, 1);
});
await test('「投稿しない」で指定した回だけ投稿しない（11/5 10:00）', () => {
  assert.equal(find(nov.posts, 11, 5, '10:00').length, 0);
  assert.equal(find(nov.posts, 11, 5, '21:00').length, 1, '同じ日の別の時刻は投稿する');
  const 見送り = find(nov.skipped, 11, 5, '10:00');
  assert.equal(見送り.length, 1);
  assert.equal(見送り[0].除外, true);
});
await test('「投稿しない」に日付だけ書くと、その日は全部投稿しない（11/6）', () => {
  assert.equal(find(nov.posts, 11, 6, '10:00').length, 0);
  assert.equal(find(nov.posts, 11, 6, '21:00').length, 0);
});
await test('期間外の日には臨時ルールを使わない', () => {
  assert.equal(find(nov.posts, 11, 9, '10:00').length, 0);
});
await test('優先「高」のルールが重なりに勝つ（11/8 21:00）', () => {
  const posts = find(nov.posts, 11, 8, '21:00');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].rule.名前, '臨時');
  assert.equal(nov.conflicts.length, 1);
});
await test('優先「低」にすると、重なった時刻ではそのルールを見送る', () => {
  const 低い = rules.map((r) => (r.名前 === '臨時' ? { ...r, 優先: '低' } : r));
  const 結果 = occurrences(低い, utcDate(2026, 11, 1), utcDate(2026, 11, 30));
  const posts = find(結果.posts, 11, 8, '21:00');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].rule.名前, '通常');
});
await test('どちらも「ふつう」なら両方とも投稿する', () => {
  const 同じ = rules.map((r) => ({ ...r, 優先: 'ふつう' }));
  const 結果 = occurrences(同じ, utcDate(2026, 11, 1), utcDate(2026, 11, 30));
  assert.equal(find(結果.posts, 11, 8, '21:00').length, 2);
  assert.equal(結果.conflicts[0].losers.length, 0);
});

console.log('\n■ 投稿するかどうかの判定（日曜21時の投稿）');
const window = nov.posts;
await test('10分前に起動 → 投稿する', () => {
  const due = withNow(at(2026, 11, 1, 20, 50), () => 投稿すべきもの(window, { 早め: 15 }));
  assert.equal(due.length, 1);
  assert.equal(due[0].時刻, '21:00');
});
await test('何時間も前 → 投稿しない', () => {
  assert.equal(withNow(at(2026, 11, 1, 15, 0), () => 投稿すべきもの(window, { 早め: 15 })).length, 0);
});
await test('起動が30分遅れた → それでも投稿する', () => {
  assert.equal(withNow(at(2026, 11, 1, 21, 30), () => 投稿すべきもの(window, { 早め: 15 })).length, 1);
});
await test('1時間以上遅れた → 投稿しない', () => {
  assert.equal(withNow(at(2026, 11, 1, 22, 10), () => 投稿すべきもの(window, { 早め: 15 })).length, 0);
});
await test('同じ時刻のものは一度にまとめて投稿する', () => {
  const due = withNow(at(2026, 11, 2, 9, 55), () => 投稿すべきもの(window, { 早め: 15 }));
  assert.equal(due.length, 1, '11/2 10:00 は臨時のみ');
});

console.log('\n■ 本文の点検');
await test('長すぎる本文を見つける', () => {
  const posts = [{ 本文: 'あ'.repeat(141), post: { where: 'テスト' }, at: new Date(), 投稿日: utcDate(2026, 11, 1), 時刻: '10:00' }];
  assert.equal(inspect([], posts, []).problems.length, 1);
});
await test('同じ本文が続くと警告する', () => {
  const base = { 本文: '同じ本文', post: { where: 'テスト' }, 投稿日: utcDate(2026, 11, 1), 時刻: '10:00' };
  const posts = [{ ...base, at: new Date(at(2026, 11, 1, 10, 0)) }, { ...base, at: new Date(at(2026, 11, 2, 10, 0)) }];
  assert.equal(inspect([], posts, []).warnings.length, 1);
});

console.log('\n■ X API の署名');
{
  const oauth = {
    oauth_consumer_key: 'key',
    oauth_nonce: 'n',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: '1',
    oauth_token: 'tok',
    oauth_version: '1.0',
  };
  const もと = 署名のもと('GET', 'https://api.x.com/2/users/123/tweets?max_results=10&exclude=replies', oauth);
  const [method, url, params] = もと.split('&');
  await test('方式とURLはクエリを除いた形で使う', () => {
    assert.equal(method, 'GET');
    assert.equal(decodeURIComponent(url), 'https://api.x.com/2/users/123/tweets');
  });
  await test('クエリも署名に含め、名前順に並べる', () => {
    assert.equal(
      decodeURIComponent(params),
      'exclude=replies&max_results=10&oauth_consumer_key=key&oauth_nonce=n&oauth_signature_method=HMAC-SHA1&oauth_timestamp=1&oauth_token=tok&oauth_version=1.0',
    );
  });
}

// 画像を添付する処理は、偽のキーで動かすと X から 401 が返るところまで進めば正常。
// 途中で ReferenceError などで落ちないことを確かめる（本番でしか通らない経路のため）。
console.log('\n■ 画像つき投稿の経路');
const 偽のキー = {
  ...process.env,
  X_API_KEY: 'test',
  X_API_SECRET: 'test',
  X_ACCESS_TOKEN: 'test',
  X_ACCESS_TOKEN_SECRET: 'test',
  DRY_RUN: 'false',
};
for (const [名前, env] of [
  ['書き込み権限の確認', { ...偽のキー, MEDIA_TEST: 'true' }],
  ['実際の投稿', { ...偽のキー, FORCE: 'true' }],
]) {
  const 出力 = await new Promise((done) => {
    const p = spawn(process.execPath, [fileURLToPath(new URL('./post.mjs', import.meta.url))], { env });
    let text = '';
    p.stdout.on('data', (d) => (text += d));
    p.stderr.on('data', (d) => (text += d));
    p.on('close', () => done(text));
  });
  if (/ENOTFOUND|EAI_AGAIN|fetch failed/.test(出力)) {
    console.log(`  － ${名前}: ネットに繋がらないため省略`);
    continue;
  }
  await test(`${名前}: 途中で落ちず、X の認証エラーまで到達する`, () => {
    assert.doesNotMatch(出力, /ReferenceError|TypeError|SyntaxError/, 出力.split('\n').slice(0, 6).join('\n'));
    assert.match(出力, /X API エラー 401/);
  });
}

// Cloudflare 上の動き。ネットにはつながず、やり取りを差し替えて確かめる。
console.log('\n■ Cloudflare の投稿処理');
{
  const env = {
    SCHEDULE_URL: 'https://example.test/schedule.yml',
    IMAGE_BASE: 'https://example.test/images/',
    X_API_KEY: 'k',
    X_API_SECRET: 'k',
    X_ACCESS_TOKEN: 'k',
    X_ACCESS_TOKEN_SECRET: 'k',
  };
  const 予定表 = readFileSync(SAMPLE, 'utf8');

  // Cloudflare は処理を何度も作り直す。作り直されると worker.mjs の記憶は消えるので、
  // 毎回まっさらな状態から動かして確かめる（記憶に頼った点検では二重投稿を見逃す）。
  let 版 = 0;
  const 置き場 = () => {
    const 中身 = new Map();
    return {
      中身,
      get: async (k) => 中身.get(k) ?? null,
      put: async (k, v) => void 中身.set(k, v),
      delete: async (k) => void 中身.delete(k),
    };
  };

  const 動かす = async (いつ, POSTED) => {
    const { default: worker } = await import(`./worker.mjs?${版++}`);
    const 送信記録 = [];
    const 本物 = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      const u = String(url);
      送信記録.push({ url: u, body: options.body });
      if (u === env.SCHEDULE_URL) return new Response(予定表);
      if (u.startsWith(env.IMAGE_BASE)) return new Response(new Uint8Array([1, 2, 3]));
      if (u.includes('holidays-jp')) return new Response('{}');
      if (u.includes('/2/media/upload')) return new Response(JSON.stringify({ data: { id: 'media1' } }));
      if (u.includes('/2/tweets')) return new Response(JSON.stringify({ data: { id: '12345' } }));
      throw new Error(`想定外の通信: ${u}`);
    };
    try {
      const 待つ = [];
      await worker.scheduled({ scheduledTime: いつ }, { ...env, POSTED }, { waitUntil: (p) => 待つ.push(p) });
      await Promise.all(待つ);
    } finally {
      globalThis.fetch = 本物;
    }
    const 投稿 = 送信記録.filter((r) => r.url.includes('/2/tweets'));
    return { 送信記録, 投稿, 本文: 投稿.map((r) => JSON.parse(r.body).text) };
  };

  const 記録 = 置き場();
  const 結果 = await 動かす(at(2026, 11, 3, 10, 0), 記録);
  await test('時刻ちょうどに、その回を投稿する', () => {
    assert.deepEqual(結果.本文, ['本日11月3日(火)はメンテナンスのため100枚までです。']);
  });

  await test('投稿したことが記録に残る', () => {
    assert.deepEqual([...記録.中身.values()], ['投稿済み 12345']);
  });

  // 2026/11/8・9 に3回ずつ投稿されたときの再現。
  // 記憶が消えても、記録が残っていれば投稿しないこと。
  await test('処理が作り直されても、記録があれば同じ回を投稿しない', async () => {
    assert.equal((await 動かす(at(2026, 11, 3, 10, 0), 記録)).投稿.length, 0);
  });

  await test('1分あとの実行では、そもそもその回を拾わない（記録なしでも二重投稿しない）', async () => {
    assert.equal((await 動かす(at(2026, 11, 3, 10, 1), 置き場())).投稿.length, 0);
    assert.equal((await 動かす(at(2026, 11, 3, 10, 1), undefined)).投稿.length, 0);
  });

  await test('「投稿しない」に指定した回は投稿しない（11/5 10:00）', async () => {
    assert.equal((await 動かす(at(2026, 11, 5, 10, 0), 置き場())).投稿.length, 0);
  });

  await test('投稿する時刻でないときは、X に一切つながない', async () => {
    const r = await 動かす(at(2026, 11, 3, 14, 0), 置き場());
    assert.equal(r.投稿.length, 0);
    assert.ok(!r.送信記録.some((x) => x.url.includes('api.x.com')));
  });

  await test('祝日の月曜は投稿しない（11/23 勤労感謝の日）', async () => {
    assert.equal((await 動かす(at(2026, 11, 23, 11, 0), 置き場())).投稿.length, 0);
  });
}

console.log('\n■ 祝日（公式データとの突き合わせ）');
try {
  const official = await (await fetch('https://holidays-jp.github.io/api/v1/date.json', { signal: AbortSignal.timeout(15e3) })).json();
  for (const year of [...new Set(Object.keys(official).map((k) => Number(k.slice(0, 4))))].filter((y) => y >= 2022)) {
    await test(`${year}年の祝日が公式データと一致する`, () => {
      const calc = holidaysOf(year);
      const keys = [...new Set([...calc.keys(), ...Object.keys(official).filter((k) => k.startsWith(`${year}-`))])];
      const diff = keys.filter((k) => calc.has(k) !== (k in official));
      assert.deepEqual(diff, [], `不一致: ${diff.join(', ')}`);
    });
  }
} catch (e) {
  console.log(`  － 祝日APIに接続できないため省略（${e.message}）`);
}

console.log(failed ? `\n${failed}件 失敗しました` : '\nすべて問題ありません');
process.exitCode = failed ? 1 : 0;
