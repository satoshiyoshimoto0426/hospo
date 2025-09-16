# PDF要約システム - 高齢者デイサービス月次経過記録

## プロジェクト概要
- **名称**: PDF要約システム
- **目的**: 60名分の月次経過記録PDFから、利用者ごとに200〜300文字の要約を自動生成
- **主要機能**: PDF解析、利用者単位分割、AI要約生成、Excel出力（重複名対応）

## URLs
- **開発環境**: https://3000-i8az55ukot8m6s1qg0so0-6532622b.e2b.dev
- **本番環境**: (未デプロイ) 
- **API Health Check**: `/api/health`

## 現在完成している機能
1. ✅ PDFファイルのアップロード機能
2. ✅ PDFからのテキスト抽出（テキスト埋め込み型PDF対応）
3. ✅ 利用者単位での自動セクション分割
   - 「◯◯さん/様/氏」パターン検出
   - Markdownヘッダー形式対応
   - 重複名の自動結合
4. ✅ OpenAI APIによる要約生成
   - 200〜300文字の敬体統一
   - 文字数自動調整機能
   - 並列処理対応（最大8件同時）
5. ✅ Excel（XLSX）ファイル生成
   - 利用者ごとにシート分割
   - 重複名に丸数字付与（①②③...）
   - シート名31文字制限対応
6. ✅ Basic認証によるセキュリティ
7. ✅ レスポンシブUIデザイン
8. ✅ ドラッグ＆ドロップ対応

## 機能エントリーポイント

### 1. メインページ
- **URL**: `/`
- **認証**: Basic認証（設定時）
- **機能**: PDFアップロードフォーム表示

### 2. アップロードAPI
- **URL**: `/api/upload`
- **Method**: POST
- **認証**: Basic認証（設定時）
- **パラメータ**: 
  - `file`: PDFファイル（multipart/form-data）
- **レスポンス**: Excel（XLSX）ファイル
- **エラーコード**:
  - 400: 無効なファイル/抽出失敗
  - 401: 認証失敗
  - 500: サーバーエラー

### 3. ヘルスチェック
- **URL**: `/api/health`
- **Method**: GET
- **レスポンス**: JSON形式のステータス情報

## 未実装機能
1. ⏳ スキャン画像PDF（OCR）対応
2. ⏳ 要約プレビュー・編集機能
3. ⏳ バッチ処理（複数PDFの一括処理）
4. ⏳ 処理履歴管理
5. ⏳ カスタムプロンプトテンプレート機能
6. ⏳ Azure OpenAI対応

## データアーキテクチャ
- **入力データ**: テキスト抽出可能なPDF（最大30MB）
- **処理フロー**: 
  1. PDFアップロード
  2. テキスト抽出
  3. 利用者単位分割
  4. 並列要約生成
  5. Excel生成・ダウンロード
- **ストレージ**: メモリ内処理のみ（データ非保存）
- **外部API**: DeepSeek API（deepseek-reasoner）

## 環境変数設定
```env
# .dev.vars または Cloudflare Pages Secrets
OPENAI_API_KEY=your-api-key       # 必須: DeepSeek APIキー
OPENAI_MODEL=deepseek-reasoner    # 任意: 使用モデル（デフォルト: deepseek-reasoner）
BASIC_USER=admin                  # 任意: Basic認証ユーザー名
BASIC_PASS=password123            # 任意: Basic認証パスワード
MAX_CONCURRENCY=8                 # 任意: 最大並列処理数（デフォルト: 8）
```

## 使用方法

### 開発環境での起動
```bash
# 依存関係インストール
npm install

# ビルド
npm run build

# 開発サーバー起動（PM2使用）
pm2 start ecosystem.config.cjs

# ログ確認
pm2 logs pdf-summarizer --nostream
```

### 本番環境へのデプロイ
```bash
# Cloudflare Pages へのデプロイ
npm run deploy:prod

# 環境変数設定
npx wrangler pages secret put OPENAI_API_KEY --project-name pdf-summarizer
npx wrangler pages secret put BASIC_USER --project-name pdf-summarizer
npx wrangler pages secret put BASIC_PASS --project-name pdf-summarizer
```

## 推奨される次の開発ステップ
1. **テスト環境の構築**
   - 実際のPDFサンプルでの動作確認
   - 文字数・形式の検証
   - エラーケースのテスト

2. **セキュリティ強化**
   - Cloudflare Zero Trust統合
   - IP制限の実装
   - 監査ログの追加

3. **パフォーマンス最適化**
   - PDF解析ライブラリの改善
   - キャッシュメカニズムの追加
   - 並列処理の最適化

4. **機能拡張**
   - OCR対応（外部API利用）
   - 要約品質向上（プロンプト調整）
   - 処理状況のリアルタイム表示

## 技術スタック
- **フレームワーク**: Hono 4.9.7
- **ランタイム**: Cloudflare Workers/Pages
- **UI**: TailwindCSS + FontAwesome
- **PDF処理**: カスタム実装（テキスト抽出）
- **Excel生成**: ExcelJS 4.4.0
- **AI**: DeepSeek API (deepseek-reasoner)
- **開発ツール**: Vite, Wrangler, PM2

## セキュリティ考慮事項
- ✅ HTTPS通信必須
- ✅ Basic認証実装
- ✅ データ非保存（メモリ内処理のみ）
- ✅ APIキーのセキュア管理（環境変数）
- ✅ 入力ファイルサイズ制限（30MB）
- ✅ エラーメッセージの適切な制御

## ライセンス
プロプライエタリ（内部使用限定）

## 最終更新
2024年1月