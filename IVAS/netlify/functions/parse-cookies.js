const { CookieParser, ResponseHelper } = require('./utils');

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
        
        return ResponseHelper.success({
            cookies: Object.keys(cookies).reduce((acc, key) => {
                const value = cookies[key];
                acc[key] = value.length > 50 ? value.substring(0, 50) + '...' : value;
                return acc;
            }, {}),
            cookie_count: Object.keys(cookies).length,
            required_cookies_found: true
        });
        
    } catch (error) {
        console.error('Parse cookies error:', error);
        return ResponseHelper.error(error.message || 'Internal server error', 500);
    }
};