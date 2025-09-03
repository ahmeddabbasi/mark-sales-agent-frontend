// Configuration for API endpoints
class Config {
    constructor() {
        // Check if we're in development or production
        this.isDevelopment = window.location.hostname === 'localhost' || 
                            window.location.hostname === '127.0.0.1';
        
        // For production, use environment variable or prompt user to set ngrok URL
        if (this.isDevelopment) {
            this.ngrokUrl = 'http://localhost:8000';
        } else {
            // Try to get from environment first, then localStorage, then prompt
            this.ngrokUrl = this.getBackendUrl();
        }
        
        this.apiUrl = this.ngrokUrl;
        this.wsUrl = this.ngrokUrl.replace('http', 'ws');
        
        console.log('Config initialized:', {
            isDevelopment: this.isDevelopment,
            apiUrl: this.apiUrl,
            wsUrl: this.wsUrl
        });
    }
    
    getBackendUrl() {
        // Try localStorage first
        let savedUrl = localStorage.getItem('ngrok_url');
        if (savedUrl) {
            return savedUrl;
        }
        
        // If no saved URL, prompt user or use default
        const urlFromUser = prompt(
            'Please enter your ngrok backend URL (e.g., https://abc123.ngrok-free.app):'
        );
        
        if (urlFromUser) {
            localStorage.setItem('ngrok_url', urlFromUser);
            return urlFromUser;
        }
        
        // Fallback - this will need to be updated
        return 'https://YOUR_NGROK_URL.ngrok-free.app';
    }
    
    updateNgrokUrl(url) {
        this.ngrokUrl = url;
        this.apiUrl = url;
        this.wsUrl = url.replace('http', 'ws');
        localStorage.setItem('ngrok_url', url);
        console.log('Config updated with ngrok URL:', {
            apiUrl: this.apiUrl,
            wsUrl: this.wsUrl
        });
    }
    
    // Method to set URL from admin panel
    setBackendUrl(url) {
        this.updateNgrokUrl(url);
        location.reload(); // Reload to apply new config
    }
}

// Global config instance
window.appConfig = new Config();
