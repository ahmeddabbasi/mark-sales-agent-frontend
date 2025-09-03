// Configuration for API endpoints
class Config {
    constructor() {
        // Check if we're in development or production
        this.isDevelopment = window.location.hostname === 'localhost' || 
                            window.location.hostname === '127.0.0.1';
        
        // Default URLs
        if (this.isDevelopment) {
            this.apiUrl = 'http://localhost:8000';
            this.wsUrl = 'ws://localhost:8000';
        } else {
            // In production, we'll auto-detect the backend URL
            this.apiUrl = null;
            this.wsUrl = null;
        }
        
        this.isConfigured = this.isDevelopment; // Auto-configured in dev
        
        console.log('Config initialized:', {
            isDevelopment: this.isDevelopment,
            isConfigured: this.isConfigured
        });
    }
    
    async autoDetectBackendUrl() {
        if (this.isDevelopment) {
            return true; // Already configured for development
        }
        
        // Try to get backend URL from various sources
        const possibleUrls = [
            // Check if there's a saved URL from before
            localStorage.getItem('backend_url'),
            // Try common ngrok patterns
            this.tryNgrokUrls()
        ].filter(Boolean);
        
        for (const baseUrl of possibleUrls) {
            try {
                const response = await fetch(`${baseUrl}/config`, {
                    method: 'GET',
                    timeout: 5000
                });
                
                if (response.ok) {
                    const config = await response.json();
                    this.updateConfig(config.backend_url, config.websocket_url);
                    return true;
                }
            } catch (error) {
                console.log(`Failed to connect to ${baseUrl}:`, error);
            }
        }
        
        return false; // Auto-detection failed
    }
    
    tryNgrokUrls() {
        // This is a fallback - in real deployment, you'd set this properly
        const possibleNgrokUrls = [
            'https://1a3c0eb5d829.ngrok-free.app',
            // Add more if needed
        ];
        return possibleNgrokUrls;
    }
    
    updateConfig(apiUrl, wsUrl) {
        this.apiUrl = apiUrl;
        this.wsUrl = wsUrl || apiUrl.replace('http', 'ws');
        this.isConfigured = true;
        
        // Save for next time
        localStorage.setItem('backend_url', apiUrl);
        
        console.log('Config updated:', {
            apiUrl: this.apiUrl,
            wsUrl: this.wsUrl
        });
    }
    
    async ensureConfigured() {
        if (this.isConfigured) {
            return true;
        }
        
        const autoDetected = await this.autoDetectBackendUrl();
        if (!autoDetected) {
            // Fallback to user input
            const userUrl = prompt('Please enter your backend URL (e.g., https://abc123.ngrok-free.app):');
            if (userUrl) {
                try {
                    const response = await fetch(`${userUrl}/config`);
                    if (response.ok) {
                        const config = await response.json();
                        this.updateConfig(config.backend_url, config.websocket_url);
                        return true;
                    }
                } catch (error) {
                    console.error('Failed to validate user URL:', error);
                }
            }
            return false;
        }
        
        return true;
    }
    
    // Method to manually set URL (for admin panel)
    async setBackendUrl(url) {
        try {
            const response = await fetch(`${url}/config`);
            if (response.ok) {
                const config = await response.json();
                this.updateConfig(config.backend_url, config.websocket_url);
                location.reload();
                return true;
            }
        } catch (error) {
            console.error('Failed to set backend URL:', error);
        }
        return false;
    }
}

// Global config instance
window.appConfig = new Config();
