from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import json
import hashlib
import os
import jwt

# Import optimized JSON for real-time performance (silent loading)
try:
    import orjson
    JSON_DUMPS = lambda x: orjson.dumps(x).decode('utf-8')
    JSON_LOADS = orjson.loads
except ImportError:
    JSON_DUMPS = json.dumps
    JSON_LOADS = json.loads
from datetime import datetime, timedelta
from typing import Dict, List
import numpy as np
import io
import base64
import torch
import gspread
from oauth2client.service_account import ServiceAccountCredentials
from dotenv import load_dotenv
import uuid
import time
import wave
from openai import OpenAI
import scipy.signal

# Import AssemblyAI integration
from assemblyai_live_stt import AssemblyAILiveSTT

# ----------------- Configuration & Initialization -----------------
load_dotenv()

app = FastAPI(title="MARK Sales Agent API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
ASSEMBLYAI_API_KEY = os.getenv("ASSEMBLYAI_API_KEY")  # Add AssemblyAI API key
GOOGLE_CRED_JSON = os.getenv("GOOGLE_CRED_JSON", os.path.join(os.path.dirname(__file__), "Google_Credentials.json"))
CONVERSATION_SCRIPT_PATH = os.getenv("CONVERSATION_SCRIPT_PATH", os.path.join(os.path.dirname(__file__), "conversation_script.txt"))
SECRET_KEY = os.getenv("SECRET_KEY", "your-secret-key-here")
RECORDINGS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "recordings")

# Create recordings directory if it doesn't exist
os.makedirs(RECORDINGS_DIR, exist_ok=True)
SAMPLERATE = 16000

# ----------------- AssemblyAI STT Configuration -----------------
STT_CONFIG = {
    # AssemblyAI Live Streaming Parameters - Optimized for Real-Time
    "sample_rate": 16000,               # Required for AssemblyAI
    "confidence_threshold": 0.5,        # Lowered for faster responses (was 0.7)
    "partial_confidence_threshold": 0.2, # Ultra-low for immediate partial transcripts (was 0.3)
    "word_boost": ["truck", "dispatch", "load", "freight", "delivery", "shipping", "route", "driver"],
    "boost_param": "default",           # Changed to default for faster processing (was "high")
    
    # Audio Processing - Real-Time Optimized
    "min_audio_length_ms": 80,          # Ultra-low minimum (was 300ms) for immediate processing
    "chunk_duration_ms": 80,            # Match frontend chunk size (was 100ms)
    "silence_timeout_ms": 850,          # Reduced for faster speech end detection (was 1500ms)
}

# Try to import necessary libraries and handle dependencies
try:
    from TTS.api import TTS
    import torch
    import torchaudio
    from assemblyai_live_stt import AssemblyAILiveSTT  # Import our custom AssemblyAI module
except ImportError as e:
    raise RuntimeError(f"Required libraries not found. Please install them. Error: {e}")

# Remove old STT model loading - we'll use AssemblyAI instead
try:
    # Silent AssemblyAI setup
    if not ASSEMBLYAI_API_KEY:
        raise RuntimeError("ASSEMBLYAI_API_KEY environment variable not set")
except Exception as e:
    raise RuntimeError(f"Failed to initialize AssemblyAI. Please check your API key. Error: {e}")

try:
    print("🤖 Initializing MARK...")
    openai_client = OpenAI(api_key=OPENAI_API_KEY)
except Exception as e:
    raise RuntimeError(f"Failed to initialize OpenAI client. Please check your API key. Error: {e}")

try:
    # Load TTS silently (suppress all TTS verbose output)
    import os
    import sys
    from contextlib import redirect_stdout, redirect_stderr
    import io
    
    os.environ['TTS_CACHE_ENABLED'] = '1'  # Cache models
    os.environ['TTS_PROGRESS_BAR'] = '0'   # Disable progress bar
    
    # Suppress TTS initialization output completely
    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
        tts = TTS(model_name="tts_models/en/vctk/vits", progress_bar=False, gpu=False)
        
except Exception as e:
    raise RuntimeError(f"Failed to load TTS model. Please check the path and dependencies. Error: {e}")

try:
    # Google Sheets setup
    scope = ["https://spreadsheets.google.com/feeds", "https://www.googleapis.com/auth/drive"]
    creds = ServiceAccountCredentials.from_json_keyfile_name(GOOGLE_CRED_JSON, scope)
    client_sheet = gspread.authorize(creds)
except Exception as e:
    raise RuntimeError(f"Failed to load Google Sheets credentials. Please check the JSON file. Error: {e}")

# Remove Silero VAD loading since we'll use AssemblyAI's built-in VAD

try:
    with open(CONVERSATION_SCRIPT_PATH, "r", encoding="utf-8") as f:
        sales_script_text = f.read()
    print("✅ MARK ready to take calls!")
except FileNotFoundError:
    raise RuntimeError(f"Conversation script file not found at {CONVERSATION_SCRIPT_PATH}")

# ----------------- Authentication & Session Management -----------------
security = HTTPBearer()

# ----------------- AssemblyAI Integration Functions -----------------
async def setup_assemblyai_for_session(session: dict, websocket: WebSocket):
    """Set up AssemblyAI STT for a session with callbacks and real-time configuration"""
    assemblyai_stt = session["assemblyai_stt"]
    
    # Set up callbacks for ultra-responsive real-time feedback
    async def on_partial_transcript(text: str, confidence: float, data: dict):
        """Handle partial transcripts from AssemblyAI - Ultra-responsive"""
        if confidence >= STT_CONFIG["partial_confidence_threshold"]:
            session["current_partial_text"] = text
            session["speech_active"] = True
            session["silence_start_time"] = None
            
            # Send partial transcript immediately to frontend
            await websocket.send_text(JSON_DUMPS({
                "type": "partial_transcription", 
                "text": text,
                "confidence": confidence,
                "source": "assemblyai",
                "real_time": True  # Flag for real-time processing
            }))
            
            session["last_transcript_time"] = datetime.now()
    
    async def on_final_transcript(text: str, confidence: float, data: dict):
        """Handle final transcripts from AssemblyAI - Time-based duplicate prevention"""
        if confidence >= STT_CONFIG["confidence_threshold"]:
            # TIME-BASED DUPLICATE PREVENTION (much less aggressive)
            def ultra_normalize(text):
                import re
                # Convert to lowercase and strip
                normalized = text.lower().strip()
                # Remove ALL punctuation and special characters
                normalized = re.sub(r'[^\w\s]', '', normalized)
                # Normalize contractions
                normalized = normalized.replace("i'm", "i am").replace("you're", "you are")
                normalized = normalized.replace("it's", "it is").replace("that's", "that is")
                normalized = normalized.replace("won't", "will not").replace("can't", "cannot")
                # Replace multiple spaces with single space
                normalized = re.sub(r'\s+', ' ', normalized)
                return normalized.strip()
            
            # Time-based duplicate prevention
            current_time = datetime.now()
            normalized_current = ultra_normalize(text)

            # Retrieve the last processed transcript from the session
            last_processed = session.get("last_processed_transcript")
            
            # Check if the current transcript is very similar to the last one and occurred within 3 seconds
            if (last_processed and
                (current_time - last_processed["time"]).total_seconds() < 3):
                
                normalized_last = last_processed["normalized"]

                # Use word-based similarity to be robust against slight variations
                current_words = set(normalized_current.split())
                last_words = set(normalized_last.split())
                
                if current_words and last_words:
                    intersection = len(current_words.intersection(last_words))
                    union = len(current_words.union(last_words))
                    similarity = intersection / union if union > 0 else 0
                    
                    # If they are very similar (e.g., > 95%), treat as a duplicate
                    if similarity > 0.95:
                        print("⚠️ Duplicate transcription detected and ignored within 3-second window.")
                        return

            # If it's not a duplicate, store it for future comparison
            session["last_processed_transcript"] = {
                "text": text,
                "normalized": normalized_current,
                "time": current_time
            }
            
            print(f"👤 USER: '{text}' (confidence: {confidence:.2f})")
            
            # PROCESSING PREVENTION: Don't process if AI is currently responding
            if session.get("ai_is_responding", False):
                session["queued_transcript"] = text
                return
            
            # Send final transcription immediately to frontend
            await websocket.send_text(JSON_DUMPS({
                "type": "transcription", 
                "text": text,
                "confidence": confidence,
                "source": "assemblyai",
                "real_time": True  # Flag for real-time processing
            }))
            
            # Process conversation immediately without delay
            await process_conversation_turn(websocket, text, session)
            
            # Clear partial text and reset state quickly
            session["current_partial_text"] = ""
            session["speech_active"] = False
            session["silence_start_time"] = datetime.now()
            
        session["last_transcript_time"] = datetime.now()
    
    async def on_error(error_msg: str):
        """Handle AssemblyAI errors"""
        print(f"❌ AssemblyAI Error: {error_msg}")
        await websocket.send_text(JSON_DUMPS({
            "type": "error", 
            "message": f"STT Error: {error_msg}"
        }))
    
    async def on_session_begins(data: dict):
        """Handle session start"""
        print(f"✅ AssemblyAI session started: {data.get('session_id')}")
        await websocket.send_text(JSON_DUMPS({
            "type": "stt_status", 
            "status": "connected",
            "session_id": data.get('session_id')
        }))
    
    async def on_session_terminated(data: dict):
        """Handle session termination"""
        print("🔚 AssemblyAI session terminated")
        await websocket.send_text(JSON_DUMPS({
            "type": "stt_status", 
            "status": "disconnected"
        }))
    
    # Set callbacks
    assemblyai_stt.set_callbacks(
        on_partial_transcript=on_partial_transcript,
        on_final_transcript=on_final_transcript,
        on_error=on_error,
        on_session_begins=on_session_begins,
        on_session_terminated=on_session_terminated
    )
    
    # Connect to AssemblyAI
    await assemblyai_stt.connect()

def detect_speech_activity(audio_bytes: bytes, threshold: float = 800.0) -> bool:
    """
    Simple Voice Activity Detection based on audio energy
    Returns True if speech is detected, False for silence
    """
    try:
        # Convert bytes to numpy array (16-bit PCM)
        audio_array = np.frombuffer(audio_bytes, dtype=np.int16)
        
        # Calculate RMS energy
        rms_energy = np.sqrt(np.mean(audio_array.astype(np.float32) ** 2))
        
        # Return True if energy is above threshold (speech detected)
        # Convert numpy boolean to Python boolean for JSON serialization
        return bool(rms_energy > threshold)
        
    except Exception as e:
        # If there's any error, assume no speech
        return False

async def process_live_audio_stream_assemblyai(websocket: WebSocket, audio_data: str, session: dict):
    """Process live audio stream using AssemblyAI with real-time optimizations"""
    try:
        # Decode audio data
        audio_bytes = base64.b64decode(audio_data)
        
        # SIMPLE VAD DETECTION FOR BARGE-IN
        speech_detected = detect_speech_activity(audio_bytes)
        
        # Send VAD status to frontend for barge-in detection
        await websocket.send_text(JSON_DUMPS({
            "type": "vad_status",
            "speech_detected": speech_detected,
            "timestamp": time.time()
        }))
        
        # Store user audio for call recording
        session["conversation_segments"].append(("user", audio_bytes))
        
        # Send audio to AssemblyAI for real-time transcription
        assemblyai_stt = session["assemblyai_stt"]
        if assemblyai_stt.is_connected:
            await assemblyai_stt.send_audio(audio_bytes)
        else:
            print("⚠️ STT connection lost, reconnecting...")
            try:
                await assemblyai_stt.connect()
                await assemblyai_stt.send_audio(audio_bytes)
                print("🔄 STT reconnected")
            except Exception as e:
                print(f"❌ STT reconnection failed: {e}")
                await websocket.send_text(JSON_DUMPS({
                    "type": "error", 
                    "message": "STT connection lost"
                }))
        
        # Handle silence detection for better conversation flow (optimized)
        await handle_silence_detection(websocket, session)
        
    except Exception as e:
        print(f"❌ Audio Error: {e}")
        # Don't block on errors - continue processing
        await websocket.send_text(JSON_DUMPS({
            "type": "error", 
            "message": f"Audio processing error: {str(e)}"
        }))

async def handle_silence_detection(websocket: WebSocket, session: dict):
    """Handle silence detection and timeout processing - Real-time optimized"""
    current_time = datetime.now()
    
    # If we have a partial transcript and silence has started
    if (session.get("current_partial_text") and 
        session.get("silence_start_time") and
        not session.get("speech_active", False)):
        silence_duration = (current_time - session["silence_start_time"]).total_seconds() * 1000
        
        # If silence exceeds timeout, process partial as final (faster timeout for real-time)
        if silence_duration > STT_CONFIG["silence_timeout_ms"]:
            partial_text = session["current_partial_text"].strip()
            
            # Time-based duplicate prevention for partial text processing
            if (partial_text and len(partial_text) > 3):
                
                normalized_partial = partial_text.lower().strip().replace("'", "'").replace(""", '"').replace(""", '"')
                
                # Check against last processed partial within time window
                last_processed_partial = session.get("last_processed_partial_data")
                should_process = True
                
                if (last_processed_partial and
                    (current_time - last_processed_partial["time"]).total_seconds() < 5):  # 5 second window for partials
                    
                    if normalized_partial == last_processed_partial["normalized"]:
                        should_process = False
                        print("⚠️ Duplicate partial processing prevented within 5-second window.")
                
                if should_process:
                    print(f"👤 USER (timeout): '{partial_text}'")
                    
                    # Store this partial for future comparison
                    session["last_processed_partial_data"] = {
                        "text": partial_text,
                        "normalized": normalized_partial,
                        "time": current_time
                    }
                    
                    # Send as final transcription immediately
                    await websocket.send_text(JSON_DUMPS({
                        "type": "transcription", 
                        "text": partial_text,
                        "confidence": 0.8,  # Slightly lower confidence for timeout
                        "source": "assemblyai_timeout",
                        "real_time": True
                    }))
                    
                    # Process conversation immediately
                    await process_conversation_turn(websocket, partial_text, session)
            
            # Clear partial state quickly
            session["current_partial_text"] = ""
            session["silence_start_time"] = None
            session["speech_active"] = False

async def cleanup_assemblyai_session(session: dict):
    """Clean up AssemblyAI connection when session ends"""
    try:
        assemblyai_stt = session.get("assemblyai_stt")
        if assemblyai_stt:
            await assemblyai_stt.disconnect()
            print("🧹 AssemblyAI session cleaned up")
    except Exception as e:
        print(f"Error cleaning up AssemblyAI session: {e}")

# Remove old VAD functions since AssemblyAI handles this internally

USERS_DB = {
    "ahmed": {"password_hash": hashlib.sha256("Ra12613a".encode()).hexdigest(), "id": 1, "sheet_name": "Ahmed_Sales_Sheet"},
    "sales1": {"password_hash": hashlib.sha256("password1".encode()).hexdigest(), "id": 2, "sheet_name": "Sales1_Sales_Sheet"},
    "sales2": {"password_hash": hashlib.sha256("password12".encode()).hexdigest(), "id": 3, "sheet_name": "Sales2_Sales_Sheet"},
    "sales3": {"password_hash": hashlib.sha256("password123".encode()).hexdigest(), "id": 4, "sheet_name": "Sales3_Sales_Sheet"},
    "hassan": {"password_hash": hashlib.sha256("password1234".encode()).hexdigest(), "id": 5, "sheet_name": "Sales4_Sales_Sheet"},
}

class SessionManager:
    def __init__(self):
        self.sessions: Dict[str, Dict] = {}
        self.client_sheet = client_sheet

    def create_session(self, user_id: str) -> str:
        session_id = str(uuid.uuid4())
        user_sheet_name = USERS_DB[user_id]["sheet_name"]
        
        try:
            user_sheet = self.client_sheet.open(user_sheet_name).sheet1
        except gspread.SpreadsheetNotFound:
            print(f"Error: Google Sheet '{user_sheet_name}' not found for user '{user_id}'.")
            raise HTTPException(status_code=500, detail=f"User's Google Sheet '{user_sheet_name}' not found")

        # Create AssemblyAI instance for this session
        assemblyai_stt = AssemblyAILiveSTT(ASSEMBLYAI_API_KEY, STT_CONFIG["sample_rate"])

        self.sessions[session_id] = {
            "user_id": user_id,
            "conversation_history": [{"role": "system", "content": sales_script_text}],
            "checklist": {"name_collected": False, "email_collected": False},
            "lead_interested": False,
            "conversation_segments": [],
            "assemblyai_stt": assemblyai_stt,  # AssemblyAI instance instead of Vosk recognizer
            "last_speech_time": datetime.now(),
            "websocket": None,
            "user_sheet": user_sheet,
            "stream_buffer": io.BytesIO(),
            "last_processing_time": datetime.now(),
            "speech_active": False,  # Track current speech state
            "last_transcript_time": datetime.now(),  # Track transcription timing
            "current_partial_text": "",  # Store current partial transcript
            "silence_start_time": None,  # Track silence periods
        }
        return session_id

    def get_session(self, session_id: str):
        return self.sessions.get(session_id)

    def remove_session(self, session_id: str):
        if session_id in self.sessions:
            del self.sessions[session_id]

session_manager = SessionManager()

def create_jwt_token(user_id: str) -> str:
    payload = {"user_id": user_id, "exp": datetime.utcnow() + timedelta(hours=24)}
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")

def verify_jwt_token(token: str) -> str:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        return payload["user_id"]
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    token = credentials.credentials
    return verify_jwt_token(token)

@app.post("/login")
async def login(credentials: dict):
    username = credentials.get("username")
    password = credentials.get("password")
    
    user_info = USERS_DB.get(username)
    if not user_info:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    
    hashed_password = hashlib.sha256(password.encode()).hexdigest()
    if user_info["password_hash"] != hashed_password:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    
    token = create_jwt_token(username)
    session_id = session_manager.create_session(username)
    
    return {"access_token": token, "token_type": "bearer", "session_id": session_id}

@app.post("/logout")
async def logout(session_id: str, current_user: str = Depends(get_current_user)):
    session_manager.remove_session(session_id)
    return {"message": "Logged out successfully"}

@app.post("/call-summary")
async def create_call_summary(request: dict, current_user: str = Depends(get_current_user)):
    """Generate call summary and update Google Sheets, then refresh session"""
    print("=== CALL SUMMARY ENDPOINT DEBUG ===")
    print(f"Request received from user: {current_user}")
    print(f"Request data: {request}")
    
    try:
        # Handle both camelCase and snake_case for compatibility
        session_id = request.get("sessionId") or request.get("session_id")
        customer_index_number = request.get("customerIndexNumber") or request.get("customer_index")
        feedback = request.get("feedback") or request.get("agent_feedback", "Call completed")
        
        print(f"Parsed - Session ID: {session_id}, Customer Index Number: {customer_index_number}, Feedback: {feedback}")
        
        if not session_id:
            print("❌ Error: Session ID is missing")
            raise HTTPException(status_code=400, detail="Session ID is required")
        
        # Validate customer index number (frontend now sends 1-based index)
        if customer_index_number is None or customer_index_number < 1:
            print(f"❌ Error: Invalid customer index number: {customer_index_number}")
            raise HTTPException(status_code=400, detail="Customer index number must be a valid number >= 1")
        
        # Get the session data
        session = session_manager.get_session(session_id)
        if not session:
            print(f"❌ Error: Session {session_id} not found")
            raise HTTPException(status_code=404, detail="Session not found")
        
        print(f"✅ Session found for user: {session.get('user_id')}")
        
        # Generate call summary and update Google Sheets
        summary_data = {}
        sheets_updated = False
        
        if session.get("conversation_history") and len(session["conversation_history"]) > 1:
            print(f"📝 Generating summary for conversation with {len(session['conversation_history'])} messages")
            # Generate summary only if there was actual conversation
            summary_data = await generate_call_summary(session["conversation_history"])
            print(f"✅ Generated call summary: {summary_data}")
        else:
            print(f"⚠️ No call summary generated - conversation_history length: {len(session.get('conversation_history', []))}")
            # Create basic summary data for minimal conversations
            summary_data = {
                "call_summary": "Call ended with minimal conversation",
                "lead_interest": "Unknown"
            }
            
        # Debug logging
        print(f"🔍 Customer index number received: {customer_index_number}")
        print(f"🔍 Session has user_sheet: {session.get('user_sheet') is not None}")
        
        # Update Google Sheets if customer_index_number is provided
        if customer_index_number is not None and session.get("user_sheet"):
            print(f"📊 Finding and updating Google Sheets row for customer index number: {customer_index_number}")
            await update_google_sheet_by_index_number(session["user_sheet"], customer_index_number, summary_data, feedback)
            print(f"✅ Google Sheets updated successfully for customer index number: {customer_index_number}")
            sheets_updated = True
            
            # Save call recording before clearing session
            if session.get("conversation_segments"):
                timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
                recording_path = await save_call_recording(
                    session["conversation_segments"], 
                    customer_index_number, 
                    timestamp_str
                )
                if recording_path:
                    print(f"🎵 Call recording saved: {os.path.basename(recording_path)}")
                else:
                    print("⚠️ Failed to save call recording")
            
            # Refresh the session after successful Google Sheets update
            session["conversation_history"] = [{"role": "system", "content": sales_script_text}]
            session["conversation_segments"] = []
            # Reset current customer index to start fresh
            if "current_customer_index" in session:
                del session["current_customer_index"]
            print("🔄 Session refreshed after successful Google Sheets update")
            
            # Notify the frontend via WebSocket if connection exists
            if session.get("websocket"):
                try:
                    await session["websocket"].send_text(JSON_DUMPS({
                        "type": "session_refreshed",
                        "message": "Session refreshed after successful Google Sheets update",
                        "sheets_updated": True
                    }))
                    print("📡 WebSocket notification sent about session refresh")
                except Exception as ws_error:
                    print(f"⚠️ Failed to send WebSocket notification: {ws_error}")
        else:
            print(f"⚠️ Google Sheets NOT updated - customer_index_number: {customer_index_number}, has_user_sheet: {session.get('user_sheet') is not None}")

        result = {
            "message": "Call summary created" + (" and session refreshed" if sheets_updated else "") + (" with recording saved" if sheets_updated else ""),
            "summary": summary_data,
            "sheets_updated": sheets_updated
        }
        
        print(f"📤 Returning result: {result}")
        return result
        
    except Exception as e:
        print(f"❌ Error in call summary endpoint: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to create call summary: {str(e)}")# ----------------- WebSocket Communication -----------------
@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    await websocket.accept()
    session = session_manager.get_session(session_id)
    
    if not session:
        await websocket.close(code=4004, reason="Invalid session")
        return
    
    session["websocket"] = websocket
    
    # Set up AssemblyAI for this session
    try:
        await setup_assemblyai_for_session(session, websocket)
    except Exception as e:
        print(f"Failed to set up AssemblyAI: {e}")
        await websocket.send_text(JSON_DUMPS({
            "type": "error", 
            "message": "Failed to initialize speech recognition"
        }))
        return
    
    # Send initial greeting
    greeting = "Hi, I'm MARK from Pathburn, First AI-powered truck dispatcher. How are you today?"
    await send_ai_response(websocket, greeting, session)
    
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            
            # Only log non-audio messages to reduce noise
            if message.get("type") not in ["audio_stream", "audio_stream_realtime"]:
                print(f"📨 Received WebSocket message: {message.get('type', 'unknown')}")
            
            # NEW LOGIC FOR BARGE-IN/INTERRUPT
            if message.get("type") == "interrupt":
                print("🛑 Received interrupt signal from client - stopping AI response")
                
                # Record the interruption time for natural pause calculation
                session["last_interruption_time"] = datetime.now()
                
                # Immediately stop AI response generation
                session["ai_is_responding"] = False
                
                # Clear TTS generation state to prevent leftover speech
                session["tts_generation_active"] = False
                session["pending_tts_chunks"] = []
                session["current_speech_buffer"] = ""
                
                # Clear any queued transcript to prevent confusion
                if "queued_transcript" in session:
                    del session["queued_transcript"]
                    print("🗑️ Cleared queued transcript due to interrupt")
                
                # Signal client to stop playing any buffered audio immediately
                await websocket.send_text(JSON_DUMPS({"type": "stop_audio"}))
                
                # Send a clear command to ensure all audio is stopped
                await websocket.send_text(JSON_DUMPS({"type": "clear_audio_buffers"}))
                print("📤 Sent stop_audio and clear_audio_buffers signals to client")
                
                # Continue to next iteration to listen for new user query
                continue
            
            elif message.get("type") == "audio_stream" or message.get("type") == "audio_stream_realtime":
                # Process audio silently - no logging for audio chunks
                await process_live_audio_stream_assemblyai(websocket, message["data"], session)
            elif message.get("type") == "end_call":
                customer_index = message.get("customer_index")
                await end_call(websocket, session, message.get("feedback", ""), customer_index)
                break
    except WebSocketDisconnect:
        await cleanup_assemblyai_session(session)
        session_manager.remove_session(session_id)
        print(f"WebSocket {session_id} disconnected")
    except Exception as e:
        print(f"WebSocket error: {e}")
        await cleanup_assemblyai_session(session)
        await websocket.send_text(JSON_DUMPS({"type": "error", "message": str(e)}))

# ----------------- Core Processing Logic (Updated for AssemblyAI) -----------------
# Note: The old process_live_audio_stream function has been replaced with 
# process_live_audio_stream_assemblyai which is defined above
# ----------------- Audio Enhancement (Simplified for AssemblyAI) -----------------
def enhance_audio_for_stt(audio_data: bytes, sample_rate: int = 16000) -> bytes:
    """
    Basic audio preprocessing for AssemblyAI (less processing needed since AssemblyAI handles most)
    """
    try:
        # Convert to numpy array
        audio_array = np.frombuffer(audio_data, dtype=np.int16).astype(np.float32)
        
        if len(audio_array) == 0:
            return audio_data
        
        # Basic normalization only (AssemblyAI handles most preprocessing)
        audio_array = audio_array - np.mean(audio_array)
        
        # Simple amplitude normalization
        max_val = np.max(np.abs(audio_array))
        if max_val > 0:
            audio_array = audio_array / max_val * 20000
        
        # Final limiting and conversion
        audio_array = np.clip(audio_array, -32767, 32767)
        return audio_array.astype(np.int16).tobytes()
        
    except Exception as e:
        print(f"Audio enhancement error: {e}, using original audio")
        return audio_data

async def process_conversation_turn(websocket: WebSocket, text: str, session: dict, is_correction: bool = False):
    try:
        # Basic validation
        text = text.strip()
        if not text or len(text) < 2:
            return
        
        # TIME-BASED DUPLICATE PREVENTION (consistent with transcript handling)
        import string
        normalized_text = text.strip().lower()
        # Remove all punctuation for comparison
        normalized_text = ''.join(char for char in normalized_text if char not in string.punctuation)
        # Remove extra spaces
        normalized_text = ' '.join(normalized_text.split())
        
        current_time = datetime.now()
        
        # Check against the last processed conversation input (not transcript)
        last_processed_conversation = session.get("last_processed_conversation")
        
        if (last_processed_conversation and
            (current_time - last_processed_conversation["time"]).total_seconds() < 3):
            
            # Calculate similarity with last processed conversation
            last_normalized = last_processed_conversation["normalized"]
            
            # Simple exact match for conversation processing (more forgiving than transcript)
            if normalized_text == last_normalized:
                print("⚠️ Duplicate conversation processing prevented within 3-second window.")
                return
        
        # Store this conversation for future comparison
        session["last_processed_conversation"] = {
            "text": text,
            "normalized": normalized_text,
            "time": current_time
        }
        
        # Process conversation turn
        session["last_speech_time"] = current_time
        
        # Check for information collection
        if "@" in text:
            session["checklist"]["email_collected"] = True
        if any(w in text.lower() for w in ["my name is", "this is", "i am", "i'm"]):
            session["checklist"]["name_collected"] = True
        if any(w in text.lower() for w in ["send", "form", "yes", "let's do it", "follow up", "i'm interested"]):
            session["lead_interested"] = True
        
        await websocket.send_text(JSON_DUMPS({
            "type": "session_update",
            "data": {"checklist": session["checklist"], "lead_interested": session["lead_interested"]}
        }))
        
        await generate_ai_response_stream(websocket, text, session)
    except Exception as e:
        print(f"Conversation turn processing error: {e}")

def calculate_text_similarity(text1: str, text2: str) -> float:
    """Calculate similarity between two texts using word-based approach"""
    words1 = set(text1.split())
    words2 = set(text2.split())
    
    if not words1 and not words2:
        return 1.0
    if not words1 or not words2:
        return 0.0
    
    intersection = words1.intersection(words2)
    union = words1.union(words2)
    
    return len(intersection) / len(union)

async def generate_ai_response_stream(websocket: WebSocket, user_input: str, session: dict):
    """Generates AI response in real-time and streams it back to the client with buffered TTS."""
    # Mark AI as responding to prevent processing new transcripts
    session["ai_is_responding"] = True
    
    # Initialize TTS state tracking to prevent leftover speech
    session["tts_generation_active"] = True
    session["pending_tts_chunks"] = []
    session["current_speech_buffer"] = ""
    
    # Check if this response is following an interruption and add natural pause
    current_time = datetime.now()
    last_interruption = session.get("last_interruption_time")
    
    if last_interruption:
        # Calculate time since last interruption
        time_since_interruption = (current_time - last_interruption).total_seconds()
        
        # If the interruption was recent (within 5 seconds), add a natural pause
        if time_since_interruption < 5.0:
            print(f"⏳ Adding 150ms natural pause after recent interruption ({time_since_interruption:.2f}s ago)")
            await asyncio.sleep(0.15)  # 150ms natural pause
            
            # Clear the interruption timestamp to avoid multiple pauses
            session["last_interruption_time"] = None
    
    session["conversation_history"].append({"role": "user", "content": user_input})
    
    full_reply_text = ""
    text_buffer = ""  # Buffer to collect words before TTS generation
    spoken_text = ""  # Track what was already spoken to prevent repetition
    tts_generated = False  # Track if any TTS has been generated
    
    try:
        messages_to_send = [
            {"role": "system", "content": sales_script_text}
        ] + session["conversation_history"][-4:]
        
        stream = await asyncio.to_thread(
            openai_client.chat.completions.create,
            model="gpt-4.1-nano",
            messages=messages_to_send,
            stream=True
        )

        for chunk in stream:
            # Check for interruption at each chunk
            if not session.get("ai_is_responding", False):
                print("🚨 Halting AI response stream due to interruption")
                break
                
            content = chunk.choices[0].delta.content or ""
            if content:
                full_reply_text += content
                text_buffer += content
                
                # Immediately send the partial text to the frontend
                await websocket.send_text(JSON_DUMPS({"type": "ai_partial_response", "text": content}))
                
                # SIMPLIFIED TTS: Generate TTS for complete phrases ending with punctuation
                if should_generate_tts(text_buffer):
                    # Check for interruption before TTS generation
                    if not session.get("ai_is_responding", False) or not session.get("tts_generation_active", True):
                        print("🚨 Halting TTS generation due to interruption")
                        break
                    # Simple approach: Only generate TTS for NEW content not already spoken
                    if len(text_buffer) > len(spoken_text):
                        # Get only the new part that hasn't been spoken yet
                        new_content = text_buffer[len(spoken_text):].strip()
                        
                        # Look for a complete phrase in the new content
                        phrase_to_speak = extract_complete_phrase(new_content)
                        
                        if phrase_to_speak and session.get("tts_generation_active", True):  # Only speak if we have a complete phrase and TTS is active
                            # Final interruption check before TTS generation
                            if not session.get("ai_is_responding", False):
                                print("🚨 Last-second interruption detected - skipping TTS")
                                break
                                
                            # Generate TTS for just this new phrase
                            audio_bytes = await asyncio.to_thread(generate_tts_audio, phrase_to_speak)
                            
                            # Check again after TTS generation (it takes time)
                            if not session.get("ai_is_responding", False) or not session.get("tts_generation_active", True):
                                print("🚨 Interruption detected after TTS generation - discarding audio")
                                break
                                
                            audio_base64 = base64.b64encode(audio_bytes).decode('utf-8')
                            await websocket.send_text(JSON_DUMPS({
                                "type": "ai_response_chunk",
                                "audio": audio_base64,
                                "sample_rate": 22050,
                                "format": "pcm16"
                            }))
                            # Update what has been spoken: spoken_text + new phrase
                            spoken_text = (spoken_text + " " + phrase_to_speak).strip()
                            tts_generated = True

        # Generate TTS for any remaining text that wasn't spoken
        if text_buffer and len(text_buffer) > len(spoken_text) and session.get("ai_is_responding", False) and session.get("tts_generation_active", True):
            # Get the remaining unsaid content
            remaining_content = text_buffer[len(spoken_text):].strip()
            
            if remaining_content and len(remaining_content) > 2:  # Only speak substantial content
                audio_bytes = await asyncio.to_thread(generate_tts_audio, remaining_content)
                audio_base64 = base64.b64encode(audio_bytes).decode('utf-8')
                await websocket.send_text(JSON_DUMPS({
                    "type": "ai_response_chunk",
                    "audio": audio_base64,
                    "sample_rate": 22050,
                    "format": "pcm16"
                }))
                tts_generated = True

        # Mark AI as no longer responding and clear TTS state
        session["ai_is_responding"] = False
        session["tts_generation_active"] = False
        session["pending_tts_chunks"] = []
        session["current_speech_buffer"] = ""
        
        # Process any queued transcript if available
        if session.get("queued_transcript"):
            queued_text = session.pop("queued_transcript")
            # Process queued transcript silently
            await process_conversation_turn(websocket, queued_text, session)

        # Append the new AI response to the full conversation history
        session["conversation_history"].append({"role": "assistant", "content": full_reply_text})
        
        # Send a final message to signal the end of the AI response
        await websocket.send_text(JSON_DUMPS({"type": "ai_response_end"}))
        
        # Only show the final complete response
        print(f"🤖 MARK: {full_reply_text}")
    except Exception as e:
        # Mark AI as no longer responding even on error and clear TTS state
        session["ai_is_responding"] = False
        session["tts_generation_active"] = False
        session["pending_tts_chunks"] = []
        session["current_speech_buffer"] = ""
        session["ai_is_responding"] = False
        print(f"❌ AI Error: {e}")
        await websocket.send_text(JSON_DUMPS({"type": "error", "message": f"AI response error: {str(e)}"}))

def generate_tts_audio(text: str) -> bytes:
    """Generate natural, human-like TTS with proper punctuation pauses and no breathing sounds."""
    # Import for suppressing TTS output
    from contextlib import redirect_stdout, redirect_stderr
    import io
    
    # Clean up text for natural speech
    text = text.strip()
    
    if not text:
        return b""
    
    # ADVANCED TEXT PREPROCESSING for natural speech
    # Remove extra spaces and normalize punctuation for natural flow
    text = text.replace('  ', '')           # Remove double spaces
    text = text.replace(' ,', ',')           # Fix spacing before commas
    text = text.replace(' .', '.')           # Fix spacing before periods
    text = text.replace(' !', '!')           # Fix spacing before exclamations
    text = text.replace(' ?', '?')           # Fix spacing before questions
    text = text.replace(' ;', ';')           # Fix spacing before semicolons
    text = text.replace(' :', ':')           # Fix spacing before colons
    
    # Ensure proper spacing after punctuation for natural pauses
    text = text.replace(',', ',')           # Comma + space for natural pause
    text = text.replace('.', '.')           # Period + space for natural pause
    text = text.replace('!', '!')           # Exclamation + space
    text = text.replace('?', '?')           # Question + space
    text = text.replace(';', ';')           # Semicolon + space
    text = text.replace(':', ':')           # Colon + space
    
    # Remove multiple consecutive spaces
    while '  ' in text:
        text = text.replace('  ', ' ')
    
    # Remove filler words and sounds that make speech robotic
    text = text.replace(' um ', '')
    text = text.replace(' uh ', '')
    text = text.replace(' er ', '')
    text = text.replace(' ah ', '')
    text = text.replace(' hmm ', '')
    text = text.replace(' mm ', ' ')
    
    # Remove breathing and hesitation sounds
    text = text.replace(' *', '')            # Remove asterisk sounds
    text = text.replace('*', '')             # Remove asterisk sounds
    text = text.replace(' ... ', ' ')        # Replace ellipses with space
    text = text.replace('...', '')           # Remove ellipses
    text = text.replace(' -- ', ' ')         # Replace dashes with space
    text = text.replace('--', ' ')           # Replace dashes
    
    # Final cleanup
    text = text.strip()
    
    # Generate TTS audio with natural speech settings
    try:
        # Suppress TTS verbose output during generation
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            # Use speaker p226 (male, natural voice) - often sounds less robotic than female voices
            wav = tts.tts(text=text, speaker="p226")
        
        wav_np = np.array(wav, dtype=np.float32)
        
        # ADVANCED AUDIO POST-PROCESSING for natural speech
        if len(wav_np) > 0:
            # Remove silence at beginning and end to prevent unnatural pauses
            # Find first and last non-silent samples
            threshold = 0.01  # Silence threshold
            start_idx = 0
            end_idx = len(wav_np)
            
            for i in range(len(wav_np)):
                if abs(wav_np[i]) > threshold:
                    start_idx = i
                    break
            
            for i in range(len(wav_np) - 1, -1, -1):
                if abs(wav_np[i]) > threshold:
                    end_idx = i + 1
                    break
            
            # Trim silence but keep a tiny bit for natural flow
            margin = int(0.05 * 22050)  # 50ms margin
            start_idx = max(0, start_idx - margin)
            end_idx = min(len(wav_np), end_idx + margin)
            wav_np = wav_np[start_idx:end_idx]
            
            # Apply very gentle smoothing to remove harsh transitions
            if len(wav_np) > 100:
                # Gentle fade in/out to prevent clicks (much shorter than before)
                fade_samples = int(0.005 * 22050)  # 5ms fade
                if len(wav_np) > fade_samples * 2:
                    # Smooth fade in
                    wav_np[:fade_samples] *= np.linspace(0.0, 1.0, fade_samples)
                    # Smooth fade out
                    wav_np[-fade_samples:] *= np.linspace(1.0, 0.0, fade_samples)
            
            # Normalize audio level for consistent, natural volume
            max_val = np.max(np.abs(wav_np))
            if max_val > 0:
                # Use 80% of max volume for more natural sound (not too loud)
                wav_np = wav_np * (0.8 / max_val)
        
        # Convert to int16 for audio output
        wav_int16 = (wav_np * 32767).astype(np.int16)
        return wav_int16.tobytes()
        
    except Exception as e:
        print(f"TTS generation error: {e}")
        return b""

def extract_complete_phrase(text: str) -> str:
    """Extract phrases only at proper punctuation marks (. , ?) for natural speech flow."""
    if not text:
        return ""
    
    text = text.strip()
    
    # STRICT: Only generate TTS at proper punctuation marks for natural speech
    sentence_endings = ['.', '!', '?']  # Complete sentences - highest priority
    natural_pauses = [',']              # Natural pause points
    
    # Look for complete sentences first (best for natural speech)
    for i, char in enumerate(text):
        if char in sentence_endings:
            sentence = text[:i + 1].strip()
            if len(sentence.split()) >= 3:  # At least 3 words for meaningful speech
                return sentence
    
    # Look for natural pause points (commas) but only for longer phrases
    for i, char in enumerate(text):
        if char in natural_pauses:
            phrase = text[:i + 1].strip()
            if len(phrase.split()) >= 5:  # At least 5 words before comma pause
                return phrase
    
    # STRICT: No TTS without proper punctuation - wait for natural speech boundaries
    # This prevents robotic choppy speech
    return ""
    
    return ""  # Wait for more content

def should_generate_tts(text_buffer: str) -> bool:
    """Natural phrase-based TTS trigger - speak complete phrases ending with punctuation."""
    text = text_buffer.strip()
    if not text:
        return False
    
    # Check if we have a complete phrase ending with punctuation
    punctuation_marks = ['.', ',', '!', '?', ';', ':']
    
    # Look for natural phrase boundaries
    for punct in punctuation_marks:
        if punct in text:
            return True
    
    # Also trigger after a reasonable number of words if no punctuation found
    # This prevents extremely long waits if the AI doesn't use punctuation
    word_count = len(text.split())
    if word_count >= 8:  # Wait for 8+ words before forcing TTS
        return True
    
    return False

async def send_ai_response(websocket: WebSocket, text: str, session: dict):
    """Sends a complete, non-streamed AI response for initial greetings."""
    try:
        audio_bytes = await asyncio.to_thread(generate_tts_audio, text)
        audio_base64 = base64.b64encode(audio_bytes).decode('utf-8')
        session["conversation_segments"].append(("ai", audio_bytes))
        
        await websocket.send_text(JSON_DUMPS({
            "type": "ai_response",
            "text": text,
            "audio": audio_base64,
            "sample_rate": 22050,
            "format": "pcm16"
        }))
        
        session["conversation_history"].append({"role": "assistant", "content": text})
        print(f"Initial AI Response sent: {text[:50]}...")
    except Exception as e:
        print(f"TTS error: {e}")
        await websocket.send_text(JSON_DUMPS({"type": "error", "message": f"TTS error: {str(e)}"}))

async def generate_call_summary(conversation_history: list) -> dict:
    conversation_text = ""
    for msg in conversation_history:
        role = "Agent" if msg["role"] == "assistant" else "Customer"
        conversation_text += f"{role}: {msg['content']}\n"
    
    summary_prompt = f"""
    Please analyze the following sales call conversation and provide:
    1. A brief call summary (2-3 sentences describing what was discussed)
    2. Lead interest level based on customer responses and engagement

    Conversation: {conversation_text}

    Determine lead interest level:
    - "High" if customer showed strong interest, asked detailed questions, or expressed intent to purchase/proceed
    - "Medium" if customer showed some interest but had concerns or wanted to think about it
    - "Low" if customer showed little interest, was unresponsive, or declined the offer
    - "Unknown" if the conversation was too brief to determine interest

    Respond in JSON format: {{ "call_summary": "Brief summary of what was discussed in the call", "lead_interest": "High/Medium/Low/Unknown" }}
    """
    
    try:
        response = await asyncio.to_thread(
            openai_client.chat.completions.create,
            model="gpt-4.1-nano",
            messages=[{"role": "user", "content": summary_prompt}],
            max_tokens=200,
            temperature=0.3
        )
        summary_data = json.loads(response.choices[0].message.content)
        print(f"Generated call summary: {summary_data}")
        return summary_data
    except Exception as e:
        print(f"Error generating call summary: {e}")
        return {"call_summary": "Call completed - summary generation failed", "lead_interest": "Unknown"}

async def save_call_recording(conversation_segments: list, customer_index: int, timestamp_str: str = None):
    """
    Save the complete call recording by combining all audio segments into a WAV file
    """
    if not conversation_segments:
        print("⚠️ No conversation segments to save")
        return None
        
    try:
        # Generate timestamp if not provided
        if not timestamp_str:
            timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
        
        # Create filename: customer_index + timestamp
        filename = f"customer_{customer_index}_{timestamp_str}.wav"
        filepath = os.path.join(RECORDINGS_DIR, filename)
        
        print(f"🎵 Saving call recording: {filename}")
        print(f"📊 Total audio segments: {len(conversation_segments)}")
        
        # Combine all audio segments
        combined_audio = io.BytesIO()
        total_duration = 0
        
        for segment_type, audio_data in conversation_segments:
            if isinstance(audio_data, bytes) and len(audio_data) > 0:
                combined_audio.write(audio_data)
                # Estimate duration (PCM16, 16kHz for user, 22.05kHz for AI)
                sample_rate = 16000 if segment_type == "user" else 22050
                duration = len(audio_data) / 2 / sample_rate  # 2 bytes per sample
                total_duration += duration
                
        if combined_audio.tell() == 0:
            print("⚠️ No audio data found in segments")
            return None
            
        print(f"⏱️ Total recording duration: {total_duration:.2f} seconds")
        
        # Save as WAV file
        combined_audio.seek(0)
        audio_data = combined_audio.read()
        
        # Create WAV file with appropriate format
        with wave.open(filepath, 'wb') as wav_file:
            wav_file.setnchannels(1)  # Mono
            wav_file.setsampwidth(2)  # 2 bytes per sample (16-bit)
            wav_file.setframerate(16000)  # Standard rate for speech
            wav_file.writeframes(audio_data)
            
        file_size = os.path.getsize(filepath)
        print(f"✅ Call recording saved successfully:")
        print(f"   📁 File: {filepath}")
        print(f"   📊 Size: {file_size:,} bytes")
        print(f"   ⏱️ Duration: {total_duration:.2f} seconds")
        
        return filepath
        
    except Exception as e:
        print(f"❌ Error saving call recording: {e}")
        import traceback
        traceback.print_exc()
        return None

async def update_google_sheet_by_index_number(user_sheet, customer_index_number: int, summary_data: dict, agent_feedback: str):
    """
    Find the row by matching customer_index_number in the Index Number column (assumed to be column A)
    and update the corresponding cells with call data
    """
    print(f"=== UPDATING GOOGLE SHEETS BY INDEX NUMBER ===")
    print(f"Sheet object: {type(user_sheet)}")
    print(f"Looking for customer index number: {customer_index_number}")
    print(f"Summary data: {summary_data}")
    print(f"Agent feedback: {agent_feedback}")
    
    try:
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
        # Get all values from column A (Index Number column) to find the matching row
        print(f"🔍 Searching for index number {customer_index_number} in column A...")
        column_a_values = await asyncio.to_thread(user_sheet.col_values, 1)  # Column A (1-based)
        
        # Find the row number that matches the customer index number
        target_row = None
        for i, value in enumerate(column_a_values, start=1):  # 1-based row numbering
            if value.strip() == str(customer_index_number):
                target_row = i
                break
        
        if target_row is None:
            print(f"❌ Customer index number {customer_index_number} not found in column A")
            raise Exception(f"Customer index number {customer_index_number} not found in the sheet")
        
        print(f"✅ Found customer index number {customer_index_number} at row {target_row}")
        
        # Read existing content from the target row before updating
        print(f"📖 Reading existing content from row {target_row}...")
        existing_row_data = await asyncio.to_thread(user_sheet.row_values, target_row)
        
        # Ensure we have enough columns in the existing data
        while len(existing_row_data) < 11:
            existing_row_data.append("")
        
        existing_call_summary = existing_row_data[7] if len(existing_row_data) > 7 else ""  # Column H (index 7)
        existing_agent_feedback = existing_row_data[8] if len(existing_row_data) > 8 else ""  # Column I (index 8)
        existing_lead_interest = existing_row_data[9] if len(existing_row_data) > 9 else ""  # Column J (index 9)
        existing_timestamp = existing_row_data[10] if len(existing_row_data) > 10 else ""  # Column K (index 10)
        
        print(f"📖 Existing call summary: {existing_call_summary[:50]}...")
        print(f"📖 Existing agent feedback: {existing_agent_feedback}")
        print(f"📖 Existing lead interest: {existing_lead_interest}")
        
        # Prepare new content by appending to existing content
        call_summary = summary_data.get("call_summary", "")
        lead_interest = summary_data.get("lead_interest", "")
        
        # Append new call summary (with separator if existing content exists)
        if existing_call_summary.strip():
            new_call_summary = f"{existing_call_summary} | {call_summary}"
        else:
            new_call_summary = call_summary
            
        # Append new agent feedback (with separator if existing content exists)  
        if existing_agent_feedback.strip():
            new_agent_feedback = f"{existing_agent_feedback} | {agent_feedback}"
        else:
            new_agent_feedback = agent_feedback
            
        # Append new lead interest (with separator if existing content exists)
        if existing_lead_interest.strip():
            new_lead_interest = f"{existing_lead_interest} | {lead_interest}"
        else:
            new_lead_interest = lead_interest
            
        # Append new timestamp (with separator if existing content exists)
        if existing_timestamp.strip():
            new_timestamp = f"{existing_timestamp} | {timestamp}"
        else:
            new_timestamp = timestamp
        
        print(f"📝 Updating cell H{target_row} (column 8) with appended call summary...")
        await asyncio.to_thread(user_sheet.update_cell, target_row, 8, new_call_summary)
        print(f"✅ Updated H{target_row} with: {new_call_summary[:50]}...")
        
        print(f"📝 Updating cell I{target_row} (column 9) with appended agent feedback...")
        await asyncio.to_thread(user_sheet.update_cell, target_row, 9, new_agent_feedback)
        print(f"✅ Updated I{target_row} with: {new_agent_feedback}")
        
        print(f"📝 Updating cell J{target_row} (column 10) with appended lead interest...")
        await asyncio.to_thread(user_sheet.update_cell, target_row, 10, new_lead_interest)
        print(f"✅ Updated J{target_row} with: {new_lead_interest}")
        
        print(f"📝 Updating cell K{target_row} (column 11) with appended timestamp...")
        await asyncio.to_thread(user_sheet.update_cell, target_row, 11, new_timestamp)
        print(f"✅ Updated K{target_row} with: {new_timestamp}")
        
        print(f"🎉 Successfully updated Google Sheet row {target_row} for customer index number {customer_index_number}")
        
    except Exception as e:
        print(f"❌ Error updating sheet cells: {e}")
        import traceback
        traceback.print_exc()
        raise

async def update_google_sheet_row(user_sheet, customer_index: int, summary_data: dict, agent_feedback: str):
    print(f"=== UPDATING GOOGLE SHEETS ===")
    print(f"Sheet object: {type(user_sheet)}")
    print(f"Customer index: {customer_index}")
    print(f"Summary data: {summary_data}")
    print(f"Agent feedback: {agent_feedback}")
    
    try:
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        row_number = customer_index + 1  # Convert 0-based index to 1-based row number
        
        print(f"📊 Updating row {row_number} (customer index {customer_index})")
        print(f"⏰ Timestamp: {timestamp}")
        
        # Update each cell individually with logging
        call_summary = summary_data.get("call_summary", "")
        lead_interest = summary_data.get("lead_interest", "")
        
        print(f"📝 Updating cell H{row_number} (column 8) with call summary...")
        await asyncio.to_thread(user_sheet.update_cell, row_number, 8, call_summary)
        print(f"✅ Updated H{row_number} with: {call_summary[:50]}...")
        
        print(f"📝 Updating cell I{row_number} (column 9) with agent feedback...")
        await asyncio.to_thread(user_sheet.update_cell, row_number, 9, agent_feedback)
        print(f"✅ Updated I{row_number} with: {agent_feedback}")
        
        print(f"📝 Updating cell J{row_number} (column 10) with lead interest...")
        await asyncio.to_thread(user_sheet.update_cell, row_number, 10, lead_interest)
        print(f"✅ Updated J{row_number} with: {lead_interest}")
        
        print(f"📝 Updating cell K{row_number} (column 11) with timestamp...")
        await asyncio.to_thread(user_sheet.update_cell, row_number, 11, timestamp)
        print(f"✅ Updated K{row_number} with: {timestamp}")
        
        print(f"🎉 Successfully updated Google Sheet row {row_number} (customer index {customer_index})")
    except Exception as e:
        print(f"❌ Error updating sheet cells: {e}")
        import traceback
        traceback.print_exc()
        raise

async def end_call(websocket: WebSocket, session: dict, feedback: str, customer_index: int = None):
    try:
        # Clean up AssemblyAI connection
        await cleanup_assemblyai_session(session)
        
        summary_data = {}
        if session.get("conversation_history") and customer_index:
            summary_data = await generate_call_summary(session["conversation_history"])
            await update_google_sheet_row(session["user_sheet"], customer_index, summary_data, feedback)
            
            # Save call recording before clearing session
            if session.get("conversation_segments"):
                timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
                recording_path = await save_call_recording(
                    session["conversation_segments"], 
                    customer_index + 1,  # Convert to 1-based for filename
                    timestamp_str
                )
                if recording_path:
                    print(f"🎵 Call recording saved: {os.path.basename(recording_path)}")
                else:
                    print("⚠️ Failed to save call recording")
        
        # Reset session for new call
        session["conversation_history"] = [{"role": "system", "content": sales_script_text}]
        session["checklist"] = {"name_collected": False, "email_collected": False}
        session["lead_interested"] = False
        session["conversation_segments"] = []
        session["current_partial_text"] = ""
        session["speech_active"] = False
        session["silence_start_time"] = None
        session["last_speech_time"] = datetime.now()
        session["last_transcript_time"] = datetime.now()
        
        # Create new AssemblyAI instance for next call
        session["assemblyai_stt"] = AssemblyAILiveSTT(ASSEMBLYAI_API_KEY, STT_CONFIG["sample_rate"])
        
        await websocket.send_text(JSON_DUMPS({
            "type": "call_ended",
            "message": f"Call ended successfully. Ready for a new call.",
            "summary": summary_data
        }))
    except Exception as e:
        await websocket.send_text(JSON_DUMPS({"type": "error", "message": f"Error ending call: {str(e)}"}))
        
        # Ensure cleanup even if there's an error
        try:
            await cleanup_assemblyai_session(session)
        except:
            pass

@app.get("/health")
async def health_check():
    return {"status": "healthy"}

def update_stt_config(**config_updates):
    """
    Update AssemblyAI STT configuration parameters for fine-tuning
    """
    global STT_CONFIG
    for key, value in config_updates.items():
        if key in STT_CONFIG:
            STT_CONFIG[key] = value
            print(f"Updated {key}: {value}")
        else:
            print(f"Unknown config key: {key}")
    
    print(f"Updated AssemblyAI STT Config: {STT_CONFIG}")

@app.post("/config/stt")
async def update_stt_configuration(config_updates: dict):
    """
    Update AssemblyAI STT configuration for fine-tuning
    Example: POST /config/stt {"confidence_threshold": 0.8, "word_boost": ["freight", "cargo"]}
    """
    try:
        update_stt_config(**config_updates)
        return {"status": "success", "updated_config": STT_CONFIG}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/config/stt")
async def get_stt_configuration():
    """Get current AssemblyAI STT configuration"""
    return {"status": "success", "config": STT_CONFIG}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)