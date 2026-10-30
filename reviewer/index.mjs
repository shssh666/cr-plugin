import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.mjs'
import { listOpenPRs } from './github.mjs'
import { reviewPR, MARKER, REVIEWER_VERSION } from './review.mjs'
import { initStore, storeMode, flushSpool, closeStore } from './store.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

function loadState() {
  if (existsSync(config.stateFile)) {
    try { return JSON.parse(readFileSync(config.stateFile, 'utf8')) } catch { /* corrupt → fresh */ }
  }
  return {}
}
function saveState(state) {
  writeFileSync(config.stateFile, JSON.stringify(state, null, 2))
}

function loadRepoContext(repoRoot) {
  const read = (p) => {
    const full = path.join(repoRoot, p)
    return existsSync(full) ? readFileSync(full, 'utf8') : ''
  }
  return { claude: read('CLAUDE.md'), review: read('REVIEW.md') }
}

async function runOnce() {
  const state = loadState()
  const repoRoot = process.env.CR_REPO_ROOT || path.resolve(here, '../../discussion-room')
  const ctx = loadRepoContext(repoRoot)

  let targets
  if (config.onlyPr) {
    targets = [{ number: config.onlyPr }]
  } else {
    const prs = await listOpenPRs()
    targets = prs.filter((p) => !p.draft)
  }

  for (const pr of targets) {
    console.log(`[cr-m2] PR #${pr.number} ...`)
    try {
      const res = await reviewPR(pr.number, state, ctx)
      if (res.skipped) {
        console.log(`  skipped: ${res.skipped}${res.note ? ' — ' + res.note : ''}`)
      } else {
        console.log(`  round ${res.round}: ${res.findings.length} findings (${res.findings.filter((f) => f.severity === 'high').length} high)${config.dryRun ? ' [dry-run]' : ''}`)
        for (const f of res.findings) console.log(`    - [${f.severity}] ${f.category} ${f.path}:${f.line ?? '?'} ${f.title}`)
      }
    } catch (err) {
      console.error(`  ERROR: ${err.message}`)
    }
  }
  if (!config.dryRun) saveState(state)
  else console.log('[cr-m2] dry-run: 状态未写盘')
}

if (config.once || config.onlyPr || config.dryRun) {
  const mode = await initStore()
  console.log(`[cr-m2] reviewer=${REVIEWER_VERSION} store=${mode}${config.dryRun ? ' (dry-run)' : config.noPost ? ' (no-post)' : ''}`)
  if (config.flush) {
    const n = await flushSpool()
    console.log(`[cr-m2] flush spool: ${n} 条入 PG`)
  } else {
    await runOnce()
  }
  await closeStore() // 一次性模式：收尾，保证进程能退出
} else {
  const mode = await initStore()
  // 启动时先消化积压的 spool（轮询进程常驻，不需要 closeStore）
  if (mode === 'pg') {
    const n = await flushSpool()
    if (n > 0) console.log(`[cr-m2] 启动 flush: ${n} 条积压记录入 PG`)
  }
  console.log(`[cr-m2] 轮询模式，每 ${config.pollMinutes} 分钟一次 · reviewer=${REVIEWER_VERSION} store=${mode}`)
  setInterval(() => { runOnce().catch((e) => console.error(e.message)) }, config.pollMinutes * 60_000)
  await runOnce()
}
