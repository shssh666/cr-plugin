# 菜谱：deploy-compose-envfile · 容器应用接入外部数据库网络（env_file 注密）

- **kind**: config
- **归属**: 代码审查插件项目（cr-plugin）的部署资产
- **适用**: docker compose 应用容器需要访问另一 compose 项目里的数据库（跨项目网络），且连接串含密码不能进 compose 明文
- **实跑记录**: 2026-10-31 hermes 通过（room 应用接 crdb_default + PG_DSN，流水线 API store=pg，条件 e2e 3/3）

## 要点

1. **网络**：应用 compose 声明 `networks: [default, <dbproject>_default]`，底部 `<dbproject>_default: {external: true}`；数据库在其项目网络内以**服务名**可解析（如 `postgres`），无需 IP
2. **密钥**：连接串写独立 env 文件（600），compose 用 `env_file:` 注入；派生自既有机密文件时**全程服务器侧**（`grep '^PG_DSN=' 源文件 > 目标`），密钥不经对话/日志
3. **生效**：必须 `up -d --force-recreate`（restart 不刷新 env_file）
4. **验证**：功能行为而非容器状态——API 真实返回（如 store=pg）、页面 200、日志干净、条件 e2e 真库实跑

## 骨架

```sh
set -e
# 1. 派生 env 文件（密钥不落屏）
umask 077
grep '^PG_DSN=' /opt/<db项目>/env > /opt/<app项目>/env
chmod 600 /opt/<app项目>/env

# 2. compose 增量（用带备份的写入通道，validate: docker compose config -q）
#    services.<app>.env_file: [/opt/<app项目>/env]
#    services.<app>.networks: [default, <dbproject>_default]
#    networks: { <dbproject>_default: { external: true } }

# 3. 生效（after: 同命令）
cd /opt/<app项目> && docker compose up -d --force-recreate

# 4. 验证（等构建型应用起来，轮询而非死等）
for i in $(seq 1 24); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:<port><api> || echo 000)
  [ "$code" = 200 ] && break; sleep 10
done
curl -s http://127.0.0.1:<port><api> | head -c 300
```

## 回滚

compose 旧版备份（写入通道自动生成）+ 仓库 `git reset --hard <上个部署提交>` + 再次 force-recreate。
