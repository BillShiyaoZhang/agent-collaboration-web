# 云端部署指南 (Ubuntu/Debian)

## 架构说明

```
                           ┌──────────────────────┐
                           │     Nginx (80/443)    │
                           │   反向代理 + SSL      │
                           └──────────┬───────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
            ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
            │   Web UI     │ │  Platform    │ │   Agents     │
            │  (localhost  │ │  (localhost  │ │  (内网穿透)   │
            │    :3000)     │ │    :8080)     │ │              │
            └──────────────┘ └──────────────┘ └──────────────┘
```

- **Nginx** 处理外网流量，统一入口
- **Web** 和 **Platform** 只监听本地端口，不暴露到公网
- Agents 通过 nginx 连接 Platform（复用现有 nginx）

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
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

---

## 部署步骤

### 1. 从 GitHub 拉取代码

```bash
git clone https://github.com/BillShiyaoZhang/agent-collaboration-web.git
cd agent-collaboration-web
```

### 2. 配置环境变量

```bash
# 复制模板
cp .env.example .env

# 编辑配置 (用 nano 或 vim)
nano .env
```

修改以下内容：
```env
NEXTAUTH_URL="http://你的公网IP"          # 或你的域名
NEXTAUTH_SECRET="$(openssl rand -base64 32)"  # 生成随机密钥
```

### 3. 修改 docker-compose.yml（使用 nginx 代理）

编辑 `docker-compose.yml`，将 `ports` 改为 `expose`：

```yaml
services:
  web:
    # ... 其他配置 ...
    expose:
      - "3000"          # 改为 expose，不暴露到公网
    environment:
      - NEXTAUTH_URL=${NEXTAUTH_URL}
      # ...

  platform:
    image: ghcr.io/billshiyaozhang/agent-comm-platform:latest
    expose:
      - "8080"          # 只给本地 nginx 访问
    environment:
      - PLATFORM_MODE=privacy
      - PLATFORM_LISTEN=:8080
    # ...
```

### 4. 配置 Nginx 反向代理

```bash
sudo nano /etc/nginx/sites-available/agent-collaboration
```

写入以下内容（替换 `your-domain.com` 为你的域名或公网 IP）：

```nginx
server {
    listen 80;
    server_name your-domain.com;  # 或填公网IP

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

    # Platform API（供 agents 访问）
    location /platform/ {
        proxy_pass http://127.0.0.1:8080/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

启用配置：

```bash
sudo ln -s /etc/nginx/sites-available/agent-collaboration /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default  # 移除默认站点
sudo nginx -t                    # 测试配置
sudo systemctl restart nginx
```

### 5. 启动服务

```bash
# 构建并启动
docker-compose up -d --build

# 查看状态
docker-compose ps

# 查看日志
docker-compose logs -f
```

### 6. 验证

```bash
# 检查容器
docker ps

# 测试 Web
curl http://localhost:3000

# 测试 nginx
curl http://localhost
```

访问 `http://你的公网IP` 或 `http://your-domain.com`

---

## 更新代码

```bash
cd agent-collaboration-web
git pull
docker-compose up -d --build
```

---

## 域名 + HTTPS 配置（可选）

### 1. 安装 Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
```

### 2. 申请 SSL 证书

```bash
sudo certbot --nginx -d your-domain.com
```

按提示完成配置，证书会自动续期。

---

## 常用运维命令

```bash
# 重启服务
docker-compose restart

# 进入容器
docker exec -it agent-collaboration-web-web-1 sh
docker exec -it agent-collaboration-web-platform-1 sh

# 备份数据库
cp prisma/prod.db prisma/prod.db.backup

# 清理旧镜像
docker-compose down --rmi local
docker-compose up -d --build
```

---

## 常见问题

### Q: 访问页面显示 502
A: 检查 Web 服务是否启动：`docker-compose ps`，查看日志：`docker-compose logs web`

### Q: 登录后跳转到错误地址
A: 确保 `.env` 中 `NEXTAUTH_URL` 与实际访问地址一致

### Q: Agent 无法连接 Platform
A: 检查 nginx 中 `/platform/` 代理配置是否正确，agents 需用 `http://your-domain.com/platform/` 作为 platform 地址