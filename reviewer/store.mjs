import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const SPOOL = process.env.CR_SPOOL || path.join(homedir(), '.cr-m2-spool.jsonl')
let pool = null

/** 尝试连 PG；连不上（比如 M2 还跑在本地而 PG 在 hermes）就降级 spool */
export async function initStore() {
  const dsn = process.env.PG_DSN
  if (!dsn) return 'spool'
  try {
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: dsn, connectionTimeoutMillis: 3000, max: 2 })
    await pool.query('select 1')
    return 'pg'
  } catch {
    pool = null
    return 'spool'
  }
}

/** 关闭连接池：一次性命令（--once/--flush）结束后必须调用，否则 Node 进程不退出 */
export async function closeStore() {
  if (pool) {
    await pool.end()
    pool = null
  }
}

export function storeMode() {
  return pool ? 'pg' : 'spool'
}

const SEV_MAP = { high: 'important', medium: 'important', low: 'nit' }

export async function recordRun({ repo, number, author, headSha, round, reviewerVersion, findings }) {
  const rec = { ts: new Date().toISOString(), repo, number, author, headSha, round, reviewerVersion, findings }
  if (!pool) {
    appendFileSync(SPOOL, JSON.stringify(rec) + '\n')
    return 'spooled'
  }
  const pr = await pool.query(
    `INSERT INTO prs(repo, number, author, agent_authored, risk_tier)
     VALUES ($1,$2,$3,true,'medium')
     ON CONFLICT (repo, number) DO UPDATE SET number = EXCLUDED.number
     RETURNING id`,
    [repo, number, author || 'unknown'],
  )
  const run = await pool.query(
    `INSERT INTO review_runs(pr_id, reviewer_version, mode, round) VALUES ($1,$2,'m2',$3) RETURNING id`,
    [pr.rows[0].id, reviewerVersion, round],
  )
  for (const f of findings) {
    await pool.query(
      `INSERT INTO findings(run_id, path, line, severity, status, category, m2_severity, body)
       VALUES ($1,$2,$3,$4,'posted',$5,$6,$7)`,
      [run.rows[0].id, f.path, f.line, SEV_MAP[f.severity] || 'nit', f.category, f.severity, `${f.title}\n${f.detail}`],
    )
  }
  return 'pg'
}

/** 把 spool 里积压的记录 flush 进 PG（部署到 hermes 后跑一次） */
export async function flushSpool() {
  if (!pool || !existsSync(SPOOL)) return 0
  const lines = readFileSync(SPOOL, 'utf8').split('\n').filter(Boolean)
  let n = 0
  for (const line of lines) {
    try {
      const rec = JSON.parse(line)
      await recordRun(rec)
      n++
    } catch {
      /* 坏行跳过 */
    }
  }
  if (n > 0) appendFileSync(SPOOL + '.flushed', lines.join('\n') + '\n')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(SPOOL, '')
  return n
}
