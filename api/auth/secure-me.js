import { getAuthenticatedSession } from "./session.js";
import { getValidMeliAccessToken } from "../../lib/meli-token.js";

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

    /*
     * Obtém o token atual do Mercado Livre.
     * Se estiver próximo da expiração, o módulo
     * faz a renovação automaticamente.
     */
    const mercadoLivreAccessToken =
      await getValidMeliAccessToken(
        session.mlUserId
      );

    const response = await fetch(
      "https://api.mercadolibre.com/users/me",
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization:
            `Bearer ${mercadoLivreAccessToken}`
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

    /*
     * Proteção adicional:
     * a conta retornada pelo Mercado Livre
     * precisa ser a mesma vinculada à sessão.
     */
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
      error instanceof Error
        ? error.message
        : "erro desconhecido"
    );

    return res.status(500).json({
      ok: false,
      error: "server_error"
    });
  }
}
