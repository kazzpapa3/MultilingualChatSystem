#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MultilingualChatStack } from '../lib/multilingual-chat-stack';

const app = new cdk.App();

new MultilingualChatStack(app, 'MultilingualChatStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
  },
  description:
    'CTF向け多言語対応チャットシステム (Mattermost on Fargate + Amazon Translate). 使い捨て用途。',
});

app.synth();
