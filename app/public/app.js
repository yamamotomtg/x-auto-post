// 管理画面の動き。サーバー（app/server.mjs）とのやり取りと、登録の手順をあつかう。

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const 最大文字数 = 280;

let データ = null;
let 画面 = '予定';
let 編集中 = null; // { 番号, 下書き }
let 手順 = 1;

// ---------- サーバーとのやり取り ----------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.エラー ?? `通信に失敗しました（${res.status}）`);
  return data;
}

async function 読み込み() {
  データ = await api('GET', '/api/state');
  描画();
}

// ---------- 画面の切り替え ----------

function 描画() {
  $$('.tab').forEach((b) => b.classList.toggle('current', b.dataset.tab === 画面));
  $$('.tab-page').forEach((p) => (p.hidden = p.id !== 画面));
  $('#追加').hidden = 画面 === '編集';
  $('#お知らせ欄').innerHTML = 画面 === '編集' ? '' : 注意書き();
  描画未反映();
  if (画面 === '予定') 描画予定();
  if (画面 === 'ルール') 描画ルール();
}

function 切替(tab) {
  画面 = tab;
  描画();
}

function 注意書き() {
  const parts = [];
  if (データ.問題?.length) {
    parts.push(note('error', '直してください', データ.問題));
  }
  if (データ.競合?.length) {
    const lines = データ.競合.map(
      (c) => `${c.表示}：<b>${esc(c.投稿.join('・'))}</b> を投稿し、${esc(c.見送り.join('・'))} は見送ります`,
    );
    parts.push(note('info', '同じ時刻に重なっているもの', lines, true));
  }
  if (データ.注意?.length) parts.push(note('warn', '念のための確認', データ.注意));
  return parts.join('');
}

const note = (kind, title, lines, html = false) =>
  `<div class="note ${kind}"><h3>${esc(title)}</h3>${lines
    .map((l) => `<p>${html ? l : esc(l)}</p>`)
    .join('')}</div>`;

function 描画未反映() {
  const g = データ.git ?? {};
  const 件数 = (g.変更 ?? 0) + (g.未送信 ?? 0);
  const badge = $('#未反映');
  badge.hidden = !g.repo || 件数 === 0;
  badge.textContent = g.repo ? `GitHubに未反映の変更があります` : '';
  $('#反映').disabled = !g.repo || !g.remote;
  $('#反映').title = g.理由 ?? '';
}

// ---------- 投稿予定 ----------

function 描画予定() {
  const すべて = [...データ.予定, ...データ.見送り.map((s) => ({ ...s, 見送り: true }))].sort(
    (a, b) => (a.日付 + a.時刻).localeCompare(b.日付 + b.時刻),
  );
  if (!すべて.length) {
    $('#予定').innerHTML = '<p class="empty">まだ投稿の予定がありません。「＋ 新しいお知らせ」から登録してください。</p>';
    return;
  }

  let html = '<p class="hint">これから70日間の予定です。祝日で見送るものは薄く表示しています。</p>';
  let 前の日 = '';
  for (const p of すべて) {
    if (p.表示 !== 前の日) {
      html += `<div class="day">${esc(p.表示)}</div>`;
      前の日 = p.表示;
    }
    const 戻す = p.除外 ? 1 : 0;
    const 操作 =
      p.見送り && !p.除外
        ? ''
        : `<button class="ghost skip" data-rule="${p.ルール番号}" data-key="${esc(p.鍵)}" data-back="${戻す}">${
            戻す ? '投稿するように戻す' : 'この回は投稿しない'
          }</button>`;
    const 印 = !p.見送り
      ? ''
      : p.除外
        ? '<span class="tag off">投稿しない</span>'
        : '<span class="tag holiday">祝日のため投稿しない</span>';
    html += `<div class="card post${p.見送り ? ' skip' : ''}">
      <div class="time">${esc(p.時刻)}</div>
      <div class="text">${印 ? `<div>${印}</div>` : ''}${esc(p.本文)}
        <div class="meta">${esc(p.ルール名)}${p.見送り ? ` ／ ${esc(p.理由)}` : ''}</div>
      </div>
      ${p.画像 ? `<img class="thumb" src="/images/${encodeURIComponent(p.画像)}" alt="">` : ''}
      <div class="post-actions">${操作}</div>
    </div>`;
  }
  $('#予定').innerHTML = html;

  $$('.skip').forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          await api('POST', '/api/skip', { 番号: Number(b.dataset.rule), 鍵: b.dataset.key, 戻す: b.dataset.back === '1' });
          await 読み込み();
        } catch (e) {
          alert(e.message);
          b.disabled = false;
        }
      }),
  );
}

// ---------- お知らせ一覧 ----------

function 描画ルール() {
  if (!データ.ルール.length) {
    $('#ルール').innerHTML = '<p class="empty">お知らせがまだありません。</p>';
    return;
  }
  $('#ルール').innerHTML = データ.ルール
    .map(
      (r) => `<div class="card">
        <div class="rule-head">
          <h3>${esc(r.名前)}</h3>
          ${r.期間 ? `<span class="tag">${esc(r.期間.from)} 〜 ${esc(r.期間.to)}</span>` : '<span class="tag">ずっと</span>'}
          ${r.優先 === '高' ? '<span class="tag high">優先</span>' : ''}
          <span class="right">
            <button class="sub" data-edit="${r.番号}">編集</button>
            <button class="ghost" data-del="${r.番号}">削除</button>
          </span>
        </div>
        <ul class="rule-posts">${r.投稿
          .map(
            (p) =>
              `<li>${esc(p.日時)}　<span class="meta">${esc(p.対象日)}のこと${
                p.祝日なら休む ? '／祝日は休む' : ''
              }${p.画像 ? `／画像 ${esc(p.画像)}` : ''}</span><br>${esc(p.本文.split('\n')[0])}…</li>`,
          )
          .join('')}</ul>
      </div>`,
    )
    .join('');

  $$('[data-edit]').forEach((b) => (b.onclick = () => 編集開始(Number(b.dataset.edit))));
  $$('[data-del]').forEach((b) => (b.onclick = () => 削除(Number(b.dataset.del))));
}

async function 削除(番号) {
  const rule = データ.ルール[番号];
  if (!confirm(`「${rule.名前}」を削除します。よろしいですか。`)) return;
  データ = { ...データ, ...(await api('DELETE', '/api/rules', { 番号 })) };
  データ.git = (await api('GET', '/api/state')).git;
  描画();
}

// ---------- 登録・編集の手順 ----------

function 新規() {
  編集中 = {
    番号: null,
    下書き: { 名前: '', 種類: 'ずっと', 期間: { from: '', to: '' }, 優先: 'ふつう', タイミング: [新しいタイミング()] },
  };
  手順 = 1;
  画面 = '編集';
  描画();
  手順を描く();
}

function 編集開始(番号) {
  const r = データ.ルール[番号];
  編集中 = {
    番号,
    優先を決めた: true,
    下書き: {
      名前: r.名前,
      種類: r.期間 ? '期間' : 'ずっと',
      期間: r.期間 ?? { from: '', to: '' },
      優先: r.優先,
      除外: r.除外 ?? [],
      タイミング: r.投稿.map((p) => {
        const [日, 時刻] = p.日時.split(' ');
        const kind = 日 === '毎日' ? 'daily' : DOW.includes(日) ? 'dow' : 'date';
        return {
          kind,
          曜日: kind === 'dow' ? [DOW.indexOf(日)] : [],
          日付: kind === 'date' ? 日 : '',
          時刻,
          対象日: p.対象日,
          祝日なら休む: p.祝日なら休む,
          本文: p.本文,
          画像: p.画像 ?? '',
        };
      }),
    },
  };
  手順 = 1;
  画面 = '編集';
  描画();
  手順を描く();
}

const 新しいタイミング = () => ({
  kind: 'dow',
  曜日: [],
  日付: '',
  時刻: '21:00',
  対象日: '当日',
  祝日なら休む: false,
  本文: '',
  画像: '',
});

function 手順を描く() {
  $$('.steps li').forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle('current', n === 手順);
    li.classList.toggle('done', n < 手順);
  });
  $$('.step').forEach((s) => (s.hidden = Number(s.dataset.step) !== 手順));
  $('#戻る').hidden = 手順 === 1;
  $('#次へ').hidden = 手順 === 4;
  $('#登録').hidden = 手順 !== 4;

  const d = 編集中.下書き;
  if (手順 === 1) {
    $('#名前').value = d.名前;
    $$('input[name="種類"]').forEach((r) => (r.checked = r.value === d.種類));
    $('#期間欄').hidden = d.種類 !== '期間';
    $('#期間開始').value = d.期間.from ?? '';
    $('#期間終了').value = d.期間.to ?? '';
  }
  if (手順 === 2) タイミングを描く();
  if (手順 === 3) 本文を描く();
  if (手順 === 4) 確認を描く();
}

// --- 手順2：いつ投稿するか ---

function タイミングを描く() {
  const 一覧 = $('#タイミング一覧');
  一覧.innerHTML = '';
  編集中.下書き.タイミング.forEach((t, i) => {
    const el = $('#タイミング雛形').content.firstElementChild.cloneNode(true);
    $('.kind', el).value = t.kind;
    $('.time-input', el).value = t.時刻;
    $('.date-input', el).value = t.日付;
    $('.target', el).value = t.対象日;
    $('.holiday', el).checked = t.祝日なら休む;
    $$('.dows input', el).forEach((c) => (c.checked = t.曜日.includes(Number(c.value))));
    $('.dows', el).hidden = t.kind !== 'dow';
    $('.date-row', el).hidden = t.kind !== 'date';
    $('.del', el).hidden = 編集中.下書き.タイミング.length === 1;

    $('.kind', el).onchange = (e) => {
      t.kind = e.target.value;
      タイミングを描く();
    };
    $('.time-input', el).onchange = (e) => (t.時刻 = e.target.value);
    $('.date-input', el).onchange = (e) => (t.日付 = e.target.value);
    $('.target', el).onchange = (e) => (t.対象日 = e.target.value);
    $('.holiday', el).onchange = (e) => (t.祝日なら休む = e.target.checked);
    $$('.dows input', el).forEach(
      (c) =>
        (c.onchange = () => {
          const v = Number(c.value);
          t.曜日 = c.checked ? [...t.曜日, v].sort() : t.曜日.filter((x) => x !== v);
        }),
    );
    $('.del', el).onclick = () => {
      編集中.下書き.タイミング.splice(i, 1);
      タイミングを描く();
    };
    一覧.append(el);
  });
}

// --- 手順3：本文 ---

function 本文を描く() {
  const 一覧 = $('#本文一覧');
  一覧.innerHTML = '';
  編集中.下書き.タイミング.forEach((t) => {
    const el = $('#本文雛形').content.firstElementChild.cloneNode(true);
    $('.when', el).textContent = `${タイミング表示(t)}　（${t.対象日}のことを伝える投稿）`;
    const text = $('.text', el);
    const count = $('.count', el);
    const image = $('.image', el);
    const thumb = $('.thumb', el);

    text.value = t.本文;
    const 数える = () => {
      const n = 文字数(t.本文.replace(/\{\{対象日\}\}/g, '11月2日(月)'));
      count.textContent = `${n} / ${最大文字数} 文字`;
      count.classList.toggle('over', n > 最大文字数);
    };
    text.oninput = () => {
      t.本文 = text.value;
      数える();
    };
    数える();

    $('.insert', el).onclick = () => {
      const pos = text.selectionStart ?? text.value.length;
      text.value = text.value.slice(0, pos) + '{{対象日}}' + text.value.slice(text.selectionEnd ?? pos);
      t.本文 = text.value;
      text.focus();
      text.selectionStart = text.selectionEnd = pos + 8;
      数える();
    };

    const 画像を並べる = () => {
      image.innerHTML = '<option value="">なし</option>' + データ.画像.map((n) => `<option>${esc(n)}</option>`).join('');
      image.value = t.画像 ?? '';
      thumb.hidden = !image.value;
      if (image.value) thumb.src = `/images/${encodeURIComponent(image.value)}`;
    };
    画像を並べる();
    image.onchange = () => {
      t.画像 = image.value;
      画像を並べる();
    };

    $('.file', el).onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = await new Promise((done) => {
          const r = new FileReader();
          r.onload = () => done(r.result);
          r.readAsDataURL(file);
        });
        const res = await api('POST', '/api/images', { 名前: file.name, data });
        データ.画像 = res.画像;
        t.画像 = res.名前;
        画像を並べる();
      } catch (err) {
        alert(err.message);
      }
    };
    一覧.append(el);
  });
}

const タイミング表示 = (t) =>
  t.kind === 'daily'
    ? `毎日 ${t.時刻}`
    : t.kind === 'date'
      ? `${t.日付} ${t.時刻}`
      : `毎週${t.曜日.map((d) => DOW[d]).join('・')}曜日 ${t.時刻}`;

// --- 手順4：確認 ---

async function 確認を描く() {
  const box = $('#確認');
  box.innerHTML = '<p class="hint">確認しています…</p>';
  try {
    const 結果 = await api('POST', '/api/preview', { 番号: 編集中.番号, ルール: ルールを組み立てる() });
    const 名前 = 編集中.下書き.名前;
    const これの予定 = 結果.予定.filter((p) => p.ルール名 === 名前).slice(0, 6);
    const これの見送り = 結果.見送り.filter((p) => p.ルール名 === 名前).slice(0, 4);
    const 競合 = 結果.競合.filter((c) => [...c.投稿, ...c.見送り].includes(名前));

    // 重なりが見つかったときは、まず「これまでのお知らせを優先」で見せる
    if (競合.length && !編集中.優先を決めた) {
      編集中.優先を決めた = true;
      編集中.下書き.優先 = '低';
      return 確認を描く();
    }

    let html = '';
    if (結果.問題.length) html += note('error', '直してください', 結果.問題);
    if (競合.length) html += 競合の説明(競合, 名前);

    html += `<div class="card"><h3>投稿の予定</h3>
      <p class="hint">投稿しなくてよい回は「この回は投稿しない」で外せます。</p>${
        これの予定.length
          ? これの予定
              .map(
                (p) => `<div class="post">
                  <div class="time">${esc(p.表示)} ${esc(p.時刻)}</div>
                  <div class="text">${esc(p.本文)}</div>
                  <div class="post-actions"><button class="ghost draft-skip" data-key="${esc(p.鍵)}">この回は投稿しない</button></div>
                </div><hr>`,
              )
              .join('')
          : '<p class="hint">70日以内に投稿の予定はありません。期間や曜日の指定を確認してください。</p>'
      }</div>`;

    const 除外 = 結果.見送り.filter((p) => p.ルール名 === 名前 && p.除外);
    if (除外.length) {
      html += `<div class="card"><h3>投稿しない回（${除外.length}件）</h3>${除外
        .map(
          (p) => `<div class="post skip">
            <div class="time">${esc(p.表示)} ${esc(p.時刻)}</div>
            <div class="text meta">${esc(p.本文.split('\n')[0])}…</div>
            <div class="post-actions"><button class="sub draft-back" data-key="${esc(p.鍵)}">戻す</button></div>
          </div>`,
        )
        .join('')}</div>`;
    }

    if (これの見送り.length) {
      html += note(
        'info',
        '祝日のため見送る予定',
        これの見送り.map((p) => `${p.表示} ${p.時刻}（${p.理由}）`),
      );
    }
    box.innerHTML = html;

    $$('.draft-skip').forEach(
      (b) =>
        (b.onclick = () => {
          編集中.下書き.除外 = [...new Set([...編集中.下書き.除外, b.dataset.key])];
          確認を描く();
        }),
    );
    $$('.draft-back').forEach(
      (b) =>
        (b.onclick = () => {
          編集中.下書き.除外 = 編集中.下書き.除外.filter((k) => k !== b.dataset.key);
          確認を描く();
        }),
    );

    $$('[name="優先"]').forEach(
      (r) =>
        (r.onchange = () => {
          編集中.優先を決めた = true;
          編集中.下書き.優先 = r.value;
          確認を描く();
        }),
    );
    $('#登録').disabled = 結果.問題.length > 0;
  } catch (e) {
    box.innerHTML = note('error', '確認できませんでした', [e.message]);
    $('#登録').disabled = true;
  }
}

function 競合の説明(競合, 名前) {
  const 行 = 競合.map((c) => {
    if (!c.見送り.length) return `${c.表示}：<b>どちらも投稿します</b>（${esc(c.投稿.join('・'))}）`;
    return c.投稿.includes(名前)
      ? `${c.表示}：<b>このお知らせ</b>を投稿し、${esc(c.見送り.join('・'))} を見送ります`
      : `${c.表示}：<b>${esc(c.投稿.join('・'))}</b>を投稿し、このお知らせを見送ります`;
  });
  const 選ぶ = (値, 題, 説明) =>
    `<label class="choice"><input type="radio" name="優先" value="${値}" ${編集中.下書き.優先 === 値 ? 'checked' : ''}>
      <span><b>${題}</b><small>${説明}</small></span></label>`;
  const 選択 = `<div class="card"><h3>重なった時刻では、どうしますか</h3>
    ${選ぶ('低', 'これまでのお知らせを優先する', '重なった時刻では、このお知らせを見送ります')}
    ${選ぶ('高', 'このお知らせを優先する', '重なった時刻では、これまでのお知らせを見送ります')}
    ${選ぶ('ふつう', 'どちらも投稿する', '同じ時刻に2本続けて投稿されます')}
  </div>`;
  return note('warn', '同じ時刻に他のお知らせと重なっています', 行, true) + 選択;
}

// --- 組み立てと保存 ---

function ルールを組み立てる() {
  const d = 編集中.下書き;
  const 投稿 = [];
  for (const t of d.タイミング) {
    const 日付たち =
      t.kind === 'daily' ? ['毎日'] : t.kind === 'date' ? [t.日付] : t.曜日.map((x) => DOW[x]);
    for (const 日 of 日付たち) {
      投稿.push({
        日時: `${日} ${t.時刻}`,
        対象日: t.対象日,
        祝日なら休む: t.祝日なら休む,
        本文: t.本文,
        画像: t.画像 || undefined,
      });
    }
  }
  return {
    名前: d.名前.trim(),
    期間: d.種類 === '期間' ? { from: d.期間.from, to: d.期間.to } : null,
    優先: d.優先,
    投稿しない: d.除外,
    投稿,
  };
}

function 手順を確かめる() {
  const d = 編集中.下書き;
  if (手順 === 1) {
    if (!d.名前.trim()) return 'お知らせの名前を入れてください。';
    if (d.種類 === '期間' && (!d.期間.from || !d.期間.to)) return '期間の開始日と終了日を入れてください。';
    if (d.種類 === '期間' && d.期間.to < d.期間.from) return '終了日は開始日より後にしてください。';
  }
  if (手順 === 2) {
    if (!d.タイミング.length) return '投稿するタイミングを1つ以上追加してください。';
    for (const t of d.タイミング) {
      if (t.kind === 'dow' && !t.曜日.length) return '曜日を選んでください。';
      if (t.kind === 'date' && !t.日付) return '日付を入れてください。';
      if (!t.時刻) return '時刻を入れてください。';
    }
  }
  if (手順 === 3) {
    for (const t of d.タイミング) {
      if (!t.本文.trim()) return `${タイミング表示(t)} の文章が空です。`;
      if (文字数(t.本文.replace(/\{\{対象日\}\}/g, '11月2日(月)')) > 最大文字数) {
        return `${タイミング表示(t)} の文章が長すぎます。`;
      }
    }
  }
  return null;
}

async function 登録() {
  try {
    const ルール = ルールを組み立てる();
    const 結果 =
      編集中.番号 === null
        ? await api('POST', '/api/rules', { ルール })
        : await api('PUT', '/api/rules', { 番号: 編集中.番号, ルール });
    編集中 = null;
    await 読み込み();
    切替('予定');
    $('#お知らせ欄').insertAdjacentHTML(
      'afterbegin',
      note('done', '登録しました', ['「GitHubへ反映」を押すと、実際の自動投稿に反映されます。']),
    );
  } catch (e) {
    alert(e.message);
  }
}

// ---------- GitHubへ反映 ----------

async function 反映() {
  const btn = $('#反映');
  btn.disabled = true;
  btn.textContent = '反映中…';
  try {
    const 結果 = await api('POST', '/api/publish', {});
    データ.git = 結果.git;
    描画();
    $('#お知らせ欄').insertAdjacentHTML(
      'afterbegin',
      note('done', 'GitHubへ反映しました', ['数分以内に自動投稿の設定が切り替わります。']) +
        `<pre class="log">${esc(結果.結果)}</pre>`,
    );
  } catch (e) {
    $('#お知らせ欄').insertAdjacentHTML('afterbegin', note('error', '反映できませんでした', [e.message]));
  } finally {
    btn.textContent = 'GitHubへ反映';
    描画未反映();
  }
}

// ---------- そのほか ----------

function 文字数(s) {
  let n = 0;
  for (const ch of s.normalize('NFC')) {
    const c = ch.codePointAt(0);
    const 軽い =
      c <= 0x10ff || (c >= 0x2000 && c <= 0x200d) || (c >= 0x2010 && c <= 0x201f) || (c >= 0x2032 && c <= 0x2037);
    n += 軽い ? 1 : 2;
  }
  return n;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- 画面の操作 ----------

$$('.tab').forEach((b) => (b.onclick = () => 切替(b.dataset.tab)));
$('#追加').onclick = 新規;
$('#反映').onclick = 反映;
$('#やめる').onclick = () => {
  編集中 = null;
  切替('ルール');
};
$('#戻る').onclick = () => {
  手順--;
  手順を描く();
};
$('#次へ').onclick = () => {
  const 問題 = 手順を確かめる();
  if (問題) return alert(問題);
  手順++;
  手順を描く();
};
$('#登録').onclick = 登録;
$('#タイミング追加').onclick = () => {
  編集中.下書き.タイミング.push(新しいタイミング());
  タイミングを描く();
};
$('#名前').oninput = (e) => (編集中.下書き.名前 = e.target.value);
$('#期間開始').onchange = (e) => (編集中.下書き.期間.from = e.target.value);
$('#期間終了').onchange = (e) => (編集中.下書き.期間.to = e.target.value);
$$('input[name="種類"]').forEach(
  (r) =>
    (r.onchange = () => {
      編集中.下書き.種類 = r.value;
      $('#期間欄').hidden = r.value !== '期間';
    }),
);

読み込み().catch((e) => alert(`管理画面を読み込めませんでした: ${e.message}`));
