class SalesAgentApp {
    constructor() {
        this.socket = null;
        this.isRecording = false;
        this.intentionalDisconnect = false;
        this.isLoggedIn = false;
        this.token = null;
        this.sessionId = null;
        this.currentUser = null;
        this.currentCustomerIndex = null; // Will be set when ending call
        this.stream = null;
        this.audioContext = null;
        this.workletNode = null;
        this.audioBuffer = [];
        this.bufferDuration = 0;
        this.maxBufferDuration = 100;  // Send every 100ms chunk for AssemblyAI compliance
        this.minChunkSize = 4800;      // Minimum samples per chunk (100ms at 48kHz, above AssemblyAI 50ms requirement)
        this.realTimeMode = true;      // Enable real-time continuous streaming
        this.isCallActive = false;

        this.currentAiResponseDiv = null;
        this.audioQueue = [];
        this.isAudioPlaying = false;
        this.isAiSpeaking = false; // Track when AI is speaking for barge-in detection
        this.webAudioContext = null;
        this.currentAudioTime = 0;
        this.scheduledBuffers = [];
        this.lastVadState = null; // Track VAD state changes

        // Client-side VAD for immediate barge-in detection
        this.clientVAD = null;
        this.vadEnabled = false;
        this.lastInterruptTime = 0;
        this.minInterruptInterval = 1000; // Minimum 1 second between interrupts
        
        // Interruption control - blocks all audio during barge-in
        this.isInterrupting = false;
        this.interruptionTimeout = null;
        this.lastAudioStartTime = 0; // Track when audio playback starts (for feedback protection)

        // Client-side deduplication to prevent race conditions
        this.recentAudioHashes = new Map();

        // Config will be set after initialization
        this.config = {
            apiUrl: window.appConfig.apiUrl,
            wsUrl: window.appConfig.wsUrl
        };
        
        console.log('SalesAgentApp initialized with config:', this.config);
    }

    async init() {
        // Show a loading message
        console.log('Initializing MARK Sales Agent...');
        
        // Ensure backend configuration is working
        const configured = await window.appConfig.ensureConfigured();
        if (!configured) {
            // Instead of alert, show a nicer error message on the page
            this.showConnectionError();
            return;
        }
        
        // Update our config with verified values
        this.config = {
            apiUrl: window.appConfig.apiUrl,
            wsUrl: window.appConfig.wsUrl
        };
        
        console.log('Backend verified and configured:', this.config);
        
        this.setupEventListeners();
        this.initializeClientVAD();
        this.showLogin();
    }

    showConnectionError() {
        // Show connection error on the login screen
        const loginScreen = document.getElementById('loginScreen');
        const existingError = document.getElementById('connectionError');
        
        if (!existingError) {
            const errorDiv = document.createElement('div');
            errorDiv.id = 'connectionError';
            errorDiv.className = 'fixed top-4 left-1/2 transform -translate-x-1/2 bg-red-600 text-white px-4 py-2 rounded-lg z-50';
            errorDiv.innerHTML = `
                <div class="flex items-center space-x-2">
                    <i class="fas fa-exclamation-triangle"></i>
                    <span>Backend connection failed. Please check settings.</span>
                    <button onclick="location.reload()" class="ml-2 underline">Retry</button>
                </div>
            `;
            document.body.appendChild(errorDiv);
        }
        
        // Still show login form but with a settings option
        this.showLogin();
    }

    async initializeClientVAD() {
        try {
            console.log('🎤 Initializing client-side VAD for zero-latency barge-in...');
            
            // Check if ClientVAD is available
            if (typeof ClientVAD === 'undefined') {
                console.warn('⚠️ ClientVAD not available, using fallback energy VAD');
                return;
            }
            
            this.clientVAD = new ClientVAD({
                threshold: 0.3,                // Lower threshold for more sensitive detection
                minSpeechDurationMs: 150,      // Very fast speech detection (150ms)
                minSilenceDurationMs: 100,     // Quick silence detection (100ms)
                speechPadMs: 30                // Minimal padding
            });
            
            // Set up VAD callbacks for immediate interruption
            this.clientVAD.setCallbacks({
                onSpeechStart: (speechProb) => {
                    console.log(`🗣️ VAD: Speech started (prob: ${speechProb.toFixed(3)})`);
                    this.handleVADSpeechStart(speechProb);
                },
                onSpeechEnd: (speechProb) => {
                    console.log(`🤐 VAD: Speech ended (prob: ${speechProb.toFixed(3)})`);
                    this.handleVADSpeechEnd(speechProb);
                },
                onVADUpdate: (speechProb, isSpeaking) => {
                    // SMART INTERRUPTION: Only trigger during AI speech, with audio feedback protection
                    if (this.isAiSpeaking && speechProb > 0.3) {  // Higher threshold to avoid false positives
                        // AUDIO FEEDBACK PROTECTION: Check if this might be AI audio feedback
                        const currentTime = Date.now();
                        const timeSinceAudioStart = currentTime - (this.lastAudioStartTime || 0);
                        
                        // Don't interrupt immediately after audio starts (likely feedback)
                        if (timeSinceAudioStart < 500) {  // 500ms grace period
                            console.log(`🔊 Ignoring potential audio feedback (${timeSinceAudioStart}ms after audio start)`);
                            return;
                        }
                        
                        console.log(`⚡ REAL USER SPEECH: Detected (${speechProb.toFixed(3)}) - stopping TTS`);
                        
                        // Stop current audio immediately (but don't block future audio)
                        this.stopAudioPlayback();
                        
                        // Send interrupt to server
                        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                            this.socket.send(JSON.stringify({ 
                                type: 'interrupt',
                                source: 'client_vad_speech'
                            }));
                        }
                    }
                    
                    // Update VAD status display
                    this.updateVadStatus(isSpeaking, Date.now());
                }
            });
            
            // Initialize the VAD model
            await this.clientVAD.initialize();
            this.vadEnabled = true;
            
            console.log('✅ Client-side VAD initialized successfully!');
            
        } catch (error) {
            console.warn('⚠️ Failed to initialize client-side VAD:', error);
            console.log('📶 Falling back to server-side VAD');
            this.vadEnabled = false;
        }
    }

    handleVADSpeechStart(speechProb) {
        // ECHO PROTECTION: If AI is speaking, temporarily disable barge-in to prevent feedback
        if (this.isAiSpeaking && this.vadEnabled) {
            const now = Date.now();
            
            // Prevent rapid fire interrupts
            if (now - this.lastInterruptTime < this.minInterruptInterval) {
                return;
            }
            
            // ENHANCED PROTECTION: Only allow barge-in if speech probability is very high
            // This helps distinguish real user speech from AI audio feedback
            const highConfidenceThreshold = 0.85; // Much higher threshold during AI speech
            if (speechProb < highConfidenceThreshold) {
                console.log(`� Ignoring low-confidence speech (${speechProb.toFixed(2)}) during AI playback`);
                return;
            }
            
            // Additional protection: Check if we just started AI audio (likely feedback)
            const timeSinceAudioStart = now - this.lastAudioStartTime;
            if (timeSinceAudioStart < 500) { // 500ms protection window
                console.log(`🔇 Ignoring speech detection too close to AI audio start (${timeSinceAudioStart}ms)`);
                return;
            }
            
            this.lastInterruptTime = now;
            
            console.log(`🚨 HIGH-CONFIDENCE BARGE-IN: Speech prob ${speechProb.toFixed(2)}, sending interrupt...`);
            
            // Send interrupt signal to server for state cleanup
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ 
                    type: 'interrupt',
                    source: 'client_vad',
                    speechProb: speechProb,
                    timestamp: now
                }));
            }
            
            console.log('📤 Interrupt signal sent to server for state cleanup');
        }
    }

    handleVADSpeechEnd(speechProb) {
        // Optional: Could be used for end-of-speech processing
        // Currently not needed for barge-in functionality
    }

    setupEventListeners() {
        // Set up global event listeners
        window.addEventListener('beforeunload', () => {
            this.intentionalDisconnect = true;
            if (this.socket) {
                this.socket.close();
            }
        });
        
        // Settings modal event listeners
        document.addEventListener('click', (e) => {
            if (e.target.id === 'settingsBtn' || e.target.closest('#settingsBtn')) {
                this.showSettings();
            }
            if (e.target.id === 'loginSettingsBtn' || e.target.closest('#loginSettingsBtn')) {
                this.showSettings();
            }
            if (e.target.id === 'closeSettings') {
                this.hideSettings();
            }
            if (e.target.id === 'saveSettings') {
                this.saveSettings();
            }
            if (e.target.id === 'testConnection') {
                this.testConnection();
            }
        });
    }

    showLogin() {
        document.getElementById('loginScreen').classList.remove('hidden');
        document.getElementById('mainApp').classList.add('hidden');
        
        // Remove existing event listener if any
        const loginForm = document.getElementById('loginForm');
        const newLoginForm = loginForm.cloneNode(true);
        loginForm.parentNode.replaceChild(newLoginForm, loginForm);
        
        // Add fresh event listener
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.handleLogin();
        });
    }

    async handleLogin() {
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        const submitButton = document.querySelector('#loginForm button[type="submit"]');

        // Prevent multiple submissions
        if (submitButton.disabled) return;
        
        console.log('Attempting login for:', username);
        console.log('API URL:', this.config.apiUrl);

        // Disable button and show loading state
        submitButton.disabled = true;
        submitButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing In...';

        try {
            const response = await fetch(`${this.config.apiUrl}/login`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'ngrok-skip-browser-warning': 'true'
                },
                body: JSON.stringify({ username, password })
            });
            
            console.log('Login response status:', response.status);
            
            if (response.ok) {
                const data = await response.json();
                console.log('Login successful, data:', data);
                
                this.token = data.access_token;
                this.sessionId = data.session_id;
                this.currentUser = username;
                this.isLoggedIn = true;
                
                this.showMainApp();
                await this.connectWebSocket();
            } else {
                const error = await response.json();
                console.error('Login failed with error:', error);
                this.showError('Login failed: ' + (error.detail || 'Unknown error'));
            }
        } catch (error) {
            console.error('Login request failed:', error);
            this.showError('Login failed. Please check your connection and try again.');
        } finally {
            // Re-enable button
            submitButton.disabled = false;
            submitButton.innerHTML = 'Sign In';
        }
    }

    showMainApp() {
        document.getElementById('loginScreen').classList.add('hidden');
        document.getElementById('mainApp').classList.remove('hidden');
        document.getElementById('micBtn').addEventListener('click', () => { this.toggleCall(); });
        document.getElementById('logoutBtn').addEventListener('click', () => { this.logout(); });
        document.getElementById('endCallBtn').addEventListener('click', () => { this.showEndCallModal(); });
        document.getElementById('confirmEndCall').addEventListener('click', () => { this.endCall(); });
        document.getElementById('cancelEndCall').addEventListener('click', () => { this.hideEndCallModal(); });
        
        const userElement = document.getElementById('currentUser');
        if (userElement) { 
            userElement.textContent = this.currentUser; 
        } else {
            // If currentUser element doesn't exist, just log the user
            console.log(`Logged in as: ${this.currentUser}`);
        }
    }

    showSettings() {
        const modal = document.getElementById('settingsModal');
        const urlInput = document.getElementById('backendUrl');
        const currentUrl = window.appConfig.apiUrl || localStorage.getItem('backend_url') || '';
        
        urlInput.value = currentUrl;
        modal.classList.remove('hidden');
    }

    hideSettings() {
        document.getElementById('settingsModal').classList.add('hidden');
    }

    async saveSettings() {
        const url = document.getElementById('backendUrl').value.trim();
        if (url && url.startsWith('http')) {
            const success = await window.appConfig.setBackendUrl(url);
            if (success) {
                // Update our local config
                this.config.apiUrl = window.appConfig.apiUrl;
                this.config.wsUrl = window.appConfig.wsUrl;
                alert('Backend URL updated successfully!');
                this.hideSettings();
            } else {
                alert('Failed to connect to the provided URL. Please check the URL and try again.');
            }
        } else {
            alert('Please enter a valid URL starting with http:// or https://');
        }
    }

    async testConnection() {
        const url = document.getElementById('backendUrl').value.trim();
        const testDiv = document.getElementById('connectionTest');
        
        if (!url || !url.startsWith('http')) {
            testDiv.className = 'text-center text-sm text-red-300';
            testDiv.textContent = 'Please enter a valid URL';
            testDiv.classList.remove('hidden');
            return;
        }

        testDiv.className = 'text-center text-sm text-yellow-300';
        testDiv.textContent = 'Testing connection...';
        testDiv.classList.remove('hidden');

        try {
            const response = await fetch(`${url}/config`, { 
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'ngrok-skip-browser-warning': 'true'
                },
                timeout: 5000 
            });
            
            if (response.ok) {
                const config = await response.json();
                testDiv.className = 'text-center text-sm text-green-300';
                testDiv.textContent = `✅ Connection successful! Backend: ${config.backend_url}`;
            } else {
                testDiv.className = 'text-center text-sm text-red-300';
                testDiv.textContent = '❌ Server responded with error';
            }
        } catch (error) {
            testDiv.className = 'text-center text-sm text-red-300';
            testDiv.textContent = '❌ Connection failed - check URL and backend status';
        }
    }

    async connectWebSocket() {
        try {
            this.socket = new WebSocket(`${this.config.wsUrl}/ws/${this.sessionId}`);

            this.socket.onopen = () => {
                console.log('WebSocket connected');
                this.updateConnectionStatus(true);
                this.addMessage('System', 'Connected! Click the microphone to start speaking.', 'system');
                this.reconnectAttempts = 0;
            };

            this.socket.onmessage = (event) => {
                this.handleWebSocketMessage(event);
            };

            this.socket.onclose = (event) => {
                this.updateConnectionStatus(false);
                if (this.reconnectAttempts < 5 && event.code !== 1000) {
                    this.reconnectAttempts++;
                    setTimeout(() => this.connectWebSocket(), 2000 * this.reconnectAttempts);
                }
            };

            this.socket.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.updateConnectionStatus(false);
            };

        } catch (error) {
            this.showError('Failed to connect to server');
        }
    }

    handleWebSocketMessage(event) {
        const message = JSON.parse(event.data);

        switch (message.type) {
            case 'transcription':
                this.addMessage('You', message.text, 'user');
                break;
            case 'ai_response':
                // Initial greeting
                this.addMessage('MARK (AI Agent)', message.text, 'agent');
                if (message.audio) {
                    console.log('Playing AI response audio (single)');
                    this.playAudio(message.audio, message.sample_rate);
                }
                break;
            case 'partial_transcription':
                this.showPartialTranscription(message.text);
                break;
            case 'ai_partial_response':
                this.appendAiText(message.text);
                break;
            case 'ai_response_chunk':
                this.audioQueue.push({
                    data: message.audio,
                    sampleRate: message.sample_rate
                });
                if (!this.isAudioPlaying) {
                    this.playNextAudioChunk();
                }
                break;
            case 'ai_response_end':
                this.currentAiResponseDiv = null;
                break;
            case 'vad_status':
                // Server-side VAD is now only used for status display
                // Client-side VAD handles immediate interruption for zero latency
                this.updateVadStatus(message.speech_detected, message.timestamp);
                
                // Fallback: If client-side VAD is not available, use server-side VAD for barge-in
                if (!this.vadEnabled && message.speech_detected && this.isAiSpeaking) {
                    console.log('🗣️ Server VAD: User barge-in detected (fallback mode)');
                    // Send interrupt signal to server
                    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                        this.socket.send(JSON.stringify({ 
                            type: 'interrupt',
                            source: 'server_vad_fallback'
                        }));
                    }
                    // Stop client audio playback
                    this.stopAudioPlayback();
                }
                break;
            case 'stop_audio':
                console.log('🛑 Server signaled to stop audio. Halting playback.');
                this.stopAudioPlayback();
                break;
            case 'clear_audio_buffers':
                console.log('🧹 Server signaled to clear all audio buffers. Deep cleaning...');
                this.clearAllAudioBuffers();
                break;
            case 'session_refreshed':
                console.log('Session refreshed:', message.message);
                // Clear the conversation area
                const convArea = document.getElementById('conversationArea');
                if (convArea) { 
                    convArea.innerHTML = ''; 
                }
                // Reset the current AI response div
                this.currentAiResponseDiv = null;
                // Clear audio queue
                this.audioQueue = [];
                this.isAudioPlaying = false;
                // Show a system message about the refresh
                this.addMessage('System', 'Session refreshed! Ready for next call.', 'system');
                // Reset session info display
                this.resetSessionInfoDisplay();
                break;
            case 'session_update':
                this.updateSessionInfo(message.data);
                break;
            case 'error':
                this.showError(message.message);
                break;
            case 'call_ended':
                this.addMessage('System', `Call ended: ${message.message}`, 'system');
                if (message.summary) {
                    this.addMessage('System', `Call Summary: ${message.summary.call_summary}`, 'system');
                    this.addMessage('System', `Lead Interest: ${message.summary.lead_interest}`, 'system');
                }
                const conversationArea = document.getElementById('conversationArea');
                if (conversationArea) { conversationArea.innerHTML = ''; }
                const micBtn = document.getElementById('micBtn');
                micBtn.disabled = false;
                micBtn.classList.remove('opacity-50');
                this.resetSessionInfoDisplay();
                break;
        }
    }

    appendAiText(text) {
        if (!this.currentAiResponseDiv) {
            this.currentAiResponseDiv = this.addMessage('MARK (AI Agent)', text, 'agent');
        } else {
            const textContent = this.currentAiResponseDiv.querySelector('.text-gray-800');
            if (textContent) {
                textContent.textContent += text;
            }
        }
    }

    async toggleCall() {
        if (!this.isCallActive) {
            await this.startCall();
        } else {
            this.stopCall();
        }
    }

    async startCall() {
        try {
            // Initialize Web Audio API for seamless TTS playback
            await this.initializeWebAudio();
            
            if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
                await this.connectWebSocket();
                await new Promise((resolve, reject) => {
                    const checkConnection = () => {
                        if (this.socket.readyState === WebSocket.OPEN) {
                            resolve();
                        } else {
                            reject(new Error('WebSocket connection failed'));
                        }
                    };
                    setTimeout(checkConnection, 1000);
                });
            }

            console.log('Requesting microphone access...');
            this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 48000
            });
            
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
            await this.audioContext.audioWorklet.addModule('audio-worklet-processor.js');
            const source = this.audioContext.createMediaStreamSource(this.stream);
            this.workletNode = new AudioWorkletNode(this.audioContext, 'audio-worklet-processor');

            this.workletNode.port.onmessage = async (event) => {
                if (!this.isCallActive) return;
                
                const { type, data } = event.data;
                
                if (type === 'audioData') {
                    // Handle audio data for streaming to server
                    const pcm16Buffer = data;
                    console.log(`📊 Audio chunk received: ${pcm16Buffer.length} bytes`);
                    
                    // Real-time mode: send each chunk immediately for lowest latency
                    if (this.realTimeMode) {
                        this.sendRealTimeAudioChunk(pcm16Buffer);
                    } else {
                        // Fallback: buffer mode for compatibility
                        this.audioBuffer.push(new Uint8Array(pcm16Buffer));
                        this.bufferDuration += 80;  // Each chunk is ~80ms
                        
                        if (this.bufferDuration >= this.maxBufferDuration) {
                            this.sendLiveAudioStream();
                        }
                    }
                } else if (type === 'vadResult') {
                    // Handle VAD result from worklet (fallback if client VAD not available)
                    if (!this.vadEnabled) {
                        const vadResult = data;
                        
                        // IMMEDIATE STOPPING: If worklet detected speech and AI is speaking
                        if (vadResult.speechProb > 0.2 && this.isAiSpeaking) {
                            console.log(`⚡ Worklet VAD: Immediate stop (${vadResult.speechProb.toFixed(3)})`);
                            this.stopAudioPlayback();
                        }
                        
                        // If worklet detected speech and AI is speaking, trigger barge-in
                        if (vadResult.isSpeaking && this.isAiSpeaking && vadResult.stateChanged) {
                            console.log('🗣️ Worklet VAD: Speech detected during AI speaking - triggering barge-in');
                            this.handleVADSpeechStart(vadResult.speechProb);
                        }
                        
                        // Update VAD status display
                        this.updateVadStatus(vadResult.isSpeaking, vadResult.timestamp);
                    }
                }
                
                // Process audio through client-side VAD if available
                if (this.vadEnabled && this.clientVAD && type === 'audioData') {
                    try {
                        // Convert PCM16 buffer to Float32Array for VAD processing
                        const pcm16Array = new Int16Array(data);
                        const float32Array = new Float32Array(pcm16Array.length);
                        
                        // Convert PCM16 to Float32 [-1, 1]
                        for (let i = 0; i < pcm16Array.length; i++) {
                            float32Array[i] = pcm16Array[i] / (pcm16Array[i] < 0 ? 32768 : 32767);
                        }
                        
                        // Process through client VAD for immediate speech detection
                        await this.clientVAD.processAudio(float32Array);
                        
                    } catch (error) {
                        console.warn('⚠️ Client VAD processing error:', error);
                    }
                }
            };
            source.connect(this.workletNode);
            this.isCallActive = true;
            this.isRecording = true;
            this.updateMicButton();
            
            console.log('Call started successfully');
        } catch (error) {
            this.showError('Failed to start call: ' + error.message);
        }
    }

    stopCall() {
        if (!this.isCallActive) return;

        if (this.workletNode) {
            this.workletNode.disconnect();
            this.workletNode = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }

        // Reset client-side VAD state
        if (this.clientVAD) {
            this.clientVAD.reset();
        }

        this.audioBuffer = [];
        this.bufferDuration = 0;
        this.isCallActive = false;
        this.isRecording = false;
        this.updateMicButton();
    }
    
    
    sendRealTimeAudioChunk(pcm16Buffer) {
        // Send individual audio chunks immediately for true real-time streaming
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            console.warn('WebSocket not ready for real-time audio');
            return;
        }

        const audioData = new Uint8Array(pcm16Buffer);
        const audioHash = this.getAudioHash(audioData);

        // Check if we've sent this exact audio chunk recently (e.g., within the last 500ms)
        const now = Date.now();
        if (this.recentAudioHashes.has(audioHash) && (now - this.recentAudioHashes.get(audioHash) < 500)) {
            console.warn('🔄 Duplicate audio chunk detected and ignored.');
            return;
        }
        
        // Add the hash and current time to the map
        this.recentAudioHashes.set(audioHash, now);

        // Clean up old hashes (older than 2 seconds) to prevent memory growth
        for (const [hash, timestamp] of this.recentAudioHashes.entries()) {
            if (now - timestamp > 2000) {
                this.recentAudioHashes.delete(hash);
            }
        }

        const base64Data = this.arrayBufferToBase64(audioData.buffer);
        
        // Send immediately with minimal overhead - silent logging
        this.socket.send(JSON.stringify({
            type: 'audio_stream_realtime',
            data: base64Data,
            format: 'pcm16',
            chunk_size: audioData.length,
            sample_rate: 48000,  // Updated to match actual frontend sample rate
            timestamp: now
        }));
    }

    // Simple, fast hashing function for byte arrays to detect duplicate audio chunks
    getAudioHash(byteArray) {
        let hash = 0;
        for (let i = 0; i < byteArray.length; i++) {
            hash = (hash << 5) - hash + byteArray[i];
            hash |= 0; // Convert to 32bit integer
        }
        return hash;
    }

    sendLiveAudioStream() {
        if (this.audioBuffer.length === 0) return;
        
        const totalLength = this.audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
        const combinedBuffer = new Uint8Array(totalLength);
        let offset = 0;
        
        for (const chunk of this.audioBuffer) {
            combinedBuffer.set(chunk, offset);
            offset += chunk.length;
        }
        
        const base64Data = this.arrayBufferToBase64(combinedBuffer.buffer);
        
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({
                type: 'audio_stream',
                data: base64Data,
                format: 'pcm16',
                duration: this.bufferDuration,
                streaming: true
            }));
        }
        
        this.audioBuffer = [];
        this.bufferDuration = 0;
    }
    
    async initializeWebAudio() {
        try {
            if (!this.webAudioContext) {
                this.webAudioContext = new (window.AudioContext || window.webkitAudioContext)();
                this.currentAudioTime = this.webAudioContext.currentTime;
                this.scheduledBuffers = [];
            }
            
            // Resume context if needed (required by some browsers)
            if (this.webAudioContext.state === 'suspended') {
                await this.webAudioContext.resume();
            }
            
            console.log('Web Audio API initialized for seamless TTS playback');
        } catch (error) {
            console.error('Error initializing Web Audio API:', error);
            // Fallback to regular Audio elements if Web Audio fails
        }
    }

    async playNextAudioChunk() {
        if (this.audioQueue.length === 0 || this.isAudioPlaying) {
            this.isAiSpeaking = false; // AI stops speaking when no audio to play
            return;
        }

        this.isAudioPlaying = true;
        this.isAiSpeaking = true; // AI is now speaking
        this.lastAudioStartTime = Date.now(); // Track audio start time for feedback protection
        const chunk = this.audioQueue.shift();

        try {
            // Use Web Audio API for seamless playback if available
            if (this.webAudioContext && this.webAudioContext.state === 'running') {
                await this.playAudioChunkWebAudio(chunk);
            } else {
                // Fallback to regular Audio element with optimized timing
                await this.playAudioChunkTraditional(chunk);
            }
        } catch (error) {
            console.error('Error playing audio chunk:', error);
            this.isAudioPlaying = false;
            this.playNextAudioChunk(); // Try next chunk
        }
    }
    
    async playAudioChunkWebAudio(chunk) {
        try {
            // Create WAV blob and decode for Web Audio
            const wavBlob = this.pcm16ToWavBlob(chunk.data, chunk.sampleRate || 22050);
            const wavArrayBuffer = await wavBlob.arrayBuffer();
            const audioBuffer = await this.webAudioContext.decodeAudioData(wavArrayBuffer);
            
            // Schedule playback for seamless continuity
            const source = this.webAudioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.webAudioContext.destination);
            
            // Calculate when to start this chunk for gapless playback
            const now = this.webAudioContext.currentTime;
            const startTime = Math.max(now, this.currentAudioTime);
            
            source.start(startTime);
            this.currentAudioTime = startTime + audioBuffer.duration;
            
            // Schedule the next chunk to start
            source.onended = () => {
                this.isAudioPlaying = false;
                this.playNextAudioChunk();
            };
            
        } catch (error) {
            console.error('Web Audio playback error:', error);
            // Fallback to traditional method
            await this.playAudioChunkTraditional(chunk);
        }
    }
    
    async playAudioChunkTraditional(chunk) {
        try {
            // Optimized traditional playback with reduced gaps
            const audioBlob = this.pcm16ToWavBlob(chunk.data, chunk.sampleRate || 22050);
            const audioUrl = URL.createObjectURL(audioBlob);
            
            const audio = new Audio();
            audio.src = audioUrl;
            audio.preload = 'auto'; // Preload for faster start
            
            // Slightly slower playback for more natural speech
            audio.playbackRate = 0.98;
            
            audio.onended = () => {
                URL.revokeObjectURL(audioUrl);
                this.isAudioPlaying = false;
                // Check if there are more chunks, if not, AI stops speaking
                if (this.audioQueue.length === 0) {
                    this.isAiSpeaking = false;
                }
                // Reduce gap between chunks
                setTimeout(() => this.playNextAudioChunk(), 25);
            };
            
            audio.onerror = (error) => {
                console.error('Audio chunk playback error:', error);
                URL.revokeObjectURL(audioUrl);
                this.isAudioPlaying = false;
                this.isAiSpeaking = false; // Stop AI speaking on error
                this.playNextAudioChunk();
            };
            
            await audio.play();
            
        } catch (error) {
            console.error('Traditional audio playback error:', error);
            this.isAudioPlaying = false;
            this.playNextAudioChunk();
        }
    }
    
    playAudio(base64Data, sampleRate) {
        try {
            this.lastAudioStartTime = Date.now(); // Track audio start time for feedback protection
            const audio = new Audio();
            const audioBlob = this.pcm16ToWavBlob(base64Data, sampleRate);
            const audioUrl = URL.createObjectURL(audioBlob);
            audio.src = audioUrl;
            audio.preload = 'auto';
            
            // Slightly slower playback for more natural speech
            audio.playbackRate = 0.98;
            
            audio.onended = () => {
                URL.revokeObjectURL(audioUrl);
            };
            
            audio.onerror = (error) => {
                console.error('Audio playback error:', error);
                URL.revokeObjectURL(audioUrl);
            };
            
            const playPromise = audio.play();
            if (playPromise !== undefined) {
                playPromise.catch(error => {
                    console.error('Audio play() failed - might need user interaction:', error);
                    URL.revokeObjectURL(audioUrl);
                });
            }
        } catch (error) {
            console.error('Error playing audio:', error);
        }
    }

    stopAudioPlayback() {
        console.log('🛑 IMMEDIATE STOP: Halting all audio playback');
        
        // 1. IMMEDIATE STATE RESET - Do this first for fastest response
        this.audioQueue = [];
        this.isAudioPlaying = false;
        this.isAiSpeaking = false;
        
        // 2. STOP WEB AUDIO API SOURCES - Most critical for immediate stopping
        if (this.webAudioContext && this.scheduledBuffers.length > 0) {
            this.scheduledBuffers.forEach(source => {
                try {
                    // Stop immediately with no fade out
                    source.stop(0);
                } catch (e) {
                    // Source may have already stopped, ignore error
                }
            });
            this.scheduledBuffers = [];
            console.log('⚡ Web Audio sources stopped immediately');
        }
        
        // 3. STOP ALL HTML AUDIO ELEMENTS - Fallback audio
        const audioElements = document.querySelectorAll('audio');
        audioElements.forEach(audio => {
            try {
                audio.pause();
                audio.currentTime = 0;
                audio.volume = 0; // Mute immediately for instant silence
            } catch (e) {
                // Ignore errors
            }
        });
        
        // 4. CLEAR CURRENT AUDIO TIME SCHEDULING
        if (this.webAudioContext) {
            this.currentAudioTime = this.webAudioContext.currentTime;
        }
        
        console.log('✅ All audio playback stopped immediately');
    }

    clearAllAudioBuffers() {
        console.log('🧹 DEEP CLEAN: Clearing all audio buffers and state');
        
        // First, stop any current playback
        this.stopAudioPlayback();
        
        // Clear all audio queues and buffers more thoroughly
        this.audioQueue = [];
        this.isAudioPlaying = false;
        this.isAiSpeaking = false;
        this.currentAiResponseDiv = null;
        
        // Clear Web Audio scheduling completely
        if (this.webAudioContext) {
            this.scheduledBuffers = [];
            this.currentAudioTime = this.webAudioContext.currentTime;
        }
        
        // Remove any orphaned audio elements from the DOM
        const audioElements = document.querySelectorAll('audio');
        audioElements.forEach(audio => {
            try {
                audio.pause();
                audio.currentTime = 0;
                audio.volume = 0;
                audio.src = '';
                audio.load(); // Force reload to clear buffer
            } catch (e) {
                // Ignore errors
            }
        });
        
        // Clear any pending timeouts or intervals related to audio
        // (This would be useful if we had any setTimeout/setInterval for audio)
        
        console.log('✅ Deep audio buffer cleaning completed');
    }

    updateVadStatus(speechDetected, timestamp) {
        const vadIndicator = document.getElementById('vadIndicator');
        const vadStatus = document.getElementById('vadText');
        
        if (vadIndicator && vadStatus) {
            if (speechDetected !== this.lastVadState) {
                console.log(`VAD: ${speechDetected ? 'Speech detected' : 'Silence detected'} at ${timestamp}`);
                this.lastVadState = speechDetected;
            }
            
            if (speechDetected) {
                vadIndicator.className = 'w-3 h-3 bg-green-500 rounded-full';
                vadStatus.textContent = 'Speaking';
            } else {
                vadIndicator.className = 'w-3 h-3 bg-gray-400 rounded-full';
                vadStatus.textContent = 'Listening';
            }
        }
    }

    showPartialTranscription(text) {
        let partialDiv = document.getElementById('partialTranscription');
        if (!partialDiv) {
            const conversationArea = document.getElementById('conversationArea');
            partialDiv = document.createElement('div');
            partialDiv.id = 'partialTranscription';
            partialDiv.className = 'bg-blue-50 border-l-4 border-blue-400 p-4 mb-4 rounded opacity-70';
            partialDiv.innerHTML = `
                <div class="flex">
                    <div class="text-sm font-semibold text-blue-800 mr-2">You (typing...):</div>
                    <div class="text-sm text-blue-700">${text}</div>
                </div>
            `;
            conversationArea.appendChild(partialDiv);
            conversationArea.scrollTop = conversationArea.scrollHeight;
        } else {
            const textContent = partialDiv.querySelector('.text-blue-700');
            if (textContent) {
                textContent.textContent = text;
            }
        }
    }

    addMessage(sender, text, type) {
        const conversationArea = document.getElementById('conversationArea');
        
        // Remove partial transcription when adding a final message
        const partialDiv = document.getElementById('partialTranscription');
        if (partialDiv) {
            partialDiv.remove();
        }
        
        const messageDiv = document.createElement('div');
        messageDiv.className = 'mb-4 p-4 rounded-lg';
        
        if (type === 'user') {
            messageDiv.className += ' bg-blue-100 ml-8';
        } else if (type === 'agent') {
            messageDiv.className += ' bg-gray-100 mr-8';
        } else {
            messageDiv.className += ' bg-yellow-100';
        }
        
        messageDiv.innerHTML = `
            <div class="flex justify-between items-start">
                <div class="flex-1">
                    <div class="font-semibold text-gray-900 mb-1">${sender}</div>
                    <div class="text-gray-800">${text}</div>
                </div>
                <div class="text-xs text-gray-500 ml-2">
                    ${new Date().toLocaleTimeString()}
                </div>
            </div>
        `;
        
        conversationArea.appendChild(messageDiv);
        conversationArea.scrollTop = conversationArea.scrollHeight;
        
        return messageDiv;
    }

    showEndCallModal() {
        document.getElementById('endCallModal').classList.remove('hidden');
    }

    hideEndCallModal() {
        document.getElementById('endCallModal').classList.add('hidden');
    }

    async endCall() {
        this.hideEndCallModal();
        
        const customerIndex = document.getElementById('customerIndex').value;
        const callFeedback = document.getElementById('callFeedback').value;
        
        if (!customerIndex) {
            this.showError('Customer Index Number is required');
            return;
        }
        
        try {
            const response = await fetch(`${this.config.apiUrl}/call-summary`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`,
                    'ngrok-skip-browser-warning': 'true'
                },
                body: JSON.stringify({
                    session_id: this.sessionId,
                    customer_index: parseInt(customerIndex), // Now using 1-based index directly 
                    agent_feedback: callFeedback || ''
                })
            });
            
            if (response.ok) {
                const data = await response.json();
                console.log('Call ended successfully:', data);
                this.stopCall();
            } else {
                this.showError('Failed to end call properly');
            }
        } catch (error) {
            console.error('Error ending call:', error);
            this.showError('Error ending call');
        }
    }

    logout() {
        this.intentionalDisconnect = true;
        
        if (this.socket) {
            this.socket.close();
        }
        
        this.stopCall();
        
        this.token = null;
        this.sessionId = null;
        this.currentUser = null;
        this.isLoggedIn = false;
        
        const conversationArea = document.getElementById('conversationArea');
        if (conversationArea) {
            conversationArea.innerHTML = '';
        }
        
        this.resetSessionInfoDisplay();
        this.showLogin();
    }

    showError(message) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'fixed top-4 right-4 bg-red-500 text-white p-4 rounded shadow-lg z-50';
        errorDiv.textContent = message;
        
        document.body.appendChild(errorDiv);
        
        setTimeout(() => {
            errorDiv.remove();
        }, 5000);
    }

    updateConnectionStatus(connected) {
        const statusElement = document.getElementById('connectionStatus');
        const statusIndicator = statusElement ? statusElement.querySelector('div') : null;
        const statusText = statusElement ? statusElement.querySelector('span') : null;
        
        if (statusIndicator && statusText) {
            if (connected) {
                statusIndicator.className = 'w-3 h-3 bg-green-500 rounded-full';
                statusText.textContent = 'Connected';
            } else {
                statusIndicator.className = 'w-3 h-3 bg-red-500 rounded-full';
                statusText.textContent = 'Disconnected';
            }
        }
    }

    updateMicButton() {
        const micBtn = document.getElementById('micBtn');
        const micBtnText = micBtn ? micBtn.querySelector('span') : null;
        
        if (micBtn && micBtnText) {
            if (this.isCallActive) {
                micBtn.className = 'px-6 py-3 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center transition-colors text-white font-medium space-x-2';
                micBtnText.textContent = 'End Call';
            } else {
                micBtn.className = 'px-6 py-3 rounded-full bg-green-500 hover:bg-green-600 flex items-center justify-center transition-colors text-white font-medium space-x-2';
                micBtnText.textContent = 'Start Call';
            }
        }
    }

    updateSessionInfo(sessionData) {
        if (sessionData.customer_index !== undefined) {
            this.currentCustomerIndex = sessionData.customer_index;
            
            const customerInfoDiv = document.getElementById('currentCustomerInfo');
            if (customerInfoDiv) {
                customerInfoDiv.innerHTML = `
                    <div class="text-sm text-gray-600">Current Customer:</div>
                    <div class="font-semibold">Customer #${sessionData.customer_index}</div>
                `;
            }
        }
        
        if (sessionData.customers_completed !== undefined) {
            const completedDiv = document.getElementById('customersCompleted');
            if (completedDiv) {
                completedDiv.innerHTML = `
                    <div class="text-sm text-gray-600">Completed:</div>
                    <div class="font-semibold">${sessionData.customers_completed}</div>
                `;
            }
        }
        
        // Update lead information in the existing UI
        if (sessionData.checklist) {
            const nameStatus = document.getElementById('nameStatus');
            const emailStatus = document.getElementById('emailStatus');
            const interestStatus = document.getElementById('interestStatus');
            
            if (nameStatus) {
                nameStatus.textContent = sessionData.checklist.name_collected ? 'Name: Collected ✓' : 'Name: Not collected';
                nameStatus.className = sessionData.checklist.name_collected 
                    ? 'text-green-400' 
                    : 'text-white text-opacity-80';
            }
            
            if (emailStatus) {
                emailStatus.textContent = sessionData.checklist.email_collected ? 'Email: Collected ✓' : 'Email: Not collected';
                emailStatus.className = sessionData.checklist.email_collected 
                    ? 'text-green-400' 
                    : 'text-white text-opacity-80';
            }
            
            if (interestStatus) {
                interestStatus.textContent = sessionData.lead_interested ? 'Interest: Detected ✓' : 'Interest: Not detected';
                interestStatus.className = sessionData.lead_interested 
                    ? 'text-green-400' 
                    : 'text-white text-opacity-80';
            }
        }
    }

    resetSessionInfoDisplay() {
        const customerInfoDiv = document.getElementById('currentCustomerInfo');
        const completedDiv = document.getElementById('customersCompleted');
        const nameStatus = document.getElementById('nameStatus');
        const emailStatus = document.getElementById('emailStatus');
        const interestStatus = document.getElementById('interestStatus');
        
        if (customerInfoDiv) {
            customerInfoDiv.innerHTML = `
                <div class="text-sm text-gray-600">Current Customer:</div>
                <div class="font-semibold">None</div>
            `;
        }
        
        if (completedDiv) {
            completedDiv.innerHTML = `
                <div class="text-sm text-gray-600">Completed:</div>
                <div class="font-semibold">0</div>
            `;
        }
        
        // Reset lead information
        if (nameStatus) {
            nameStatus.textContent = 'Name: Not collected';
            nameStatus.className = 'text-white text-opacity-80';
        }
        
        if (emailStatus) {
            emailStatus.textContent = 'Email: Not collected';
            emailStatus.className = 'text-white text-opacity-80';
        }
        
        if (interestStatus) {
            interestStatus.textContent = 'Interest: Not detected';
            interestStatus.className = 'text-white text-opacity-80';
        }
    }

    pcm16ToWavBlob(base64Data, sampleRate = 22050) {
        const binaryString = atob(base64Data);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        
        const dataView = new DataView(bytes.buffer);
        const numSamples = bytes.length / 2;
        const numChannels = 1;
        const bytesPerSample = 2;
        
        const buffer = new ArrayBuffer(44 + bytes.length);
        const view = new DataView(buffer);
        
        const writeString = (offset, string) => {
            for (let i = 0; i < string.length; i++) {
                view.setUint8(offset + i, string.charCodeAt(i));
            }
        };
        
        writeString(0, 'RIFF');
        view.setUint32(4, 36 + bytes.length, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
        view.setUint16(32, numChannels * bytesPerSample, true);
        view.setUint16(34, 8 * bytesPerSample, true);
        writeString(36, 'data');
        view.setUint32(40, bytes.length, true);
        
        for (let i = 0; i < bytes.length; i++) {
            view.setUint8(44 + i, bytes[i]);
        }
        
        return new Blob([buffer], { type: 'audio/wav' });
    }

    arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        
        return btoa(binary);
    }

    // VAD Configuration and Utilities
    updateVADConfig(config) {
        if (this.clientVAD && this.vadEnabled) {
            this.clientVAD.updateConfig(config);
            console.log('🔧 Client VAD config updated:', config);
        }
        
        // Also update worklet VAD config
        if (this.workletNode) {
            this.workletNode.port.postMessage({
                type: 'vadConfig',
                data: config
            });
        }
    }

    getVADStatus() {
        if (this.vadEnabled && this.clientVAD) {
            return {
                enabled: true,
                type: 'client-side',
                isSpeaking: this.clientVAD.isSpeaking,
                speechProb: this.clientVAD.currentSpeechProb,
                timeSinceLastSpeech: this.clientVAD.getTimeSinceLastSpeech()
            };
        } else {
            return {
                enabled: false,
                type: 'server-side-fallback',
                isSpeaking: false,
                speechProb: 0,
                timeSinceLastSpeech: 0
            };
        }
    }
}

// Initialize the app when the page loads
document.addEventListener('DOMContentLoaded', () => {
    const app = new SalesAgentApp();
    app.init();
});