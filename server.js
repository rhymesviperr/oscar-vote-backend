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

// ===== helpers =====
async function getSetting(key, defaultValue = null) {
  const r = await pool.query(
    `SELECT value FROM settings WHERE key = $1 LIMIT 1`,
    [key]
  );
  if (!r.rows.length) return defaultValue;
  return r.rows[0].value;
}

async function getSettingBool(key, defaultValue = false) {
  const v = await getSetting(key, defaultValue ? "true" : "false");
  return String(v).toLowerCase() === "true";
}

// создаём пользователя, если его ещё нет
async function ensureUserExists(userId) {
  await pool.query(
    `INSERT INTO users (id)
     VALUES ($1)
     ON CONFLICT (id) DO NOTHING`,
    [userId]
  );
}

// ===== routes =====

// Тест: жив ли сервер
app.get("/", (req, res) => {
  res.send("Backend работает!");
});

// Тест базы
app.get("/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ time: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Статус: открыт ли vote + опубликованы ли итоги
app.get("/status", async (req, res) => {
  try {
    const votingOpen = await getSettingBool("voting_open", true);
    const resultsPublished = await getSettingBool("results_published", false);
    res.json({ votingOpen, resultsPublished });
  } catch (error) {
    console.error("Error in /status:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Список номинаций + номинанты
app.get("/nominations", async (req, res) => {
  try {
    const query = `
      SELECT
        n.id           AS nomination_id,
        n.title        AS nomination_title,
        n.description  AS nomination_description,
        n.position     AS nomination_position,
        n.imageurl     AS nomination_image_url,
        n.is_published AS nomination_is_published,

        nom.id         AS nominee_id,
        nom.name       AS nominee_name,
        nom.image_url  AS nominee_image_url,
        nom.position   AS nominee_position
      FROM nominations n
      LEFT JOIN nominees nom ON nom.nomination_id = n.id
      WHERE COALESCE(n.is_published, TRUE) = TRUE
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
          imageUrl: row.nomination_image_url,
          nominees: [],
        });
      }

      if (row.nominee_id) {
        nominationsMap.get(nId).nominees.push({
          id: row.nominee_id,
          name: row.nominee_name,
          imageUrl: row.nominee_image_url,
          position: row.nominee_position,
        });
      }
    }

    res.json({ nominations: Array.from(nominationsMap.values()) });
  } catch (error) {
    console.error("Error in /nominations:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Отдать голоса пользователя
app.get("/my-votes", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const result = await pool.query(
      `SELECT nomination_id, nominee_id
       FROM votes
       WHERE user_id = $1`,
      [userId]
    );

    const votes = {};
    for (const row of result.rows) {
      votes[row.nomination_id] = row.nominee_id;
    }

    res.json({ votes });
  } catch (error) {
    console.error("Error in /my-votes:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Проголосовать (UPSERT: можно менять голос сколько угодно раз)
app.post("/vote", async (req, res) => {
  try {
    const { userId, nominationId, nomineeId } = req.body;
    if (!userId || !nominationId || !nomineeId) {
      return res
        .status(400)
        .json({ error: "userId, nominationId и nomineeId обязательны" });
    }

    const votingOpen = await getSettingBool("voting_open", true);
    if (!votingOpen) {
      return res.status(403).json({ error: "Голосование завершено" });
    }

    // проверяем, что номинант существует и принадлежит номинации
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

    // ВАЖНО: у тебя уже есть уникальность (user_id, nomination_id)
    await pool.query(
      `INSERT INTO votes (user_id, nomination_id, nominee_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, nomination_id)
       DO UPDATE SET nominee_id = EXCLUDED.nominee_id`,
      [userId, nominationId, nomineeId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Error in /vote:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Отменить голос
app.post("/unvote", async (req, res) => {
  try {
    const { userId, nominationId } = req.body;
    if (!userId || !nominationId) {
      return res
        .status(400)
        .json({ error: "userId и nominationId обязательны" });
    }

    const votingOpen = await getSettingBool("voting_open", true);
    if (!votingOpen) {
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

// Итоги (только если results_published = true)
app.get("/results", async (req, res) => {
  try {
    const resultsPublished = await getSettingBool("results_published", false);
    if (!resultsPublished) {
      return res.status(403).json({ error: "Итоги ещё не опубликованы" });
    }

    const query = `
      SELECT
        n.id        AS nomination_id,
        n.title     AS nomination_title,
        n.position  AS nomination_position,
        n.imageurl  AS nomination_image_url,

        nm.id       AS nominee_id,
        nm.name     AS nominee_name,
        nm.image_url AS nominee_image_url
      FROM winners w
      JOIN nominations n ON n.id = w.nomination_id
      JOIN nominees nm ON nm.id = w.nominee_id
      WHERE COALESCE(n.is_published, TRUE) = TRUE
      ORDER BY n.position;
    `;

    const r = await pool.query(query);

    const results = r.rows.map((row) => ({
      nomination: {
        id: row.nomination_id,
        title: row.nomination_title,
        position: row.nomination_position,
        imageUrl: row.nomination_image_url,
      },
      winner: {
        id: row.nominee_id,
        name: row.nominee_name,
        imageUrl: row.nominee_image_url,
      },
    }));

    res.json({ results });
  } catch (error) {
    console.error("Error in /results:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT || 10000;
// ===== ADMIN =====

function checkAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// получить текущие статусы
app.get("/admin/status", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT key, value FROM settings WHERE key IN ('voting_open', 'results_published')`
    );

    const status = {
      voting_open: false,
      results_published: false,
    };

    for (const row of result.rows) {
      status[row.key] = row.value === "true";
    }

    res.json(status);
  } catch (e) {
    console.error("admin/status error:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

// изменить статус
app.post("/admin/status", checkAdmin, async (req, res) => {
  const { key, value } = req.body;

  if (!["voting_open", "results_published"].includes(key)) {
    return res.status(400).json({ error: "Invalid key" });
  }

  try {
    await pool.query(
      `
      INSERT INTO settings (key, value)
      VALUES ($1, $2)
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value
      `,
      [key, value ? "true" : "false"]
    );

    res.json({ success: true });
  } catch (e) {
    console.error("admin/status POST error:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

app.listen(PORT, () => console.log("Server running on " + PORT));
