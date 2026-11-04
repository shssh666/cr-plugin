# cr-plugin · 代码审查流水线插件（开发版）

> **星曙铸能工作室 · 审核部分**。双引擎 PR 审查流水线：cr-m2 自研审查引擎 + 流程固化 skills + 服务器部署菜谱。
> 状态：**v0.3-dev（开发版）**——工作流已在试点仓 9 个 PR 上实战闭环；v2 落地 C2a 投票过滤；插件化封装未完成（见"已知缺陷"）。

## 这是什么

把《How the Claude Code team does code review》的审查流程，落成可复用的 DSH 插件资产：

```
cr-plugin/
├── skills/cr-review-pipeline/   # 工作流固化：双引擎审查全流程纪律（SKILL.md + 细则参考）
├── reviewer/                    # cr-m2 审查引擎（Node 24，增量审查 + 收敛四规则 + PG 落库）
├── recipes/                     # 服务器菜谱（PG 部署 / compose+env_file 部署 / 密钥轮换）
├── cordis.patch.yml             # DSH bundle 挂载点（skills provider）
└── lib/index.js                 # 运行时入口（v0 占位，未注册工具）
```

## 实战履历（试点仓 discussion-room，9 PR 全合并）

- **双引擎互补实证**：M2 强资源泄漏/清理/测试缺口/约定合规；DSH-action 强异步竞态/跨文件一致性；双引擎同报 = 免复核高优（PR#9 migrate 约束条实证）
- **收敛机制实证**：3 轮上限（PR#6 触发）、增量 diff-only 复审（PR#7/#9 R2 均 0 findings 收敛）
- **人工裁决条款实证 2 例**：引擎超时 ≠ 代码问题（PR#6 R5、PR#9 R2），三要素读证合并
- **指标落库**：findings/runs/prs 入 PostgreSQL，流水线看板 store=pg 实时可视

## cr-m2 引擎（reviewer/）

```bash
cd reviewer && npm install
cp env.example env  # GITHUB_TOKEN / DEEPSEEK_API_KEY / PG_DSN（可选，缺省 spool 降级）
node index.mjs --once      # 审查一轮所有开放 PR
node index.mjs --dry-run   # 只打印不发评论
node index.mjs             # 常驻轮询（默认 10 分钟）
```

特性：增量审查（首轮全量建指纹，后续 diff-only）· 收敛四规则 · 8 类问题分类 · inline comments（422 自动降级）· findings 落 PG（spool 降级 + 启动 flush）· reviewer_version=prompt 哈希可回溯。

## 安装（路线图，未实测）

```
dsh plugin --profile web add github:shssh666/cr-plugin
```

dev 版仅保证 skills 内容与引擎可独立运行；bundle 挂载未经安装实测（见缺陷 ①）。

## 已知缺陷（诚实清单）

1. **插件安装未实测**：cordis.patch.yml 按 brooks-lint 惯例写，未经 `dsh plugin add` 真装验证
2. ~~**M2 无投票过滤**~~ ✅ v2 已落（C2a，2026-11-04）：3 票独立采样按 path|category 计票 ≥2 存活 + 双引擎同报加权；落选入库 `dropped_by_vote`
3. ~~**fingerprint 含 title**~~ ✅ v2 已改 `path|category`（哈希前缀隔离旧状态）
4. **无 eval 集**：35 条已裁决 findings 已备种子，跑分框架未建（M4）
5. **lib/ 为占位 stub**：未注册任何 DSH 运行时工具；M1 验证工具箱（verify run/shot）未接入

## 边界声明

- 本仓**只存 PR 审查相关资产**（引擎/skills/菜谱）；聊天室产品在同工作室 `discussion-room` 仓
- 项目管理文档（计划表/交接文档）**不入 GitHub**，归档于服务器 `/opt/docs`（CRLF Windows 格式）
- 任何密钥不落仓：引擎从 env 读，菜谱只写路径与权限约定

## 许可

许可待定（工作室统一决定前保留所有权利）。
