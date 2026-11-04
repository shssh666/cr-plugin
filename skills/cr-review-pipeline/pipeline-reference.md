# pipeline-reference.md · 审查流水线细则（cr-review-pipeline 配套）

> SKILL.md 是纪律主干，本文是执行细则与实战数据。来源：试点仓 discussion-room 9 PR / 35 findings 全量复盘。

## 1. 增量审查策略

```
PR 首次审查 → 全量扫描，建立该仓"问题指纹"（fingerprint = path|category 哈希，v2）
     ↓
后续轮次 → 只看新 diff + 例外扩大：
  • 修改已知高危文件（上传/房间/入口）→ 扩大到该文件全文
  • 新增 I/O 边界（新路由、新 ws handler）→ 触发安全检查清单
  • lockfile 变了 → 自动跑 npm ci 验证（不等 AI）
     ↓
每种问题类型独立计数 → 同类 3 次 → 沉淀为 lint 规则 / REVIEW.md 条目 / eval case
```

v2 已改：fingerprint = path|category（2026-11-04，与 C2a 投票过滤一并落地：同 prompt 3 票独立采样、≥2 票存活、外部引擎同 path 加权 1 票存活；落选 status=dropped_by_vote 入库供 M4）。

## 2. 问题类型图谱（8 类，按自动化难度）

| 类型 | 典型表现 | 自动化难度 |
|---|---|---|
| 模块图/构建断裂 | import 解析失败、白屏 | 🟢 lint/typecheck |
| 依赖/lockfile 不同步 | npm ci 失败、CI 红 | 🟢 pre-push hook |
| API 契约不安全 | payload:null 崩溃、缺 error 监听 | 🟡 语义理解 |
| 安全：输入校验缺失 | 路径穿越、MIME 伪装、XSS | 🟡 模式+语义 |
| 资源限制缺失 | 无大小上限、无速率限制、OOM | 🟡 业务上下文 |
| 并发/状态竞态 | check-then-act 跨 await、世代错乱 | 🔴 最难（外部引擎相对强） |
| 前端 UI 状态 bug | 按钮永久 disabled、位置映射泄漏 | 🟡 e2e |
| 测试本身有缺陷 | 断言竞态、只测降级分支 | 🟡 运行验证 |

## 3. 审查噪声四分类

每条 finding 结案归入：`fixed`（修了）/ `wrong`（假阳）/ `intentional`（有意为之，带理由关闭）/ `ignored`（记录不处理）。
干净 PR 的有害率（提了但全 wrong/intentional）是引擎精度的核心指标。实战基线：自研 M2 召回高、精度约 40%；外部 DSH 精度高、召回低（有漏报实证）。

## 4. 人工裁决操作单（引擎超时/崩溃时）

1. 确认失败是基础设施性质：查 run 的 failure code（如 DSH_TIMEOUT）与步骤时序，确认引擎未产出任何 finding
2. 读证三要素：
   - CI 必需检查（required contexts）全绿——注意区分必需与非必需检查
   - 历轮 findings 全部有处置记录（修复 commit 或带理由关闭，线程可查）
   - 末提交最小性：`git show --stat` 核对改动逐条对应 findings 回应
3. 请示人类负责人批准（裁决权在人不在 agent）
4. 批准后：resolve 全部线程 → API squash 合并，裁决理由与证据写进 commit message
5. 实战先例：PR#6 R5（DSH 第二次超时）、PR#9 R2（第三次超时，10m44s，DSH_TIMEOUT）

## 5. 分支保护下的合并 mechanics

- `required_conversation_resolution: true`：合并前必须 resolve 所有 review 线程。
  批量：一条 GraphQL mutation 用别名 `t0: resolveReviewThread(input:{threadId:"…"}) { thread { isResolved } } t1: …`
- `mergeable_state`：`blocked`=必需闸未过（查线程/必需检查）；`unstable`=非必需检查失败，**可合并**
- squash 合并请求带 `sha` 字段锁定 head，防竞态
- squash 后旧分支谱系断裂：**禁止续用**，下一个 PR 从 main 新建分支；合并后及时删特性分支（远程+本地）

## 6. 部署踩坑清单（实证）

- `docker restart` 不刷新 env_file → 必须 `up -d --force-recreate`
- pg Pool 不 end 进程不退出 → 一次性命令收尾 closeStore；常驻进程启动时 flush spool
- 云防火墙才是真闸，主机 iptables 无效（且重启即丢）
- 国内服务器 → github.com git https 间歇不通：fetch 写重试循环用 `if git fetch; then` 判定（**别管道到 tail**，管道吃退出码）；api.github.com / codeload.github.com 通常稳定，可做备用通道（tarball / Git Data API）
- 小内存机（<2G）：应用容器启动时 npm ci + build 是常态，验证要等构建完成再打 API
- **`docker cp` 到容器内已存在的目录会嵌套而非覆盖**（2026-11-04 实证：eval 重放三次都跑了第一次的旧代码+旧快照，diff 字符数雷同暴露）→ 容器侧复用路径必须先 `docker exec … rm -rf <目标>`；**对照实验必须跑前断言版本指纹**（REVIEWER_VERSION 不符即中止），版本打印纪律是环境污染的最后防线

## 7. 审查者视角（REVIEW.md 模板要点）

- 首行写清"这个仓的失败长什么样"（3-4 条业务级故障形态），审查围绕它展开
- 必查级：并发与状态 / 文件安全（服务端生效）/ 资源预算（流式、无无限增长对象）/ 证据要求（文件:行号，禁止从函数名猜行为）/ 流程合规（绕过审查痕迹直接报 high）
- Nit 上限：每 PR 最多 3 条风格类，超出归并一句"其余见 lint 输出"
- 跳过路径：dist/、docs/、*.md（规范文件自身变更除外）
- 摘要格式：计数开头（`2 Important, 1 Nit`）；没有要修的就直说"没有要修的"

## 8. 度量与北极星

- 北极星：大多数 PR ≤ 1 人在环（人工批准数/PR，中位数 + p95）
- 过程度量：人工评论数、PR 等人时长、审查轮数（自动采集入 PG）
- 护栏：回滚率、事故率——上升 = 只是把人力转移了，不算赢
- 对标（原文数据）：一轮通过率 65%→78%、≥5 轮 8.9%→1.5%、平均轮数 2.08→1.32
