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
            // In production, try to get from localStorage first, then use default
            const savedUrl = localStorage.getItem('backend_url');
            if (savedUrl) {
                this.apiUrl = savedUrl;
                this.wsUrl = savedUrl.replace('http', 'ws');
                this.isConfigured = false; // Still need to verify
            } else {
                // Use the current ngrok URL as default
                this.apiUrl = 'https://48172acdb676.ngrok-free.app';
                this.wsUrl = 'wss://48172acdb676.ngrok-free.app';
                this.isConfigured = false; // Need to verify
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
                timeout: 5000
            });
            
            if (response.ok) {
                const config = await response.json();
                console.log('Backend config verified:', config);
                
                // Update URLs from backend response
                this.apiUrl = config.backend_url;
                this.wsUrl = config.websocket_url;
                this.isConfigured = true;
                
                // Save for future use
                localStorage.setItem('backend_url', this.apiUrl);
                
                return true;
            }
        } catch (error) {
            console.log('Connection verification failed:', error);
        }
        return false;
    }
    
    async ensureConfigured() {
        // Always try to verify current config first (no prompting)
        const verified = await this.verifyConnection();
        if (verified) {
            return true;
        }
        
        // If verification failed and we're in production, try a few common patterns silently
        if (!this.isDevelopment) {
            const fallbackUrls = [
                'https://48172acdb676.ngrok-free.app', // Current ngrok URL
                localStorage.getItem('backend_url')
            ].filter(Boolean);
            
            for (const url of fallbackUrls) {
                this.apiUrl = url;
                this.wsUrl = url.replace('http', 'ws');
                
                const verified = await this.verifyConnection();
                if (verified) {
                    return true;
                }
            }
        }
        
        // Only prompt as last resort if all automatic attempts fail
        const userUrl = prompt('Backend connection failed. Please enter your backend URL (e.g., https://abc123.ngrok-free.app):');
        if (userUrl && userUrl.startsWith('http')) {
            this.apiUrl = userUrl;
            this.wsUrl = userUrl.replace('http', 'ws');
            
            // Try to verify the user-provided URL
            const verified = await this.verifyConnection();
            if (verified) {
                return true;
            } else {
                alert('Failed to connect to the provided URL. Please check the URL and try again.');
            }
        }
        
        return false;
    }
    
    // Method to manually set URL (for admin panel)
    async setBackendUrl(url) {
        this.apiUrl = url;
        this.wsUrl = url.replace('http', 'ws');
        
        const verified = await this.verifyConnection();
        if (verified) {
            alert('Backend URL updated successfully!');
            return true;
        } else {
            alert('Failed to connect to the provided URL. Please check the URL and try again.');
            return false;
        }
    }
}

// Global config instance
window.appConfig = new Config();
