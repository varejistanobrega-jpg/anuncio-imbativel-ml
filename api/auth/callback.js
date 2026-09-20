import crypto from "crypto";
import { neon } from "@neondatabase/serverless";

function getCookie(req, name) {
  const cookies = req.headers.cookie || "";

  const cookie = cookies
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));

  return cookie
    ? decodeURIComponent(cookie.substring(name.length + 1))
    : null;
}

function getEncryptionKey() {
  const keyHex = process.env.TOKEN_ENCRYPTION_KEY;

  if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error("TOKEN_ENCRYPTION_KEY inválida");
  }

  return Buffer.from(keyHex, "hex");
}

function encryptToken(token) {
  const key = getEncryptionKey();

  // 12 bytes é o tamanho recomendado de nonce/IV para GCM.
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  // Envelope versionado para permitir mudanças futuras
  // sem perder compatibilidade com tokens já armazenados.
  return [
    "v1",
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64")
  ].join(":");
}

export default async function handler(req, res) {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).json({
        ok: false,
        error: "Autorização recusada ou cancelada"
      });
    }

    if (!code || !state) {
      return res.status(400).json({
        ok: false,
        error: "Retorno OAuth incompleto"
      });
    }

    const savedState = getCookie(req, "meli_oauth_state");

    if (!savedState || savedState !== state) {
      return res.status(400).json({
        ok: false,
        error: "State OAuth inválido"
      });
    }

    const clientId = process.env.MELI_CLIENT_ID;
    const clientSecret = process.env.MELI_CLIENT_SECRET;
    const redirectUri = process.env.MELI_REDIRECT_URI;
    const databaseUrl = process.env.DATABASE_URL;

    if (!clientId || !clientSecret || !redirectUri) {
      return res.status(500).json({
        ok: false,
        error: "Configuração OAuth incompleta"
      });
    }

    if (!databaseUrl) {
      return res.status(500).json({
        ok: false,
        error: "Conexão com o banco de dados não encontrada"
      });
    }

    // Valida a chave antes de solicitar tokens ao Mercado Livre.
    getEncryptionKey();

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri
    });

    const tokenResponse = await fetch(
      "https://api.mercadolibre.com/oauth/token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body
      }
    );

    const tokenData = await tokenResponse.json();

    res.setHeader(
      "Set-Cookie",
      "meli_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    );

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
        error: "Mercado Livre não retornou todos os dados necessários"
      });
    }

    // Criptografa antes de qualquer gravação no banco.
    const encryptedAccessToken =
      encryptToken(tokenData.access_token);

    const encryptedRefreshToken =
      encryptToken(tokenData.refresh_token);

    const expiresIn = Number(tokenData.expires_in || 0);

    const tokenExpiresAt =
      expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000)
        : null;

    const scope = Array.isArray(tokenData.scope)
      ? tokenData.scope.join(" ")
      : tokenData.scope || null;

    const sql = neon(databaseUrl);

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

    return res.status(200).json({
      ok: true,
      message: "Conta Mercado Livre autorizada e armazenada com segurança",
      user_id: tokenData.user_id
    });
  } catch (error) {
    console.error(
      "Erro no callback OAuth:",
      error instanceof Error ? error.message : "erro desconhecido"
    );

    return res.status(500).json({
      ok: false,
      error: "Erro interno ao concluir autorização"
    });
  }
}
