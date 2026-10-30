import { config } from './config.mjs'

const API = 'https://api.github.com'

async function gh(pathname, opts = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub API ${pathname} -> ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.status === 204 ? null : res.json()
}

export function listOpenPRs() {
  return gh(`/repos/${config.repo}/pulls?state=open&per_page=50`)
}

export function getPR(number) {
  return gh(`/repos/${config.repo}/pulls/${number}`)
}

/** 取两个 SHA 之间的文件级 patch */
export async function getDiff(base, head) {
  const cmp = await gh(`/repos/${config.repo}/compare/${base}...${head}`)
  return (cmp.files || [])
    .map((f) => `--- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})\n${f.patch || '(无 patch，可能为二进制)'}`)
    .join('\n\n')
}

export function listReviews(number) {
  return gh(`/repos/${config.repo}/pulls/${number}/reviews?per_page=100`)
}

/** 以 Pull Request Review 形式发布 findings（只需 Pull requests: write） */
export function postReview(number, commitSha, body) {
  return gh(`/repos/${config.repo}/pulls/${number}/reviews`, {
    method: 'POST',
    body: JSON.stringify({ commit_id: commitSha, event: 'COMMENT', body }),
  })
}

/** v1：带 inline comments 的 review；行不在 diff 里会 422 → 自动降级为纯 body */
export async function postReviewWithComments(number, commitSha, body, comments) {
  if (!comments || comments.length === 0) return postReview(number, commitSha, body)
  try {
    return await gh(`/repos/${config.repo}/pulls/${number}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ commit_id: commitSha, event: 'COMMENT', body, comments }),
    })
  } catch (err) {
    if (String(err.message).includes('422')) {
      console.log(`  (inline comments 422，降级为纯 body；丢弃 ${comments.length} 条行内)`)
      return postReview(number, commitSha, body)
    }
    throw err
  }
}
