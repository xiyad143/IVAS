const { CookieParser, IVASClient, ResponseHelper } = require('./utils');

exports.handler = async (event) => {
    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return ResponseHelper.cors();
    }
    
    if (event.httpMethod !== 'POST') {
        return ResponseHelper.error('Method not allowed', 405);
    }
    
    try {
        const body = JSON.parse(event.body || '{}');
        const cookieString = (body.cookies || '').trim();
        
        if (!cookieString) {
            return ResponseHelper.error('No cookies provided');
        }
        
        // Parse cookies
        const cookies = CookieParser.parseCookieString(cookieString);
        
        // Validate required cookies
        const validation = CookieParser.validateCookies(cookies);
        if (!validation.valid) {
            return ResponseHelper.error(
                `Missing required cookies: ${validation.missing.join(', ')}`,
                400
            );
        }
        
        // Test connection
        const client = new IVASClient(cookies);
        const result = await client.testConnection();
        
        return ResponseHelper.success({
            connected: result.success,
            status: result.status,
            preview: result.data,
            timestamp: new Date().toISOString(),
            cookie_count: Object.keys(cookies).length
        });
        
    } catch (error) {
        console.error('Test connection error:', error);
        return ResponseHelper.error(error.message || 'Internal server error', 500);
    }
};