#!/usr/bin/env node
// M1 verify shot — UI 截图留证（对比留证；v1 不做像素 diff，视觉判断交给人或 VL subagent）
//
// 用法：
//   SHOT_CMD="npx playwright screenshot http://localhost:3000 shot.png" node m1/verify-shot.mjs --expected design.png
//   node m1/verify-shot.mjs --actual shot.png --expected design.png --note "登录页 v2"
// 选项：
//   --actual <file>    实拍截图（SHOT_CMD 未设置时必填）
//   --expected <file>  设计稿/对照图（可选：无对照时留证单图）
//   --note <text>      场景说明（写进证据）
//   --out <file>       证据文件（默认 shot-evidence.md，写到 --cwd）
//   --cwd <dir>        基准目录，图片相对路径以此为根（默认当前目录）
// 环境变量：
//   SHOT_CMD           可插拔截图命令（在 --cwd 下以 shell 执行；命令自己负责产出 --actual 文件）
// 退出码：0 留证成功；1 失败（截图命令失败/文件不存在）；2 使用错误
// 零依赖：node >=18

import { spawnSync } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const opt = { actual: null, expected: null, note: '', out: null, cwd: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--actual') opt.actual = argv[++i]
    else if (a === '--expected') opt.expected = argv[++i]
    else if (a === '--note') opt.note = argv[++i]
    else if (a === '--out') opt.out = argv[++i]
    else if (a === '--cwd') opt.cwd = argv[++i]
    else { console.error(`[shot] 未知参数: ${a}`); process.exit(2) }
  }
  return opt
}

function main() {
  const opt = parseArgs(process.argv.slice(2))

  if (process.env.SHOT_CMD) {
    console.log(`[shot] 执行捕获: ${process.env.SHOT_CMD}`)
    const r = spawnSync(process.env.SHOT_CMD, { cwd: opt.cwd, encoding: 'utf8', shell: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
    if (r.stdout) process.stdout.write(r.stdout)
    if (r.stderr) process.stderr.write(r.stderr)
    if (r.status !== 0) {
      console.error(`[shot] SHOT_CMD 失败 exit=${r.status}`)
      process.exit(1)
    }
  }
  if (!opt.actual) {
    console.error('[shot] 缺 --actual（或设 SHOT_CMD 由其产出）')
    process.exit(2)
  }
  const actualPath = path.resolve(opt.cwd, opt.actual)
  if (!existsSync(actualPath)) {
    console.error(`[shot] 实拍不存在: ${actualPath}`)
    process.exit(1)
  }
  let expectedRel = null
  if (opt.expected) {
    const expectedPath = path.resolve(opt.cwd, opt.expected)
    if (!existsSync(expectedPath)) {
      console.error(`[shot] 对照图不存在: ${expectedPath}`)
      process.exit(1)
    }
    expectedRel = opt.expected
  }

  const outPath = opt.out ? path.resolve(opt.out) : path.join(opt.cwd, 'shot-evidence.md')
  // md 引用相对 out 文件目录计算，保证在 GitHub/本地都能渲染
  const relTo = (p) => path.relative(path.dirname(outPath), path.resolve(opt.cwd, p)).replace(/\\/g, '/')
  const lines = []
  lines.push('# UI 截图证据（m1-verify-shot/1.0）')
  lines.push('')
  lines.push(`- 时间：${new Date().toISOString()}`)
  if (opt.note) lines.push(`- 场景：${opt.note}`)
  lines.push(`- 实拍：\`${opt.actual}\`（HEAD 时点产出）`)
  if (expectedRel) lines.push(`- 对照：\`${expectedRel}\``)
  lines.push('')
  lines.push('## 截图')
  lines.push('')
  if (expectedRel) {
    lines.push('| 实拍 | 对照 |')
    lines.push('|---|---|')
    lines.push(`| ![实拍](${relTo(opt.actual)}) | ![对照](${relTo(expectedRel)}) |`)
  } else {
    lines.push(`![实拍](${relTo(opt.actual)})`)
  }
  lines.push('')
  lines.push('## 比对结论（由人或 VL subagent 填写，不许空着合并）')
  lines.push('')
  lines.push('- [ ] 布局结构与对照一致')
  lines.push('- [ ] 文案/数字正确')
  lines.push('- [ ] 关键交互状态可见（加载/空态/错误态，视场景）')
  lines.push('- [ ] 无明显回归（错位/溢出/遮挡）')
  lines.push('')
  lines.push('**结论：**（一致 / 有差异：逐条列出 → 建 issue 或回改）')
  lines.push('')
  writeFileSync(outPath, lines.join('\n'))
  console.log(`[shot] 证据已写入 ${outPath}`)
}

main()
