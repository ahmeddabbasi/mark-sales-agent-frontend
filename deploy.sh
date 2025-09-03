#!/bin/bash
# Deployment script for Lisa Sales Agent on VPS
# Run this script on your VPS as root user

set -e

# Configuration
APP_USER="lisaagent"
APP_DIR="/home/$APP_USER/lisa-sales-agent"
DOMAIN="your-domain.com"  # Replace with your actual domain

echo "🚀 Starting deployment of Lisa Sales Agent..."

# Create application directory
sudo -u $APP_USER mkdir -p $APP_DIR
cd $APP_DIR

# Clone repository (you'll need to create a GitHub repo for backend)
echo "📥 Cloning repository..."
sudo -u $APP_USER git clone https://github.com/yourusername/lisa-sales-agent-backend.git .

# Create virtual environment
echo "🐍 Setting up Python virtual environment..."
sudo -u $APP_USER python3.10 -m venv venv
sudo -u $APP_USER ./venv/bin/pip install --upgrade pip

# Install Python dependencies
echo "📦 Installing Python packages..."
sudo -u $APP_USER ./venv/bin/pip install -r requirements.txt

# Download Vosk model
echo "🎤 Downloading Vosk model..."
cd /tmp
wget https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip
unzip vosk-model-small-en-us-0.15.zip
sudo -u $APP_USER mv vosk-model-small-en-us-0.15 $APP_DIR/
cd $APP_DIR

# Set up environment variables (you'll need to edit this)
echo "⚙️ Setting up environment variables..."
sudo -u $APP_USER cat > .env << EOF
OPENAI_API_KEY=your_openai_api_key_here
SECRET_KEY=your_super_secret_jwt_key
GOOGLE_CRED_JSON=$APP_DIR/Google_Credentials.json
SHEET_NAME=Your Google Sheet Name
ENVIRONMENT=production
CONVERSATION_SCRIPT_PATH=$APP_DIR/conversation_script.txt
VOSK_MODEL_PATH=$APP_DIR/vosk-model-small-en-us-0.15
EOF

echo "📄 Don't forget to:"
echo "1. Upload your Google_Credentials.json to $APP_DIR/"
echo "2. Edit .env file with your actual API keys"
echo "3. Update DOMAIN in nginx config"

# Set up Nginx
echo "🌐 Configuring Nginx..."
cp nginx-config.conf /etc/nginx/sites-available/lisa-sales-agent
sed -i "s/your-domain.com/$DOMAIN/g" /etc/nginx/sites-available/lisa-sales-agent
ln -sf /etc/nginx/sites-available/lisa-sales-agent /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# Set up Supervisor
echo "👥 Configuring Supervisor..."
cp supervisor-config.conf /etc/supervisor/conf.d/lisa-sales-agent.conf
supervisorctl reread
supervisorctl update
supervisorctl start lisa-sales-agent

# Set up SSL with Let's Encrypt
echo "🔒 Setting up SSL certificate..."
certbot --nginx -d $DOMAIN -d www.$DOMAIN --non-interactive --agree-tos --email admin@$DOMAIN

# Set up firewall
echo "🔥 Configuring firewall..."
ufw allow 22    # SSH
ufw allow 80    # HTTP
ufw allow 443   # HTTPS
ufw --force enable

echo "✅ Deployment complete!"
echo "🌐 Your backend should be available at: https://$DOMAIN"
echo "📊 Check status with: supervisorctl status lisa-sales-agent"
echo "📋 View logs with: tail -f /var/log/lisa-sales-agent.log"
