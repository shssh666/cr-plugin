#!/usr/bin/env node
// M4 eval runner — 审查引擎离线重放跑分（计划表 §3 M4 / P3 沉淀）
//
// 输入：eval/cases.json（人工裁决种子）+ eval/diffs/*.patch（bug 存在时点的 diff 快照，见 $comment 快照原则）
// 行为：每个 set 用与生产完全相同的 prompt（reviewer/review.mjs buildPrompt）采样 N 票，
//       按 case 匹配计票，输出 min=1..N 的对照 verdict——回答「CR_VOTE_MIN 压不压召回」这类阈值问题
// 匹配：case.category 非空 → path+category 精确；为空（fresh-eyes 来源无 M2 八类分类）→ 仅 path
//       （同路径多例共享证据，v1 已知限度，见 cases.json $comment）
// 落库：PG_DSN 时 eval_cases 幂等确保 + eval_runs 全量入档（ts 区分批次，供「每日跑分→升留降回」）；
//       落库失败不静默——计数告警 + jsonl 兜底落盘 + exit 1。无 PG 时写 JSONL（默认 eval/eval-last-run.jsonl）
//       --mock 不写 PG（防假票污染真实版本跑分档案）
// verdict 语义（对齐 schema enum）：tp → caught/missed；fp/intentional → 命中即 false_positive（噪声复现），
//       被压制不落行（scorecard 由内存聚合）
// 用法：
//   node m4/eval-run.mjs [--votes 1-9] [--only SETID] [--jsonl FILE] [--no-pg] [--mock] [--list]
//   --mock  不调 LLM，固定假票走通匹配/计分链路（不写 PG）；--list 只列 case 不跑
// env：DEEPSEEK_API_KEY（非 mock 必需）；CR_MODEL 可选；PG_DSN 可选；
//      GITHUB_TOKEN 不需要（本工具不调 GitHub API；config 导入门槛由进程内垫 dummy 满足）
//      EVAL_DR_ROOT / EVAL_CR_ROOT 仓规上下文（CLAUDE.md/REVIEW.md）读取根——discussion-room set 必须指向
//      有效仓克隆，缺失时大声告警（重放 prompt 会与生产不符）
// 注意：仓规读当前版本而非 PR 时点版本（约定文件少变，v1 已知限度）

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const evalRoot = path.resolve(here, '../eval')

function fail(msg) {
  console.error(`[eval] ${msg}`)
  process.exit(2)
}

const argv = process.argv.slice(2)
const VALUE_FLAGS = ['--only', '--jsonl', '--votes']
const BOOL_FLAGS = ['--no-pg', '--mock', '--list']
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  if (!VALUE_FLAGS.includes(a) && !BOOL_FLAGS.includes(a)) fail(`未知参数: ${a}（已知: ${[...VALUE_FLAGS, ...BOOL_FLAGS].join(' ')}）`)
  if (VALUE_FLAGS.includes(a)) {
    if (i + 1 >= argv.length) fail(`${a} 需要一个参数值`)
    i++
  }
}
const flag = (n) => argv.includes(n)
const optVal = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }

const onlySet = optVal('--only') ?? null
const jsonlOut = optVal('--jsonl') ?? null
const votesRaw = optVal('--votes')
if (votesRaw !== undefined) {
  const n = Number(votesRaw)
  if (!Number.isInteger(n) || n < 1 || n > 9) fail(`--votes 需 1-9 正整数，收到: ${votesRaw}`)
}
const MOCK = flag('--mock')
const PASSIVE = MOCK || flag('--list') // 不调 LLM 的模式：垫假密钥过 config 导入门槛
const N_VOTES = votesRaw !== undefined ? Number(votesRaw) : 0

// shims 必须在 import config/review 之前（它们在模块顶层读 env/argv）
if (!process.env.GITHUB_TOKEN) process.env.GITHUB_TOKEN = 'eval-no-github-needed'
if (PASSIVE && !process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = 'mock'
if (N_VOTES > 0) process.env.CR_VOTES = String(N_VOTES)

const { REVIEWER_VERSION, buildPrompt, collectBallots, tallyGroups } = await import('../reviewer/review.mjs')
const { config } = await import('../reviewer/config.mjs')

if (!MOCK && !process.env.DEEPSEEK_API_KEY) fail('缺 DEEPSEEK_API_KEY（或用 --mock 自检链路）')

const casesFile = JSON.parse(readFileSync(path.join(evalRoot, 'cases.json'), 'utf8').replace(/^\uFEFF/, ''))
const sets = onlySet ? casesFile.sets.filter((s) => s.id === onlySet) : casesFile.sets
if (sets.length === 0) fail(`无匹配 set: ${onlySet}`)

const DR_ROOT = process.env.EVAL_DR_ROOT || path.resolve(here, '../../../discussion-room')
const CR_ROOT = process.env.EVAL_CR_ROOT || path.resolve(here, '..')
const ctxWarned = new Set()
function ctxFor(repo) {
  const isDr = repo.includes('discussion-room')
  const root = isDr ? DR_ROOT : CR_ROOT
  const read = (p) => (existsSync(path.join(root, p)) ? readFileSync(path.join(root, p), 'utf8') : '')
  const ctx = { claude: read('CLAUDE.md'), review: read('REVIEW.md') }
  if (isDr && !ctx.claude && !ctx.review && !ctxWarned.has(repo)) {
    ctxWarned.add(repo)
    console.error(`[eval] ⚠ ${repo} 仓规缺失（${root} 下无 CLAUDE.md/REVIEW.md）——重放 prompt 与生产不符！请设 EVAL_DR_ROOT 指向该仓有效克隆`)
  }
  return ctx
}

let pool = null
let pgFailures = 0
if (process.env.PG_DSN && !flag('--no-pg')) {
  try {
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.PG_DSN, connectionTimeoutMillis: 3000, max: 2 })
    // idle 客户端报错不崩进程（无监听会 uncaughtException），计入失败继续跑
    pool.on('error', (e) => {
      pgFailures++
      console.error(`[eval] PG 连接错误（继续，已计失败 ${pgFailures}）: ${String(e.message).slice(0, 80)}`)
    })
    await pool.query('select 1')
    console.log('[eval] store=pg')
  } catch (e) {
    if (pool) await pool.end().catch(() => {})
    pool = null
    console.log(`[eval] store=jsonl（PG 不可达: ${String(e.message).slice(0, 80)}）`)
  }
} else {
  console.log('[eval] store=jsonl')
}
if (MOCK && pool) {
  await pool.end().catch(() => {})
  pool = null
  console.log('[eval] mock：跳过 PG 入档（防假票污染真实版本跑分档案）')
}

async function ensureCaseRow(set, c) {
  if (!pool) return null
  const diffRef = `${set.base}..${set.head}`
  const loc = `${c.path}:${c.line}`
  const ex = await pool.query(
    'SELECT id FROM eval_cases WHERE repo=$1 AND diff_ref=$2 AND bug_location=$3 LIMIT 1',
    [set.repo, diffRef, loc],
  )
  if (ex.rows.length > 0) return ex.rows[0].id
  const ins = await pool.query(
    'INSERT INTO eval_cases(repo, diff_ref, bug_location, confirmed_by) VALUES ($1,$2,$3,$4) RETURNING id',
    [set.repo, diffRef, loc, c.confirmed_by],
  )
  return ins.rows[0].id
}

async function recordRun(caseId, verdict, voteMin, votes) {
  if (!pool || !caseId) return
  await pool.query(
    'INSERT INTO eval_runs(reviewer_version, case_id, verdict, vote_min, votes) VALUES ($1,$2,$3,$4,$5)',
    [REVIEWER_VERSION, caseId, verdict, voteMin, votes],
  )
}

if (flag('--list')) {
  for (const s of sets) {
    console.log(`# ${s.id} · ${s.repo} · ${s.base}..${s.head}（${s.cases.length} 例）`)
    for (const c of s.cases) console.log(`  [${c.label}] ${c.path}:${c.line} ${c.category || '-'} ${c.title}`)
  }
  if (pool) await pool.end().catch(() => {})
  process.exit(0)
}

const nVotes = Math.max(1, Number(process.env.CR_VOTES || 3))
const totals = {}
for (let m = 1; m <= nVotes; m++) totals[m] = { caught: 0, missed: 0, noiseEmitted: 0, noiseSuppressed: 0 }
const jsonlLines = []
const ts = new Date().toISOString()
function flushJsonl(target) {
  if (!target || jsonlLines.length === 0) return
  writeFileSync(target, jsonlLines.join('\n') + '\n') // 整跑覆盖式：重跑同目标不叠批次
}

for (const s of sets) {
  let diff = readFileSync(path.join(evalRoot, s.diff), 'utf8')
  // 保真：与生产 reviewPR 同规则截断（config.maxDiffChars），重放才等于生产视角
  let truncated = false
  if (diff.length > config.maxDiffChars) {
    diff = diff.slice(0, config.maxDiffChars) + '\n\n... [diff 过长已截断]'
    truncated = true
  }
  console.log(`\n== set ${s.id}（${s.cases.length} 例，diff ${diff.length} 字符${truncated ? '，已按生产规则截断' : ''}）==`)
  const prompt = buildPrompt({
    pr: { number: 0, title: `eval replay ${s.id}`, body: s.context },
    diff,
    round: 1,
    isFirst: true,
    st: { fingerprints: [] },
    ctxFiles: ctxFor(s.repo),
    truncated,
  })

  let groups
  if (MOCK) {
    // 固定假票：tp 例进前两票（→2 票），fp/intentional 例进第三票（→1 票）：min=1 全出、min=2 压 fp，链路可验
    const mk = (label) => s.cases.filter((c) => c.label === label).map((c) => ({
      path: c.path, line: c.line, severity: 'medium', category: c.category || 'api-contract',
      title: `[mock] ${c.title}`, detail: 'mock ballot',
    }))
    groups = tallyGroups([mk('tp'), mk('tp'), [...mk('fp'), ...mk('intentional')]])
  } else {
    const ballots = await collectBallots(prompt)
    groups = tallyGroups(ballots)
    console.log(`  票池：${groups.size} 个独立指纹组（${nVotes} 票）`)
  }

  for (const c of s.cases) {
    let votes = 0
    let matched = ''
    for (const g of groups.values()) {
      const hit = g.examples.find((f) => f.path === c.path && (!c.category || f.category === c.category))
      if (hit && g.votes.size > votes) { votes = g.votes.size; matched = hit.title }
    }
    const caseId = await ensureCaseRow(s, c).catch((e) => {
      pgFailures++
      console.error(`[eval] eval_cases 落库失败（${c.path}:${c.line}）: ${String(e.message).slice(0, 60)}`)
      return null
    })
    for (let m = 1; m <= nVotes; m++) {
      if (c.label === 'tp') {
        const verdict = votes >= m ? 'caught' : 'missed'
        totals[m][verdict === 'caught' ? 'caught' : 'missed']++
        await recordRun(caseId, verdict, m, votes).catch((e) => {
          pgFailures++
          console.error(`[eval] eval_runs 落库失败（${c.path}:${c.line} min=${m}）: ${String(e.message).slice(0, 60)}`)
        })
      } else if (votes >= m) {
        totals[m].noiseEmitted++
        await recordRun(caseId, 'false_positive', m, votes).catch((e) => {
          pgFailures++
          console.error(`[eval] eval_runs 落库失败（${c.path}:${c.line} min=${m}）: ${String(e.message).slice(0, 60)}`)
        })
      } else {
        totals[m].noiseSuppressed++
      }
    }
    jsonlLines.push(JSON.stringify({ ts, set: s.id, reviewer: REVIEWER_VERSION, mock: MOCK || undefined, votes, matched, ...c }))
    console.log(`  [${c.label}] ${c.path}:${c.line} 票=${votes}/${nVotes}${matched ? ` 命中「${matched.slice(0, 42)}」` : ' · 未命中'}`)
  }
  flushJsonl(jsonlOut) // 每集落盘一次：长跑中途崩不丢已跑明细
}

console.log('\n== 计分卡（阈值对照）==')
console.log('| vote_min | tp 召回 caught/missed | recall | 噪声 emitted/suppressed |')
console.log('|---|---|---|---|')
for (let m = 1; m <= nVotes; m++) {
  const t = totals[m]
  const tpTotal = t.caught + t.missed
  const recall = tpTotal > 0 ? ((t.caught / tpTotal) * 100).toFixed(0) + '%' : '-'
  console.log(`| ${m} | ${t.caught}/${t.missed} | ${recall} | ${t.noiseEmitted}/${t.noiseSuppressed} |`)
}

// 明细落盘：--jsonl 恒写；默认路径在无 PG 或 PG 有失败时兜底（有 PG 且全成不入仓目录，避免污染）
const defaultTarget = !pool || pgFailures > 0 ? path.join(evalRoot, 'eval-last-run.jsonl') : null
flushJsonl(jsonlOut || defaultTarget)
if (jsonlOut || defaultTarget) console.log(`[eval] 明细 → ${jsonlOut || defaultTarget}`)
if (pool) await pool.end().catch(() => {})
console.log(`[eval] reviewer=${REVIEWER_VERSION}${MOCK ? ' (mock)' : ''} · sets=${sets.length} · cases=${sets.reduce((n, s) => n + s.cases.length, 0)}${pgFailures > 0 ? ` · PG失败=${pgFailures}` : ''}`)
if (pgFailures > 0) {
  console.error(`[eval] PG 落库失败 ${pgFailures} 次——档案不完整（明细已保 jsonl），修复后重跑补档`)
  process.exit(1)
}
