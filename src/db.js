import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

/**
 * SQLite helper + prepared statements.
 * FIX:
 *  - используем '' (одинарные кавычки) для строк в SQL
 *  - создаём папку для SQLITE_PATH если её нет
 *  - upsertUser НЕ сбрасывает кредиты
 */
export function initDb(sqlitePath = "./data.sqlite") {
  // ✅ создаём папку под базу если путь вида /var/data/data.sqlite
  const dir = path.dirname(sqlitePath);
  if (dir && dir !== "." && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(sqlitePath);

  // Good defaults
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // ---------- schema ----------
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id       INTEGER PRIMARY KEY,
      username      TEXT,
      first_name    TEXT,
      last_name     TEXT,
      joined_at     INTEGER,
      credits       INTEGER NOT NULL DEFAULT 0,
      spent_stars   INTEGER NOT NULL DEFAULT 0,
      referred_by   TEXT,
      last_result   TEXT
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT,
      text         TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS generations (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      prompt       TEXT NOT NULL,
      aspect_ratio TEXT NOT NULL,
      task_id      TEXT,
      status       TEXT NOT NULL,
      url          TEXT,
      created_at   INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
    );
  `);

  // ---------- prepared statements ----------
  const stmts = {
    // USERS
    getUser: db.prepare(`SELECT * FROM users WHERE user_id = ?`),

    /**
     * Важно:
     * - создаёт пользователя если его нет
     * - обновляет только username/first_name/last_name если есть
     * - НЕ сбрасывает credits/spent_stars
     */
    upsertUser: db.prepare(`
      INSERT INTO users (
        user_id, username, first_name, last_name, joined_at, credits, referred_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        username   = excluded.username,
        first_name = excluded.first_name,
        last_name  = excluded.last_name
    `),

    spendCredit: db.prepare(`
      UPDATE users
      SET credits = credits - 1
      WHERE user_id = ? AND credits > 0
    `),

    addCredits: db.prepare(`
      UPDATE users
      SET credits = credits + ?
      WHERE user_id = ?
    `),

    addSpentStars: db.prepare(`
      UPDATE users
      SET spent_stars = spent_stars + ?
      WHERE user_id = ?
    `),

    setLastResult: db.prepare(`
      UPDATE users
      SET last_result = ?
      WHERE user_id = ?
    `),

    // PROMPTS
    insertPrompt: db.prepare(`
      INSERT INTO prompts (title, text, created_at)
      VALUES (?, ?, ?)
    `),

    // ✅ FIX: '' вместо ""
    listPrompts: db.prepare(`
      SELECT
        id,
        COALESCE(title, '') AS title,
        text,
        created_at
      FROM prompts
      ORDER BY id DESC
      LIMIT ?
    `),

    // GENERATIONS / HISTORY
    insertGen: db.prepare(`
      INSERT INTO generations (user_id, prompt, aspect_ratio, task_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),

    updateGen: db.prepare(`
      UPDATE generations
      SET status = ?, url = ?
      WHERE task_id = ?
    `),

    listHistory: db.prepare(`
      SELECT id, prompt, status, url, created_at
      FROM generations
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT ?
    `),
  };

  const insertPromptsBatch = db.transaction((rows) => {
    for (const r of rows) {
      stmts.insertPrompt.run(r.title ?? null, r.text, r.created_at ?? Date.now());
    }
  });

  return {
    db,
    ...stmts,
    insertPromptsBatch,
  };
}
