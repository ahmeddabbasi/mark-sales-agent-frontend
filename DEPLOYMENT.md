# Lisa AI Sales Agent - Deployment Guide

## Frontend Deployment (Vercel)

### Step 1: Prepare Frontend
The frontend is already configured for Vercel deployment with:
- ✅ `vercel.json` - Vercel configuration
- ✅ `package.json` - Project metadata  
- ✅ Environment-aware API URLs
- ✅ Static file optimization

### Step 2: Deploy to Vercel
1. Push the `frontend` folder to GitHub
2. Connect repository to Vercel
3. Deploy automatically
4. Your frontend will be available at: `https://your-app.vercel.app`

## Backend Deployment Options

### Option 1: Heroku
1. Install Heroku CLI
2. Create new Heroku app:
   ```bash
   cd backend
   heroku create your-app-name
   ```
3. Set environment variables:
   ```bash
   heroku config:set OPENAI_API_KEY=your_key
   heroku config:set SECRET_KEY=your_secret
   heroku config:set ENVIRONMENT=production
   ```
4. Deploy:
   ```bash
   git add .
   git commit -m "Deploy backend"
   git push heroku main
   ```

### Option 2: Railway
1. Connect GitHub repository to Railway
2. Set environment variables in Railway dashboard
3. Deploy automatically

### Option 3: DigitalOcean App Platform
1. Connect GitHub repository
2. Configure environment variables
3. Deploy

## Environment Variables Required

### Backend (.env or hosting platform):
```
OPENAI_API_KEY=your_openai_api_key
SECRET_KEY=your_jwt_secret_key
GOOGLE_CRED_JSON=google_credentials.json
SHEET_NAME=your_sheet_name
ENVIRONMENT=production
```

## Final Setup

### 1. Update Frontend URLs
In `frontend/app.js`, replace placeholder URLs:
```javascript
apiUrl: 'https://your-backend-domain.herokuapp.com'
wsUrl: 'wss://your-backend-domain.herokuapp.com'
```

### 2. Test Deployment
1. Frontend: Access your Vercel URL
2. Backend: Test API endpoints
3. Integration: Test login and WebSocket connection

## Architecture
```
Frontend (Vercel) → Backend (Heroku/Railway) → AI Services
     ↓                    ↓
Static Files         FastAPI + WebSocket
Environment          OpenAI + Vosk + TTS
Detection            Google Sheets
```

## Support
- Frontend: Vercel automatic scaling
- Backend: Choose based on needs (Heroku free tier, Railway, etc.)
- WebSocket: Supported on all platforms
- File Upload: Configured for production
