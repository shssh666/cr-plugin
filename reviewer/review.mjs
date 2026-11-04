import { createHash } from 'node:crypto'
import { config } from './config.mjs'
import { getDiff, getPR, listReviews, postReview, postReviewWithComments } from './github.mjs'
import { chat, extractFindings } from './llm.mjs'
import { recordRun } from './store.mjs'

export const MARKER = '<!-- cr-m2:v2 -->'

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

// v2：引擎行为标识入哈希——投票过滤任何改动都可经 REVIEWER_VERSION 回溯（M4 跑分键）
// 教训（2026-11-04 A/B 实证，实验 d73447c1fbcc 已回退）：全局 prompt 反例必须是无语境的普适真理；
// 语境条件豁免（如 dev-CLI 执行自设命令）放仓级 REVIEW.md「语境豁免」段（随 ctxFiles 注入）——
// 反例 5/6 曾使工具类 diff 召回 46%→8%（模型泛化为「CLI diff 不用报」）
const ENGINE = 'v2-vote'

/** reviewer_version：engine+prompt+分类+模型 的哈希，任何改动都可回溯（M4 跑分用） */
export const REVIEWER_VERSION = createHash('sha1')
  .update([ENGINE, SYSTEM_PROMPT, CATEGORIES.join(','), config.model].join('|'))
  .digest('hex')
  .slice(0, 12)

/**
 * v2 指纹：path|category。
 * v1 含 title，改措辞的重复意见会漏判重（README 缺陷③、HANDOFF §6 定论）。
 * 前缀 v2 使其与 v1 状态文件里的旧指纹天然不碰撞（语义：v2 生命周期重新计数）。
 */
export function fingerprint(f) {
  return createHash('sha1').update(['v2', f.path, f.category].join('|')).digest('hex').slice(0, 12)
}

/** 投票采样温度：低/中/高三档独立采样（自一致性投票） */
const VOTE_TEMPERATURES = [0.2, 0.5, 0.8]

function normalizeFindings(list) {
  return (Array.isArray(list) ? list : [])
    .filter((f) => f && typeof f.path === 'string' && typeof f.title === 'string')
    .map((f) => ({
      path: f.path,
      line: Number.isInteger(f.line) ? f.line : null,
      severity: ['high', 'medium', 'low'].includes(f.severity) ? f.severity : 'low',
      category: CATEGORIES.includes(f.category) ? f.category : 'api-contract',
      title: String(f.title).slice(0, 120),
      detail: String(f.detail || '').slice(0, 1500),
    }))
}

/**
 * C2a 投票过滤（v2 核心）：
 *  - 同一 prompt 独立采样 CR_VOTES 票（温度分层），按指纹（path|category）分组计票
 *  - ≥CR_VOTE_MIN 票存活；单票模式（CR_VOTES=1）退回 v1 行为（全存活）
 *  - 双引擎加权：外部引擎（非 cr-m2 的 review）已提及同 path → 1 票即存活
 *    （依据：双引擎同报=免复核高优，PR#9 migrate 约束条实证；权重来自 9 PR/35 findings 复盘）
 *  - 落选者带 status='dropped_by_vote' 落库（PG 枚举已预留），供 M4 噪声度量
 *    （M2 单引擎精度 ~40%：PR#5 3 真/3 假阳/5 弱、PR#7 3 真/2 假阳——多数票压制单人采样的措辞性假阳）
 */
/** 采样 N 票（温度分层独立采样）；voteFilter 与 M4 eval 重放共用 */
export async function collectBallots(prompt) {
  const nVotes = Math.max(1, config.votes)
  const ballots = []
  for (let i = 0; i < nVotes; i++) {
    const raw = await chat(prompt, { temperature: VOTE_TEMPERATURES[i % VOTE_TEMPERATURES.length] })
    ballots.push(normalizeFindings(extractFindings(raw)))
  }
  return ballots
}

/** 跨票按指纹（path|category）分组计票；同一票内同指纹只计一票 */
export function tallyGroups(ballots) {
  const groups = new Map()
  ballots.forEach((ballot, vi) => {
    const seen = new Set()
    for (const f of ballot) {
      const fp = fingerprint(f)
      if (seen.has(fp)) continue
      seen.add(fp)
      if (!groups.has(fp)) groups.set(fp, { votes: new Set(), examples: [] })
      groups.get(fp).votes.add(vi)
      groups.get(fp).examples.push(f)
    }
  })
  return groups
}

async function voteFilter(prompt, pr) {
  const nVotes = Math.max(1, config.votes)
  const voteMin = nVotes === 1 ? 1 : Math.max(1, config.voteMin)

  const ballots = await collectBallots(prompt)

  // 外部引擎信号：本 PR 已有 review 里排除 cr-m2 自己（防自举：上轮报过的 path 不该给自己加权）
  let foreignText = ''
  try {
    const reviews = await listReviews(pr.number)
    foreignText = reviews
      .filter((r) => !(r.body || '').includes(MARKER))
      .map((r) => r.body || '')
      .join('\n')
  } catch {
    /* 拉不到外部 review 就当无加权信号 */
  }

  const groups = tallyGroups(ballots)

  const survivors = []
  const dropped = []
  for (const g of groups.values()) {
    const votes = g.votes.size
    // 代表条目取证据最完整的（detail 最长），票数与加权信息附在条目上
    const best = g.examples.reduce((a, b) => ((b.detail || '').length > (a.detail || '').length ? b : a))
    const boosted = votes < voteMin && foreignText.includes(best.path)
    const item = { ...best, votes, nVotes, boosted }
    if (votes >= voteMin || boosted) survivors.push(item)
    else dropped.push({ ...item, status: 'dropped_by_vote' })
  }
  return { survivors, dropped, nVotes, voteMin }
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

  // v2：多票采样 + 投票过滤 + 双引擎加权
  const { survivors, dropped, nVotes, voteMin } = await voteFilter(prompt, pr)

  // 收敛规则 4：不提重复意见（指纹去重；v2 指纹=path|category）
  const before = survivors.length
  const findings = survivors.filter((f) => !st.fingerprints.includes(fingerprint(f)))

  // 收敛规则 3：同类问题一次全部指出（prompt 已要求；此处按 category 聚合展示）
  const byCat = {}
  for (const f of findings) (byCat[f.category] ||= []).push(f)

  const newFps = findings.map(fingerprint)
  const result = {
    round, isFirst, findings, byCat, truncated, head,
    droppedDuplicates: before - findings.length,
    droppedByVote: dropped.length, nVotes, voteMin,
  }

  if (!config.dryRun && !config.noPost) {
    const body = renderReview(result, pr)
    // inline comments 落到具体行（line 必须在 diff 内，否则 API 422 自动降级）
    const comments = findings
      .filter((f) => f.line)
      .slice(0, 20)
      .map((f) => ({
        path: f.path,
        line: f.line,
        side: 'RIGHT',
        body: `${MARKER}\n${f.severity === 'high' ? '🟠' : f.severity === 'medium' ? '🟡' : ''} **${f.title}** [${f.category}]（票 ${f.votes}/${f.nVotes}${f.boosted ? ' ·DSH 同报加权' : ''}）\n\n${f.detail}`,
      }))
    await postReviewWithComments(number, head, body, comments)
  }

  if (!config.dryRun) {
    const storeTag = (f) => `[votes ${f.votes}/${f.nVotes}${f.boosted ? ',DSH' : ''}] `
    const mode = await recordRun({
      repo: config.repo,
      number,
      author: pr.user?.login,
      headSha: head,
      round,
      reviewerVersion: REVIEWER_VERSION,
      findings: [
        ...findings.map((f) => ({ ...f, status: 'posted', storeBody: storeTag(f) + f.title + '\n' + f.detail })),
        ...dropped.map((f) => ({ ...f, storeBody: storeTag(f) + f.title + '\n' + f.detail })),
      ],
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

export function buildPrompt({ pr, diff, round, isFirst, st, ctxFiles, truncated }) {
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
  const { findings, byCat, round, isFirst, nVotes, voteMin } = result
  const counts = { high: 0, medium: 0, low: 0 }
  for (const f of findings) counts[f.severity]++
  const lines = [
    MARKER,
    `## cr-m2 v2 审查 · 第 ${round} 轮（${isFirst ? '全量' : '增量'}）· 投票 ${nVotes} 票 ≥${voteMin} 存活`,
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
        lines.push(`- ${sev} **${f.title}** — \`${f.path}${f.line ? ':' + f.line : ''}\` [${f.severity}]（票 ${f.votes}/${f.nVotes}${f.boosted ? ' ·DSH 同报加权' : ''}）`)
        lines.push(`  ${f.detail.split('\n').join('\n  ')}`)
      }
      lines.push('')
    }
    if (result.droppedDuplicates > 0) lines.push(`（已过滤 ${result.droppedDuplicates} 条历史重复意见）`)
  }
  if (result.droppedByVote > 0) {
    lines.push('', `**已过滤低票 ${result.droppedByVote} 条**（status=dropped_by_vote 入库，供 M4 噪声度量复盘）`)
  }
  lines.push('', `<sub>cr-m2 v2 · head ${pr.head.sha.slice(0, 8)} · 增量审查 + 投票过滤（C2a）</sub>`)
  return lines.join('\n')
}
