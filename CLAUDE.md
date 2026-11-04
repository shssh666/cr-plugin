# CLAUDE.md — cr-plugin 工具仓约定

> 本仓是代码审查流水线插件：审查引擎（reviewer/）、验证工具箱（m1/）、eval 跑分（m4/+eval/）、流程 skill（skills/）、服务器菜谱（recipes/）。
> **本文件的每条约定都源自真实审查 findings（2026-11-04：fresh-eyes 23 条 + M2 dropped 复盘 + M4 跑分），同类 ≥3 次即沉淀为此**——改约定请附来源编号。

## 这是什么

星曙铸能工作室 · 审核部分。被审查的对象也是审查工具本身：本仓代码质量直接影响流水线公信力。

## 栈

- Node.js ≥24（m1/ 脚本兼容 ≥18），ESM，零依赖优先（pg 为唯一可选依赖）
- 生产：hermes docker（node:24-alpine），PG 17（crdb，仅 127.0.0.1）

## 编码契约（审查必查，违反即 finding）

1. **退出码契约**：`0` 全部成功 / `1` 失败 / `2` 用法错误。任何「承诺了但没做到」的路径（落库失败、校验被跳过、依赖不可用）必须反映到退出码或显式告警——**静默的成功是 bug**（来源：M1#5 脏区 exit 0、M1r2#1 null 放行、M4#1 PG 落库静默）
2. **失败可见性**：每个 `catch`/降级路径必须留痕（`console.error` + 计数）；禁止 `.catch(() => {})` 吞错（来源：M1#7 git 错误吞、M4#1、M4#5 仓规静默缺失）
3. **参数 fail-fast**：带值选项统一 `val()` 模式校验——缺值/`NaN`/越界 → `exit 2`；未知 flag 拒绝而非忽略（拼错参数引发成本放大会被放大审查，来源：M1#10、M1r2#5、M4#4）
4. **副作用隔离**：自检/模拟模式（`--mock`）不得写真实档案或生产存储；工具自身产物不得污染被测状态（如证据文件计入脏树，来源：M4#2、M1r2#2）
5. **长跑容错**：外部连接对象（pg.Pool 等）必须挂 `error` 监听防 idle 崩溃；批量任务的明细增量落盘，不把全跑押在最后一次写（来源：M4#3）
6. **退出语义与文档一致**：头注/README 写的退出码、行为必须与代码一致；**文档示例必须真跑验证**（dogfood），没跑过的示例不许写（来源：M1#1 SHOT_CMD 示例必然 exit 2、M2-dropped#41）

## 流程铁律（同 discussion-room，违反即事故）

- 任何改动走 PR + 审查 + 合并；禁直推 main
- 每条 finding 必须回应：修复，或带理由关闭
- **审查引擎的 prompt/规则改动必须重跑 eval 对比**（`m4/eval-run.mjs`，升留降回）；只升噪声不升召回的改动回退
- schema 变更成对：migrate.sql（存量幂等）+ pg-init.sql 基线（discussion-room 仓）
- 密钥只从 env 读，不落仓、不进对话日志

## 目标 / 非目标

- 目标：审查流水线自身的高质量闭环——工具组合（verify→fresh→subagent→eval）持续沉淀
- 非目标：通用 lint 工具；与审查无关的脚手架

## 验证方式（提 PR 前）

```
node m1/verify-run.mjs --cwd . --cmd "node --check <改动的脚本>"   # 语法 + 证据文件
node m4/eval-run.mjs --mock                                        # 跑分器链路自检
```
触及 reviewer/ 时另跑一次真实 eval 对比（hermes，见 README）。
