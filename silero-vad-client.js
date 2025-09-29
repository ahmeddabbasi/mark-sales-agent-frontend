/**
 * Silero VAD Client Implementation
 * Uses Silero VAD model for accurate and fast voice activity detection
 * Much simpler than ONNX with better browser compatibility
 */

class SileroVADClient {
    constructor(options = {}) {
        // Configuration options
        this.options = {
            modelURL: options.modelURL || 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.7/dist/silero_vad.onnx',
            threshold: options.threshold || 0.5,
            minSpeechDurationMs: options.minSpeechDurationMs || 250,
            minSilenceDurationMs: options.minSilenceDurationMs || 200,
            sampleRate: options.sampleRate || 16000,
            frameSamples: options.frameSamples || 1536, // Silero VAD uses 1536 samples per frame
            ...options
        };

        // VAD state
        this.isInitialized = false;
        this.model = null;
        this.h = null; // Hidden state for RNN
        this.c = null; // Cell state for RNN
        this.speechProb = 0;
        this.isSpeaking = false;
        this.speechStartTime = 0;
        this.silenceStartTime = 0;
        this.lastStateChange = 0;

        // Audio buffer for frame processing
        this.audioBuffer = [];

        // Callbacks
        this.callbacks = {
            onSpeechStart: null,
            onSpeechEnd: null,
            onVADUpdate: null
        };

        console.log('🎯 Silero VAD Client created with options:', this.options);
    }

    async initialize() {
        try {
            console.log('🤖 Initializing Silero VAD...');

            // Check if ONNX Runtime is available
            if (typeof ort === 'undefined') {
                throw new Error('ONNX Runtime not loaded. Please include onnxruntime-web.');
            }

            // Load the Silero VAD model
            console.log('📥 Loading Silero VAD model from CDN...');
            this.model = await ort.InferenceSession.create(this.options.modelURL, {
                executionProviders: ['wasm'],
                graphOptimizationLevel: 'all'
            });

            console.log('✅ Silero VAD model loaded successfully');
            console.log('📊 Model inputs:', this.model.inputNames);
            console.log('📊 Model outputs:', this.model.outputNames);

            // Initialize RNN states
            this.resetStates();

            // Test the model
            await this.testModel();

            this.isInitialized = true;
            console.log('🎉 Silero VAD initialized successfully');

        } catch (error) {
            console.error('❌ Failed to initialize Silero VAD:', error);
            this.isInitialized = false;
            throw error;
        }
    }

    /**
     * Reset RNN states
     */
    resetStates() {
        // Silero VAD uses LSTM with hidden and cell states of shape [2, 1, 64]
        this.h = new Float32Array(2 * 1 * 64).fill(0);
        this.c = new Float32Array(2 * 1 * 64).fill(0);
        console.log('🔄 Reset Silero VAD RNN states');
    }

    /**
     * Test the model with sample data
     */
    async testModel() {
        try {
            console.log('🧪 Testing Silero VAD model...');

            // Create test input (1536 samples of silence)
            const testAudio = new Float32Array(this.options.frameSamples).fill(0);
            const testSr = typeof BigInt64Array !== 'undefined' 
                ? new BigInt64Array([BigInt(this.options.sampleRate)])
                : new Int32Array([this.options.sampleRate]);

            const inputs = {
                input: new ort.Tensor('float32', testAudio, [1, this.options.frameSamples]),
                h: new ort.Tensor('float32', this.h, [2, 1, 64]),
                c: new ort.Tensor('float32', this.c, [2, 1, 64]),
                sr: new ort.Tensor(typeof BigInt64Array !== 'undefined' ? 'int64' : 'int32', testSr, [])
            };

            const results = await this.model.run(inputs);

            console.log('✅ Silero VAD model test successful');
            console.log('📊 Output keys:', Object.keys(results));
            console.log('📊 Speech probability:', results.output.data[0]);

            return true;
        } catch (error) {
            console.error('❌ Silero VAD model test failed:', error);
            throw error;
        }
    }

    /**
     * Process audio chunk for VAD
     */
    async processAudio(audioChunk) {
        if (!this.isInitialized) {
            console.warn('⚠️ Silero VAD not initialized');
            return { speechProb: 0, isSpeaking: false };
        }

        try {
            // Add audio to buffer
            this.audioBuffer.push(...audioChunk);

            // Process complete frames
            let lastResult = { speechProb: this.speechProb, isSpeaking: this.isSpeaking };

            while (this.audioBuffer.length >= this.options.frameSamples) {
                // Extract one frame
                const frame = this.audioBuffer.splice(0, this.options.frameSamples);
                const audioFrame = new Float32Array(frame);

                // Run VAD on this frame
                const result = await this.processFrame(audioFrame);
                lastResult = result;
            }

            return lastResult;

        } catch (error) {
            console.error('❌ Error processing audio with Silero VAD:', error);

            // Fallback to simple energy-based VAD
            return this.energyBasedVAD(audioChunk);
        }
    }

    /**
     * Process a single frame with Silero VAD
     */
    async processFrame(audioFrame) {
        try {
            // Prepare inputs
            const sr = typeof BigInt64Array !== 'undefined' 
                ? new BigInt64Array([BigInt(this.options.sampleRate)])
                : new Int32Array([this.options.sampleRate]);

            const inputs = {
                input: new ort.Tensor('float32', audioFrame, [1, this.options.frameSamples]),
                h: new ort.Tensor('float32', this.h, [2, 1, 64]),
                c: new ort.Tensor('float32', this.c, [2, 1, 64]),
                sr: new ort.Tensor(typeof BigInt64Array !== 'undefined' ? 'int64' : 'int32', sr, [])
            };

            // Run inference
            const results = await this.model.run(inputs);

            // Extract results
            const speechProb = results.output.data[0];
            
            // Update RNN states for next frame
            this.h = new Float32Array(results.hn.data);
            this.c = new Float32Array(results.cn.data);

            // Update VAD state
            return this.updateVADState(speechProb);

        } catch (error) {
            console.error('❌ Frame processing error:', error);
            return { speechProb: this.speechProb, isSpeaking: this.isSpeaking };
        }
    }

    /**
     * Simple energy-based VAD fallback
     */
    energyBasedVAD(audioChunk) {
        let energy = 0;
        for (let i = 0; i < audioChunk.length; i++) {
            energy += audioChunk[i] * audioChunk[i];
        }
        energy = Math.sqrt(energy / audioChunk.length);

        // Convert energy to probability (simple heuristic)
        const speechProb = Math.min(1, Math.max(0, (energy - 0.01) * 10));
        const isSpeaking = speechProb > this.options.threshold;

        console.log(`🔄 Fallback VAD: energy=${energy.toFixed(4)}, prob=${speechProb.toFixed(3)}`);
        return { speechProb: speechProb, isSpeaking: isSpeaking };
    }

    /**
     * Update VAD state with temporal logic
     */
    updateVADState(speechProb) {
        const currentTime = Date.now();
        const wasSpeaking = this.isSpeaking;
        
        this.speechProb = speechProb;

        // Determine if currently speaking based on threshold
        const currentlySpeaking = speechProb > this.options.threshold;

        if (!wasSpeaking && currentlySpeaking) {
            // Potential speech start
            if (this.speechStartTime === 0) {
                this.speechStartTime = currentTime;
            } else if (currentTime - this.speechStartTime >= this.options.minSpeechDurationMs) {
                // Confirmed speech start
                this.isSpeaking = true;
                this.silenceStartTime = 0;
                this.lastStateChange = currentTime;
                
                if (this.callbacks.onSpeechStart) {
                    this.callbacks.onSpeechStart(speechProb);
                }
            }
        } else if (wasSpeaking && !currentlySpeaking) {
            // Potential speech end
            if (this.silenceStartTime === 0) {
                this.silenceStartTime = currentTime;
            } else if (currentTime - this.silenceStartTime >= this.options.minSilenceDurationMs) {
                // Confirmed speech end
                this.isSpeaking = false;
                this.speechStartTime = 0;
                this.lastStateChange = currentTime;
                
                if (this.callbacks.onSpeechEnd) {
                    this.callbacks.onSpeechEnd(speechProb);
                }
            }
        } else if (currentlySpeaking) {
            // Continue speaking
            this.silenceStartTime = 0;
        } else {
            // Continue silence
            this.speechStartTime = 0;
        }

        // Call update callback
        if (this.callbacks.onVADUpdate) {
            this.callbacks.onVADUpdate(speechProb, this.isSpeaking);
        }

        return {
            speechProb: this.speechProb,
            isSpeaking: this.isSpeaking,
            stateChanged: wasSpeaking !== this.isSpeaking
        };
    }

    /**
     * Set callback functions
     */
    setCallbacks(callbacks) {
        this.callbacks = { ...this.callbacks, ...callbacks };
    }

    /**
     * Update VAD configuration (required by app.js)
     */
    updateConfig(config) {
        if (config.threshold !== undefined) {
            this.options.threshold = config.threshold;
        }
        if (config.minSpeechDurationMs !== undefined) {
            this.options.minSpeechDurationMs = config.minSpeechDurationMs;
        }
        if (config.minSilenceDurationMs !== undefined) {
            this.options.minSilenceDurationMs = config.minSilenceDurationMs;
        }
        console.log('🔧 Silero VAD config updated:', config);
    }

    /**
     * Get current speech probability (property getter for compatibility)
     */
    get currentSpeechProb() {
        return this.speechProb;
    }

    /**
     * Get time since last speech (required by app.js)
     */
    getTimeSinceLastSpeech() {
        if (this.lastStateChange === 0) return 0;
        return Date.now() - this.lastStateChange;
    }

    /**
     * Reset VAD state (required by app.js)
     */
    reset(force = false) {
        this.audioBuffer = [];
        this.speechProb = 0;
        this.isSpeaking = false;
        this.speechStartTime = 0;
        this.silenceStartTime = 0;
        this.lastStateChange = 0;
        
        if (force) {
            this.resetStates();
            console.log('🔄 Silero VAD full reset (including RNN states)');
        } else {
            console.log('🔄 Silero VAD soft reset (keeping RNN states)');
        }
    }

    /**
     * Clean up resources
     */
    destroy() {
        if (this.model) {
            this.model.release();
            this.model = null;
        }
        this.isInitialized = false;
        this.reset();
        console.log('🗑️ Silero VAD destroyed');
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SileroVADClient;
} else {
    window.SileroVADClient = SileroVADClient;
}