// schedule.yml の読み書き。画面（app/server.mjs）から呼ばれる。
// 本文を「|」の形で読みやすく書き出したいので、書き出しは自前で組み立てる。

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildWorkflow } from './build.mjs';
import { loadSchedule } from './schedule-file.mjs';

const SCHEDULE = fileURLToPath(new URL('./schedule.yml', import.meta.url));
const WORKFLOW = fileURLToPath(new URL('./.github/workflows/post.yml', import.meta.url));
const DOW = ['日', '月', '火', '水', '木', '金', '土'];

const HEADER = `# 投稿ルール
# このファイルは管理画面（npm start）から書き換えられます。
# 手で直すこともできますが、直したあとは「node build.mjs」を実行してください。
`;

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** 展開済みの日時を、YAML に書く文字列に戻す */
export function whenToText(when) {
  const time = `${pad(when.hour)}:${pad(when.minute)}`;
  if (when.kind === 'daily') return `毎日 ${time}`;
  if (when.kind === 'dow') return `${DOW[when.dow]} ${time}`;
  return `${ymd(when.date)} ${time}`;
}

export const readRules = () => loadSchedule(SCHEDULE);

/** ルール一覧を保存し、GitHub Actions の実行時刻も作り直す */
export function writeRules(rules) {
  writeFileSync(SCHEDULE, HEADER + rules.map(serializeRule).join('\n'), 'utf8');
  const saved = loadSchedule(SCHEDULE); // 書き出したものを読み直して確かめる
  writeFileSync(WORKFLOW, buildWorkflow(saved), 'utf8');
  return saved;
}

function serializeRule(rule) {
  const lines = [`- 名前: ${quote(rule.名前)}`];
  if (rule.期間.from) lines.push(`  期間: ${ymd(rule.期間.from)} 〜 ${ymd(rule.期間.to)}`);
  if (rule.優先 !== 'ふつう') lines.push(`  優先: ${rule.優先}`);
  if (rule.除外.size) {
    lines.push('  投稿しない:');
    for (const k of [...rule.除外].sort()) lines.push(`    - "${k}"`); // 日付として解釈されないよう引用符で囲む
  }
  lines.push('  投稿:');

  for (const post of rule.投稿) {
    lines.push(`    - 日時: ${whenToText(post.日時)}`);
    lines.push(`      対象日: ${post.対象日}`);
    lines.push(`      祝日なら休む: ${post.祝日なら休む ? 'はい' : 'いいえ'}`);
    if (post.画像) lines.push(`      画像: ${post.画像}`);
    lines.push('      本文: |');
    for (const line of post.本文.split('\n')) lines.push(line ? `        ${line}` : '');
  }
  return lines.join('\n') + '\n';
}

// 「名前」に YAML の記号が入っても壊れないようにする
const quote = (s) => (/^[^-?:,[\]{}#&*!|>'"%@`\s][^:#]*$/.test(s) ? s : JSON.stringify(s));
