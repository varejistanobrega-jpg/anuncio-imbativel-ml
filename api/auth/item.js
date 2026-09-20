import { getAuthenticatedSession } from "./session.js";
import { getValidMeliAccessToken } from "../../lib/meli-token.js";

const DESCRIPTION_ALLOWED_BODY_KEYS = new Set([
  "item_id",
  "plain_text"
]);

const TITLE_ALLOWED_BODY_KEYS = new Set([
  "item_id",
  "title"
]);

const MAX_TITLE_LENGTH = 60;

function normalizeItemId(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
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
      options.headers["Content-Type"] =
        "application/json";

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

async function authenticateAndLoadItem(
  req,
  itemIdInput
) {
  /*
   * 1. Valida a sessão OAuth do usuário do GPT.
   */
  const session = await getAuthenticatedSession(req);

  if (!session) {
    return {
      error: {
        status: 401,
        body: {
          ok: false,
          applied: false,
          verified: false,
          error:
            "Sessão não autenticada ou expirada"
        }
      }
    };
  }

  /*
   * 2. Valida o ID do anúncio.
   */
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

  /*
   * 3. Obtém token válido exclusivamente
   * da conta autenticada.
   */
  const accessToken =
    await getValidMeliAccessToken(
      session.mlUserId
    );

  /*
   * 4. Consulta o anúncio antes de qualquer
   * leitura complementar ou escrita.
   */
  const itemResult = await requestMercadoLivre(
    `https://api.mercadolibre.com/items/${encodeURIComponent(
      itemId
    )}`,
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
          error:
            "Mercado Livre recusou a consulta do anúncio",
          mercado_livre_status:
            itemResult.http_status,
          mercado_livre_response:
            itemResult.data
        }
      }
    };
  }

  const item = itemResult.data;

  /*
   * 5. Proteção multi-vendedor.
   *
   * O vendedor é determinado pela sessão +
   * resposta do Mercado Livre.
   * Nunca aceitamos seller_id vindo do GPT.
   */
  if (
    !item ||
    !item.seller_id ||
    String(item.seller_id) !==
      String(session.mlUserId)
  ) {
    return {
      error: {
        status: 403,
        body: {
          ok: false,
          applied: false,
          verified: false,
          error:
            "O anúncio não pertence à conta Mercado Livre autenticada"
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
  const loaded = await authenticateAndLoadItem(
    req,
    req.query.item_id
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

  /*
   * Mantém compatibilidade com as views
   * existentes do endpoint.
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

  const categoryId = normalizeItemId(
    item.category_id
  );

  /*
   * VIEW: BASIC
   *
   * Retorna o anúncio completo e sua descrição.
   */
  if (view === "basic") {
    const descriptionResult =
      await requestMercadoLivre(
        `https://api.mercadolibre.com/items/${encodeURIComponent(
          itemId
        )}/description`,
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
   * As demais views exigem categoria válida.
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
      await requestMercadoLivre(
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
      await requestMercadoLivre(
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
    await requestMercadoLivre(
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
    resource_status:
      technicalSpecsResult.ok
        ? "available"
        : "unavailable",
    resource_http_status:
      technicalSpecsResult.http_status,
    technical_specs:
      technicalSpecsResult.data
  });
}

function validateDescriptionBody(body) {
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
   * Allowlist estrita:
   * nenhum outro campo pode entrar neste endpoint.
   */
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

  const itemId = normalizeItemId(
    body.item_id
  );

  if (!/^MLB\d+$/.test(itemId)) {
    throw new Error("item_id inválido");
  }

  if (typeof body.plain_text !== "string") {
    throw new Error(
      "plain_text deve ser uma string"
    );
  }

  /*
   * Não usamos trim no valor final para não
   * modificar silenciosamente o texto aprovado.
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
   * valida a estrutura antes de carregar o anúncio.
   */
  try {
    validated = validateDescriptionBody(
      req.body
    );
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
   * autenticação + propriedade do anúncio.
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
    itemId
  } = loaded;

  /*
   * Snapshot da descrição antes da alteração.
   */
  const beforeResult =
    await requestMercadoLivre(
      `https://api.mercadolibre.com/items/${encodeURIComponent(
        itemId
      )}/description`,
      accessToken
    );

  const beforePlainText =
    beforeResult.ok
      ? extractPlainText(beforeResult.data)
      : null;

  /*
   * Esta primeira Action de escrita de descrição
   * trabalha apenas com descrições já existentes.
   *
   * Criação de descrição ausente será tratada
   * separadamente depois.
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
   * PAYLOAD MÍNIMO.
   *
   * O Mercado Livre recebe somente plain_text.
   * Nenhum outro campo do anúncio participa.
   */
  const updateBody = {
    plain_text: validated.plain_text
  };

  /*
   * Atualiza exclusivamente a descrição existente.
   */
  const updateResult =
    await requestMercadoLivre(
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
   * Reconsulta obrigatória.
   */
  const afterResult =
    await requestMercadoLivre(
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

  /*
   * Comparação literal.
   *
   * Não consideramos sucesso verificado apenas
   * porque o PUT respondeu positivamente.
   */
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
   * Allowlist absoluta:
   * este fluxo aceita SOMENTE item_id e title.
   */
  const receivedKeys = Object.keys(body);

  const forbiddenKeys = receivedKeys.filter(
    (key) =>
      !TITLE_ALLOWED_BODY_KEYS.has(key)
  );

  if (forbiddenKeys.length > 0) {
    throw new Error(
      `Campos não autorizados na atualização de título: ${forbiddenKeys.join(
        ", "
      )}`
    );
  }

  const itemId = normalizeItemId(
    body.item_id
  );

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
   * O valor enviado será exatamente o aprovado.
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
   * estrutura e allowlist antes de carregar o anúncio.
   */
  try {
    validated = validateTitleBody(
      req.body
    );
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

  /*
   * BARREIRA 3:
   * título só é elegível neste fluxo quando
   * o anúncio não possui vendas.
   *
   * Falhamos de forma fechada se sold_quantity
   * estiver ausente, inválido ou for diferente de 0.
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
   * SKU/SELLER_SKU, preço, estoque, atributos,
   * imagens, categoria e demais campos não entram.
   */
  const updateBody = {
    title: validated.title
  };

  /*
   * Atualização do item.
   *
   * Não tentamos contornar estados, moderações
   * ou restrições retornadas pelo Mercado Livre.
   */
  const updateResult =
    await requestMercadoLivre(
      `https://api.mercadolibre.com/items/${encodeURIComponent(
        itemId
      )}`,
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
   * BARREIRA 4:
   * reconsulta obrigatória após o PUT.
   */
  const afterResult =
    await requestMercadoLivre(
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
   * Comparação literal:
   * só marcamos verified=true se o título
   * reconsultado for exatamente o solicitado.
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
