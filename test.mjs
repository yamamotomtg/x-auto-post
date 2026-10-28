// 仕組み全体の点検。 実行: node test.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dateKey, holidaysOf } from './holidays.mjs';
import { loadSchedule, occurrences, utcDate, instantOf, label } from './rules.mjs';
import { cronEntries, inspect } from './build.mjs';
import { pickDue } from './post.mjs';

const SAMPLE = fileURLToPath(new URL('./tests/schedule-sample.yml', import.meta.url));
let failed = 0;
const test = (name, fn) => {
  try {
    fn();
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
test('日曜21時と月曜11時に投稿予定がある', () => {
  assert.equal(find(nov.posts, 11, 1, '21:00').length, 1);
  assert.equal(find(nov.posts, 11, 2, '11:00').length, 1);
});
test('{{対象日}}が置き換わる', () => {
  assert.equal(find(nov.posts, 11, 1, '21:00')[0].本文, '明日11月2日(月)は16時から、10枚までです。');
});
test('祝日の月曜（11/23 勤労感謝の日）は前夜も当日も投稿しない', () => {
  assert.equal(find(nov.posts, 11, 22, '21:00').length, 0);
  assert.equal(find(nov.posts, 11, 23, '11:00').length, 0);
  assert.equal(find(nov.skipped, 11, 23, '11:00').length, 1);
});
test('祝日でも「祝日なら休む」を書いていないルールは投稿する（11/3 文化の日）', () => {
  assert.equal(find(nov.posts, 11, 3, '10:00').length, 1);
});
test('期間外の日には臨時ルールを使わない', () => {
  assert.equal(find(nov.posts, 11, 9, '10:00').length, 0);
});
test('優先「高」のルールが重なりに勝つ（11/8 21:00）', () => {
  const posts = find(nov.posts, 11, 8, '21:00');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].rule.名前, '臨時');
  assert.equal(nov.conflicts.length, 1);
});
test('優先「低」にすると、重なった時刻ではそのルールを見送る', () => {
  const 低い = rules.map((r) => (r.名前 === '臨時' ? { ...r, 優先: '低' } : r));
  const 結果 = occurrences(低い, utcDate(2026, 11, 1), utcDate(2026, 11, 30));
  const posts = find(結果.posts, 11, 8, '21:00');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].rule.名前, '通常');
});
test('どちらも「ふつう」なら両方とも投稿する', () => {
  const 同じ = rules.map((r) => ({ ...r, 優先: 'ふつう' }));
  const 結果 = occurrences(同じ, utcDate(2026, 11, 1), utcDate(2026, 11, 30));
  assert.equal(find(結果.posts, 11, 8, '21:00').length, 2);
  assert.equal(結果.conflicts[0].losers.length, 0);
});

console.log('\n■ 投稿するかどうかの判定（日曜21時の投稿）');
const window = nov.posts;
test('10分前に起動 → 投稿する', () => {
  const due = withNow(at(2026, 11, 1, 20, 50), () => pickDue(window));
  assert.equal(due.length, 1);
  assert.equal(due[0].時刻, '21:00');
});
test('何時間も前 → 投稿しない', () => {
  assert.equal(withNow(at(2026, 11, 1, 15, 0), () => pickDue(window)).length, 0);
});
test('起動が30分遅れた → それでも投稿する', () => {
  assert.equal(withNow(at(2026, 11, 1, 21, 30), () => pickDue(window)).length, 1);
});
test('1時間以上遅れた → 投稿しない', () => {
  assert.equal(withNow(at(2026, 11, 1, 22, 10), () => pickDue(window)).length, 0);
});
test('同じ時刻のものは一度にまとめて投稿する', () => {
  const due = withNow(at(2026, 11, 2, 9, 55), () => pickDue(window));
  assert.equal(due.length, 1, '11/2 10:00 は臨時のみ');
});

console.log('\n■ 実行時刻（日本時間 → UTC の cron）');
const cronsOf = (rs) => Object.fromEntries(cronEntries(rs).map(([line, note]) => [note, line]));
const 毎週だけ = cronsOf(rules.filter((r) => r.名前 === '通常'));
const crons = cronsOf(rules);
test('月曜11:00 → UTC 月曜 01:50', () => assert.equal(毎週だけ['通常 / 11:00'], '50 1 * * 1'));
test('日曜21:00 → UTC 日曜 11:50', () => assert.equal(毎週だけ['通常 / 21:00'], '50 11 * * 0'));
test('月曜08:00 → UTC 日曜 22:50（前日にずれる）', () => assert.equal(毎週だけ['通常 / 08:00'], '50 22 * * 0'));
test('毎日10:00 → UTC 毎日 00:50', () => assert.equal(crons['臨時 / 10:00'], '50 0 * * *'));
test('日付指定は毎日起動して実行時に判定する', () => assert.equal(crons['臨時 / 07:30'], '20 22 * * *'));
test('同じ時刻に毎日と毎週があるときは、毎日の起動だけにする（二重起動を防ぐ）', () => {
  const lines = cronEntries(rules).map(([line]) => line);
  assert.equal(lines.filter((l) => l.startsWith('50 11')).length, 1, '21:00 の起動は1つだけ');
  assert.ok(lines.includes('50 11 * * *'));
  assert.equal(new Set(lines).size, lines.length, '同じ時刻の重複はない');
});

console.log('\n■ 本文の点検');
test('長すぎる本文を見つける', () => {
  const posts = [{ 本文: 'あ'.repeat(141), post: { where: 'テスト' }, at: new Date(), 投稿日: utcDate(2026, 11, 1), 時刻: '10:00' }];
  assert.equal(inspect([], posts, []).problems.length, 1);
});
test('同じ本文が続くと警告する', () => {
  const base = { 本文: '同じ本文', post: { where: 'テスト' }, 投稿日: utcDate(2026, 11, 1), 時刻: '10:00' };
  const posts = [{ ...base, at: new Date(at(2026, 11, 1, 10, 0)) }, { ...base, at: new Date(at(2026, 11, 2, 10, 0)) }];
  assert.equal(inspect([], posts, []).warnings.length, 1);
});

console.log('\n■ 祝日（公式データとの突き合わせ）');
try {
  const official = await (await fetch('https://holidays-jp.github.io/api/v1/date.json', { signal: AbortSignal.timeout(15e3) })).json();
  for (const year of [...new Set(Object.keys(official).map((k) => Number(k.slice(0, 4))))].filter((y) => y >= 2022)) {
    test(`${year}年の祝日が公式データと一致する`, () => {
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
