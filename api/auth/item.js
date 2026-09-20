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

    let data = null;

    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      return {
        ok: false,
        http_status: response.status,
        data: null
      };
    }

    return {
      ok: true,
      http_status: response.status,
      data
    };
  } catch (error) {
    console.warn(
      "Erro ao consultar recurso do Mercado Livre:",
      error instanceof Error
        ? error.message
        : "erro desconhecido"
    );

    return {
      ok: false,
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

    /*
     * 1. Valida a sessão OAuth do usuário do GPT.
     */
    const session = await getAuthenticatedSession(req);

    if (!session) {
      return res.status(401).json({
        ok: false,
        error: "Sessão não autenticada ou expirada"
      });
    }

    /*
     * 2. Valida o ID do anúncio.
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

    /*
     * 3. Define qual conjunto de dados será consultado.
     *
     * basic é o padrão para manter compatibilidade
     * com as chamadas anteriores.
     */
    const view = String(
      req.query.view || "basic"
    ).toLowerCase();

    const allowedViews = [
      "basic",
      "category",
      "attributes",
      "technical_specs"
    ];

    if (!allowedViews.includes(view)) {
      return res.status(400).json({
        ok: false,
        error: "view inválida",
        allowed_views: allowedViews
      });
    }

    /*
     * 4. Obtém um token válido do Mercado Livre
     * correspondente ao vendedor da sessão.
     */
    const accessToken = await getValidMeliAccessToken(
      session.mlUserId
    );

    /*
     * 5. Consulta primeiro o anúncio.
     *
     * Essa consulta é obrigatória em todas as views,
     * pois precisamos verificar quem é o proprietário.
     */
    const itemResult = await getMercadoLivreResource(
      `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`,
      accessToken
    );

    if (!itemResult.ok) {
      return res
        .status(itemResult.http_status || 502)
        .json({
          ok: false,
          error: "Mercado Livre recusou a consulta do anúncio",
          status: itemResult.http_status
        });
    }

    const item = itemResult.data;

    /*
     * 6. Proteção multi-vendedor.
     *
     * Falha fechada:
     * sem seller_id ou com vendedor diferente,
     * nenhum dado complementar é devolvido.
     */
    if (
      !item ||
      !item.seller_id ||
      String(item.seller_id) !==
        String(session.mlUserId)
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

    /*
     * VIEW: BASIC
     *
     * Retorna o anúncio completo e sua descrição.
     */
    if (view === "basic") {
      const descriptionResult =
        await getMercadoLivreResource(
          `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}/description`,
          accessToken
        );

      return res.status(200).json({
        ok: true,
        view: "basic",
        item,
        description_status:
          descriptionResult.ok
            ? "available"
            : "unavailable",
        description_http_status:
          descriptionResult.http_status,
        description: descriptionResult.data
      });
    }

    /*
     * As demais views dependem de uma categoria válida.
     */
    if (!/^MLB\d+$/.test(categoryId)) {
      return res.status(422).json({
        ok: false,
        error:
          "O anúncio não possui uma categoria válida para esta consulta"
      });
    }

    /*
     * VIEW: CATEGORY
     */
    if (view === "category") {
      const categoryResult =
        await getMercadoLivreResource(
          `https://api.mercadolibre.com/categories/${encodeURIComponent(categoryId)}`,
          accessToken
        );

      return res.status(200).json({
        ok: true,
        view: "category",
        item_id: itemId,
        category_id: categoryId,
        resource_status:
          categoryResult.ok
            ? "available"
            : "unavailable",
        resource_http_status:
          categoryResult.http_status,
        category: categoryResult.data
      });
    }

    /*
     * VIEW: ATTRIBUTES
     */
    if (view === "attributes") {
      const attributesResult =
        await getMercadoLivreResource(
          `https://api.mercadolibre.com/categories/${encodeURIComponent(categoryId)}/attributes`,
          accessToken
        );

      return res.status(200).json({
        ok: true,
        view: "attributes",
        item_id: itemId,
        category_id: categoryId,
        resource_status:
          attributesResult.ok
            ? "available"
            : "unavailable",
        resource_http_status:
          attributesResult.http_status,
        attributes: attributesResult.data
      });
    }

    /*
     * VIEW: TECHNICAL SPECS
     */
    const technicalSpecsResult =
      await getMercadoLivreResource(
        `https://api.mercadolibre.com/categories/${encodeURIComponent(categoryId)}/technical_specs/input`,
        accessToken
      );

    return res.status(200).json({
      ok: true,
      view: "technical_specs",
      item_id: itemId,
      category_id: categoryId,
      resource_status:
        technicalSpecsResult.ok
          ? "available"
          : "unavailable",
      resource_http_status:
        technicalSpecsResult.http_status,
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
