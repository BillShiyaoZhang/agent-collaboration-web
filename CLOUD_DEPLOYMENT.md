# 云端部署指南 (Ubuntu/Debian)

## 环境准备

### 1. 安装 Docker 和 Docker Compose

```bash
# 更新系统
sudo apt update && sudo apt upgrade -y

# 安装依赖
sudo apt install -y ca-certificates curl gnupg

# 添加 Docker GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# 添加 Docker 仓库
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# 安装 Docker
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# 启动 Docker
sudo systemctl start docker
sudo systemctl enable docker

# 将当前用户加入 docker 组（免 sudo）
sudo usermod -aG docker $USER
newgrp docker
```

### 2. 配置防火墙

```bash
# 开放必要端口
sudo ufw allow 22    # SSH
sudo ufw allow 3000  # Web UI
sudo ufw allow 8080  # Platform API
sudo ufw enable
```

---

## 部署步骤

### 1. 上传代码到服务器

```bash
# 在本地打包
zip -r agent-collaboration-web.zip . -x "node_modules/*" ".next/*" "*.db" ".git/*"

# 上传到云服务器 (在本地执行)
scp agent-collaboration-web.zip user@你的服务器IP:/home/ubuntu/

# 在服务器上解压
ssh user@你的服务器IP
unzip agent-collaboration-web.zip
cd agent-collaboration-web
```

### 2. 配置环境变量

```bash
# 创建 .env 文件
cat > .env << EOF
DATABASE_URL="file:./prod.db"
NEXTAUTH_URL="http://你的公网IP:3000"
NEXTAUTH_SECRET="$(openssl rand -base64 32)"
AGENT_PLATFORM_URL="http://localhost:8080"
EOF

# 验证文件
cat .env
```

### 3. 构建并启动

```bash
# 构建镜像（首次需要几分钟）
docker-compose up -d --build

# 查看运行状态
docker-compose ps

# 查看日志
docker-compose logs -f web
docker-compose logs -f platform
```

### 4. 验证部署

```bash
# 检查容器状态
docker ps

# 测试 Web 服务
curl http://localhost:3000

# 测试 Platform API
curl http://localhost:8080/api/v1/registry/ping
```

---

## 配置域名（可选）

如果使用域名而非 IP：

### 1. 修改 .env
```bash
NEXTAUTH_URL="https://your-domain.com"
```

### 2. 配置反向代理 (Nginx)

```bash
sudo apt install -y nginx

sudo cat > /etc/nginx/sites-available/agent-collaboration << EOF
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/agent-collaboration /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 3. 配置 HTTPS (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## 常用运维命令

```bash
# 重启服务
docker-compose restart

# 更新代码后重新部署
docker-compose down
git pull
docker-compose up -d --build

# 查看资源使用
docker stats

# 进入容器调试
docker exec -it agent-collaboration-web-web-1 sh
docker exec -it agent-collaboration-web-platform-1 sh

# 备份数据库
cp prisma/prod.db prisma/prod.db.backup
```

---

## 常见问题

### Q: 登录后提示 URL 不匹配
A: 确保 `NEXTAUTH_URL` 与实际访问地址一致（包含端口）

### Q: Agent 无法注册到 platform
A: 检查 `AGENT_PLATFORM_URL` 是否正确，platform 端口 8080 是否开放

### Q: Docker 构建失败
A: 确保服务器内存充足（建议至少 2GB），清理磁盘空间