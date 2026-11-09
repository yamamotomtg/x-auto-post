// X API の呼び出し（OAuth 1.0a）。
// パソコン（Node）でも Cloudflare でも動くよう、標準の暗号機能だけを使う。

const ME_URL = 'https://api.x.com/2/users/me';
const UPLOAD_URL = 'https://api.x.com/2/media/upload';
const TWEET_URL = 'https://api.x.com/2/tweets';

export class XApiError extends Error {
  constructor(status, method, url, body) {
    super(`X API エラー ${status} ${method} ${url}\n${body}`);
    this.status = status;
    this.body = body;
  }
  /** 同じ内容がすでに投稿されている場合 */
  get 重複() {
    return /duplicate/i.test(this.body);
  }
}

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** 署名のもとになる文字列。URL のクエリは署名に含め、URL 自体はクエリを除いた形で使う。 */
export function 署名のもと(method, url, oauthParams) {
  const { origin, pathname, searchParams } = new URL(url);
  const すべて = { ...oauthParams, ...Object.fromEntries(searchParams) };
  const paramString = Object.keys(すべて).sort().map((k) => `${enc(k)}=${enc(すべて[k])}`).join('&');
  return [method, enc(origin + pathname), enc(paramString)].join('&');
}

async function hmacSha1(鍵, 文字列) {
  const bytes = new TextEncoder().encode(文字列);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(鍵), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
  return btoa(String.fromCharCode(...sig));
}

const nonce = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

async function oauthHeader(method, url, keys) {
  const oauth = {
    oauth_consumer_key: keys.apiKey,
    oauth_nonce: nonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: keys.accessToken,
    oauth_version: '1.0',
  };
  const 署名鍵 = `${enc(keys.apiSecret)}&${enc(keys.accessTokenSecret)}`;
  oauth.oauth_signature = await hmacSha1(署名鍵, 署名のもと(method, url, oauth));
  return `OAuth ${Object.keys(oauth).sort().map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(', ')}`;
}

/** 4つのキーから、X API を呼ぶための道具を作る */
export function xClient(keys) {
  const 足りないキー = Object.entries(keys).filter(([, v]) => !v).map(([k]) => k);
  if (足りないキー.length) throw new Error(`X API のキーが設定されていません: ${足りないキー.join(', ')}`);

  const call = async (method, url, body, contentType) => {
    const headers = { Authorization: await oauthHeader(method, url, keys) };
    if (contentType) headers['Content-Type'] = contentType;
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(60e3) });
    const raw = await res.text();
    if (!res.ok) throw new XApiError(res.status, method, url, raw);
    return JSON.parse(raw);
  };

  return {
    /** ログインしているアカウント */
    me: () => call('GET', ME_URL),

    /** 画像をアップロードして媒体IDを返す（この時点では公開されない） */
    async 画像をあげる(バイト列, ファイル名) {
      const form = new FormData();
      form.append('media', new Blob([バイト列], { type: 画像の種類(ファイル名) }), ファイル名);
      form.append('media_category', 'tweet_image');
      return (await call('POST', UPLOAD_URL, form)).data.id;
    },

    /** 投稿する */
    async 投稿する(本文, 媒体ID) {
      const body = JSON.stringify({ text: 本文, ...(媒体ID ? { media: { media_ids: [媒体ID] } } : {}) });
      return (await call('POST', TWEET_URL, body, 'application/json')).data;
    },
  };
}

export function 画像の種類(名前) {
  if (/\.png$/i.test(名前)) return 'image/png';
  if (/\.gif$/i.test(名前)) return 'image/gif';
  return 'image/jpeg';
}

/** 環境変数・Cloudflare の設定から4つのキーを取り出す */
export const キーを読む = (env) => ({
  apiKey: env.X_API_KEY,
  apiSecret: env.X_API_SECRET,
  accessToken: env.X_ACCESS_TOKEN,
  accessTokenSecret: env.X_ACCESS_TOKEN_SECRET,
});
