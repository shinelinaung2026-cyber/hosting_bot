# -*- coding: utf-8 -*-
import telebot
import subprocess
import os
import zipfile
import tempfile
import shutil
from telebot import types
import time
from datetime import datetime, timedelta
import psutil
import sqlite3
import json
import logging
import signal
import threading
import re
import sys
import atexit
import requests

# --- Configuration for Render ---
TOKEN = os.getenv("BOT_TOKEN") or '8135908663:AAH8LI4t30GktfAXwiv667-j4IhsKRrb92Y'
OWNER_ID = int(os.getenv("OWNER_ID", "6786210764"))
ADMIN_ID = int(os.getenv("ADMIN_ID", "6786210764"))
YOUR_USERNAME = os.getenv("YOUR_USERNAME", "@shine_linaung")
UPDATE_CHANNEL = os.getenv("UPDATE_CHANNEL", "https://t.me/tglottery009")

# --- Flask for Webhook & Keep Alive ---
from flask import Flask, request
from threading import Thread

app = Flask('')

# --- Base Directories ---
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
UPLOAD_BOTS_DIR = os.path.join(BASE_DIR, 'upload_bots')
IROTECH_DIR = os.path.join(BASE_DIR, 'inf')
DATABASE_PATH = os.path.join(IROTECH_DIR, 'bot_data.db')

# Create directories
os.makedirs(UPLOAD_BOTS_DIR, exist_ok=True)
os.makedirs(IROTECH_DIR, exist_ok=True)

# --- Bot Initialization ---
bot = telebot.TeleBot(TOKEN, parse_mode='HTML')

# --- Constants ---
FREE_USER_LIMIT = 3
SUBSCRIBED_USER_LIMIT = 15
ADMIN_LIMIT = 999
OWNER_LIMIT = float('inf')

# --- Global Variables ---
bot_scripts = {}
user_subscriptions = {}
user_files = {}
active_users = set()
admin_ids = {ADMIN_ID, OWNER_ID}
bot_locked = False

# --- Logging Setup ---
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('bot.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# --- Menu Layouts ---
COMMAND_BUTTONS_LAYOUT_USER_SPEC = [
    ["📢 Updates Channel"],
    ["📤 Upload File", "📂 Check Files"],
    ["⚡ Bot Speed", "📊 Statistics"],
    ["📞 Contact Owner"]
]

ADMIN_COMMAND_BUTTONS_LAYOUT_USER_SPEC = [
    ["📢 Updates Channel"],
    ["📤 Upload File", "📂 Check Files"],
    ["⚡ Bot Speed", "📊 Statistics"],
    ["💳 Subscriptions", "📢 Broadcast"],
    ["🔒 Lock Bot", "🟢 Running All Code"],
    ["👑 Admin Panel", "📞 Contact Owner"]
]

# --- Python Module Mapping ---
PYTHON_MODULES = {
    'telebot': 'pyTelegramBotAPI',
    'telegram': 'python-telegram-bot',
    'python_telegram_bot': 'python-telegram-bot',
    'aiogram': 'aiogram',
    'pyrogram': 'pyrogram',
    'telethon': 'telethon',
    'pil': 'Pillow',
    'PIL': 'Pillow',
    'Image': 'Pillow',
    'ImageDraw': 'Pillow',
    'ImageFont': 'Pillow',
    'ImageFilter': 'Pillow',
    'bs4': 'beautifulsoup4',
    'requests': 'requests',
    'pillow': 'Pillow',
    'Pillow': 'Pillow',
    'cv2': 'opencv-python',
    'yaml': 'PyYAML',
    'dotenv': 'python-dotenv',
    'dateutil': 'python-dateutil',
    'pandas': 'pandas',
    'numpy': 'numpy',
    'flask': 'Flask',
    'django': 'Django',
    'sqlalchemy': 'SQLAlchemy',
    'psutil': 'psutil',
    'asyncio': None,
    'json': None,
    'datetime': None,
    'os': None,
    'sys': None,
    're': None,
    'time': None,
    'math': None,
    'random': None,
    'logging': None,
    'threading': None,
    'subprocess': None,
    'zipfile': None,
    'tempfile': None,
    'shutil': None,
    'sqlite3': None,
    'atexit': None
}

# ==================== DATABASE FUNCTIONS ====================
DB_LOCK = threading.Lock()

def init_db():
    """Initialize database and create tables"""
    logger.info(f"Initializing database at: {DATABASE_PATH}")
    try:
        conn = sqlite3.connect(DATABASE_PATH, check_same_thread=False)
        c = conn.cursor()
        
        # Subscriptions table
        c.execute('''CREATE TABLE IF NOT EXISTS subscriptions
                     (user_id INTEGER PRIMARY KEY, expiry TEXT)''')
        
        # User files table
        c.execute('''CREATE TABLE IF NOT EXISTS user_files
                     (user_id INTEGER, file_name TEXT, file_type TEXT,
                      PRIMARY KEY (user_id, file_name))''')
        
        # Active users table
        c.execute('''CREATE TABLE IF NOT EXISTS active_users
                     (user_id INTEGER PRIMARY KEY)''')
        
        # Admins table
        c.execute('''CREATE TABLE IF NOT EXISTS admins
                     (user_id INTEGER PRIMARY KEY)''')
        
        # Add owner and admin to admins table
        c.execute('INSERT OR IGNORE INTO admins (user_id) VALUES (?)', (OWNER_ID,))
        if ADMIN_ID != OWNER_ID:
            c.execute('INSERT OR IGNORE INTO admins (user_id) VALUES (?)', (ADMIN_ID,))
        
        conn.commit()
        conn.close()
        logger.info("Database initialized successfully.")
    except Exception as e:
        logger.error(f"Database initialization error: {e}", exc_info=True)

def load_data():
    """Load all data from database into memory"""
    logger.info("Loading data from database...")
    try:
        conn = sqlite3.connect(DATABASE_PATH, check_same_thread=False)
        c = conn.cursor()
        
        # Load subscriptions
        c.execute('SELECT user_id, expiry FROM subscriptions')
        for user_id, expiry in c.fetchall():
            try:
                user_subscriptions[user_id] = {'expiry': datetime.fromisoformat(expiry)}
            except ValueError:
                logger.warning(f"Invalid expiry date format for user {user_id}: {expiry}")
        
        # Load user files
        c.execute('SELECT user_id, file_name, file_type FROM user_files')
        for user_id, file_name, file_type in c.fetchall():
            if user_id not in user_files:
                user_files[user_id] = []
            user_files[user_id].append((file_name, file_type))
        
        # Load active users
        c.execute('SELECT user_id FROM active_users')
        active_users.update(user_id for (user_id,) in c.fetchall())
        
        # Load admins
        c.execute('SELECT user_id FROM admins')
        admin_ids.update(user_id for (user_id,) in c.fetchall())
        
        conn.close()
        logger.info(f"Data loaded: {len(active_users)} users, {len(user_subscriptions)} subscriptions, {len(admin_ids)} admins.")
    except Exception as e:
        logger.error(f"Error loading data: {e}", exc_info=True)

def save_user_file(user_id, file_name, file_type='py'):
    """Save user file record to database"""
    with DB_LOCK:
        conn = sqlite3.connect(DATABASE_PATH, check_same_thread=False)
        c = conn.cursor()
        try:
            c.execute('INSERT OR REPLACE INTO user_files (user_id, file_name, file_type) VALUES (?, ?, ?)',
                      (user_id, file_name, file_type))
            conn.commit()
            
            # Update memory
            if user_id not in user_files:
                user_files[user_id] = []
            user_files[user_id] = [(fn, ft) for fn, ft in user_files[user_id] if fn != file_name]
            user_files[user_id].append((file_name, file_type))
            
            logger.info(f"Saved file '{file_name}' ({file_type}) for user {user_id}")
        except Exception as e:
            logger.error(f"Error saving file for user {user_id}: {e}", exc_info=True)
        finally:
            conn.close()

def remove_user_file_db(user_id, file_name):
    """Remove user file record from database"""
    with DB_LOCK:
        conn = sqlite3.connect(DATABASE_PATH, check_same_thread=False)
        c = conn.cursor()
        try:
            c.execute('DELETE FROM user_files WHERE user_id = ? AND file_name = ?', (user_id, file_name))
            conn.commit()
            
            # Update memory
            if user_id in user_files:
                user_files[user_id] = [f for f in user_files[user_id] if f[0] != file_name]
                if not user_files[user_id]:
                    del user_files[user_id]
            
            logger.info(f"Removed file '{file_name}' for user {user_id}")
        except Exception as e:
            logger.error(f"Error removing file for user {user_id}: {e}", exc_info=True)
        finally:
            conn.close()

def add_active_user(user_id):
    """Add user to active users list"""
    active_users.add(user_id)
    with DB_LOCK:
        conn = sqlite3.connect(DATABASE_PATH, check_same_thread=False)
        c = conn.cursor()
        try:
            c.execute('INSERT OR IGNORE INTO active_users (user_id) VALUES (?)', (user_id,))
            conn.commit()
        except Exception as e:
            logger.error(f"Error adding active user {user_id}: {e}", exc_info=True)
        finally:
            conn.close()

def save_subscription(user_id, expiry):
    """Save subscription to database"""
    with DB_LOCK:
        conn = sqlite3.connect(DATABASE_PATH, check_same_thread=False)
        c = conn.cursor()
        try:
            expiry_str = expiry.isoformat()
            c.execute('INSERT OR REPLACE INTO subscriptions (user_id, expiry) VALUES (?, ?)', (user_id, expiry_str))
            conn.commit()
            user_subscriptions[user_id] = {'expiry': expiry}
            logger.info(f"Saved subscription for {user_id}, expiry {expiry_str}")
        except Exception as e:
            logger.error(f"Error saving subscription for {user_id}: {e}", exc_info=True)
        finally:
            conn.close()

def remove_subscription_db(user_id):
    """Remove subscription from database"""
    with DB_LOCK:
        conn = sqlite3.connect(DATABASE_PATH, check_same_thread=False)
        c = conn.cursor()
        try:
            c.execute('DELETE FROM subscriptions WHERE user_id = ?', (user_id,))
            conn.commit()
            if user_id in user_subscriptions:
                del user_subscriptions[user_id]
            logger.info(f"Removed subscription for {user_id}")
        except Exception as e:
            logger.error(f"Error removing subscription for {user_id}: {e}", exc_info=True)
        finally:
            conn.close()

def add_admin_db(admin_id):
    """Add admin to database"""
    with DB_LOCK:
        conn = sqlite3.connect(DATABASE_PATH, check_same_thread=False)
        c = conn.cursor()
        try:
            c.execute('INSERT OR IGNORE INTO admins (user_id) VALUES (?)', (admin_id,))
            conn.commit()
            admin_ids.add(admin_id)
            logger.info(f"Added admin {admin_id}")
        except Exception as e:
            logger.error(f"Error adding admin {admin_id}: {e}", exc_info=True)
        finally:
            conn.close()

def remove_admin_db(admin_id):
    """Remove admin from database"""
    if admin_id == OWNER_ID:
        logger.warning("Attempted to remove OWNER_ID from admins.")
        return False
    
    with DB_LOCK:
        conn = sqlite3.connect(DATABASE_PATH, check_same_thread=False)
        c = conn.cursor()
        try:
            c.execute('DELETE FROM admins WHERE user_id = ?', (admin_id,))
            conn.commit()
            admin_ids.discard(admin_id)
            logger.info(f"Removed admin {admin_id}")
            return True
        except Exception as e:
            logger.error(f"Error removing admin {admin_id}: {e}", exc_info=True)
            return False
        finally:
            conn.close()

# Initialize database on startup
init_db()
load_data()

# ==================== HELPER FUNCTIONS ====================

def get_user_folder(user_id):
    """Get user's folder path and create if not exists"""
    user_folder = os.path.join(UPLOAD_BOTS_DIR, str(user_id))
    os.makedirs(user_folder, exist_ok=True)
    return user_folder

def get_user_file_limit(user_id):
    """Get file limit for user based on status"""
    if user_id == OWNER_ID:
        return OWNER_LIMIT
    if user_id in admin_ids:
        return ADMIN_LIMIT
    if user_id in user_subscriptions and user_subscriptions[user_id]['expiry'] > datetime.now():
        return SUBSCRIBED_USER_LIMIT
    return FREE_USER_LIMIT

def get_user_file_count(user_id):
    """Get number of files uploaded by user"""
    return len(user_files.get(user_id, []))

def is_bot_running(script_owner_id, file_name):
    """Check if a specific bot script is running"""
    script_key = f"{script_owner_id}_{file_name}"
    script_info = bot_scripts.get(script_key)
    
    if script_info and script_info.get('process'):
        try:
            proc = psutil.Process(script_info['process'].pid)
            is_running = proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE
            
            if not is_running:
                logger.warning(f"Process {script_info['process'].pid} for {script_key} not running. Cleaning up.")
                if 'log_file' in script_info and hasattr(script_info['log_file'], 'close') and not script_info['log_file'].closed:
                    try:
                        script_info['log_file'].close()
                    except Exception:
                        pass
                if script_key in bot_scripts:
                    del bot_scripts[script_key]
            
            return is_running
        except psutil.NoSuchProcess:
            logger.warning(f"Process for {script_key} not found. Cleaning up.")
            if 'log_file' in script_info and hasattr(script_info['log_file'], 'close') and not script_info['log_file'].closed:
                try:
                    script_info['log_file'].close()
                except Exception:
                    pass
            if script_key in bot_scripts:
                del bot_scripts[script_key]
            return False
        except Exception as e:
            logger.error(f"Error checking process for {script_key}: {e}")
            return False
    
    return False

def kill_process_tree(process_info):
    """Kill process and all its children"""
    pid = None
    script_key = process_info.get('script_key', 'N/A')
    
    try:
        # Close log file
        if 'log_file' in process_info and hasattr(process_info['log_file'], 'close') and not process_info['log_file'].closed:
            try:
                process_info['log_file'].close()
                logger.info(f"Closed log file for {script_key}")
            except Exception as e:
                logger.error(f"Error closing log file: {e}")
        
        # Kill process tree
        process = process_info.get('process')
        if process and hasattr(process, 'pid'):
            pid = process.pid
            if pid:
                try:
                    parent = psutil.Process(pid)
                    children = parent.children(recursive=True)
                    
                    # Kill children
                    for child in children:
                        try:
                            child.terminate()
                        except psutil.NoSuchProcess:
                            pass
                    
                    # Wait for children to terminate
                    gone, alive = psutil.wait_procs(children, timeout=2)
                    
                    # Kill any remaining children
                    for p in alive:
                        try:
                            p.kill()
                        except:
                            pass
                    
                    # Kill parent
                    try:
                        parent.terminate()
                        parent.wait(timeout=2)
                    except psutil.TimeoutExpired:
                        parent.kill()
                    except psutil.NoSuchProcess:
                        pass
                    
                    logger.info(f"Killed process tree for {script_key} (PID: {pid})")
                except psutil.NoSuchProcess:
                    logger.warning(f"Process {pid} for {script_key} not found")
    except Exception as e:
        logger.error(f"Error killing process tree for {script_key}: {e}")

def attempt_install_pip(module_name, message):
    """Attempt to install missing Python module"""
    package_name = PYTHON_MODULES.get(module_name.lower(), module_name)
    
    if package_name is None:
        logger.info(f"Module '{module_name}' is core. Skipping pip install.")
        return False
    
    try:
        bot.reply_to(message, f"🐍 Module `{module_name}` not found. Installing `{package_name}`...", parse_mode='Markdown')
        
        command = [sys.executable, '-m', 'pip', 'install', package_name]
        logger.info(f"Running install: {' '.join(command)}")
        
        result = subprocess.run(command, capture_output=True, text=True, check=False, encoding='utf-8', errors='ignore')
        
        if result.returncode == 0:
            logger.info(f"Installed {package_name}")
            bot.reply_to(message, f"✅ Package `{package_name}` installed.", parse_mode='Markdown')
            return True
        else:
            error_msg = f"❌ Failed to install `{package_name}`.\nLog:\n```\n{result.stderr[:500]}\n```"
            bot.reply_to(message, error_msg, parse_mode='Markdown')
            return False
    except Exception as e:
        error_msg = f"❌ Error installing `{package_name}`: {str(e)}"
        logger.error(error_msg, exc_info=True)
        bot.reply_to(message, error_msg)
        return False

def run_script(script_path, script_owner_id, user_folder, file_name, message_obj_for_reply, attempt=1):
    """Run Python script with proper error handling"""
    max_attempts = 2
    
    if attempt > max_attempts:
        bot.reply_to(message_obj_for_reply, f"❌ Failed to run '{file_name}' after {max_attempts} attempts. Check logs.")
        return
    
    script_key = f"{script_owner_id}_{file_name}"
    logger.info(f"Attempt {attempt} to run Python script: {script_path} for user {script_owner_id}")
    
    try:
        if not os.path.exists(script_path):
            bot.reply_to(message_obj_for_reply, f"❌ Error: Script '{file_name}' not found!")
            if script_owner_id in user_files:
                user_files[script_owner_id] = [f for f in user_files[script_owner_id] if f[0] != file_name]
            remove_user_file_db(script_owner_id, file_name)
            return
        
        script_dir = os.path.dirname(script_path)
        
        # Check for missing modules
        if attempt == 1:
            check_command = [sys.executable, '-c', f"import {os.path.splitext(file_name)[0]}"]
            check_proc = None
            
            try:
                check_proc = subprocess.Popen(check_command, cwd=script_dir,
                                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                              text=True, encoding='utf-8', errors='ignore')
                stdout, stderr = check_proc.communicate(timeout=5)
                
                if check_proc.returncode != 0 and stderr:
                    match_py = re.search(r"ModuleNotFoundError: No module named '(.+?)'", stderr)
                    if match_py:
                        module_name = match_py.group(1).strip().strip("'\"")
                        logger.info(f"Detected missing Python module: {module_name}")
                        
                        if attempt_install_pip(module_name, message_obj_for_reply):
                            logger.info(f"Install OK for {module_name}. Retrying...")
                            bot.reply_to(message_obj_for_reply, f"🔄 Install successful. Retrying '{file_name}'...")
                            time.sleep(2)
                            threading.Thread(target=run_script,
                                             args=(script_path, script_owner_id, user_folder, file_name,
                                                   message_obj_for_reply, attempt + 1)).start()
                            return
                        else:
                            bot.reply_to(message_obj_for_reply, f"❌ Install failed. Cannot run '{file_name}'.")
                            return
            except subprocess.TimeoutExpired:
                logger.info("Pre-check timed out, imports likely OK")
                if check_proc and check_proc.poll() is None:
                    check_proc.kill()
                    check_proc.communicate()
            except Exception as e:
                logger.error(f"Error in pre-check: {e}")
            finally:
                if check_proc and check_proc.poll() is None:
                    check_proc.kill()
                    check_proc.communicate()
        
        # Start long-running process
        logger.info(f"Starting long-running Python process for {script_key}")
        
        log_filename = f"{os.path.splitext(os.path.basename(file_name))[0]}.log"
        log_file_path = os.path.join(script_dir, log_filename)
        
        try:
            log_file = open(log_file_path, 'w', encoding='utf-8', errors='ignore')
        except Exception as e:
            logger.error(f"Failed to open log file: {e}")
            bot.reply_to(message_obj_for_reply, f"❌ Failed to open log file: {e}")
            return
        
        try:
            startupinfo = None
            creationflags = 0
            
            if os.name == 'nt':
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startupinfo.wShowWindow = subprocess.SW_HIDE
            
            process = subprocess.Popen(
                [sys.executable, script_path],
                cwd=script_dir,
                stdout=log_file,
                stderr=log_file,
                stdin=subprocess.PIPE,
                startupinfo=startupinfo,
                creationflags=creationflags,
                encoding='utf-8',
                errors='ignore'
            )
            
            logger.info(f"Started Python process {process.pid} for {script_key}")
            
            bot_scripts[script_key] = {
                'process': process,
                'log_file': log_file,
                'file_name': file_name,
                'chat_id': message_obj_for_reply.chat.id,
                'script_owner_id': script_owner_id,
                'start_time': datetime.now(),
                'user_folder': user_folder,
                'type': 'py',
                'script_key': script_key
            }
            
            bot.reply_to(message_obj_for_reply,
                         f"✅ Python script '{file_name}' started! (PID: {process.pid})")
        except FileNotFoundError:
            logger.error(f"Python interpreter not found")
            bot.reply_to(message_obj_for_reply, f"❌ Error: Python interpreter not found.")
            if log_file and not log_file.closed:
                log_file.close()
        except Exception as e:
            if log_file and not log_file.closed:
                log_file.close()
            error_msg = f"❌ Error starting Python script: {str(e)}"
            logger.error(error_msg, exc_info=True)
            bot.reply_to(message_obj_for_reply, error_msg)
            if script_key in bot_scripts:
                del bot_scripts[script_key]
    except Exception as e:
        error_msg = f"❌ Unexpected error: {str(e)}"
        logger.error(error_msg, exc_info=True)
        bot.reply_to(message_obj_for_reply, error_msg)

def handle_zip_file(downloaded_file_content, file_name_zip, message):
    """Handle ZIP file upload - extract and process"""
    user_id = message.from_user.id
    user_folder = get_user_folder(user_id)
    temp_dir = None
    
    try:
        temp_dir = tempfile.mkdtemp(prefix=f"user_{user_id}_zip_")
        logger.info(f"Temp dir for zip: {temp_dir}")
        
        zip_path = os.path.join(temp_dir, file_name_zip)
        with open(zip_path, 'wb') as new_file:
            new_file.write(downloaded_file_content)
        
        # Extract zip
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            # Security check for path traversal
            for member in zip_ref.infolist():
                member_path = os.path.abspath(os.path.join(temp_dir, member.filename))
                if not member_path.startswith(os.path.abspath(temp_dir)):
                    raise zipfile.BadZipFile(f"Zip has unsafe path: {member.filename}")
            
            zip_ref.extractall(temp_dir)
            logger.info(f"Extracted zip to {temp_dir}")
        
        # Find all files
        all_files = []
        for root, dirs, files in os.walk(temp_dir):
            for file in files:
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, temp_dir)
                all_files.append((rel_path, file))
        
        # Install requirements.txt if exists
        req_files = [rel_path for rel_path, filename in all_files if filename == 'requirements.txt']
        for req_file in req_files:
            req_full_path = os.path.join(temp_dir, req_file)
            logger.info(f"requirements.txt found at {req_file}, installing...")
            bot.reply_to(message, f"🔄 Installing Python deps from `{req_file}`...")
            
            try:
                command = [sys.executable, '-m', 'pip', 'install', '-r', req_full_path]
                result = subprocess.run(command, capture_output=True, text=True, check=True, encoding='utf-8', errors='ignore')
                logger.info(f"pip install from requirements.txt OK")
                bot.reply_to(message, f"✅ Python deps from `{req_file}` installed.")
            except subprocess.CalledProcessError as e:
                error_msg = f"❌ Failed to install Python deps.\nLog:\n```\n{e.stderr[:500]}\n```"
                bot.reply_to(message, error_msg, parse_mode='Markdown')
                return
            except Exception as e:
                error_msg = f"❌ Unexpected error: {e}"
                logger.error(error_msg, exc_info=True)
                bot.reply_to(message, error_msg)
                return
        
        # Find Python files
        py_files = [rel_path for rel_path, filename in all_files if filename.endswith('.py')]
        if not py_files:
            bot.reply_to(message, "❌ No `.py` files found in archive!")
            return
        
        # Determine main script
        main_script_rel = None
        preferred_py = ['main.py', 'bot.py', 'app.py', 'index.py', 'run.py', 'telegram_bot.py']
        
        for preferred in preferred_py:
            matches = [rel_path for rel_path in py_files if os.path.basename(rel_path) == preferred]
            if matches:
                main_script_rel = min(matches, key=lambda x: x.count(os.sep))
                break
        
        if not main_script_rel:
            main_script_rel = min(py_files, key=lambda x: x.count(os.sep))
        
        # Move files to user folder
        logger.info(f"Moving extracted files to {user_folder}")
        moved_count = 0
        
        for rel_path, filename in all_files:
            src_path = os.path.join(temp_dir, rel_path)
            dest_path = os.path.join(user_folder, rel_path)
            dest_dir = os.path.dirname(dest_path)
            
            os.makedirs(dest_dir, exist_ok=True)
            
            if os.path.isdir(dest_path):
                shutil.rmtree(dest_path)
            elif os.path.exists(dest_path):
                os.remove(dest_path)
            
            shutil.move(src_path, dest_path)
            moved_count += 1
        
        logger.info(f"Moved {moved_count} items to {user_folder}")
        
        # Save file record
        save_user_file(user_id, main_script_rel.replace(os.sep, '/'), 'py')
        
        # Start main script
        main_script_full_path = os.path.join(user_folder, main_script_rel)
        bot.reply_to(message, f"✅ Files extracted. Starting main script: `{main_script_rel}`...", parse_mode='Markdown')
        threading.Thread(target=run_script, args=(main_script_full_path, user_id, user_folder, main_script_rel.replace(os.sep, '/'), message)).start()
        
    except zipfile.BadZipFile as e:
        logger.error(f"Bad zip file: {e}")
        bot.reply_to(message, f"❌ Error: Invalid/corrupted ZIP. {e}")
    except Exception as e:
        logger.error(f"Error processing zip: {e}", exc_info=True)
        bot.reply_to(message, f"❌ Error processing zip: {str(e)}")
    finally:
        if temp_dir and os.path.exists(temp_dir):
            try:
                shutil.rmtree(temp_dir)
                logger.info(f"Cleaned temp dir: {temp_dir}")
            except Exception as e:
                logger.error(f"Failed to clean temp dir: {e}")

def handle_py_file(file_path, script_owner_id, user_folder, file_name, message):
    """Handle single Python file upload"""
    try:
        save_user_file(script_owner_id, file_name, 'py')
        threading.Thread(target=run_script, args=(file_path, script_owner_id, user_folder, file_name, message)).start()
    except Exception as e:
        logger.error(f"Error processing Python file: {e}", exc_info=True)
        bot.reply_to(message, f"❌ Error processing Python file: {str(e)}")

# ==================== MENU CREATION ====================

def create_main_menu_inline(user_id):
    """Create inline keyboard for main menu"""
    markup = types.InlineKeyboardMarkup(row_width=2)
    
    buttons = [
        types.InlineKeyboardButton('📢 Updates Channel', url=UPDATE_CHANNEL),
        types.InlineKeyboardButton('📤 Upload File', callback_data='upload'),
        types.InlineKeyboardButton('📂 Check Files', callback_data='check_files'),
        types.InlineKeyboardButton('⚡ Bot Speed', callback_data='speed'),
        types.InlineKeyboardButton('📞 Contact Owner', url=f'https://t.me/{YOUR_USERNAME.replace("@", "")}')
    ]
    
    if user_id in admin_ids:
        admin_buttons = [
            types.InlineKeyboardButton('💳 Subscriptions', callback_data='subscription'),
            types.InlineKeyboardButton('📊 Statistics', callback_data='stats'),
            types.InlineKeyboardButton('🔒 Lock Bot' if not bot_locked else '🔓 Unlock Bot',
                                     callback_data='lock_bot' if not bot_locked else 'unlock_bot'),
            types.InlineKeyboardButton('📢 Broadcast', callback_data='broadcast'),
            types.InlineKeyboardButton('👑 Admin Panel', callback_data='admin_panel'),
            types.InlineKeyboardButton('🟢 Run All Scripts', callback_data='run_all_scripts')
        ]
        
        markup.add(buttons[0])
        markup.add(buttons[1], buttons[2])
        markup.add(buttons[3], admin_buttons[0])
        markup.add(admin_buttons[1], admin_buttons[3])
        markup.add(admin_buttons[2], admin_buttons[5])
        markup.add(admin_buttons[4])
        markup.add(buttons[4])
    else:
        markup.add(buttons[0])
        markup.add(buttons[1], buttons[2])
        markup.add(buttons[3])
        markup.add(types.InlineKeyboardButton('📊 Statistics', callback_data='stats'))
        markup.add(buttons[4])
    
    return markup

def create_reply_keyboard_main_menu(user_id):
    """Create reply keyboard for main menu"""
    markup = types.ReplyKeyboardMarkup(resize_keyboard=True, row_width=2)
    
    layout_to_use = ADMIN_COMMAND_BUTTONS_LAYOUT_USER_SPEC if user_id in admin_ids else COMMAND_BUTTONS_LAYOUT_USER_SPEC
    
    for row_buttons_text in layout_to_use:
        markup.add(*[types.KeyboardButton(text) for text in row_buttons_text])
    
    return markup

def create_control_buttons(script_owner_id, file_name, is_running=True):
    """Create control buttons for file management"""
    markup = types.InlineKeyboardMarkup(row_width=2)
    
    if is_running:
        markup.row(
            types.InlineKeyboardButton("🔴 Stop", callback_data=f'stop_{script_owner_id}_{file_name}'),
            types.InlineKeyboardButton("🔄 Restart", callback_data=f'restart_{script_owner_id}_{file_name}')
        )
        markup.row(
            types.InlineKeyboardButton("🗑️ Delete", callback_data=f'delete_{script_owner_id}_{file_name}'),
            types.InlineKeyboardButton("📜 Logs", callback_data=f'logs_{script_owner_id}_{file_name}')
        )
    else:
        markup.row(
            types.InlineKeyboardButton("🟢 Start", callback_data=f'start_{script_owner_id}_{file_name}'),
            types.InlineKeyboardButton("🗑️ Delete", callback_data=f'delete_{script_owner_id}_{file_name}')
        )
        markup.row(
            types.InlineKeyboardButton("📜 Logs", callback_data=f'logs_{script_owner_id}_{file_name}')
        )
    
    markup.add(types.InlineKeyboardButton("🔙 Back to Files", callback_data='check_files'))
    
    return markup

def create_admin_panel():
    """Create admin panel keyboard"""
    markup = types.InlineKeyboardMarkup(row_width=2)
    markup.row(
        types.InlineKeyboardButton('➕ Add Admin', callback_data='add_admin'),
        types.InlineKeyboardButton('➖ Remove Admin', callback_data='remove_admin')
    )
    markup.row(types.InlineKeyboardButton('📋 List Admins', callback_data='list_admins'))
    markup.row(types.InlineKeyboardButton('🔙 Back to Main', callback_data='back_to_main'))
    return markup

def create_subscription_menu():
    """Create subscription management keyboard"""
    markup = types.InlineKeyboardMarkup(row_width=2)
    markup.row(
        types.InlineKeyboardButton('➕ Add Subscription', callback_data='add_subscription'),
        types.InlineKeyboardButton('➖ Remove Subscription', callback_data='remove_subscription')
    )
    markup.row(types.InlineKeyboardButton('🔍 Check Subscription', callback_data='check_subscription'))
    markup.row(types.InlineKeyboardButton('🔙 Back to Main', callback_data='back_to_main'))
    return markup

# ==================== MESSAGE HANDLERS ====================

@bot.message_handler(commands=['start', 'help'])
def command_send_welcome(message):
    """Handle /start and /help commands"""
    user_id = message.from_user.id
    chat_id = message.chat.id
    user_name = message.from_user.first_name
    user_username = message.from_user.username
    
    logger.info(f"Welcome request from user_id: {user_id}, username: @{user_username}")
    
    # Check if bot is locked
    if bot_locked and user_id not in admin_ids:
        bot.send_message(chat_id, "⚠️ Bot locked by admin. Try later.")
        return
    
    # Get user bio and photo
    user_bio = "No bio"
    photo_file_id = None
    
    try:
        user_bio = bot.get_chat(user_id).bio or "No bio"
    except Exception:
        pass
    
    try:
        user_profile_photos = bot.get_user_profile_photos(user_id, limit=1)
        if user_profile_photos.photos:
            photo_file_id = user_profile_photos.photos[0][-1].file_id
    except Exception:
        pass
    
    # Add to active users if new
    if user_id not in active_users:
        add_active_user(user_id)
        try:
            owner_notification = (f"🎉 New user!\n"
                                 f"👤 Name: {user_name}\n"
                                 f"✳️ User: @{user_username or 'N/A'}\n"
                                 f"🆔 ID: `{user_id}`\n"
                                 f"📝 Bio: {user_bio}")
            bot.send_message(OWNER_ID, owner_notification, parse_mode='Markdown')
            
            if photo_file_id:
                bot.send_photo(OWNER_ID, photo_file_id, caption=f"Pic of new user {user_id}")
        except Exception as e:
            logger.error(f"Failed to notify owner about new user: {e}")
    
    # Determine user status
    file_limit = get_user_file_limit(user_id)
    current_files = get_user_file_count(user_id)
    limit_str = str(file_limit) if file_limit != float('inf') else "Unlimited"
    
    expiry_info = ""
    
    if user_id == OWNER_ID:
        user_status = "👑 Owner"
    elif user_id in admin_ids:
        user_status = "🛡️ Admin"
    elif user_id in user_subscriptions:
        expiry_date = user_subscriptions[user_id].get('expiry')
        if expiry_date and expiry_date > datetime.now():
            user_status = "⭐ Premium"
            days_left = (expiry_date - datetime.now()).days
            expiry_info = f"\n⏳ Subscription expires in: {days_left} days"
        else:
            user_status = "🆓 Free User (Expired Sub)"
            remove_subscription_db(user_id)
    else:
        user_status = "🆓 Free User"
    
    # Create welcome message
    welcome_msg_text = (f"〽️ Welcome, {user_name}!\n\n"
                       f"🆔 Your User ID: `{user_id}`\n"
                       f"✳️ Username: `@{user_username or 'Not set'}`\n"
                       f"🔰 Your Status: {user_status}{expiry_info}\n"
                       f"📁 Files Uploaded: {current_files} / {limit_str}\n\n"
                       f"🤖 Host & run Python (`.py`) scripts only.\n"
                       f"   Upload single `.py` files or `.zip` archives.\n\n"
                       f"👇 Use buttons or type commands.")
    
    main_reply_markup = create_reply_keyboard_main_menu(user_id)
    
    try:
        if photo_file_id:
            bot.send_photo(chat_id, photo_file_id)
        bot.send_message(chat_id, welcome_msg_text, reply_markup=main_reply_markup, parse_mode='Markdown')
    except Exception as e:
        logger.error(f"Error sending welcome: {e}")
        bot.send_message(chat_id, welcome_msg_text, reply_markup=main_reply_markup, parse_mode='Markdown')

@bot.message_handler(commands=['status'])
def command_show_status(message):
    """Handle /status command"""
    _logic_statistics(message)

# Button text handlers
BUTTON_TEXT_TO_LOGIC = {
    "📢 Updates Channel": lambda msg: _logic_updates_channel(msg),
    "📤 Upload File": lambda msg: _logic_upload_file(msg),
    "📂 Check Files": lambda msg: _logic_check_files(msg),
    "⚡ Bot Speed": lambda msg: _logic_bot_speed(msg),
    "📞 Contact Owner": lambda msg: _logic_contact_owner(msg),
    "📊 Statistics": lambda msg: _logic_statistics(msg),
    "💳 Subscriptions": lambda msg: _logic_subscriptions_panel(msg),
    "📢 Broadcast": lambda msg: _logic_broadcast_init(msg),
    "🔒 Lock Bot": lambda msg: _logic_toggle_lock_bot(msg),
    "🟢 Running All Code": lambda msg: _logic_run_all_scripts(msg),
    "👑 Admin Panel": lambda msg: _logic_admin_panel(msg),
}

@bot.message_handler(func=lambda message: message.text in BUTTON_TEXT_TO_LOGIC)
def handle_button_text(message):
    """Handle button text commands"""
    logic_func = BUTTON_TEXT_TO_LOGIC.get(message.text)
    if logic_func:
        logic_func(message)
    else:
        logger.warning(f"Button text '{message.text}' matched but no logic func")

# Command handlers
@bot.message_handler(commands=['updateschannel'])
def command_updates_channel(message):
    _logic_updates_channel(message)

@bot.message_handler(commands=['uploadfile'])
def command_upload_file(message):
    _logic_upload_file(message)

@bot.message_handler(commands=['checkfiles'])
def command_check_files(message):
    _logic_check_files(message)

@bot.message_handler(commands=['botspeed'])
def command_bot_speed(message):
    _logic_bot_speed(message)

@bot.message_handler(commands=['contactowner'])
def command_contact_owner(message):
    _logic_contact_owner(message)

@bot.message_handler(commands=['subscriptions'])
def command_subscriptions(message):
    _logic_subscriptions_panel(message)

@bot.message_handler(commands=['statistics'])
def command_statistics(message):
    _logic_statistics(message)

@bot.message_handler(commands=['broadcast'])
def command_broadcast(message):
    _logic_broadcast_init(message)

@bot.message_handler(commands=['lockbot'])
def command_lock_bot(message):
    _logic_toggle_lock_bot(message)

@bot.message_handler(commands=['adminpanel'])
def command_admin_panel(message):
    _logic_admin_panel(message)

@bot.message_handler(commands=['runningallcode'])
def command_run_all_code(message):
    _logic_run_all_scripts(message)

@bot.message_handler(commands=['ping'])
def ping(message):
    """Ping command to check bot responsiveness"""
    start_ping_time = time.time()
    msg = bot.reply_to(message, "Pong!")
    latency = round((time.time() - start_ping_time) * 1000, 2)
    bot.edit_message_text(f"Pong! Latency: {latency} ms", message.chat.id, msg.message_id)

# Document handler for file uploads
@bot.message_handler(content_types=['document'])
def handle_file_upload_doc(message):
    """Handle document uploads (Python files or ZIP archives)"""
    user_id = message.from_user.id
    chat_id = message.chat.id
    doc = message.document
    
    logger.info(f"Doc from {user_id}: {doc.file_name} ({doc.mime_type}), Size: {doc.file_size}")
    
    # Check if bot is locked
    if bot_locked and user_id not in admin_ids:
        bot.reply_to(message, "⚠️ Bot locked, cannot accept files.")
        return
    
    # Check file limit
    file_limit = get_user_file_limit(user_id)
    current_files = get_user_file_count(user_id)
    
    if current_files >= file_limit:
        limit_str = str(file_limit) if file_limit != float('inf') else "Unlimited"
        bot.reply_to(message, f"⚠️ File limit ({current_files}/{limit_str}) reached. Delete files via /checkfiles.")
        return
    
    file_name = doc.file_name
    
    if not file_name:
        bot.reply_to(message, "⚠️ No file name. Ensure file has a name.")
        return
    
    # Check file extension
    file_ext = os.path.splitext(file_name)[1].lower()
    if file_ext not in ['.py', '.zip']:
        bot.reply_to(message, "⚠️ Unsupported type! Only `.py` or `.zip` files allowed.")
        return
    
    # Check file size (20MB limit)
    max_file_size = 20 * 1024 * 1024
    if doc.file_size > max_file_size:
        bot.reply_to(message, f"⚠️ File too large (Max: {max_file_size // 1024 // 1024} MB).")
        return
    
    try:
        # Forward to owner
        try:
            bot.forward_message(OWNER_ID, chat_id, message.message_id)
            bot.send_message(OWNER_ID, f"⬆️ File '{file_name}' from {message.from_user.first_name} (`{user_id}`)", parse_mode='Markdown')
        except Exception as e:
            logger.error(f"Failed to forward uploaded file to owner: {e}")
        
        # Download file
        download_wait_msg = bot.reply_to(message, f"⏳ Downloading `{file_name}`...")
        file_info_tg_doc = bot.get_file(doc.file_id)
        downloaded_file_content = bot.download_file(file_info_tg_doc.file_path)
        
        bot.edit_message_text(f"✅ Downloaded `{file_name}`. Processing...", chat_id, download_wait_msg.message_id)
        logger.info(f"Downloaded {file_name} for user {user_id}")
        
        user_folder = get_user_folder(user_id)
        
        if file_ext == '.zip':
            handle_zip_file(downloaded_file_content, file_name, message)
        else:  # .py file
            file_path = os.path.join(user_folder, file_name)
            with open(file_path, 'wb') as f:
                f.write(downloaded_file_content)
            logger.info(f"Saved single file to {file_path}")
            handle_py_file(file_path, user_id, user_folder, file_name, message)
            
    except telebot.apihelper.ApiTelegramException as e:
        logger.error(f"Telegram API Error: {e}")
        if "file is too big" in str(e).lower():
            bot.reply_to(message, f"❌ File too large to download (~20MB limit).")
        else:
            bot.reply_to(message, f"❌ Telegram API Error: {str(e)}. Try later.")
    except Exception as e:
        logger.error(f"Error handling file: {e}", exc_info=True)
        bot.reply_to(message, f"❌ Unexpected error: {str(e)}")

# ==================== LOGIC FUNCTIONS ====================

def _logic_updates_channel(message):
    """Send updates channel link"""
    markup = types.InlineKeyboardMarkup()
    markup.add(types.InlineKeyboardButton('📢 Updates Channel', url=UPDATE_CHANNEL))
    bot.reply_to(message, "Visit our Updates Channel:", reply_markup=markup)

def _logic_upload_file(message):
    """Prompt user to upload file"""
    user_id = message.from_user.id
    
    if bot_locked and user_id not in admin_ids:
        bot.reply_to(message, "⚠️ Bot locked by admin, cannot accept files.")
        return
    
    file_limit = get_user_file_limit(user_id)
    current_files = get_user_file_count(user_id)
    
    if current_files >= file_limit:
        limit_str = str(file_limit) if file_limit != float('inf') else "Unlimited"
        bot.reply_to(message, f"⚠️ File limit ({current_files}/{limit_str}) reached. Delete files first.")
        return
    
    bot.reply_to(message, "📤 Send your Python (`.py`) or ZIP (`.zip`) file.")

def _logic_check_files(message):
    """Show user's uploaded files"""
    user_id = message.from_user.id
    user_files_list = user_files.get(user_id, [])
    
    if not user_files_list:
        bot.reply_to(message, "📂 Your files:\n\n(No files uploaded yet)")
        return
    
    markup = types.InlineKeyboardMarkup(row_width=1)
    
    for file_name, file_type in sorted(user_files_list):
        is_running = is_bot_running(user_id, file_name)
        status_icon = "🟢 Running" if is_running else "🔴 Stopped"
        btn_text = f"{file_name} ({file_type}) - {status_icon}"
        markup.add(types.InlineKeyboardButton(btn_text, callback_data=f'file_{user_id}_{file_name}'))
    
    bot.reply_to(message, "📂 Your files:\nClick to manage.", reply_markup=markup, parse_mode='Markdown')

def _logic_bot_speed(message):
    """Check bot response speed"""
    user_id = message.from_user.id
    chat_id = message.chat.id
    
    start_time_ping = time.time()
    wait_msg = bot.reply_to(message, "🏃 Testing speed...")
    
    try:
        bot.send_chat_action(chat_id, 'typing')
        response_time = round((time.time() - start_time_ping) * 1000, 2)
        
        status = "🔓 Unlocked" if not bot_locked else "🔒 Locked"
        
        if user_id == OWNER_ID:
            user_level = "👑 Owner"
        elif user_id in admin_ids:
            user_level = "🛡️ Admin"
        elif user_id in user_subscriptions and user_subscriptions[user_id].get('expiry', datetime.min) > datetime.now():
            user_level = "⭐ Premium"
        else:
            user_level = "🆓 Free User"
        
        speed_msg = (f"⚡ Bot Speed & Status:\n\n"
                    f"⏱️ API Response Time: {response_time} ms\n"
                    f"🚦 Bot Status: {status}\n"
                    f"👤 Your Level: {user_level}")
        
        bot.edit_message_text(speed_msg, chat_id, wait_msg.message_id)
    except Exception as e:
        logger.error(f"Error during speed test: {e}")
        bot.edit_message_text("❌ Error during speed test.", chat_id, wait_msg.message_id)

def _logic_contact_owner(message):
    """Send contact owner button"""
    markup = types.InlineKeyboardMarkup()
    markup.add(types.InlineKeyboardButton('📞 Contact Owner', url=f'https://t.me/{YOUR_USERNAME.replace("@", "")}'))
    bot.reply_to(message, "Click to contact Owner:", reply_markup=markup)

def _logic_subscriptions_panel(message):
    """Show subscription management panel (admin only)"""
    if message.from_user.id not in admin_ids:
        bot.reply_to(message, "⚠️ Admin permissions required.")
        return
    
    bot.reply_to(message, "💳 Subscription Management\nUse inline buttons from /start or admin command menu.",
                 reply_markup=create_subscription_menu())

def _logic_statistics(message):
    """Show bot statistics"""
    user_id = message.from_user.id
    
    total_users = len(active_users)
    total_files_records = sum(len(files) for files in user_files.values())
    
    running_bots_count = 0
    user_running_bots = 0
    
    for script_key, script_info in list(bot_scripts.items()):
        s_owner_id, _ = script_key.split('_', 1)
        if is_bot_running(int(s_owner_id), script_info['file_name']):
            running_bots_count += 1
            if int(s_owner_id) == user_id:
                user_running_bots += 1
    
    stats_msg_base = (f"📊 Bot Statistics:\n\n"
                     f"👥 Total Users: {total_users}\n"
                     f"📂 Total File Records: {total_files_records}\n"
                     f"🟢 Total Active Bots: {running_bots_count}\n")
    
    if user_id in admin_ids:
        stats_msg_admin = (f"🔒 Bot Status: {'🔴 Locked' if bot_locked else '🟢 Unlocked'}\n"
                          f"🤖 Your Running Bots: {user_running_bots}")
        stats_msg = stats_msg_base + stats_msg_admin
    else:
        stats_msg = stats_msg_base + f"🤖 Your Running Bots: {user_running_bots}"
    
    bot.reply_to(message, stats_msg)

def _logic_broadcast_init(message):
    """Initialize broadcast (admin only)"""
    if message.from_user.id not in admin_ids:
        bot.reply_to(message, "⚠️ Admin permissions required.")
        return
    
    msg = bot.reply_to(message, "📢 Send message to broadcast to all active users.\n/cancel to abort.")
    bot.register_next_step_handler(msg, process_broadcast_message)

def _logic_toggle_lock_bot(message):
    """Toggle bot lock status (admin only)"""
    if message.from_user.id not in admin_ids:
        bot.reply_to(message, "⚠️ Admin permissions required.")
        return
    
    global bot_locked
    bot_locked = not bot_locked
    status = "locked" if bot_locked else "unlocked"
    
    logger.warning(f"Bot {status} by Admin {message.from_user.id}")
    bot.reply_to(message, f"🔒 Bot has been {status}.")

def _logic_admin_panel(message):
    """Show admin panel (admin only)"""
    if message.from_user.id not in admin_ids:
        bot.reply_to(message, "⚠️ Admin permissions required.")
        return
    
    bot.reply_to(message, "👑 Admin Panel\nManage admins. Use inline buttons from /start or admin menu.",
                 reply_markup=create_admin_panel())

def _logic_run_all_scripts(message_or_call):
    """Run all user scripts (admin only)"""
    if isinstance(message_or_call, telebot.types.Message):
        admin_user_id = message_or_call.from_user.id
        admin_chat_id = message_or_call.chat.id
        reply_func = lambda text, **kwargs: bot.reply_to(message_or_call, text, **kwargs)
        admin_message_obj = message_or_call
    elif isinstance(message_or_call, telebot.types.CallbackQuery):
        admin_user_id = message_or_call.from_user.id
        admin_chat_id = message_or_call.message.chat.id
        bot.answer_callback_query(message_or_call.id)
        reply_func = lambda text, **kwargs: bot.send_message(admin_chat_id, text, **kwargs)
        admin_message_obj = message_or_call.message
    else:
        logger.error("Invalid argument for _logic_run_all_scripts")
        return
    
    if admin_user_id not in admin_ids:
        reply_func("⚠️ Admin permissions required.")
        return
    
    reply_func("⏳ Starting process to run all user scripts. This may take a while...")
    logger.info(f"Admin {admin_user_id} initiated 'run all scripts'")
    
    started_count = 0
    attempted_users = 0
    skipped_files = 0
    error_files_details = []
    
    all_user_files_snapshot = dict(user_files)
    
    for target_user_id, files_for_user in all_user_files_snapshot.items():
        if not files_for_user:
            continue
        
        attempted_users += 1
        logger.info(f"Processing scripts for user {target_user_id}...")
        user_folder = get_user_folder(target_user_id)
        
        for file_name, file_type in files_for_user:
            if not is_bot_running(target_user_id, file_name):
                file_path = os.path.join(user_folder, file_name)
                
                if os.path.exists(file_path):
                    logger.info(f"Admin {admin_user_id} starting '{file_name}' for user {target_user_id}")
                    
                    try:
                        if file_type == 'py':
                            threading.Thread(target=run_script, args=(file_path, target_user_id, user_folder, file_name, admin_message_obj)).start()
                            started_count += 1
                        else:
                            logger.warning(f"Unknown file type '{file_type}' for {file_name}")
                            error_files_details.append(f"`{file_name}` (User {target_user_id}) - Unknown type")
                            skipped_files += 1
                        
                        time.sleep(0.7)
                    except Exception as e:
                        logger.error(f"Error starting '{file_name}': {e}")
                        error_files_details.append(f"`{file_name}` (User {target_user_id}) - Start error")
                        skipped_files += 1
                else:
                    logger.warning(f"File '{file_name}' not found")
                    error_files_details.append(f"`{file_name}` (User {target_user_id}) - File not found")
                    skipped_files += 1
    
    summary_msg = (f"✅ All Users' Scripts - Processing Complete:\n\n"
                  f"▶️ Attempted to start: {started_count} scripts.\n"
                  f"👥 Users processed: {attempted_users}.\n")
    
    if skipped_files > 0:
        summary_msg += f"⚠️ Skipped/Error files: {skipped_files}\n"
        if error_files_details:
            summary_msg += "Details (first 5):\n" + "\n".join([f"  - {err}" for err in error_files_details[:5]])
            if len(error_files_details) > 5:
                summary_msg += "\n  ... and more (check logs)."
    
    reply_func(summary_msg, parse_mode='Markdown')
    logger.info(f"Run all scripts finished. Started: {started_count}. Skipped/Errors: {skipped_files}")

# ==================== CALLBACK HANDLERS ====================

@bot.callback_query_handler(func=lambda call: True)
def handle_callbacks(call):
    """Handle all inline button callbacks"""
    user_id = call.from_user.id
    data = call.data
    
    logger.info(f"Callback: User={user_id}, Data='{data}'")
    
    # Check if bot is locked (allow some basic actions)
    if bot_locked and user_id not in admin_ids and data not in ['back_to_main', 'speed', 'stats']:
        bot.answer_callback_query(call.id, "⚠️ Bot locked by admin.", show_alert=True)
        return
    
    try:
        # Main menu callbacks
        if data == 'upload':
            upload_callback(call)
        elif data == 'check_files':
            check_files_callback(call)
        elif data.startswith('file_'):
            file_control_callback(call)
        elif data.startswith('start_'):
            start_bot_callback(call)
        elif data.startswith('stop_'):
            stop_bot_callback(call)
        elif data.startswith('restart_'):
            restart_bot_callback(call)
        elif data.startswith('delete_'):
            delete_bot_callback(call)
        elif data.startswith('logs_'):
            logs_bot_callback(call)
        elif data == 'speed':
            speed_callback(call)
        elif data == 'back_to_main':
            back_to_main_callback(call)
        elif data.startswith('confirm_broadcast_'):
            handle_confirm_broadcast(call)
        elif data == 'cancel_broadcast':
            handle_cancel_broadcast(call)
        
        # Admin only callbacks
        elif data == 'subscription':
            admin_required_callback(call, subscription_management_callback)
        elif data == 'stats':
            stats_callback(call)
        elif data == 'lock_bot':
            admin_required_callback(call, lock_bot_callback)
        elif data == 'unlock_bot':
            admin_required_callback(call, unlock_bot_callback)
        elif data == 'run_all_scripts':
            admin_required_callback(call, run_all_scripts_callback)
        elif data == 'broadcast':
            admin_required_callback(call, broadcast_init_callback)
        elif data == 'admin_panel':
            admin_required_callback(call, admin_panel_callback)
        
        # Owner only callbacks
        elif data == 'add_admin':
            owner_required_callback(call, add_admin_init_callback)
        elif data == 'remove_admin':
            owner_required_callback(call, remove_admin_init_callback)
        elif data == 'list_admins':
            admin_required_callback(call, list_admins_callback)
        
        # Subscription management callbacks
        elif data == 'add_subscription':
            admin_required_callback(call, add_subscription_init_callback)
        elif data == 'remove_subscription':
            admin_required_callback(call, remove_subscription_init_callback)
        elif data == 'check_subscription':
            admin_required_callback(call, check_subscription_init_callback)
        
        else:
            bot.answer_callback_query(call.id, "Unknown action.")
            logger.warning(f"Unhandled callback data: {data}")
            
    except Exception as e:
        logger.error(f"Error handling callback '{data}': {e}", exc_info=True)
        try:
            bot.answer_callback_query(call.id, "Error processing request.", show_alert=True)
        except Exception:
            pass

def admin_required_callback(call, func_to_run):
    """Check admin permissions for callback"""
    if call.from_user.id not in admin_ids:
        bot.answer_callback_query(call.id, "⚠️ Admin permissions required.", show_alert=True)
        return
    func_to_run(call)

def owner_required_callback(call, func_to_run):
    """Check owner permissions for callback"""
    if call.from_user.id != OWNER_ID:
        bot.answer_callback_query(call.id, "⚠️ Owner permissions required.", show_alert=True)
        return
    func_to_run(call)

def upload_callback(call):
    """Handle upload button callback"""
    user_id = call.from_user.id
    
    file_limit = get_user_file_limit(user_id)
    current_files = get_user_file_count(user_id)
    
    if current_files >= file_limit:
        limit_str = str(file_limit) if file_limit != float('inf') else "Unlimited"
        bot.answer_callback_query(call.id, f"⚠️ File limit ({current_files}/{limit_str}) reached.", show_alert=True)
        return
    
    bot.answer_callback_query(call.id)
    bot.send_message(call.message.chat.id, "📤 Send your Python (`.py`) or ZIP (`.zip`) file.")

def check_files_callback(call):
    """Handle check files button callback"""
    user_id = call.from_user.id
    chat_id = call.message.chat.id
    
    user_files_list = user_files.get(user_id, [])
    
    if not user_files_list:
        bot.answer_callback_query(call.id, "⚠️ No files uploaded.", show_alert=True)
        try:
            markup = types.InlineKeyboardMarkup()
            markup.add(types.InlineKeyboardButton("🔙 Back to Main", callback_data='back_to_main'))
            bot.edit_message_text("📂 Your files:\n\n(No files uploaded)", chat_id, call.message.message_id, reply_markup=markup)
        except Exception as e:
            logger.error(f"Error editing msg for empty file list: {e}")
        return
    
    bot.answer_callback_query(call.id)
    
    markup = types.InlineKeyboardMarkup(row_width=1)
    
    for file_name, file_type in sorted(user_files_list):
        is_running = is_bot_running(user_id, file_name)
        status_icon = "🟢 Running" if is_running else "🔴 Stopped"
        btn_text = f"{file_name} ({file_type}) - {status_icon}"
        markup.add(types.InlineKeyboardButton(btn_text, callback_data=f'file_{user_id}_{file_name}'))
    
    markup.add(types.InlineKeyboardButton("🔙 Back to Main", callback_data='back_to_main'))
    
    try:
        bot.edit_message_text("📂 Your files:\nClick to manage.", chat_id, call.message.message_id, reply_markup=markup, parse_mode='Markdown')
    except telebot.apihelper.ApiTelegramException as e:
        if "message is not modified" in str(e):
            logger.warning("Msg not modified (files)")
        else:
            logger.error(f"Error editing msg: {e}")
    except Exception as e:
        logger.error(f"Unexpected error: {e}")

def file_control_callback(call):
    """Handle file control button callback"""
    try:
        _, script_owner_id_str, file_name = call.data.split('_', 2)
        script_owner_id = int(script_owner_id_str)
        requesting_user_id = call.from_user.id
        
        # Check permissions
        if not (requesting_user_id == script_owner_id or requesting_user_id in admin_ids):
            logger.warning(f"User {requesting_user_id} tried to access file of user {script_owner_id} without permission")
            bot.answer_callback_query(call.id, "⚠️ You can only manage your own files.", show_alert=True)
            check_files_callback(call)
            return
        
        # Check if file exists
        user_files_list = user_files.get(script_owner_id, [])
        if not any(f[0] == file_name for f in user_files_list):
            logger.warning(f"File '{file_name}' not found for user {script_owner_id}")
            bot.answer_callback_query(call.id, "⚠️ File not found.", show_alert=True)
            check_files_callback(call)
            return
        
        bot.answer_callback_query(call.id)
        
        is_running = is_bot_running(script_owner_id, file_name)
        status_text = '🟢 Running' if is_running else '🔴 Stopped'
        file_type = next((f[1] for f in user_files_list if f[0] == file_name), '?')
        
        try:
            bot.edit_message_text(
                f"⚙️ Controls for: `{file_name}` ({file_type}) of User `{script_owner_id}`\nStatus: {status_text}",
                call.message.chat.id, call.message.message_id,
                reply_markup=create_control_buttons(script_owner_id, file_name, is_running),
                parse_mode='Markdown'
            )
        except telebot.apihelper.ApiTelegramException as e:
            if "message is not modified" in str(e):
                logger.warning(f"Msg not modified (controls)")
            else:
                raise
    except Exception as e:
        logger.error(f"Error in file_control_callback: {e}", exc_info=True)
        bot.answer_callback_query(call.id, "An error occurred.", show_alert=True)

def start_bot_callback(call):
    """Handle start button callback"""
    try:
        _, script_owner_id_str, file_name = call.data.split('_', 2)
        script_owner_id = int(script_owner_id_str)
        requesting_user_id = call.from_user.id
        chat_id = call.message.chat.id
        
        # Check permissions
        if not (requesting_user_id == script_owner_id or requesting_user_id in admin_ids):
            bot.answer_callback_query(call.id, "⚠️ Permission denied.", show_alert=True)
            return
        
        # Check if file exists
        user_files_list = user_files.get(script_owner_id, [])
        file_info = next((f for f in user_files_list if f[0] == file_name), None)
        
        if not file_info:
            bot.answer_callback_query(call.id, "⚠️ File not found.", show_alert=True)
            check_files_callback(call)
            return
        
        file_type = file_info[1]
        user_folder = get_user_folder(script_owner_id)
        file_path = os.path.join(user_folder, file_name)
        
        if not os.path.exists(file_path):
            bot.answer_callback_query(call.id, f"⚠️ File missing! Re-upload.", show_alert=True)
            remove_user_file_db(script_owner_id, file_name)
            check_files_callback(call)
            return
        
        # Check if already running
        if is_bot_running(script_owner_id, file_name):
            bot.answer_callback_query(call.id, f"⚠️ Script already running.", show_alert=True)
            try:
                bot.edit_message_reply_markup(chat_id, call.message.message_id,
                                             reply_markup=create_control_buttons(script_owner_id, file_name, True))
            except Exception as e:
                logger.error(f"Error updating buttons: {e}")
            return
        
        bot.answer_callback_query(call.id, f"⏳ Starting {file_name}...")
        
        # Start script
        if file_type == 'py':
            threading.Thread(target=run_script, args=(file_path, script_owner_id, user_folder, file_name, call.message)).start()
        else:
            bot.send_message(chat_id, f"❌ Unknown file type '{file_type}'.")
            return
        
        time.sleep(1.5)
        
        # Update status
        is_now_running = is_bot_running(script_owner_id, file_name)
        status_text = '🟢 Running' if is_now_running else '🟡 Starting...'
        
        try:
            bot.edit_message_text(
                f"⚙️ Controls for: `{file_name}` ({file_type}) of User `{script_owner_id}`\nStatus: {status_text}",
                chat_id, call.message.message_id,
                reply_markup=create_control_buttons(script_owner_id, file_name, is_now_running),
                parse_mode='Markdown'
            )
        except Exception as e:
            logger.error(f"Error updating after start: {e}")
            
    except Exception as e:
        logger.error(f"Error in start_bot_callback: {e}", exc_info=True)
        bot.answer_callback_query(call.id, "Error starting script.", show_alert=True)

def stop_bot_callback(call):
    """Handle stop button callback"""
    try:
        _, script_owner_id_str, file_name = call.data.split('_', 2)
        script_owner_id = int(script_owner_id_str)
        requesting_user_id = call.from_user.id
        chat_id = call.message.chat.id
        
        # Check permissions
        if not (requesting_user_id == script_owner_id or requesting_user_id in admin_ids):
            bot.answer_callback_query(call.id, "⚠️ Permission denied.", show_alert=True)
            return
        
        # Check if file exists
        user_files_list = user_files.get(script_owner_id, [])
        file_info = next((f for f in user_files_list if f[0] == file_name), None)
        
        if not file_info:
            bot.answer_callback_query(call.id, "⚠️ File not found.", show_alert=True)
            check_files_callback(call)
            return
        
        file_type = file_info[1]
        script_key = f"{script_owner_id}_{file_name}"
        
        # Check if running
        if not is_bot_running(script_owner_id, file_name):
            bot.answer_callback_query(call.id, f"⚠️ Script already stopped.", show_alert=True)
            try:
                bot.edit_message_text(
                    f"⚙️ Controls for: `{file_name}` ({file_type}) of User `{script_owner_id}`\nStatus: 🔴 Stopped",
                    chat_id, call.message.message_id,
                    reply_markup=create_control_buttons(script_owner_id, file_name, False),
                    parse_mode='Markdown'
                )
            except Exception as e:
                logger.error(f"Error updating buttons: {e}")
            return
        
        bot.answer_callback_query(call.id, f"⏳ Stopping {file_name}...")
        
        # Stop script
        process_info = bot_scripts.get(script_key)
        if process_info:
            kill_process_tree(process_info)
            if script_key in bot_scripts:
                del bot_scripts[script_key]
                logger.info(f"Removed {script_key} from running")
        else:
            logger.warning(f"Script {script_key} running but not in bot_scripts dict")
        
        # Update status
        try:
            bot.edit_message_text(
                f"⚙️ Controls for: `{file_name}` ({file_type}) of User `{script_owner_id}`\nStatus: 🔴 Stopped",
                chat_id, call.message.message_id,
                reply_markup=create_control_buttons(script_owner_id, file_name, False),
                parse_mode='Markdown'
            )
        except Exception as e:
            logger.error(f"Error updating after stop: {e}")
            
    except Exception as e:
        logger.error(f"Error in stop_bot_callback: {e}", exc_info=True)
        bot.answer_callback_query(call.id, "Error stopping script.", show_alert=True)

def restart_bot_callback(call):
    """Handle restart button callback"""
    try:
        _, script_owner_id_str, file_name = call.data.split('_', 2)
        script_owner_id = int(script_owner_id_str)
        requesting_user_id = call.from_user.id
        chat_id = call.message.chat.id
        
        # Check permissions
        if not (requesting_user_id == script_owner_id or requesting_user_id in admin_ids):
            bot.answer_callback_query(call.id, "⚠️ Permission denied.", show_alert=True)
            return
        
        # Check if file exists
        user_files_list = user_files.get(script_owner_id, [])
        file_info = next((f for f in user_files_list if f[0] == file_name), None)
        
        if not file_info:
            bot.answer_callback_query(call.id, "⚠️ File not found.", show_alert=True)
            check_files_callback(call)
            return
        
        file_type = file_info[1]
        user_folder = get_user_folder(script_owner_id)
        file_path = os.path.join(user_folder, file_name)
        script_key = f"{script_owner_id}_{file_name}"
        
        if not os.path.exists(file_path):
            bot.answer_callback_query(call.id, f"⚠️ File missing!", show_alert=True)
            remove_user_file_db(script_owner_id, file_name)
            if script_key in bot_scripts:
                del bot_scripts[script_key]
            check_files_callback(call)
            return
        
        bot.answer_callback_query(call.id, f"⏳ Restarting {file_name}...")
        
        # Stop if running
        if is_bot_running(script_owner_id, file_name):
            logger.info(f"Restart: Stopping existing {script_key}")
            process_info = bot_scripts.get(script_key)
            if process_info:
                kill_process_tree(process_info)
            if script_key in bot_scripts:
                del bot_scripts[script_key]
            time.sleep(1.5)
        
        # Start
        logger.info(f"Restart: Starting script {script_key}")
        if file_type == 'py':
            threading.Thread(target=run_script, args=(file_path, script_owner_id, user_folder, file_name, call.message)).start()
        else:
            bot.send_message(chat_id, f"❌ Unknown type '{file_type}'.")
            return
        
        time.sleep(1.5)
        
        # Update status
        is_now_running = is_bot_running(script_owner_id, file_name)
        status_text = '🟢 Running' if is_now_running else '🟡 Starting...'
        
        try:
            bot.edit_message_text(
                f"⚙️ Controls for: `{file_name}` ({file_type}) of User `{script_owner_id}`\nStatus: {status_text}",
                chat_id, call.message.message_id,
                reply_markup=create_control_buttons(script_owner_id, file_name, is_now_running),
                parse_mode='Markdown'
            )
        except Exception as e:
            logger.error(f"Error updating after restart: {e}")
            
    except Exception as e:
        logger.error(f"Error in restart_bot_callback: {e}", exc_info=True)
        bot.answer_callback_query(call.id, "Error restarting.", show_alert=True)

def delete_bot_callback(call):
    """Handle delete button callback"""
    try:
        _, script_owner_id_str, file_name = call.data.split('_', 2)
        script_owner_id = int(script_owner_id_str)
        requesting_user_id = call.from_user.id
        chat_id = call.message.chat.id
        
        # Check permissions
        if not (requesting_user_id == script_owner_id or requesting_user_id in admin_ids):
            bot.answer_callback_query(call.id, "⚠️ Permission denied.", show_alert=True)
            return
        
        # Check if file exists
        user_files_list = user_files.get(script_owner_id, [])
        if not any(f[0] == file_name for f in user_files_list):
            bot.answer_callback_query(call.id, "⚠️ File not found.", show_alert=True)
            check_files_callback(call)
            return
        
        bot.answer_callback_query(call.id, f"🗑️ Deleting {file_name}...")
        
        script_key = f"{script_owner_id}_{file_name}"
        
        # Stop if running
        if is_bot_running(script_owner_id, file_name):
            logger.info(f"Delete: Stopping {script_key}")
            process_info = bot_scripts.get(script_key)
            if process_info:
                kill_process_tree(process_info)
            if script_key in bot_scripts:
                del bot_scripts[script_key]
            time.sleep(0.5)
        
        # Delete files
        user_folder = get_user_folder(script_owner_id)
        file_path = os.path.join(user_folder, file_name)
        log_path = os.path.join(user_folder, f"{os.path.splitext(file_name)[0]}.log")
        
        deleted_disk = []
        
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
                deleted_disk.append(file_name)
                logger.info(f"Deleted file: {file_path}")
            except OSError as e:
                logger.error(f"Error deleting {file_path}: {e}")
        
        if os.path.exists(log_path):
            try:
                os.remove(log_path)
                deleted_disk.append(os.path.basename(log_path))
                logger.info(f"Deleted log: {log_path}")
            except OSError as e:
                logger.error(f"Error deleting log {log_path}: {e}")
        
        # Remove from database
        remove_user_file_db(script_owner_id, file_name)
        
        deleted_str = ", ".join(f"`{f}`" for f in deleted_disk) if deleted_disk else "associated files"
        
        try:
            bot.edit_message_text(
                f"🗑️ Record `{file_name}` (User `{script_owner_id}`) and {deleted_str} deleted!",
                chat_id, call.message.message_id, reply_markup=None, parse_mode='Markdown'
            )
        except Exception as e:
            logger.error(f"Error editing after delete: {e}")
            bot.send_message(chat_id, f"🗑️ Record `{file_name}` deleted.", parse_mode='Markdown')
            
    except Exception as e:
        logger.error(f"Error in delete_bot_callback: {e}", exc_info=True)
        bot.answer_callback_query(call.id, "Error deleting.", show_alert=True)

def logs_bot_callback(call):
    """Handle logs button callback"""
    try:
        _, script_owner_id_str, file_name = call.data.split('_', 2)
        script_owner_id = int(script_owner_id_str)
        requesting_user_id = call.from_user.id
        chat_id = call.message.chat.id
        
        # Check permissions
        if not (requesting_user_id == script_owner_id or requesting_user_id in admin_ids):
            bot.answer_callback_query(call.id, "⚠️ Permission denied.", show_alert=True)
            return
        
        # Check if file exists
        user_files_list = user_files.get(script_owner_id, [])
        if not any(f[0] == file_name for f in user_files_list):
            bot.answer_callback_query(call.id, "⚠️ File not found.", show_alert=True)
            check_files_callback(call)
            return
        
        # Get log file
        user_folder = get_user_folder(script_owner_id)
        log_path = os.path.join(user_folder, f"{os.path.splitext(file_name)[0]}.log")
        
        if not os.path.exists(log_path):
            bot.answer_callback_query(call.id, f"⚠️ No logs for '{file_name}'.", show_alert=True)
            return
        
        bot.answer_callback_query(call.id)
        
        # Read log file
        try:
            log_content = ""
            file_size = os.path.getsize(log_path)
            max_log_kb = 100
            max_tg_msg = 4096
            
            if file_size == 0:
                log_content = "(Log empty)"
            elif file_size > max_log_kb * 1024:
                with open(log_path, 'rb') as f:
                    f.seek(-max_log_kb * 1024, os.SEEK_END)
                    log_bytes = f.read()
                log_content = log_bytes.decode('utf-8', errors='ignore')
                log_content = f"(Last {max_log_kb} KB)\n...\n" + log_content
            else:
                with open(log_path, 'r', encoding='utf-8', errors='ignore') as f:
                    log_content = f.read()
            
            # Truncate if too long
            if len(log_content) > max_tg_msg:
                log_content = log_content[-max_tg_msg:]
                first_nl = log_content.find('\n')
                if first_nl != -1:
                    log_content = "...\n" + log_content[first_nl+1:]
                else:
                    log_content = "...\n" + log_content
            
            if not log_content.strip():
                log_content = "(No visible content)"
            
            bot.send_message(chat_id, f"📜 Logs for `{file_name}` (User `{script_owner_id}`):\n```\n{log_content}\n```", parse_mode='Markdown')
        except Exception as e:
            logger.error(f"Error reading log: {e}")
            bot.send_message(chat_id, f"❌ Error reading log for `{file_name}`.")
            
    except Exception as e:
        logger.error(f"Error in logs_bot_callback: {e}", exc_info=True)
        bot.answer_callback_query(call.id, "Error fetching logs.", show_alert=True)

def speed_callback(call):
    """Handle speed test callback"""
    user_id = call.from_user.id
    chat_id = call.message.chat.id
    
    start_cb_ping_time = time.time()
    
    try:
        bot.edit_message_text("🏃 Testing speed...", chat_id, call.message.message_id)
        bot.send_chat_action(chat_id, 'typing')
        
        response_time = round((time.time() - start_cb_ping_time) * 1000, 2)
        status = "🔓 Unlocked" if not bot_locked else "🔒 Locked"
        
        if user_id == OWNER_ID:
            user_level = "👑 Owner"
        elif user_id in admin_ids:
            user_level = "🛡️ Admin"
        elif user_id in user_subscriptions and user_subscriptions[user_id].get('expiry', datetime.min) > datetime.now():
            user_level = "⭐ Premium"
        else:
            user_level = "🆓 Free User"
        
        speed_msg = (f"⚡ Bot Speed & Status:\n\n"
                    f"⏱️ API Response Time: {response_time} ms\n"
                    f"🚦 Bot Status: {status}\n"
                    f"👤 Your Level: {user_level}")
        
        bot.answer_callback_query(call.id)
        bot.edit_message_text(speed_msg, chat_id, call.message.message_id, reply_markup=create_main_menu_inline(user_id))
    except Exception as e:
        logger.error(f"Error in speed test: {e}")
        bot.answer_callback_query(call.id, "Error in speed test.", show_alert=True)
        try:
            bot.edit_message_text("〽️ Main Menu", chat_id, call.message.message_id, reply_markup=create_main_menu_inline(user_id))
        except Exception:
            pass

def back_to_main_callback(call):
    """Handle back to main button callback"""
    user_id = call.from_user.id
    chat_id = call.message.chat.id
    
    file_limit = get_user_file_limit(user_id)
    current_files = get_user_file_count(user_id)
    limit_str = str(file_limit) if file_limit != float('inf') else "Unlimited"
    
    expiry_info = ""
    
    if user_id == OWNER_ID:
        user_status = "👑 Owner"
    elif user_id in admin_ids:
        user_status = "🛡️ Admin"
    elif user_id in user_subscriptions:
        expiry_date = user_subscriptions[user_id].get('expiry')
        if expiry_date and expiry_date > datetime.now():
            user_status = "⭐ Premium"
            days_left = (expiry_date - datetime.now()).days
            expiry_info = f"\n⏳ Subscription expires in: {days_left} days"
        else:
            user_status = "🆓 Free User (Expired Sub)"
    else:
        user_status = "🆓 Free User"
    
    main_menu_text = (f"〽️ Welcome back, {call.from_user.first_name}!\n\n"
                     f"🆔 ID: `{user_id}`\n"
                     f"🔰 Status: {user_status}{expiry_info}\n"
                     f"📁 Files: {current_files} / {limit_str}\n\n"
                     f"👇 Use buttons or type commands.")
    
    try:
        bot.answer_callback_query(call.id)
        bot.edit_message_text(main_menu_text, chat_id, call.message.message_id,
                             reply_markup=create_main_menu_inline(user_id), parse_mode='Markdown')
    except telebot.apihelper.ApiTelegramException as e:
        if "message is not modified" in str(e):
            logger.warning("Msg not modified (back_to_main)")
        else:
            logger.error(f"API error: {e}")
    except Exception as e:
        logger.error(f"Error handling back_to_main: {e}")

def subscription_management_callback(call):
    """Handle subscription management callback"""
    bot.answer_callback_query(call.id)
    try:
        bot.edit_message_text("💳 Subscription Management\nSelect action:",
                             call.message.chat.id, call.message.message_id, 
                             reply_markup=create_subscription_menu())
    except Exception as e:
        logger.error(f"Error showing sub menu: {e}")

def stats_callback(call):
    """Handle statistics callback"""
    bot.answer_callback_query(call.id)
    _logic_statistics(call.message)
    try:
        bot.edit_message_reply_markup(call.message.chat.id, call.message.message_id,
                                     reply_markup=create_main_menu_inline(call.from_user.id))
    except Exception as e:
        logger.error(f"Error updating menu: {e}")

def lock_bot_callback(call):
    """Handle lock bot callback"""
    global bot_locked
    bot_locked = True
    logger.warning(f"Bot locked by Admin {call.from_user.id}")
    bot.answer_callback_query(call.id, "🔒 Bot locked.")
    try:
        bot.edit_message_reply_markup(call.message.chat.id, call.message.message_id,
                                     reply_markup=create_main_menu_inline(call.from_user.id))
    except Exception as e:
        logger.error(f"Error updating menu: {e}")

def unlock_bot_callback(call):
    """Handle unlock bot callback"""
    global bot_locked
    bot_locked = False
    logger.warning(f"Bot unlocked by Admin {call.from_user.id}")
    bot.answer_callback_query(call.id, "🔓 Bot unlocked.")
    try:
        bot.edit_message_reply_markup(call.message.chat.id, call.message.message_id,
                                     reply_markup=create_main_menu_inline(call.from_user.id))
    except Exception as e:
        logger.error(f"Error updating menu: {e}")

def run_all_scripts_callback(call):
    """Handle run all scripts callback"""
    _logic_run_all_scripts(call)

def broadcast_init_callback(call):
    """Handle broadcast init callback"""
    bot.answer_callback_query(call.id)
    msg = bot.send_message(call.message.chat.id, "📢 Send message to broadcast.\n/cancel to abort.")
    bot.register_next_step_handler(msg, process_broadcast_message)

def process_broadcast_message(message):
    """Process broadcast message input"""
    user_id = message.from_user.id
    
    if user_id not in admin_ids:
        bot.reply_to(message, "⚠️ Not authorized.")
        return
    
    if message.text and message.text.lower() == '/cancel':
        bot.reply_to(message, "Broadcast cancelled.")
        return
    
    broadcast_content = message.text
    
    if not broadcast_content and not (message.photo or message.video or message.document or message.sticker or message.voice or message.audio):
        bot.reply_to(message, "⚠️ Cannot broadcast empty message. Send text or media, or /cancel.")
        msg = bot.send_message(message.chat.id, "📢 Send broadcast message or /cancel.")
        bot.register_next_step_handler(msg, process_broadcast_message)
        return
    
    target_count = len(active_users)
    
    markup = types.InlineKeyboardMarkup()
    markup.row(types.InlineKeyboardButton("✅ Confirm & Send", callback_data=f"confirm_broadcast_{message.message_id}"),
               types.InlineKeyboardButton("❌ Cancel", callback_data="cancel_broadcast"))
    
    preview_text = broadcast_content[:1000].strip() if broadcast_content else "(Media message)"
    
    bot.reply_to(message, f"⚠️ Confirm Broadcast:\n\n```\n{preview_text}\n```\n"
                          f"To **{target_count}** users. Sure?", reply_markup=markup, parse_mode='Markdown')

def handle_confirm_broadcast(call):
    """Handle broadcast confirmation"""
    user_id = call.from_user.id
    chat_id = call.message.chat.id
    
    if user_id not in admin_ids:
        bot.answer_callback_query(call.id, "⚠️ Admin only.", show_alert=True)
        return
    
    try:
        original_message = call.message.reply_to_message
        if not original_message:
            raise ValueError("Could not retrieve original message.")
        
        broadcast_text = None
        broadcast_photo_id = None
        broadcast_video_id = None
        
        if original_message.text:
            broadcast_text = original_message.text
        elif original_message.photo:
            broadcast_photo_id = original_message.photo[-1].file_id
        elif original_message.video:
            broadcast_video_id = original_message.video.file_id
        else:
            raise ValueError("Message has no text or supported media for broadcast.")
        
        bot.answer_callback_query(call.id, "🚀 Starting broadcast...")
        bot.edit_message_text(f"📢 Broadcasting to {len(active_users)} users...",
                             chat_id, call.message.message_id, reply_markup=None)
        
        thread = threading.Thread(target=execute_broadcast, args=(
            broadcast_text, broadcast_photo_id, broadcast_video_id,
            original_message.caption if (broadcast_photo_id or broadcast_video_id) else None,
            chat_id))
        thread.start()
    except Exception as e:
        logger.error(f"Error starting broadcast: {e}")
        bot.edit_message_text("❌ Error starting broadcast.", chat_id, call.message.message_id, reply_markup=None)

def handle_cancel_broadcast(call):
    """Handle broadcast cancellation"""
    bot.answer_callback_query(call.id, "Broadcast cancelled.")
    bot.delete_message(call.message.chat.id, call.message.message_id)
    if call.message.reply_to_message:
        try:
            bot.delete_message(call.message.chat.id, call.message.reply_to_message.message_id)
        except:
            pass

def execute_broadcast(broadcast_text, photo_id, video_id, caption, admin_chat_id):
    """Execute broadcast to all active users"""
    sent_count = 0
    failed_count = 0
    blocked_count = 0
    
    start_exec_time = time.time()
    users_to_broadcast = list(active_users)
    total_users = len(users_to_broadcast)
    
    logger.info(f"Executing broadcast to {total_users} users.")
    
    batch_size = 25
    delay_batches = 1.5
    
    for i, user_id in enumerate(users_to_broadcast):
        try:
            if broadcast_text:
                bot.send_message(user_id, broadcast_text, parse_mode='Markdown')
            elif photo_id:
                bot.send_photo(user_id, photo_id, caption=caption, parse_mode='Markdown' if caption else None)
            elif video_id:
                bot.send_video(user_id, video_id, caption=caption, parse_mode='Markdown' if caption else None)
            
            sent_count += 1
        except telebot.apihelper.ApiTelegramException as e:
            err_desc = str(e).lower()
            if any(s in err_desc for s in ["bot was blocked", "user is deactivated", "chat not found", "kicked from", "restricted"]):
                logger.warning(f"Broadcast failed to {user_id}: User blocked/inactive.")
                blocked_count += 1
            elif "flood control" in err_desc or "too many requests" in err_desc:
                retry_after = 5
                match = re.search(r"retry after (\d+)", err_desc)
                if match:
                    retry_after = int(match.group(1)) + 1
                
                logger.warning(f"Flood control. Sleeping {retry_after}s...")
                time.sleep(retry_after)
                
                try:
                    if broadcast_text:
                        bot.send_message(user_id, broadcast_text, parse_mode='Markdown')
                    elif photo_id:
                        bot.send_photo(user_id, photo_id, caption=caption, parse_mode='Markdown' if caption else None)
                    elif video_id:
                        bot.send_video(user_id, video_id, caption=caption, parse_mode='Markdown' if caption else None)
                    
                    sent_count += 1
                except Exception as e_retry:
                    logger.error(f"Broadcast retry failed: {e_retry}")
                    failed_count += 1
            else:
                logger.error(f"Broadcast failed to {user_id}: {e}")
                failed_count += 1
        except Exception as e:
            logger.error(f"Unexpected error broadcasting to {user_id}: {e}")
            failed_count += 1
        
        if (i + 1) % batch_size == 0 and i < total_users - 1:
            logger.info(f"Broadcast batch {i//batch_size + 1} sent. Sleeping {delay_batches}s...")
            time.sleep(delay_batches)
        elif i % 5 == 0:
            time.sleep(0.2)
    
    duration = round(time.time() - start_exec_time, 2)
    
    result_msg = (f"📢 Broadcast Complete!\n\n"
                 f"✅ Sent: {sent_count}\n"
                 f"❌ Failed: {failed_count}\n"
                 f"🚫 Blocked/Inactive: {blocked_count}\n"
                 f"👥 Targets: {total_users}\n"
                 f"⏱️ Duration: {duration}s")
    
    logger.info(result_msg)
    
    try:
        bot.send_message(admin_chat_id, result_msg)
    except Exception as e:
        logger.error(f"Failed to send broadcast result: {e}")

def admin_panel_callback(call):
    """Handle admin panel callback"""
    bot.answer_callback_query(call.id)
    try:
        bot.edit_message_text("👑 Admin Panel\nManage admins (Owner actions may be restricted).",
                             call.message.chat.id, call.message.message_id,
                             reply_markup=create_admin_panel())
    except Exception as e:
        logger.error(f"Error showing admin panel: {e}")

def add_admin_init_callback(call):
    """Handle add admin init callback"""
    bot.answer_callback_query(call.id)
    msg = bot.send_message(call.message.chat.id, "👑 Enter User ID to promote to Admin.\n/cancel to abort.")
    bot.register_next_step_handler(msg, process_add_admin_id)

def process_add_admin_id(message):
    """Process add admin ID input"""
    owner_id_check = message.from_user.id
    
    if owner_id_check != OWNER_ID:
        bot.reply_to(message, "⚠️ Owner only.")
        return
    
    if message.text.lower() == '/cancel':
        bot.reply_to(message, "Admin promotion cancelled.")
        return
    
    try:
        new_admin_id = int(message.text.strip())
        
        if new_admin_id <= 0:
            raise ValueError("ID must be positive")
        
        if new_admin_id == OWNER_ID:
            bot.reply_to(message, "⚠️ Owner is already Owner.")
            return
        
        if new_admin_id in admin_ids:
            bot.reply_to(message, f"⚠️ User `{new_admin_id}` already Admin.")
            return
        
        add_admin_db(new_admin_id)
        logger.warning(f"Admin {new_admin_id} added by Owner {owner_id_check}.")
        
        bot.reply_to(message, f"✅ User `{new_admin_id}` promoted to Admin.")
        
        try:
            bot.send_message(new_admin_id, "🎉 Congrats! You are now an Admin.")
        except Exception as e:
            logger.error(f"Failed to notify new admin: {e}")
            
    except ValueError:
        bot.reply_to(message, "⚠️ Invalid ID. Send numerical ID or /cancel.")
        msg = bot.send_message(message.chat.id, "👑 Enter User ID to promote or /cancel.")
        bot.register_next_step_handler(msg, process_add_admin_id)
    except Exception as e:
        logger.error(f"Error processing add admin: {e}", exc_info=True)
        bot.reply_to(message, "Error.")

def remove_admin_init_callback(call):
    """Handle remove admin init callback"""
    bot.answer_callback_query(call.id)
    msg = bot.send_message(call.message.chat.id, "👑 Enter User ID of Admin to remove.\n/cancel to abort.")
    bot.register_next_step_handler(msg, process_remove_admin_id)

def process_remove_admin_id(message):
    """Process remove admin ID input"""
    owner_id_check = message.from_user.id
    
    if owner_id_check != OWNER_ID:
        bot.reply_to(message, "⚠️ Owner only.")
        return
    
    if message.text.lower() == '/cancel':
        bot.reply_to(message, "Admin removal cancelled.")
        return
    
    try:
        admin_id_remove = int(message.text.strip())
        
        if admin_id_remove <= 0:
            raise ValueError("ID must be positive")
        
        if admin_id_remove == OWNER_ID:
            bot.reply_to(message, "⚠️ Owner cannot remove self.")
            return
        
        if admin_id_remove not in admin_ids:
            bot.reply_to(message, f"⚠️ User `{admin_id_remove}` not Admin.")
            return
        
        if remove_admin_db(admin_id_remove):
            logger.warning(f"Admin {admin_id_remove} removed by Owner {owner_id_check}.")
            bot.reply_to(message, f"✅ Admin `{admin_id_remove}` removed.")
            
            try:
                bot.send_message(admin_id_remove, "ℹ️ You are no longer an Admin.")
            except Exception as e:
                logger.error(f"Failed to notify removed admin: {e}")
        else:
            bot.reply_to(message, f"❌ Failed to remove admin `{admin_id_remove}`. Check logs.")
            
    except ValueError:
        bot.reply_to(message, "⚠️ Invalid ID. Send numerical ID or /cancel.")
        msg = bot.send_message(message.chat.id, "👑 Enter Admin ID to remove or /cancel.")
        bot.register_next_step_handler(msg, process_remove_admin_id)
    except Exception as e:
        logger.error(f"Error processing remove admin: {e}", exc_info=True)
        bot.reply_to(message, "Error.")

def list_admins_callback(call):
    """Handle list admins callback"""
    bot.answer_callback_query(call.id)
    try:
        admin_list_str = "\n".join(f"- `{aid}` {'(Owner)' if aid == OWNER_ID else ''}" for aid in sorted(list(admin_ids)))
        if not admin_list_str:
            admin_list_str = "(No Owner/Admins configured!)"
        
        bot.edit_message_text(f"👑 Current Admins:\n\n{admin_list_str}", call.message.chat.id,
                             call.message.message_id, reply_markup=create_admin_panel(), parse_mode='Markdown')
    except Exception as e:
        logger.error(f"Error listing admins: {e}")

def add_subscription_init_callback(call):
    """Handle add subscription init callback"""
    bot.answer_callback_query(call.id)
    msg = bot.send_message(call.message.chat.id, "💳 Enter User ID & days (e.g., `12345678 30`).\n/cancel to abort.")
    bot.register_next_step_handler(msg, process_add_subscription_details)

def process_add_subscription_details(message):
    """Process add subscription details"""
    admin_id_check = message.from_user.id
    
    if admin_id_check not in admin_ids:
        bot.reply_to(message, "⚠️ Not authorized.")
        return
    
    if message.text.lower() == '/cancel':
        bot.reply_to(message, "Sub add cancelled.")
        return
    
    try:
        parts = message.text.split()
        if len(parts) != 2:
            raise ValueError("Incorrect format")
        
        sub_user_id = int(parts[0].strip())
        days = int(parts[1].strip())
        
        if sub_user_id <= 0 or days <= 0:
            raise ValueError("User ID/days must be positive")
        
        current_expiry = user_subscriptions.get(sub_user_id, {}).get('expiry')
        start_date_new_sub = datetime.now()
        
        if current_expiry and current_expiry > start_date_new_sub:
            start_date_new_sub = current_expiry
        
        new_expiry = start_date_new_sub + timedelta(days=days)
        save_subscription(sub_user_id, new_expiry)
        
        logger.info(f"Sub for {sub_user_id} by admin {admin_id_check}. Expiry: {new_expiry:%Y-%m-%d}")
        
        bot.reply_to(message, f"✅ Sub for `{sub_user_id}` by {days} days.\nNew expiry: {new_expiry:%Y-%m-%d}")
        
        try:
            bot.send_message(sub_user_id, f"🎉 Sub activated/extended by {days} days! Expires: {new_expiry:%Y-%m-%d}.")
        except Exception as e:
            logger.error(f"Failed to notify user: {e}")
            
    except ValueError as e:
        bot.reply_to(message, f"⚠️ Invalid: {e}. Format: `ID days` or /cancel.")
        msg = bot.send_message(message.chat.id, "💳 Enter User ID & days, or /cancel.")
        bot.register_next_step_handler(msg, process_add_subscription_details)
    except Exception as e:
        logger.error(f"Error processing add sub: {e}", exc_info=True)
        bot.reply_to(message, "Error.")

def remove_subscription_init_callback(call):
    """Handle remove subscription init callback"""
    bot.answer_callback_query(call.id)
    msg = bot.send_message(call.message.chat.id, "💳 Enter User ID to remove sub.\n/cancel to abort.")
    bot.register_next_step_handler(msg, process_remove_subscription_id)

def process_remove_subscription_id(message):
    """Process remove subscription ID input"""
    admin_id_check = message.from_user.id
    
    if admin_id_check not in admin_ids:
        bot.reply_to(message, "⚠️ Not authorized.")
        return
    
    if message.text.lower() == '/cancel':
        bot.reply_to(message, "Sub removal cancelled.")
        return
    
    try:
        sub_user_id_remove = int(message.text.strip())
        
        if sub_user_id_remove <= 0:
            raise ValueError("ID must be positive")
        
        if sub_user_id_remove not in user_subscriptions:
            bot.reply_to(message, f"⚠️ User `{sub_user_id_remove}` no active sub in memory.")
            return
        
        remove_subscription_db(sub_user_id_remove)
        logger.warning(f"Sub removed for {sub_user_id_remove} by admin {admin_id_check}.")
        
        bot.reply_to(message, f"✅ Sub for `{sub_user_id_remove}` removed.")
        
        try:
            bot.send_message(sub_user_id_remove, "ℹ️ Your subscription removed by admin.")
        except Exception as e:
            logger.error(f"Failed to notify user: {e}")
            
    except ValueError:
        bot.reply_to(message, "⚠️ Invalid ID. Send numerical ID or /cancel.")
        msg = bot.send_message(message.chat.id, "💳 Enter User ID to remove sub from, or /cancel.")
        bot.register_next_step_handler(msg, process_remove_subscription_id)
    except Exception as e:
        logger.error(f"Error processing remove sub: {e}", exc_info=True)
        bot.reply_to(message, "Error.")

def check_subscription_init_callback(call):
    """Handle check subscription init callback"""
    bot.answer_callback_query(call.id)
    msg = bot.send_message(call.message.chat.id, "💳 Enter User ID to check sub.\n/cancel to abort.")
    bot.register_next_step_handler(msg, process_check_subscription_id)

def process_check_subscription_id(message):
    """Process check subscription ID input"""
    admin_id_check = message.from_user.id
    
    if admin_id_check not in admin_ids:
        bot.reply_to(message, "⚠️ Not authorized.")
        return
    
    if message.text.lower() == '/cancel':
        bot.reply_to(message, "Sub check cancelled.")
        return
    
    try:
        sub_user_id_check = int(message.text.strip())
        
        if sub_user_id_check <= 0:
            raise ValueError("ID must be positive")
        
        if sub_user_id_check in user_subscriptions:
            expiry_dt = user_subscriptions[sub_user_id_check].get('expiry')
            
            if expiry_dt:
                if expiry_dt > datetime.now():
                    days_left = (expiry_dt - datetime.now()).days
                    bot.reply_to(message, f"✅ User `{sub_user_id_check}` active sub.\nExpires: {expiry_dt:%Y-%m-%d %H:%M:%S} ({days_left} days left).")
                else:
                    bot.reply_to(message, f"⚠️ User `{sub_user_id_check}` expired sub (On: {expiry_dt:%Y-%m-%d %H:%M:%S}).")
                    remove_subscription_db(sub_user_id_check)
            else:
                bot.reply_to(message, f"⚠️ User `{sub_user_id_check}` in sub list, but expiry missing.")
        else:
            bot.reply_to(message, f"ℹ️ User `{sub_user_id_check}` no active sub record.")
            
    except ValueError:
        bot.reply_to(message, "⚠️ Invalid ID. Send numerical ID or /cancel.")
        msg = bot.send_message(message.chat.id, "💳 Enter User ID to check, or /cancel.")
        bot.register_next_step_handler(msg, process_check_subscription_id)
    except Exception as e:
        logger.error(f"Error processing check sub: {e}", exc_info=True)
        bot.reply_to(message, "Error.")

# ==================== FLASK WEBHOOK SETUP ====================

@app.route('/')
def home():
    """Home endpoint for uptime monitoring"""
    return "Bot is running!", 200

@app.route('/health')
def health():
    """Health check endpoint"""
    return {
        'status': 'healthy',
        'timestamp': datetime.now().isoformat(),
        'active_users': len(active_users),
        'running_scripts': len(bot_scripts),
        'bot_locked': bot_locked
    }, 200

@app.route(f'/{TOKEN}', methods=['POST'])
def webhook():
    """Webhook endpoint for Telegram updates"""
    if request.headers.get('content-type') == 'application/json':
        json_string = request.get_data().decode('utf-8')
        update = telebot.types.Update.de_json(json_string)
        bot.process_new_updates([update])
        return 'OK', 200
    else:
        return 'Bad Request', 400

def set_webhook():
    """Set webhook for the bot"""
    try:
        # Get Render URL from environment
        render_url = os.getenv('RENDER_EXTERNAL_URL')
        if not render_url:
            logger.error("RENDER_EXTERNAL_URL not set in environment")
            return False
        
        webhook_url = f"{render_url}/{TOKEN}"
        
        # Remove any existing webhook
        bot.remove_webhook()
        time.sleep(1)
        
        # Set new webhook
        success = bot.set_webhook(url=webhook_url)
        
        if success:
            logger.info(f"Webhook set successfully: {webhook_url}")
            webhook_info = bot.get_webhook_info()
            logger.info(f"Webhook info: {webhook_info}")
            return True
        else:
            logger.error("Failed to set webhook")
            return False
    except Exception as e:
        logger.error(f"Error setting webhook: {e}", exc_info=True)
        return False

def remove_webhook():
    """Remove webhook on shutdown"""
    try:
        bot.remove_webhook()
        logger.info("Webhook removed")
    except Exception as e:
        logger.error(f"Error removing webhook: {e}")

# ==================== CLEANUP ====================

def cleanup():
    """Cleanup function for graceful shutdown"""
    logger.warning("Shutting down. Cleaning up processes...")
    
    script_keys_to_stop = list(bot_scripts.keys())
    
    if not script_keys_to_stop:
        logger.info("No scripts running.")
    else:
        logger.info(f"Stopping {len(script_keys_to_stop)} scripts...")
        
        for key in script_keys_to_stop:
            if key in bot_scripts:
                logger.info(f"Stopping: {key}")
                kill_process_tree(bot_scripts[key])
        
        logger.info("All scripts stopped.")
    
    # Remove webhook
    remove_webhook()
    
    logger.warning("Cleanup finished.")

# Register cleanup function
atexit.register(cleanup)

# ==================== MAIN ====================

def run_flask():
    """Run Flask app"""
    port = int(os.getenv('PORT', 8080))
    app.run(host='0.0.0.0', port=port)

def main():
    """Main function to start the bot"""
    logger.info("="*50)
    logger.info("🤖 Bot Starting Up")
    logger.info(f"🐍 Python: {sys.version.split()[0]}")
    logger.info(f"📁 Base Dir: {BASE_DIR}")
    logger.info(f"📁 Upload Dir: {UPLOAD_BOTS_DIR}")
    logger.info(f"📊 Data Dir: {IROTECH_DIR}")
    logger.info(f"🔑 Owner ID: {OWNER_ID}")
    logger.info(f"🛡️ Admins: {admin_ids}")
    logger.info("="*50)
    
    # Check if running on Render
    if os.getenv('RENDER'):
        logger.info("Running on Render - Using Webhook mode")
        
        # Start Flask in a separate thread
        flask_thread = Thread(target=run_flask, daemon=True)
        flask_thread.start()
        logger.info("Flask server started in background thread")
        
        # Set webhook
        if set_webhook():
            logger.info("✅ Bot is running in webhook mode")
            logger.info(f"Webhook URL: {os.getenv('RENDER_EXTERNAL_URL')}/{TOKEN}")
            
            # Keep main thread alive
            while True:
                time.sleep(60)
                logger.info("Bot still running... Health check")
        else:
            logger.error("❌ Failed to set webhook. Falling back to polling?")
            # Fallback to polling if webhook fails
            logger.info("Falling back to polling mode...")
            bot.infinity_polling(timeout=60, long_polling_timeout=60)
    else:
        logger.info("Running locally - Using Polling mode")
        logger.info("🔄 Starting bot polling...")
        bot.infinity_polling(timeout=60, long_polling_timeout=60)

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        logger.info("Bot stopped by user")
        cleanup()
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        cleanup()
        sys.exit(1)
