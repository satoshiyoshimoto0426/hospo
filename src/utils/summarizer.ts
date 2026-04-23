// Summarization utility using Gemini API (OpenAI compatible)
import { OpenAI } from 'openai'

// ================================================================
// システムプロンプト - 介護記録要約の専門家としてのロール設定
// ※ コンパクトに保つことで出力トークンを最大限確保する
// ================================================================
const SUMMARY_SYSTEM = `あなたは高齢者デイサービスの月次モニタリング記録を作成する熟練の介護福祉士である。
支援経過記録から正確に読み取り、簡潔で的確なモニタリング要約を作成する。

【出力形式の絶対ルール】
- 100〜200文字程度の本文のみ出力する（短くてよい。目安は120字前後）
- 文末は必ず「〜である」「〜する」等の常体（断定調）で終わる
- 最後は必ず句点「。」で完結させる。途中で終わることは絶対禁止
- 見出し・番号・前置き・マークダウン記法は不要。本文だけを書く`

// ================================================================
// 要約指示 - 現場スタッフ要望を反映した構成・文体ルール
// ================================================================
const SUMMARY_RULES = `【文体（最重要）】
- 常体（だ・である調）で統一。敬体（です・ます）は禁止
  例: ×「参加しています」→ ○「参加している」
  例: ×「笑顔が見られます」→ ○「笑顔が見られる」
  例: ×「促していきます」→ ○「受診を促す」
- 1文は20〜30文字を目安に句点で区切る。読点で長くつなげない
- 現在形で記載（〜している、〜である）。過去完了形は不使用
- 箇条書き不可

【文章構成（必須）】
以下の順で構成し、①②③は必ず含めること：
①【できていること】記録から読み取れる本人の前向きな姿・できていること・継続できている点を必ず1つ以上記載する
②【気になる点・状態】体調・発言・皮膚所見・リスク等、配慮すべき点を簡潔に記載
③【今後の対応方針】文章の最後は必ず今後の対応方針で締める
  例: 「〜については受診を促す。」「〜の様子を継続観察する。」
      「〜の声かけを継続する。」「〜の変化に注意して見守る。」

【文字数】
- 100〜200文字程度。短くてよい。無理に長くしない
- 情報が少ない場合は100字前後で簡潔にまとめてよい

【禁止】
- 実施されなかった活動は記載しない。否定表現不要
- 利用者の行動に「対応」は使わない（スタッフ行動のみ可）
- 原文にない推測や評価は書かない
- できていないこと・問題点だけを並べない（必ず良い点を1つ入れる）

【必須変換】
- スタッフ洗身介助 → 「手の届きにくい背中等はスタッフが洗身を介助する」
- 不自然な原文は自然な日本語に修正

【記載優先順位】記載がある項目のみ：
レクリエーション参加・発言 → 運動・入浴での良好な様子 → 体調・睡眠・感情 → 排泄・転倒 → 皮膚所見・疼痛 → 連絡事項 → 今後の対応方針（必須で末尾）`

// Token estimation (rough approximation for Japanese text)
const CHARS_PER_TOKEN_ESTIMATE = 0.4
const MAX_INPUT_TOKENS = 900000 // Gemini 3 Flash has 1M context window
const MAX_INPUT_CHARS = Math.floor(MAX_INPUT_TOKENS * CHARS_PER_TOKEN_ESTIMATE)

// Maximum retry attempts for incomplete summaries
const MAX_RETRY_ATTEMPTS = 2

// Function to estimate token count
function estimateTokens(text: string): number {
  const japaneseChars = (text.match(/[ぁ-んァ-ヶー一-龯]/g) || []).length
  const asciiChars = (text.match(/[a-zA-Z0-9]/g) || []).length
  const otherChars = text.length - japaneseChars - asciiChars
  
  return Math.ceil(japaneseChars * 2.5 + asciiChars * 0.25 + otherChars * 1.5)
}

// Function to truncate text to fit token limit
function truncateToTokenLimit(text: string, maxChars: number = MAX_INPUT_CHARS): string {
  if (text.length <= maxChars) {
    return text
  }
  
  console.log(`Truncating text from ${text.length} to ${maxChars} characters`)
  
  const truncated = text.substring(0, maxChars)
  const lastPeriod = truncated.lastIndexOf('。')
  const lastNewline = truncated.lastIndexOf('\n')
  
  const cutPoint = Math.max(lastPeriod, lastNewline, maxChars - 100)
  
  return text.substring(0, cutPoint) + '\n\n[注意: 記録が長すぎるため、一部のみを要約対象としています]'
}

/**
 * Gemini API にリクエストを送信するヘルパー
 * 
 * 根本修正ポイント:
 * 1. max_tokens の代わりに max_completion_tokens を使用（Gemini OpenAI互換の正しいパラメータ）
 * 2. Gemini の thinking を制御するため reasoning_effort を設定
 * 3. fetch レベルで body を直接構築し、Gemini固有のパラメータを確実に送る
 */
async function callGeminiAPI(
  openai: OpenAI,
  model: string,
  systemContent: string,
  userContent: string,
  temperature: number = 0.3
): Promise<{ content: string; finishReason: string | null }> {
  // Gemini OpenAI互換エンドポイントにリクエスト
  // max_completion_tokens と extra_body で出力トークン制御を確実にする
  const response = await openai.chat.completions.create({
    model: model,
    temperature: temperature,
    // max_completion_tokens は OpenAI SDK v4+ で対応、Gemini互換レイヤーでも解釈される
    max_completion_tokens: 2000,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent }
    ],
    // Gemini の thinking を低く設定して、出力トークンを本文に回す
    // @ts-ignore - Gemini specific parameter
    reasoning_effort: 'low',
  } as any).catch(error => {
    console.error('Gemini API error details:', {
      message: error.message,
      status: error.status,
      statusCode: error.statusCode,
      code: error.code,
      type: error.type
    })
    
    if (error.status === 401 || error.message?.includes('401')) {
      throw new Error(`Gemini API認証エラー: APIキーが無効です。`)
    }
    if (error.status === 429 || error.message?.includes('429')) {
      throw new Error(`Gemini API制限: リクエスト上限に達しました。しばらくお待ちください。`)
    }
    
    throw error
  })
  
  const content = response.choices[0]?.message?.content?.trim() || ''
  const finishReason = response.choices[0]?.finish_reason || null
  
  return { content, finishReason }
}

/**
 * 要約が完結しているかを判定する
 * - 句点「。」で終わっているか
 * - finish_reason が途中打ち切りを示していないか
 */
function isSummaryComplete(summary: string, finishReason: string | null): boolean {
  if (!summary || summary.length === 0) return false
  
  // 要約失敗メッセージはスキップ
  if (summary.includes('要約失敗')) return true
  
  // finish_reason による打ち切り検知
  // Gemini OpenAI互換は "stop", "length", "MAX_TOKENS" などを返しうる
  const cutOffReasons = ['length', 'max_tokens', 'MAX_TOKENS', 'SAFETY', 'RECITATION']
  if (finishReason && cutOffReasons.includes(finishReason)) {
    console.warn(`finish_reason indicates cutoff: ${finishReason}`)
    return false
  }
  
  // 句点で終わっているか
  if (!summary.endsWith('。')) {
    return false
  }
  
  return true
}

/**
 * 要約テキストからマークダウン記法や余計なプレフィックスを除去する
 */
function cleanSummaryOutput(text: string): string {
  let result = text
  
  // マークダウンのコードブロック除去
  result = result.replace(/^```[a-z]*\n?/gm, '')
  result = result.replace(/\n?```$/gm, '')
  
  // 先頭の見出しや番号を除去
  result = result.replace(/^#+\s+.+\n/gm, '')
  result = result.replace(/^(?:要約|モニタリング要約|以下|出力)[：:]\s*/gm, '')
  result = result.replace(/^【[^】]+】\s*/gm, '')
  
  // 改行を除去して1段落にまとめる（要約は1段落が理想）
  result = result.replace(/\n+/g, '')
  
  return result.trim()
}

export async function summarizeOne(
  name: string,
  content: string,
  openai: OpenAI,
  model: string
): Promise<string> {
  try {
    // Check and truncate if content is too long
    const estimatedTokens = estimateTokens(content)
    console.log(`Processing ${name}: ${content.length} chars, ~${estimatedTokens} tokens`)
    
    if (estimatedTokens > MAX_INPUT_TOKENS) {
      console.warn(`Content for ${name} exceeds token limit (${estimatedTokens} tokens)`)
      content = truncateToTokenLimit(content)
    }
    
    // Further safety check
    if (content.length > 200000) {
      console.warn(`Content still too long after truncation: ${content.length} chars`)
      content = content.substring(0, 180000) + '\n\n[以下省略]'
    }
    
    // Replace person name with generic term for privacy
    const nameBase = name.replace(/さん|様|氏/, '')
    const maskedContent = content.replace(new RegExp(nameBase, 'g'), '対象者')
    
    // ================================================================
    // 初回リクエスト
    // プロンプト設計のポイント:
    //   - システムプロンプトにルールを集約（出力形式の絶対ルール含む）
    //   - ユーザープロンプトは記録データ＋簡潔な指示のみ
    //   - 指示の重複を避け、入力トークンを節約 → 出力トークンに余裕を確保
    // ================================================================
    const userPrompt = `以下は利用者「${name}」の当月の支援経過記録です。
この記録を読み、200〜300文字のモニタリング要約を作成してください。
必ず句点「。」で完結する本文のみを出力してください。

${SUMMARY_RULES}

---記録開始---
${maskedContent}
---記録終了---`

    console.log(`Sending request for ${name}:`, {
      promptLength: userPrompt.length,
      systemLength: SUMMARY_SYSTEM.length,
      model: model,
      baseURL: openai.baseURL
    })

    let { content: summary, finishReason } = await callGeminiAPI(
      openai, model, SUMMARY_SYSTEM, userPrompt, 0.3
    )
    
    summary = cleanSummaryOutput(summary)
    
    console.log(`${name} - finish_reason: ${finishReason}, length: ${summary.length}, ends_with_kuten: ${summary.endsWith('。')}`)
    
    // ================================================================
    // リトライロジック（最大 MAX_RETRY_ATTEMPTS 回）
    // 
    // 根本修正: リトライ時はプロンプトを大幅に簡素化し、
    // 「前回の途中結果 + 続きを完成させて」という方式に変更
    // ================================================================
    let retryCount = 0
    while (!isSummaryComplete(summary, finishReason) && retryCount < MAX_RETRY_ATTEMPTS) {
      retryCount++
      console.warn(`Summary for ${name} is incomplete (attempt ${retryCount}/${MAX_RETRY_ATTEMPTS}). Retrying...`)
      
      let retryPrompt: string
      
      if (summary.length > 50) {
        // 前回の結果がある程度ある場合: 前回の結果を渡して完結させる
        retryPrompt = `以下は利用者「${name}」のモニタリング要約の途中結果である。
この文章を基に、100〜200文字程度で完結する要約を書き直せ。

【絶対条件】
- 文体は「〜である」「〜する」の常体（断定調）のみ。です・ます調禁止
- 「できていること」を1つ以上含める
- 文末は「今後の対応方針」（例：受診を促す、継続観察する等）で締める
- 最後は必ず句点「。」で終わる完全な文章にする
- 1文は20〜30文字の短文を重ねる
- 本文のみ出力すること

途中結果:
${summary}

参考記録（抜粋）:
${maskedContent.substring(0, 3000)}

上記を踏まえ、100〜200文字程度の完結した要約を本文のみ出力すること。`
      } else {
        // 前回の結果がほぼない場合: 記録を短縮して再送信
        const shortenedContent = maskedContent.substring(0, 5000)
        retryPrompt = `利用者「${name}」の記録から100〜200文字程度のモニタリング要約を作成せよ。

【絶対条件】
- 常体（だ・である調）のみ。敬体禁止
- 「できていること」を1つ以上含める
- 文末は「今後の対応方針」で締める
- 最後は必ず「。」で終わる。本文のみ出力。現在形。

---
${shortenedContent}
---`
      }
      
      const retryResult = await callGeminiAPI(
        openai, model,
        '介護記録の要約を作成する専門家である。常体（だ・である調の断定調）のみで書く。「できていること」を1つ以上含め、文末は「今後の対応方針」で締める。必ず句点「。」で終わる完全な文章を100〜200文字程度で出力する。本文のみ出力し、見出しや前置きは不要である。',
        retryPrompt,
        0.2
      )
      
      const retriedSummary = cleanSummaryOutput(retryResult.content)
      console.log(`${name} retry ${retryCount} - finish_reason: ${retryResult.finishReason}, length: ${retriedSummary.length}, ends_with_kuten: ${retriedSummary?.endsWith('。')}`)
      
      if (retriedSummary && retriedSummary.length > 0) {
        summary = retriedSummary
        finishReason = retryResult.finishReason
      } else {
        break // 空の結果が返ってきたらリトライ終了
      }
    }
    
    // Post-processing: enforce style rules
    summary = postProcessSummary(summary)
    
    // ── 最終保険：それでも句点で終わっていない場合は最後の句点まで切り取る ──
    if (!summary.endsWith('。')) {
      const lastKuten = summary.lastIndexOf('。')
      if (lastKuten > 80) {
        // 80文字以上の位置に句点がある場合のみトリム（短すぎる結果を防止）
        console.warn(`${name}: Final summary still doesn't end with 。. Trimming to last 。 at pos ${lastKuten}`)
        summary = summary.substring(0, lastKuten + 1)
      } else {
        // 句点がない or 位置が早すぎる場合は「。」を付加して完結させる
        console.warn(`${name}: No suitable 。 found. Appending 。 to complete.`)
        // 末尾の不完全な部分を除去して「。」を追加
        summary = summary.replace(/[、，,\s]+$/, '') + '。'
      }
    }
    
    // Check character count and adjust if needed
    // 新基準: 80字未満は短すぎ、250字超は長すぎ（目安100〜200字）
    const charCount = summary.replace(/\n/g, '').length
    if (charCount < 80 || charCount > 250) {
      console.log(`Adjusting summary length for ${name}: ${charCount} chars`)
      
      const adjustPrompt = charCount < 80
        ? `次の文章を100〜200文字程度になるよう情報を追加せよ。「できていること」を1つ以上含め、文末は「今後の対応方針」（例：受診を促す、継続観察する等）で締めること。常体（だ・である調）のみ使用し、敬体は禁止。最後は必ず句点「。」で完結。本文のみ出力。

${summary}`
        : `次の文章を100〜200文字程度に短縮せよ。「できていること」「気になる点」「今後の対応方針」の3要素を残し、重要度の低い情報を削ること。常体（だ・である調）のみ使用し、敬体は禁止。文末は「今後の対応方針」で締める。最後は必ず句点「。」で完結。本文のみ出力。

${summary}`
      
      const adjustResult = await callGeminiAPI(
        openai, model,
        '介護記録の文章調整の専門家である。指示に従い本文のみ出力する。常体（だ・である調の断定調）のみ使用し、文章は必ず句点「。」で完結させる。',
        adjustPrompt,
        0.1
      )
      const adjusted = cleanSummaryOutput(adjustResult.content)
      if (adjusted && adjusted.length > 0) {
        let processedAdjusted = postProcessSummary(adjusted)
        // 調整後も句点で終わるか確認
        if (!processedAdjusted.endsWith('。')) {
          const lastK = processedAdjusted.lastIndexOf('。')
          if (lastK > 80) {
            processedAdjusted = processedAdjusted.substring(0, lastK + 1)
          } else {
            processedAdjusted = processedAdjusted.replace(/[、，,\s]+$/, '') + '。'
          }
        }
        summary = processedAdjusted
      }
    }
    
    return summary
  } catch (error: any) {
    console.error(`Failed to summarize for ${name}:`, error)
    
    if (error.response) {
      console.error('API Response Error:', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      })
    }
    
    if (error instanceof Error) {
      const errorMsg = error.message.toLowerCase()
      
      if (errorMsg.includes('maximum context length') || errorMsg.includes('token')) {
        return `要約失敗: テキストが長すぎます。管理者にお問い合わせください。`
      }
      if (errorMsg.includes('invalid_api_key') || errorMsg.includes('unauthorized') || errorMsg.includes('401')) {
        return `要約失敗: Gemini APIキーが無効です。APIキーを確認してください。`
      }
      if (errorMsg.includes('rate_limit') || errorMsg.includes('429')) {
        return `要約失敗: API制限に達しました。しばらくお待ちください。`
      }
      if (errorMsg.includes('model') || errorMsg.includes('not found')) {
        return `要約失敗: モデル名が正しくありません。gemini-3-flash-previewが利用可能か確認してください。`
      }
      if (errorMsg.includes('network') || errorMsg.includes('fetch')) {
        return `要約失敗: ネットワークエラー。Gemini APIに接続できません。`
      }
      
      return `要約失敗: ${error.message}`
    }
    return `要約失敗: 不明なエラー`
  }
}

/**
 * Post-processing: enforce writing style rules after AI generation
 * - Remove "対応" when used for user actions
 * - Ensure present tense
 * - Convert "です・ます調" (敬体) to "だ・である調" (常体/断定調)
 * - Clean up any remaining style issues
 */
function postProcessSummary(text: string): string {
  let result = text

  // Remove common "対応" misusages for user actions
  result = result.replace(/される対応をされ(ている|ています)/g, 'している')
  result = result.replace(/する対応をされ(ている|ています)/g, 'している')
  result = result.replace(/する対応を(している|しています)/g, 'している')
  result = result.replace(/された対応/g, 'した様子')
  result = result.replace(/対応をされている/g, 'している')
  result = result.replace(/対応をされています/g, 'しています')
  result = result.replace(/の対応をされ/g, 'をし')
  
  // Remove negative existence statements about activities
  result = result.replace(/[。、]?(?:入浴|レクリエーション|運動|機能訓練)(?:は|の)(?:実施|参加|利用)(?:は|が)?(?:ありません|されていません|行われていません)(?:でした)?。?/g, '')

  // ================================================================
  // 敬体 → 常体（断定調）への変換
  // AI生成で敬体が混入した場合のセーフティネット
  // ================================================================
  // 動詞「〜しています」「〜している」→「〜している」（そのまま）
  // 「〜されています」→「〜されている」
  result = result.replace(/されています(?=[。、])/g, 'されている')
  result = result.replace(/されています$/g, 'されている')
  // 「〜しています」→「〜している」
  result = result.replace(/しています(?=[。、])/g, 'している')
  result = result.replace(/しています$/g, 'している')
  // 「〜ています」→「〜ている」（汎用）
  result = result.replace(/ています(?=[。、])/g, 'ている')
  result = result.replace(/ています$/g, 'ている')
  // 「〜ます」→「〜る」（例：あります→ある、できます→できる、見られます→見られる）
  result = result.replace(/られます(?=[。、])/g, 'られる')
  result = result.replace(/られます$/g, 'られる')
  result = result.replace(/えます(?=[。、])/g, 'える')
  result = result.replace(/えます$/g, 'える')
  result = result.replace(/きます(?=[。、])/g, 'きる')
  result = result.replace(/きます$/g, 'きる')
  result = result.replace(/ります(?=[。、])/g, 'る')
  result = result.replace(/ります$/g, 'る')
  result = result.replace(/います(?=[。、])/g, 'いる')
  result = result.replace(/います$/g, 'いる')
  // 「〜です」→「〜である」
  result = result.replace(/(.)です(?=[。、])/g, (_m, p1) => {
    // 末尾が名詞・形容動詞系なら「である」に変換
    return `${p1}である`
  })
  result = result.replace(/(.)です$/g, (_m, p1) => `${p1}である`)
  // 「〜でした」→「〜であった」
  result = result.replace(/でした(?=[。、])/g, 'であった')
  result = result.replace(/でした$/g, 'であった')
  // 「〜ました」→「〜た」
  result = result.replace(/ました(?=[。、])/g, 'た')
  result = result.replace(/ました$/g, 'た')
  // 「〜ません」→「〜ない」
  result = result.replace(/ません(?=[。、])/g, 'ない')
  result = result.replace(/ません$/g, 'ない')
  // 二重変換の清掃（例：「であるある」防止）
  result = result.replace(/であるである/g, 'である')
  result = result.replace(/でいるいる/g, 'でいる')

  // Clean up double periods or spaces
  result = result.replace(/。。/g, '。')
  result = result.replace(/\s{2,}/g, ' ')
  result = result.trim()
  
  return result
}

// Process multiple summaries with concurrency control
export async function processSummaries(
  sections: Map<string, string>,
  openaiApiKey: string,
  model: string,
  maxConcurrency: number
): Promise<Map<string, string>> {
  // Validate API key
  if (!openaiApiKey || openaiApiKey.length < 10) {
    console.error('Invalid API key provided:', openaiApiKey ? 'key too short' : 'key missing')
    throw new Error('有効なAPIキーが設定されていません')
  }
  
  console.log('Initializing Gemini API client (OpenAI compatible)')
  
  // Use Gemini API with OpenAI compatible client
  const openai = new OpenAI({
    apiKey: openaiApiKey,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  })
  
  const summaries = new Map<string, string>()
  const entries = Array.from(sections.entries())
  
  console.log(`Processing ${entries.length} sections with concurrency ${maxConcurrency}`)
  
  // Process in batches to control concurrency
  for (let i = 0; i < entries.length; i += maxConcurrency) {
    const batch = entries.slice(i, i + maxConcurrency)
    console.log(`Processing batch ${Math.floor(i / maxConcurrency) + 1}/${Math.ceil(entries.length / maxConcurrency)}`)
    
    const promises = batch.map(async ([name, content]) => {
      try {
        const summary = await summarizeOne(name, content, openai, model)
        return { name, summary, success: true }
      } catch (error) {
        console.error(`Batch processing error for ${name}:`, error)
        return { 
          name, 
          summary: `要約失敗: ${error instanceof Error ? error.message : 'Unknown error'}`,
          success: false 
        }
      }
    })
    
    const results = await Promise.allSettled(promises)
    
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        summaries.set(result.value.name, result.value.summary)
      } else {
        console.error('Promise rejected:', result.reason)
      }
    })
  }
  
  console.log(`Completed processing ${summaries.size} summaries`)
  
  return summaries
}
