#!/bin/bash

# Automated deployment script for Lisa Sales Agent Backend
# This script handles the complete deployment process

set -e  # Exit on any error

echo "🚀 Starting Lisa Sales Agent Backend Deployment..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
PROJECT_DIR="/var/www/lisa-sales-agent"
SERVICE_NAME="lisa-sales-agent"
BACKUP_DIR="/var/backups/lisa-sales-agent"

# Create backup directory if it doesn't exist
sudo mkdir -p $BACKUP_DIR

echo -e "${YELLOW}📦 Creating backup...${NC}"
sudo cp -r $PROJECT_DIR $BACKUP_DIR/backup-$(date +%Y%m%d-%H%M%S)

echo -e "${YELLOW}📥 Pulling latest changes...${NC}"
cd $PROJECT_DIR
git pull origin main

echo -e "${YELLOW}🔧 Installing/updating dependencies...${NC}"
source venv/bin/activate
pip install -r requirements.txt --upgrade

echo -e "${YELLOW}🔄 Restarting services...${NC}"
sudo supervisorctl restart $SERVICE_NAME

echo -e "${YELLOW}⏳ Waiting for service to start...${NC}"
sleep 10

echo -e "${YELLOW}🔍 Checking service status...${NC}"
if sudo supervisorctl status $SERVICE_NAME | grep -q "RUNNING"; then
    echo -e "${GREEN}✅ Service is running successfully!${NC}"
else
    echo -e "${RED}❌ Service failed to start!${NC}"
    sudo supervisorctl tail $SERVICE_NAME stderr
    exit 1
fi

echo -e "${YELLOW}🏥 Health check...${NC}"
if curl -f -s http://localhost/health > /dev/null; then
    echo -e "${GREEN}✅ Backend health check passed!${NC}"
else
    echo -e "${RED}❌ Backend health check failed!${NC}"
    exit 1
fi

# Check ngrok status
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | python3 -c "import sys, json; tunnels = json.load(sys.stdin)['tunnels']; print(tunnels[0]['public_url'] if tunnels else '')" 2>/dev/null || echo "")

if [ -n "$NGROK_URL" ]; then
    echo -e "${GREEN}✅ Ngrok tunnel active: $NGROK_URL${NC}"
else
    echo -e "${YELLOW}⚠️  Ngrok tunnel not active. You may need to restart it.${NC}"
fi

echo -e "${GREEN}🎉 Deployment completed successfully!${NC}"
echo -e "${GREEN}📱 Frontend: https://lisa-sales-agent-frontend-8v3m.vercel.app/${NC}"
if [ -n "$NGROK_URL" ]; then
    echo -e "${GREEN}🔗 Backend: $NGROK_URL${NC}"
fi
