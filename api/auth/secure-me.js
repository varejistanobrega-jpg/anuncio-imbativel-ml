import { neon } from "@neondatabase/serverless";
import { decryptToken } from "./crypto.js";
import { getAuthenticatedSession } from "./session.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");

      return res.status(405).json({
        ok: false,
        error: "method_not_allowed"
      });
    }

    res.setHeader("Cache-Control", "no-store");

    const session = await getAuthenticatedSession(req);

    if (!session.ok) {
      return res.status(session.status).json({
        ok: false,
        error: session.error
      });
    }

    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
      return res.status(500).json({
        ok: false,
        error: "server_error"
      });
    }

    const sql = neon(databaseUrl);

    const accounts = await sql`
      SELECT
        ml_user_id,
        access_token,
        token_expires_at
      FROM mercado_livre_accounts
      WHERE ml_user_id = ${session.mlUserId}
      LIMIT 1
    `;

    if (accounts.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "mercado_livre_account_not_found"
      });
    }

    const account = accounts[0];

    if (
      account.token_expires_at &&
      new Date(account.token_expires_at).getTime() <= Date.now()
    ) {
      return res.status(401).json({
        ok: false,
        error: "mercado_livre_token_expired"
      });
    }

    const mercadoLivreAccessToken = decryptToken(
      account.access_token
    );

    const response = await fetch(
      "https://api.mercadolibre.com/users/me",
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${mercadoLivreAccessToken}`
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: "mercado_livre_request_failed"
      });
    }

    if (String(data.id) !== session.mlUserId) {
      return res.status(403).json({
        ok: false,
        error: "account_identity_mismatch"
      });
    }

    return res.status(200).json({
      ok: true,
      mercado_livre_user_id: data.id,
      nickname: data.nickname || null,
      country_id: data.country_id || null,
      site_id: data.site_id || null
    });
  } catch (error) {
    console.error(
      "Erro na consulta autenticada:",
      error instanceof Error ? error.message : "erro desconhecido"
    );

    return res.status(500).json({
      ok: false,
      error: "server_error"
    });
  }
}
