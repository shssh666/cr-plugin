import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

function readSecret(envName, filePath) {
  if (process.env[envName]) return process.env[envName].trim()
  const p = filePath.startsWith('~') ? path.join(homedir(), filePath.slice(1)) : filePath
  if (existsSync(p)) return readFileSync(p, 'utf8').trim()
  return null
}

export const config = {
  repo: process.env.CR_REPO || 'shssh666/discussion-room',
  githubToken: readSecret('GITHUB_TOKEN', '~/.cr-token-pr'),
  deepseekKey: readSecret('DEEPSEEK_API_KEY', '~/.dskey-reviewer'),
  deepseekBase: process.env.DEEPSEEK_BASE || 'https://api.deepseek.com',
  model: process.env.CR_MODEL || 'deepseek-chat',
  stateFile: process.env.CR_STATE || path.join(homedir(), '.cr-m2-state.json'),
  maxRounds: Number(process.env.CR_MAX_ROUNDS || 3),
  maxDiffChars: Number(process.env.CR_MAX_DIFF || 60000),
  // v2 投票过滤（C2a）：CR_VOTES=3 独立采样，≥CR_VOTE_MIN 票存活；CR_VOTES=1 退回 v1 行为
  votes: Number(process.env.CR_VOTES || 3),
  voteMin: Number(process.env.CR_VOTE_MIN || 2),
  pollMinutes: Number(process.env.CR_POLL_MIN || 10),
  dryRun: process.argv.includes('--dry-run'),
  noPost: process.argv.includes('--no-post'),
  flush: process.argv.includes('--flush'),
  once: process.argv.includes('--once'),
  onlyPr: (() => {
    const i = process.argv.indexOf('--pr')
    return i >= 0 ? Number(process.argv[i + 1]) : null
  })(),
}

if (!config.githubToken) throw new Error('缺 GITHUB_TOKEN（~/.cr-token-pr）')
if (!config.deepseekKey && !config.dryRun) throw new Error('缺 DEEPSEEK_API_KEY（~/.dskey-reviewer）')
