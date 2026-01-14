from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import requests
from bs4 import BeautifulSoup
import json
import base64
import re
from datetime import datetime, timedelta
import logging
from urllib.parse import unquote

# Configure logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

class CookieParser:
    """Parse cookies from various formats"""
    
    @staticmethod
    def decode_base64_cookies(cookie_string):
        """Decode base64 encoded cookies"""
        try:
            # Remove whitespace and decode
            cookie_string = cookie_string.strip()
            decoded = base64.b64decode(cookie_string).decode('utf-8')
            logger.debug(f"Base64 decoded: {decoded[:200]}...")
            return decoded
        except Exception as e:
            logger.error(f"Base64 decode error: {e}")
            return None
    
    @staticmethod
    def parse_cookies_from_decoded(decoded_string):
        """Parse cookies from decoded string"""
        cookies = {}
        
        try:
            # Try to parse as JSON array or object
            if decoded_string.startswith('[') or decoded_string.startswith('{'):
                try:
                    data = json.loads(decoded_string)
                    if isinstance(data, list):
                        for item in data:
                            if 'name' in item and 'value' in item:
                                cookies[item['name']] = item['value']
                    elif isinstance(data, dict):
                        # Check if it's a single cookie object or dict of cookies
                        if 'name' in data and 'value' in data:
                            cookies[data['name']] = data['value']
                        else:
                            # Assume it's a dict of name:value pairs
                            for key, value in data.items():
                                if isinstance(value, str):
                                    cookies[key] = value
                    return cookies
                except json.JSONDecodeError:
                    pass
            
            # Try to parse as Netscape cookie format (your format)
            # Format: {"domain":"...","name":"...","value":"..."};{...}
            if '";"' in decoded_string and '"name"' in decoded_string:
                # Split by semicolon and parse each JSON object
                cookie_objects = decoded_string.split(';')
                for cookie_obj in cookie_objects:
                    cookie_obj = cookie_obj.strip()
                    if cookie_obj:
                        try:
                            # Clean the JSON string
                            cookie_obj = cookie_obj.strip()
                            if not cookie_obj.endswith('}'):
                                cookie_obj = cookie_obj + '}'
                            data = json.loads(cookie_obj)
                            if 'name' in data and 'value' in data:
                                cookies[data['name']] = data['value']
                        except json.JSONDecodeError as e:
                            logger.debug(f"Failed to parse cookie object: {e}")
                            continue
                return cookies
            
            # Try to parse as raw cookie string
            if '=' in decoded_string:
                pairs = decoded_string.split(';')
                for pair in pairs:
                    if '=' in pair:
                        name, value = pair.strip().split('=', 1)
                        cookies[name] = value
                return cookies
                
        except Exception as e:
            logger.error(f"Parse error: {e}")
        
        return cookies
    
    @staticmethod
    def parse_cookie_string(cookie_string):
        """Main method to parse any cookie format"""
        cookies = {}
        
        # First try direct parsing
        if '=' in cookie_string and (';' in cookie_string or len(cookie_string) > 50):
            pairs = cookie_string.split(';')
            for pair in pairs:
                if '=' in pair:
                    name, value = pair.strip().split('=', 1)
                    cookies[name] = unquote(value)
        
        # If no cookies found, try base64 decoding
        if not cookies:
            decoded = CookieParser.decode_base64_cookies(cookie_string)
            if decoded:
                cookies = CookieParser.parse_cookies_from_decoded(decoded)
        
        # Extract specific cookies we need
        required_cookies = {}
        cookie_mapping = {
            'cf_clearance': ['cf_clearance', 'cf-clearance', 'cloudflare'],
            'XSRF-TOKEN': ['XSRF-TOKEN', 'xsrf-token', 'csrf_token'],
            'ivas_sms_session': ['ivas_sms_session', 'session', 'laravel_session'],
            '_ga': ['_ga', 'ga'],
            '_gid': ['_gid', 'gid'],
            '_fbp': ['_fbp', 'fbp']
        }
        
        for required_name, possible_names in cookie_mapping.items():
            for possible_name in possible_names:
                if possible_name in cookies:
                    required_cookies[required_name] = cookies[possible_name]
                    break
        
        logger.debug(f"Parsed cookies: {list(required_cookies.keys())}")
        return required_cookies

class IVASClient:
    """Client for interacting with iVAS SMS"""
    
    def __init__(self, cookies):
        self.session = requests.Session()
        self.session.cookies.update(cookies)
        
        self.headers = {
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
        }
        
        self.session.headers.update(self.headers)
    
    def test_connection(self):
        """Test if cookies are valid"""
        try:
            response = self.session.get('https://www.ivasms.com/portal/live/test_sms', timeout=10)
            return response.status_code == 200, response.status_code, response.text[:500]
        except Exception as e:
            return False, str(e), ""
    
    def fetch_sms_data(self):
        """Fetch SMS data from iVAS"""
        try:
            response = self.session.get('https://www.ivasms.com/portal/live/test_sms', timeout=30)
            if response.status_code == 200:
                return self.parse_sms_data(response.text)
            return []
        except Exception as e:
            logger.error(f"Fetch error: {e}")
            return []
    
    def parse_sms_data(self, html_content):
        """Parse SMS data from HTML"""
        soup = BeautifulSoup(html_content, 'html.parser')
        data = []
        
        # Look for SMS data in various formats
        # Try to find tables with SMS data
        tables = soup.find_all('table')
        
        for table in tables:
            rows = table.find_all('tr')
            for row in rows:
                cells = row.find_all(['td', 'th'])
                if len(cells) >= 4:
                    # Extract SMS data
                    sms_entry = {
                        'sid': cells[0].text.strip() if len(cells) > 0 else '',
                        'message': cells[1].text.strip() if len(cells) > 1 else '',
                        'service': cells[2].text.strip() if len(cells) > 2 else '',
                        'country': cells[3].text.strip() if len(cells) > 3 else '',
                        'range': cells[4].text.strip() if len(cells) > 4 else '',
                        'content': cells[5].text.strip() if len(cells) > 5 else cells[1].text.strip(),
                        'timestamp': datetime.now().isoformat()
                    }
                    
                    # Filter for social media services
                    service_lower = sms_entry['service'].lower()
                    if any(keyword in service_lower for keyword in ['facebook', 'instagram', 'whatsapp', 'fb', 'ig', 'wa']):
                        # Standardize service names
                        if 'facebook' in service_lower or 'fb' in service_lower:
                            sms_entry['service'] = 'Facebook'
                        elif 'instagram' in service_lower or 'ig' in service_lower:
                            sms_entry['service'] = 'Instagram'
                        elif 'whatsapp' in service_lower or 'wa' in service_lower:
                            sms_entry['service'] = 'WhatsApp'
                        
                        data.append(sms_entry)
        
        # If no table data found, try to extract from page content
        if not data:
            text = soup.get_text()
            lines = text.split('\n')
            for line in lines:
                line = line.strip()
                if line and len(line) > 10:
                    # Check for SMS patterns
                    if any(keyword in line.lower() for keyword in ['facebook', 'instagram', 'whatsapp', 'sms', 'message']):
                        # Extract SID (alphanumeric code)
                        sid_match = re.search(r'[A-Z0-9]{8,}', line)
                        sid = sid_match.group(0) if sid_match else 'N/A'
                        
                        # Determine service
                        if 'facebook' in line.lower() or 'fb' in line.lower():
                            service = 'Facebook'
                        elif 'instagram' in line.lower() or 'ig' in line.lower():
                            service = 'Instagram'
                        elif 'whatsapp' in line.lower() or 'wa' in line.lower():
                            service = 'WhatsApp'
                        else:
                            continue  # Skip if not social media
                        
                        # Extract country (look for country codes or names)
                        country_match = re.search(r'[A-Z]{2,3}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*', line[-50:])
                        country = country_match.group(0) if country_match else 'Unknown'
                        
                        data.append({
                            'sid': sid,
                            'message': line[:100] + '...' if len(line) > 100 else line,
                            'service': service,
                            'country': country,
                            'range': 'N/A',
                            'content': line,
                            'timestamp': datetime.now().isoformat()
                        })
        
        return data

@app.route('/api/parse-cookies', methods=['POST'])
def parse_cookies():
    """Parse cookies from any format"""
    try:
        data = request.get_json()
        cookie_string = data.get('cookies', '').strip()
        
        if not cookie_string:
            return jsonify({'success': False, 'error': 'No cookies provided'})
        
        # Parse cookies
        parser = CookieParser()
        cookies = parser.parse_cookie_string(cookie_string)
        
        # Validate we have required cookies
        required = ['cf_clearance', 'XSRF-TOKEN', 'ivas_sms_session']
        missing = [cookie for cookie in required if cookie not in cookies]
        
        if missing:
            return jsonify({
                'success': False,
                'error': f'Missing required cookies: {", ".join(missing)}',
                'parsed_cookies': list(cookies.keys())
            })
        
        return jsonify({
            'success': True,
            'cookies': {k: v[:50] + '...' if len(v) > 50 else v for k, v in cookies.items()},
            'cookie_count': len(cookies)
        })
        
    except Exception as e:
        logger.error(f"Parse cookies error: {e}")
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/test-connection', methods=['POST'])
def test_connection():
    """Test connection with parsed cookies"""
    try:
        data = request.get_json()
        cookie_string = data.get('cookies', '').strip()
        
        if not cookie_string:
            return jsonify({'success': False, 'error': 'No cookies provided'})
        
        # Parse cookies
        parser = CookieParser()
        cookies = parser.parse_cookie_string(cookie_string)
        
        # Test connection
        client = IVASClient(cookies)
        is_connected, status, preview = client.test_connection()
        
        return jsonify({
            'success': is_connected,
            'status': status,
            'preview': preview,
            'cookie_count': len(cookies)
        })
        
    except Exception as e:
        logger.error(f"Test connection error: {e}")
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/fetch-data', methods=['POST'])
def fetch_data():
    """Fetch SMS data"""
    try:
        data = request.get_json()
        cookie_string = data.get('cookies', '').strip()
        
        if not cookie_string:
            return jsonify({'success': False, 'error': 'No cookies provided'})
        
        # Parse cookies
        parser = CookieParser()
        cookies = parser.parse_cookie_string(cookie_string)
        
        # Fetch data
        client = IVASClient(cookies)
        sms_data = client.fetch_sms_data()
        
        # Filter for Facebook, Instagram, WhatsApp only
        filtered_data = []
        for item in sms_data:
            service = item.get('service', '').lower()
            if any(keyword in service for keyword in ['facebook', 'instagram', 'whatsapp']):
                filtered_data.append(item)
        
        # Calculate statistics
        service_count = {}
        country_count = {}
        
        for item in filtered_data:
            service = item['service']
            country = item['country']
            
            service_count[service] = service_count.get(service, 0) + 1
            country_count[country] = country_count.get(country, 0) + 1
        
        # Get top services
        top_services = sorted(service_count.items(), key=lambda x: x[1], reverse=True)[:10]
        
        # Get top countries
        top_countries = sorted(country_count.items(), key=lambda x: x[1], reverse=True)[:10]
        
        # Get recent data (last 5 minutes)
        recent_data = []
        cutoff = datetime.now() - timedelta(minutes=5)
        
        for item in filtered_data:
            try:
                item_time = datetime.fromisoformat(item['timestamp'].replace('Z', '+00:00'))
                if item_time > cutoff:
                    recent_data.append(item)
            except:
                recent_data.append(item)
        
        return jsonify({
            'success': True,
            'total': len(filtered_data),
            'recent': len(recent_data),
            'top_services': top_services,
            'top_countries': top_countries,
            'recent_data': recent_data[:20],  # Limit for performance
            'all_data': filtered_data[:100],   # Limit for performance
            'timestamp': datetime.now().isoformat()
        })
        
    except Exception as e:
        logger.error(f"Fetch data error: {e}")
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/stats', methods=['POST'])
def get_stats():
    """Get statistics for specific filters"""
    try:
        data = request.get_json()
        cookie_string = data.get('cookies', '')
        service_filter = data.get('service', '').lower()
        country_filter = data.get('country', '').lower()
        
        # Parse cookies
        parser = CookieParser()
        cookies = parser.parse_cookie_string(cookie_string)
        
        # Fetch data
        client = IVASClient(cookies)
        sms_data = client.fetch_sms_data()
        
        # Apply filters
        filtered_data = []
        for item in sms_data:
            item_service = item.get('service', '').lower()
            item_country = item.get('country', '').lower()
            
            # Check if matches filters
            service_match = not service_filter or service_filter in item_service
            country_match = not country_filter or country_filter in item_country
            
            if service_match and country_match:
                # Check if it's social media
                if any(keyword in item_service for keyword in ['facebook', 'instagram', 'whatsapp']):
                    filtered_data.append(item)
        
        # Calculate detailed stats
        stats = {
            'total': len(filtered_data),
            'by_service': {},
            'by_country': {},
            'by_hour': {},
            'ranges': set()
        }
        
        for item in filtered_data:
            service = item['service']
            country = item['country']
            sms_range = item.get('range', 'N/A')
            
            # Service stats
            stats['by_service'][service] = stats['by_service'].get(service, 0) + 1
            
            # Country stats
            stats['by_country'][country] = stats['by_country'].get(country, 0) + 1
            
            # Range stats
            if sms_range and sms_range != 'N/A':
                stats['ranges'].add(sms_range)
            
            # Hourly stats
            try:
                hour = datetime.fromisoformat(item['timestamp'].replace('Z', '+00:00')).hour
                stats['by_hour'][hour] = stats['by_hour'].get(hour, 0) + 1
            except:
                pass
        
        return jsonify({
            'success': True,
            'stats': stats,
            'ranges': list(stats['ranges'])[:20]  # Limit ranges
        })
        
    except Exception as e:
        logger.error(f"Stats error: {e}")
        return jsonify({'success': False, 'error': str(e)})

@app.route('/health')
def health():
    """Health check endpoint"""
    return jsonify({'status': 'healthy', 'timestamp': datetime.now().isoformat()})

if __name__ == '__main__':
    app.run(debug=True, port=5000, host='0.0.0.0')