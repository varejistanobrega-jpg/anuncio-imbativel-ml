import { getAuthenticatedSession } from "./session.js";
import { getValidMeliAccessToken } from "../../lib/meli-token.js";

async function getMercadoLivreResource(url, accessToken) {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      return {
        status: "unavailable",
        http_status: response.status,
        data: null
      };
    }

    return {
      status: "available",
      http_status: response.status,
      data: await response.json()
    };
  } catch (error) {
    console.warn(
      "Erro em recurso complementar do Mercado Livre:",
      error instanceof Error ? error.message : "erro desconhecido"
    );

    return {
      status: "unavailable",
      http_status: null,
      data: null
    };
  }
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
     * 3. Precisamos de uma categoria válida para realizar
     * as consultas técnicas complementares.
     */
    const categoryId = String(item.category_id || "").toUpperCase();

    const validCategoryId = /^MLB\d+$/.test(categoryId);

    /*
     * 4. Consulta descrição, categoria, atributos e
     * ficha técnica atual.
     *
     * Essas consultas são independentes. A indisponibilidade
     * de uma delas não impede o retorno dos dados principais.
     */
    const descriptionPromise = getMercadoLivreResource(
      `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}/description`,
      accessToken
    );

    let categoryPromise = Promise.resolve({
      status: "unavailable",
      http_status: null,
      data: null
    });

    let attributesPromise = Promise.resolve({
      status: "unavailable",
      http_status: null,
      data: null
    });

    let technicalSpecsPromise = Promise.resolve({
      status: "unavailable",
      http_status: null,
      data: null
    });

    if (validCategoryId) {
      categoryPromise = getMercadoLivreResource(
        `https://api.mercadolibre.com/categories/${encodeURIComponent(categoryId)}`,
        accessToken
      );

      attributesPromise = getMercadoLivreResource(
        `https://api.mercadolibre.com/categories/${encodeURIComponent(categoryId)}/attributes`,
        accessToken
      );

      technicalSpecsPromise = getMercadoLivreResource(
        `https://api.mercadolibre.com/categories/${encodeURIComponent(categoryId)}/technical_specs/input`,
        accessToken
      );
    }

    const [
      descriptionResult,
      categoryResult,
      attributesResult,
      technicalSpecsResult
    ] = await Promise.all([
      descriptionPromise,
      categoryPromise,
      attributesPromise,
      technicalSpecsPromise
    ]);

    /*
     * 5. Retorna o anúncio e os recursos necessários
     * para auditoria técnica.
     */
    return res.status(200).json({
      ok: true,
      item,

      description_status: descriptionResult.status,
      description_http_status: descriptionResult.http_status,
      description: descriptionResult.data,

      category_status: categoryResult.status,
      category_http_status: categoryResult.http_status,
      category: categoryResult.data,

      category_attributes_status: attributesResult.status,
      category_attributes_http_status: attributesResult.http_status,
      category_attributes: attributesResult.data,

      technical_specs_status: technicalSpecsResult.status,
      technical_specs_http_status: technicalSpecsResult.http_status,
      technical_specs: technicalSpecsResult.data
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
