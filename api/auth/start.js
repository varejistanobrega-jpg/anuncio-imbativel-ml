import crypto from "crypto";

export default function handler(req, res) {
  const clientId = process.env.MELI_CLIENT_ID;
  const redirectUri = process.env.MELI_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(500).json({
      error: "Configuração OAuth incompleta"
    });
  }

  const state = crypto.randomBytes(32).toString("hex");

  res.setHeader(
    "Set-Cookie",
    `meli_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state
  });

  const authorizationUrl =
    `https://auth.mercadolivre.com.br/authorization?${params.toString()}`;

  return res.redirect(302, authorizationUrl);
}
