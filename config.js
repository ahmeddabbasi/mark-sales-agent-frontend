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
            if (savedUrl && !savedUrl.includes('11880bc4a32b.ngrok-free.app')) {
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
                // Use the current ngrok tunnel URL as default
                this.apiUrl = 'https://11880bc4a32b.ngrok-free.app';
                this.wsUrl = 'wss://11880bc4a32b.ngrok-free.app';
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
        // If we're in development or have a hardcoded tunnel URL, skip verification popup
        if (this.isConfigured) {
            return true;
        }
        
        // For hardcoded tunnel URLs (ngrok, serveo, loca.lt), skip verification and accept directly
        if (this.apiUrl.includes('ngrok-free.app') || 
            this.apiUrl.includes('serveo.net') || 
            this.apiUrl.includes('loca.lt')) {
            console.log('Using hardcoded tunnel URL, skipping verification:', this.apiUrl);
            this.isConfigured = true;
            return true;
        }
        
        // Always try to verify current config first (no prompting)
        const verified = await this.verifyConnection();
        if (verified) {
            return true;
        }
        
        // If verification failed and we're in production, try a few common patterns silently
        if (!this.isDevelopment) {
            const fallbackUrls = [
                'https://61998bca0380717425730ee490a70e06.serveo.net', // Current tunnel URL
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
        
        // Only prompt as last resort if all automatic attempts fail AND we don't have hardcoded URL
        if (!this.apiUrl.includes('ngrok-free.app') && 
            !this.apiUrl.includes('serveo.net') && 
            !this.apiUrl.includes('loca.lt')) {
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
        }
        
        // If we have a hardcoded tunnel URL, just proceed without popup
        return (this.apiUrl.includes('ngrok-free.app') || 
                this.apiUrl.includes('serveo.net') || 
                this.apiUrl.includes('loca.lt'));
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
