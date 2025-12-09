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
  ssl: { rejectUnauthorized: false }
});

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

// ===== Список номинаций + кандидаты (с картинкой номинации!) =====
app.get("/nominations", async (req, res) => {
  try {
    const query = `
      SELECT
        n.id          AS nomination_id,
        n.title       AS nomination_title,
        n.description AS nomination_description,
        n.position    AS nomination_position,
        n.image_url   AS nomination_image_url,   -- 🔥 картинка НОМИНАЦИИ

        nom.id        AS nominee_id,
        nom.name      AS nominee_name,
        nom.image_url AS nominee_image_url,
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
          imageUrl: row.nomination_image_url,  // 👈 идёт в JSON
          nominees: []
        });
      }

      if (row.nominee_id) {
        nominationsMap.get(nId).nominees.push({
          id: row.nominee_id,
          name: row.nominee_name,
          imageUrl: row.nominee_image_url,
          position: row.nominee_position
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

// 👉 вспомогательная функция: создаём пользователя, если его ещё нет
async function ensureUserExists(userId) {
  await pool.query(
    `INSERT INTO users (id)
     VALUES ($1)
     ON CONFLICT (id) DO NOTHING`,
    [userId]
  );
}

// 👉 отдать голоса пользователя
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

// 👉 проголосовать
app.post("/vote", async (req, res) => {
  try {
    const { userId, nominationId, nomineeId } = req.body;
    if (!userId || !nominationId || !nomineeId) {
      return res
        .status(400)
        .json({ error: "userId, nominationId и nomineeId обязательны" });
    }

    // убеждаемся, что номинант существует и принадлежит номинации
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

    // создаём пользователя, если его ещё нет
    await ensureUserExists(userId);

    // убираем прошлый голос в этой номинации
    await pool.query(
      `DELETE FROM votes WHERE user_id = $1 AND nomination_id = $2`,
      [userId, nominationId]
    );

    // вставляем новый голос
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

// 👉 отменить голос (удалить из базы)
app.post("/unvote", async (req, res) => {
  try {
    const { userId, nominationId } = req.body;
    if (!userId || !nominationId) {
      return res
        .status(400)
        .json({ error: "userId и nominationId обязательны" });
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on " + PORT));
