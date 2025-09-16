# DeepSeek API 統合ガイド

## 概要
このシステムはDeepSeek APIを使用して、高齢者デイサービスの月次経過記録の要約を生成します。

## DeepSeek API設定

### APIキー
```
sk-e324780129514a8d8bcd040cdd3809a3
```

### エンドポイント
```
https://api.deepseek.com/v1
```

### 使用モデル
```
deepseek-reasoner
```

## 技術的詳細

### OpenAI互換性
DeepSeekはOpenAI互換APIを提供しているため、OpenAI SDKをそのまま使用できます。必要な変更は以下のみです：

1. **baseURL設定**: `https://api.deepseek.com/v1`
2. **モデル名**: `deepseek-reasoner`
3. **APIキー**: DeepSeekから提供されたキー

### 実装箇所

#### `/src/utils/summarizer.ts`
```typescript
const openai = new OpenAI({
  apiKey: openaiApiKey,
  baseURL: 'https://api.deepseek.com/v1', // DeepSeek API endpoint
})
```

#### `/.dev.vars`
```env
OPENAI_API_KEY=sk-e324780129514a8d8bcd040cdd3809a3
OPENAI_MODEL=deepseek-reasoner
```

## 要約生成の特徴

### DeepSeek Reasonerモデルの利点
- 高度な論理的思考能力
- 日本語の自然な処理
- 文脈理解の深さ
- 敬体での正確な要約生成

### プロンプト設定
システムは以下の要件で要約を生成します：
- 200〜300文字の敬体
- 推測や評価を含まない事実のみ
- 優先順位に基づいた要約
  1. 体調/睡眠/感情
  2. 排泄/入浴/転倒
  3. 皮膚所見/脱水リスク
  4. 連絡事項
  5. 次回への配慮事項

## 使用方法

1. **開発環境での確認**
```bash
# サーバー起動
pm2 restart pdf-summarizer

# ログ確認
pm2 logs pdf-summarizer --nostream
```

2. **本番環境へのデプロイ**
```bash
# Cloudflare Pages Secret設定
npx wrangler pages secret put OPENAI_API_KEY --project-name pdf-summarizer
# 値: sk-e324780129514a8d8bcd040cdd3809a3

npx wrangler pages secret put OPENAI_MODEL --project-name pdf-summarizer  
# 値: deepseek-reasoner
```

## トラブルシューティング

### APIキーエラー
エラーメッセージ: `invalid_api_key`
- APIキーが正しく設定されているか確認
- `.dev.vars`ファイルが正しく読み込まれているか確認

### モデルエラー
- `deepseek-reasoner`モデル名が正しいか確認
- DeepSeek APIのステータスを確認

### 要約品質
- 文字数が200〜300文字の範囲外の場合、自動で再調整
- 敬体が保たれない場合は、プロンプトを調整

## コスト見積もり
- DeepSeekの料金体系に基づく
- 60名分の処理で概算：
  - 入力トークン: 約30,000〜50,000トークン
  - 出力トークン: 約15,000トークン（250文字×60名）
  
## セキュリティ注意事項
- APIキーは環境変数で管理
- 本番環境ではCloudflare Pages Secretsを使用
- ログにAPIキーが出力されないよう注意
- 定期的にAPIキーをローテーション推奨

## サポート
DeepSeek API ドキュメント: https://platform.deepseek.com/docs