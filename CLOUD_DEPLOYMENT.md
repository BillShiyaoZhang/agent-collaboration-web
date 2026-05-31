# 云端部署指南 (Ubuntu/Debian)

## 架构说明

```
                           ┌──────────────────────┐
                           │     Nginx (80/443)    │
                           │   反向代理 + SSL      │
                           └──────────┬───────────┘
                                      │
                         ┌────────────┴────────────┐
                         ▼                         ▼
                 ┌──────────────┐         ┌──────────────┐
                 │   Web UI     │         │   Platform   │
                 │  localhost   │         │  localhost    │
                 │    :3000     │         │    :8080     │
                 └──────────────┘         └──────────────┘
                       │                        ▲
                       │  AGENT_PLATFORM_URL     │
                       └────────────────────────┘
```

本指南只部署 **Web UI**。Platform 需单独部署，参见 [agent-comm-platform](https://github.com/BillShiyaoZhang/agent-comm-platform)。

## 环境准备

### 1. 安装必要软件

```bash
# 更新系统
sudo apt update && sudo apt upgrade -y

# 安装 Docker
sudo apt install -y ca-certificates curl gnupg
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl start docker && sudo systemctl enable docker

# 安装 Nginx
sudo apt install -y nginx

# 安装 Git
sudo apt install -y git
```

### 2. 配置防火墙

```bash
sudo ufw allow 22    # SSH（如果需要远程管理）
sudo ufw allow 80     # HTTP
sudo ufw allow 443   # HTTPS
sudo ufw enable
```

---

## 部署步骤

### 1. 从 GitHub 拉取 Web 项目

```bash
git clone https://github.com/BillShiyaoZhang/agent-collaboration-web.git
cd agent-collaboration-web
```

### 2. 配置环境变量

```bash
# 复制模板
cp .env.example .env

# 编辑配置
nano .env
```

```env
DATABASE_URL="file:./prod.db"
NEXTAUTH_URL="http://你的公网IP"          # 或你的域名
NEXTAUTH_SECRET="$(openssl rand -base64 32)"

# Platform 地址（指向已部署的 platform）
AGENT_PLATFORM_URL="http://platform.example.com:8080"
```

> **重要**：`AGENT_PLATFORM_URL` 填写你部署的 Platform 地址（可以是 IP 或域名）。

### 3. 配置 Nginx 反向代理

```bash
sudo nano /etc/nginx/sites-available/agent-collaboration
```

```nginx
server {
    listen 80;
    server_name your-domain.com;  # 或公网 IP

    # Web UI
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
```

启用配置：

```bash
sudo ln -s /etc/nginx/sites-available/agent-collaboration /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

### 4. 修改 docker-compose.yml（移除 platform 服务）

Web 项目默认的 docker-compose.yml 包含 platform 服务。分离部署时需要移除：

编辑 `docker-compose.yml`，删除 `platform` 服务及其依赖：

```yaml
services:
  web:
    build:
      context: .
      dockerfile: Dockerfile
    expose:
      - "3000"
    environment:
      - DATABASE_URL=file:./prod.db
      - NEXTAUTH_URL=${NEXTAUTH_URL:-http://localhost:3000}
      - NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
      - AGENT_PLATFORM_URL=${AGENT_PLATFORM_URL:-http://localhost:8080}
    volumes:
      - ./prisma:/app/prisma
    restart: unless-stopped
```

### 5. 启动 Web 服务

```bash
docker-compose up -d --build
docker-compose ps
docker-compose logs -f
```

### 6. 验证

```bash
curl http://localhost
```

访问 `http://你的公网IP`

---

## Platform 单独部署

Platform 部署在另一台服务器或同一台的不同端口，参见 [agent-comm-platform 仓库](https://github.com/BillShiyaoZhang/agent-comm-platform)。

部署后确保 Web 的 `AGENT_PLATFORM_URL` 指向正确的 Platform 地址。

---

## 更新代码

```bash
cd agent-collaboration-web
git pull
docker-compose up -d --build
```

---

## 域名 + HTTPS（可选）

### 1. 安装 Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
```

### 2. 申请 SSL 证书

```bash
sudo certbot --nginx -d your-domain.com
```

---

## 常用运维命令

```bash
# 重启
docker-compose restart

# 查看日志
docker-compose logs -f web

# 进入容器
docker exec -it agent-collaboration-web-web-1 sh

# 备份数据库
cp prisma/prod.db prisma/prod.db.backup
```

---

## 常见问题

### Q: 访问页面显示 502
A: `docker-compose ps` 检查 web 是否启动，`docker-compose logs web` 查看错误

### Q: 登录后跳转到错误地址
A: 确保 `.env` 中 `NEXTAUTH_URL` 与实际访问地址一致

### Q: Agent 无法注册/发现
A: 检查 `AGENT_PLATFORM_URL` 是否指向正确的 Platform 地址，Platform 是否正常运行