# Lisa AI Sales Agent Frontend

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
