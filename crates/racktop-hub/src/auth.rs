use crate::AppState;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    extract::FromRequestParts,
    http::{StatusCode, request::Parts},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{Duration, Utc};
use rand::TryRngCore;
use serde::Serialize;
use sqlx::{PgPool, Row};
use std::{env, sync::Arc};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    pub linux_username: String,
    pub wecom_user_id: Option<String>,
    pub role: String,
    pub concurrent_gpu_limit: i32,
    pub csrf_token: String,
}

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, axum::Json(serde_json::json!({ "error": self.1 }))).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!(%error, "database error");
        Self(StatusCode::INTERNAL_SERVER_ERROR, "数据库操作失败".into())
    }
}

impl FromRequestParts<Arc<AppState>> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        let cookie = parts
            .headers
            .get("cookie")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        let token = cookie
            .split(';')
            .map(str::trim)
            .find_map(|item| item.strip_prefix("racktop_session="))
            .ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "请先登录".into()))?;
        let token_hash = sha256(token);
        let row = sqlx::query(
            "SELECT u.id,u.username,u.display_name,u.linux_username,u.wecom_user_id,u.role,u.concurrent_gpu_limit,s.csrf_token
             FROM sessions s JOIN users u ON u.id=s.user_id
             WHERE s.token_hash=$1 AND s.expires_at>now() AND s.last_seen_at>now()-interval '12 hours' AND u.enabled=true"
        ).bind(token_hash).fetch_optional(&state.pool).await?
            .ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "登录已过期".into()))?;
        sqlx::query("UPDATE sessions SET last_seen_at=now() WHERE token_hash=$1")
            .bind(sha256(token))
            .execute(&state.pool)
            .await?;
        Ok(Self {
            id: row.get("id"),
            username: row.get("username"),
            display_name: row.get("display_name"),
            linux_username: row.get("linux_username"),
            wecom_user_id: row.get("wecom_user_id"),
            role: row.get("role"),
            concurrent_gpu_limit: row.get("concurrent_gpu_limit"),
            csrf_token: row.get("csrf_token"),
        })
    }
}

impl AuthUser {
    pub fn require_admin(&self) -> Result<(), ApiError> {
        if self.role == "admin" {
            Ok(())
        } else {
            Err(ApiError(StatusCode::FORBIDDEN, "需要管理员权限".into()))
        }
    }

    pub fn require_csrf(&self, headers: &axum::http::HeaderMap) -> Result<(), ApiError> {
        let supplied = headers
            .get("x-csrf-token")
            .and_then(|value| value.to_str().ok());
        if supplied == Some(self.csrf_token.as_str()) {
            Ok(())
        } else {
            Err(ApiError(StatusCode::FORBIDDEN, "CSRF 校验失败".into()))
        }
    }
}

pub async fn bootstrap_admin(pool: &PgPool) -> anyhow::Result<()> {
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE role='admin'")
        .fetch_one(pool)
        .await?;
    if count > 0 {
        return Ok(());
    }
    let username = env::var("RACKTOP_BOOTSTRAP_ADMIN").unwrap_or_else(|_| "admin".into());
    let password = match env::var("RACKTOP_BOOTSTRAP_PASSWORD") {
        Ok(password) => password,
        Err(_) => {
            let path = env::var("RACKTOP_BOOTSTRAP_PASSWORD_FILE").map_err(|_| {
                anyhow::anyhow!("RACKTOP_BOOTSTRAP_PASSWORD or RACKTOP_BOOTSTRAP_PASSWORD_FILE is required for first start")
            })?;
            std::fs::read_to_string(path)?.trim().to_string()
        }
    };
    if password.len() < 12 {
        anyhow::bail!("bootstrap password must contain at least 12 characters");
    }
    let password_hash = hash_password(&password)?;
    sqlx::query("INSERT INTO users(id,username,display_name,linux_username,password_hash,role) VALUES($1,$2,$2,$2,$3,'admin')")
        .bind(Uuid::new_v4()).bind(username).bind(password_hash).execute(pool).await?;
    Ok(())
}

pub fn hash_password(password: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
    Ok(Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|error| anyhow::anyhow!("password hashing failed: {error}"))?
        .to_string())
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash).ok().is_some_and(|parsed| {
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    })
}

pub fn random_token(bytes: usize) -> String {
    let mut data = vec![0u8; bytes];
    rand::rngs::OsRng
        .try_fill_bytes(&mut data)
        .expect("OS random source");
    URL_SAFE_NO_PAD.encode(data)
}

pub fn sha256(value: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub async fn create_session(pool: &PgPool, user_id: Uuid) -> Result<(String, String), ApiError> {
    let token = random_token(32);
    let csrf = random_token(24);
    sqlx::query(
        "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,$4)",
    )
    .bind(sha256(&token))
    .bind(user_id)
    .bind(&csrf)
    .bind(Utc::now() + Duration::days(7))
    .execute(pool)
    .await?;
    Ok((token, csrf))
}
