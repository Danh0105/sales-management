#!/bin/bash
set -e

APP_NAME="sales-management"
PORT="3010"
export PORT
export NODE_ENV=production

echo "🚀 Bắt đầu deploy $APP_NAME (port $PORT)..."

# Build
echo "📦 Building..."
npm run build

# Restart / start PM2 với PORT rõ ràng
echo "♻️  (Re)starting PM2 trên port $PORT..."
if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
  PORT="$PORT" NODE_ENV=production pm2 restart "$APP_NAME" --update-env
else
  PORT="$PORT" NODE_ENV=production pm2 start dist/main.js --name "$APP_NAME" --update-env
fi

# Lưu trạng thái PM2
pm2 save --force

# Chờ process ổn định
sleep 3

# Kiểm tra status
STATUS=$(pm2 jlist | node -e "
  const list = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const app = list.find(p => p.name === '$APP_NAME');
  console.log(app ? app.pm2_env.status : 'not_found');
")

if [ "$STATUS" = "online" ]; then
  echo "✅ Deploy thành công — $APP_NAME đang chạy trên port $PORT"
else
  echo "❌ Deploy thất bại — status: $STATUS"
  pm2 logs $APP_NAME --lines 30 --nostream
  exit 1
fi

# Xác nhận cổng đang lắng nghe
echo ""
echo "🔎 Kiểm tra cổng $PORT:"
if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
  echo "✅ Cổng $PORT đang lắng nghe"
else
  echo "⚠️  Chưa thấy cổng $PORT lắng nghe — kiểm tra logs bên dưới"
fi

# Hiện logs gần nhất
echo ""
echo "📄 Logs gần nhất:"
pm2 logs $APP_NAME --lines 20 --nostream
