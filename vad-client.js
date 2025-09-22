/**
 * Client-Side Voice Activity Detection using Silero VAD
 * Provides real-time, low-latency speech detection in the browser
 */

class ClientVAD {
    constructor(options = {}) {
        this.modelUrl = options.modelUrl || 'https://github.com/snakers4/silero-vad/releases/download/v3.1/silero_vad.onnx';
        this.threshold = options.threshold || 0.5;
        this.minSpeechDurationMs = options.minSpeechDurationMs || 250;
        this.minSilenceDurationMs = options.minSilenceDurationMs || 100;
        this.speechPadMs = options.speechPadMs || 30;
        
        this.session = null;
        this.h = null;
        this.c = null;
        this.isLoaded = false;
        this.isInitialized = false;
        
        // Audio processing parameters
        this.sampleRate = 16000;
        this.windowSizeMs = 64; // 64ms window
        this.windowSizeSamples = Math.floor(this.sampleRate * this.windowSizeMs / 1000);
        
        // State tracking
        this.speechFrames = 0;
        this.silenceFrames = 0;
        this.currentSpeechProb = 0;
        this.isSpeaking = false;
        this.lastSpeechTime = 0;
        
        // Callbacks
        this.onSpeechStart = null;
        this.onSpeechEnd = null;
        this.onVADUpdate = null;
        
        // Audio buffer for windowing
        this.audioBuffer = new Float32Array(0);
        
        console.log('🎤 ClientVAD initialized with parameters:', {
            threshold: this.threshold,
            windowSizeMs: this.windowSizeMs,
            minSpeechDurationMs: this.minSpeechDurationMs,
            minSilenceDurationMs: this.minSilenceDurationMs
        });
    }
    
    async initialize() {
        if (this.isInitialized) return;
        
        try {
            console.log('🚀 Initializing Silero ONNX VAD for zero-latency barge-in...');
            
            // Load ONNX Runtime from CDN
            await this.loadONNXRuntimeFromCDN();
            
            // Load Silero VAD model
            console.log('� Loading Silero VAD model...');
            this.session = await ort.InferenceSession.create(this.modelUrl, {
                executionProviders: ['wasm'],
                logSeverityLevel: 3  // Suppress logs
            });
            
            // Initialize LSTM states
            this.resetStates();
            
            this.isLoaded = true;
            this.isInitialized = true;
            
            console.log('✅ Silero ONNX VAD initialized successfully - zero-latency barge-in ready!');
            
        } catch (error) {
            console.error('❌ Failed to initialize Silero VAD:', error);
            
            // Fallback to energy-based VAD
            console.log('🔄 Falling back to energy-based VAD...');
            this.useEnergyVAD = true;
            this.isInitialized = true;
        }
    }
    
    async loadONNXRuntimeFromCDN() {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.0/dist/ort.min.js';
            script.onload = () => {
                console.log('📦 ONNX Runtime loaded from CDN');
                resolve();
            };
            script.onerror = () => {
                console.warn('⚠️ Failed to load ONNX Runtime from CDN');
                reject(new Error('Failed to load ONNX Runtime'));
            };
            document.head.appendChild(script);
        });
    }
    
    resetStates() {
        // Initialize LSTM hidden states for Silero VAD
        // Silero VAD expects h and c states of shape [2, 1, 64]
        const stateSize = [2, 1, 64];
        this.h = new ort.Tensor('float32', new Float32Array(2 * 1 * 64).fill(0), stateSize);
        this.c = new ort.Tensor('float32', new Float32Array(2 * 1 * 64).fill(0), stateSize);
    }
    
    /**
     * Process audio chunk and return VAD result
     * @param {Float32Array} audioChunk - Audio samples at 16kHz
     * @returns {Object} VAD result with speech probability and speaking state
     */
    async processAudio(audioChunk) {
        if (!this.isInitialized) {
            console.warn('⚠️ ClientVAD not initialized');
            return { speechProb: 0, isSpeaking: false };
        }
        
        // Use energy-based fallback if ONNX model failed to load
        if (this.useEnergyVAD) {
            return this.processEnergyVAD(audioChunk);
        }
        
        // Combine with existing buffer
        const combinedBuffer = new Float32Array(this.audioBuffer.length + audioChunk.length);
        combinedBuffer.set(this.audioBuffer);
        combinedBuffer.set(audioChunk, this.audioBuffer.length);
        this.audioBuffer = combinedBuffer;
        
        const results = [];
        
        // Process in windows of the required size
        while (this.audioBuffer.length >= this.windowSizeSamples) {
            const window = this.audioBuffer.slice(0, this.windowSizeSamples);
            this.audioBuffer = this.audioBuffer.slice(this.windowSizeSamples);
            
            try {
                const result = await this.processWindow(window);
                results.push(result);
            } catch (error) {
                console.error('❌ VAD processing error:', error);
                // Return safe fallback
                results.push({ speechProb: 0, isSpeaking: this.isSpeaking });
            }
        }
        
        // Return the last result or current state
        return results.length > 0 ? results[results.length - 1] : { speechProb: this.currentSpeechProb, isSpeaking: this.isSpeaking };
    }
    
    async processWindow(audioWindow) {
        try {
            // Prepare input tensor for Silero VAD
            // Silero expects input shape [1, windowSize]
            const inputTensor = new ort.Tensor('float32', audioWindow, [1, audioWindow.length]);
            
            // Run inference
            const feeds = {
                input: inputTensor,
                h: this.h,
                c: this.c
            };
            
            const results = await this.session.run(feeds);
            
            // Update LSTM states for next iteration
            this.h = results.hn;
            this.c = results.cn;
            
            // Get speech probability
            const speechProb = results.output.data[0];
            this.currentSpeechProb = speechProb;
            
            // Apply threshold and temporal smoothing
            const vadResult = this.applyTemporalLogic(speechProb);
            
            // Trigger callbacks if state changed
            if (vadResult.isSpeaking !== this.isSpeaking) {
                this.isSpeaking = vadResult.isSpeaking;
                
                if (this.isSpeaking) {
                    this.lastSpeechTime = Date.now();
                    if (this.onSpeechStart) {
                        this.onSpeechStart(speechProb);
                    }
                } else {
                    if (this.onSpeechEnd) {
                        this.onSpeechEnd(speechProb);
                    }
                }
            }
            
            // Trigger update callback
            if (this.onVADUpdate) {
                this.onVADUpdate(speechProb, this.isSpeaking);
            }
            
            return vadResult;
            
        } catch (error) {
            console.error('❌ Silero VAD inference error:', error);
            // Fallback to energy-based detection
            return this.processEnergyVAD(audioWindow);
        }
    }
    
    processEnergyVAD(audioChunk) {
        // Simple energy-based VAD as fallback
        let energy = 0;
        for (let i = 0; i < audioChunk.length; i++) {
            energy += audioChunk[i] * audioChunk[i];
        }
        energy = Math.sqrt(energy / audioChunk.length);
        
        // Use energy threshold (much lower than server-side threshold)
        const speechProb = energy > 0.01 ? 0.8 : 0.2;
        const vadResult = this.applyTemporalLogic(speechProb);
        
        this.currentSpeechProb = speechProb;
        
        // Trigger callbacks if state changed
        if (vadResult.isSpeaking !== this.isSpeaking) {
            this.isSpeaking = vadResult.isSpeaking;
            
            if (this.isSpeaking) {
                this.lastSpeechTime = Date.now();
                if (this.onSpeechStart) this.onSpeechStart(speechProb);
            } else {
                if (this.onSpeechEnd) this.onSpeechEnd(speechProb);
            }
        }
        
        if (this.onVADUpdate) {
            this.onVADUpdate(speechProb, this.isSpeaking);
        }
        
        return vadResult;
    }
    
    applyTemporalLogic(speechProb) {
        const currentTime = Date.now();
        const isSpeechFrame = speechProb > this.threshold;
        
        if (isSpeechFrame) {
            this.speechFrames++;
            this.silenceFrames = 0;
        } else {
            this.speechFrames = 0;
            this.silenceFrames++;
        }
        
        // Calculate required frames for duration thresholds
        const framesPerMs = 1000 / this.windowSizeMs;
        const minSpeechFrames = Math.floor(this.minSpeechDurationMs / this.windowSizeMs);
        const minSilenceFrames = Math.floor(this.minSilenceDurationMs / this.windowSizeMs);
        
        let isSpeaking = this.isSpeaking;
        
        // Start speaking: need minimum consecutive speech frames
        if (!isSpeaking && this.speechFrames >= minSpeechFrames) {
            isSpeaking = true;
        }
        
        // Stop speaking: need minimum consecutive silence frames
        if (isSpeaking && this.silenceFrames >= minSilenceFrames) {
            isSpeaking = false;
        }
        
        return {
            speechProb,
            isSpeaking,
            speechFrames: this.speechFrames,
            silenceFrames: this.silenceFrames
        };
    }
    
    /**
     * Get time since last speech detection
     */
    getTimeSinceLastSpeech() {
        return Date.now() - this.lastSpeechTime;
    }
    
    /**
     * Set callbacks for VAD events
     */
    setCallbacks({ onSpeechStart, onSpeechEnd, onVADUpdate }) {
        this.onSpeechStart = onSpeechStart;
        this.onSpeechEnd = onSpeechEnd;
        this.onVADUpdate = onVADUpdate;
    }
    
    /**
     * Update VAD configuration
     */
    updateConfig(config) {
        if (config.threshold !== undefined) this.threshold = config.threshold;
        if (config.minSpeechDurationMs !== undefined) this.minSpeechDurationMs = config.minSpeechDurationMs;
        if (config.minSilenceDurationMs !== undefined) this.minSilenceDurationMs = config.minSilenceDurationMs;
        
        console.log('🔧 VAD config updated:', {
            threshold: this.threshold,
            minSpeechDurationMs: this.minSpeechDurationMs,
            minSilenceDurationMs: this.minSilenceDurationMs
        });
    }
    
    /**
     * Reset VAD state
     */
    reset() {
        this.speechFrames = 0;
        this.silenceFrames = 0;
        this.currentSpeechProb = 0;
        this.isSpeaking = false;
        this.lastSpeechTime = 0;
        this.audioBuffer = new Float32Array(0);
        
        if (this.session) {
            this.resetStates();
        }
        
        console.log('🔄 VAD state reset');
    }
    
    /**
     * Cleanup resources
     */
    async dispose() {
        if (this.session) {
            await this.session.release();
            this.session = null;
        }
        this.isLoaded = false;
        this.isInitialized = false;
        console.log('🧹 ClientVAD disposed');
    }
}

// Export for use in modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ClientVAD;
}
