// 管理画面のサーバー。 起動: npm start → http://localhost:8787
// このPCの中だけで動きます（外からは繋がりません）。

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from '../build.mjs';
import { ScheduleError, normalizeRules, occurrences, addDays, label, jstNow, weightedLength } from '../rules.mjs';
import { readRules, writeRules, whenToText } from '../storage.mjs';
import * as git from '../git.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const PREVIEW_DAYS = 70;
const MAX_BODY = 8 * 1024 * 1024;
const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif' };
const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const IMAGES = fileURLToPath(new URL('../images/', import.meta.url));

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** 保存されているルール → 画面に渡す形 */
const toApi = (rule, i) => ({
  番号: i,
  名前: rule.名前,
  期間: rule.期間.from ? { from: ymd(rule.期間.from), to: ymd(rule.期間.to) } : null,
  優先: rule.優先,
  投稿: rule.投稿.map((p) => ({
    日時: whenToText(p.日時),
    対象日: p.対象日,
    祝日なら休む: p.祝日なら休む,
    本文: p.本文,
    画像: p.画像,
    文字数: weightedLength(p.本文),
  })),
});

/** 画面から来た形・保存されている形 → ルールを読み取る元の形（YAML と同じ） */
const toRaw = (rule) => ({
  名前: rule.名前,
  期間: rule.期間?.from ? `${rule.期間.from} 〜 ${rule.期間.to}` : undefined,
  優先: rule.優先 ?? 'ふつう',
  投稿: (rule.投稿 ?? []).map((p) => ({
    日時: typeof p.日時 === 'string' ? p.日時 : whenToText(p.日時),
    対象日: p.対象日 ?? '当日',
    祝日なら休む: (typeof p.祝日なら休む === 'string' ? p.祝日なら休む === 'はい' : p.祝日なら休む) ? 'はい' : 'いいえ',
    本文: p.本文,
    画像: p.画像 || undefined,
  })),
});

/** ルール一覧から、今後の予定・競合・注意点をまとめる */
function summarize(rules) {
  const today = jstNow().date;
  const { posts, skipped, conflicts } = occurrences(rules, today, addDays(today, PREVIEW_DAYS));
  const { problems, warnings } = inspect(rules, posts, conflicts);
  const view = (p) => ({
    日付: ymd(p.投稿日),
    表示: label(p.投稿日),
    時刻: p.時刻,
    ルール名: p.rule.名前,
    本文: p.本文,
    画像: p.画像,
    文字数: weightedLength(p.本文),
    理由: p.理由,
  });
  return {
    予定: posts.map(view),
    見送り: skipped.map(view),
    競合: conflicts.map((c) => ({
      表示: `${label(c.winners[0].投稿日)} ${c.winners[0].時刻}`,
      投稿: c.winners.map((w) => w.rule.名前),
      見送り: c.losers.map((l) => l.rule.名前),
    })),
    注意: warnings,
    問題: problems,
  };
}

const routes = {
  'GET /api/state': async () => {
    const rules = readRules();
    return { ルール: rules.map(toApi), ...summarize(rules), 画像: await imageList(), git: await git.status() };
  },

  // 保存せずに、登録したらどうなるかだけ見る
  'POST /api/preview': async (body) => {
    const rules = replaceAt(readRules().map(toRaw), body.番号, toRaw(body.ルール));
    return summarize(normalizeRules(rules));
  },

  'POST /api/rules': async (body) => {
    const rules = [...readRules().map(toRaw), toRaw(body.ルール)];
    return save(rules);
  },

  'PUT /api/rules': async (body) => {
    const rules = replaceAt(readRules().map(toRaw), body.番号, toRaw(body.ルール));
    return save(rules);
  },

  'DELETE /api/rules': async (body) => {
    const rules = readRules().map(toRaw).filter((_, i) => i !== body.番号);
    return save(rules);
  },

  'POST /api/images': async (body) => {
    const name = basename(String(body.名前 ?? '')).replace(/[^\w.\-]/g, '_');
    if (!IMAGE_TYPES[extname(name).toLowerCase()]) throw new ScheduleError('画像は jpg・png・gif のみ使えます。');
    const data = Buffer.from(String(body.data ?? '').split(',').pop(), 'base64');
    if (!data.length) throw new ScheduleError('画像が空です。');
    if (data.length > 5 * 1024 * 1024) throw new ScheduleError('画像は5MBまでにしてください。');
    await writeFile(IMAGES + name, data);
    return { 名前: name, 画像: await imageList() };
  },

  'POST /api/publish': async (body) => ({
    結果: await git.publish(body.message || `投稿ルールの更新（${new Date().toLocaleString('ja-JP')}）`),
    git: await git.status(),
  }),
};

function save(rawRules) {
  const rules = writeRules(normalizeRules(rawRules));
  return { ルール: rules.map(toApi), ...summarize(rules) };
}

const replaceAt = (list, i, item) =>
  Number.isInteger(i) && i >= 0 && i < list.length ? list.map((x, j) => (j === i ? item : x)) : [...list, item];

async function imageList() {
  const names = await readdir(IMAGES).catch(() => []);
  return names.filter((n) => IMAGE_TYPES[extname(n).toLowerCase()]).sort();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, type, body) => res.writeHead(code, { 'Content-Type': type }).end(body);

  try {
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
      const body = req.method === 'GET' ? {} : JSON.parse((await readBody(req)) || '{}');
      return send(200, 'application/json; charset=utf-8', JSON.stringify(await route(body)));
    }
    if (req.method !== 'GET') return send(404, 'application/json', '{}');

    if (url.pathname.startsWith('/images/')) {
      const name = basename(decodeURIComponent(url.pathname));
      const type = IMAGE_TYPES[extname(name).toLowerCase()];
      if (!type) return send(404, 'text/plain', 'not found');
      return send(200, type, await readFile(IMAGES + name));
    }

    const file = url.pathname === '/' ? 'index.html' : basename(decodeURIComponent(url.pathname));
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    const type = types[extname(file).toLowerCase()];
    if (!type) return send(404, 'text/plain', 'not found');
    send(200, type, await readFile(PUBLIC + file));
  } catch (e) {
    if (e?.code === 'ENOENT') return send(404, 'text/plain', 'not found');
    const 入力ミス = e instanceof ScheduleError;
    if (!入力ミス) console.error(e);
    send(入力ミス ? 400 : 500, 'application/json; charset=utf-8', JSON.stringify({ エラー: String(e.message ?? e) }));
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY) reject(new ScheduleError('送信されたデータが大きすぎます。'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const URL_ = `http://localhost:${PORT}`;

server.listen(PORT, '127.0.0.1', () => {
  console.log(`管理画面を開きました → ${URL_}`);
  console.log('終了するには Ctrl+C を押すか、このウィンドウを閉じてください。');
  ブラウザで開く();
});

// すでに起動している場合は、二重に立ち上げずそちらを開く
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.log(`管理画面はすでに起動しています → ${URL_}`);
  ブラウザで開く();
  process.exit(0);
});

function ブラウザで開く() {
  if (process.env.OPEN_BROWSER === 'false') return;
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', URL_]]
      : process.platform === 'darwin'
        ? ['open', [URL_]]
        : ['xdg-open', [URL_]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
