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
            this.isConfigured = true;
        } else {
            // Clear old URLs from localStorage to ensure we use the latest config
            const savedUrl = localStorage.getItem('backend_url');
            if (savedUrl && !savedUrl.includes('9184e787ca4abaf98404e34c54ff5a9e.serveo.net')) {
                localStorage.removeItem('backend_url');
                console.log('Cleared old backend URL from localStorage');
            }
            
            // In production, try to get from localStorage first, then use default
            const currentSavedUrl = localStorage.getItem('backend_url');
            if (currentSavedUrl) {
                this.apiUrl = currentSavedUrl;
                this.wsUrl = currentSavedUrl.replace('http', 'ws');
                this.isConfigured = false; // Still need to verify
            } else {
                                // Use the NEW serveo tunnel URL as default
                this.apiUrl = 'https://9184e787ca4abaf98404e34c54ff5a9e.serveo.net';
                this.wsUrl = 'wss://9184e787ca4abaf98404e34c54ff5a9e.serveo.net';
                this.isConfigured = true; // Auto-configured with hardcoded tunnel URL
            }
        }
        
        console.log('Config initialized:', {
            isDevelopment: this.isDevelopment,
            apiUrl: this.apiUrl,
            wsUrl: this.wsUrl,
            isConfigured: this.isConfigured
        });
    }
    
    async verifyConnection() {
        try {
            const response = await fetch(`${this.apiUrl}/config`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'ngrok-skip-browser-warning': 'true'
                },
                timeout: 10000
            });
            
            if (response.ok) {
                console.log('✅ Backend connection verified');
                this.isConfigured = true;
                
                // Cache the working URL
                localStorage.setItem('backend_url', this.apiUrl);
                
                return true;
            } else {
                console.error('❌ Backend responded with error:', response.status);
                return false;
            }
        } catch (error) {
            console.error('❌ Failed to connect to backend:', error);
            return false;
        }
    }
    
    async promptForUrl() {
        if (this.isDevelopment) {
            return; // Don't prompt in development
        }
        
        const userUrl = prompt(
            'Backend connection failed. Please enter the backend URL (e.g., https://your-tunnel.serveo.net):',
            this.apiUrl
        );
        
        if (userUrl && userUrl.trim()) {
            this.apiUrl = userUrl.trim();
            this.wsUrl = this.apiUrl.replace('http', 'ws');
            
            // Test the new URL
            const isWorking = await this.verifyConnection();
            if (isWorking) {
                console.log('✅ New backend URL is working');
                return true;
            } else {
                console.log('❌ New backend URL is not working');
                return false;
            }
        }
        
        return false;
    }
    
    getApiUrl() {
        return this.apiUrl;
    }
    
    getWsUrl() {
        return this.wsUrl;
    }
}

// Create global config instance
window.appConfig = new Config();

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Config;
}
