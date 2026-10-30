# 菜谱：rotate-container-secret · 容器密钥轮换（零回显）

- **kind**: config
- **归属**: 代码审查插件项目（cr-plugin）的部署资产
- **适用**: 容器 env 文件里某个密钥泄露/到期，需要单值轮换；文件里还有**其他不能进对话的密钥**（所以不能用全量覆写类工具）
- **实跑记录**: 2026-10-31 hermes 通过（DEEPSEEK_API_KEY 轮换：备份→单行替换→force-recreate→API 冒烟 200→旧钥吊销）

## 铁则

1. **新密钥不进对话日志为上策**：能由用户在服务器终端粘贴就不经 agent；已经过对话的按泄露处理，轮换后择期再滚一次
2. **改前备份**（`cp -a env env.bak-$(date +%Y%m%d-%H%M%S)`，600）；备份含旧密钥，**旧钥吊销后删备份**
3. **单行替换**用 `sed -i 's|^KEY=.*|KEY=<新值>|'`，不用全量覆写（其余密钥不落屏）
4. **验证不回显**：`grep -c '^KEY=<新值前缀>'`（存在性）+ 确认旧值前缀 `grep -q` 不存在 + 其他行 `grep -c` 完好 + `wc -l` 行数不变
5. **生效**：`up -d --force-recreate`（restart 不刷 env_file）
6. **冒烟**：用新密钥打一次真实 API，**只回显 HTTP 码**；服务日志确认正常启动
7. 最后一步永远是：**吊销旧密钥**（多数平台吊销无 API，需用户在后台操作）+ 删备份

## 骨架

```sh
set -e
cd /opt/<项目>
BAK="env.bak-$(date +%Y%m%d-%H%M%S)"
cp -a env "$BAK" && chmod 600 "$BAK"
sed -i 's|^<KEY>=.*|<KEY>=<新值>|' env
chmod 600 env
echo "lines: $(wc -l < env)"                       # 行数应不变
echo "new in place: $(grep -c '^<KEY>=<新值>$' env)" # 应为 1
grep -q '<旧值前几位>' env && { echo 'OLD STILL PRESENT'; exit 1; } || echo 'old: gone'
# 其他密钥行完好性（只数行数，不打印值）
docker compose up -d --force-recreate
sleep 8 && docker logs <容器> 2>&1 | tail -5
# 冒烟（只回显状态码）
set -a; . ./env; set +a
curl -s -o /dev/null -w 'smoke: HTTP %{http_code}\n' <用新钥的 API 端点>
```

## 关联

- 泄露源若是"打码读取"失误：读含密文件一律白名单取行（`grep '^KEY='` 重定向到文件）或只验存在性，打码要在服务器侧完成
- 同文件多钥轮换时逐个来，每换一个立即冒烟，别攒批
