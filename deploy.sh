#!/bin/bash
# 部署脚本：本地 → 服务器
set -e
SERVER="root@42.194.158.77"
REMOTE_ROOT="/var/www/scroll-verse"

echo "=== 1/4 服务器端准备目录 ==="
ssh $SERVER "mkdir -p $REMOTE_ROOT/{astra,neon,biolum} && chown -R www-data:www-data $REMOTE_ROOT"

echo "=== 2/4 传输文件（约240MB） ==="
# 三站静态文件
rsync -avz --progress \
  --exclude '_discarded' --exclude 'test' --exclude 'tools' --exclude '*.log' \
  --exclude '.git' --exclude 'PLAN-*.md' --exclude 'README*.md' \
  astra/ $SERVER:$REMOTE_ROOT/astra/
rsync -avz --progress \
  --exclude '_discarded' --exclude 'test' --exclude '*.log' \
  --exclude '.git' --exclude 'PLAN-*.md' --exclude 'README*.md' --exclude 'keys/' \
  --exclude 'city-tower.png' \
  neon/ $SERVER:$REMOTE_ROOT/neon/
rsync -avz --progress \
  --exclude 'test' --exclude '*.log' \
  --exclude '.git' --exclude 'PLAN-*.md' --exclude 'README*.md' \
  biolum/ $REMOTE_ROOT/biolum/

# 入口页
scp landing.html $SERVER:$REMOTE_ROOT/index.html

echo "=== 3/4 配置 nginx ==="
ssh $SERVER "cat > /etc/nginx/sites-available/scroll-verse << 'NGINX'
# 入口页（根域名）
server {
    listen 80;
    listen [::]:80;
    server_name veilchow.space www.veilchow.space;
    root $REMOTE_ROOT;
    index index.html;
    location / { try_files \$uri \$uri/ =404; }
    location ~* \.(mp4|png|jpg|webp|svg|ico|css|js|woff2)$ {
        expires 30d;
        add_header Cache-Control \"public, immutable\";
    }
}

# ASTRA
server {
    listen 80;
    listen [::]:80;
    server_name astra.veilchow.space;
    root $REMOTE_ROOT/astra;
    index index.html;
    location / { try_files \$uri \$uri/ =404; }
    location ~* \.(mp4|png)$ { expires 30d; add_header Cache-Control \"public, immutable\"; }
}

# NEON
server {
    listen 80;
    listen [::]:80;
    server_name neon.veilchow.space;
    root $REMOTE_ROOT/neon;
    index index.html;
    location / { try_files \$uri \$uri/ =404; }
    location ~* \.(mp4|png)$ { expires 30d; add_header Cache-Control \"public, immutable\"; }
}

# BIOLUM
server {
    listen 80;
    listen [::]:80;
    server_name biolum.veilchow.space;
    root $REMOTE_ROOT/biolum;
    index index.html;
    location / { try_files \$uri \$uri/ =404; }
    location ~* \.(mp4|png)$ { expires 30d; add_header Cache-Control \"public, immutable\"; }
}
NGINX
ln -sf /etc/nginx/sites-available/scroll-verse /etc/nginx/sites-enabled/scroll-verse
nginx -t && systemctl reload nginx
echo 'nginx configured'"

echo "=== 4/4 修复站内路径（landing 的图片引用根路径 → 同域可访问） ==="
# landing 页中的 /astra/ /neon/ /biolum/ 路径在同域名下已经正确
# 不需要修改

echo ""
echo "=== 部署完成 ==="
echo "入口页: http://veilchow.space"
echo "ASTRA:  http://astra.veilchow.space"
echo "NEON:   http://neon.veilchow.space"
echo "BIOLUM: http://biolum.veilchow.space"
echo ""
echo "⚠️  需要在 Cloudflare 添加 DNS A 记录："
echo "  A  astra   → 42.194.158.77  (Proxied)"
echo "  A  neon    → 42.194.158.77  (Proxied)"
echo "  A  biolum  → 42.194.158.77  (Proxied)"
