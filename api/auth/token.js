import crypto from "crypto";
import { neon } from "@neondatabase/serverless";

function hashValue(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function generateToken() {
  return crypto.randomBytes(48).toString("base64url");
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");

      return res.status(405).json({
        error: "method_not_allowed"
      });
    }

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");

    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
      return res.status(500).json({
        error: "server_error"
      });
    }

    let body = req.body || {};

    if (typeof body === "string") {
      body = Object.fromEntries(
        new URLSearchParams(body)
      );
    }

    const grantType = String(body.grant_type || "");

    if (grantType !== "authorization_code") {
      return res.status(400).json({
        error: "unsupported_grant_type"
      });
    }

    const code = String(body.code || "");
    const redirectUri = String(body.redirect_uri || "");

    if (!code || !redirectUri) {
      return res.status(400).json({
        error: "invalid_request"
      });
    }

    const sql = neon(databaseUrl);
    const codeHash = hashValue(code);

    const codes = await sql`
      SELECT
        id,
        ml_user_id,
        redirect_uri,
        expires_at,
        used_at
      FROM oauth_authorization_codes
      WHERE code_hash = ${codeHash}
      LIMIT 1
    `;

    if (codes.length === 0) {
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    const authorizationCode = codes[0];

    if (authorizationCode.used_at) {
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    if (
      new Date(authorizationCode.expires_at).getTime() <=
      Date.now()
    ) {
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    if (authorizationCode.redirect_uri !== redirectUri) {
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    const accessToken = generateToken();
    const refreshToken = generateToken();

    const accessTokenHash = hashValue(accessToken);
    const refreshTokenHash = hashValue(refreshToken);

    const updated = await sql`
      UPDATE oauth_authorization_codes
      SET used_at = NOW()
      WHERE id = ${authorizationCode.id}
        AND used_at IS NULL
      RETURNING id
    `;

    if (updated.length !== 1) {
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    await sql`
      INSERT INTO oauth_sessions (
        ml_user_id,
        access_token_hash,
        refresh_token_hash,
        access_token_expires_at,
        refresh_token_expires_at
      )
      VALUES (
        ${String(authorizationCode.ml_user_id)},
        ${accessTokenHash},
        ${refreshTokenHash},
        NOW() + INTERVAL '1 hour',
        NOW() + INTERVAL '30 days'
      )
    `;

    return res.status(200).json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken
    });
  } catch (error) {
    console.error(
      "Erro no endpoint de token:",
      error instanceof Error ? error.message : "erro desconhecido"
    );

    return res.status(500).json({
      error: "server_error"
    });
  }
}
