#!/usr/bin/env node
// M1 review fresh — 新上下文复审提示词包
//
// 「Fresh eyes」：复审者必须没有作者上下文。本工具把 diff 原文 + 仓规（CLAUDE.md/REVIEW.md）
// + 审查纪律打包成一份提示词文件；把整份内容交给【全新上下文】的 subagent（DSH subagent 工具
// 或新会话），不得附带任何作者解释。产出按 findings 格式回流 PR。
//
// 用法（在目标仓根执行，或 --cwd 指定）：
//   node m1/review-fresh.mjs                          # base=main, head=工作区（含未提交）
//   node m1/review-fresh.mjs --base main --head HEAD  # 显式区间
// 选项：
//   --base <ref>   基线（默认 main）
//   --head <ref>   目标（默认工作区，含未提交改动）
//   --out <file>   输出（默认 review-fresh-prompt.md，写到 --cwd）
//   --cwd <dir>    目标仓根
//   --max <chars>  diff 上限（默认 120000，超出截断并标注——超大 diff 应先拆 PR）
// 退出码：0 成品；1 diff 为空；2 使用错误
// 零依赖：node >=18

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const opt = { base: 'main', head: null, out: null, cwd: process.cwd(), max: 120000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') opt.base = argv[++i]
    else if (a === '--head') opt.head = argv[++i]
    else if (a === '--out') opt.out = argv[++i]
    else if (a === '--cwd') opt.cwd = argv[++i]
    else if (a === '--max') opt.max = Number(argv[++i])
    else { console.error(`[fresh] 未知参数: ${a}`); process.exit(2) }
  }
  return opt
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (r.status !== 0) return null
  return r.stdout
}

function main() {
  const opt = parseArgs(process.argv.slice(2))
  const read = (p) => (existsSync(path.join(opt.cwd, p)) ? readFileSync(path.join(opt.cwd, p), 'utf8') : '（本仓无此文件）')

  // head 默认：工作区（含未提交）—— PR 前自查正是这个区间；显式 --head 用 git 区间
  let diff
  if (opt.head) {
    diff = git(['diff', `${opt.base}...${opt.head}`], opt.cwd)
  } else {
    diff = git(['diff', opt.base], opt.cwd) // base..工作区（未暂存+已暂存）
  }
  if (!diff || diff.trim() === '') {
    console.error('[fresh] diff 为空（或 git 不可用）——没有可复审内容')
    process.exit(1)
  }
  let truncated = false
  if (diff.length > opt.max) {
    diff = diff.slice(0, opt.max) + `\n... [diff 超 ${opt.max} 字符已截断——请拆分 PR 后再复审] ...`
    truncated = true
  }

  const head = git(['rev-parse', opt.head || 'HEAD'], opt.cwd)?.trim() || '(未知)'
  const stat = git(['diff', '--stat', opt.base, ...(opt.head ? [opt.head] : [])], opt.cwd)?.trim() || ''

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

## 改动（base=${opt.base} → head=${opt.head || '工作区'}${truncated ? ' · 已截断' : ''}）

\`\`\`diff
${diff}
\`\`\`

## diff --stat

\`\`\`text
${stat}
\`\`\`

## 输出格式（严格遵守）

第一行计数开头，如 \`2 Important, 1 Nit\`；没有要修的就直说 **没有要修的**。
每条发现：\`- [high|medium|low] [category] 文件:行号 标题\`，下一行缩进给证据（引用 diff 原文）与触发路径。
`

  const outPath = opt.out ? path.resolve(opt.out) : path.join(opt.cwd, 'review-fresh-prompt.md')
  writeFileSync(outPath, prompt)
  console.log(`[fresh] 提示词包已生成: ${outPath}（diff ${diff.length} 字符${truncated ? '，已截断' : ''}，head=${head.slice(0, 8)}）`)
  console.log('[fresh] 消费方式：整份文件内容原样交给全新上下文的 subagent（不带作者解释），findings 回流 PR')
}

main()
