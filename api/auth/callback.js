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
    const databaseUrl =
      process.env.DATABASE_URL ||
      process.env.STORAGE_URL ||
      process.env.POSTGRES_URL;

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
          "Accept": "application/json",
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

    const sql = neon(databaseUrl);

    const expiresIn = Number(tokenData.expires_in || 0);

    const tokenExpiresAt = new Date(
      Date.now() + expiresIn * 1000
    );

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
        ${tokenData.access_token},
        ${tokenData.refresh_token},
        ${tokenExpiresAt},
        ${tokenData.scope || null},
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
      message: "Conta Mercado Livre autorizada e armazenada com sucesso",
      user_id: tokenData.user_id
    });
  } catch (error) {
    console.error("Erro no callback OAuth:", error);

    return res.status(500).json({
      ok: false,
      error: "Erro interno ao concluir autorização"
    });
  }
}
