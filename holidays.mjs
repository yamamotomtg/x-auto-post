// 日本の祝日・休日を計算で求める（「国民の祝日に関する法律」の2022年以降の規定）。
// 春分の日・秋分の日は近似式で求めている（正式な日付は前年2月の官報で発表。2099年まで有効）。

// [月, 日, 名称]
const FIXED = [
  [1, 1, '元日'],
  [2, 11, '建国記念の日'],
  [2, 23, '天皇誕生日'],
  [4, 29, '昭和の日'],
  [5, 3, '憲法記念日'],
  [5, 4, 'みどりの日'],
  [5, 5, 'こどもの日'],
  [8, 11, '山の日'],
  [11, 3, '文化の日'],
  [11, 23, '勤労感謝の日'],
];

// [月, 第n月曜日, 名称]
const HAPPY_MONDAY = [
  [1, 2, '成人の日'],
  [7, 3, '海の日'],
  [9, 3, '敬老の日'],
  [10, 2, 'スポーツの日'],
];

const pad = (n) => String(n).padStart(2, '0');
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const addDays = (date, n) => new Date(date.getTime() + n * 86400e3);
export const dateKey = (date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

const cache = new Map();

/** その年の祝日・休日を Map<'YYYY-MM-DD', 名称> で返す */
export function holidaysOf(year) {
  if (year < 2022 || year > 2099) {
    throw new RangeError(`${year}年の祝日は計算できません（2022〜2099年のみ対応）`);
  }
  if (cache.has(year)) return cache.get(year);

  const base = new Map();
  for (const [m, d, name] of FIXED) base.set(dateKey(utc(year, m, d)), name);
  for (const [m, n, name] of HAPPY_MONDAY) {
    const firstDow = utc(year, m, 1).getUTCDay();
    base.set(dateKey(utc(year, m, 1 + ((8 - firstDow) % 7) + (n - 1) * 7)), name);
  }
  const t = year - 1980;
  base.set(dateKey(utc(year, 3, Math.floor(20.8431 + 0.242194 * t - Math.floor(t / 4)))), '春分の日');
  base.set(dateKey(utc(year, 9, Math.floor(23.2488 + 0.242194 * t - Math.floor(t / 4)))), '秋分の日');

  const all = new Map(base);

  // 国民の休日：前日と翌日が祝日に挟まれた日
  for (let d = utc(year, 1, 2); d.getUTCFullYear() === year; d = addDays(d, 1)) {
    const k = dateKey(d);
    if (!base.has(k) && d.getUTCDay() !== 0 && base.has(dateKey(addDays(d, -1))) && base.has(dateKey(addDays(d, 1)))) {
      all.set(k, '国民の休日');
    }
  }

  // 振替休日：祝日が日曜なら、その後の最初の「祝日でない日」が休日
  for (const k of [...base.keys()].sort()) {
    const d = new Date(`${k}T00:00:00Z`);
    if (d.getUTCDay() !== 0) continue;
    let s = addDays(d, 1);
    while (all.has(dateKey(s))) s = addDays(s, 1);
    all.set(dateKey(s), '振替休日');
  }

  const sorted = new Map([...all].sort(([a], [b]) => (a < b ? -1 : 1)));
  cache.set(year, sorted);
  return sorted;
}

/** 'YYYY-MM-DD' が祝日・休日なら名称、そうでなければ null */
export function holidayName(key) {
  return holidaysOf(Number(key.slice(0, 4))).get(key) ?? null;
}
