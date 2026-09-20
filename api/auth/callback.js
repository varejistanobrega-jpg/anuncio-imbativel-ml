function getCookie(req, name) {
  const cookies = req.headers.cookie || "";

  const cookie = cookies
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));

  return cookie ? decodeURIComponent(cookie.substring(name.length + 1)) : null;
}

export default async function handler(req, res) {
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

  if (!clientId || !clientSecret || !redirectUri) {
    return res.status(500).json({
      ok: false,
      error: "Configuração OAuth incompleta"
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
      error: "Falha ao obter token do Mercado Livre",
      details: tokenData
    });
  }

  return res.status(200).json({
    ok: true,
    message: "Conta Mercado Livre autorizada com sucesso",
    user_id: tokenData.user_id
  });
}
