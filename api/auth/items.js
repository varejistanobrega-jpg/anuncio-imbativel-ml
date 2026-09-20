import { neon } from "@neondatabase/serverless";
import { decryptToken } from "./crypto.js";

export default async function handler(req, res) {
  try {
    const userId = String(req.query.user_id || "");
    const limit = Math.min(
      Math.max(Number(req.query.limit) || 50, 1),
      100
    );
    const offset = Math.max(
      Number(req.query.offset) || 0,
      0
    );

    if (!/^\d+$/.test(userId)) {
      return res.status(400).json({
        ok: false,
        error: "user_id inválido"
      });
    }

    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
      return res.status(500).json({
        ok: false,
        error: "Conexão com o banco não encontrada"
      });
    }

    const sql = neon(databaseUrl);

    const rows = await sql`
      SELECT
        ml_user_id,
        access_token
      FROM mercado_livre_accounts
      WHERE ml_user_id = ${userId}
      LIMIT 1
    `;

    if (rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Conta Mercado Livre não encontrada"
      });
    }

    const accessToken = decryptToken(rows[0].access_token);

    const url = new URL(
      `https://api.mercadolibre.com/users/${userId}/items/search`
    );

    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: "Mercado Livre recusou a consulta",
        details: data
      });
    }

    return res.status(200).json({
      ok: true,
      user_id: userId,
      paging: data.paging || null,
      results: data.results || [],
      orders: data.orders || [],
      available_orders: data.available_orders || []
    });
  } catch (error) {
    console.error(
      "Erro ao consultar anúncios:",
      error instanceof Error ? error.message : "erro desconhecido"
    );

    return res.status(500).json({
      ok: false,
      error: "Erro interno ao consultar anúncios"
    });
  }
}
