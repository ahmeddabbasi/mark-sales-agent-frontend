#!/bin/bash

# Backend startup script
echo "Starting MARK Sales Agent Backend..."

# Activate virtual environment
source ../venv/bin/activate

# Start the FastAPI server
python main.py
