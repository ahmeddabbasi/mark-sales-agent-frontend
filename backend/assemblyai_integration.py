"""
Updated WebSocket endpoint and audio processing functions for AssemblyAI integration
"""

import json
import base64
from datetime import datetime
from fastapi import WebSocket

# Import configuration from main module
try:
    from main import STT_CONFIG, process_conversation_turn
except ImportError:
    # Fallback configuration if imported separately
    STT_CONFIG = {
        "partial_confidence_threshold": 0.7,
        "confidence_threshold": 0.8,
        "silence_timeout_ms": 500
    }
    
    async def process_conversation_turn(websocket, text, session):
        """Fallback function - should be imported from main"""
        pass

async def setup_assemblyai_for_session(session: dict, websocket: WebSocket):
    """Set up AssemblyAI STT for a session with callbacks"""
    assemblyai_stt = session["assemblyai_stt"]
    
    # Set up callbacks
    async def on_partial_transcript(text: str, confidence: float, data: dict):
        """Handle partial transcripts from AssemblyAI"""
        if confidence >= STT_CONFIG["partial_confidence_threshold"]:
            session["current_partial_text"] = text
            session["speech_active"] = True
            session["silence_start_time"] = None
            
            # Send partial transcript to frontend
            await websocket.send_text(json.dumps({
                "type": "partial_transcription", 
                "text": text,
                "confidence": confidence,
                "source": "assemblyai"
            }))
            
            session["last_transcript_time"] = datetime.now()
    
    async def on_final_transcript(text: str, confidence: float, data: dict):
        """Handle final transcripts from AssemblyAI"""
        if confidence >= STT_CONFIG["confidence_threshold"]:
            print(f"🎯 AssemblyAI Final: '{text}' (confidence: {confidence:.2f})")
            
            # Send final transcription to frontend
            await websocket.send_text(json.dumps({
                "type": "transcription", 
                "text": text,
                "confidence": confidence,
                "source": "assemblyai"
            }))
            
            # Process conversation
            await process_conversation_turn(websocket, text, session)
            
            # Clear partial text
            session["current_partial_text"] = ""
            session["speech_active"] = False
            session["silence_start_time"] = datetime.now()
            
        session["last_transcript_time"] = datetime.now()
    
    async def on_error(error_msg: str):
        """Handle AssemblyAI errors"""
        print(f"❌ AssemblyAI Error: {error_msg}")
        await websocket.send_text(json.dumps({
            "type": "error", 
            "message": f"STT Error: {error_msg}"
        }))
    
    async def on_session_begins(data: dict):
        """Handle session start"""
        print(f"✅ AssemblyAI session started: {data.get('session_id')}")
        await websocket.send_text(json.dumps({
            "type": "stt_status", 
            "status": "connected",
            "session_id": data.get('session_id')
        }))
    
    async def on_session_terminated(data: dict):
        """Handle session termination"""
        print("🔚 AssemblyAI session terminated")
        await websocket.send_text(json.dumps({
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

async def process_live_audio_stream_assemblyai(websocket: WebSocket, audio_data: str, session: dict):
    """Process live audio stream using AssemblyAI"""
    try:
        # Decode audio data
        audio_bytes = base64.b64decode(audio_data)
        
        # Store user audio for call recording
        session["conversation_segments"].append(("user", audio_bytes))
        
        # Send audio to AssemblyAI for real-time transcription
        assemblyai_stt = session["assemblyai_stt"]
        if assemblyai_stt.is_connected:
            await assemblyai_stt.send_audio(audio_bytes)
        else:
            print("⚠️ AssemblyAI not connected, attempting to reconnect...")
            try:
                await assemblyai_stt.connect()
                await assemblyai_stt.send_audio(audio_bytes)
            except Exception as e:
                print(f"❌ Failed to reconnect to AssemblyAI: {e}")
                await websocket.send_text(json.dumps({
                    "type": "error", 
                    "message": "STT connection lost"
                }))
        
        # Handle silence detection for better conversation flow
        await handle_silence_detection(websocket, session)
        
    except Exception as e:
        print(f"Live audio stream processing error: {e}")
        await websocket.send_text(json.dumps({
            "type": "error", 
            "message": f"Audio processing error: {str(e)}"
        }))

async def handle_silence_detection(websocket: WebSocket, session: dict):
    """Handle silence detection and timeout processing"""
    current_time = datetime.now()
    
    # If we have a partial transcript and silence has started
    if (session.get("current_partial_text") and 
        session.get("silence_start_time") and
        not session.get("speech_active", False)):
        
        silence_duration = (current_time - session["silence_start_time"]).total_seconds() * 1000
        
        # If silence exceeds timeout, process partial as final
        if silence_duration > STT_CONFIG["silence_timeout_ms"]:
            partial_text = session["current_partial_text"].strip()
            if partial_text:
                print(f"⏰ Silence timeout - processing partial: '{partial_text}'")
                
                # Send as final transcription
                await websocket.send_text(json.dumps({
                    "type": "transcription", 
                    "text": partial_text,
                    "confidence": 0.9,  # Assume good confidence
                    "source": "assemblyai_timeout"
                }))
                
                # Process conversation
                await process_conversation_turn(websocket, partial_text, session)
                
                # Clear partial
                session["current_partial_text"] = ""
                session["silence_start_time"] = None

async def cleanup_assemblyai_session(session: dict):
    """Clean up AssemblyAI connection when session ends"""
    try:
        assemblyai_stt = session.get("assemblyai_stt")
        if assemblyai_stt:
            await assemblyai_stt.disconnect()
            print("🧹 AssemblyAI session cleaned up")
    except Exception as e:
        print(f"Error cleaning up AssemblyAI session: {e}")
