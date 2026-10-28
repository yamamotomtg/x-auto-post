// schedule.yml を読み込み、「いつ・何を投稿するか」の一覧に展開する。
// 日付はすべて日本時間。JST の壁時計の日付を UTC の Date で表して扱う。

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { dateKey, holidayName } from './holidays.mjs';

const DOW = ['日', '月', '火', '水', '木', '金', '土'];
// 同じ時刻に重なったときの強さ
const RANK = new Map([['高', 2], ['ふつう', 1], ['低', 0]]);
const YES = new Set(['はい', 'する', 'true', true]);
const NO = new Set(['いいえ', 'しない', 'false', false]);

export const utcDate = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
export const addDays = (date, n) => new Date(date.getTime() + n * 86400e3);
export const label = (date) => `${date.getUTCMonth() + 1}月${date.getUTCDate()}日(${DOW[date.getUTCDay()]})`;

/** JST の「今」の日付（時刻を切り捨てた UTC の Date）と分 */
export function jstNow(now = Date.now()) {
  const t = new Date(now + 9 * 3600e3);
  return {
    date: utcDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()),
    minutes: t.getUTCHours() * 60 + t.getUTCMinutes(),
  };
}

/** JST の日付と「時:分」から、実際の時刻（UTC の瞬間）を求める */
export const instantOf = (date, hour, minute) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour - 9, minute));

export class ScheduleError extends Error {}
const fail = (where, message) => {
  throw new ScheduleError(`schedule.yml の「${where}」${message}`);
};

export function loadSchedule(path = process.env.SCHEDULE_FILE ?? new URL('./schedule.yml', import.meta.url)) {
  const doc = yaml.load(readFileSync(path, 'utf8'));
  if (doc == null) return [];
  if (!Array.isArray(doc)) throw new ScheduleError('schedule.yml はルールの一覧（先頭が "- 名前:" の形）で書いてください。');
  return doc.map(normalizeRule);
}

function normalizeRule(raw, i) {
  const 名前 = raw?.['名前'] ?? `${i + 1}番目のルール`;
  if (!raw || typeof raw !== 'object') fail(名前, 'の中身が読み取れません。');

  const 優先 = raw['優先'] ?? 'ふつう';
  if (!RANK.has(優先)) fail(名前, 'の「優先」は 高・ふつう・低 のどれかで書いてください。');

  const posts = raw['投稿'];
  if (!Array.isArray(posts) || posts.length === 0) fail(名前, 'に「投稿」がありません。');

  return {
    名前,
    期間: parsePeriod(raw['期間'], 名前),
    優先,
    投稿: posts.map((p, j) => normalizePost(p, raw, `${名前} の${j + 1}件目の投稿`)),
  };
}

function normalizePost(raw, rule, where) {
  if (!raw || typeof raw !== 'object') fail(where, 'の中身が読み取れません。');
  const 本文 = raw['本文'] ?? rule['本文'];
  if (typeof 本文 !== 'string' || !本文.trim()) fail(where, 'に「本文」がありません。');

  const 対象日 = raw['対象日'] ?? rule['対象日'] ?? '当日';
  if (!['当日', '翌日'].includes(対象日)) fail(where, 'の「対象日」は 当日 か 翌日 で書いてください。');

  const skip = raw['祝日なら休む'] ?? rule['祝日なら休む'] ?? false;
  if (!YES.has(skip) && !NO.has(skip)) fail(where, 'の「祝日なら休む」は はい か いいえ で書いてください。');

  return {
    日時: parseWhen(raw['日時'], where),
    対象日,
    祝日なら休む: YES.has(skip),
    本文: 本文.replace(/\r\n/g, '\n').trim(),
    画像: raw['画像'] ?? rule['画像'] ?? null,
    where,
  };
}

// 「日 21:00」「毎日 10:00」「2026-11-03 10:00」「11/3 10:00」
function parseWhen(value, where) {
  if (typeof value !== 'string') fail(where, 'に「日時」がありません。');
  const parts = value.replace(/[　]/g, ' ').trim().split(/\s+/);
  if (parts.length !== 2) fail(where, `の「日時」が読めません: ${value}（例: 日 21:00 / 毎日 10:00 / 11/3 10:00）`);

  const [day, time] = parts;
  const hm = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!hm) fail(where, `の時刻が読めません: ${time}（例: 21:00）`);
  const [hour, minute] = [Number(hm[1]), Number(hm[2])];
  if (hour > 23 || minute > 59) fail(where, `の時刻が範囲外です: ${time}`);

  if (day === '毎日') return { kind: 'daily', hour, minute };
  const dow = DOW.indexOf(day.replace(/曜日?$/, ''));
  if (dow >= 0) return { kind: 'dow', dow, hour, minute };

  const date = parseDate(day);
  if (!date) fail(where, `の日付が読めません: ${day}（例: 毎日 / 日 / 2026-11-03 / 11/3）`);
  return { kind: 'date', date, hour, minute };
}

function parseDate(value, year) {
  const s = String(value).trim();
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) return utcDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m && year) return utcDate(year, Number(m[1]), Number(m[2]));
  return null;
}

// 「2026-11-02 〜 2026-11-08」。省略なら期限なし。
function parsePeriod(value, where) {
  if (value == null) return { from: null, to: null };
  const parts = String(value).split(/\s*[〜~～]\s*|\s+から\s+|\s*--\s*/);
  if (parts.length !== 2) fail(where, `の「期間」が読めません: ${value}（例: 2026-11-02 〜 2026-11-08）`);
  const from = parseDate(parts[0]);
  const to = parseDate(parts[1]) ?? (from && parseDate(parts[1], from.getUTCFullYear()));
  if (!from || !to) fail(where, `の「期間」の日付が読めません: ${value}`);
  if (to < from) fail(where, `の「期間」の終わりが始まりより前です: ${value}`);
  return { from, to };
}

const activeOn = (rule, date) =>
  (!rule.期間.from || date >= rule.期間.from) && (!rule.期間.to || date <= rule.期間.to);

const matchesDay = (when, date) =>
  when.kind === 'daily' ||
  (when.kind === 'dow' && when.dow === date.getUTCDay()) ||
  (when.kind === 'date' && when.date.getTime() === date.getTime());

/**
 * 期間内に実際に投稿されるものを時刻順で返す。
 * 祝日で休むものは skipped に理由付きで入れる（投稿はしない）。
 */
export function occurrences(rules, fromDate, toDate) {
  const found = [];
  const skipped = [];

  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
    for (const rule of rules) {
      if (!activeOn(rule, d)) continue;
      for (const post of rule.投稿) {
        if (!matchesDay(post.日時, d)) continue;
        const target = post.対象日 === '翌日' ? addDays(d, 1) : d;
        const item = {
          at: instantOf(d, post.日時.hour, post.日時.minute),
          時刻: `${String(post.日時.hour).padStart(2, '0')}:${String(post.日時.minute).padStart(2, '0')}`,
          投稿日: d,
          対象日: target,
          rule,
          post,
          本文: render(post.本文, d, target),
          画像: post.画像,
          優先: rule.優先,
        };
        const holiday = post.祝日なら休む ? holidayName(dateKey(target)) : null;
        if (holiday) skipped.push({ ...item, 理由: `${label(target)}は${holiday}` });
        else found.push(item);
      }
    }
  }

  return { ...resolveConflicts(found), skipped };
}

/** 同じ時刻に複数ある場合、優先度がいちばん高いものだけを残す（同じ高さなら両方とも投稿する） */
function resolveConflicts(items) {
  const byTime = new Map();
  for (const item of items) {
    const k = item.at.getTime();
    byTime.set(k, [...(byTime.get(k) ?? []), item]);
  }

  const posts = [];
  const conflicts = [];
  for (const [, group] of [...byTime].sort(([a], [b]) => a - b)) {
    if (group.length === 1) {
      posts.push(group[0]);
      continue;
    }
    const 最高 = Math.max(...group.map((g) => RANK.get(g.優先)));
    const winners = group.filter((g) => RANK.get(g.優先) === 最高);
    const losers = group.filter((g) => RANK.get(g.優先) !== 最高);
    conflicts.push({ at: group[0].at, winners, losers });
    posts.push(...winners);
  }
  return { posts, conflicts };
}

function render(text, today, target) {
  return text
    .replaceAll('{{対象日}}', label(target))
    .replaceAll('{{今日}}', label(today))
    .trim();
}

// X の文字数カウント（twitter-text v3）：ラテン文字などは1、日本語などは2
export function weightedLength(s) {
  let n = 0;
  for (const ch of s.normalize('NFC')) {
    const c = ch.codePointAt(0);
    const light = c <= 0x10ff || (c >= 0x2000 && c <= 0x200d) || (c >= 0x2010 && c <= 0x201f) || (c >= 0x2032 && c <= 0x2037);
    n += light ? 1 : 2;
  }
  return n;
}

/** 画面から送られてきたルール（YAML と同じ形のオブジェクト）を点検して整える */
export const normalizeRules = (list) => list.map(normalizeRule);
