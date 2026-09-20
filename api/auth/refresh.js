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
    const refreshToken = String(body.refresh_token || "");

    if (grantType !== "refresh_token") {
      return res.status(400).json({
        error: "unsupported_grant_type"
      });
    }

    if (!refreshToken) {
      return res.status(400).json({
        error: "invalid_request"
      });
    }

    const sql = neon(databaseUrl);
    const refreshTokenHash = hashValue(refreshToken);

    const sessions = await sql`
      SELECT
        id,
        ml_user_id,
        refresh_token_expires_at,
        revoked_at
      FROM oauth_sessions
      WHERE refresh_token_hash = ${refreshTokenHash}
      LIMIT 1
    `;

    if (sessions.length === 0) {
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    const session = sessions[0];

    if (session.revoked_at) {
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    if (
      new Date(session.refresh_token_expires_at).getTime() <=
      Date.now()
    ) {
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    const newAccessToken = generateToken();
    const newRefreshToken = generateToken();

    const newAccessTokenHash =
      hashValue(newAccessToken);

    const newRefreshTokenHash =
      hashValue(newRefreshToken);

    const updated = await sql`
      UPDATE oauth_sessions
      SET
        access_token_hash = ${newAccessTokenHash},
        refresh_token_hash = ${newRefreshTokenHash},
        access_token_expires_at =
          NOW() + INTERVAL '1 hour',
        refresh_token_expires_at =
          NOW() + INTERVAL '30 days',
        updated_at = NOW()
      WHERE id = ${session.id}
        AND refresh_token_hash = ${refreshTokenHash}
        AND revoked_at IS NULL
        AND refresh_token_expires_at > NOW()
      RETURNING id
    `;

    if (updated.length !== 1) {
      return res.status(400).json({
        error: "invalid_grant"
      });
    }

    return res.status(200).json({
      access_token: newAccessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: newRefreshToken
    });
  } catch (error) {
    console.error(
      "Erro ao renovar sessão OAuth:",
      error instanceof Error
        ? error.message
        : "erro desconhecido"
    );

    return res.status(500).json({
      error: "server_error"
    });
  }
}
