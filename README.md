# CTF向け 多言語対応チャットシステム (Mattermost + Amazon Translate)

CTF 大会のコミュニケーション補助を目的とした、**使い捨て前提**の多言語チャット基盤です。
OSS チャット **Mattermost** を AWS 上に構築し、**Amazon Translate** と連携して
日本語・英語・韓国語を相互に自動翻訳します。指定したチャンネルにいずれかの言語で
投稿すると、残り 2 言語に翻訳された内容が **Bot による後追いメッセージ**として投稿されます。

- リージョン: **東京 (ap-northeast-1)** を想定
- 想定規模: 最大 100 名程度
- ライフサイクル: イベント時に `cdk deploy` → 終了後に `cdk destroy` で**丸ごと削除**

アーキテクチャ図は [`docs/architecture.drawio`](docs/architecture.drawio) を参照してください
(draw.io / VSCode の Draw.io Integration 拡張で開けます)。

---

## 構成

| 層 | リソース | 役割 |
|---|---|---|
| ネットワーク | VPC (2AZ) + NAT Gateway ×1 | 使い捨て用途のためコスト優先で NAT は 1 つ |
| チャット基盤 | ECS Fargate + ALB | Mattermost (`mattermost-team-edition:9.11`) |
| データストア | Aurora Serverless v2 (PostgreSQL 15.10) | Mattermost の DB。0.5〜4 ACU |
| 翻訳連携 | API Gateway (REST) + Lambda + Amazon Translate | Outgoing Webhook を受けて翻訳 |
| 投稿 | Mattermost Incoming Webhook | 翻訳文を Bot として対象チャンネルへ投稿 |
| 機密情報 | Secrets Manager | DB 認証情報 / Outgoing Webhook 検証トークン / Incoming Webhook URL |

### 翻訳フロー

```
Mattermost 指定チャンネルへの投稿
  → Outgoing Webhook (x-www-form-urlencoded)
  → API Gateway → Lambda
  → Amazon Translate (SourceLanguageCode=auto で言語自動判定 → 残り2言語へ翻訳)
  → Lambda が Mattermost Incoming Webhook を呼び出して翻訳文を投稿
     (元投稿と同じチャンネルへ、言語ラベル付きの別メッセージ)
```

- **投稿方式**: Lambda が翻訳後、Mattermost の **Incoming Webhook** を呼び出して
  能動的に投稿します。投稿先は Outgoing Webhook が渡す `channel_name` を使い、
  元投稿と同じチャンネルへ返します。Outgoing Webhook への HTTP レスポンスは
  空 (`{}`) を返し、レスポンス経由では投稿しません。
- **ループ防止**: Incoming Webhook による Bot 投稿は Outgoing Webhook を
  再発火させません。加えて Lambda 側でも空メッセージをスキップします。
- **言語判定**: Translate の `auto` 判定は内部で Amazon Comprehend を使うため、
  Comprehend 対応リージョン（東京など）で動かす必要があります。
- **トークン/URL のキャッシュ**: Lambda は Outgoing Webhook 検証トークンと
  Incoming Webhook URL を Secrets Manager から取得し、実行環境に **60 秒 TTL** で
  キャッシュします。Secret を更新しても最大 60 秒で反映されます。

---

## 前提

- Node.js 18 以上 (検証環境は v22)
- AWS CLI がセットアップ済みで、デプロイ先アカウントの認証情報が利用可能なこと
- Docker は不要 (Lambda バンドルは esbuild。コンテナは公式イメージを ECR 経由せず利用)
- 対象アカウント/リージョンで CDK ブートストラップ済みであること

> リセラー運用の補足: AWS 請求代行サービスのエンドカスタマー環境へ構築する場合、
> `aws login`(例: `--profile awslogin2`) で踏み台アカウントの認証情報を取得し、
> 対象アカウントへ AssumeRole した**書き込み可能なロール**で実行してください
> (`ServerworksControlRoleRO` は ReadOnly のためデプロイ不可)。

---

## デプロイ手順

```bash
# 1. 依存インストール
npm install

# 2. (初回のみ) CDK ブートストラップ
npx cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-1

# 3. 合成して内容確認 (任意)
npx cdk synth

# 4. デプロイ
npx cdk deploy
```

デプロイ完了後、以下が **Outputs** に表示されます。

| Output | 用途 |
|---|---|
| `MattermostUrl` | Mattermost の URL (ALB の DNS 名) |
| `TranslateWebhookUrl` | Outgoing Webhook のコールバック先に設定する URL |
| `OutgoingTokenSecretName` | Outgoing Webhook トークンが入った Secret 名 |
| `IncomingWebhookSecretName` | Incoming Webhook URL を設定する Secret 名 |

> ALB はヘルスチェック (`/api/v4/system/ping`) が通るまで数分かかります。
> Mattermost 初回起動時に DB スキーマが自動作成されます。

---

## Mattermost の初期設定

### 1. 管理者アカウント作成

`MattermostUrl` にブラウザでアクセスし、最初のユーザー (管理者) を作成します。
続いてチーム (Team) とチャンネルを作成します。翻訳したいチャンネル
(例: `#general` や `#qa`) を決めておきます。

### 2. Site URL について (自動設定・設定不要)

Site URL は CDK が ECS タスクの環境変数 `MM_SERVICESETTINGS_SITEURL` に
**ALB の URL を自動設定**します。環境変数で指定された項目は Mattermost の
**System Console → Environment → Web Server → Site URL** では
**編集不可 (グレーアウト)** となりますが、これは正常です。表示値が ALB の
URL になっていれば設定は完了しています。

> Site URL が正しくないと、ブラウザの WebSocket 接続先 URL が誤り、
> 新着メッセージがリアルタイム反映されず**リロードが必要**になります。
> 本テンプレートでは ALB の URL を自動設定するため、この問題は起きません。
> (あわせて ALB のアイドルタイムアウトを 300 秒に設定し、WebSocket の
> 切断を抑制しています)

### 3. Outgoing Webhook を有効化

**System Console → Integrations → Integration Management** で以下を `true` に:

- Enable Outgoing Webhooks

### 4. 検証トークンの取得

Outgoing Webhook の検証に使うトークンは Secrets Manager に自動生成済みです。
値を取得します (Secret 名は Output `OutgoingTokenSecretName`)。

```bash
aws secretsmanager get-secret-value \
  --region ap-northeast-1 \
  --secret-id ctf-chat/outgoing-webhook-token \
  --query SecretString --output text
```

### 5. Outgoing Webhook の作成

Mattermost の **Main Menu → Integrations → Outgoing Webhooks → Add Outgoing Webhook**:

| 項目 | 設定値 |
|---|---|
| Content Type | `application/x-www-form-urlencoded` (デフォルト) |
| Channel | 翻訳対象のチャンネル (例: `general`) |
| Trigger Words | **空のまま** (チャンネルの全投稿を対象にする場合) |
| Callback URLs | Output `TranslateWebhookUrl` の値 |

作成後に **Token** が払い出されます。この値を**手順 4 で取得した Secrets Manager の
トークンと一致させる**必要があります。方法は 2 通り:

- **(A) Secret 側を Mattermost 発行トークンに合わせる (推奨・簡単)**

  ```bash
  aws secretsmanager put-secret-value \
    --region ap-northeast-1 \
    --secret-id ctf-chat/outgoing-webhook-token \
    --secret-string '<Mattermostが発行したToken>'
  ```

  Lambda は Secret を実行環境に 60 秒 TTL でキャッシュするため、
  更新後は最大 60 秒で新トークンが反映されます。

- **(B) トークン検証を使わない**

  Secret を空文字にすると Lambda はトークン検証をスキップします
  (CTF の閉じた環境なら許容できる場合あり。非推奨)。

> 対象チャンネルを増やしたい場合は、チャンネルごとに Outgoing Webhook を追加し、
> Callback URL は同じ `TranslateWebhookUrl` を指定すれば OK です。
> Incoming Webhook は 1 つで複数チャンネルへ投稿できる (後述) ため、
> 追加は不要です。

### 6. Incoming Webhook の作成 (翻訳文の投稿先)

翻訳文は Lambda が Mattermost の **Incoming Webhook** を呼び出して投稿します。
以下の手順で Incoming Webhook を作成し、その URL を Secrets Manager に登録します。

1. **System Console → Integrations → Integration Management** で
   **Enable Incoming Webhooks = true** にします。
2. **Main Menu → Integrations → Incoming Webhooks → Add Incoming Webhook** を開き、
   既定チャンネル (任意のパブリックチャンネル。例: `qa`) を選んで作成します。
3. 払い出される URL (`http://<ALB-DNS>/hooks/xxxxxxxx`) を控えます。
4. その URL を Secret `ctf-chat/incoming-webhook-url` に登録します
   (Secret 名は Output `IncomingWebhookSecretName`)。

   ```bash
   aws secretsmanager put-secret-value \
     --region ap-northeast-1 \
     --secret-id ctf-chat/incoming-webhook-url \
     --secret-string 'http://<ALB-DNS>/hooks/xxxxxxxx'
   ```

   Lambda は 60 秒 TTL でキャッシュするため、最大 60 秒で反映されます。

> **投稿先チャンネル**: Lambda は投稿時に、元投稿のあったチャンネル名
> (`channel_name`) を Incoming Webhook の `channel` パラメータに指定します。
> このため Incoming Webhook は 1 つ作成すれば、Outgoing Webhook を設定した
> 複数のパブリックチャンネルすべてへ、それぞれ元のチャンネルに翻訳を返せます。
>
> **投稿者の表示名**: 翻訳投稿は Incoming Webhook を**作成したユーザー名義**で
> 投稿され、`BOT` バッジが付きます。別名にしたい場合は Lambda の投稿payloadに
> `username` を追加し、System Console の
> **Enable integrations to override usernames = true** を設定してください。

---

## 動作確認

対象チャンネルに日本語で投稿します。

```
こんにちは、CTF へようこそ！
```

数秒後に Bot が以下のような翻訳を後追い投稿します (元言語は除外。
Mattermost 上ではラベルが太字で表示されます)。

```
**🇺🇸 English**
Hello, welcome to the CTF!

**🇰🇷 한국어**
안녕하세요, CTF에 오신 것을 환영합니다!
```

英語・韓国語で投稿した場合も、残り 2 言語へ翻訳されます。

---

## カスタマイズ

| 変更したいもの | 場所 |
|---|---|
| 対応言語・表示ラベル | `lambda/translate/index.ts` の `SUPPORTED_LANGS` |
| Fargate のスペック | `lib/multilingual-chat-stack.ts` の `cpu` / `memoryLimitMiB` |
| Aurora の ACU 範囲 | 同 `serverlessV2MinCapacity` / `serverlessV2MaxCapacity` |
| Mattermost バージョン | 同 `ContainerImage.fromRegistry(...)` のタグ |

---

## 片付け (使い捨て)

イベント終了後、以下で**全リソースを削除**します。

```bash
npx cdk destroy
```

- Aurora は `removalPolicy: DESTROY` / `deletionProtection: false` のため、
  スナップショットを残さず削除されます。**必要なデータは事前に退避**してください。
- Secrets Manager のシークレットは、CloudFormation 削除後も既定の回復期間
  (7〜30 日) 残る場合があります。即時削除したい場合は手動で
  `delete-secret --force-delete-without-recovery` を実行してください。
- 削除後、ECR やログの残骸がないか心配な場合は CloudWatch Logs のロググループ
  (`retention: 1週間`) が自動失効するのを待つか、手動削除してください。

---

## 注意事項・制約

- **Outgoing Webhook はパブリックチャンネルのみ**対象です (プライベートチャンネル /
  DM は対象外)。全チャンネルやプライベートを翻訳したい場合は Bot + WebSocket 購読方式
  への変更が必要です。
- 現構成の ALB は **HTTP (ポート80)** です。本番/公開利用では ACM 証明書 + HTTPS 化を
  推奨します (`listenerPort` / `certificate` の設定)。
- 翻訳はメッセージ本文のテキストが対象です。コードブロックや添付ファイルは翻訳しません。
- 料金はおおむね Fargate + Aurora Serverless v2 + NAT Gateway + Translate 従量です。
  将来の料金試算は [AWS Pricing Calculator](https://calculator.aws/) を参照してください。

---

## プロジェクト構成

```
.
├── bin/app.ts                        # CDK エントリポイント
├── lib/multilingual-chat-stack.ts    # スタック定義
├── lambda/translate/index.ts         # 翻訳 Lambda (Incoming Webhook 投稿)
├── docs/architecture.drawio          # アーキテクチャ図 (AWS公式アイコン)
├── cdk.json / tsconfig.json / package.json
└── README.md
```
