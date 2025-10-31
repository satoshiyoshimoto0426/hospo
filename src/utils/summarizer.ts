// Summarization utility using DeepSeek API (OpenAI compatible)
import { OpenAI } from 'openai'

// System prompt for summarization
const SUMMARY_SYSTEM = `あなたは高齢者デイサービスの月次経過記録を要約する専門スタッフです。
支援経過から重要な情報を抽出し、現場の申し送りに使える実用的な要約を作成してください。
特に、レクリエーション、運動、入浴の様子、利用者様の発言は記載があれば必ず含めてください。`

const SUMMARY_INSTRUCTIONS = `要約要件:
・200〜300文字、敬体（です・ます調）。箇条書き不可、1段落。
・原文にない推測や評価は禁止。日付や数値は正確に転記。

【必須項目】支援経過に以下の記載がある場合は必ず要約に含めること：
①レクリエーション - 参加状況、様子、内容
②運動 - 実施状況、様子、内容
③入浴の様子 - 実施の有無、様子、特記事項
④発していた言葉 - 利用者様の発言があれば具体的に記載

【優先順位】上記必須項目を含めた上で：
体調/睡眠/感情 → 排泄/転倒等 → 皮膚所見/脱水等のリスクと対応 → 連絡事項（家族・ショートステイ等）→ 次回への配慮事項

・該当がない項目は無理に入れない。
・必須項目がある場合は優先的に含め、文字数を調整すること。
出力は本文のみ。`

// Token estimation (rough approximation for Japanese text)
// Japanese characters typically use 2-3 tokens per character
const CHARS_PER_TOKEN_ESTIMATE = 0.4 // Conservative estimate
const MAX_INPUT_TOKENS = 120000 // Leave buffer for DeepSeek's 131072 limit
const MAX_INPUT_CHARS = Math.floor(MAX_INPUT_TOKENS * CHARS_PER_TOKEN_ESTIMATE) // ~48000 chars

// Function to estimate token count
function estimateTokens(text: string): number {
  // Rough estimation: Japanese chars ~2.5 tokens, ASCII ~0.25 tokens
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
  
  // Try to truncate at a sentence boundary
  const truncated = text.substring(0, maxChars)
  const lastPeriod = truncated.lastIndexOf('。')
  const lastNewline = truncated.lastIndexOf('\n')
  
  const cutPoint = Math.max(lastPeriod, lastNewline, maxChars - 100)
  
  return text.substring(0, cutPoint) + '\n\n[注意: 記録が長すぎるため、一部のみを要約対象としています]'
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
    
    // Further safety check - absolute character limit
    if (content.length > 50000) {
      console.warn(`Content still too long after truncation: ${content.length} chars`)
      content = content.substring(0, 45000) + '\n\n[以下省略]'
    }
    
    // Replace person name with generic term for privacy
    const nameBase = name.replace(/さん|様|氏/, '')
    const maskedContent = content.replace(new RegExp(nameBase, 'g'), '対象者')
    
    const userPrompt = `利用者: ${name}
以下は当月の支援経過記録です。この記録から以下の項目を確実に確認し、要件に従って要約してください。

【必ず確認する項目】
1. レクリエーション - 参加内容や様子が記載されているか
2. 運動 - 実施内容や様子が記載されているか  
3. 入浴の様子 - 入浴の実施や様子が記載されているか
4. 発していた言葉 - 利用者様の具体的な発言が記載されているか

上記の項目が記載されている場合は、必ず要約に含めてください。

---
${maskedContent}
---
${SUMMARY_INSTRUCTIONS}`

    console.log(`Sending request for ${name}:`, {
      promptLength: userPrompt.length,
      model: model,
      apiKeyPrefix: openai.apiKey?.substring(0, 10) + '...',
      baseURL: openai.baseURL
    })

    const response = await openai.chat.completions.create({
      model: model,
      temperature: 0.2,
      max_tokens: 500, // Limit output tokens
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: userPrompt }
      ]
    }).catch(error => {
      console.error('DeepSeek API error details:', {
        message: error.message,
        status: error.status,
        statusCode: error.statusCode,
        code: error.code,
        type: error.type,
        response: error.response,
        cause: error.cause
      })
      
      // Check if it's an authentication error
      if (error.status === 401 || error.message?.includes('401')) {
        throw new Error(`DeepSeek API認証エラー: APIキーが無効です。キー: ${openai.apiKey.substring(0, 10)}...`)
      }
      
      throw error
    })
    
    let summary = response.choices[0]?.message?.content?.trim() || '要約生成に失敗しました'
    
    // Check character count and adjust if needed
    const charCount = summary.replace(/\n/g, '').length
    if (charCount < 200 || charCount > 300) {
      console.log(`Adjusting summary length for ${name}: ${charCount} chars`)
      
      const adjustResponse = await openai.chat.completions.create({
        model: model,
        temperature: 0.0,
        max_tokens: 400,
        messages: [
          { role: 'system', content: '文章整形アシスタント' },
          { role: 'user', content: `次の文章を200〜300文字に調整し、敬体を維持して意味を保ってください。本文のみ:\n---\n${summary}\n---` }
        ]
      })
      summary = adjustResponse.choices[0]?.message?.content?.trim() || summary
    }
    
    return summary
  } catch (error: any) {
    console.error(`Failed to summarize for ${name}:`, error)
    
    // Log detailed error information
    if (error.response) {
      console.error('API Response Error:', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      })
    }
    
    // Provide more specific error messages
    if (error instanceof Error) {
      // Check for specific DeepSeek error messages
      const errorMsg = error.message.toLowerCase()
      
      if (errorMsg.includes('maximum context length') || errorMsg.includes('token')) {
        return `要約失敗: テキストが長すぎます。管理者にお問い合わせください。`
      }
      if (errorMsg.includes('invalid_api_key') || errorMsg.includes('unauthorized') || errorMsg.includes('401')) {
        return `要約失敗: DeepSeek APIキーが無効です。APIキーを確認してください: ${error.message}`
      }
      if (errorMsg.includes('rate_limit') || errorMsg.includes('429')) {
        return `要約失敗: API制限に達しました。しばらくお待ちください。`
      }
      if (errorMsg.includes('model') || errorMsg.includes('not found')) {
        return `要約失敗: モデル名が正しくありません。deepseek-reasonerが利用可能か確認してください。`
      }
      if (errorMsg.includes('network') || errorMsg.includes('fetch')) {
        return `要約失敗: ネットワークエラー。DeepSeek APIに接続できません。`
      }
      
      return `要約失敗: ${error.message}`
    }
    return `要約失敗: 不明なエラー`
  }
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
  
  console.log('Initializing DeepSeek API client with key:', openaiApiKey.substring(0, 5) + '...')
  
  // Use DeepSeek API with OpenAI compatible client
  const openai = new OpenAI({
    apiKey: openaiApiKey,
    baseURL: 'https://api.deepseek.com/v1', // DeepSeek API endpoint
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