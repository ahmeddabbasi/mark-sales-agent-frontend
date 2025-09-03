# MARK Sales Agent - Frontend

AI-Powered Sales Agent Frontend built with Vanilla JavaScript and deployed on Vercel.

## 🚀 Features

- Real-time voice conversation with AI sales agent
- Voice Activity Detection (VAD)
- WebSocket-based real-time communication
- Modern responsive UI with Tailwind CSS
- Easy backend URL configuration
- Production-ready deployment

## 🛠 Tech Stack

- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Styling**: Tailwind CSS
- **Audio**: Web Audio API, WebRTC VAD
- **Real-time**: WebSocket
- **Deployment**: Vercel

## 🔧 Configuration

The app automatically detects if you're running locally or in production:

- **Local Development**: Uses `http://localhost:8000`
- **Production**: Prompts for ngrok URL or uses settings panel

## 🎯 Usage

1. Visit the deployed application
2. Enter your ngrok backend URL when prompted
3. Login with demo credentials: `ahmed / Ra12613a`
4. Start talking to the AI sales agent!

## Deployment on Vercel

This frontend is configured for deployment on Vercel with automatic environment detection.

### Quick Deploy

1. Push this frontend folder to a GitHub repository
2. Connect your GitHub repo to Vercel
3. Deploy automatically

### Environment Configuration

The app automatically detects the environment:
- **Development**: Uses `localhost:8000` for backend
- **Production**: Uses your production backend URL

### Before Deploying

1. Update the backend URLs in `app.js`:
   ```javascript
   // Replace 'your-backend-domain.herokuapp.com' with your actual backend URL
   apiUrl: 'https://your-actual-backend-domain.com'
   wsUrl: 'wss://your-actual-backend-domain.com'
   ```

2. Make sure your backend is deployed and supports CORS for your Vercel domain

### Files Structure

- `index.html` - Main HTML file
- `app.js` - Main JavaScript application
- `vercel.json` - Vercel configuration
- `package.json` - Project metadata
- `.gitignore` - Git ignore rules

### Features

- Automatic environment detection
- No-cache headers for JavaScript files
- Static file serving optimized for Vercel
- WebSocket support for real-time communication

### Local Development

Run locally:
```bash
python3 server.py
```

Access at: http://localhost:3002
