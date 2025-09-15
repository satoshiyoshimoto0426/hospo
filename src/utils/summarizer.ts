// Summarization utility using OpenAI API
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

export async function summarizeOne(
  name: string,
  content: string,
  openai: OpenAI,
  model: string
): Promise<string> {
  try {
    // Replace person name with generic term for privacy
    const nameBase = name.replace(/さん|様|氏/, '')
    const maskedContent = content.replace(new RegExp(nameBase, 'g'), '対象者')
    
    const userPrompt = `利用者: ${name}
以下は当月の経過記録です。これを要件に従い要約してください。
---
${maskedContent}
---
${SUMMARY_INSTRUCTIONS}`

    const response = await openai.chat.completions.create({
      model: model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: userPrompt }
      ]
    })
    
    let summary = response.choices[0]?.message?.content?.trim() || '要約生成に失敗しました'
    
    // Check character count and adjust if needed
    const charCount = summary.replace(/\n/g, '').length
    if (charCount < 200 || charCount > 300) {
      const adjustResponse = await openai.chat.completions.create({
        model: model,
        temperature: 0.0,
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
    return `要約失敗: ${error instanceof Error ? error.message : 'Unknown error'}`
  }
}

// Process multiple summaries with concurrency control
export async function processSummaries(
  sections: Map<string, string>,
  openaiApiKey: string,
  model: string,
  maxConcurrency: number
): Promise<Map<string, string>> {
  const openai = new OpenAI({
    apiKey: openaiApiKey,
  })
  
  const summaries = new Map<string, string>()
  const entries = Array.from(sections.entries())
  
  // Process in batches to control concurrency
  for (let i = 0; i < entries.length; i += maxConcurrency) {
    const batch = entries.slice(i, i + maxConcurrency)
    const promises = batch.map(async ([name, content]) => {
      const summary = await summarizeOne(name, content, openai, model)
      return { name, summary }
    })
    
    const results = await Promise.all(promises)
    results.forEach(({ name, summary }) => {
      summaries.set(name, summary)
    })
  }
  
  return summaries
}