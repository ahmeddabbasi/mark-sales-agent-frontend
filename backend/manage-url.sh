#!/bin/bash

# Backend URL Management Script
# Use this script to update the ngrok URL in your backend

BACKEND_HOST="localhost:8000"

echo "🔧 MARK Sales Agent - Backend URL Manager"
echo "========================================"

# Function to get current ngrok URL
get_current_url() {
    echo "📡 Current backend configuration:"
    curl -s "http://$BACKEND_HOST/config" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(f'  Backend URL: {data[\"backend_url\"]}')
    print(f'  WebSocket URL: {data[\"websocket_url\"]}')
    print(f'  Status: {data[\"status\"]}')
except:
    print('  ❌ Failed to get current configuration')
" 2>/dev/null || echo "  ❌ Backend not responding"
}

# Function to update ngrok URL
update_url() {
    local new_url="$1"
    echo "🔄 Updating backend URL to: $new_url"
    
    response=$(curl -s -X POST "http://$BACKEND_HOST/config/ngrok" \
        -H "Content-Type: application/json" \
        -d "{\"url\": \"$new_url\"}")
    
    echo "$response" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if data.get('status') == 'success':
        print(f'✅ Successfully updated to: {data[\"new_url\"]}')
    else:
        print(f'❌ Error: {data.get(\"message\", \"Unknown error\")}')
except:
    print('❌ Failed to update URL')
" 2>/dev/null || echo "❌ Failed to communicate with backend"
}

# Function to auto-detect ngrok URL
auto_detect_ngrok() {
    echo "🔍 Auto-detecting ngrok URL..."
    ngrok_url=$(curl -s http://localhost:4040/api/tunnels | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for tunnel in data['tunnels']:
        if tunnel['proto'] == 'https':
            print(tunnel['public_url'])
            break
except:
    pass
" 2>/dev/null)
    
    if [ -n "$ngrok_url" ]; then
        echo "✅ Found ngrok URL: $ngrok_url"
        update_url "$ngrok_url"
    else
        echo "❌ Could not auto-detect ngrok URL. Make sure ngrok is running."
    fi
}

# Main menu
case "$1" in
    "status"|"")
        get_current_url
        ;;
    "auto")
        auto_detect_ngrok
        ;;
    "update")
        if [ -z "$2" ]; then
            echo "Usage: $0 update <new_url>"
            echo "Example: $0 update https://abc123.ngrok-free.app"
            exit 1
        fi
        update_url "$2"
        ;;
    "help")
        echo "Usage: $0 [command] [options]"
        echo ""
        echo "Commands:"
        echo "  status     Show current backend configuration (default)"
        echo "  auto       Auto-detect and update ngrok URL"
        echo "  update <url>  Manually set backend URL"
        echo "  help       Show this help message"
        echo ""
        echo "Examples:"
        echo "  $0                                          # Show current status"
        echo "  $0 auto                                     # Auto-detect ngrok URL"
        echo "  $0 update https://abc123.ngrok-free.app     # Set specific URL"
        ;;
    *)
        echo "Unknown command: $1"
        echo "Use '$0 help' for usage information"
        exit 1
        ;;
esac
