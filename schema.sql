-- schema.sql
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  folder TEXT NOT NULL DEFAULT 'inbox', -- 'inbox', 'sent', 'trash'
  sender_name TEXT,
  sender_email TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  is_read INTEGER NOT NULL DEFAULT 0, -- 0 = unread, 1 = read
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT, -- NULL if R2 is not enabled
  FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);

-- Indexes for fast inbox listing, search, and thread lookups
CREATE INDEX IF NOT EXISTS idx_emails_folder_created ON emails(folder, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_email_id ON attachments(email_id);
