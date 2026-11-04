---
name: m1-verify
description: >
  提 PR 前的验证工具箱（M1）：可运行验证产证据（verify run——PR Testing 段唯一合法证据来源）、
  UI 截图留证对比（verify shot）、新上下文复审提示词包（review fresh），以及三个自查技能：
  bug 猎手、diff 简化、端到端行为检查。
  触发条件：用户要提 PR / 做提审前自查 / 说"我做完了"要出证据 / 截图对比设计稿 /
  要 fresh-eyes 复审 / 提到 verify run、verify shot、review fresh、bug 猎手、diff 简化、
  端到端检查、PR 证据。
  不适用：审查他人 PR（用 cr-review-pipeline）；运行时代码问题（先跑 lint/test 再说）。
---

# m1-verify · 提 PR 前的验证工具箱

> 阶段一（PR 前）三件套 + 三技能。北极星配套纪律：**「我做完了」必须等于「verify run 全绿的证据文件」**，
> 口头转述一律不接受（P1 验收标准：PR 必附 verify 证据）。

## 三件套（脚本在 cr-plugin/m1/，零依赖 node ≥18）

### 1. verify run — 可运行验证 + 证据文件

```bash
# 在目标仓根（自动发现 package.json 的 lint/typecheck/test/build）
node <cr-plugin>/m1/verify-run.mjs
# 显式命令（--cmd 可重复，跨平台推荐）/ 自定义输出
node <cr-plugin>/m1/verify-run.mjs --cmd "npm run test:e2e" --out e2e-evidence.md
```

> Windows PowerShell 注意：裸 `--` 可能不被传入脚本（PS 自身吞掉），显式命令请用 `--cmd "..."`（可重复）或环境变量 `VERIFY_CMDS`；POSIX 下 `-- "cmd1" "cmd2"` 亦可。`VERIFY_CMDS` 按 `;`/`,` 拆分多条，命令本身含分号/逗号时改用 `--cmd`（不拆分）。

- 产出 `verify-evidence.md`：时间、HEAD、**工作区干净度**（脏工作区出证会被标注「证据含混」）、逐命令退出码/耗时/输出原文（折叠块，超长截断留痕）
- 退出码：0 全绿 / 1 有失败 / 2 用法错误 —— 可进 CI 与 pre-push
- **PR 规则**：Testing 段引用本文件内容（或直接贴），不许手打"测试过了"

### 2. verify shot — UI 截图留证

```bash
# 有截图工具时（SHOT_CMD 负责产出到 --actual 指定路径；--actual 始终必填）
SHOT_CMD="npx playwright screenshot <url> shot.png" node <cr-plugin>/m1/verify-shot.mjs --actual shot.png --expected design.png --note "场景"
# 已有截图时
node <cr-plugin>/m1/verify-shot.mjs --actual shot.png --expected design.png
```

- 产出 `shot-evidence.md`：并排图表 + 检查清单 + 结论槽位
- 视觉判断交给**人或 VL subagent**（把证据文件和图交给能读图的 agent），v1 不做像素 diff；**结论槽位不许空着合并**

### 3. review fresh — 新上下文复审

```bash
node <cr-plugin>/m1/review-fresh.mjs --base main   # diff = main → 工作区（含未提交）
```

- 产出 `review-fresh-prompt.md`：diff 原文 + CLAUDE.md + REVIEW.md + 审查纪律的完整提示词包
- **消费铁律**：整份内容交给**全新上下文的 subagent**（DSH subagent 工具 / 新会话），**不带任何作者解释**；findings 按格式回流 PR
- 这是双引擎外的第三双眼睛：没有作者立场的纯 diff 视角

## 三技能（自查 playbook）

### bug 猎手（对 diff 空跑一遍审查再提 PR）

拿 review-fresh 的提示词包，但以**作者身份**自查：逐 hunk 问「这段在什么输入下会坏？」。重点四问（对齐 REVIEW.md 必查级）：
1. 并发与状态：有没有跨 await 的 check-then-act？断线/重入路径状态对吗？
2. 文件安全：校验在**服务端**生效了吗？前端限制只算体验。
3. 资源预算：新对象会不会无限增长？大文件路径流式了吗（服务器 1.9G）？
4. 证据：我能不能给每个结论标 `文件:行号`？标不出 = 不确定 = 回去读代码。
产出与处置：自查 findings 修完再提 PR；修不完的写进 PR 的 Risk 段。

### diff 简化（末提交最小性从源头做起）

提 PR 前对 diff 本身过一遍：删调试代码/注释掉的旧代码；能不动的文件绝不碰（diff 里每个文件都要能答出「为什么在这」）；重复逻辑可否收敛；改法是不是最小closure（不是最炫 closure）。参考先例：PR#9 末提交 6 文件 +37/-5 过裁决三要素。

### 端到端行为检查（改了什么就验什么行为）

把 diff 映射成用户可见行为清单（每条：行为 → 触发路径 → 对应 e2e），逐条跑：
discussion-room 有现成 e2e 家族（`npm run test:e2e*`）；新增行为没有对应 e2e = 缺口，要么补测试要么在 PR 里声明为什么没有。输出用 `verify-run --cmd "npm run test:e2e:xxx" --out e2e-evidence.md` 留证。

## 与流水线的衔接

- 证据文件（verify-evidence / shot-evidence / e2e-evidence）随 PR 正文提交；M2/DSH 审查时会核对 Testing 段与证据一致性
- review fresh 的 findings 与双引擎 findings 同等对待：**修复，或带理由关闭**
- 阶段一做扎实 → 阶段二（PR 中）轮数下降 → 北极星（≤1 人在环）才有基础
