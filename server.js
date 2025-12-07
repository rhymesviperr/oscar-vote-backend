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

// 👉 Список номинаций + кандидаты
app.get("/nominations", async (req, res) => {
  try {
    const query = `
      SELECT
        n.id AS nomination_id,
        n.title AS nomination_title,
        n.description AS nomination_description,
        n.position AS nomination_position,
        nom.id AS nominee_id,
        nom.name AS nominee_name,
        nom.image_url AS nominee_image_url,
        nom.position AS nominee_position
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on " + PORT));
