const axios = require('axios');
const cheerio = require('cheerio');

// Cookie Parser
class CookieParser {
    static parseCookieString(cookieString) {
        const cookies = {};
        
        if (!cookieString) return cookies;
        
        try {
            // Remove whitespace
            let decodedString = cookieString.trim();
            
            // Try to decode base64
            if (this.isBase64(decodedString)) {
                try {
                    decodedString = Buffer.from(decodedString, 'base64').toString('utf-8');
                } catch (e) {
                    // Not base64, continue with original
                }
            }
            
            // Try to parse as JSON
            if (decodedString.startsWith('[') || decodedString.startsWith('{')) {
                try {
                    const data = JSON.parse(decodedString);
                    if (Array.isArray(data)) {
                        data.forEach(item => {
                            if (item.name && item.value) {
                                cookies[item.name] = item.value;
                            }
                        });
                    } else if (data.name && data.value) {
                        cookies[data.name] = data.value;
                    } else {
                        // Assume object of name:value pairs
                        Object.keys(data).forEach(key => {
                            if (typeof data[key] === 'string') {
                                cookies[key] = data[key];
                            }
                        });
                    }
                    return cookies;
                } catch (e) {
                    // Not JSON, try as raw cookies
                }
            }
            
            // Parse as raw cookie string
            const pairs = decodedString.split(';');
            pairs.forEach(pair => {
                if (pair.includes('=')) {
                    const [name, ...valueParts] = pair.trim().split('=');
                    if (name && valueParts.length > 0) {
                        cookies[name.trim()] = decodeURIComponent(valueParts.join('=').trim());
                    }
                }
            });
            
        } catch (error) {
            console.error('Cookie parsing error:', error);
        }
        
        return cookies;
    }
    
    static isBase64(str) {
        try {
            return Buffer.from(str, 'base64').toString('base64') === str;
        } catch (e) {
            return false;
        }
    }
    
    static validateCookies(cookies) {
        const required = ['cf_clearance', 'XSRF-TOKEN', 'ivas_sms_session'];
        const missing = required.filter(cookie => !cookies[cookie]);
        return {
            valid: missing.length === 0,
            missing
        };
    }
}

// IVAS Client
class IVASClient {
    constructor(cookies) {
        this.cookies = cookies;
        this.baseURL = 'https://www.ivasms.com';
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
            'Cookie': Object.keys(cookies).map(key => `${key}=${cookies[key]}`).join('; ')
        };
    }
    
    async testConnection() {
        try {
            const response = await axios.get(`${this.baseURL}/portal/live/test_sms`, {
                headers: this.headers,
                timeout: 10000,
                validateStatus: () => true
            });
            
            return {
                success: response.status === 200 || response.status === 302,
                status: response.status,
                data: response.data?.substring?.(0, 500) || ''
            };
        } catch (error) {
            return {
                success: false,
                error: error.message,
                status: error.response?.status || 0
            };
        }
    }
    
    async fetchSMSData() {
        try {
            const response = await axios.get(`${this.baseURL}/portal/live/test_sms`, {
                headers: this.headers,
                timeout: 30000,
                validateStatus: () => true
            });
            
            if (response.status === 200) {
                return this.parseSMSData(response.data);
            }
            return [];
        } catch (error) {
            console.error('Fetch error:', error);
            return [];
        }
    }
    
    parseSMSData(htmlContent) {
        try {
            const $ = cheerio.load(htmlContent);
            const data = [];
            
            // Parse tables
            $('table').each((index, table) => {
                $(table).find('tr').each((rowIndex, row) => {
                    const cells = $(row).find('td, th');
                    if (cells.length >= 4) {
                        const smsEntry = {
                            'sid': $(cells[0]).text().trim() || '',
                            'message': $(cells[1]).text().trim() || '',
                            'service': $(cells[2]).text().trim() || '',
                            'country': $(cells[3]).text().trim() || '',
                            'range': cells.length > 4 ? $(cells[4]).text().trim() : '',
                            'content': cells.length > 5 ? $(cells[5]).text().trim() : $(cells[1]).text().trim(),
                            'timestamp': new Date().toISOString()
                        };
                        
                        // Filter for social media
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
            
            return data;
        } catch (error) {
            console.error('Parse error:', error);
            return [];
        }
    }
}

// Response Helper
class ResponseHelper {
    static success(data) {
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            body: JSON.stringify({ success: true, ...data })
        };
    }
    
    static error(message, statusCode = 400) {
        return {
            statusCode,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            body: JSON.stringify({ success: false, error: message })
        };
    }
    
    static cors() {
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            body: ''
        };
    }
}

module.exports = { CookieParser, IVASClient, ResponseHelper };