#!/bin/bash

# Sales Agent Deployment Script
# This script deploys the backend locally with ngrok and frontend to Vercel

set -e

echo "🚀 Starting Sales Agent Deployment..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if required tools are installed
check_dependencies() {
    echo -e "${BLUE}Checking dependencies...${NC}"
    
    if ! command -v ngrok &> /dev/null; then
        echo -e "${RED}❌ ngrok is not installed. Please install ngrok first.${NC}"
        exit 1
    fi
    
    if ! command -v vercel &> /dev/null; then
        echo -e "${YELLOW}⚠️  Vercel CLI not found. Installing...${NC}"
        npm i -g vercel
    fi
    
    echo -e "${GREEN}✅ Dependencies checked${NC}"
}

# Start backend server
start_backend() {
    echo -e "${BLUE}Starting backend server...${NC}"
    
    cd backend
    
    # Activate virtual environment and start server in background
    source ../venv/bin/activate
    nohup python main.py > ../backend.log 2>&1 &
    BACKEND_PID=$!
    echo $BACKEND_PID > ../backend.pid
    
    cd ..
    
    # Wait for backend to start
    sleep 5
    
    if ps -p $BACKEND_PID > /dev/null; then
        echo -e "${GREEN}✅ Backend started successfully (PID: $BACKEND_PID)${NC}"
    else
        echo -e "${RED}❌ Failed to start backend server${NC}"
        exit 1
    fi
}

# Start ngrok tunnel
start_ngrok() {
    echo -e "${BLUE}Starting ngrok tunnel...${NC}"
    
    # Kill any existing ngrok process
    pkill -f ngrok || true
    
    # Start ngrok in background
    nohup ngrok http 8000 --log=stdout > ngrok.log 2>&1 &
    NGROK_PID=$!
    echo $NGROK_PID > ngrok.pid
    
    # Wait for ngrok to start and get the URL
    sleep 5
    
    # Extract ngrok URL
    NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for tunnel in data['tunnels']:
        if tunnel['proto'] == 'https':
            print(tunnel['public_url'])
            break
except:
    pass
")
    
    if [ -z "$NGROK_URL" ]; then
        echo -e "${RED}❌ Failed to get ngrok URL${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}✅ Ngrok tunnel started: $NGROK_URL${NC}"
    echo $NGROK_URL > ngrok_url.txt
}

# Update frontend config
update_frontend_config() {
    echo -e "${BLUE}Updating frontend configuration...${NC}"
    
    # Update the config.js file with the actual ngrok URL
    sed -i "s|YOUR_NGROK_URL|${NGROK_URL#https://}|g" frontend/config.js
    
    echo -e "${GREEN}✅ Frontend config updated with ngrok URL${NC}"
}

# Deploy to Vercel
deploy_vercel() {
    echo -e "${BLUE}Deploying frontend to Vercel...${NC}"
    
    cd frontend
    
    # Login to Vercel (will prompt if not logged in)
    vercel whoami || vercel login
    
    # Deploy to Vercel
    vercel --prod
    
    cd ..
    
    echo -e "${GREEN}✅ Frontend deployed to Vercel${NC}"
}

# Cleanup function
cleanup() {
    echo -e "${YELLOW}Cleaning up...${NC}"
    
    if [ -f backend.pid ]; then
        BACKEND_PID=$(cat backend.pid)
        kill $BACKEND_PID 2>/dev/null || true
        rm backend.pid
    fi
    
    if [ -f ngrok.pid ]; then
        NGROK_PID=$(cat ngrok.pid)
        kill $NGROK_PID 2>/dev/null || true
        rm ngrok.pid
    fi
}

# Set up trap for cleanup on script exit
trap cleanup EXIT

# Main deployment flow
main() {
    check_dependencies
    start_backend
    start_ngrok
    update_frontend_config
    deploy_vercel
    
    echo -e "${GREEN}🎉 Deployment completed successfully!${NC}"
    echo -e "${BLUE}Backend URL: $NGROK_URL${NC}"
    echo -e "${BLUE}Frontend will be deployed to Vercel${NC}"
    echo -e "${YELLOW}Note: Keep this terminal open to maintain the ngrok tunnel${NC}"
    
    # Keep script running to maintain tunnel
    echo -e "${BLUE}Press Ctrl+C to stop the deployment${NC}"
    wait
}

# Run main function
main
