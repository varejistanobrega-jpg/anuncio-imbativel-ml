import { getAuthenticatedSession } from "./session.js";
import { getValidMeliAccessToken } from "../../lib/meli-token.js";

const DESCRIPTION_ALLOWED_BODY_KEYS = new Set(["item_id", "plain_text"]);
const TITLE_ALLOWED_BODY_KEYS = new Set(["item_id", "title"]);
const MAX_TITLE_LENGTH = 60;

function normalizeItemId(value) {
  return String(value || "").trim().toUpperCase();
}

async function requestMercadoLivre(
  url,
  accessToken,
  method = "GET",
  body = undefined
) {
  try {
    const options = {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`
      }
    };

    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    let data = null;

    try {
      data = await response.json();
    } catch {
      data = null;
    }

    return {
      ok: response.ok,
      http_status: response.status,
      data
    };
  } catch (error) {
    console.warn(
      "Erro ao acessar recurso do Mercado Livre:",
      error instanceof Error ? error.message : "erro desconhecido"
    );

    return {
      ok: false,
      http_status: null,
      data: null
    };
  }
}

async function authenticateAndLoadItem(req, itemIdInput) {
  const session = await getAuthenticatedSession(req);

  if (!session) {
    return {
      error: {
        status: 401,
        body: {
          ok: false,
          applied: false,
          verified: false,
          error: "Sessão não autenticada ou expirada"
        }
      }
    };
  }

  const itemId = normalizeItemId(itemIdInput);

  if (!/^MLB\d+$/.test(itemId)) {
    return {
      error: {
        status: 400,
        body: {
          ok: false,
          applied: false,
          verified: false,
          error: "item_id inválido"
        }
      }
    };
  }

  const accessToken = await getValidMeliAccessToken(session.mlUserId);

  const itemResult = await requestMercadoLivre(
    `https://api.mercadolibre.com/items/${encodeURIComponent(itemId)}`,
    accessToken
  );

  if (!itemResult.ok) {
    return {
      error: {
        status: itemResult.http_status || 502,
        body: {
          ok: false,
          applied: false,
          verified: false,
          error: "Mercado Livre recusou a consulta do anúncio",
          mercado_livre_status: itemResult.http_status,
          mercado_livre_response: itemResult.data
        }
      }
    };
  }

  const item = itemResult.data;

  if (
    !item ||
    !item.seller_id ||
    String(item.seller_id) !== String(session.mlUserId)
  ) {
    return {
      error: {
        status: 403,
        body: {
          ok: false,
          applied: false,
          verified: false,
          error: "O anúncio não pertence à conta Mercado Livre autenticada"
        }
      }
    };
  }

  return {
    session,
    accessToken,
    itemId,
    item
  };
}

async function handleGet(req, res) {
  const loaded = await authenticateAndLoadItem(req, req.query.item_id);

  if (loaded.error) {
    return res
      .status(loaded.error.status)
      .json(loaded.error.body);
  }

  const { accessToken, itemId, item } = loaded;

  const view = String(req.query.view || "basic").toLowerCase();

  const allowedViews = [
    "basic",
    "category",
    "attributes",
    "technical_specs",
    "user_product"
  ];

  if (!allowedViews.includes(view)) {
    return res.status(400).json({
      ok: false,
      error: "view inválida",
      allowed_views: allowedViews
    });
  }

  const categoryId = normalizeItemId(item.category_id);

  if (view === "basic") {
    const descriptionResult = await requestMercadoLivre(
      `https://api.mercadolibre.com/items/${encodeURIComponent(
        itemId
      )}/description`,
      accessToken
    );

    return res.status(200).json({
      ok: true,
      view: "basic",
      item,
      description_status: descriptionResult.ok
        ? "available"
        : "unavailable",
      description_http_status: descriptionResult.http_status,
      description: descriptionResult.data
    });
  }

  /*
   * USER PRODUCT / FAMÍLIA
   *
   * Somente leitura.
   * Não executa qualquer alteração no Mercado Livre.
   */
  if (view === "user_product") {
    const userProductId =
      typeof item.user_product_id === "string"
        ? item.user_product_id.trim()
        : "";

    const itemFamilyId =
      item.family_id !== undefined &&
      item.family_id !== null
        ? String(item.family_id).trim()
        : "";

    const familyName =
      typeof item.family_name === "string"
        ? item.family_name
        : null;

    if (!/^MLBU\d+$/.test(userProductId)) {
      return res.status(422).json({
        ok: false,
        view: "user_product",
        item_id: itemId,
        seller_id: item.seller_id ?? null,
        title:
          typeof item.title === "string"
            ? item.title
            : null,
        status: item.status ?? null,
        sold_quantity: item.sold_quantity ?? null,
        user_product_id: userProductId || null,
        family_id: itemFamilyId || null,
        family_name: familyName,
        error:
          "O anúncio não possui um user_product_id MLB válido para esta consulta"
      });
    }

    const userProductResult = await requestMercadoLivre(
      `https://api.mercadolibre.com/user-products/${encodeURIComponent(
        userProductId
      )}`,
      accessToken
    );

    const upFamilyId =
      userProductResult.ok &&
      userProductResult.data &&
      userProductResult.data.family_id !== undefined &&
      userProductResult.data.family_id !== null
        ? String(userProductResult.data.family_id).trim()
        : "";

    const effectiveFamilyId = upFamilyId || itemFamilyId;

    let familyResult = {
      ok: false,
      http_status: null,
      data: null
    };

    let familyUserProductsResult = {
      ok: false,
      http_status: null,
      data: null
    };

    if (effectiveFamilyId) {
      familyResult = await requestMercadoLivre(
        `https://api.mercadolibre.com/user-products-families/${encodeURIComponent(
          effectiveFamilyId
        )}`,
        accessToken
      );

      familyUserProductsResult = await requestMercadoLivre(
        `https://api.mercadolibre.com/user-products-families/${encodeURIComponent(
          effectiveFamilyId
        )}/user-products`,
        accessToken
      );
    }

    const familyUserProductIds =
      familyUserProductsResult.ok &&
      familyUserProductsResult.data &&
      Array.isArray(
        familyUserProductsResult.data.user_products_ids
      )
        ? familyUserProductsResult.data.user_products_ids
            .filter(
              (value) =>
                typeof value === "string" &&
                /^MLBU\d+$/.test(value.trim())
            )
            .map((value) => value.trim())
        : [];

    /*
     * CONDIÇÕES DE VENDA DA FAMÍLIA
     *
     * Para cada User Product da família:
     * 1. localiza os item_ids pertencentes ao seller autenticado;
     * 2. consulta cada item individualmente;
     * 3. valida novamente a propriedade;
     * 4. retorna sold_quantity e dados mínimos para auditoria.
     *
     * Somente leitura. Nenhum PUT/POST/PATCH é executado aqui.
     */
    const sellingConditions = [];

    for (const relatedUserProductId of familyUserProductIds) {
      const searchResult = await requestMercadoLivre(
        `https://api.mercadolibre.com/users/${encodeURIComponent(
          String(item.seller_id)
        )}/items/search?user_product_id=${encodeURIComponent(
          relatedUserProductId
        )}`,
        accessToken
      );

      const relatedItemIds =
        searchResult.ok &&
        searchResult.data &&
        Array.isArray(searchResult.data.results)
          ? searchResult.data.results
              .filter(
                (value) =>
                  typeof value === "string" &&
                  /^MLB\d+$/.test(value.trim().toUpperCase())
              )
              .map((value) => value.trim().toUpperCase())
          : [];

      const relatedItems = [];

      for (const relatedItemId of relatedItemIds) {
        const relatedItemResult = await requestMercadoLivre(
          `https://api.mercadolibre.com/items/${encodeURIComponent(
            relatedItemId
          )}`,
          accessToken
        );

        if (!relatedItemResult.ok) {
          relatedItems.push({
            item_id: relatedItemId,
            status: "unavailable",
            http_status: relatedItemResult.http_status,
            ownership_verified: false,
            title: null,
            item_status: null,
            sold_quantity: null,
            user_product_id: relatedUserProductId
          });
          continue;
        }

        const relatedItem = relatedItemResult.data;

        const ownershipVerified =
          relatedItem &&
          relatedItem.seller_id &&
          String(relatedItem.seller_id) ===
            String(item.seller_id);

        if (!ownershipVerified) {
          relatedItems.push({
            item_id: relatedItemId,
            status: "ownership_mismatch",
            http_status: relatedItemResult.http_status,
            ownership_verified: false,
            title: null,
            item_status: null,
            sold_quantity: null,
            user_product_id: relatedUserProductId
          });
          continue;
        }

        relatedItems.push({
          item_id: relatedItemId,
          status: "available",
          http_status: relatedItemResult.http_status,
          ownership_verified: true,
          title:
            typeof relatedItem.title === "string"
              ? relatedItem.title
              : null,
          item_status: relatedItem.status ?? null,
          sold_quantity: relatedItem.sold_quantity ?? null,
          user_product_id:
            relatedItem.user_product_id ??
            relatedUserProductId
        });
      }

      sellingConditions.push({
        user_product_id: relatedUserProductId,
        search_status: searchResult.ok
                  ? "available"
          : "unavailable",
        search_http_status: searchResult.http_status,
        paging:
          searchResult.ok &&
          searchResult.data &&
          searchResult.data.paging
            ? {
                total:
                  searchResult.data.paging.total ?? null,
                offset:
                  searchResult.data.paging.offset ?? null,
                limit:
                  searchResult.data.paging.limit ?? null
              }
            : null,
        item_ids: relatedItemIds,
        items: relatedItems
      });
    }

    const allSellingConditionsReadable =
      familyUserProductIds.length > 0 &&
      sellingConditions.length === familyUserProductIds.length &&
      sellingConditions.every(
        (condition) =>
          condition.search_status === "available" &&
          condition.paging &&
          Number.isFinite(Number(condition.paging.total)) &&
          Number(condition.paging.total) ===
            condition.item_ids.length &&
          condition.items.length ===
            condition.item_ids.length &&
          condition.items.every(
            (relatedItem) =>
              relatedItem.status === "available" &&
              relatedItem.ownership_verified === true &&
              Number.isFinite(
                Number(relatedItem.sold_quantity)
              )
          )
      );

    const allSellingConditionsWithoutSales =
      allSellingConditionsReadable &&
      sellingConditions.every((condition) =>
        condition.items.every(
          (relatedItem) =>
            Number(relatedItem.sold_quantity) === 0
        )
      );

    return res.status(200).json({
      ok: true,
      view: "user_product",

      item_id: itemId,
      seller_id: item.seller_id ?? null,
      title:
        typeof item.title === "string"
          ? item.title
          : null,
      status: item.status ?? null,
      sold_quantity: item.sold_quantity ?? null,

      user_product_id: userProductId,
      family_id: effectiveFamilyId || null,
      family_name: familyName,

      user_product: {
        status: userProductResult.ok
          ? "available"
          : "unavailable",
        http_status: userProductResult.http_status,
        data: userProductResult.data
      },

      family: {
        status: familyResult.ok
          ? "available"
          : "unavailable",
        http_status: familyResult.http_status,
        data: familyResult.data
      },

      family_user_products: {
        status: familyUserProductsResult.ok
          ? "available"
          : "unavailable",
        http_status:
          familyUserProductsResult.http_status,
        family_id: effectiveFamilyId || null,
        user_products_ids: familyUserProductIds
      },

      selling_conditions: {
        status: allSellingConditionsReadable
          ? "available"
          : "incomplete",
        all_readable: allSellingConditionsReadable,
        all_without_sales:
          allSellingConditionsReadable
            ? allSellingConditionsWithoutSales
            : null,
        user_products: sellingConditions
      }
    });
  }

  if (!/^MLB\d+$/.test(categoryId)) {
    return res.status(422).json({
      ok: false,
      error:
        "O anúncio não possui uma categoria válida para esta consulta"
    });
  }

  if (view === "category") {
    const categoryResult = await requestMercadoLivre(
      `https://api.mercadolibre.com/categories/${encodeURIComponent(
        categoryId
      )}`,
      accessToken
    );

    return res.status(200).json({
      ok: true,
      view: "category",
      item_id: itemId,
      category_id: categoryId,
      resource_status: categoryResult.ok
        ? "available"
        : "unavailable",
      resource_http_status: categoryResult.http_status,
      category: categoryResult.data
    });
  }

  if (view === "attributes") {
    const attributesResult = await requestMercadoLivre(
      `https://api.mercadolibre.com/categories/${encodeURIComponent(
        categoryId
      )}/attributes`,
      accessToken
    );

    return res.status(200).json({
      ok: true,
      view: "attributes",
      item_id: itemId,
      category_id: categoryId,
      resource_status: attributesResult.ok
        ? "available"
        : "unavailable",
      resource_http_status:
        attributesResult.http_status,
      attributes: attributesResult.data
    });
  }

  const technicalSpecsResult = await requestMercadoLivre(
    `https://api.mercadolibre.com/categories/${encodeURIComponent(
      categoryId
    )}/technical_specs/input`,
    accessToken
  );

  return res.status(200).json({
    ok: true,
    view: "technical_specs",
    item_id: itemId,
    category_id: categoryId,
    resource_status: technicalSpecsResult.ok
      ? "available"
      : "unavailable",
    resource_http_status:
      technicalSpecsResult.http_status,
    technical_specs: technicalSpecsResult.data
  });
}

function validateDescriptionBody(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw new Error("Corpo da solicitação inválido");
  }

  const receivedKeys = Object.keys(body);

  const forbiddenKeys = receivedKeys.filter(
    (key) =>
      !DESCRIPTION_ALLOWED_BODY_KEYS.has(key)
  );

  if (forbiddenKeys.length > 0) {
    throw new Error(
      `Campos não autorizados na atualização de descrição: ${forbiddenKeys.join(
        ", "
      )}`
    );
  }

  const itemId = normalizeItemId(body.item_id);

  if (!/^MLB\d+$/.test(itemId)) {
    throw new Error("item_id inválido");
  }

  if (typeof body.plain_text !== "string") {
    throw new Error(
      "plain_text deve ser uma string"
    );
  }

  /*
   * Não usamos trim no valor retornado.
   * Isso evita modificar silenciosamente
   * a descrição aprovada pelo usuário.
   */
  if (body.plain_text.trim().length === 0) {
    throw new Error(
      "A descrição não pode estar vazia"
    );
  }

  return {
    item_id: itemId,
    plain_text: body.plain_text
  };
}

function extractPlainText(description) {
  if (
    !description ||
    typeof description !== "object"
  ) {
    return null;
  }

  if (
    typeof description.plain_text === "string"
  ) {
    return description.plain_text;
  }

  return null;
}

async function handlePost(req, res) {
  let validated;

  /*
   * BARREIRA 1:
   * validação do corpo.
   */
  try {
    validated = validateDescriptionBody(req.body);
  } catch (error) {
    return res.status(400).json({
      ok: false,
      applied: false,
      verified: false,
      error:
        error instanceof Error
          ? error.message
          : "Solicitação inválida"
    });
  }

  /*
   * BARREIRA 2:
   * autenticação + propriedade.
   */
  const loaded = await authenticateAndLoadItem(
    req,
    validated.item_id
  );

  if (loaded.error) {
    return res
      .status(loaded.error.status)
      .json(loaded.error.body);
  }

  const { accessToken, itemId } = loaded;

  const beforeResult = await requestMercadoLivre(
    `https://api.mercadolibre.com/items/${encodeURIComponent(
      itemId
    )}/description`,
    accessToken
  );

  const beforePlainText = beforeResult.ok
    ? extractPlainText(beforeResult.data)
    : null;

  /*
   * Este fluxo trabalha somente com
   * descrição já existente.
   */
  if (!beforeResult.ok) {
    return res.status(422).json({
      ok: false,
      applied: false,
      verified: false,
      item_id: itemId,
      error:
        "Não foi possível carregar a descrição atual; nenhuma alteração foi executada",
      description_http_status:
        beforeResult.http_status
    });
  }

  /*
   * PAYLOAD MÍNIMO:
   * somente plain_text.
   */
  const updateBody = {
    plain_text: validated.plain_text
  };

  const updateResult = await requestMercadoLivre(
    `https://api.mercadolibre.com/items/${encodeURIComponent(
      itemId
    )}/description?api_version=2`,
    accessToken,
    "PUT",
    updateBody
  );

  if (!updateResult.ok) {
    return res.status(
      updateResult.http_status || 502
    ).json({
      ok: false,
      applied: false,
      verified: false,
      item_id: itemId,
      error:
        "Mercado Livre recusou a atualização da descrição",
      mercado_livre_status:
        updateResult.http_status,
      mercado_livre_response:
        updateResult.data,
      before: {
        plain_text: beforePlainText
      },
      requested: {
        plain_text: validated.plain_text
      }
    });
  }

  /*
   * Reconsulta obrigatória após a escrita.
   */
  const afterResult = await requestMercadoLivre(
    `https://api.mercadolibre.com/items/${encodeURIComponent(
      itemId
    )}/description`,
    accessToken
  );

  if (!afterResult.ok) {
    return res.status(200).json({
      ok: true,
      applied: true,
      verified: false,
      item_id: itemId,
      before: {
        plain_text: beforePlainText
      },
      requested: {
        plain_text: validated.plain_text
      },
      error:
        "A descrição foi aceita, mas a verificação posterior falhou",
      verification_http_status:
        afterResult.http_status
    });
  }

  const afterPlainText =
    extractPlainText(afterResult.data);

  const verified =
    afterPlainText === validated.plain_text;

  return res.status(200).json({
    ok: true,
    applied: true,
    verified,
    item_id: itemId,
    before: {
      plain_text: beforePlainText
    },
    requested: {
      plain_text: validated.plain_text
    },
    after: {
      plain_text: afterPlainText
    },
    changes: [
      {
        field: "description.plain_text",
        before: beforePlainText,
        requested: validated.plain_text,
        after: afterPlainText,
        verified
      }
    ]
  });
}

function validateTitleBody(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw new Error(
      "Corpo da solicitação inválido"
    );
  }

  /*
   * Allowlist absoluta.
   *
   * Este fluxo aceita SOMENTE:
   * item_id
   * title
   */
  const receivedKeys = Object.keys(body);

  const forbiddenKeys = receivedKeys.filter(
    (key) => !TITLE_ALLOWED_BODY_KEYS.has(key)
  );

  if (forbiddenKeys.length > 0) {
    throw new Error(
      `Campos não autorizados na atualização de título: ${forbiddenKeys.join(
        ", "
      )}`
    );
  }

  const itemId = normalizeItemId(body.item_id);

  if (!/^MLB\d+$/.test(itemId)) {
    throw new Error("item_id inválido");
  }

  if (typeof body.title !== "string") {
    throw new Error(
      "title deve ser uma string"
    );
  }

  /*
   * Não modificamos silenciosamente o título.
   */
  if (body.title.trim().length === 0) {
    throw new Error(
      "O título não pode estar vazio"
    );
  }

  if (body.title.length > MAX_TITLE_LENGTH) {
    throw new Error(
      `O título não pode ultrapassar ${MAX_TITLE_LENGTH} caracteres`
    );
  }

  return {
    item_id: itemId,
    title: body.title
  };
}

async function handlePatch(req, res) {
  let validated;

  /*
   * BARREIRA 1:
   * estrutura + allowlist.
   */
  try {
    validated = validateTitleBody(req.body);
  } catch (error) {
    return res.status(400).json({
      ok: false,
      applied: false,
      verified: false,
      error:
        error instanceof Error
          ? error.message
          : "Solicitação inválida"
    });
  }

  /*
   * BARREIRA 2:
   * autenticação + propriedade.
   */
  const loaded = await authenticateAndLoadItem(
    req,
    validated.item_id
  );

  if (loaded.error) {
    return res
      .status(loaded.error.status)
      .json(loaded.error.body);
  }

  const {
    accessToken,
    itemId,
    item
  } = loaded;

  const beforeTitle =
    typeof item.title === "string"
      ? item.title
      : null;

  const soldQuantity =
    Number(item.sold_quantity);

  const familyName =
    typeof item.family_name === "string"
      ? item.family_name.trim()
      : "";

  /*
   * BARREIRA 3:
   * USER PRODUCTS / FAMILY NAME.
   *
   * Se family_name estiver presente,
   * title direto NÃO entra neste fluxo.
   *
   * O bloqueio ocorre ANTES de qualquer PUT.
   */
  if (familyName.length > 0) {
    return res.status(422).json({
      ok: false,
      applied: false,
      verified: false,
      item_id: itemId,

      reason: "USER_PRODUCT_FAMILY",

      error:
        "Este anúncio pertence ao modelo User Products e possui family_name; a alteração direta de title foi bloqueada antes de qualquer escrita",

      sold_quantity:
        item.sold_quantity ?? null,

      user_product_id:
        item.user_product_id ?? null,

      family_id:
        item.family_id ?? null,

      family_name:
        item.family_name,

      before: {
        title: beforeTitle
      },

      requested: {
        title: validated.title
      }
    });
  }
    /*
   * BARREIRA 4:
   * fluxo de título direto somente para
   * anúncio sem vendas.
   *
   * Falha fechada se sold_quantity:
   * - estiver ausente;
   * - for inválido;
   * - for diferente de zero.
   */
  if (
    !Number.isFinite(soldQuantity) ||
    soldQuantity !== 0
  ) {
    return res.status(422).json({
      ok: false,
      applied: false,
      verified: false,
      item_id: itemId,
      error:
        "O título não pode ser alterado por este fluxo porque o anúncio possui vendas ou a quantidade vendida não pôde ser validada como zero",
      sold_quantity:
        item.sold_quantity ?? null,
      before: {
        title: beforeTitle
      },
      requested: {
        title: validated.title
      }
    });
  }

  /*
   * PAYLOAD MÍNIMO E ISOLADO.
   *
   * O Mercado Livre recebe SOMENTE title.
   *
   * Não entram:
   * SKU / SELLER_SKU
   * descrição
   * atributos
   * categoria
   * preço
   * estoque
   * imagens
   * variações
   * family_name
   * qualquer outro campo
   */
  const updateBody = {
    title: validated.title
  };

  const updateResult = await requestMercadoLivre(
    `https://api.mercadolibre.com/items/${encodeURIComponent(
      itemId
    )}`,
    accessToken,
    "PUT",
    updateBody
  );

  /*
   * Não contorna rejeições do Mercado Livre.
   */
  if (!updateResult.ok) {
    return res.status(
      updateResult.http_status || 502
    ).json({
      ok: false,
      applied: false,
      verified: false,
      item_id: itemId,
      error:
        "Mercado Livre recusou a atualização do título",
      mercado_livre_status:
        updateResult.http_status,
      mercado_livre_response:
        updateResult.data,
      before: {
        title: beforeTitle
      },
      requested: {
        title: validated.title
      }
    });
  }

  /*
   * BARREIRA 5:
   * reconsulta obrigatória.
   */
  const afterResult = await requestMercadoLivre(
    `https://api.mercadolibre.com/items/${encodeURIComponent(
      itemId
    )}`,
    accessToken
  );

  if (!afterResult.ok) {
    return res.status(200).json({
      ok: true,
      applied: true,
      verified: false,
      item_id: itemId,
      before: {
        title: beforeTitle
      },
      requested: {
        title: validated.title
      },
      error:
        "A atualização do título foi aceita, mas a verificação posterior falhou",
      verification_http_status:
        afterResult.http_status
    });
  }

  const afterTitle =
    afterResult.data &&
    typeof afterResult.data.title === "string"
      ? afterResult.data.title
      : null;

  /*
   * Verificação literal.
   */
  const verified =
    afterTitle === validated.title;

  return res.status(200).json({
    ok: true,
    applied: true,
    verified,
    item_id: itemId,
    sold_quantity: soldQuantity,

    before: {
      title: beforeTitle
    },

    requested: {
      title: validated.title
    },

    after: {
      title: afterTitle
    },

    changes: [
      {
        field: "title",
        before: beforeTitle,
        requested: validated.title,
        after: afterTitle,
        verified
      }
    ]
  });
}

export default async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  try {
    if (req.method === "GET") {
      return await handleGet(req, res);
    }

    if (req.method === "POST") {
      return await handlePost(req, res);
    }

    if (req.method === "PATCH") {
      return await handlePatch(req, res);
    }

    res.setHeader(
      "Allow",
      "GET, POST, PATCH"
    );

    return res.status(405).json({
      ok: false,
      error: "Método não permitido"
    });
  } catch (error) {
    console.error(
      "Erro no endpoint de anúncio/descrição/título:",
      error instanceof Error
        ? error.message
        : "erro desconhecido"
    );

    return res.status(500).json({
      ok: false,
      applied: false,
      verified: false,
      error:
        "Erro interno no endpoint de anúncio/descrição/título"
    });
  }
}
