from flask import Flask, request, jsonify, render_template
from flask_login import LoginManager, UserMixin, login_user, login_required, logout_user, current_user
import cloudscraper
from bs4 import BeautifulSoup
import json, os, re, time, threading, gzip, brotli, csv, io, base64
from datetime import datetime, timedelta
from collections import defaultdict, deque
import sqlite3
import bcrypt

app = Flask(__name__)
app.secret_key = os.urandom(24)
login_manager = LoginManager()
login_manager.init_app(app)

BASE_URL = "https://www.ivasms.com"
DB_FILE = "smsgateway.db"

# --------------------- DATABASE SETUP ---------------------
def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL)''')
    c.execute('''CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    country TEXT, number TEXT, service TEXT, message TEXT, range_id TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS trend_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    minute_bucket TEXT UNIQUE, msg_count INTEGER)''')
    c.execute('''CREATE TABLE IF NOT EXISTS cookies (
                    id INTEGER PRIMARY KEY CHECK (id = 1), content TEXT)''')
    conn.commit()
    conn.close()

init_db()

# --------------------- IN‑MEMORY STORE ---------------------
class InMemoryStore:
    def __init__(self):
        self.live_messages = deque(maxlen=200)
        self.minute_counts = deque(maxlen=60)
        self.range_activity = defaultdict(list)
        self.service_counts = defaultdict(int)
        self.country_counts = defaultdict(int)
        self.last_fetch_time = None

store = InMemoryStore()

# --------------------- IVAS CLIENT (DATA LAYER) ---------------------
class IVASClient:
    def __init__(self):
        self.scraper = cloudscraper.create_scraper()
        self.logged_in = False
        self.csrf_token = None
        self.scraper.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "text/html,application/xhtml+xml"
        })

    def login(self):
        try:
            conn = sqlite3.connect(DB_FILE)
            c = conn.cursor()
            c.execute("SELECT content FROM cookies WHERE id = 1")
            row = c.fetchone()
            conn.close()
            if not row:
                return False
            cookies_raw = json.loads(row[0])

            # Normalize to list of cookie objects
            if isinstance(cookies_raw, dict):
                cookie_list = [{'name': k, 'value': v} for k, v in cookies_raw.items()]
            elif isinstance(cookies_raw, list):
                cookie_list = cookies_raw
            else:
                return False

            # Set each cookie with its original domain (fallback to www.ivasms.com)
            for c in cookie_list:
                name = c.get('name')
                value = c.get('value')
                domain = c.get('domain', 'www.ivasms.com')
                if name and value:
                    self.scraper.cookies.set(name, value, domain=domain)

            # Verify login by accessing a protected page
            r = self.scraper.get(f"{BASE_URL}/portal/sms/received")
            if r.status_code == 200:
                soup = BeautifulSoup(r.text, 'html.parser')
                token = soup.find("input", {"name": "_token"})
                if token:
                    self.csrf_token = token["value"]
                    self.logged_in = True
                    return True
            return False
        except Exception as e:
            print(f"Login error: {e}")
            return False

    def get_stats(self):
        if not self.logged_in:
            return None
        r = self.scraper.post(f"{BASE_URL}/portal/sms/received/getsms", data={"_token": self.csrf_token})
        soup = BeautifulSoup(r.text, 'html.parser')
        return {
            "total_sms": soup.select_one("#CountSMS").text if soup.select_one("#CountSMS") else "0",
            "paid_sms": soup.select_one("#PaidSMS").text if soup.select_one("#PaidSMS") else "0",
            "unpaid_sms": soup.select_one("#UnpaidSMS").text if soup.select_one("#UnpaidSMS") else "0",
            "revenue": soup.select_one("#RevenueSMS").text.replace(" USD", "") if soup.select_one("#RevenueSMS") else "0",
        }

    def get_range_numbers(self, range_id):
        if not self.logged_in:
            return None
        r = self.scraper.post(f"{BASE_URL}/portal/sms/received/getsms/number", data={"_token": self.csrf_token, "range": range_id})
        soup = BeautifulSoup(r.text, 'html.parser')
        numbers = []
        for item in soup.select(".card.card-body"):
            number_elem = item.select_one(".col-sm-4")
            count_elem = item.select_one(".col-3:nth-child(2) p")
            if number_elem:
                numbers.append({"number": number_elem.text.strip(), "count": count_elem.text.strip() if count_elem else "0"})
        return numbers

    def get_range_list(self):
        if not self.logged_in:
            return None
        r = self.scraper.get(f"{BASE_URL}/portal/numbers/test")
        soup = BeautifulSoup(r.text, 'html.parser')
        ranges = []
        for option in soup.select("select.form-select option"):
            val = option.get("value", "").strip()
            if val:
                ranges.append(val)
        return ranges

    def get_live_test_sms(self):
        if not self.logged_in:
            return None
        r = self.scraper.get(f"{BASE_URL}/portal/live/test_sms")
        soup = BeautifulSoup(r.text, 'html.parser')
        messages = []
        for row in soup.select("tr")[1:]:
            cols = row.select("td")
            if len(cols) >= 4:
                messages.append({
                    "country": cols[1].text.strip() if len(cols) > 1 else "",
                    "number": cols[2].text.strip() if len(cols) > 2 else "",
                    "service": cols[3].text.strip() if len(cols) > 3 else "",
                    "message": cols[4].text.strip() if len(cols) > 4 else ""
                })
        return messages

# --------------------- PROCESSING LAYER ---------------------
def normalize_service(raw):
    raw = raw.lower()
    mapping = {"facebook": "Facebook", "fb": "Facebook", "whatsapp": "WhatsApp",
               "telegram": "Telegram", "google": "Google", "instagram": "Instagram",
               "twitter": "Twitter/X", "tiktok": "TikTok", "snapchat": "Snapchat"}
    for key, val in mapping.items():
        if key in raw:
            return val
    return raw.title()

def extract_country_from_range(range_id):
    mapping = {"1":"US","91":"IN","44":"GB","49":"DE","55":"BR","7":"RU","86":"CN","81":"JP","82":"KR",
               "234":"NG","92":"PK","20":"EG","27":"ZA","52":"MX","54":"AR","62":"ID"}
    return mapping.get(range_id, range_id)

def process_live_message(msg, now=None):
    if now is None:
        now = datetime.now()
    service = normalize_service(msg.get("service", ""))
    country = msg.get("country", extract_country_from_range(msg.get("range", "")))
    range_id = msg.get("range", "")

    store.live_messages.append({
        "time": now.strftime("%H:%M:%S"), "country": country,
        "number": msg.get("number", ""), "service": service,
        "message": msg.get("message", "")
    })
    store.service_counts[service] += 1
    store.country_counts[country] += 1
    if range_id:
        store.range_activity[range_id].append(now)

    minute_key = now.replace(second=0, microsecond=0)
    if not store.minute_counts or store.minute_counts[-1][0] != minute_key:
        store.minute_counts.append([minute_key, 1])
    else:
        store.minute_counts[-1][1] += 1

    # Save to database
    conn = sqlite3.connect(DB_FILE)
    conn.execute("INSERT INTO messages (timestamp, country, number, service, message, range_id) VALUES (?,?,?,?,?,?)",
                 (now.isoformat(), country, msg.get("number",""), service, msg.get("message",""), range_id))
    conn.commit()
    conn.execute("INSERT INTO trend_log (minute_bucket, msg_count) VALUES (?,1) ON CONFLICT(minute_bucket) DO UPDATE SET msg_count = msg_count+1",
                 (minute_key.strftime("%Y-%m-%d %H:%M"),))
    conn.commit()
    conn.close()

# --------------------- INTELLIGENCE LAYER ---------------------
def get_top_ranges(n=5):
    now = datetime.now()
    window = timedelta(minutes=10)
    activity = {}
    for rng, times in store.range_activity.items():
        recent = sum(1 for t in times if now - t <= window)
        if recent > 0:
            activity[rng] = recent
    return sorted(activity.items(), key=lambda x: x[1], reverse=True)[:n]

def get_service_ranking():
    return sorted(store.service_counts.items(), key=lambda x: x[1], reverse=True)[:10]

def get_country_analytics():
    return sorted(store.country_counts.items(), key=lambda x: x[1], reverse=True)

def get_hot_ranges(threshold=3):
    now = datetime.now()
    window = timedelta(minutes=10)
    avg_per_range = {}
    for rng, times in store.range_activity.items():
        recent = [t for t in times if now - t <= window]
        if recent:
            avg_per_range[rng] = len(recent)
    if not avg_per_range:
        return []
    overall_avg = sum(avg_per_range.values()) / len(avg_per_range)
    hot = [{"range": rng, "count": cnt, "avg": overall_avg} for rng, cnt in avg_per_range.items() if cnt > overall_avg * threshold]
    return sorted(hot, key=lambda x: x['count'], reverse=True)[:5]

def get_trend_data():
    return [{"minute": t.strftime("%H:%M"), "count": c} for t, c in store.minute_counts]

def predict_next_hour():
    if len(store.minute_counts) < 5:
        return 0
    alpha = 0.3
    smoothed = store.minute_counts[0][1]
    for _, val in store.minute_counts[1:]:
        smoothed = alpha * val + (1 - alpha) * smoothed
    return round(smoothed, 1)

# --------------------- USER AUTH ---------------------
class User(UserMixin):
    def __init__(self, id, username):
        self.id = id
        self.username = username

@login_manager.user_loader
def load_user(user_id):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT id, username FROM users WHERE id = ?", (user_id,))
    row = c.fetchone()
    conn.close()
    return User(row[0], row[1]) if row else None

def create_default_admin():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT id FROM users WHERE username = 'admin'")
    if not c.fetchone():
        pwd = bcrypt.hashpw("admin123".encode('utf-8'), bcrypt.gensalt())
        c.execute("INSERT INTO users (username, password_hash) VALUES (?, ?)", ("admin", pwd))
        conn.commit()
    conn.close()

# --------------------- API ROUTES ---------------------
@app.route("/api/stats")
def stats():
    data = client.get_stats()
    if data:
        return jsonify(data)
    return jsonify({"error": "not authenticated"}), 401

@app.route("/api/live")
def live_feed():
    return jsonify(list(store.live_messages))

@app.route("/api/top-ranges")
def top_routes():
    return jsonify(get_top_ranges())

@app.route("/api/services")
def services_route():
    return jsonify(get_service_ranking())

@app.route("/api/countries")
def countries_route():
    return jsonify(get_country_analytics())

@app.route("/api/hot-ranges")
def hot_routes():
    return jsonify(get_hot_ranges())

@app.route("/api/trends")
def trends_route():
    return jsonify(get_trend_data())

@app.route("/api/prediction")
def prediction():
    return jsonify({"next_hour_prediction": predict_next_hour()})

@app.route("/api/range/list")
def list_ranges():
    ranges = client.get_range_list()
    if ranges:
        return jsonify(ranges)
    return jsonify({"error": "not authenticated"}), 401

@app.route("/api/range/<range_id>")
def range_detail(range_id):
    numbers = client.get_range_numbers(range_id)
    if numbers is not None:
        return jsonify({"range": range_id, "total": len(numbers), "numbers": numbers})
    return jsonify({"error": "not authenticated"}), 401

@app.route("/api/history")
def history():
    service = request.args.get("service","")
    number = request.args.get("number","")
    country = request.args.get("country","")
    from_date = request.args.get("from","")
    to_date = request.args.get("to","")
    limit = request.args.get("limit", 100, type=int)

    conn = sqlite3.connect(DB_FILE)
    query = "SELECT timestamp, country, number, service, message FROM messages WHERE 1=1"
    params = []
    if service:
        query += " AND service LIKE ?"
        params.append(f"%{service}%")
    if number:
        query += " AND number LIKE ?"
        params.append(f"%{number}%")
    if country:
        query += " AND country LIKE ?"
        params.append(f"%{country}%")
    if from_date:
        query += " AND timestamp >= ?"
        params.append(from_date)
    if to_date:
        query += " AND timestamp <= ?"
        params.append(to_date)
    query += " ORDER BY timestamp DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return jsonify([{"timestamp": r[0], "country": r[1], "number": r[2], "service": r[3], "message": r[4]} for r in rows])

@app.route("/api/export")
def export_data():
    fmt = request.args.get("format", "json")
    data = history()
    if fmt == "csv":
        si = io.StringIO()
        cw = csv.writer(si)
        cw.writerow(["Timestamp", "Country", "Number", "Service", "Message"])
        for row in data:
            cw.writerow([row['timestamp'], row['country'], row['number'], row['service'], row['message']])
        output = si.getvalue()
        return app.response_class(output, mimetype="text/csv",
                                  headers={"Content-Disposition": "attachment;filename=sms_export.csv"})
    return jsonify(data)

# --- Auth API ---
@app.route("/api/auth/status")
def auth_status():
    if current_user.is_authenticated:
        return jsonify({"authenticated": True, "username": current_user.username})
    return jsonify({"authenticated": False})

@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json()
    if not data:
        return jsonify({"error": "Invalid request"}), 400
    username = data.get("username", "")
    password = data.get("password", "").encode('utf-8')
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT id, username, password_hash FROM users WHERE username = ?", (username,))
    user_row = c.fetchone()
    conn.close()
    if user_row and bcrypt.checkpw(password, user_row[2]):
        user = User(user_row[0], user_row[1])
        login_user(user)
        return jsonify({"success": True, "username": username})
    return jsonify({"error": "Invalid credentials"}), 401

@app.route("/api/logout", methods=["POST"])
@login_required
def api_logout():
    logout_user()
    return jsonify({"success": True})

# --- Settings: Upload cookies (file OR paste) ---
@app.route("/api/settings/upload-cookies", methods=["POST"])
@login_required
def api_upload_cookies():
    content = None

    # File upload
    if 'cookies_file' in request.files:
        file = request.files['cookies_file']
        try:
            content = file.read().decode('utf-8')
        except:
            return jsonify({"error": "Could not read file"}), 400

    # Text paste
    elif request.form.get('cookies_text'):
        content = request.form['cookies_text'].strip()
        # Auto-detect base64
        if not content.startswith('[') and not content.startswith('{'):
            try:
                decoded = base64.b64decode(content).decode()
                content = decoded
            except:
                pass  # not base64, assume plain JSON

    if not content:
        return jsonify({"error": "No cookies provided"}), 400

    # Validate JSON
    try:
        cookies_raw = json.loads(content)
        if isinstance(cookies_raw, list):
            for item in cookies_raw:
                if 'name' not in item or 'value' not in item:
                    return jsonify({"error": "List items must have 'name' and 'value'"}), 400
    except json.JSONDecodeError:
        return jsonify({"error": "Invalid JSON format"}), 400

    # Store to DB
    conn = sqlite3.connect(DB_FILE)
    conn.execute("INSERT OR REPLACE INTO cookies (id, content) VALUES (1, ?)", (json.dumps(cookies_raw),))
    conn.commit()
    conn.close()

    # Re-login background client
    global client
    client = IVASClient()
    if not client.login():
        return jsonify({"success": True, "warning": "Cookies saved, but login failed. Check cookies."})
    return jsonify({"success": True})

# --------------------- MAIN PAGE ---------------------
@app.route("/")
@app.route("/login")
@app.route("/admin/settings")
def single_page_app():
    return render_template("index.html")

@app.route("/health")
def health():
    return jsonify({"status": "ok", "logged_in": client.logged_in})

# --------------------- BACKGROUND FETCHER ---------------------
def live_fetcher():
    global client
    while True:
        if client.logged_in:
            try:
                msgs = client.get_live_test_sms()
                if msgs:
                    for m in msgs:
                        process_live_message(m)
                    store.last_fetch_time = datetime.now()
            except Exception as e:
                print(f"Fetch error: {e}")
        time.sleep(5)

# --------------------- STARTUP ---------------------
if __name__ == "__main__":
    create_default_admin()
    client = IVASClient()
    if not client.login():
        print("WARNING: Initial login failed. Please upload cookies via admin panel.")
    t = threading.Thread(target=live_fetcher, daemon=True)
    t.start()
    app.run(host="0.0.0.0", port=5000, debug=False)
