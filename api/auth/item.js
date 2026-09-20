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

    res.setHeader("Cache-Control", "no-store");

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

    const accessToken = await getValidMeliAccessToken(
      session.mlUserId
    );

    /*
     * 1. Consulta os dados principais do anúncio.
     */
    const itemResponse = await fetch(
      `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    const item = await itemResponse.json();

    if (!itemResponse.ok) {
      return res.status(itemResponse.status).json({
        ok: false,
        error: "Mercado Livre recusou a consulta do anúncio",
        status: itemResponse.status
      });
    }

    /*
     * 2. Proteção multi-vendedor.
     *
     * Só continuamos se o Mercado Livre informar o seller_id
     * e ele corresponder à conta vinculada à sessão OAuth.
     */
    if (
      !item.seller_id ||
      String(item.seller_id) !== String(session.mlUserId)
    ) {
      return res.status(403).json({
        ok: false,
        error: "O anúncio não pertence à conta Mercado Livre autenticada"
      });
    }

    /*
     * 3. Depois de confirmar a propriedade do anúncio,
     * consulta sua descrição.
     */
    let description = null;
    let descriptionStatus = "unavailable";

    try {
      const descriptionResponse = await fetch(
        `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}/description`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`
          }
        }
      );

      if (descriptionResponse.ok) {
        description = await descriptionResponse.json();
        descriptionStatus = "available";
      } else {
        console.warn(
          "Descrição do anúncio não disponível:",
          descriptionResponse.status
        );
      }
    } catch (descriptionError) {
      console.warn(
        "Erro ao consultar descrição:",
        descriptionError instanceof Error
          ? descriptionError.message
          : "erro desconhecido"
      );
    }

    /*
     * 4. Retorna somente após todas as verificações.
     */
    return res.status(200).json({
      ok: true,
      item,
      description_status: descriptionStatus,
      description
    });
  } catch (error) {
    console.error(
      "Erro ao consultar anúncio:",
      error instanceof Error
        ? error.message
        : "erro desconhecido"
    );

    return res.status(500).json({
      ok: false,
      error: "Erro interno ao consultar anúncio"
    });
  }
}
