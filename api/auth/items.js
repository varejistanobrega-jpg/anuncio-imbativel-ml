import { getAuthenticatedSession } from "./session.js";
import { getValidMeliAccessToken } from "../../lib/meli-token.js";

const SELLER_ITEMS_LIMIT = 50;

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

function parseNonNegativeInteger(value, fallback = 0) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return fallback;
  }

  const text = String(value);

  if (!/^\d+$/.test(text)) {
    return null;
  }

  const parsed = Number(text);

  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0
  ) {
    return null;
  }

  return parsed;
}

async function listSellerItems(req, res, session, accessToken) {
  /*
   * O vendedor nunca é recebido do GPT.
   * A identidade vem exclusivamente da sessão OAuth autenticada.
   */
  const sellerId = String(session.mlUserId || "");

  if (!/^\d+$/.test(sellerId)) {
    return res.status(401).json({
      ok: false,
      error: "Sessão autenticada sem vendedor válido"
    });
  }

  /*
   * Paginação controlada.
   * O limite fica fixo no servidor para evitar respostas excessivas.
   */
  const offset = parseNonNegativeInteger(
    req.query.offset,
    0
  );

  if (offset === null) {
    return res.status(400).json({
      ok: false,
      error: "offset inválido"
    });
  }

  const searchUrl = new URL(
    `https://api.mercadolibre.com/users/${encodeURIComponent(
      sellerId
    )}/items/search`
  );

  searchUrl.searchParams.set(
    "limit",
    String(SELLER_ITEMS_LIMIT)
  );

  searchUrl.searchParams.set(
    "offset",
    String(offset)
  );

  const searchResult = await getResource(
    searchUrl.toString(),
    accessToken
  );

  if (!searchResult.ok) {
    return res.status(searchResult.status || 502).json({
      ok: false,
      error:
        "Mercado Livre recusou a consulta dos anúncios do vendedor",
      status: searchResult.status
    });
  }

  const data =
    searchResult.data &&
    typeof searchResult.data === "object"
      ? searchResult.data
      : {};

  const rawResults = Array.isArray(data.results)
    ? data.results
    : [];

  /*
   * Mantemos apenas IDs MLB válidos.
   * Nenhum dado de outro vendedor é aceito ou inferido aqui.
   */
  const results = rawResults
    .map((itemId) =>
      String(itemId || "").toUpperCase()
    )
    .filter((itemId) =>
      /^MLB\d+$/.test(itemId)
    );

  const paging =
    data.paging &&
    typeof data.paging === "object"
      ? data.paging
      : {};

  const total = Number.isSafeInteger(
    Number(paging.total)
  )
    ? Number(paging.total)
    : null;

  const returnedOffset = Number.isSafeInteger(
    Number(paging.offset)
  )
    ? Number(paging.offset)
    : offset;

  const returnedLimit = Number.isSafeInteger(
    Number(paging.limit)
  )
    ? Number(paging.limit)
    : SELLER_ITEMS_LIMIT;

  const nextOffset =
    results.length > 0 &&
    (
      total === null ||
      returnedOffset + results.length < total
    )
      ? returnedOffset + results.length
      : null;

  return res.status(200).json({
    ok: true,
    mode: "seller_items",
    seller_id: Number(sellerId),
    paging: {
      total,
      offset: returnedOffset,
      limit: returnedLimit,
      returned: results.length,
      next_offset: nextOffset
    },
    results
  });
}

async function getItemCategory(
  req,
  res,
  session,
  accessToken
) {
  /*
   * Fluxo original:
   * valida o anúncio informado.
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
   * Consulta o anúncio primeiro para validar
   * propriedade e descobrir sua categoria.
   */
  const itemResult = await getResource(
    `https://api.mercadolibre.com/items/${encodeURIComponent(
      itemId
    )}`,
    accessToken
  );

  if (!itemResult.ok) {
    return res.status(itemResult.status || 502).json({
      ok: false,
      error:
        "Mercado Livre recusou a consulta do anúncio",
      status: itemResult.status
    });
  }

  const item = itemResult.data;

  /*
   * Proteção multi-vendedor.
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

  if (!/^MLB\d+$/.test(categoryId)) {
    return res.status(422).json({
      ok: false,
      error:
        "O anúncio não possui categoria válida"
    });
  }

  /*
   * Consulta exclusivamente a categoria.
   */
  const categoryResult = await getResource(
    `https://api.mercadolibre.com/categories/${encodeURIComponent(
      categoryId
    )}`,
    accessToken
  );

  if (!categoryResult.ok) {
    return res.status(200).json({
      ok: true,
      resource_status: "unavailable",
      resource_http_status: categoryResult.status,
      item_id: itemId,
      category_id: categoryId,
      category: null
    });
  }

  return res.status(200).json({
    ok: true,
    resource_status: "available",
    resource_http_status: categoryResult.status,
    item_id: itemId,
    category_id: categoryId,
    category: categoryResult.data
  });
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
     * 1. Identifica o vendedor autenticado pelo OAuth.
     */
    const session = await getAuthenticatedSession(req);

    if (!session) {
      return res.status(401).json({
        ok: false,
        error:
          "Sessão não autenticada ou expirada"
      });
    }

    /*
     * 2. Obtém token Mercado Livre válido da própria
     * conta autenticada.
     */
    const accessToken =
      await getValidMeliAccessToken(
        session.mlUserId
      );

    /*
     * 3. Seleciona o modo da operação.
     *
     * Sem mode:
     * preserva exatamente o comportamento histórico
     * de consulta de categoria por item_id.
     *
     * mode=seller_items:
     * lista de forma compacta os anúncios pertencentes
     * à própria conta autenticada.
     */
    const mode = String(
      req.query.mode || ""
    ).toLowerCase();

    if (mode === "seller_items") {
      return await listSellerItems(
        req,
        res,
        session,
        accessToken
      );
    }

    /*
     * Qualquer mode desconhecido é recusado.
     * Ausência de mode mantém compatibilidade
     * com consultarCategoriaAnuncio.
     */
    if (mode !== "") {
      return res.status(400).json({
        ok: false,
        error: "mode inválido"
      });
    }

    return await getItemCategory(
      req,
      res,
      session,
      accessToken
    );
  } catch (error) {
    console.error(
      "Erro no endpoint de itens:",
      error instanceof Error
        ? error.message
        : "erro desconhecido"
    );

    return res.status(500).json({
      ok: false,
      error:
        "Erro interno no endpoint de itens"
    });
  }
}
