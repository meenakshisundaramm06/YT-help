#!/usr/bin/env python3
"""Gmail Email Cleanup Tool

Uses IMAP to fetch and delete emails. No OAuth, no external dependencies.

Setup:
  1. Enable IMAP in Gmail: Settings → See all settings → Forwarding and POP/IMAP → Enable IMAP
  2. Create an App Password: https://myaccount.google.com/apppasswords
     (Requires 2FA enabled. Create one for "Mail" on "Mac")
  3. Run this script — it will prompt for email and app password on first run.
"""

import email
import email.header
import getpass
import http.server
import imaplib
import json
import os
import re
import sys
import threading
import webbrowser

PORT = 9877
DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(DIR, ".gmail_config.json")

# Global state
imap_conn = None
all_emails = []


def load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE) as f:
            return json.load(f)
    return None


def save_config(email_addr, app_password):
    with open(CONFIG_FILE, "w") as f:
        json.dump({"email": email_addr, "app_password": app_password}, f)
    os.chmod(CONFIG_FILE, 0o600)


def connect_imap(email_addr, app_password):
    """Connect to Gmail IMAP."""
    conn = imaplib.IMAP4_SSL("imap.gmail.com")
    conn.login(email_addr, app_password)
    return conn


def decode_header_value(raw):
    """Decode MIME encoded header like =?UTF-8?B?...?="""
    if not raw:
        return ""
    parts = email.header.decode_header(raw)
    decoded = []
    for part, charset in parts:
        if isinstance(part, bytes):
            try:
                decoded.append(part.decode(charset or "utf-8", errors="replace"))
            except (LookupError, UnicodeError):
                # Some messages use non-standard labels such as "unknown-8bit".
                decoded.append(part.decode("utf-8", errors="replace"))
        else:
            decoded.append(part)
    return " ".join(decoded)


def parse_sender(from_header):
    """Extract email and name from 'Name <email>' format."""
    decoded = decode_header_value(from_header)
    m = re.match(r'"?([^"<]*)"?\s*<?([^>]+@[^>]+)>?', decoded)
    if m:
        name = m.group(1).strip().strip('"')
        addr = m.group(2).strip()
        return addr, name or addr.split("@")[0]
    return decoded.strip(), decoded.split("@")[0]


def fetch_all_emails(conn, read_state, write_progress):
    """Fetch either read or unread inbox emails via IMAP."""
    conn.select("INBOX")

    search_criteria = {"unread": "UNSEEN", "read": "SEEN"}.get(read_state)
    if search_criteria is None:
        return {"error": "Invalid email state"}

    write_progress({"status": "scanning", "phase": "searching", "found": 0, "total": 0})
    status, data = conn.search(None, search_criteria)
    if status != "OK":
        return {"error": "IMAP search failed"}

    msg_ids = data[0].split()
    total = len(msg_ids)
    write_progress({"status": "scanning", "phase": "fetching", "found": 0, "total": total})

    emails = []
    # Fetch in batches for speed
    batch_size = 50
    for i in range(0, total, batch_size):
        batch = msg_ids[i:i + batch_size]
        # Fetch headers only (fast)
        id_range = b",".join(batch)
        status, data = conn.fetch(id_range, "(UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
        if status != "OK":
            continue

        for j in range(0, len(data), 2):
            if not isinstance(data[j], tuple):
                continue
            meta_line = data[j][0].decode("utf-8", errors="replace")
            uid_match = re.search(r"UID (\d+)", meta_line)
            uid = uid_match.group(1) if uid_match else ""

            raw_headers = data[j][1]
            msg = email.message_from_bytes(raw_headers)

            sender_email, sender_name = parse_sender(msg.get("From", ""))
            subject = decode_header_value(msg.get("Subject", "(no subject)"))
            date = msg.get("Date", "")
            # Clean up date
            date = re.sub(r"\s*\(.*?\)\s*$", "", date)

            emails.append({
                "uid": uid,
                "sender": sender_email,
                "senderName": sender_name,
                "subject": subject,
                "date": date,
                "snippet": "",
            })

        write_progress({"status": "scanning", "phase": "fetching", "found": len(emails), "total": total})

    # Mark all as unread again (PEEK doesn't mark as read, but just in case)
    return emails


def trash_by_sender(conn, sender, email_list):
    """Move emails from a sender to trash via IMAP."""
    uids = [e["uid"] for e in email_list if e["sender"] == sender and e.get("uid")]
    if not uids:
        return {"ok": True, "trashed": 0}

    conn.select("INBOX")
    uid_set = ",".join(uids)
    # Move to Trash (Gmail-specific: copy to [Gmail]/Trash, then delete from INBOX)
    status, _ = conn.uid("COPY", uid_set, "[Gmail]/Trash")
    if status == "OK":
        conn.uid("STORE", uid_set, "+FLAGS", "(\\Deleted)")
        conn.expunge()
    return {"ok": status == "OK", "trashed": len(uids)}


def trash_by_uids(conn, uids):
    """Move specific emails to trash."""
    if not uids:
        return {"ok": True, "trashed": 0}
    conn.select("INBOX")
    uid_set = ",".join(uids)
    status, _ = conn.uid("COPY", uid_set, "[Gmail]/Trash")
    if status == "OK":
        conn.uid("STORE", uid_set, "+FLAGS", "(\\Deleted)")
        conn.expunge()
    return {"ok": status == "OK", "trashed": len(uids)}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def do_GET(self):
        if self.path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        global all_emails, imap_conn
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        if self.path == "/api/scan":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            def progress(info):
                self.wfile.write((json.dumps(info) + "\n").encode())
                self.wfile.flush()

            try:
                read_state = body.get("readState", "unread")
                all_emails = fetch_all_emails(imap_conn, read_state, progress)
                if isinstance(all_emails, dict) and "error" in all_emails:
                    self.wfile.write((json.dumps(all_emails) + "\n").encode())
                else:
                    self.wfile.write((json.dumps({"emails": all_emails}) + "\n").encode())
                self.wfile.flush()
            except Exception as e:
                self.wfile.write((json.dumps({"error": str(e)}) + "\n").encode())
                self.wfile.flush()

        elif self.path == "/api/delete-sender":
            sender = body.get("sender", "")
            try:
                result = trash_by_sender(imap_conn, sender, all_emails)
                all_emails = [e for e in all_emails if e["sender"] != sender]
                self.send_json(result)
            except Exception as e:
                self.send_json({"error": str(e)})

        elif self.path == "/api/delete-ids":
            uids = body.get("uids", [])
            try:
                result = trash_by_uids(imap_conn, uids)
                uid_set = set(uids)
                all_emails = [e for e in all_emails if e.get("uid") not in uid_set]
                self.send_json(result)
            except Exception as e:
                self.send_json({"error": str(e)})
        else:
            self.send_json({"error": "unknown"})

    def send_json(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, fmt, *args):
        pass


def main():
    global imap_conn

    print("📧 Gmail Cleanup Tool")
    print()

    config = load_config()
    if config:
        email_addr = config["email"]
        app_password = config["app_password"]
        print(f"   Using saved credentials for {email_addr}")
    else:
        print("   First-time setup:")
        print("   1. Enable IMAP: Gmail → Settings → See all settings → Forwarding and POP/IMAP")
        print("   2. Create App Password: https://myaccount.google.com/apppasswords")
        print()
        email_addr = input("   Gmail address: ").strip()
        app_password = getpass.getpass("   App password: ").strip()

    print("   Connecting to Gmail...")
    try:
        imap_conn = connect_imap(email_addr, app_password)
    except imaplib.IMAP4.error as e:
        print(f"\n   ❌ Login failed: {e}")
        print("   Check your email and app password.")
        print("   App passwords: https://myaccount.google.com/apppasswords")
        if os.path.exists(CONFIG_FILE):
            os.remove(CONFIG_FILE)
        sys.exit(1)

    print("   ✓ Connected")

    if not config:
        save = input("   Save credentials for next time? (y/n): ").strip().lower()
        if save == "y":
            save_config(email_addr, app_password)
            print("   ✓ Saved (chmod 600)")

    server = http.server.HTTPServer(("localhost", PORT), Handler)
    url = f"http://localhost:{PORT}"
    print(f"   Server: {url}")
    print(f"\n   Press Ctrl+C to stop")

    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n   Closing IMAP connection...")
        try:
            imap_conn.close()
            imap_conn.logout()
        except:
            pass
        print("   👋 Stopped.")
        server.shutdown()


if __name__ == "__main__":
    main()
