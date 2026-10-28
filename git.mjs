// GitHub への反映（git の呼び出し）。管理画面の「GitHubへ反映」から使う。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const cwd = fileURLToPath(new URL('.', import.meta.url));
const git = async (...args) => (await run('git', args, { cwd, windowsHide: true })).stdout.trim();

/** 反映できる状態か、未反映の変更がいくつあるかを調べる */
export async function status() {
  try {
    await git('rev-parse', '--git-dir');
  } catch {
    return { repo: false, 理由: 'このフォルダはまだ git で管理されていません。' };
  }

  const 変更 = (await git('status', '--porcelain')).split('\n').filter(Boolean);
  let remote = null;
  try {
    remote = await git('remote', 'get-url', 'origin');
  } catch {
    return { repo: true, remote: null, 変更: 変更.length, 未送信: 0, 理由: 'GitHub のリポジトリ（origin）がまだ設定されていません。' };
  }

  let 未送信 = 0;
  try {
    未送信 = Number(await git('rev-list', '--count', '@{u}..HEAD'));
  } catch {
    未送信 = Number(await git('rev-list', '--count', 'HEAD').catch(() => 0));
  }
  return { repo: true, remote: remote.replace(/\/\/[^@]*@/, '//'), 変更: 変更.length, 未送信 };
}

/** 変更をコミットして push する */
export async function publish(message) {
  const log = [];
  const step = async (...args) => log.push(`$ git ${args.join(' ')}\n${await git(...args)}`.trim());

  await step('add', '-A');
  const 変更 = (await git('status', '--porcelain')).split('\n').filter(Boolean);
  if (変更.length) await step('commit', '-m', message);
  else log.push('コミットする変更はありませんでした。');
  await step('push');
  return log.join('\n\n');
}
