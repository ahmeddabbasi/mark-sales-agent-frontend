"""
AssemblyAI Real-Time Continuous Streaming STT Module
Optimized for ultra-low latency real-time speech-to-text
"""

import asyncio
import websockets
import json
import base64
import time
import httpx  # For HTTP requests to generate tokens
from typing import Callable, Optional
import logging

# Use faster JSON library if available
try:
    import orjson as json_lib
    JSON_LOADS = json_lib.loads
    JSON_DUMPS = lambda x: json_lib.dumps(x).decode()
except ImportError:
    import json as json_lib
    JSON_LOADS = json_lib.loads
    JSON_DUMPS = json_lib.dumps

logger = logging.getLogger(__name__)

class AssemblyAILiveSTT:
    def __init__(self, api_key: str, sample_rate: int = 16000):
        """
        Initialize AssemblyAI Live STT
        
        Args:
            api_key: AssemblyAI API key
            sample_rate: Audio sample rate (must be 16000 for AssemblyAI)
        """
        self.api_key = api_key
        self.sample_rate = sample_rate
        self.websocket = None
        self.is_connected = False
        self.session_id = None
        self.token_expires_at = None  # Track token expiration
        self.reconnect_attempts = 0
        self.max_reconnect_attempts = 3
        
        # Track processed turns to prevent duplicates
        self.processed_turns = set()  # Track turn_order numbers that were already processed
        self.last_turn_order = -1     # Track the highest turn order processed
        
        # Callbacks
        self.on_partial_transcript: Optional[Callable] = None
        self.on_final_transcript: Optional[Callable] = None
        self.on_error: Optional[Callable] = None
        self.on_session_begins: Optional[Callable] = None
        self.on_session_terminated: Optional[Callable] = None
        
        # Configuration optimized for real-time continuous streaming with Universal Streaming
        self.config = {
            "sample_rate": sample_rate,
            "word_boost": ["truck", "dispatch", "load", "freight", "delivery", "shipping", "route", "driver"],
            "boost_param": "high",
            "encoding": "pcm_s16le",
            "disable_partial_transcripts": False,  # Enable partials for real-time feel
            "enable_extra_session_information": True,
            # Universal Streaming model settings
            "speech_model": "nano",  # Use nano model for ultra-low latency
            "language_code": "en",
            "punctuate": True,
            "format_text": True,
            "diarization": False,  # Disabled for speed
            "multichannel": False,  # Mono only for speed
        }
        
    async def _generate_temporary_token(self) -> str:
        """Generate a temporary token for WebSocket authentication"""
        try:
            url = "https://streaming.assemblyai.com/v3/token"
            headers = {"Authorization": self.api_key}
            params = {
                "expires_in_seconds": 600  # 10 minutes (safe duration)
            }
            
            async with httpx.AsyncClient() as client:
                response = await client.get(url, headers=headers, params=params)
                response.raise_for_status()
                data = response.json()
                
                # Track when token expires
                self.token_expires_at = time.time() + 600  # 10 minutes from now
                logger.info(f"Generated token valid for 10 minutes")
                
                return data["token"]
        except Exception as e:
            logger.error(f"Failed to generate temporary token: {e}")
            raise
    
    def _is_token_expired(self) -> bool:
        """Check if the current token is expired or will expire soon"""
        if not self.token_expires_at:
            return True
        # Consider token expired if it expires within 2 minutes
        return time.time() > (self.token_expires_at - 120)
    
    async def _reconnect_if_needed(self):
        """Reconnect if token is expired or connection is lost"""
        if not self.is_connected or self._is_token_expired():
            logger.info("Reconnecting to AssemblyAI due to token expiration or connection loss...")
            try:
                if self.websocket:
                    await self.disconnect()
                await self.connect()
                self.reconnect_attempts = 0
                logger.info("✅ Reconnected successfully")
            except Exception as e:
                self.reconnect_attempts += 1
                logger.error(f"Reconnection attempt {self.reconnect_attempts} failed: {e}")
                if self.reconnect_attempts >= self.max_reconnect_attempts:
                    logger.error("Max reconnection attempts reached")
                    raise
        
    async def connect(self):
        """Connect to AssemblyAI Universal Streaming API using temporary token"""
        try:
            # Generate temporary token for secure authentication
            logger.info("Generating temporary token for AssemblyAI Universal Streaming...")
            temp_token = await self._generate_temporary_token()
            logger.info("✅ Temporary token generated successfully")
            
            # Universal Streaming v3 expects configuration in URL parameters
            params = {
                "token": temp_token,
                "sample_rate": self.config["sample_rate"],
                "encoding": self.config["encoding"],
                "format_turns": "true",  # String for URL param
                "end_of_turn_confidence_threshold": "0.7",
                "min_end_of_turn_silence_when_confident": "160",
                "max_turn_silence": "2400",
            }
            
            # Build URL with parameters
            param_string = "&".join([f"{k}={v}" for k, v in params.items()])
            url = f"wss://streaming.assemblyai.com/v3/ws?{param_string}"
            
            self.websocket = await websockets.connect(
                url,
                ping_interval=10,      # More frequent pings for real-time
                ping_timeout=5,        # Faster timeout detection
                close_timeout=3,       # Quick cleanup
                max_size=None,         # No message size limit
                compression=None       # Disable compression for speed
            )
            
            logger.info("Connected to AssemblyAI Universal Streaming v3")
            
            # Start listening for messages
            asyncio.create_task(self._listen_for_messages())
            
            # Configuration is already sent via URL parameters, no separate config message needed
            
            self.is_connected = True
            
        except Exception as e:
            logger.error(f"Failed to connect to AssemblyAI: {e}")
            if self.on_error:
                await self.on_error(f"Connection failed: {e}")
            raise
    
    async def _send_config(self):
        """Configuration is now sent via URL parameters during connection"""
        # No separate config message needed for Universal Streaming v3
        logger.info("Configuration sent via URL parameters during connection")
    
    async def _listen_for_messages(self):
        """Listen for messages from AssemblyAI WebSocket with real-time processing"""
        try:
            async for message in self.websocket:
                # Use faster JSON parsing
                data = JSON_LOADS(message)
                await self._handle_message(data)
        except websockets.exceptions.ConnectionClosed:
            logger.info("AssemblyAI WebSocket connection closed")
            self.is_connected = False
        except Exception as e:
            logger.error(f"Error listening for messages: {e}")
            if self.on_error:
                await self.on_error(f"Listen error: {e}")
    
    async def _handle_message(self, data: dict):
        """Handle messages from AssemblyAI Universal Streaming (v3 format) with turn-order deduplication"""
        # Universal Streaming v3 uses different message format
        if "turn_order" in data:
            # This is a Turn message (main transcription response)
            turn_order = data.get("turn_order")
            text = data.get("transcript", "").strip()
            end_of_turn = data.get("end_of_turn", False)
            turn_is_formatted = data.get("turn_is_formatted", False)
            confidence = data.get("end_of_turn_confidence", 0.9)
            
            # CRITICAL: Prevent duplicate processing based on turn_order
            if turn_order is not None:
                if end_of_turn:
                    # For final transcripts, only process if we haven't processed this turn_order yet
                    if turn_order in self.processed_turns:
                        logger.debug(f"Skipping duplicate final turn {turn_order}: '{text}'")
                        return
                    
                    # Only process turns that are newer than our last processed turn
                    if turn_order <= self.last_turn_order:
                        logger.debug(f"Skipping old final turn {turn_order} (last: {self.last_turn_order}): '{text}'")
                        return
                    
                    # Mark this turn as processed and update last turn order
                    self.processed_turns.add(turn_order)
                    self.last_turn_order = turn_order
                    
                    # Clean up old processed turns (keep only last 50 to prevent memory growth)
                    if len(self.processed_turns) > 50:
                        self.processed_turns = {t for t in self.processed_turns if t > self.last_turn_order - 25}
                    
                    logger.info(f"Processing final turn {turn_order}: '{text}'")
                    
                    # Final transcript - guaranteed unique
                    if text and self.on_final_transcript:
                        await self.on_final_transcript(text, confidence, data)
                else:
                    # Partial transcript (ongoing turn) - allow these for real-time feedback
                    if text and self.on_partial_transcript:
                        await self.on_partial_transcript(text, confidence, data)
            else:
                logger.warning(f"Turn message without turn_order: {data}")
                        
        elif "type" in data:
            message_type = data["type"]
            
            if message_type == "session_begins":
                logger.info(f"AssemblyAI Universal Streaming session started: {data.get('session_id')}")
                self.session_id = data.get("session_id")
                # Reset turn tracking for new session
                self.processed_turns.clear()
                self.last_turn_order = -1
                if self.on_session_begins:
                    await self.on_session_begins(data)
                    
            elif message_type == "session_terminated":
                logger.info("AssemblyAI Universal Streaming session terminated")
                self.is_connected = False
                # Clear turn tracking
                self.processed_turns.clear()
                self.last_turn_order = -1
                if self.on_session_terminated:
                    await self.on_session_terminated(data)
                    
            elif message_type == "error":
                error_msg = data.get("error", "Unknown error")
                logger.error(f"AssemblyAI Universal Streaming error: {error_msg}")
                if self.on_error:
                    await self.on_error(error_msg)
        else:
            logger.debug(f"Unknown message format from AssemblyAI: {data}")
    
    async def send_audio(self, audio_data: bytes):
        """
        Send audio data to AssemblyAI Universal Streaming (v3 format)
        
        Args:
            audio_data: PCM16 audio data at 16kHz
        """
        # Check if we need to reconnect due to token expiration
        if self._is_token_expired() or not self.is_connected or not self.websocket:
            logger.info("Token expired or connection lost, reconnecting...")
            await self._reconnect_if_needed()
        
        if not self.is_connected or not self.websocket:
            logger.warning("Cannot send audio: not connected to AssemblyAI")
            return
        
        try:
            # Universal Streaming v3 expects raw binary audio data, not JSON
            await self.websocket.send(audio_data)
            
        except Exception as e:
            logger.error(f"Error sending audio to AssemblyAI: {e}")
            # Try to reconnect on connection errors
            if "ConnectionClosed" in str(e) or "ConnectionReset" in str(e):
                logger.info("Connection error detected, attempting reconnection...")
                await self._reconnect_if_needed()
            elif self.on_error:
                await self.on_error(f"Send audio error: {e}")
    
    async def send_terminate(self):
        """Send termination message to end the Universal Streaming session"""
        if self.websocket and self.is_connected:
            try:
                # Universal Streaming v3 termination format
                terminate_message = {"terminate": True}
                await self.websocket.send(JSON_DUMPS(terminate_message))
                logger.info("Sent termination message to AssemblyAI")
            except Exception as e:
                logger.error(f"Error sending termination: {e}")
    
    async def disconnect(self):
        """Disconnect from AssemblyAI"""
        if self.websocket:
            try:
                await self.send_terminate()
                await self.websocket.close()
                logger.info("Disconnected from AssemblyAI")
            except Exception as e:
                logger.error(f"Error during disconnect: {e}")
            finally:
                self.is_connected = False
                self.websocket = None
                self.session_id = None
    
    def set_callbacks(self, 
                     on_partial_transcript: Optional[Callable] = None,
                     on_final_transcript: Optional[Callable] = None,
                     on_error: Optional[Callable] = None,
                     on_session_begins: Optional[Callable] = None,
                     on_session_terminated: Optional[Callable] = None):
        """Set callback functions for different events"""
        self.on_partial_transcript = on_partial_transcript
        self.on_final_transcript = on_final_transcript
        self.on_error = on_error
        self.on_session_begins = on_session_begins
        self.on_session_terminated = on_session_terminated

    def get_realtime_config(self, session_id: str = None) -> dict:
        """
        Get real-time optimized configuration for AssemblyAI Live Streaming STT
        
        Returns:
            dict: Configuration for maximum real-time performance
        """
        config = {
            "sample_rate": 16000,
            "word_boost": [],  # Empty for faster processing
            "encoding": "pcm_s16le",
            
            # Real-time optimizations
            "disable_partial_transcripts": False,  # Enable partial for immediate feedback
            "format_text": True,  # Auto-format for better readability
            
            # Ultra-low latency settings
            "speech_threshold": 0.3,  # Lower threshold for faster speech detection
            "auto_highlights": False,  # Disable for speed
            "speaker_labels": False,  # Disable for speed
            "punctuate": True,  # Keep punctuation
            "format_text": True,  # Auto-capitalization
        }
        
        # Add session context if provided
        if session_id:
            config["session_id"] = session_id
            
        return config
