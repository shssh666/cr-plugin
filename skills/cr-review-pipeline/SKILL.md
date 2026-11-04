---
name: cr-review-pipeline
description: >
  双引擎 PR 审查流水线的全流程纪律：建分支提 PR、双引擎审查（cr-m2 自研 + DSH-action 外部）、
  findings 逐条回应、收敛与人工裁决、保护规则下合并、部署四查与功能验证、密钥卫生。
  触发条件：用户要求审查 PR / 提交 PR / 处理审查意见 / 引擎超时或崩溃后裁决合并 /
  部署前检查 / 合并被分支保护阻塞，或提到：双引擎、增量审查、findings、审查轮数、
  squash 合并、required_conversation_resolution、部署四查。
  不适用：写业务功能代码本身；单文件风格检查（直接用 lint）；无 PR 流程的个人草稿仓。
---

# cr-review-pipeline · 双引擎 PR 审查流水线

> 星曙铸能工作室 · 审核部分。9 个 PR 实战闭环固化的流程纪律。细则见同目录 `pipeline-reference.md`。

## 铁律（违反即事故）

1. **任何改动走 PR + 审查 + 合并**——含 hotfix、含"很明显"的修复，无一例外（hotfix 标题加 `HOTFIX:`，审查可快不可省）
2. **禁直推 main、禁解除分支保护**——合并永远走 API/PR 通道
3. 冲突在特性分支解决后**重新过审查**，不允许解完直接合
4. **部署四查**：有 PR？有审查记录？有回滚路径？CI 绿？
5. schema 变更**成对**：新环境基线（init SQL）+ 存量幂等自愈迁移
6. **每条 finding 必须回应**：修复，或带理由关闭——并在 PR 线程里留痕

## 流程主干

```
main 新建分支（squash 合并后旧分支禁止续用）
  → 开发 + 本地验证（verify-run 产证据文件 = Testing 段唯一合法来源；裸控制台输出不作数）
  → 提 PR → 三眼审查
      M2 投票引擎：R1 全量建指纹 / R2+ 增量（高危文件扩大；新 I/O 边界触发安全清单；lockfile 变更自动 npm ci）
      DSH-action：异步竞态/跨文件一致性强项
      fresh-eyes：review-fresh 提示词包 → 全新上下文 subagent（不带作者解释）——微妙语义 bug 召回主力
  → findings 逐条回应（修复 commit 或带理由回复）
  → 收敛判定（见下）→ 合并 → 部署 → 功能验证
```

## 收敛与裁决

- **收敛四规则**：3 轮上限 · 前几轮后只看新改动 · 同类问题一次全部指出 · 不提重复意见
- 同类 bug 被报 **≥3 次 = 设计问题信号** → 升级人工设计评审，不再打补丁
- **人工裁决条款**：引擎超时/崩溃 ≠ 代码问题。外部引擎因基础设施失败无法收口时，人工读证三要素可裁决合并：
  ① CI 必需检查全绿 ② 历轮 findings 全部有处置记录 ③ 末提交最小（逐条对应 findings）
  裁决理由**写进合并 commit message** 留档
- **三眼分工**（2026-11-04 实证升级）：M2 投票引擎强资源/清理/测试缺口/约定合规、压不一致噪声；DSH-action 强异步竞态/跨文件一致性（有硬超时，大 diff 必超时）；**fresh-eyes 强微妙语义 bug**（M2 对二阶语义 bug 实测票池=0，fresh-eyes 同批 6/6 全中）。**双引擎同报 = 免复核高优**；引擎与人工裁决冲突且引擎高票复现 → 列裁决复核候选（eval 反向挑战）
- **findings 三去向闭环**（同类 ≥3 次必沉淀）：每条审出的问题 ①修代码（PR）②反哺规则——CLAUDE.md/REVIEW.md 契约、SYSTEM_PROMPT 反例、skill 条目、lint 规则 ③入 eval 种子（cases.json，注意快照取 bug 存在时点）。只修代码不复盘 = 同类问题必然重演（实例：cr-plugin CLAUDE.md 六契约即历史 findings——fresh-eyes 23 条 + M2 dropped + M4 跑分——的沉淀）

## 合并操作要点

- `required_conversation_resolution=true` 时：先 GraphQL `resolveReviewThread`  resolve 全部线程（一条 mutation 用别名可批量），否则 mergeable_state 恒为 blocked
- 非必需检查失败（如超时引擎的 check）→ mergeable_state=unstable，**不阻** API 合并
- squash 合并并锁定 head sha（防合并瞬间有新推送）；合并信息含审查记录摘要

## 部署与验证

- env 变更必须 `up -d --force-recreate`（restart 不刷新 env_file）
- **验证功能行为而非版本号**：API 真实返回 + 页面 200 + 日志干净 + 条件 e2e 真库实跑
- 服务器上的热修**必须当日回传本地仓提交**——否则下次"上传工作区"会把运行版打回旧版

## 密钥卫生

- 密钥只存 600 权限文件，**永不经对话/日志/仓库**；读含密文件用白名单取行（`grep '^KEY='` 重定向）或只验存在性（`grep -c`）
- 改容器密钥不用全量覆写（会把其余密钥拉进对话）：服务器侧 `sed` 单行替换 + 手动备份 + 不回显验证 + force-recreate + API 冒烟（只回显 HTTP 码）
- 泄露即轮换：换新 → 部署 → 删含旧值的备份 → 吊销旧密钥
- 部署完成后附访问链接（交付习惯）
