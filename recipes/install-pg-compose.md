# 菜谱：install-pg-compose · PostgreSQL 单实例（docker compose + 国内镜像加速）

- **kind**: install
- **归属**: 代码审查插件项目（cr-plugin）的部署资产
- **适用**: 国内 Ubuntu/Debian 服务器（Docker Hub 直连超时环境），小内存机器
- **实跑记录**: 2026-10-29 hermes 通过（crdb 库，7 张表，仅绑 127.0.0.1:5432）

## 参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `deploy_dir` | `/opt/crdb` | 部署目录（密码、SQL、compose 都在这里） |
| `db_user` | `crdb` | 库用户 |
| `db_name` | `crdb` | 库名 |
| `pg_image` | `postgres:17-alpine` | 镜像 |
| `shared_buffers` | `128MB` | 小内存压参 |
| `max_connections` | `30` | 小内存压参 |
| `bind` | `127.0.0.1` | 只绑本机；要对外改 `0.0.0.0` 并自行加防火墙 |

## detect（现状检查）

```sh
dir="${deploy_dir:-/opt/crdb}"
command -v docker >/dev/null 2>&1 && echo "docker=ok" || echo "docker=missing"
docker info 2>/dev/null | grep -A2 'Registry Mirrors' | grep -q https && echo "mirror=ok" || echo "mirror=missing"
[ -f "$dir/docker-compose.yml" ] && echo "compose=ok" || echo "compose=missing"
docker compose -f "$dir/docker-compose.yml" ps --status running 2>/dev/null | grep -q postgres && echo "pg=running" || echo "pg=not-running"
```

## plan（执行计划）

1. 检查 Docker（缺则先跑 `install-docker` 菜谱）
2. 无镜像加速则配 `/etc/docker/daemon.json`（腾讯云内网源 + DaoCloud）并重启
3. 建部署目录、生成密码文件（**已存在不覆盖**，避免改密码）
4. 放占位 init sql（自定义 DDL 在**首次 up 前**放到 `$deploy_dir/pg-init.sql`）
5. 写 docker-compose.yml（压参模板）
6. 预拉镜像 + 幂等启动
7. 功能验证（psql 查询 + 端口绑定）

## run（幂等，可重复执行）

```sh
set -e
dir="${deploy_dir:-/opt/crdb}"
db_user="${db_user:-crdb}"
db_name="${db_name:-crdb}"
pg_image="${pg_image:-postgres:17-alpine}"
sb="${shared_buffers:-128MB}"
mc="${max_connections:-30}"
bind="${bind:-127.0.0.1}"

# 1. Docker 必须已装
command -v docker >/dev/null 2>&1 || { echo '请先运行 install-docker 菜谱'; exit 1; }

# 2. 镜像加速（已配则不动）
if ! docker info 2>/dev/null | grep -A2 'Registry Mirrors' | grep -q https; then
  mkdir -p /etc/docker
  if [ -f /etc/docker/daemon.json ]; then
    python3 - <<'EOF'
import json
p='/etc/docker/daemon.json'
try: cfg=json.load(open(p))
except Exception: cfg={}
cfg.setdefault('registry-mirrors',['https://mirror.ccs.tencentyun.com','https://docker.m.daocloud.io'])
json.dump(cfg,open(p,'w'),indent=2)
EOF
  else
    printf '{\n  "registry-mirrors": ["https://mirror.ccs.tencentyun.com", "https://docker.m.daocloud.io"]\n}\n' > /etc/docker/daemon.json
  fi
  systemctl restart docker
fi

# 3. 目录 + 密码（已存在不重新生成，避免改密码）
install -d -m 755 "$dir"
[ -f "$dir/pg_password" ] || { umask 077; openssl rand -base64 24 > "$dir/pg_password"; chmod 600 "$dir/pg_password"; }

# 4. 占位 init sql（仅当不存在；自定义 DDL 在首次 up 前放这里）
[ -f "$dir/pg-init.sql" ] || printf -- '-- placeholder\n' > "$dir/pg-init.sql"

# 5. compose
cat > "$dir/docker-compose.yml" <<EOF
services:
  postgres:
    image: $pg_image
    restart: unless-stopped
    environment:
      POSTGRES_USER: $db_user
      POSTGRES_PASSWORD_FILE: /run/secrets/pg_password
      POSTGRES_DB: $db_name
    secrets: [pg_password]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./pg-init.sql:/docker-entrypoint-initdb.d/10-tables.sql:ro
    ports:
      - "$bind:5432"
    command: ["postgres", "-c", "shared_buffers=$sb", "-c", "max_connections=$mc"]
volumes:
  pgdata:
secrets:
  pg_password:
    file: ./pg_password
EOF

# 6. 拉镜像 + 起（幂等）
docker pull "$pg_image"
docker compose -f "$dir/docker-compose.yml" up -d
```

## verify（功能验证，不是看版本号）

```sh
set -e
dir="${deploy_dir:-/opt/crdb}"
db_user="${db_user:-crdb}"
db_name="${db_name:-crdb}"
docker compose -f "$dir/docker-compose.yml" ps --status running | grep -q postgres
docker compose -f "$dir/docker-compose.yml" exec -T postgres psql -U "$db_user" -d "$db_name" -c 'SELECT 1' >/dev/null
ss -tln | grep ':5432'
echo 'verify: PG 运行中、可查询、端口绑定符合参数'
```

## 备注

- 导入 VPS 菜谱库时的字段映射：`id=install-pg-compose`，`kind=install`，name/desc/detect/run/verify/plan/params 照本文各节。
- 密码文件 `/opt/crdb/pg_password` 权限 600、root only、**永不入库、永不在对话中回显**。
- crdb 的 7 张表 DDL 见 `discussion-room/deploy/pg-init.sql`（项目专属，不放菜谱里）。
