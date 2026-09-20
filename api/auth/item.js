import { neon } from "@neondatabase/serverless";
import { decryptToken } from "./crypto.js";

export default async function handler(req, res) {
  try {
    const userId = String(req.query.user_id || "");
    const itemId = String(req.query.item_id || "").toUpperCase();

    if (!/^\d+$/.test(userId)) {
      return res.status(400).json({
        ok: false,
        error: "user_id inválido"
      });
    }

    if (!/^MLB\d+$/.test(itemId)) {
      return res.status(400).json({
        ok: false,
        error: "item_id inválido"
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

    const response = await fetch(
      `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`,
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
        error: "Mercado Livre recusou a consulta do anúncio",
        status: response.status
      });
    }

    // Segurança multi-vendedor:
    // impede usar a conta autenticada de um vendedor
    // para consultar como próprio um anúncio de outro vendedor.
    if (
      data.seller_id &&
      String(data.seller_id) !== userId
    ) {
      return res.status(403).json({
        ok: false,
        error: "O anúncio não pertence à conta Mercado Livre informada"
      });
    }

    return res.status(200).json({
      ok: true,
      item: data
    });
  } catch (error) {
    console.error(
      "Erro ao consultar anúncio:",
      error instanceof Error ? error.message : "erro desconhecido"
    );

    return res.status(500).json({
      ok: false,
      error: "Erro interno ao consultar anúncio"
    });
  }
}
