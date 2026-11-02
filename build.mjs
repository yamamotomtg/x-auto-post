// schedule.yml を点検し、GitHub Actions の実行時刻（.github/workflows/post.yml）を作り直す。
//
//   node build.mjs            点検して post.yml を作り直す
//   node build.mjs --check    点検のみ。post.yml が古いままなら失敗する（毎朝の自動点検用）
//   node build.mjs --preview  今後の投稿予定を表示する

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { occurrences, addDays, label, jstNow, weightedLength } from './rules.mjs';
import { loadSchedule } from './schedule-file.mjs';

const WORKFLOW = fileURLToPath(new URL('./.github/workflows/post.yml', import.meta.url));
const PREVIEW_DAYS = 70;
const MAX_LENGTH = 280;

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv[2] ?? '');

function main(mode) {
  const rules = loadSchedule();
  const today = jstNow().date;
  const { posts, skipped, conflicts } = occurrences(rules, today, addDays(today, PREVIEW_DAYS));
  const { problems, warnings } = inspect(rules, posts, conflicts);

  for (const w of warnings) console.log(`⚠ ${w}`);
  for (const p of problems) console.error(`✗ ${p}`);

  if (mode === '--preview') {
    printPreview(posts, skipped);
    process.exit(problems.length ? 1 : 0);
  }

  const generated = buildWorkflow(rules);

  if (mode === '--check') {
    const current = existsSync(WORKFLOW) ? readFileSync(WORKFLOW, 'utf8') : '';
    if (current !== generated) {
      console.error('\n✗ 実行時刻の設定が schedule.yml と合っていません。「node build.mjs」を実行し直してください。');
      process.exit(1);
    }
    if (problems.length) process.exit(1);
    console.log('\n✓ 設定は最新です。');
    return;
  }

  if (problems.length) {
    console.error('\n✗ 問題があるため、実行時刻の設定は作り直していません。');
    process.exit(1);
  }
  writeFileSync(WORKFLOW, generated);
  console.log('\n✓ .github/workflows/post.yml を作り直しました。');
  printPreview(posts, skipped);
}

/** 本文の長さ・画像の有無・本文の重複・ルールの競合を調べる */
export function inspect(rules, posts, conflicts) {
  const problems = [];
  const warnings = [];

  for (const rule of rules) {
    for (const post of rule.投稿) {
      if (post.画像 && !existsSync(fileURLToPath(new URL(`./images/${post.画像}`, import.meta.url)))) {
        problems.push(`${post.where}: 画像 images/${post.画像} が見つかりません。`);
      }
    }
  }
  for (const p of posts) {
    const n = weightedLength(p.本文);
    if (n > MAX_LENGTH) problems.push(`${p.post.where}: 本文が ${n}/${MAX_LENGTH} 字で長すぎます。`);
  }

  // X は同じ本文の投稿を拒否することがある
  const seen = new Map();
  for (const p of posts) {
    const prev = seen.get(p.本文);
    if (prev && p.at - prev.at < 14 * 86400e3) {
      warnings.push(`${label(prev.投稿日)} ${prev.時刻} と ${label(p.投稿日)} ${p.時刻} の本文が同じです（Xに拒否される可能性があります）。`);
    }
    seen.set(p.本文, p);
  }
  for (const c of conflicts) {
    const names = (list) => list.map((i) => i.rule.名前).join('・');
    warnings.push(
      `${label(c.winners[0].投稿日)} ${c.winners[0].時刻} が重なっています → 投稿: ${names(c.winners)} / 見送り: ${names(c.losers)}`,
    );
  }
  return { problems, warnings };
}

function printPreview(posts, skipped) {
  console.log(`\n今後${PREVIEW_DAYS}日間の投稿予定（${posts.length}件）:`);
  for (const p of posts) {
    console.log(`  ${label(p.投稿日)} ${p.時刻}  ${p.rule.名前}${p.画像 ? `  [${p.画像}]` : ''}`);
  }
  if (skipped.length) {
    console.log(`\n祝日のため見送る投稿（${skipped.length}件）:`);
    for (const s of skipped) console.log(`  ${label(s.投稿日)} ${s.時刻}  ${s.rule.名前} … ${s.理由}`);
  }
}

export function buildWorkflow() {
  return `# このファイルは build.mjs が作ります。手で編集せず、schedule.yml を直してから
# 「node build.mjs」を実行してください。
name: 自動投稿

# ふだんの定期投稿は Cloudflare が行います。ここは手動で投稿・確認するためのものです。
on:
  workflow_dispatch:
    inputs:
      dry_run:
        description: '投稿せずに、投稿予定と本文の確認だけする'
        type: boolean
        default: true
      force:
        description: '時刻を待たずにすぐ実行する（テスト用）'
        type: boolean
        default: true
      media_test:
        description: '投稿せずに、書き込み権限があるかだけ確かめる'
        type: boolean
        default: false

permissions:
  contents: read

concurrency:
  group: x-auto-post

jobs:
  post:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: node post.mjs
        env:
          X_API_KEY: \${{ secrets.X_API_KEY }}
          X_API_SECRET: \${{ secrets.X_API_SECRET }}
          X_ACCESS_TOKEN: \${{ secrets.X_ACCESS_TOKEN }}
          X_ACCESS_TOKEN_SECRET: \${{ secrets.X_ACCESS_TOKEN_SECRET }}
          DRY_RUN: \${{ inputs.dry_run }}
          FORCE: \${{ inputs.force }}
          MEDIA_TEST: \${{ inputs.media_test }}
`;
}
