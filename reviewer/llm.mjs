import { config } from './config.mjs'

export async function chat(messages, { temperature = 0.2, maxTokens = 4096 } = {}) {
  const res = await fetch(`${config.deepseekBase}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.deepseekKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, messages, temperature, max_tokens: maxTokens }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`DeepSeek API -> ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

/** 从模型输出里抠出 JSON 数组（容忍 markdown 围栏与前后废话） */
export function extractFindings(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('[')
  const end = candidate.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return []
  try {
    const arr = JSON.parse(candidate.slice(start, end + 1))
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}
