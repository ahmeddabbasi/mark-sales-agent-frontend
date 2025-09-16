class AudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._inputSampleRate = sampleRate;
        this._outputSampleRate = 48000;
        this._buffer = [];
        this._chunkSize = 4800; // 100ms at 48kHz (well above 50ms minimum for AssemblyAI)
        this._processedSamples = 0;
        this._vadBuffer = [];
        this._vadWindowSize = 3072; // 64ms at 48kHz for VAD
        this._lastVadResult = { speechProb: 0, isSpeaking: false };
        this._energyThreshold = 0.01;
        this._speechFrames = 0;
        this._silenceFrames = 0;
        this._minSpeechFrames = 4;
        this._minSilenceFrames = 2;
        this._currentIsSpeaking = false;
        
        console.log('🎤 Audio Worklet initialized');
        
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

    _processVAD(audioChunk) {
        try {
            let energy = 0;
            for (let i = 0; i < audioChunk.length; i++) {
                energy += audioChunk[i] * audioChunk[i];
            }
            energy = Math.sqrt(energy / audioChunk.length);
            const isSpeechFrame = energy > this._energyThreshold;
            const speechProb = isSpeechFrame ? Math.min(energy * 10, 1.0) : energy * 5;
            
            if (isSpeechFrame) {
                this._speechFrames++;
                this._silenceFrames = 0;
            } else {
                this._speechFrames = 0;
                this._silenceFrames++;
            }
            
            let isSpeaking = this._currentIsSpeaking;
            if (!isSpeaking && this._speechFrames >= this._minSpeechFrames) {
                isSpeaking = true;
                console.log('🗣️ VAD: Speech started');
            }
            if (isSpeaking && this._silenceFrames >= this._minSilenceFrames) {
                isSpeaking = false;
                console.log('🤐 VAD: Speech ended');
            }
            
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
        const inputChannel = input[0];
        if (!inputChannel) return true;

        this._buffer.push(...inputChannel);
        this._vadBuffer.push(...inputChannel);

        while (this._vadBuffer.length >= this._vadWindowSize) {
            const vadChunk = this._vadBuffer.slice(0, this._vadWindowSize);
            this._vadBuffer = this._vadBuffer.slice(this._vadWindowSize);
            this._processVAD(new Float32Array(vadChunk));
        }

        const requiredInputLength = this._chunkSize;

        while (this._buffer.length >= requiredInputLength) {
            const chunk = this._buffer.slice(0, requiredInputLength);
            this._buffer = this._buffer.slice(requiredInputLength);
            
            // Convert Float32 [-1,1] to PCM16 with proper scaling
            const pcm16 = new Int16Array(chunk.length);
            for (let i = 0; i < chunk.length; i++) {
                let sample = Math.max(-1, Math.min(1, chunk[i]));
                pcm16[i] = sample < 0 ? sample * 32768 : sample * 32767;
            }

            this.port.postMessage({
                type: 'audioData',
                data: pcm16.buffer
            }, [pcm16.buffer]);
            
            this._processedSamples += pcm16.length;
        }
        return true;
    }
}

registerProcessor('audio-worklet-processor', AudioProcessor);