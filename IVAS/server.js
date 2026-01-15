const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const base64 = require('base64-js');
const { TextDecoder } = require('util');
const path = require('path');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configure logging
const logger = {
    debug: (msg) => console.debug(`[DEBUG] ${msg}`),
    error: (msg) => console.error(`[ERROR] ${msg}`),
    info: (msg) => console.info(`[INFO] ${msg}`)
};

class CookieParser {
    /** Parse cookies from various formats */
    
    static decodeBase64Cookies(cookieString) {
        /** Decode base64 encoded cookies */
        try {
            // Remove whitespace and decode
            cookieString = cookieString.trim();
            const decodedBytes = base64.toByteArray(cookieString);
            const decoded = new TextDecoder('utf-8').decode(decodedBytes);
            logger.debug(`Base64 decoded: ${decoded.substring(0, 200)}...`);
            return decoded;
        } catch (e) {
            logger.error(`Base64 decode error: ${e}`);
            return null;
        }
    }
    
    static parseCookiesFromDecoded(decodedString) {
        /** Parse cookies from decoded string */
        let cookies = {};
        
        try {
            // Try to parse as JSON array or object
            if (decodedString.startsWith('[') || decodedString.startsWith('{')) {
                try {
                    const data = JSON.parse(decodedString);
                    
                    if (Array.isArray(data)) {
                        data.forEach(item => {
                            if (item.name && item.value) {
                                cookies[item.name] = item.value;
                            }
                        });
                    } else if (typeof data === 'object') {
                        // Check if it's a single cookie object or dict of cookies
                        if (data.name && data.value) {
                            cookies[data.name] = data.value;
                        } else {
                            // Assume it's a dict of name:value pairs
                            Object.keys(data).forEach(key => {
                                if (typeof data[key] === 'string') {
                                    cookies[key] = data[key];
                                }
                            });
                        }
                    }
                    return cookies;
                } catch (e) {
                    // Not JSON, continue with other formats
                }
            }
            
            // Try to parse as Netscape cookie format
            if (decodedString.includes('";"') && decodedString.includes('"name"')) {
                // Split by semicolon and parse each JSON object
                const cookieObjects = decodedString.split(';');
                cookieObjects.forEach(cookieObj => {
                    cookieObj = cookieObj.trim();
                    if (cookieObj) {
                        try {
                            // Clean the JSON string
                            cookieObj = cookieObj.trim();
                            if (!cookieObj.endsWith('}')) {
                                cookieObj = cookieObj + '}';
                            }
                            const data = JSON.parse(cookieObj);
                            if (data.name && data.value) {
                                cookies[data.name] = data.value;
                            }
                        } catch (e) {
                            logger.debug(`Failed to parse cookie object: ${e}`);
                        }
                    }
                });
                return cookies;
            }
            
            // Try to parse as raw cookie string
            if (decodedString.includes('=')) {
                const pairs = decodedString.split(';');
                pairs.forEach(pair => {
                    if (pair.includes('=')) {
                        const [name, ...valueParts] = pair.trim().split('=');
                        const value = valueParts.join('='); // In case value contains '='
                        cookies[name] = value;
                    }
                });
                return cookies;
            }
                
        } catch (e) {
            logger.error(`Parse error: ${e}`);
        }
        
        return cookies;
    }
    
    static parseCookieString(cookieString) {
        /** Main method to parse any cookie format */
        let cookies = {};
        
        // First try direct parsing
        if (cookieString.includes('=') && (cookieString.includes(';') || cookieString.length > 50)) {
            const pairs = cookieString.split(';');
            pairs.forEach(pair => {
                if (pair.includes('=')) {
                    const [name, ...valueParts] = pair.trim().split('=');
                    const value = valueParts.join('=');
                    cookies[name] = decodeURIComponent(value);
                }
            });
        }
        
        // If no cookies found, try base64 decoding
        if (Object.keys(cookies).length === 0) {
            const decoded = CookieParser.decodeBase64Cookies(cookieString);
            if (decoded) {
                cookies = CookieParser.parseCookiesFromDecoded(decoded);
            }
        }
        
        // Extract specific cookies we need
        const requiredCookies = {};
        const cookieMapping = {
            'cf_clearance': ['cf_clearance', 'cf-clearance', 'cloudflare'],
            'XSRF-TOKEN': ['XSRF-TOKEN', 'xsrf-token', 'csrf_token'],
            'ivas_sms_session': ['ivas_sms_session', 'session', 'laravel_session'],
            '_ga': ['_ga', 'ga'],
            '_gid': ['_gid', 'gid'],
            '_fbp': ['_fbp', 'fbp']
        };
        
        Object.keys(cookieMapping).forEach(requiredName => {
            const possibleNames = cookieMapping[requiredName];
            for (const possibleName of possibleNames) {
                if (cookies[possibleName]) {
                    requiredCookies[requiredName] = cookies[possibleName];
                    break;
                }
            }
        });
        
        logger.debug(`Parsed cookies: ${Object.keys(requiredCookies)}`);
        return requiredCookies;
    }
}

class IVASClient {
    /** Client for interacting with iVAS SMS */
    
    constructor(cookies) {
        this.cookies = cookies;
        this.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
        };
    }
    
    async testConnection() {
        /** Test if cookies are valid */
        try {
            const response = await axios.get('https://www.ivasms.com/portal/live/test_sms', {
                headers: {
                    ...this.headers,
                    'Cookie': Object.keys(this.cookies)
                        .map(key => `${key}=${this.cookies[key]}`)
                        .join('; ')
                },
                timeout: 10000,
                validateStatus: () => true // Accept any status code
            });
            return [response.status === 200 || response.status === 302, response.status, response.data?.substring?.(0, 500) || ''];
        } catch (e) {
            return [false, e.message || e.code || 'Error', ''];
        }
    }
    
    async fetchSmsData() {
        /** Fetch SMS data from iVAS */
        try {
            const response = await axios.get('https://www.ivasms.com/portal/live/test_sms', {
                headers: {
                    ...this.headers,
                    'Cookie': Object.keys(this.cookies)
                        .map(key => `${key}=${this.cookies[key]}`)
                        .join('; ')
                },
                timeout: 30000,
                validateStatus: () => true
            });
            
            if (response.status === 200) {
                return this.parseSmsData(response.data);
            }
            return [];
        } catch (e) {
            logger.error(`Fetch error: ${e}`);
            return [];
        }
    }
    
    parseSmsData(htmlContent) {
        /** Parse SMS data from HTML */
        try {
            const $ = cheerio.load(htmlContent);
            const data = [];
            
            // Check if we're on the right page by looking for specific elements
            const pageText = $('body').text().toLowerCase();
            if (!pageText.includes('sms') && !pageText.includes('message')) {
                logger.error('Not on SMS data page');
                return [];
            }
            
            // Look for SMS data in various formats
            // Try to find tables with SMS data
            $('table').each((index, table) => {
                $(table).find('tr').each((rowIndex, row) => {
                    const cells = $(row).find('td, th');
                    if (cells.length >= 4) {
                        // Extract SMS data
                        const smsEntry = {
                            'sid': $(cells[0]).text().trim() || '',
                            'message': $(cells[1]).text().trim() || '',
                            'service': $(cells[2]).text().trim() || '',
                            'country': $(cells[3]).text().trim() || '',
                            'range': cells.length > 4 ? $(cells[4]).text().trim() : '',
                            'content': cells.length > 5 ? $(cells[5]).text().trim() : $(cells[1]).text().trim(),
                            'timestamp': new Date().toISOString()
                        };
                        
                        // Filter for social media services
                        const serviceLower = smsEntry.service.toLowerCase();
                        const socialKeywords = ['facebook', 'instagram', 'whatsapp', 'fb', 'ig', 'wa'];
                        if (socialKeywords.some(keyword => serviceLower.includes(keyword))) {
                            // Standardize service names
                            if (serviceLower.includes('facebook') || serviceLower.includes('fb')) {
                                smsEntry.service = 'Facebook';
                            } else if (serviceLower.includes('instagram') || serviceLower.includes('ig')) {
                                smsEntry.service = 'Instagram';
                            } else if (serviceLower.includes('whatsapp') || serviceLower.includes('wa')) {
                                smsEntry.service = 'WhatsApp';
                            }
                            
                            data.push(smsEntry);
                        }
                    }
                });
            });
            
            // If no table data found, try to extract from page content
            if (data.length === 0) {
                const text = $('body').text();
                const lines = text.split('\n');
                
                lines.forEach(line => {
                    line = line.trim();
                    if (line && line.length > 10) {
                        // Check for SMS patterns
                        const keywords = ['facebook', 'instagram', 'whatsapp', 'sms', 'message', 'code'];
                        if (keywords.some(keyword => line.toLowerCase().includes(keyword))) {
                            // Extract SID (alphanumeric code)
                            const sidMatch = line.match(/[A-Z0-9]{8,}/);
                            const sid = sidMatch ? sidMatch[0] : 'N/A';
                            
                            // Determine service
                            let service = '';
                            if (line.toLowerCase().includes('facebook') || line.toLowerCase().includes('fb')) {
                                service = 'Facebook';
                            } else if (line.toLowerCase().includes('instagram') || line.toLowerCase().includes('ig')) {
                                service = 'Instagram';
                            } else if (line.toLowerCase().includes('whatsapp') || line.toLowerCase().includes('wa')) {
                                service = 'WhatsApp';
                            } else {
                                return; // Skip if not social media
                            }
                            
                            // Extract country (look for country codes or names)
                            const countryMatch = line.substring(Math.max(0, line.length - 50)).match(/[A-Z]{2,3}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/);
                            const country = countryMatch ? countryMatch[0] : 'Unknown';
                            
                            data.push({
                                'sid': sid,
                                'message': line.length > 100 ? line.substring(0, 100) + '...' : line,
                                'service': service,
                                'country': country,
                                'range': 'N/A',
                                'content': line,
                                'timestamp': new Date().toISOString()
                            });
                        }
                    }
                });
            }
            
            return data;
        } catch (e) {
            logger.error(`Parse error: ${e}`);
            return [];
        }
    }
}

// API Routes
app.post('/api/parse-cookies', (req, res) => {
    /** Parse cookies from any format */
    try {
        const cookieString = (req.body.cookies || '').trim();
        
        if (!cookieString) {
            return res.json({success: false, error: 'No cookies provided'});
        }
        
        // Parse cookies
        const cookies = CookieParser.parseCookieString(cookieString);
        
        // Validate we have required cookies
        const required = ['cf_clearance', 'XSRF-TOKEN', 'ivas_sms_session'];
        const missing = required.filter(cookie => !cookies[cookie]);
        
        if (missing.length > 0) {
            return res.json({
                success: false,
                error: `Missing required cookies: ${missing.join(', ')}`,
                parsed_cookies: Object.keys(cookies)
            });
        }
        
        return res.json({
            success: true,
            cookies: Object.keys(cookies).reduce((acc, key) => {
                acc[key] = cookies[key].length > 50 ? 
                    cookies[key].substring(0, 50) + '...' : cookies[key];
                return acc;
            }, {}),
            cookie_count: Object.keys(cookies).length
        });
        
    } catch (e) {
        logger.error(`Parse cookies error: ${e}`);
        return res.json({success: false, error: e.message});
    }
});

app.post('/api/test-connection', async (req, res) => {
    /** Test connection with parsed cookies */
    try {
        const cookieString = (req.body.cookies || '').trim();
        
        if (!cookieString) {
            return res.json({success: false, error: 'No cookies provided'});
        }
        
        // Parse cookies
        const cookies = CookieParser.parseCookieString(cookieString);
        
        // Test connection
        const client = new IVASClient(cookies);
        const [isConnected, status, preview] = await client.testConnection();
        
        return res.json({
            success: isConnected,
            status: status,
            preview: preview,
            cookie_count: Object.keys(cookies).length
        });
        
    } catch (e) {
        logger.error(`Test connection error: ${e}`);
        return res.json({success: false, error: e.message});
    }
});

app.post('/api/fetch-data', async (req, res) => {
    /** Fetch SMS data */
    try {
        const cookieString = (req.body.cookies || '').trim();
        
        if (!cookieString) {
            return res.json({success: false, error: 'No cookies provided'});
        }
        
        // Parse cookies
        const cookies = CookieParser.parseCookieString(cookieString);
        
        // Fetch data
        const client = new IVASClient(cookies);
        const smsData = await client.fetchSmsData();
        
        // Filter for Facebook, Instagram, WhatsApp only
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
                return true;
            }
        });
        
        return res.json({
            success: true,
            total: filteredData.length,
            recent: recentData.length,
            top_services: topServices,
            top_countries: topCountries,
            recent_data: recentData.slice(0, 20),  // Limit for performance
            all_data: filteredData.slice(0, 100),   // Limit for performance
            timestamp: new Date().toISOString()
        });
        
    } catch (e) {
        logger.error(`Fetch data error: ${e}`);
        return res.json({success: false, error: e.message});
    }
});

app.post('/api/stats', async (req, res) => {
    /** Get statistics for specific filters */
    try {
        const cookieString = req.body.cookies || '';
        const serviceFilter = (req.body.service || '').toLowerCase();
        const countryFilter = (req.body.country || '').toLowerCase();
        
        // Parse cookies
        const cookies = CookieParser.parseCookieString(cookieString);
        
        // Fetch data
        const client = new IVASClient(cookies);
        const smsData = await client.fetchSmsData();
        
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
            ranges: new Set()
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
        
        return res.json({
            success: true,
            stats: stats,
            ranges: Array.from(stats.ranges).slice(0, 20)  // Limit ranges
        });
        
    } catch (e) {
        logger.error(`Stats error: ${e}`);
        return res.json({success: false, error: e.message});
    }
});

app.get('/api/health', (req, res) => {
    /** Health check endpoint */
    res.json({status: 'healthy', timestamp: new Date().toISOString()});
});

// Serve frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Frontend available at http://localhost:${PORT}`);
});