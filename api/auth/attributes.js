import { getAuthenticatedSession } from "./session.js";
import { getValidMeliAccessToken } from "../../lib/meli-token.js";

async function getResource(url, accessToken) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`
    }
  });

  let data = null;

  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

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

    /*
     * 1. Identifica o vendedor autenticado.
     */
    const session = await getAuthenticatedSession(req);

    if (!session) {
      return res.status(401).json({
        ok: false,
        error: "Sessão não autenticada ou expirada"
      });
    }

    /*
     * 2. Valida o anúncio.
     */
    const itemId = String(
      req.query.item_id || ""
    ).toUpperCase();

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
     * 3. Consulta o anúncio para validar a propriedade
     * e descobrir sua categoria.
     */
    const itemResult = await getResource(
      `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`,
      accessToken
    );

    if (!itemResult.ok) {
      return res.status(itemResult.status || 502).json({
        ok: false,
        error: "Mercado Livre recusou a consulta do anúncio",
        status: itemResult.status
      });
    }

    const item = itemResult.data;

    /*
     * 4. Proteção multi-vendedor.
     */
    if (
      !item ||
      !item.seller_id ||
      String(item.seller_id) !== String(session.mlUserId)
    ) {
      return res.status(403).json({
        ok: false,
        error:
          "O anúncio não pertence à conta Mercado Livre autenticada"
      });
    }

    const categoryId = String(
      item.category_id || ""
    ).toUpperCase();

    if (!/^MLB\d+$/.test(categoryId)) {
      return res.status(422).json({
        ok: false,
        error: "O anúncio não possui categoria válida"
      });
    }

    /*
     * 5. Consulta exclusivamente os atributos
     * da categoria atual do anúncio.
     */
    const attributesResult = await getResource(
      `https://api.mercadolibre.com/categories/${encodeURIComponent(categoryId)}/attributes`,
      accessToken
    );

    if (!attributesResult.ok) {
      return res.status(200).json({
        ok: true,
        resource_status: "unavailable",
        resource_http_status: attributesResult.status,
        item_id: itemId,
        category_id: categoryId,
        attributes: null
      });
    }

    return res.status(200).json({
      ok: true,
      resource_status: "available",
      resource_http_status: attributesResult.status,
      item_id: itemId,
      category_id: categoryId,
      attributes: attributesResult.data
    });
  } catch (error) {
    console.error(
      "Erro ao consultar atributos da categoria:",
      error instanceof Error
        ? error.message
        : "erro desconhecido"
    );

    return res.status(500).json({
      ok: false,
      error:
        "Erro interno ao consultar atributos da categoria"
    });
  }
}
