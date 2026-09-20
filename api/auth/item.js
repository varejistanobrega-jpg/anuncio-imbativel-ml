import { getAuthenticatedSession } from "./session.js";
import { getValidMeliAccessToken } from "../../lib/meli-token.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");

      return res.status(405).json({
        ok: false,
        error: "Método não permitido"
      });
    }

    const session = await getAuthenticatedSession(req);

    if (!session) {
      return res.status(401).json({
        ok: false,
        error: "Sessão não autenticada ou expirada"
      });
    }

    const itemId = String(req.query.item_id || "").toUpperCase();

    if (!/^MLB\d+$/.test(itemId)) {
      return res.status(400).json({
        ok: false,
        error: "item_id inválido"
      });
    }

    const accessToken = await getValidMeliAccessToken(session.mlUserId);

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

    if (
      data.seller_id &&
      String(data.seller_id) !== String(session.mlUserId)
    ) {
      return res.status(403).json({
        ok: false,
        error: "O anúncio não pertence à conta Mercado Livre autenticada"
      });
    }

    res.setHeader("Cache-Control", "no-store");

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
