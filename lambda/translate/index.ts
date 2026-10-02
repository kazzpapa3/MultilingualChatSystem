import {
  TranslateClient,
  TranslateTextCommand,
} from '@aws-sdk/client-translate';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from 'aws-lambda';

/**
 * CTF向け多言語チャット 翻訳Lambda (方式1: Outgoing Webhook)
 *
 * フロー:
 *   Mattermost 指定チャンネルへの投稿
 *     -> Outgoing Webhook (application/x-www-form-urlencoded)
 *     -> API Gateway -> この Lambda
 *     -> Amazon Translate (SourceLanguageCode=auto で言語自動判定)
 *     -> 残り2言語へ翻訳
 *     -> Outgoing Webhook のレスポンスとして翻訳文を返す
 *        (レスポンス投稿はWebhookを再発火させないためループしない)
 *
 * 補足:
 *   - Translate の auto 判定は内部で Amazon Comprehend を利用するため、
 *     Comprehend 対応リージョン(例: ap-northeast-1)で動作させること。
 */

const REGION = process.env.AWS_REGION ?? 'ap-northeast-1';
const translate = new TranslateClient({ region: REGION });
const secrets = new SecretsManagerClient({ region: REGION });

// Outgoing Webhook 検証トークンを保持するSecretのARN/名前 (CDKが環境変数で注入)
const TOKEN_SECRET_ID = process.env.OUTGOING_TOKEN_SECRET_ID ?? '';

// Mattermost Incoming Webhook URL を保持するSecretのARN (CDKが環境変数で注入)
const INCOMING_WEBHOOK_SECRET_ID =
  process.env.INCOMING_WEBHOOK_SECRET_ID ?? '';

// 取得値を実行環境にキャッシュ。ただしPC常時ウォーム環境でSecret更新が
// 反映されるよう短いTTL(60秒)を設ける。
const CACHE_TTL_MS = 60_000;
let cachedToken: string | undefined;
let cachedTokenAt = 0;
let cachedWebhookUrl: string | undefined;
let cachedWebhookUrlAt = 0;

async function getExpectedToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken !== undefined && now - cachedTokenAt < CACHE_TTL_MS) {
    return cachedToken;
  }
  if (!TOKEN_SECRET_ID) {
    cachedToken = '';
    cachedTokenAt = now;
    return cachedToken;
  }
  const res = await secrets.send(
    new GetSecretValueCommand({ SecretId: TOKEN_SECRET_ID }),
  );
  cachedToken = res.SecretString ?? '';
  cachedTokenAt = now;
  return cachedToken;
}

async function getIncomingWebhookUrl(): Promise<string> {
  const now = Date.now();
  if (
    cachedWebhookUrl !== undefined &&
    now - cachedWebhookUrlAt < CACHE_TTL_MS
  ) {
    return cachedWebhookUrl;
  }
  if (!INCOMING_WEBHOOK_SECRET_ID) {
    cachedWebhookUrl = '';
    cachedWebhookUrlAt = now;
    return cachedWebhookUrl;
  }
  const res = await secrets.send(
    new GetSecretValueCommand({ SecretId: INCOMING_WEBHOOK_SECRET_ID }),
  );
  const val = (res.SecretString ?? '').trim();
  // http(s) で始まらない値(プレースホルダ等)は未設定扱い
  cachedWebhookUrl = /^https?:\/\//.test(val) ? val : '';
  cachedWebhookUrlAt = now;
  return cachedWebhookUrl;
}

/**
 * Mattermost Incoming Webhook にメッセージを投稿する。
 * channel にはチャンネル名(表示名でなく name。例: 'qa')を指定する。
 */
async function postToMattermost(
  webhookUrl: string,
  channel: string,
  text: string,
): Promise<void> {
  const payload: Record<string, unknown> = { text };
  // channel 名が取れていれば元の投稿と同じチャンネルへ返す
  if (channel) payload.channel = channel;

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(
      `Incoming webhook POST failed: ${res.status} ${bodyText}`,
    );
  }
}

// 対応言語の定義。Translate の言語コードと表示ラベルを対応付ける。
interface Lang {
  code: string; // Amazon Translate 言語コード
  label: string; // Mattermost 投稿時の表示ラベル
}

const SUPPORTED_LANGS: Lang[] = [
  { code: 'ja', label: '🇯🇵 日本語' },
  { code: 'en', label: '🇺🇸 English' },
  { code: 'ko', label: '🇰🇷 한국어' },
];

/**
 * x-www-form-urlencoded のボディをパースする。
 * API Gateway が base64 エンコードしている場合も考慮。
 */
function parseFormBody(
  body: string | null,
  isBase64Encoded: boolean,
): Record<string, string> {
  if (!body) return {};
  const decoded = isBase64Encoded
    ? Buffer.from(body, 'base64').toString('utf-8')
    : body;
  const params = new URLSearchParams(decoded);
  const result: Record<string, string> = {};
  for (const [k, v] of params.entries()) {
    result[k] = v;
  }
  return result;
}

/**
 * Translate を使って text を targetCode へ翻訳する。
 * sourceCode に 'auto' を渡すと自動判定。
 */
async function translateText(
  text: string,
  sourceCode: string,
  targetCode: string,
): Promise<string> {
  const res = await translate.send(
    new TranslateTextCommand({
      Text: text,
      SourceLanguageCode: sourceCode,
      TargetLanguageCode: targetCode,
    }),
  );
  return res.TranslatedText ?? '';
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const form = parseFormBody(event.body, event.isBase64Encoded ?? false);

  // 1) トークン検証 (設定されている場合のみ)
  const expectedToken = await getExpectedToken();
  if (expectedToken && form.token !== expectedToken) {
    console.warn('Invalid outgoing webhook token');
    return { statusCode: 401, body: JSON.stringify({}) };
  }

  const text = (form.text ?? '').trim();
  const channelName = form.channel_name ?? '';

  // 2) 空メッセージはスキップ。
  //    Incoming Webhook の bot 投稿は Outgoing Webhook を再発火しないが、
  //    多重防御として空投稿はここで弾く。
  if (!text) {
    return { statusCode: 200, body: JSON.stringify({}) };
  }

  try {
    // 3) 言語を自動判定しつつ全対応言語へ翻訳。
    //    まず 'auto' で各ターゲットへ翻訳し、判定された元言語を取得する。
    //    Translate は翻訳結果に SourceLanguageCode を返すので、
    //    最初の1回で元言語を特定し、元言語と同じターゲットは除外する。
    const first = await translate.send(
      new TranslateTextCommand({
        Text: text,
        SourceLanguageCode: 'auto',
        TargetLanguageCode: SUPPORTED_LANGS[0].code,
      }),
    );
    const detectedSource = first.SourceLanguageCode ?? '';

    // 4) 元言語以外のターゲット言語を決定
    const targets = SUPPORTED_LANGS.filter(
      (l) => l.code !== detectedSource,
    );

    // 検出された元言語が対応言語3つに含まれない場合は、
    // 全言語へ翻訳する(フォールバック)。
    const effectiveTargets =
      targets.length === SUPPORTED_LANGS.length
        ? SUPPORTED_LANGS
        : targets;

    // 5) 各ターゲットへ翻訳 (並列実行)
    const translations = await Promise.all(
      effectiveTargets.map(async (lang) => {
        // first で既に取得済みのターゲットは再利用して無駄な呼び出しを避ける
        if (
          lang.code === SUPPORTED_LANGS[0].code &&
          detectedSource !== SUPPORTED_LANGS[0].code
        ) {
          return { lang, text: first.TranslatedText ?? '' };
        }
        const translated = await translateText(
          text,
          detectedSource || 'auto',
          lang.code,
        );
        return { lang, text: translated };
      }),
    );

    // 6) 言語ラベル付きで整形。
    const lines = translations
      .filter((t) => t.text.trim().length > 0)
      .map((t) => `**${t.lang.label}**\n${t.text}`);

    if (lines.length === 0) {
      return { statusCode: 200, body: JSON.stringify({}) };
    }

    const postText = lines.join('\n\n');

    // 7) Mattermost の Incoming Webhook へ能動的に投稿する。
    //    (Outgoing Webhook のレスポンス投稿方式は環境依存で動作しないため、
    //     確実な Incoming Webhook 方式を採用)
    const webhookUrl = await getIncomingWebhookUrl();
    if (!webhookUrl) {
      console.error(
        'INCOMING_WEBHOOK_SECRET_ID is not configured or empty',
      );
      return { statusCode: 200, body: JSON.stringify({}) };
    }

    await postToMattermost(webhookUrl, channelName, postText);

    // Outgoing Webhook への応答は空(=レスポンスでは投稿させない)
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    };
  } catch (err) {
    console.error('Translation or post failed', err);
    // エラー時はチャンネルを汚さないよう空レスポンス
    return { statusCode: 200, body: JSON.stringify({}) };
  }
};
