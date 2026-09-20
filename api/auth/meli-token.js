import { neon } from "@neondatabase/serverless";
import { decryptToken, encryptToken } from "./crypto.js";

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export async function getValidMeliAccessToken(mlUserId) {
  const databaseUrl = process.env.DATABASE_URL;
  const clientId = process.env.MELI_CLIENT_ID;
  const clientSecret = process.env.MELI_CLIENT_SECRET;

  if (!databaseUrl || !clientId || !clientSecret) {
    throw new Error("Configuração Mercado Livre incompleta");
  }

  const sql = neon(databaseUrl);

  const rows = await sql`
    SELECT
      ml_user_id,
      access_token,
      refresh_token,
      token_expires_at
    FROM mercado_livre_accounts
    WHERE ml_user_id = ${String(mlUserId)}
    LIMIT 1
  `;

  if (rows.length === 0) {
    throw new Error("Conta Mercado Livre não encontrada");
  }

  const account = rows[0];

  const expiresAt = account.token_expires_at
    ? new Date(account.token_expires_at).getTime()
    : 0;

  if (
    expiresAt &&
    expiresAt > Date.now() + REFRESH_BUFFER_MS
  ) {
    return decryptToken(account.access_token);
  }

  const refreshToken = decryptToken(
    account.refresh_token
  );

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken
  });

  const response = await fetch(
    "https://api.mercadolibre.com/oauth/token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body
    }
  );

  const tokenData = await response.json();

  if (!response.ok) {
    throw new Error(
      "Falha ao renovar token do Mercado Livre"
    );
  }

  if (
    !tokenData.access_token ||
    !tokenData.refresh_token
  ) {
    throw new Error(
      "Resposta de renovação do Mercado Livre incompleta"
    );
  }

  const encryptedAccessToken = encryptToken(
    tokenData.access_token
  );

  const encryptedRefreshToken = encryptToken(
    tokenData.refresh_token
  );

  const expiresIn = Number(tokenData.expires_in || 0);

  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error(
      "Tempo de expiração do token inválido"
    );
  }

  const tokenExpiresAt = new Date(
    Date.now() + expiresIn * 1000
  );

  const scope = Array.isArray(tokenData.scope)
    ? tokenData.scope.join(" ")
    : tokenData.scope || null;

  const tokenType = tokenData.token_type || null;

  const updated = await sql`
    UPDATE mercado_livre_accounts
    SET
      access_token = ${encryptedAccessToken},
      refresh_token = ${encryptedRefreshToken},
      token_expires_at = ${tokenExpiresAt},
      scope = COALESCE(${scope}, scope),
      token_type = COALESCE(${tokenType}, token_type),
      updated_at = NOW()
    WHERE ml_user_id = ${String(mlUserId)}
      AND refresh_token = ${account.refresh_token}
    RETURNING ml_user_id
  `;

  if (updated.length !== 1) {
    /*
     * Outra requisição pode ter renovado o token
     * enquanto esta renovação estava em andamento.
     * Nesse caso, buscamos o token mais recente.
     */
    const latestRows = await sql`
      SELECT
        access_token,
        token_expires_at
      FROM mercado_livre_accounts
      WHERE ml_user_id = ${String(mlUserId)}
      LIMIT 1
    `;

    if (latestRows.length === 0) {
      throw new Error(
        "Conta Mercado Livre não encontrada após renovação"
      );
    }

    const latest = latestRows[0];

    if (
      !latest.token_expires_at ||
      new Date(latest.token_expires_at).getTime() <=
        Date.now()
    ) {
      throw new Error(
        "Conflito ao renovar token do Mercado Livre"
      );
    }

    return decryptToken(latest.access_token);
  }

  return tokenData.access_token;
}
