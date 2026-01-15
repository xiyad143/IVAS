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
        
        // Fetch data
        const client = new IVASClient(cookies);
        const smsData = await client.fetchSMSData();
        
        // Filter for social media
        const filteredData = smsData.filter(item => {
            const service = (item.service || '').toLowerCase();
            return ['facebook', 'instagram', 'whatsapp'].some(keyword => 
                service.includes(keyword));
        });
        
        // Calculate statistics
        const serviceCount = {};
        const countryCount = {};
        
        filteredData.forEach(item => {
            const service = item.service;
            const country = item.country;
            
            serviceCount[service] = (serviceCount[service] || 0) + 1;
            countryCount[country] = (countryCount[country] || 0) + 1;
        });
        
        // Get top services
        const topServices = Object.entries(serviceCount)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);
        
        // Get top countries
        const topCountries = Object.entries(countryCount)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);
        
        // Get recent data (last 5 minutes)
        const cutoff = new Date(Date.now() - 5 * 60 * 1000);
        const recentData = filteredData.filter(item => {
            try {
                const itemTime = new Date(item.timestamp);
                return itemTime > cutoff;
            } catch {
                return false;
            }
        });
        
        return ResponseHelper.success({
            total: filteredData.length,
            recent: recentData.length,
            top_services: topServices,
            top_countries: topCountries,
            recent_data: recentData.slice(0, 20),
            all_data: filteredData.slice(0, 100),
            timestamp: new Date().toISOString(),
            data_source: 'iVAS SMS Portal'
        });
        
    } catch (error) {
        console.error('Fetch data error:', error);
        return ResponseHelper.error(error.message || 'Internal server error', 500);
    }
};