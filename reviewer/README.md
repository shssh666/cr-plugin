# cr-m2 · 自研 AI 审查引擎（最小骨架 v0）

> 替换 DSH-action 的自研审查引擎。解决 DSH-action 的 600s 硬超时，落地计划表 v1.0 的
> **增量审查 + 收敛四规则 + 问题分类** 三大设计。

## 运行

```bash
# 单次审查指定 PR（dry-run 只打印不发布）
node index.mjs --dry-run --pr 4

# 单次审查所有 open PR（真实发布评论）
node index.mjs --once

# 轮询模式（默认 10 分钟一次）
node index.mjs
```

## 配置（env 或文件）

| 项 | 来源 | 说明 |
|---|---|---|
| `GITHUB_TOKEN` | env / `~/.cr-token-pr` | 需 Pull requests: write（以 Review 形式发 findings） |
| `DEEPSEEK_API_KEY` | env / `~/.dskey-reviewer` | 审查模型密钥 |
| `CR_REPO` | env | 默认 `shssh666/discussion-room` |
| `CR_REPO_ROOT` | env | 读 CLAUDE.md / REVIEW.md 的仓库根（默认 `../../discussion-room`） |
| `CR_MAX_ROUNDS` | env | 收敛规则 1：每 PR 轮数上限，默认 3 |
| `CR_MAX_DIFF` | env | diff 截断阈值字符数，默认 60000 |
| `CR_POLL_MIN` | env | 轮询间隔分钟 |
| `CR_STATE` | env | 状态文件路径，默认 `~/.cr-m2-state.json` |

## 三大设计落地

1. **增量审查**：状态文件记 `reviewedSha`；首轮 `base...head` 全量，后续 `reviewedSha...head` 只看新 diff；空 diff 跳过
2. **收敛四规则**：
   - 超 3 轮停（`CR_MAX_ROUNDS`），提示人工重想方案
   - 后续轮只看新改动（增量即此）
   - 同类问题一次全指（prompt 要求 + 按 category 聚合展示）
   - 不重复（fingerprint = sha1(path|category|title)，历史指纹进 prompt + 发布前过滤）
3. **问题分类**：8 类 taxonomy（build/module-graph · dependency/lockfile · api-contract · security/input · resource-limits · concurrency/state · ui/state · test/defect），findings 带 category，为 M4 沉淀做准备

## 与 DSH-action 的差异

| | DSH-action | cr-m2 v0 |
|---|---|---|
| 超时 | 600s 硬限（参数不生效） | 自控（LLM 单次调用，无整体硬限） |
| 审查范围 | 每次全量 | 增量（reviewedSha 之后） |
| 重复意见 | 靠模型自觉 | fingerprint 硬过滤 |
| 轮数 | 无限制 | 3 轮上限 |
| 发布形式 | summary + inline | v0 仅 review body（inline 在 v1） |
| 数据沉淀 | 无 | 状态文件（v1 接 PG findings 表） |

## 已验证

- 2026-10-30 dry-run PR#4：5 findings（1 high）——抓到 DSH-action 漏报的
  「demo 消息未校验 file 归属」（security/input），分类与证据格式正确
- 2026-10-30 dry-run PR#5：11 findings（2 high）vs DSH-action 0 findings。
  人工裁决 3 真 / 3 假阳 / 5 弱 → **精度 ~40%，召回高于 DSH-action**。
  假阳模式记录（供 prompt 迭代）：
  1. 误判 Node 单线程内 check-then-set 为竞态（无 await 即原子）
  2. 忽略上游已存在的校验（upload 已验 magic，convert 无需重复）
  3. 忽略 finally 已覆盖的清理路径
  → v1 prompt 增加三条反例约束

## v1 已落地（2026-10-30）

- **inline comments**：findings 带 path+line 以 review comments 形式落到具体行；行不在 diff 内（422）自动降级纯 body
- **findings 落 PG**：review_runs（mode='m2' + reviewer_version）+ findings（category/m2_severity）；
  PG 不可达时降级本地 spool（`~/.cr-m2-spool.jsonl`），部署后 `--flush` 一次性入库
- **reviewer_version**：sha1(system prompt + taxonomy + model) 前 12 位，prompt 任何改动可回溯（M4 跑分键）
- **反例约束进 prompt**：4 条历史假阳模式（Node 原子性 / 上游已校验 / finally 已覆盖 / 缺代码类需 grep 确认）
- 新参数：`--no-post`（跑 LLM+落库但不发评论）、`--flush`（spool 入 PG）
- hermes PG 迁移已执行：findings +category/+m2_severity；review_runs.mode 放开 'm2'

## v1 待做

- inline comments（review comments API + position 映射）
- findings 写入 PG（findings 表 + reviewer_version）
- 部署 hermes（systemd timer 或 docker）
- 多 agent 投票过滤（C2a）
- 噪声度量回路（M4）
