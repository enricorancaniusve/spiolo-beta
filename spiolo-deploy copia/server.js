require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
app.set('trust proxy', true);

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend/public')));

/* ---------------- RATE LIMIT ---------------- */

const postLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Troppi segreti inviati. Riprova più tardi." }
});

const reactionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  message: { error: "Troppe reazioni. Riprova tra poco." }
});

/* ---------------- DATABASE INIT ---------------- */

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS secrets (
      id BIGSERIAL PRIMARY KEY,
      content TEXT NOT NULL CHECK (char_length(content) BETWEEN 10 AND 500),
      category VARCHAR(10) DEFAULT 's',
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reactions (
      id BIGSERIAL PRIMARY KEY,
      secret_id BIGINT REFERENCES secrets(id) ON DELETE CASCADE,
      emoji VARCHAR(10) NOT NULL,
      ip_address TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log("✅ Database pronto");
}

/* ---------------- GET SECRETS ---------------- */

app.get('/api/secrets', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = parseInt(req.query.offset) || 0;

    const result = await pool.query(`
      SELECT s.id, s.content, s.category, s.created_at,
        COALESCE(
          json_object_agg(r.emoji, r.cnt) FILTER (WHERE r.emoji IS NOT NULL),
          '{}'::json
        ) AS reactions
      FROM secrets s
      LEFT JOIN (
        SELECT secret_id, emoji, COUNT(*) as cnt
        FROM reactions
        GROUP BY secret_id, emoji
      ) r ON r.secret_id = s.id
      GROUP BY s.id
      ORDER BY s.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const countResult = await pool.query('SELECT COUNT(*) FROM secrets');
    const total = parseInt(countResult.rows[0].count);

    res.json({
      secrets: result.rows,
      total,
      hasMore: offset + limit < total
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nel recupero dei segreti." });
  }
});

/* ---------------- POST SECRET ---------------- */

app.post('/api/secrets', postLimiter, async (req, res) => {
  try {
    const { content, category } = req.body;

    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: "Contenuto mancante." });
    }

    const trimmed = content.trim();

    if (trimmed.length < 10) {
      return res.status(400).json({ error: "Segreto troppo corto." });
    }

    if (trimmed.length > 500) {
      return res.status(400).json({ error: "Segreto troppo lungo." });
    }

    const allowed = ['s', 'p', 'c', 'd'];
    const cat = allowed.includes(category) ? category : 's';

    const ip =
      req.headers['x-forwarded-for'] ||
      req.socket.remoteAddress;

    const userAgent = req.headers['user-agent'];

    const result = await pool.query(
      `INSERT INTO secrets (content, category, ip_address, user_agent)
       VALUES ($1, $2, $3, $4)
       RETURNING id, content, category, created_at`,
      [trimmed, cat, ip, userAgent]
    );

    res.status(201).json({
      ...result.rows[0],
      reactions: {}
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nella pubblicazione." });
  }
});

/* ---------------- POST REACTION ---------------- */

app.post('/api/reactions', reactionLimiter, async (req, res) => {
  try {
    const { secret_id, emoji } = req.body;

    if (!secret_id || !emoji) {
      return res.status(400).json({ error: "Dati mancanti." });
    }

    const ip =
      req.headers['x-forwarded-for'] ||
      req.socket.remoteAddress;

    await pool.query(
      `INSERT INTO reactions (secret_id, emoji, ip_address)
       VALUES ($1, $2, $3)
       ON CONFLICT (secret_id, ip_address)
       DO UPDATE SET emoji = EXCLUDED.emoji`,
      [secret_id, emoji, ip]
    );

    const result = await pool.query(
      `SELECT emoji, COUNT(*) as cnt
       FROM reactions
       WHERE secret_id=$1
       GROUP BY emoji`,
      [secret_id]
    );

    const reactions = {};
    result.rows.forEach(r => reactions[r.emoji] = parseInt(r.cnt));

    res.json({ reactions });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nella reazione." });
  }
});

/* ---------------- STATS ---------------- */

app.get('/api/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS today
      FROM secrets
    `);

    res.json(result.rows[0]);

  } catch (err) {
    res.status(500).json({ error: "Errore stats." });
  }
});

/* ---------------- FRONTEND ---------------- */

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend/public/index.html'));
});

/* ---------------- START SERVER ---------------- */

initDB().then(() => {
  app.listen(PORT, () =>
    console.log(`🌿 Lo Spiolo attivo su http://localhost:${PORT}`)
  );
});