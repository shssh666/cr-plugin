#!/usr/bin/env node
// M1 verify run — 可运行验证：跑验证命令、捕获输出原文、产出 PR 证据文件
//
// 「堵死'我做完了'的口头发言」：PR 模板 Testing 段只接受本工具产出的证据文件，
// 不接受手打转述（计划表 §2 阶段一 / P1 验收标准「PR 必附 verify 证据」）。
//
// 用法（在目标仓根执行，或用 --cwd 指定）：
//   node m1/verify-run.mjs                       # 自动发现：package.json scripts 中的 lint/typecheck/test/build
//   node m1/verify-run.mjs --cmd "npm run test" --cmd "node x.js"   # 显式命令（--cmd 可重复，跨平台推荐）
//   node m1/verify-run.mjs -- "npm run test"     # 显式命令（POSIX；Windows PowerShell 下 -- 可能不传入，改用 --cmd）
// 选项：
//   --out <file>    证据文件路径（默认 <cwd>/verify-evidence.md）
//   --cwd <dir>     目标仓根（默认当前目录）
//   --label <name>  证据标题（默认 "verify run"）
//   --timeout <ms>  单命令超时（默认 600000）
//   --cmd <command> 显式命令（可重复多次）
// 环境变量：
//   VERIFY_CMDS     覆盖自动发现（逗号/分号分隔多条；Windows 下替代 --cmd 的又一选择）
// 退出码：0 全部通过；1 任一失败；2 使用错误
// 零依赖：node >=18（spawnSync / readFileSync）

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const TOOL = 'm1-verify-run/1.0'
const DISCOVER_ORDER = ['lint', 'typecheck', 'test', 'build']
const OUTPUT_CAP = 20000 // 单命令输出入证上限（超出保头尾，文件仍标注截断）

function parseArgs(argv) {
  const opt = { cwd: process.cwd(), out: null, label: 'verify run', timeout: 600000, cmds: [] }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') opt.out = argv[++i]
    else if (a === '--cwd') opt.cwd = argv[++i]
    else if (a === '--label') opt.label = argv[++i]
    else if (a === '--timeout') opt.timeout = Number(argv[++i])
    else if (a === '--cmd') opt.cmds.push(argv[++i])
    else if (a === '--') { opt.cmds.push(...argv.slice(i + 1).filter(Boolean)); break }
    else rest.push(a)
  }
  if (rest.length > 0) {
    console.error(`[verify] 未知参数: ${rest.join(' ')}（显式命令请放在 -- 之后）`)
    process.exit(2)
  }
  return opt
}

function discoverCommands(cwd) {
  if (process.env.VERIFY_CMDS) {
    return process.env.VERIFY_CMDS.split(/[;,]/).map((s) => s.trim()).filter(Boolean)
  }
  const pj = path.join(cwd, 'package.json')
  if (!existsSync(pj)) return []
  const scripts = JSON.parse(readFileSync(pj, 'utf8').replace(/^\uFEFF/, '')).scripts || {}
  return DISCOVER_ORDER.filter((s) => scripts[s]).map((s) => `npm run ${s}`)
}

function gitInfo(cwd) {
  const run = (args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10000 })
    return r.status === 0 ? r.stdout.trim() : null
  }
  return {
    head: run(['rev-parse', 'HEAD']),
    branch: run(['branch', '--show-current']),
    dirty: run(['status', '--porcelain'])?.split('\n').filter(Boolean).length ?? null,
  }
}

function capOutput(s) {
  if (s.length <= OUTPUT_CAP) return { text: s, truncated: false }
  const head = Math.floor(OUTPUT_CAP * 0.65)
  const tail = OUTPUT_CAP - head
  return { text: s.slice(0, head) + `\n\n... [输出超 ${OUTPUT_CAP} 字符，中段截断，头 ${head} 尾 ${tail}] ...\n\n` + s.slice(-tail), truncated: true }
}

function fence(text) {
  // 输出里若含 ``` 用 ~~~~ 围栏兜底
  return text.includes('```') ? { open: '~~~~text', close: '~~~~' } : { open: '```text', close: '```' }
}

function main() {
  const opt = parseArgs(process.argv.slice(2))
  const cmds = opt.cmds.length > 0 ? opt.cmds : discoverCommands(opt.cwd)
  if (cmds.length === 0) {
    console.error('[verify] 未发现可执行命令（无 package.json scripts / VERIFY_CMDS），且未用 -- 显式指定')
    process.exit(2)
  }

  const gi = gitInfo(opt.cwd)
  const results = []
  for (const cmd of cmds) {
    const t0 = Date.now()
    const r = spawnSync(cmd, { cwd: opt.cwd, encoding: 'utf8', shell: true, timeout: opt.timeout, maxBuffer: 32 * 1024 * 1024, env: process.env })
    const durationMs = Date.now() - t0
    const combined = `--- stdout ---\n${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}`
    const failed = r.status !== 0
    results.push({
      cmd,
      code: r.status,
      timedOut: r.status === null,
      signal: r.signal,
      durationMs,
      failed,
      output: capOutput((combined || '(无输出)').trim()),
    })
    console.log(`[verify] ${failed ? '✗' : '✓'} ${cmd} → exit=${r.status ?? 'TIMEOUT'} (${(durationMs / 1000).toFixed(1)}s)`)
  }

  const outPath = opt.out ? path.resolve(opt.out) : path.join(opt.cwd, 'verify-evidence.md')
  const allPass = results.every((r) => !r.failed)
  const lines = []
  lines.push(`# ${opt.label} · 证据文件`)
  lines.push('')
  lines.push(`> 由 \`${TOOL}\` 生成；Testing 段请直接引用本文件，不接受手打转述。`)
  lines.push('')
  lines.push(`- 时间：${new Date().toISOString()}`)
  lines.push(`- 目录：\`${path.resolve(opt.cwd)}\``)
  if (gi.head) {
    lines.push(`- HEAD：\`${gi.head}\`（${gi.branch || 'detached'}）`)
    lines.push(`- 工作区：${gi.dirty === 0 ? '干净' : `**${gi.dirty} 个未提交变更（证据含混，先提交或暂存再出证）**`}`)
  } else {
    lines.push('- HEAD：（非 git 目录）')
  }
  lines.push(`- node：${process.version}`)
  lines.push('')
  lines.push('## 结果汇总')
  lines.push('')
  lines.push('| # | 命令 | 退出码 | 耗时 |')
  lines.push('|---|---|---|---|')
  results.forEach((r, i) => {
    lines.push(`| ${i + 1} | \`${r.cmd}\` | ${r.timedOut ? '⏱ TIMEOUT' : (r.failed ? `❌ ${r.code}` : `✅ ${r.code}`)} | ${(r.durationMs / 1000).toFixed(1)}s |`)
  })
  lines.push('')
  lines.push(allPass ? `**结论：${results.length} 项全部通过（exit 0）。**` : `**结论：${results.filter((r) => r.failed).length}/${results.length} 项失败。**`)
  lines.push('')
  for (const r of results) {
    const f = fence(r.output.text)
    lines.push(`## ${r.failed ? '✗' : '✓'} \`${r.cmd}\``)
    lines.push('')
    lines.push(`exit=${r.code ?? 'TIMEOUT'}${r.signal ? ` signal=${r.signal}` : ''} · ${(r.durationMs / 1000).toFixed(1)}s${r.output.truncated ? ' · 输出已截断' : ''}`)
    lines.push('')
    lines.push(f.open)
    lines.push(r.output.text)
    lines.push(f.close)
    lines.push('')
  }
  writeFileSync(outPath, lines.join('\n'))
  console.log(`[verify] 证据已写入 ${outPath} · 结论: ${allPass ? 'ALL PASS' : 'FAIL'} `)
  process.exit(allPass ? 0 : 1)
}

main()
