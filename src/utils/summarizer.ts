// Summarization utility using DeepSeek API (OpenAI compatible)
import { OpenAI } from 'openai'

// System prompt for summarization
const SUMMARY_SYSTEM = `あなたは介護・福祉の月次経過記録の要約担当です。
記録を正確・簡潔にまとめ、現場の申し送りに使える品質で出力してください。`

const SUMMARY_INSTRUCTIONS = `要約要件:
・200〜300文字、敬体（です・ます調）。箇条書き不可、1段落。
・原文にない推測や評価は禁止。日付や数値は正確に転記。
・優先順位: 体調/睡眠/感情 → 排泄/入浴/転倒等 → 皮膚所見/脱水等のリスクと対応 → 連絡事項（家族・ショートステイ等）→ 次回への配慮事項。
・該当がない項目は無理に入れない。
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
以下は当月の経過記録です。これを要件に従い要約してください。
---
${maskedContent}
---
${SUMMARY_INSTRUCTIONS}`

    console.log(`Sending request for ${name} (prompt length: ${userPrompt.length} chars)`)

    const response = await openai.chat.completions.create({
      model: model,
      temperature: 0.2,
      max_tokens: 500, // Limit output tokens
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: userPrompt }
      ]
    }).catch(error => {
      console.error('DeepSeek API error:', {
        message: error.message,
        status: error.status,
        code: error.code,
        type: error.type
      })
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
  } catch (error) {
    console.error(`Failed to summarize for ${name}:`, error)
    
    // Provide more specific error messages
    if (error instanceof Error) {
      if (error.message.includes('maximum context length')) {
        return `要約失敗: テキストが長すぎます。管理者にお問い合わせください。`
      }
      if (error.message.includes('invalid_api_key')) {
        return `要約失敗: APIキーが無効です。設定を確認してください。`
      }
      if (error.message.includes('rate_limit')) {
        return `要約失敗: API制限に達しました。しばらくお待ちください。`
      }
      return `要約失敗: ${error.message.substring(0, 100)}`
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