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
        const cookieString = body.cookies || '';
        const serviceFilter = (body.service || '').toLowerCase();
        const countryFilter = (body.country || '').toLowerCase();
        
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
        
        // Apply filters
        const filteredData = smsData.filter(item => {
            const itemService = (item.service || '').toLowerCase();
            const itemCountry = (item.country || '').toLowerCase();
            
            // Check if matches filters
            const serviceMatch = !serviceFilter || itemService.includes(serviceFilter);
            const countryMatch = !countryFilter || itemCountry.includes(countryFilter);
            
            return serviceMatch && countryMatch && 
                ['facebook', 'instagram', 'whatsapp'].some(keyword => 
                    itemService.includes(keyword));
        });
        
        // Calculate detailed stats
        const stats = {
            total: filteredData.length,
            by_service: {},
            by_country: {},
            by_hour: {},
            ranges: new Set(),
            service_distribution: {},
            country_distribution: {}
        };
        
        filteredData.forEach(item => {
            const service = item.service;
            const country = item.country;
            const smsRange = item.range || 'N/A';
            
            // Service stats
            stats.by_service[service] = (stats.by_service[service] || 0) + 1;
            
            // Country stats
            stats.by_country[country] = (stats.by_country[country] || 0) + 1;
            
            // Range stats
            if (smsRange && smsRange !== 'N/A') {
                stats.ranges.add(smsRange);
            }
            
            // Hourly stats
            try {
                const hour = new Date(item.timestamp).getHours();
                stats.by_hour[hour] = (stats.by_hour[hour] || 0) + 1;
            } catch (e) {
                // Ignore timestamp errors
            }
        });
        
        // Calculate percentages
        Object.keys(stats.by_service).forEach(service => {
            stats.service_distribution[service] = {
                count: stats.by_service[service],
                percentage: stats.total > 0 ? 
                    Math.round((stats.by_service[service] / stats.total) * 100) : 0
            };
        });
        
        Object.keys(stats.by_country).forEach(country => {
            stats.country_distribution[country] = {
                count: stats.by_country[country],
                percentage: stats.total > 0 ? 
                    Math.round((stats.by_country[country] / stats.total) * 100) : 0
            };
        });
        
        return ResponseHelper.success({
            stats: stats,
            ranges: Array.from(stats.ranges).slice(0, 20),
            summary: {
                total_filtered: filteredData.length,
                services_count: Object.keys(stats.by_service).length,
                countries_count: Object.keys(stats.by_country).length,
                unique_ranges: stats.ranges.size
            }
        });
        
    } catch (error) {
        console.error('Stats error:', error);
        return ResponseHelper.error(error.message || 'Internal server error', 500);
    }
};