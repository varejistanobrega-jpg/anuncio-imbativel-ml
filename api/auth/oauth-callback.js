import crypto from "crypto";
import { neon } from "@neondatabase/serverless";
import { encryptToken } from "./crypto.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");

      return res.status(405).json({
        ok: false,
        error: "Método não permitido"
      });
    }

    const code = String(req.query.code || "");
    const meliState = String(req.query.state || "");
    const oauthError = String(req.query.error || "");

    if (oauthError) {
      return res.status(400).json({
        ok: false,
        error: "Autorização recusada ou cancelada"
      });
    }

    if (!code || !meliState) {
      return res.status(400).json({
        ok: false,
        error: "Retorno OAuth incompleto"
      });
    }

    const clientId = process.env.MELI_CLIENT_ID;
    const clientSecret = process.env.MELI_CLIENT_SECRET;
    const meliRedirectUri = process.env.MELI_REDIRECT_URI;
    const databaseUrl = process.env.DATABASE_URL;

    if (
      !clientId ||
      !clientSecret ||
      !meliRedirectUri ||
      !databaseUrl
    ) {
      return res.status(500).json({
        ok: false,
        error: "Configuração OAuth incompleta"
      });
    }

    const sql = neon(databaseUrl);

    const transactions = await sql`
      SELECT
        id,
        transaction_id,
        openai_state,
        openai_redirect_uri,
        ml_oauth_state,
        expires_at,
        used_at
      FROM oauth_transactions
      WHERE ml_oauth_state = ${meliState}
      LIMIT 1
    `;

    if (transactions.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Transação OAuth não encontrada"
      });
    }

    const transaction = transactions[0];

    if (transaction.used_at) {
      return res.status(400).json({
        ok: false,
        error: "Transação OAuth já utilizada"
      });
    }

    if (new Date(transaction.expires_at).getTime() <= Date.now()) {
      return res.status(400).json({
        ok: false,
        error: "Transação OAuth expirada"
      });
    }

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: meliRedirectUri
    });

    const tokenResponse = await fetch(
      "https://api.mercadolibre.com/oauth/token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: tokenBody
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      return res.status(tokenResponse.status).json({
        ok: false,
        error: "Falha ao obter token do Mercado Livre"
      });
    }

    if (
      !tokenData.user_id ||
      !tokenData.access_token ||
      !tokenData.refresh_token
    ) {
      return res.status(500).json({
        ok: false,
        error: "Mercado Livre não retornou os dados necessários"
      });
    }

    const encryptedAccessToken = encryptToken(
      tokenData.access_token
    );

    const encryptedRefreshToken = encryptToken(
      tokenData.refresh_token
    );

    const expiresIn = Number(tokenData.expires_in || 0);

    const tokenExpiresAt =
      expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000)
        : null;

    const scope = Array.isArray(tokenData.scope)
      ? tokenData.scope.join(" ")
      : tokenData.scope || null;

    await sql`
      INSERT INTO mercado_livre_accounts (
        ml_user_id,
        access_token,
        refresh_token,
        token_expires_at,
        scope,
        token_type,
        updated_at
      )
      VALUES (
        ${String(tokenData.user_id)},
        ${encryptedAccessToken},
        ${encryptedRefreshToken},
        ${tokenExpiresAt},
        ${scope},
        ${tokenData.token_type || null},
        NOW()
      )
      ON CONFLICT (ml_user_id)
      DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        token_expires_at = EXCLUDED.token_expires_at,
        scope = EXCLUDED.scope,
        token_type = EXCLUDED.token_type,
        updated_at = NOW()
    `;

    const authorizationCode = crypto
      .randomBytes(32)
      .toString("hex");

    const codeHash = crypto
      .createHash("sha256")
      .update(authorizationCode)
      .digest("hex");

    await sql`
      INSERT INTO oauth_authorization_codes (
        code_hash,
        ml_user_id,
        redirect_uri,
        expires_at
      )
      VALUES (
        ${codeHash},
        ${String(tokenData.user_id)},
        ${transaction.openai_redirect_uri},
        NOW() + INTERVAL '5 minutes'
      )
    `;

    await sql`
      UPDATE oauth_transactions
      SET used_at = NOW()
      WHERE id = ${transaction.id}
        AND used_at IS NULL
    `;

    const redirectUrl = new URL(
      transaction.openai_redirect_uri
    );

    redirectUrl.searchParams.set(
      "code",
      authorizationCode
    );

    redirectUrl.searchParams.set(
      "state",
      transaction.openai_state
    );

    res.setHeader("Cache-Control", "no-store");

    return res.redirect(302, redirectUrl.toString());
  } catch (error) {
    console.error(
      "Erro no callback OAuth seguro:",
      error instanceof Error ? error.message : "erro desconhecido"
    );

    return res.status(500).json({
      ok: false,
      error: "Erro interno ao concluir autorização"
    });
  }
}
