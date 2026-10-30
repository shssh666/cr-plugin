import { createHash } from 'node:crypto'
import { config } from './config.mjs'
import { getDiff, getPR, listReviews, postReview, postReviewWithComments } from './github.mjs'
import { chat, extractFindings } from './llm.mjs'
import { recordRun } from './store.mjs'

export const MARKER = '<!-- cr-m2:v1 -->'

const CATEGORIES = [
  'build/module-graph',   // 构建/模块图断裂
  'dependency/lockfile',  // 依赖/lockfile 不同步
  'api-contract',         // API 契约不安全（null/缺校验/缺 error 处理）
  'security/input',       // 安全：输入校验缺失（穿越/XSS/MIME/注入）
  'resource-limits',      // 资源限制缺失（大小/速率/内存）
  'concurrency/state',    // 并发/状态竞态
  'ui/state',             // 前端 UI 状态 bug
  'test/defect',          // 测试本身有缺陷
]

const SYSTEM_PROMPT = `你是资深代码审查者。只报高置信度问题；风格类/猜测类不报。
问题分类只能是：${CATEGORIES.join(' / ')}。
输出严格 JSON 数组，元素：{"path","line","severity":"high|medium|low","category","title","detail"}。
没有问题输出 []。detail 里必须给证据（引用代码或说明触发路径）。
反例约束（历史假阳模式，勿重犯）：
1. Node 单线程事件循环内、两个 await 之间的 check-then-set 是原子的，不要报竞态
2. 报"缺校验"前先检查上游调用链是否已校验（如 upload 已验 magic，下游无需重复）
3. 报"清理路径缺失"前先检查 try/finally 是否已覆盖
4. "缺少的代码"类问题（如某 signal 无触发者）要全文件 grep 确认后再报`

/** reviewer_version：prompt+分类+模型 的哈希，任何改动都可回溯（M4 跑分用） */
export const REVIEWER_VERSION = createHash('sha1')
  .update(SYSTEM_PROMPT + '|' + CATEGORIES.join(',') + '|' + config.model)
  .digest('hex')
  .slice(0, 12)

export function fingerprint(f) {
  return createHash('sha1').update(`${f.path}|${f.category}|${f.title}`).digest('hex').slice(0, 12)
}

function loadRepoContext() {
  // CLAUDE.md / REVIEW.md 随仓走——审查必须读它们（M0 的落地点）
  return { claude: '', review: '' } // v0 由调用方注入文件内容
}

export async function reviewPR(number, state, ctxFiles) {
  const pr = await getPR(number)
  const head = pr.head.sha
  const base = pr.base.sha
  const st = state[number] || { reviewedSha: null, rounds: 0, fingerprints: [] }

  // 收敛规则 1：超过 3 轮，停下来
  if (st.rounds >= config.maxRounds) {
    return { skipped: 'round-cap', note: `已达 ${config.maxRounds} 轮上限，建议人工介入重想方案` }
  }

  // 增量审查：首轮全量，后续只看新 diff
  const isFirst = !st.reviewedSha
  const diffBase = isFirst ? base : st.reviewedSha
  if (!isFirst && diffBase === head) {
    return { skipped: 'no-new-diff' }
  }
  let diff = await getDiff(diffBase, head)
  if (!diff || diff.trim() === '') return { skipped: 'empty-diff' }

  let truncated = false
  if (diff.length > config.maxDiffChars) {
    diff = diff.slice(0, config.maxDiffChars) + '\n\n... [diff 过长已截断]'
    truncated = true
  }

  const round = st.rounds + 1
  const prompt = buildPrompt({ pr, diff, round, isFirst, st, ctxFiles, truncated })

  const raw = await chat(prompt)
  let findings = extractFindings(raw)
    .filter((f) => f && typeof f.path === 'string' && typeof f.title === 'string')
    .map((f) => ({
      path: f.path,
      line: Number.isInteger(f.line) ? f.line : null,
      severity: ['high', 'medium', 'low'].includes(f.severity) ? f.severity : 'low',
      category: CATEGORIES.includes(f.category) ? f.category : 'api-contract',
      title: String(f.title).slice(0, 120),
      detail: String(f.detail || '').slice(0, 1500),
    }))

  // 收敛规则 4：不提重复意见（fingerprint 去重）
  const before = findings.length
  findings = findings.filter((f) => !st.fingerprints.includes(fingerprint(f)))

  // 收敛规则 3：同类问题一次全部指出（prompt 已要求；此处按 category 聚合展示）
  const byCat = {}
  for (const f of findings) (byCat[f.category] ||= []).push(f)

  const newFps = findings.map(fingerprint)
  const result = { round, isFirst, findings, byCat, truncated, head, droppedDuplicates: before - findings.length }

  if (!config.dryRun && !config.noPost) {
    const body = renderReview(result, pr)
    // v1：inline comments 落到具体行（line 必须在 diff 内，否则 API 422 自动降级）
    const comments = findings
      .filter((f) => f.line)
      .slice(0, 20)
      .map((f) => ({
        path: f.path,
        line: f.line,
        side: 'RIGHT',
        body: `${MARKER}\n${f.severity === 'high' ? '🟠' : f.severity === 'medium' ? '🟡' : ''} **${f.title}** [${f.category}]\n\n${f.detail}`,
      }))
    await postReviewWithComments(number, head, body, comments)
  }

  if (!config.dryRun) {
    const mode = await recordRun({
      repo: config.repo,
      number,
      author: pr.user?.login,
      headSha: head,
      round,
      reviewerVersion: REVIEWER_VERSION,
      findings,
    })
    result.storeMode = mode
  }

  // 更新状态
  state[number] = {
    reviewedSha: head,
    rounds: round,
    fingerprints: [...st.fingerprints, ...newFps],
  }
  return result
}

function buildPrompt({ pr, diff, round, isFirst, st, ctxFiles, truncated }) {
  const known = st.fingerprints.length
    ? `已报告过的问题指纹（不要重复报告同类同位置问题）：${st.fingerprints.slice(-30).join(', ')}`
    : '（首轮，无历史）'
  return [
    {
      role: 'system',
      content: SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: `## 项目约定（CLAUDE.md）
${ctxFiles.claude || '(无)'}

## 审查重点（REVIEW.md）
${ctxFiles.review || '(无)'}

## PR 信息
#${pr.number} ${pr.title}
意图：${(pr.body || '').slice(0, 800)}

## 审查轮次
第 ${round} 轮（${isFirst ? '首轮全量' : '增量：只看新 diff'}）${truncated ? '（diff 已截断）' : ''}
${known}

## Diff
${diff}

## 收敛规则（你必须遵守）
1. 只报新引入或新暴露的问题；首轮可报存量高危
2. 同类问题一次全部指出，不要挤牙膏
3. 不报与已报告指纹重复的问题
4. 不确定就不报`,
    },
  ]
}

function renderReview(result, pr) {
  const { findings, byCat, round, isFirst } = result
  const counts = { high: 0, medium: 0, low: 0 }
  for (const f of findings) counts[f.severity]++
  const lines = [
    MARKER,
    `## cr-m2 审查 · 第 ${round} 轮（${isFirst ? '全量' : '增量'}）`,
    '',
    `**High-confidence findings:** ${findings.length}（high ${counts.high} / medium ${counts.medium} / low ${counts.low}）`,
    '',
  ]
  if (findings.length === 0) {
    lines.push('没有要修的。')
  } else {
    for (const [cat, fs] of Object.entries(byCat)) {
      lines.push(`### ${cat}`)
      for (const f of fs) {
        const sev = f.severity === 'high' ? '🟠' : f.severity === 'medium' ? '🟡' : '⚪'
        lines.push(`- ${sev} **${f.title}** — \`${f.path}${f.line ? ':' + f.line : ''}\` [${f.severity}]`)
        lines.push(`  ${f.detail.split('\n').join('\n  ')}`)
      }
      lines.push('')
    }
    if (result.droppedDuplicates > 0) lines.push(`（已过滤 ${result.droppedDuplicates} 条重复意见）`)
  }
  lines.push('', `<sub>cr-m2 · head ${pr.head.sha.slice(0, 8)} · 增量审查 v0</sub>`)
  return lines.join('\n')
}
