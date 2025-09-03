#!/bin/bash
# VPS Setup Script for Lisa Sales Agent Backend

# Update system
apt update && apt upgrade -y

# Install Python 3.10 and pip
apt install -y python3.10 python3.10-venv python3-pip

# Install Nginx
apt install -y nginx

# Install system dependencies for audio processing
apt install -y build-essential libasound2-dev portaudio19-dev libportaudio2 libportaudiocpp0

# Install Git
apt install -y git

# Install certbot for SSL (Let's Encrypt)
apt install -y certbot python3-certbot-nginx

# Install supervisor for process management
apt install -y supervisor

# Create application user
useradd -m -s /bin/bash lisaagent
usermod -aG sudo lisaagent

echo "Base system setup complete!"
echo "Next: Clone your repository and set up the application"
