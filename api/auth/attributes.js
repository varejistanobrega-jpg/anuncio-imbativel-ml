import { getAuthenticatedSession } from "./session.js";
import { getValidMeliAccessToken } from "../../lib/meli-token.js";

/*
 * Identificadores absolutamente protegidos.
 * Nunca podem participar de uma operação de escrita.
 */
const ABSOLUTELY_PROTECTED_ATTRIBUTE_IDS = new Set([
  "SELLER_SKU"
]);

/*
 * Identificadores de produto que ficam fora desta
 * primeira superfície genérica de escrita.
 *
 * Terão tratamento específico futuramente.
 */
const TEMPORARILY_BLOCKED_ATTRIBUTE_IDS = new Set([
  "GTIN",
  "EAN",
  "UPC",
  "JAN"
]);

function normalizeId(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function hasTrueTag(tags, tagName) {
  if (!tags || typeof tags !== "object") {
    return false;
  }

  return tags[tagName] === true;
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
 * Defesa profunda.
 *
 * SELLER_SKU não pode aparecer em nenhuma estrutura
 * recebida para escrita.
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

    if (ABSOLUTELY_PROTECTED_ATTRIBUTE_IDS.has(id)) {
      throw new Error(
        "SKU é um identificador protegido e imutável"
      );
    }

    if (TEMPORARILY_BLOCKED_ATTRIBUTE_IDS.has(id)) {
      throw new Error(
        `O atributo ${id} exige fluxo específico e não está autorizado nesta operação`
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
          applied: false,
          verified: false,
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
          applied: false,
          verified: false,
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
          applied: false,
          verified: false,
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
   * Proteção multi-vendedor.
   *
   * O seller_id usado aqui vem do próprio Mercado Livre,
   * nunca do corpo enviado pelo GPT.
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

  const categoryId = normalizeId(
    item.category_id
  );

  if (!/^MLB\d+$/.test(categoryId)) {
    return {
      error: {
        status: 422,
        body: {
          ok: false,
          applied: false,
          verified: false,
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

function getDefinitionValues(definition) {
  return Array.isArray(definition?.values)
    ? definition.values
    : [];
}

function validateRequestedAttribute(
  requested,
  definition,
  item
) {
  const tags =
    definition?.tags &&
    typeof definition.tags === "object"
      ? definition.tags
      : {};

  /*
   * Campos que o vendedor não deve modificar.
   */
  if (
    hasTrueTag(tags, "read_only") ||
    hasTrueTag(tags, "readonly")
  ) {
    throw new Error(
      `O atributo ${requested.id} é somente leitura`
    );
  }

  if (hasTrueTag(tags, "fixed")) {
    throw new Error(
      `O atributo ${requested.id} possui valor fixo`
    );
  }

  if (hasTrueTag(tags, "inferred")) {
    throw new Error(
      `O atributo ${requested.id} possui valor inferido e não pode ser alterado`
    );
  }

  /*
   * Esta Action modifica atributos no nível do item.
   *
   * Se o anúncio possui variações, atributos marcados como
   * variation_attribute ficam fora deste endpoint genérico.
   * Futuramente terão fluxo próprio por variação.
   *
   * Se NÃO existem variações, a tag por si só não bloqueia
   * o atributo.
   */
  const variations = Array.isArray(item?.variations)
    ? item.variations
    : [];

  if (
    variations.length > 0 &&
    hasTrueTag(tags, "variation_attribute")
  ) {
    throw new Error(
      `O atributo ${requested.id} exige tratamento específico por variação neste anúncio`
    );
  }

  const valueType = String(
    definition?.value_type || ""
  )
    .trim()
    .toLowerCase();

  const definitionValues =
    getDefinitionValues(definition);

  /*
   * BOOLEAN
   *
   * A API exige o ID do valor.
   */
  if (valueType === "boolean") {
    if (!requested.value_id) {
      throw new Error(
        `O atributo booleano ${requested.id} exige value_id`
      );
    }

    if (definitionValues.length > 0) {
      const allowed = definitionValues.some(
        (value) =>
          String(value?.id) ===
          String(requested.value_id)
      );

      if (!allowed) {
        throw new Error(
          `value_id inválido para o atributo ${requested.id}`
        );
      }
    }
  }

  /*
   * LIST
   *
   * Quando o cliente envia value_id, esse ID precisa
   * existir entre os valores apresentados pela categoria.
   *
   * value_name continua permitido porque existem fluxos
   * do Mercado Livre em que o nome pode ser informado.
   */
  if (
    valueType === "list" &&
    requested.value_id &&
    definitionValues.length > 0
  ) {
    const allowed = definitionValues.some(
      (value) =>
        String(value?.id) ===
        String(requested.value_id)
    );

    if (!allowed) {
      throw new Error(
        `value_id inválido para o atributo ${requested.id}`
      );
    }
  }

  /*
   * Limite máximo de caracteres definido pela categoria.
   */
  const maxLength = Number(
    definition?.value_max_length
  );

  if (
    Number.isFinite(maxLength) &&
    maxLength > 0
  ) {
    if (
      requested.value_name &&
      requested.value_name.length > maxLength
    ) {
      throw new Error(
        `value_name excede o limite de ${maxLength} caracteres para ${requested.id}`
      );
    }

    if (
      requested.value_id &&
      requested.value_id.length > maxLength
    ) {
      throw new Error(
        `value_id excede o limite de ${maxLength} caracteres para ${requested.id}`
      );
    }
  }
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
   * BARREIRA 1:
   * rejeita SKU antes até mesmo de carregar o anúncio.
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
   * Carrega a definição atual dos atributos da categoria.
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
   * Validação completa antes de qualquer PUT.
   */
  try {
    for (const requested of requestedAttributes) {
      const definition =
        categoryAttributeMap.get(requested.id);

      if (!definition) {
        throw new Error(
          `O atributo ${requested.id} não pertence à categoria ${categoryId}`
        );
      }

      if (
        ABSOLUTELY_PROTECTED_ATTRIBUTE_IDS.has(
          requested.id
        )
      ) {
        throw new Error(
          "SKU é um identificador protegido e imutável"
        );
      }

      if (
        TEMPORARILY_BLOCKED_ATTRIBUTE_IDS.has(
          requested.id
        )
      ) {
        throw new Error(
          `O atributo ${requested.id} exige fluxo específico e não está autorizado nesta operação`
        );
      }

      validateRequestedAttribute(
        requested,
        definition,
        itemBefore
      );
    }
  } catch (error) {
    return res.status(400).json({
      ok: false,
      applied: false,
      verified: false,
      item_id: itemId,
      category_id: categoryId,
      error:
        error instanceof Error
          ? error.message
          : "Atributo não autorizado"
    });
  }

  /*
   * Snapshot dos campos que realmente serão modificados.
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
   * Somente os atributos solicitados entram no PUT.
   * SELLER_SKU nunca é copiado do anúncio.
   */
  const updateBody = {
    attributes: requestedAttributes
  };

  /*
   * BARREIRA 2:
   * inspeção final do payload imediatamente antes do PUT.
   */
  if (containsProtectedSkuDeep(updateBody)) {
    return res.status(400).json({
      ok: false,
      applied: false,
      verified: false,
      item_id: itemId,
      category_id: categoryId,
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
   * Nunca considerar somente a resposta do PUT
   * como prova suficiente.
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
