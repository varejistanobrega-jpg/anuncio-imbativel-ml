import crypto from "crypto";
import { neon } from "@neondatabase/serverless";

function hashToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

export async function getAuthenticatedSession(req) {
  const authorization = String(
    req.headers.authorization || ""
  );

  if (!authorization.startsWith("Bearer ")) {
    return {
      ok: false,
      status: 401,
      error: "missing_access_token"
    };
  }

  const accessToken = authorization
    .slice(7)
    .trim();

  if (!accessToken) {
    return {
      ok: false,
      status: 401,
      error: "missing_access_token"
    };
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return {
      ok: false,
      status: 500,
      error: "server_error"
    };
  }

  const sql = neon(databaseUrl);
  const accessTokenHash = hashToken(accessToken);

  const sessions = await sql`
    SELECT
      id,
      ml_user_id,
      access_token_expires_at,
      refresh_token_expires_at,
      revoked_at
    FROM oauth_sessions
    WHERE access_token_hash = ${accessTokenHash}
    LIMIT 1
  `;

  if (sessions.length === 0) {
    return {
      ok: false,
      status: 401,
      error: "invalid_access_token"
    };
  }

  const session = sessions[0];

  if (session.revoked_at) {
    return {
      ok: false,
      status: 401,
      error: "revoked_access_token"
    };
  }

  if (
    new Date(
      session.access_token_expires_at
    ).getTime() <= Date.now()
  ) {
    return {
      ok: false,
      status: 401,
      error: "expired_access_token"
    };
  }

  return {
    ok: true,
    sessionId: session.id,
    mlUserId: String(session.ml_user_id)
  };
}
