# Sales Agent Web Application

A full-stack web application that provides an AI-powered sales agent interface with live speech-to-text and text-to-speech capabilities.

## Project Structure

```
sales-agent/
├── backend/                 # FastAPI backend
│   ├── main.py             # Main application file
│   └── requirements.txt    # Python dependencies
├── frontend/               # JavaScript frontend
│   ├── index.html         # Main HTML file
│   └── app.js            # JavaScript application logic
├── lisa_vit.py           # Original standalone agent
├── .env                  # Environment variables
└── vosk-model-small-en-us-0.15/  # Speech recognition model
```

## Features

### Backend (FastAPI)
- **Authentication**: JWT-based user authentication
- **WebSocket Support**: Real-time communication for audio streaming
- **Speech Recognition**: Live STT using Vosk
- **Text-to-Speech**: AI voice generation using TTS
- **OpenAI Integration**: GPT-4 powered conversations
- **Google Sheets**: Customer data management
- **Session Management**: Multi-user support with isolated sessions

### Frontend (JavaScript)
- **Modern UI**: Glass-morphism design with Tailwind CSS
- **Real-time Audio**: Live microphone input and audio playback
- **Authentication**: Login/logout functionality
- **Live Conversation**: Real-time chat interface
- **Call Management**: Start, end, and manage sales calls
- **Status Monitoring**: Connection status, call duration, lead information

## Setup Instructions

### Backend Setup

1. Navigate to the backend directory:
   ```bash
   cd backend
   ```

2. Install Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Copy your environment variables from the parent directory or create new ones:
   ```bash
   cp ../.env .
   ```

4. Start the FastAPI server:
   ```bash
   python main.py
   ```
   
   Or using uvicorn:
   ```bash
   uvicorn main:app --host 0.0.0.0 --port 8000 --reload
   ```

### Frontend Setup

1. Navigate to the frontend directory:
   ```bash
   cd frontend
   ```

2. Serve the files using a local server (Python example):
   ```bash
   python -m http.server 3000
   ```
   
   Or using Node.js:
   ```bash
   npx serve -s . -l 3000
   ```

3. Open your browser and navigate to:
   ```
   http://localhost:3000
   ```

## Usage

### Login Credentials
- **Username**: admin
- **Password**: password123

or

- **Username**: user1  
- **Password**: mypassword

### Starting a Sales Call

1. Log in with valid credentials
2. Click the microphone button to start recording
3. Speak into your microphone
4. Lisa will respond with AI-generated speech
5. The conversation continues until you end the call

### Ending a Call

1. Click the "End Call" button
2. Provide feedback about the call
3. The audio will be saved locally
4. Google Sheets will be updated (if configured)

## Configuration

### Environment Variables

Make sure your `.env` file contains:

```env
OPENAI_API_KEY=your_openai_api_key
GOOGLE_CRED_JSON=Google_Credentials.json
SHEET_NAME=customers
CONVERSATION_SCRIPT_PATH=conversation_script.txt
SECRET_KEY=your_secret_key_for_jwt
```

### Audio Configuration

- **Sample Rate**: 16kHz for speech recognition  
- **Audio Format**: PCM16 for live streaming, Base64 for transmission
- **TTS Sample Rate**: 22.05kHz for high-quality output

## API Endpoints

### Authentication
- `POST /login` - User authentication
- `POST /logout` - User logout

### WebSocket
- `WS /ws/{session_id}` - Real-time communication

### Health Check
- `GET /health` - Server health status

## WebSocket Message Types

### Client to Server
```json
{
  "type": "audio",
  "data": "base64_encoded_audio"
}
```

```json
{
  "type": "end_call",
  "feedback": "Call feedback text"
}
```

### Server to Client
```json
{
  "type": "transcription",
  "text": "Recognized speech text"
}
```

```json
{
  "type": "ai_response",
  "text": "AI response text",
  "audio": "base64_encoded_audio",
  "sample_rate": 22050
}
```

## Development

### Adding New Features

1. **Backend**: Add new endpoints in `main.py`
2. **Frontend**: Extend functionality in `app.js`
3. **Styling**: Modify CSS classes in `index.html`

### Customizing the AI Agent

1. Modify the conversation script file
2. Adjust TTS speaker IDs for different voices
3. Update the system prompt for different behavior

## Deployment

### Docker Deployment (Recommended)

Create Dockerfile for backend:
```dockerfile
FROM python:3.10
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["python", "main.py"]
```

### Production Considerations

1. Use a reverse proxy (nginx) for the frontend
2. Set up SSL/TLS certificates
3. Use a production WSGI server (gunicorn)
4. Implement proper logging and monitoring
5. Use a real database for user management
6. Set up CI/CD pipelines

## Troubleshooting

### Common Issues

1. **Microphone not working**: Check browser permissions
2. **WebSocket connection failed**: Verify backend is running
3. **Audio playback issues**: Check browser audio support
4. **Authentication errors**: Verify JWT secret key

### Browser Compatibility

- Chrome 80+ (recommended)
- Firefox 75+
- Safari 13+
- Edge 80+

## License

This project is for demonstration purposes. Please ensure you have proper licenses for all dependencies and models used.
