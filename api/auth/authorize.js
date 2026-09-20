import crypto from "crypto";
import { neon } from "@neondatabase/serverless";

function isAllowedRedirectUri(value) {
  if (!value || typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      (
        url.hostname === "chatgpt.com" ||
        url.hostname === "chat.openai.com"
      )
    );
  } catch {
    return false;
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

    const redirectUri = String(req.query.redirect_uri || "");
    const openaiState = String(req.query.state || "");

    if (!redirectUri || !openaiState) {
      return res.status(400).json({
        ok: false,
        error: "redirect_uri e state são obrigatórios"
      });
    }

    if (!isAllowedRedirectUri(redirectUri)) {
      return res.status(400).json({
        ok: false,
        error: "redirect_uri não permitido"
      });
    }

    if (openaiState.length > 2048) {
      return res.status(400).json({
        ok: false,
        error: "state inválido"
      });
    }

    const clientId = process.env.MELI_CLIENT_ID;
    const meliRedirectUri = process.env.MELI_REDIRECT_URI;
    const databaseUrl = process.env.DATABASE_URL;

    if (!clientId || !meliRedirectUri || !databaseUrl) {
      return res.status(500).json({
        ok: false,
        error: "Configuração OAuth incompleta"
      });
    }

    const transactionId = crypto.randomBytes(32).toString("hex");
    const meliState = crypto.randomBytes(32).toString("hex");

    const sql = neon(databaseUrl);

    await sql`
      INSERT INTO oauth_transactions (
        transaction_id,
        openai_state,
        openai_redirect_uri,
        ml_oauth_state,
        expires_at
      )
      VALUES (
        ${transactionId},
        ${openaiState},
        ${redirectUri},
        ${meliState},
        NOW() + INTERVAL '10 minutes'
      )
    `;

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: meliRedirectUri,
      state: meliState
    });

    const authorizationUrl =
      `https://auth.mercadolivre.com.br/authorization?${params.toString()}`;

    res.setHeader("Cache-Control", "no-store");

    return res.redirect(302, authorizationUrl);
  } catch (error) {
    console.error(
      "Erro ao iniciar OAuth:",
      error instanceof Error ? error.message : "erro desconhecido"
    );

    return res.status(500).json({
      ok: false,
      error: "Erro interno ao iniciar autorização"
    });
  }
}
