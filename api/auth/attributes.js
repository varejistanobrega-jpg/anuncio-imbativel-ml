import { getAuthenticatedSession } from "./session.js";
import { getValidMeliAccessToken } from "../../lib/meli-token.js";

/*
 * Identificadores absolutamente protegidos.
 * Eles nunca podem participar de uma operação de escrita.
 */
const PROTECTED_ATTRIBUTE_IDS = new Set([
  "SELLER_SKU"
]);

/*
 * Atributos que não queremos permitir nesta primeira
 * versão controlada da escrita.
 */
const BLOCKED_ATTRIBUTE_IDS = new Set([
  "GTIN"
]);

function normalizeId(value) {
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
    status: response.status,
    data
  };
}

/*
 * Defesa profunda contra SKU.
 *
 * Mesmo que no futuro o Schema mude ou algum cliente tente
 * enviar SELLER_SKU em uma estrutura inesperada, a requisição
 * é recusada antes de qualquer PUT no Mercado Livre.
 */
function containsProtectedSkuDeep(value) {
  if (value === null || value === undefined) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some(containsProtectedSkuDeep);
  }

  if (typeof value !== "object") {
    return false;
  }

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizeId(key);

    if (
      normalizedKey === "SELLER_SKU" ||
      normalizedKey === "SELLER_CUSTOM_FIELD"
    ) {
      return true;
    }

    if (
      normalizedKey === "ID" &&
      normalizeId(child) === "SELLER_SKU"
    ) {
      return true;
    }

    if (containsProtectedSkuDeep(child)) {
      return true;
    }
  }

  return false;
}

function sanitizeRequestedAttributes(attributes) {
  if (!Array.isArray(attributes) || attributes.length === 0) {
    throw new Error(
      "É necessário informar pelo menos um atributo"
    );
  }

  const seen = new Set();

  return attributes.map((attribute) => {
    if (
      !attribute ||
      typeof attribute !== "object" ||
      Array.isArray(attribute)
    ) {
      throw new Error("Atributo inválido");
    }

    const id = normalizeId(attribute.id);

    if (!id) {
      throw new Error("Atributo sem id");
    }

    if (PROTECTED_ATTRIBUTE_IDS.has(id)) {
      throw new Error(
        "SKU é um identificador protegido e imutável"
      );
    }

    if (BLOCKED_ATTRIBUTE_IDS.has(id)) {
      throw new Error(
        `O atributo ${id} não está autorizado nesta versão da escrita`
      );
    }

    if (seen.has(id)) {
      throw new Error(
        `Atributo duplicado na solicitação: ${id}`
      );
    }

    seen.add(id);

    const hasValueId =
      Object.prototype.hasOwnProperty.call(
        attribute,
        "value_id"
      ) &&
      attribute.value_id !== undefined &&
      attribute.value_id !== null &&
      String(attribute.value_id).trim() !== "";

    const hasValueName =
      Object.prototype.hasOwnProperty.call(
        attribute,
        "value_name"
      ) &&
      attribute.value_name !== undefined &&
      attribute.value_name !== null &&
      String(attribute.value_name).trim() !== "";

    if (!hasValueId && !hasValueName) {
      throw new Error(
        `O atributo ${id} precisa de value_id ou value_name`
      );
    }

    const sanitized = { id };

    if (hasValueId) {
      sanitized.value_id = String(
        attribute.value_id
      ).trim();
    }

    if (hasValueName) {
      sanitized.value_name = String(
        attribute.value_name
      ).trim();
    }

    return sanitized;
  });
}

async function authenticateAndLoadItem(req, itemId) {
  const session = await getAuthenticatedSession(req);

  if (!session) {
    return {
      error: {
        status: 401,
        body: {
          ok: false,
          error: "Sessão não autenticada ou expirada"
        }
      }
    };
  }

  const normalizedItemId = normalizeId(itemId);

  if (!/^MLB\d+$/.test(normalizedItemId)) {
    return {
      error: {
        status: 400,
        body: {
          ok: false,
          error: "item_id inválido"
        }
      }
    };
  }

  const accessToken = await getValidMeliAccessToken(
    session.mlUserId
  );

  const itemResult = await requestMercadoLivre(
    `https://api.mercadolibre.com/items/${encodeURIComponent(
      normalizedItemId
    )}`,
    accessToken
  );

  if (!itemResult.ok) {
    return {
      error: {
        status: itemResult.status || 502,
        body: {
          ok: false,
          error:
            "Mercado Livre recusou a consulta do anúncio",
          mercado_livre_status: itemResult.status,
          mercado_livre_response: itemResult.data
        }
      }
    };
  }

  const item = itemResult.data;

  /*
   * Proteção multi-vendedor:
   * nunca confiar em seller_id recebido do GPT.
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
          error:
            "O anúncio não pertence à conta Mercado Livre autenticada"
        }
      }
    };
  }

  const categoryId = normalizeId(
    item.category_id
  );

  if (!/^MLB\d+$/.test(categoryId)) {
    return {
      error: {
        status: 422,
        body: {
          ok: false,
          error:
            "O anúncio não possui categoria válida"
        }
      }
    };
  }

  return {
    session,
    accessToken,
    itemId: normalizedItemId,
    categoryId,
    item
  };
}

function findItemAttribute(item, attributeId) {
  const attributes = Array.isArray(item?.attributes)
    ? item.attributes
    : [];

  return (
    attributes.find(
      (attribute) =>
        normalizeId(attribute?.id) ===
        normalizeId(attributeId)
    ) || null
  );
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
    categoryId
  } = loaded;

  const attributesResult =
    await requestMercadoLivre(
      `https://api.mercadolibre.com/categories/${encodeURIComponent(
        categoryId
      )}/attributes`,
      accessToken
    );

  if (!attributesResult.ok) {
    return res.status(200).json({
      ok: true,
      resource_status: "unavailable",
      resource_http_status:
        attributesResult.status,
      item_id: itemId,
      category_id: categoryId,
      attributes: null
    });
  }

  return res.status(200).json({
    ok: true,
    resource_status: "available",
    resource_http_status:
      attributesResult.status,
    item_id: itemId,
    category_id: categoryId,
    attributes: attributesResult.data
  });
}

async function handlePost(req, res) {
  /*
   * PRIMEIRA BARREIRA:
   * SKU não pode aparecer em nenhuma parte da solicitação.
   */
  if (containsProtectedSkuDeep(req.body)) {
    return res.status(400).json({
      ok: false,
      applied: false,
      verified: false,
      error:
        "Solicitação rejeitada: SKU é um identificador protegido e imutável"
    });
  }

  let requestedAttributes;

  try {
    requestedAttributes =
      sanitizeRequestedAttributes(
        req.body?.attributes
      );
  } catch (error) {
    return res.status(400).json({
      ok: false,
      applied: false,
      verified: false,
      error:
        error instanceof Error
          ? error.message
          : "Atributos inválidos"
    });
  }

  const loaded = await authenticateAndLoadItem(
    req,
    req.body?.item_id
  );

  if (loaded.error) {
    return res
      .status(loaded.error.status)
      .json(loaded.error.body);
  }

  const {
    accessToken,
    itemId,
    categoryId,
    item: itemBefore
  } = loaded;

  /*
   * Consulta a definição oficial dos atributos
   * da categoria antes da escrita.
   */
  const categoryAttributesResult =
    await requestMercadoLivre(
      `https://api.mercadolibre.com/categories/${encodeURIComponent(
        categoryId
      )}/attributes`,
      accessToken
    );

  if (!categoryAttributesResult.ok) {
    return res.status(422).json({
      ok: false,
      applied: false,
      verified: false,
      error:
        "Não foi possível validar os atributos da categoria",
      mercado_livre_status:
        categoryAttributesResult.status
    });
  }

  const categoryAttributes =
    Array.isArray(categoryAttributesResult.data)
      ? categoryAttributesResult.data
      : [];

  const categoryAttributeMap = new Map(
    categoryAttributes.map((attribute) => [
      normalizeId(attribute?.id),
      attribute
    ])
  );

  /*
   * Valida individualmente tudo o que será escrito.
   */
  for (const requested of requestedAttributes) {
    const definition =
      categoryAttributeMap.get(requested.id);

    if (!definition) {
      return res.status(400).json({
        ok: false,
        applied: false,
        verified: false,
        error:
          `O atributo ${requested.id} não pertence à categoria ${categoryId}`
      });
    }

    if (
      PROTECTED_ATTRIBUTE_IDS.has(
        requested.id
      )
    ) {
      return res.status(400).json({
        ok: false,
        applied: false,
        verified: false,
        error:
          "SKU é um identificador protegido e imutável"
      });
    }

    const tags =
      definition.tags &&
      typeof definition.tags === "object"
        ? definition.tags
        : {};

    if (
      tags.fixed === true ||
      tags.read_only === true ||
      tags.readonly === true
    ) {
      return res.status(400).json({
        ok: false,
        applied: false,
        verified: false,
        error:
          `O atributo ${requested.id} não pode ser alterado por esta operação`
      });
    }
  }

  /*
   * Snapshot somente dos atributos solicitados.
   */
  const before = requestedAttributes.map(
    (requested) => ({
      id: requested.id,
      value:
        findItemAttribute(
          itemBefore,
          requested.id
        )
    })
  );

  /*
   * PAYLOAD MÍNIMO.
   *
   * Nenhum atributo atual é copiado.
   * SELLER_SKU não entra no payload.
   * Nenhum preço, estoque, título, descrição,
   * imagem, categoria ou outro campo é enviado.
   */
  const updateBody = {
    attributes: requestedAttributes
  };

  /*
   * ÚLTIMA BARREIRA antes do PUT.
   */
  if (containsProtectedSkuDeep(updateBody)) {
    return res.status(400).json({
      ok: false,
      applied: false,
      verified: false,
      error:
        "Operação cancelada: SKU detectado no payload de escrita"
    });
  }

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
      updateResult.status || 502
    ).json({
      ok: false,
      applied: false,
      verified: false,
      item_id: itemId,
      category_id: categoryId,
      error:
        "Mercado Livre recusou a atualização",
      mercado_livre_status:
        updateResult.status,
      mercado_livre_response:
        updateResult.data,
      before,
      requested: requestedAttributes
    });
  }

  /*
   * Nunca considerar o PUT suficiente.
   * Fazemos uma nova leitura do anúncio.
   */
  const verifyResult =
    await requestMercadoLivre(
      `https://api.mercadolibre.com/items/${encodeURIComponent(
        itemId
      )}`,
      accessToken
    );

  if (!verifyResult.ok) {
    return res.status(200).json({
      ok: true,
      applied: true,
      verified: false,
      item_id: itemId,
      category_id: categoryId,
      before,
      requested: requestedAttributes,
      error:
        "A atualização foi aceita, mas a verificação posterior falhou",
      verification_http_status:
        verifyResult.status
    });
  }

  const itemAfter = verifyResult.data;

  const after = requestedAttributes.map(
    (requested) => ({
      id: requested.id,
      value:
        findItemAttribute(
          itemAfter,
          requested.id
        )
    })
  );

  /*
   * Verificação campo a campo.
   */
  const changes = requestedAttributes.map(
    (requested) => {
      const beforeAttribute =
        findItemAttribute(
          itemBefore,
          requested.id
        );

      const afterAttribute =
        findItemAttribute(
          itemAfter,
          requested.id
        );

      const expectedValueId =
        requested.value_id ?? null;

      const expectedValueName =
        requested.value_name ?? null;

      const actualValueId =
        afterAttribute?.value_id ?? null;

      const actualValueName =
        afterAttribute?.value_name ?? null;

      let matches = false;

      if (expectedValueId !== null) {
        matches =
          String(actualValueId) ===
          String(expectedValueId);
      } else if (
        expectedValueName !== null
      ) {
        matches =
          String(actualValueName) ===
          String(expectedValueName);
      }

      return {
        id: requested.id,
        before: beforeAttribute,
        requested,
        after: afterAttribute,
        verified: matches
      };
    }
  );

  const verified = changes.every(
    (change) => change.verified === true
  );

  return res.status(200).json({
    ok: true,
    applied: true,
    verified,
    item_id: itemId,
    category_id: categoryId,
    before,
    requested: requestedAttributes,
    after,
    changes
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

    res.setHeader(
      "Allow",
      "GET, POST"
    );

    return res.status(405).json({
      ok: false,
      error: "Método não permitido"
    });
  } catch (error) {
    console.error(
      "Erro no endpoint de atributos:",
      error instanceof Error
        ? error.message
        : "erro desconhecido"
    );

    return res.status(500).json({
      ok: false,
      applied: false,
      verified: false,
      error:
        "Erro interno no endpoint de atributos"
    });
  }
}
