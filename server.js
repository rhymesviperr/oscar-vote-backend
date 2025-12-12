import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";

dotenv.config();

const { Pool } = pkg;
const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// =====================
// Helpers
// =====================
function requireAdmin(req, res, next) {
  const token = String(req.headers["x-admin-token"] || "");
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Таблица настроек (если ещё нет):
// CREATE TABLE IF NOT EXISTS settings (
//   key TEXT PRIMARY KEY,
//   value TEXT NOT NULL
// );

async function getSettingBool(key, defaultValue) {
  const r = await pool.query(`SELECT value FROM settings WHERE key = $1`, [key]);
  if (!r.rows.length) return defaultValue;
  const raw = String(r.rows[0].value || "").trim().toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return defaultValue;
}

async function setSettingBool(key, value) {
  const v = value ? "true" : "false";
  await pool.query(
    `INSERT INTO settings (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, v]
  );
}

async function getPublicStatus() {
  const voting_open = await getSettingBool("voting_open", true);
  const results_published = await getSettingBool("results_published", false);
  return { voting_open, results_published };
}

// =====================
// Health
// =====================
app.get("/", (req, res) => res.send("Backend работает!"));

app.get("/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ time: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================
// Public status + results
// =====================
app.get("/status", async (req, res) => {
  try {
    const st = await getPublicStatus();
    res.json(st);
  } catch (e) {
    console.error("Error in /status:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Вспомогательный расчёт победителей (без чисел голосов)
async function computeWinners() {
  // Победитель = максимум голосов в номинации.
  // При равенстве — минимальный nominee_id (детерминированно).
  const q = `
    WITH counts AS (
      SELECT nomination_id, nominee_id, COUNT(*)::int AS c
      FROM votes
      GROUP BY nomination_id, nominee_id
    ),
    ranked AS (
      SELECT
        nomination_id,
        nominee_id,
        c,
        ROW_NUMBER() OVER (
          PARTITION BY nomination_id
          ORDER BY c DESC, nominee_id ASC
        ) AS rn
      FROM counts
    )
    SELECT nomination_id, nominee_id
    FROM ranked
    WHERE rn = 1;
  `;
  const r = await pool.query(q);
  const results = {};
  for (const row of r.rows) {
    results[row.nomination_id] = row.nominee_id;
  }
  return results;
}

app.get("/results", async (req, res) => {
  try {
    const st = await getPublicStatus();
    if (!st.results_published) {
      return res.status(403).json({ error: "Results not published" });
    }
    const results = await computeWinners();
    res.json({ results });
  } catch (e) {
    console.error("Error in /results:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// =====================
// Nominations + nominees
// =====================
app.get("/nominations", async (req, res) => {
  try {
    const query = `
      SELECT
        n.id          AS nomination_id,
        n.title       AS nomination_title,
        n.description AS nomination_description,
        n.position    AS nomination_position,
        n.imageurl    AS nomination_imageurl,

        nom.id        AS nominee_id,
        nom.name      AS nominee_name,
        nom.imageurl  AS nominee_imageurl,
        nom.position  AS nominee_position
      FROM nominations n
      LEFT JOIN nominees nom ON nom.nomination_id = n.id
      ORDER BY n.position, nom.position;
    `;

    const result = await pool.query(query);
    const nominationsMap = new Map();

    for (const row of result.rows) {
      const nId = row.nomination_id;

      if (!nominationsMap.has(nId)) {
        nominationsMap.set(nId, {
          id: nId,
          title: row.nomination_title,
          description: row.nomination_description,
          position: row.nomination_position,
          imageUrl: row.nomination_imageurl,
          nominees: [],
        });
      }

      if (row.nominee_id) {
        nominationsMap.get(nId).nominees.push({
          id: row.nominee_id,
          name: row.nominee_name,
          imageUrl: row.nominee_imageurl,
          position: row.nominee_position,
        });
      }
    }

    const nominations = Array.from(nominationsMap.values());
    res.json({ nominations });
  } catch (error) {
    console.error("Error in /nominations:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// =====================
// Users + votes
// =====================
async function ensureUserExists(userId) {
  await pool.query(
    `INSERT INTO users (id)
     VALUES ($1)
     ON CONFLICT (id) DO NOTHING`,
    [userId]
  );
}

app.get("/my-votes", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: "userId is required" });

    const result = await pool.query(
      `SELECT nomination_id, nominee_id
       FROM votes
       WHERE user_id = $1`,
      [userId]
    );

    const votes = {};
    for (const row of result.rows) votes[row.nomination_id] = row.nominee_id;

    res.json({ votes });
  } catch (error) {
    console.error("Error in /my-votes:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/vote", async (req, res) => {
  try {
    const { userId, nominationId, nomineeId } = req.body;
    if (!userId || !nominationId || !nomineeId) {
      return res
        .status(400)
        .json({ error: "userId, nominationId и nomineeId обязательны" });
    }

    const st = await getPublicStatus();
    if (!st.voting_open) {
      return res.status(403).json({ error: "Голосование завершено" });
    }

    const nomineeCheck = await pool.query(
      `SELECT nomination_id FROM nominees WHERE id = $1`,
      [nomineeId]
    );
    if (nomineeCheck.rows.length === 0) {
      return res.status(400).json({ error: "Номинант не найден" });
    }

    const realNominationId = nomineeCheck.rows[0].nomination_id;
    if (Number(realNominationId) !== Number(nominationId)) {
      return res
        .status(400)
        .json({ error: "Номинант не принадлежит указанной номинации" });
    }

    await ensureUserExists(userId);

    await pool.query(
      `DELETE FROM votes WHERE user_id = $1 AND nomination_id = $2`,
      [userId, nominationId]
    );

    await pool.query(
      `INSERT INTO votes (user_id, nomination_id, nominee_id)
       VALUES ($1, $2, $3)`,
      [userId, nominationId, nomineeId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Error in /vote:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/unvote", async (req, res) => {
  try {
    const { userId, nominationId } = req.body;
    if (!userId || !nominationId) {
      return res.status(400).json({ error: "userId и nominationId обязательны" });
    }

    const st = await getPublicStatus();
    if (!st.voting_open) {
      return res.status(403).json({ error: "Голосование завершено" });
    }

    await pool.query(
      `DELETE FROM votes WHERE user_id = $1 AND nomination_id = $2`,
      [userId, nominationId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Error in /unvote:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// =====================
// Admin: status + results
// =====================
app.get("/admin/status", requireAdmin, async (req, res) => {
  try {
    const st = await getPublicStatus();
    res.json(st);
  } catch (e) {
    console.error("Error in /admin/status:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/admin/status", requireAdmin, async (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (key !== "voting_open" && key !== "results_published") {
      return res.status(400).json({ error: "Invalid key" });
    }
    await setSettingBool(key, !!value);
    res.json({ success: true });
  } catch (e) {
    console.error("Error in /admin/status POST:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/admin/results", requireAdmin, async (req, res) => {
  try {
    const results = await computeWinners();
    res.json({ results });
  } catch (e) {
    console.error("Error in /admin/results:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on " + PORT));
