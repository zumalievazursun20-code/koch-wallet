require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-in-production-32chars';
const INITIAL_ADMIN_ID = process.env.INITIAL_ADMIN_ID ? parseInt(process.env.INITIAL_ADMIN_ID) : null;

// Ensure data dir
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'koch.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ========== SCHEMA ==========
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    balance REAL NOT NULL DEFAULT 0,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT,
    related_user_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS loans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    interest_rate REAL NOT NULL DEFAULT 5.0,
    term_days INTEGER NOT NULL DEFAULT 30,
    status TEXT NOT NULL DEFAULT 'pending',
    remaining REAL NOT NULL,
    purpose TEXT,
    approved_by INTEGER,
    approved_at TEXT,
    due_date TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
  CREATE INDEX IF NOT EXISTS idx_loans_user ON loans(user_id);
  CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);
`);

// ========== HELPERS ==========
function validateInitData(initData) {
  if (!initData || !BOT_TOKEN) {
    // Dev mode fallback
    if (process.env.NODE_ENV !== 'production' && initData) {
      try {
        const params = new URLSearchParams(initData);
        const userStr = params.get('user');
        if (userStr) return JSON.parse(userStr);
      } catch (e) {}
    }
    return null;
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculatedHash !== hash) return null;

    const authDate = parseInt(params.get('auth_date') || '0');
    if (Date.now() / 1000 - authDate > 86400) return null; // 24h

    const userStr = params.get('user');
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch (e) {
    console.error('InitData validation error:', e);
    return null;
  }
}

function getOrCreateUser(tgUser) {
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(tgUser.id);
  if (!user) {
    const isAdmin = INITIAL_ADMIN_ID && tgUser.id === INITIAL_ADMIN_ID ? 1 : 0;
    db.prepare(`
      INSERT INTO users (id, username, first_name, last_name, is_admin)
      VALUES (?, ?, ?, ?, ?)
    `).run(tgUser.id, tgUser.username || null, tgUser.first_name || null, tgUser.last_name || null, isAdmin);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(tgUser.id);
  } else {
    // Update profile
    db.prepare(`
      UPDATE users SET username = ?, first_name = ?, last_name = ? WHERE id = ?
    `).run(tgUser.username || null, tgUser.first_name || null, tgUser.last_name || null, tgUser.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(tgUser.id);
  }
  return user;
}

function requireAuth(req, res, next) {
  const initData = req.headers['x-telegram-init-data'] || req.body?.initData || '';
  const tgUser = validateInitData(initData);
  if (!tgUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.tgUser = tgUser;
  req.user = getOrCreateUser(tgUser);
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

function addTransaction(userId, type, amount, description = null, relatedUserId = null) {
  db.prepare(`
    INSERT INTO transactions (user_id, type, amount, description, related_user_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, type, amount, description, relatedUserId);
}

function formatMoney(n) {
  return Number(n).toFixed(2);
}

// ========== MIDDLEWARE ==========
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many requests' }
});
app.use('/api/', limiter);

// ========== API ROUTES ==========

// Auth / Me
app.get('/api/me', requireAuth, (req, res) => {
  const user = req.user;
  const loans = db.prepare(`
    SELECT * FROM loans WHERE user_id = ? AND status IN ('pending', 'approved', 'active')
    ORDER BY created_at DESC
  `).all(user.id);
  res.json({
    id: user.id,
    username: user.username,
    first_name: user.first_name,
    last_name: user.last_name,
    balance: user.balance,
    is_admin: !!user.is_admin,
    loans
  });
});

// Transactions history
app.get('/api/transactions', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const rows = db.prepare(`
    SELECT * FROM transactions WHERE user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(req.user.id, limit);
  res.json(rows);
});

// Request loan
app.post('/api/loans/request', requireAuth, (req, res) => {
  const { amount, purpose, term_days } = req.body;
  const amt = parseFloat(amount);
  if (!amt || amt < 10 || amt > 100000) {
    return res.status(400).json({ error: 'Сумма от 10 до 100 000' });
  }
  const term = parseInt(term_days) || 30;
  if (term < 7 || term > 365) {
    return res.status(400).json({ error: 'Срок от 7 до 365 дней' });
  }

  // Check pending
  const pending = db.prepare(`SELECT id FROM loans WHERE user_id = ? AND status = 'pending'`).get(req.user.id);
  if (pending) {
    return res.status(400).json({ error: 'У вас уже есть заявка на рассмотрении' });
  }

  const interestRate = 5.0; // fixed for now, can be dynamic
  const remaining = amt; // will accrue interest on approval or periodically

  const info = db.prepare(`
    INSERT INTO loans (user_id, amount, interest_rate, term_days, remaining, purpose, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `).run(req.user.id, amt, interestRate, term, remaining, purpose || null);

  res.json({ success: true, loan_id: info.lastInsertRowid });
});

// Get my loans
app.get('/api/loans', requireAuth, (req, res) => {
  const loans = db.prepare(`
    SELECT * FROM loans WHERE user_id = ? ORDER BY created_at DESC
  `).all(req.user.id);
  res.json(loans);
});

// Repay loan
app.post('/api/loans/:id/repay', requireAuth, (req, res) => {
  const loanId = parseInt(req.params.id);
  const { amount } = req.body;
  const payAmt = parseFloat(amount);

  const loan = db.prepare(`SELECT * FROM loans WHERE id = ? AND user_id = ?`).get(loanId, req.user.id);
  if (!loan || !['approved', 'active'].includes(loan.status)) {
    return res.status(404).json({ error: 'Кредит не найден или недоступен для погашения' });
  }
  if (!payAmt || payAmt <= 0) {
    return res.status(400).json({ error: 'Некорректная сумма' });
  }
  if (payAmt > req.user.balance) {
    return res.status(400).json({ error: 'Недостаточно средств на балансе' });
  }
  if (payAmt > loan.remaining) {
    return res.status(400).json({ error: 'Сумма больше остатка долга' });
  }

  // Deduct from balance
  db.prepare(`UPDATE users SET balance = balance - ? WHERE id = ?`).run(payAmt, req.user.id);
  addTransaction(req.user.id, 'loan_repay', -payAmt, `Погашение кредита #${loanId}`);

  const newRemaining = loan.remaining - payAmt;
  if (newRemaining <= 0.01) {
    db.prepare(`UPDATE loans SET remaining = 0, status = 'repaid' WHERE id = ?`).run(loanId);
  } else {
    db.prepare(`UPDATE loans SET remaining = ?, status = 'active' WHERE id = ?`).run(newRemaining, loanId);
  }

  const updatedUser = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id);
  res.json({ success: true, new_balance: updatedUser.balance, remaining: Math.max(0, newRemaining) });
});

// ========== ADMIN ROUTES ==========

// Admin: list users
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const q = req.query.q || '';
  let users;
  if (q) {
    users = db.prepare(`
      SELECT id, username, first_name, last_name, balance, is_admin, created_at
      FROM users
      WHERE CAST(id AS TEXT) LIKE ? OR username LIKE ? OR first_name LIKE ? OR last_name LIKE ?
      ORDER BY created_at DESC LIMIT 100
    `).all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  } else {
    users = db.prepare(`
      SELECT id, username, first_name, last_name, balance, is_admin, created_at
      FROM users ORDER BY created_at DESC LIMIT 100
    `).all();
  }
  res.json(users);
});

// Admin: adjust balance
app.post('/api/admin/adjust-balance', requireAuth, requireAdmin, (req, res) => {
  const { user_id, amount, reason } = req.body;
  const uid = parseInt(user_id);
  const amt = parseFloat(amount);
  if (!uid || isNaN(amt) || amt === 0) {
    return res.status(400).json({ error: 'Некорректные данные' });
  }

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

  db.prepare(`UPDATE users SET balance = balance + ? WHERE id = ?`).run(amt, uid);
  addTransaction(uid, 'admin_adjust', amt, reason || `Корректировка админом #${req.user.id}`, req.user.id);

  const updated = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid);
  res.json({ success: true, new_balance: updated.balance });
});

// Admin: set admin status
app.post('/api/admin/set-admin', requireAuth, requireAdmin, (req, res) => {
  const { user_id, is_admin } = req.body;
  const uid = parseInt(user_id);
  if (!uid || uid === req.user.id) {
    return res.status(400).json({ error: 'Нельзя изменить свой статус' });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });

  db.prepare(`UPDATE users SET is_admin = ? WHERE id = ?`).run(is_admin ? 1 : 0, uid);
  res.json({ success: true });
});

// Admin: pending loans
app.get('/api/admin/loans', requireAuth, requireAdmin, (req, res) => {
  const status = req.query.status || 'pending';
  const loans = db.prepare(`
    SELECT l.*, u.username, u.first_name, u.last_name
    FROM loans l
    JOIN users u ON u.id = l.user_id
    WHERE l.status = ?
    ORDER BY l.created_at ASC
  `).all(status);
  res.json(loans);
});

// Admin: approve / reject loan
app.post('/api/admin/loans/:id/decide', requireAuth, requireAdmin, (req, res) => {
  const loanId = parseInt(req.params.id);
  const { action, interest_rate } = req.body; // action: approve | reject

  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(loanId);
  if (!loan || loan.status !== 'pending') {
    return res.status(400).json({ error: 'Заявка не найдена или уже обработана' });
  }

  if (action === 'reject') {
    db.prepare(`UPDATE loans SET status = 'rejected', approved_by = ?, approved_at = datetime('now') WHERE id = ?`)
      .run(req.user.id, loanId);
    return res.json({ success: true, status: 'rejected' });
  }

  if (action === 'approve') {
    const rate = parseFloat(interest_rate) || loan.interest_rate;
    const interest = loan.amount * (rate / 100);
    const totalDue = loan.amount + interest;
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + loan.term_days);

    // Credit money to user
    db.prepare(`UPDATE users SET balance = balance + ? WHERE id = ?`).run(loan.amount, loan.user_id);
    addTransaction(loan.user_id, 'loan_disburse', loan.amount, `Выдача кредита #${loanId}`);

    db.prepare(`
      UPDATE loans SET
        status = 'active',
        remaining = ?,
        interest_rate = ?,
        approved_by = ?,
        approved_at = datetime('now'),
        due_date = ?
      WHERE id = ?
    `).run(totalDue, rate, req.user.id, dueDate.toISOString().slice(0, 10), loanId);

    return res.json({ success: true, status: 'active', total_due: totalDue });
  }

  res.status(400).json({ error: 'Неизвестное действие' });
});

// Admin: stats
app.get('/api/admin/stats', requireAuth, requireAdmin, (req, res) => {
  const usersCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const totalBalance = db.prepare('SELECT COALESCE(SUM(balance),0) as s FROM users').get().s;
  const pendingLoans = db.prepare(`SELECT COUNT(*) as c FROM loans WHERE status = 'pending'`).get().c;
  const activeLoans = db.prepare(`SELECT COUNT(*) as c FROM loans WHERE status = 'active'`).get().c;
  const totalLoaned = db.prepare(`SELECT COALESCE(SUM(amount),0) as s FROM loans WHERE status IN ('active','repaid')`).get().s;
  res.json({ usersCount, totalBalance, pendingLoans, activeLoans, totalLoaned });
});

// Fallback SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start
app.listen(PORT, () => {
  console.log(`Koch Wallet running on http://localhost:${PORT}`);
  if (!BOT_TOKEN) {
    console.warn('WARNING: BOT_TOKEN not set. Auth will work only in dev mode with mock data.');
  }
});
