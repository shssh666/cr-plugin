-- cr-m2 v1 迁移：findings 增加分类与原始严重度；review_runs.mode 放开 'm2'
-- 幂等，可重复执行
ALTER TABLE findings ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS m2_severity text;
ALTER TABLE review_runs DROP CONSTRAINT IF EXISTS review_runs_mode_check;

-- M4 v1（2026-11-04）：eval_runs 记录投票阈值上下文（阈值对照跑分用；基线同步 discussion-room deploy/pg-init.sql）
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS vote_min int;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS votes int;
