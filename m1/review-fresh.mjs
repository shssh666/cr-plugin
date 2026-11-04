#!/usr/bin/env node
// M1 review fresh — 新上下文复审提示词包
//
// 「Fresh eyes」：复审者必须没有作者上下文。本工具把 diff 原文 + 仓规（CLAUDE.md/REVIEW.md）
// + 审查纪律打包成一份提示词文件；把整份内容交给【全新上下文】的 subagent（DSH subagent 工具
// 或新会话），不得附带任何作者解释。产出按 findings 格式回流 PR。
//
// 用法（在目标仓根执行，或 --cwd 指定）：
//   node m1/review-fresh.mjs                          # base=main, head=工作区（含未提交的已跟踪改动）
//   node m1/review-fresh.mjs --base main --head HEAD  # 显式区间（三点 base...head）
// 选项：
//   --base <ref>   基线（默认 main）
//   --head <ref>   目标（默认工作区；显式给出时用三点 base...head，diff 与 --stat 同区间）
//   --out <file>   输出（相对路径按 --cwd 解析；默认 <cwd>/review-fresh-prompt.md）
//   --cwd <dir>    目标仓根
//   --max <chars>  diff 上限（默认 120000，超出截断并标注——超大 diff 应先拆 PR）
// 退出码：0 成品；1 diff 为空；2 使用错误
// 注意：git diff 不含未跟踪新文件；本工具会检出并在提示词包顶部 + stderr 显式警告，避免漏审
// 零依赖：node >=18

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

function fail(msg) {
  console.error(`[fresh] ${msg}`)
  process.exit(2)
}

function parseArgs(argv) {
  const opt = { base: 'main', head: null, out: null, cwd: process.cwd(), max: 120000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') opt.base = argv[++i]
    else if (a === '--head') opt.head = argv[++i]
    else if (a === '--out') opt.out = argv[++i]
    else if (a === '--cwd') opt.cwd = argv[++i]
    else if (a === '--max') {
      const n = Number(argv[++i])
      if (!Number.isFinite(n) || n <= 0) fail(`--max 需正整数，收到: ${argv[i]}`)
      opt.max = n
    } else fail(`未知参数: ${a}`)
  }
  return opt
}

let lastGitErr = ''
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (r.status !== 0) {
    lastGitErr = ((r.stderr || (r.error && r.error.message) || `exit ${r.status}`) + '').trim()
    return null
  }
  return r.stdout
}

// 围栏兜底：取内容里最长连续反引号 +1 作外层围栏，避免 diff 内的 ``` 提前闭合代码块
function codeFence(content, lang) {
  let maxRun = 0
  const re = /`+/g
  let m
  while ((m = re.exec(content)) !== null) if (m[0].length > maxRun) maxRun = m[0].length
  const f = '`'.repeat(Math.max(3, maxRun + 1))
  return { open: f + lang, close: f }
}

function main() {
  const opt = parseArgs(process.argv.slice(2))
  const read = (p) => (existsSync(path.join(opt.cwd, p)) ? readFileSync(path.join(opt.cwd, p), 'utf8') : '（本仓无此文件）')

  // 统一区间：有 --head 用三点 base...head（diff 与 stat 同区间，避免 stat 混入 base 侧提交）；缺省用 base..工作区
  const range = opt.head ? [`${opt.base}...${opt.head}`] : [opt.base]
  let diff = git(['diff', ...range], opt.cwd)
  // 未跟踪新文件不在 git diff 内 —— 显式检出，避免「PR 前新文件未 add」被静默漏审
  const untracked = (git(['ls-files', '--others', '--exclude-standard'], opt.cwd) || '').split('\n').filter(Boolean)

  if (!diff || diff.trim() === '') {
    if (untracked.length > 0) {
      console.error(`[fresh] 已跟踪文件无 diff，但有 ${untracked.length} 个未跟踪新文件不在 diff 内：${untracked.slice(0, 8).join(', ')}${untracked.length > 8 ? ' …' : ''}`)
      console.error('[fresh] 请先 git add（或 git add -N）再复审，否则新文件会被漏审')
    } else {
      console.error(`[fresh] diff 为空——没有可复审内容${lastGitErr ? `（git: ${lastGitErr}）` : ''}`)
    }
    process.exit(1)
  }
  let truncated = false
  if (diff.length > opt.max) {
    diff = diff.slice(0, opt.max) + `\n... [diff 超 ${opt.max} 字符已截断——请拆分 PR 后再复审] ...`
    truncated = true
  }

  const head = (git(['rev-parse', opt.head || 'HEAD'], opt.cwd) || '').trim() || '(未知)'
  const stat = (git(['diff', '--stat', ...range], opt.cwd) || '').trim() || '(无)'
  const diffFence = codeFence(diff, 'diff')
  const statFence = codeFence(stat, 'text')

  const untrackedNote = untracked.length > 0
    ? `\n> ⚠ 以下 ${untracked.length} 个未跟踪文件**不在下方 diff 内**（git diff 不含 untracked），可能漏审——如需复审请先 git add：\n>\n${untracked.slice(0, 30).map((f) => `> - \`${f}\``).join('\n')}${untracked.length > 30 ? '\n> - …' : ''}\n`
    : ''

  const prompt = `# Fresh-eyes 复审任务（cr-plugin · M1 review fresh）

你是**没有作者上下文**的独立复审者：不知道改动动机、不知道哪些"应该没问题"。
只依据本文件内的材料判断，不确定就不报。

## 审查纪律（必须遵守）

1. 只看 diff；不从函数名猜行为——每个发现必须给 \`文件:行号\` 与代码证据
2. 同类问题一次全部指出；风格类最多 3 条，超出写"其余见 lint 输出"
3. dist/、docs/、*.md 跳过（规范文件自身变更除外）
4. 不确定就不报；没有要修的就直说"没有要修的"
5. 关注四件事：并发与状态 / 文件安全（服务端生效） / 资源预算（流式、无无限增长对象） / 流程合规（绕过审查痕迹直接报 high）

## 项目约定（CLAUDE.md）

${read('CLAUDE.md')}

## 审查重点（REVIEW.md）

${read('REVIEW.md')}

## 改动（base=${opt.base} → head=${opt.head || '工作区'} · 区间 \`${range[0]}\`${truncated ? ' · 已截断' : ''}）
${untrackedNote}
${diffFence.open}
${diff}
${diffFence.close}

## diff --stat（同区间 \`${range[0]}\`）

${statFence.open}
${stat}
${statFence.close}

## 输出格式（严格遵守）

第一行计数开头，如 \`2 Important, 1 Nit\`；没有要修的就直说 **没有要修的**。
每条发现：\`- [high|medium|low] [category] 文件:行号 标题\`，下一行缩进给证据（引用 diff 原文）与触发路径。
`

  const outPath = opt.out ? path.resolve(opt.cwd, opt.out) : path.join(opt.cwd, 'review-fresh-prompt.md')
  writeFileSync(outPath, prompt)
  console.log(`[fresh] 提示词包已生成: ${outPath}（diff ${diff.length} 字符${truncated ? '，已截断' : ''}，head=${head.slice(0, 8)}）`)
  if (untracked.length > 0) console.error(`[fresh] 警告：${untracked.length} 个未跟踪文件未纳入 diff（详见提示词包顶部），先 git add 再复审可避免漏审`)
  console.log('[fresh] 消费方式：整份文件内容原样交给全新上下文的 subagent（不带作者解释），findings 回流 PR')
}

main()
