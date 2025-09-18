// Real-Time Audio Worklet Processor with Client-Side VAD
// Downsamples browser audio to 16kHz PCM16 with minimal latency
// Includes immediate VAD processing for zero-latency barge-in

class DownsampleTo16kPCM16Processor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._inputSampleRate = sampleRate; // Browser sample rate (44.1kHz or 48kHz)
        this._outputSampleRate = 16000;
        this._buffer = [];
        this._chunkSize = 1280; // 80ms at 16kHz for real-time feel
        this._processedSamples = 0;
        
        // VAD processing buffer (for parallel VAD analysis)
        this._vadBuffer = [];
        this._vadWindowSize = 1024; // 64ms at 16kHz for VAD
        this._lastVadResult = { speechProb: 0, isSpeaking: false };
        
        // Energy-based VAD parameters (lightweight fallback)
        this._energyThreshold = 0.01;
        this._speechFrames = 0;
        this._silenceFrames = 0;
        this._minSpeechFrames = 4;  // ~250ms of speech
        this._minSilenceFrames = 2; // ~125ms of silence
        this._currentIsSpeaking = false;
        
        console.log('🎤 Audio Worklet with VAD initialized');
        
        // Listen for VAD configuration updates
        this.port.onmessage = (event) => {
            const { type, data } = event.data;
            
            if (type === 'vadConfig') {
                this._energyThreshold = data.threshold || this._energyThreshold;
                this._minSpeechFrames = Math.floor((data.minSpeechDurationMs || 250) / 64);
                this._minSilenceFrames = Math.floor((data.minSilenceDurationMs || 125) / 64);
                console.log('🔧 VAD config updated in worklet:', data);
            }
        };
    }

    // Optimized downsampling for real-time performance
    _downsampleBuffer(buffer, inSampleRate, outSampleRate) {
        if (inSampleRate === outSampleRate) return buffer;
        
        const ratio = inSampleRate / outSampleRate;
        const newLength = Math.floor(buffer.length / ratio);
        const result = new Float32Array(newLength);

        // Linear interpolation for better quality at real-time speeds
        for (let i = 0; i < newLength; i++) {
            const srcIndex = i * ratio;
            const srcIndexFloor = Math.floor(srcIndex);
            const srcIndexCeil = Math.min(srcIndexFloor + 1, buffer.length - 1);
            const fraction = srcIndex - srcIndexFloor;
            
            // Linear interpolation between samples
            result[i] = buffer[srcIndexFloor] * (1 - fraction) + buffer[srcIndexCeil] * fraction;
        }
        return result;
    }
    
    // Lightweight energy-based VAD for immediate processing
    _processVAD(audioChunk) {
        try {
            // Calculate RMS energy
            let energy = 0;
            for (let i = 0; i < audioChunk.length; i++) {
                energy += audioChunk[i] * audioChunk[i];
            }
            energy = Math.sqrt(energy / audioChunk.length);
            
            // Determine if this frame contains speech
            const isSpeechFrame = energy > this._energyThreshold;
            const speechProb = isSpeechFrame ? Math.min(energy * 10, 1.0) : energy * 5;
            
            // Update frame counters
            if (isSpeechFrame) {
                this._speechFrames++;
                this._silenceFrames = 0;
            } else {
                this._speechFrames = 0;
                this._silenceFrames++;
            }
            
            // Apply temporal logic
            let isSpeaking = this._currentIsSpeaking;
            
            // Start speaking: need minimum consecutive speech frames
            if (!isSpeaking && this._speechFrames >= this._minSpeechFrames) {
                isSpeaking = true;
                console.log('🗣️ VAD: Speech started');
            }
            
            // Stop speaking: need minimum consecutive silence frames  
            if (isSpeaking && this._silenceFrames >= this._minSilenceFrames) {
                isSpeaking = false;
                console.log('🤐 VAD: Speech ended');
            }
            
            // Update state
            const stateChanged = isSpeaking !== this._currentIsSpeaking;
            this._currentIsSpeaking = isSpeaking;
            
            const vadResult = {
                speechProb: speechProb,
                isSpeaking: isSpeaking,
                energy: energy,
                stateChanged: stateChanged,
                timestamp: currentTime
            };
            
            this._lastVadResult = vadResult;
            
            // Send VAD result to main thread immediately if state changed or periodically
            if (stateChanged || this._processedSamples % (this._chunkSize * 2) === 0) {
                this.port.postMessage({
                    type: 'vadResult',
                    data: vadResult
                });
            }
            
            return vadResult;
            
        } catch (error) {
            console.error('❌ VAD processing error:', error);
            return this._lastVadResult;
        }
    }

    process(inputs) {
        const input = inputs[0];
        if (input.length === 0) return true;

        // Always use mono channel for consistency
        const inputChannel = input[0];
        if (!inputChannel) return true;

        // Buffer audio samples for processing
        this._buffer.push(...inputChannel);
        this._vadBuffer.push(...inputChannel);

        // Process VAD on smaller windows for responsiveness
        while (this._vadBuffer.length >= this._vadWindowSize) {
            const vadChunk = this._vadBuffer.slice(0, this._vadWindowSize);
            this._vadBuffer = this._vadBuffer.slice(this._vadWindowSize);
            
            // Downsample VAD chunk for processing
            const vadDownsampled = this._downsampleBuffer(
                new Float32Array(vadChunk), 
                this._inputSampleRate, 
                this._outputSampleRate
            );
            
            // Process VAD immediately
            this._processVAD(vadDownsampled);
        }

        // Process in optimal chunks for real-time streaming (80ms)
        // This balances latency vs. processing efficiency
        const requiredInputLength = Math.floor(this._chunkSize * (this._inputSampleRate / this._outputSampleRate));

        while (this._buffer.length >= requiredInputLength) {
            const chunk = this._buffer.slice(0, requiredInputLength);
            this._buffer = this._buffer.slice(requiredInputLength);

            // Downsample to 16kHz with interpolation
            const downsampled = this._downsampleBuffer(new Float32Array(chunk), this._inputSampleRate, this._outputSampleRate);

            // Convert Float32 [-1,1] to PCM16 with proper scaling
            const pcm16 = new Int16Array(downsampled.length);
            for (let i = 0; i < downsampled.length; i++) {
                // Clamp and scale to 16-bit range
                let sample = Math.max(-1, Math.min(1, downsampled[i]));
                pcm16[i] = sample < 0 ? sample * 32768 : sample * 32767;
            }

            // Send buffer to main thread immediately for real-time streaming
            this.port.postMessage({
                type: 'audioData',
                data: pcm16.buffer
            }, [pcm16.buffer]);
            
            this._processedSamples += pcm16.length;
        }
        return true;
    }
}

registerProcessor('audio-worklet-processor', DownsampleTo16kPCM16Processor);