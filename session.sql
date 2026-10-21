-- web_session.sql
USE acore_auth;

CREATE TABLE IF NOT EXISTS web_session (
  token       CHAR(48) PRIMARY KEY,
  account_id  INT UNSIGNED NOT NULL,
  expires_at  DATETIME NOT NULL,
  INDEX idx_account (account_id),
  CONSTRAINT fk_lh_session_account
    FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
