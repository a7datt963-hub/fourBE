// server.js
const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const BASE = process.env.FASTCARD_BASE || "https://store.ahminix.com/client/api";
const TOKEN = process.env.FASTCARD_TOKEN;

// جلب البطاقات
app.get("/api/cards", async (req, res) => {
  try {
    const r = await axios.get(`${BASE}/products`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// إنشاء طلب
app.post("/api/orders", async (req, res) => {
  try {
    const r = await axios.post(`${BASE}/orders`, req.body, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Proxy running on port " + PORT));
