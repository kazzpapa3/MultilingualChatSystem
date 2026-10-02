import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';

/**
 * CTF向け多言語対応チャットシステム (使い捨て構成)
 *
 * 構成:
 *  - VPC (2AZ, NAT 1つ)
 *  - Aurora Serverless v2 (PostgreSQL) : Mattermostのデータストア
 *  - ECS Fargate + ALB : Mattermost 本体
 *  - API Gateway(REST) + Lambda + Amazon Translate : 翻訳連携 (方式1)
 *
 * 使い捨て方針:
 *  - 全リソース RemovalPolicy.DESTROY / Aurora deletionProtection=false
 *  - cdk destroy で一括削除可能
 */
export class MultilingualChatStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------
    // 1) ネットワーク (VPC)
    // ---------------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1, // 使い捨て用途のためコスト優先で1つ
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // ---------------------------------------------------------------
    // 2) データベース (Aurora Serverless v2 / PostgreSQL)
    // ---------------------------------------------------------------
    const dbSecret = new secretsmanager.Secret(this, 'DbSecret', {
      secretName: 'ctf-chat/db-credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'mmuser' }),
        generateStringKey: 'password',
        excludePunctuation: true, // 接続文字列で扱いやすいよう記号除外
        passwordLength: 24,
      },
    });

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      description: 'Aurora Serverless v2 for Mattermost',
      allowAllOutbound: true,
    });

    const dbCluster = new rds.DatabaseCluster(this, 'Aurora', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        // 15.4 は提供終了のため、現在利用可能な 15.10 を指定する。
        // CDK v2.150.0 の定数は VER_15_6 までのため of() で直接指定。
        // 利用可能バージョンは以下で確認:
        //   aws rds describe-db-engine-versions --engine aurora-postgresql \
        //     --region ap-northeast-1 --query 'DBEngineVersions[].EngineVersion'
        version: rds.AuroraPostgresEngineVersion.of('15.10', '15'),
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbSecurityGroup],
      credentials: rds.Credentials.fromSecret(dbSecret),
      defaultDatabaseName: 'mattermost',
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 4,
      writer: rds.ClusterInstance.serverlessV2('writer'),
      removalPolicy: cdk.RemovalPolicy.DESTROY, // 使い捨て
      deletionProtection: false,
      storageEncrypted: true,
    });

    // ---------------------------------------------------------------
    // 3) 翻訳連携用 Outgoing Webhook 検証トークン (Secret)
    // ---------------------------------------------------------------
    const outgoingTokenSecret = new secretsmanager.Secret(
      this,
      'OutgoingToken',
      {
        secretName: 'ctf-chat/outgoing-webhook-token',
        generateSecretString: {
          passwordLength: 32,
          excludePunctuation: true,
        },
      },
    );

    // Mattermost Incoming Webhook URL を格納する Secret。
    // デプロイ後に Mattermost 側で作成した Incoming Webhook URL
    // (http(s)://<ALB-DNS>/hooks/xxxx) を put-secret-value で設定する。
    // 初期値はプレースホルダ(空文字はCFnが拒否するため非空のダミー)。
    // Lambda は値が http(s) で始まらなければ「未設定」とみなす。
    const incomingWebhookSecret = new secretsmanager.Secret(
      this,
      'IncomingWebhookUrl',
      {
        secretName: 'ctf-chat/incoming-webhook-url',
        secretStringValue: cdk.SecretValue.unsafePlainText(
          'UNSET-set-mattermost-incoming-webhook-url',
        ),
      },
    );

    // ---------------------------------------------------------------
    // 4) ECS Fargate + ALB (Mattermost)
    // ---------------------------------------------------------------
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });

    const logGroup = new logs.LogGroup(this, 'MattermostLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Mattermost はDB接続文字列を MM_SQLSETTINGS_DATASOURCE で受け取る。
    // Aurora の Secret から password を解決し、cluster endpoint と
    // 組み合わせて Postgres DSN を組み立てる。
    //   postgres://user:password@host:port/db?sslmode=require&connect_timeout=10
    // password は Secrets Manager のダイナミックリファレンスで解決されるため、
    // 合成後の CloudFormation テンプレートに平文は残らない。
    const dbHost = dbCluster.clusterEndpoint.hostname;
    const dbPort = dbCluster.clusterEndpoint.port;
    const dbUser = 'mmuser';
    const dbName = 'mattermost';
    const dbPassword = dbSecret
      .secretValueFromJson('password')
      .unsafeUnwrap(); // CloudFormationダイナミックリファレンスとして解決

    const datasource =
      `postgres://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}` +
      `?sslmode=require&connect_timeout=10`;

    const fargate =
      new ecsPatterns.ApplicationLoadBalancedFargateService(
        this,
        'Mattermost',
        {
          cluster,
          cpu: 1024,
          memoryLimitMiB: 2048,
          desiredCount: 1,
          publicLoadBalancer: true,
          listenerPort: 80,
          taskImageOptions: {
            image: ecs.ContainerImage.fromRegistry(
              'mattermost/mattermost-team-edition:9.11',
            ),
            containerPort: 8065,
            enableLogging: true,
            logDriver: ecs.LogDrivers.awsLogs({
              streamPrefix: 'mattermost',
              logGroup,
            }),
            environment: {
              // 初期値。construct作成後に ALB DNS で上書きする(下記参照)。
              // Site URL が正しくないと WebSocket 接続先URLが誤り、
              // リアルタイム反映されず要リロードになる。
              MM_SERVICESETTINGS_SITEURL: 'http://localhost',
              MM_SQLSETTINGS_DRIVERNAME: 'postgres',
              MM_SQLSETTINGS_DATASOURCE: datasource,
            },
          },
          minHealthyPercent: 100,
        },
      );

    // ALB のヘルスチェックを Mattermost のpingエンドポイントに合わせる
    fargate.targetGroup.configureHealthCheck({
      path: '/api/v4/system/ping',
      healthyHttpCodes: '200',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(10),
    });

    // Site URL を ALB の URL に設定する。
    // Mattermost はこの値を基準に WebSocket 接続先URLを組み立てるため、
    // localhost のままだとブラウザのWebSocketが失敗し、リアルタイム反映
    // されず要リロードになる。construct作成後なら ALB DNS を参照しても
    // 循環参照にならない(タスク定義がALB属性を参照するのみ)。
    fargate.taskDefinition.defaultContainer?.addEnvironment(
      'MM_SERVICESETTINGS_SITEURL',
      `http://${fargate.loadBalancer.loadBalancerDnsName}`,
    );

    // WebSocket のアイドル切断を減らすため ALB アイドルタイムアウトを延長
    fargate.loadBalancer.setAttribute(
      'idle_timeout.timeout_seconds',
      '300',
    );

    // ECS タスクから Aurora へ接続を許可
    dbSecurityGroup.addIngressRule(
      fargate.service.connections.securityGroups[0],
      ec2.Port.tcp(dbPort),
      'Allow Mattermost tasks to reach Aurora',
    );

    // ---------------------------------------------------------------
    // 5) 翻訳 Lambda + API Gateway
    // ---------------------------------------------------------------
    const translateFn = new NodejsFunction(this, 'TranslateFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(
        __dirname,
        '..',
        'lambda',
        'translate',
        'index.ts',
      ),
      handler: 'handler',
      timeout: cdk.Duration.seconds(29), // API Gateway RESTの上限に合わせる
      // メモリは実測で92MB程度だが、メモリに比例してCPUも増えるため
      // 512MB にして初期化/JS実行を僅かに高速化する。
      memorySize: 512,
      environment: {
        // Lambda内でSecrets Managerから取得する(平文を環境変数に置かない)
        OUTGOING_TOKEN_SECRET_ID: outgoingTokenSecret.secretArn,
        INCOMING_WEBHOOK_SECRET_ID: incomingWebhookSecret.secretArn,
      },
      bundling: {
        minify: true,
        target: 'node20',
      },
    });

    // Lambda に Outgoing Webhook トークンSecretの読取を許可
    outgoingTokenSecret.grantRead(translateFn);
    // Lambda に Incoming Webhook URL Secretの読取を許可
    incomingWebhookSecret.grantRead(translateFn);

    // Translate 権限 (auto判定でComprehendも使用)
    translateFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'translate:TranslateText',
          'comprehend:DetectDominantLanguage',
        ],
        resources: ['*'], // Translate/Comprehendはリソースレベル制御不可
      }),
    );

    const api = new apigw.RestApi(this, 'TranslateApi', {
      restApiName: 'ctf-chat-translate',
      description:
        'Mattermost Outgoing Webhook receiver for translation',
      deployOptions: { stageName: 'prod' },
    });

    const webhookResource = api.root.addResource('webhook');
    webhookResource.addMethod(
      'POST',
      new apigw.LambdaIntegration(translateFn),
    );

    // ---------------------------------------------------------------
    // 6) 出力
    // ---------------------------------------------------------------
    new cdk.CfnOutput(this, 'MattermostUrl', {
      value: `http://${fargate.loadBalancer.loadBalancerDnsName}`,
      description: 'MattermostのURL(ALB DNS)。初回アクセスで管理者を作成',
    });
    new cdk.CfnOutput(this, 'TranslateWebhookUrl', {
      value: `${api.url}webhook`,
      description:
        'Mattermost Outgoing Webhook のCallback URLに設定する値',
    });
    new cdk.CfnOutput(this, 'OutgoingTokenSecretName', {
      value: outgoingTokenSecret.secretName,
      description:
        'Outgoing Webhookトークン(Secrets Manager)。Mattermost側のトークンと一致させる',
    });
    new cdk.CfnOutput(this, 'IncomingWebhookSecretName', {
      value: incomingWebhookSecret.secretName,
      description:
        'Incoming Webhook URL(Secrets Manager)。Mattermostで作成したURLを設定する',
    });
  }
}
