import { neon } from "@neondatabase/serverless";
import { decryptToken } from "./crypto.js";

export default async function handler(req, res) {
  try {
    const userId = String(req.query.user_id || "");

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
        access_token,
        token_expires_at
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

    const account = rows[0];

    const accessToken = decryptToken(account.access_token);

    const response = await fetch(
      "https://api.mercadolibre.com/users/me",
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

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
      mercado_livre_user_id: data.id,
      nickname: data.nickname || null,
      country_id: data.country_id || null,
      site_id: data.site_id || null
    });
  } catch (error) {
    console.error(
      "Erro ao consultar conta Mercado Livre:",
      error instanceof Error ? error.message : "erro desconhecido"
    );

    return res.status(500).json({
      ok: false,
      error: "Erro interno ao consultar Mercado Livre"
    });
  }
}
