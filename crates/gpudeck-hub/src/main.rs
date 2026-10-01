mod api;
mod auth;
mod db;
mod notification;
#[cfg(test)]
mod storage_tests;
mod web;
mod worker;

use anyhow::Context;
use axum::{Router, routing::get};
use sqlx::SqlitePool;
use std::{env, net::SocketAddr, sync::Arc};
use tower_http::trace::TraceLayer;
use tracing::info;

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub public_url: String,
    pub wecom_webhook: Option<String>,
    pub secure_cookie: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if env::args().any(|arg| arg == "--version") {
        println!("gpudeck-hub {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "gpudeck_hub=info,tower_http=info".into()),
        )
        .init();

    let database_url =
        env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite://gpudeck.sqlite".into());
    let pool = db::open(&database_url)
        .await
        .context("opening SQLite database")?;
    if env::args().any(|arg| arg == "--init-db-only") {
        pool.close().await;
        return Ok(());
    }
    auth::bootstrap_admin(&pool).await?;

    let state = Arc::new(AppState {
        pool,
        public_url: env::var("GPUDECK_PUBLIC_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:1420".into()),
        wecom_webhook: env::var("WECOM_WEBHOOK_URL").ok(),
        secure_cookie: env::var("GPUDECK_SECURE_COOKIE").map_or(true, |value| value != "false"),
    });
    worker::spawn(state.clone());

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .nest("/api/v1", api::router())
        .fallback(web::serve)
        .layer(TraceLayer::new_for_http())
        .with_state(state.clone());

    let address: SocketAddr = env::var("GPUDECK_LISTEN")
        .unwrap_or_else(|_| "0.0.0.0:8080".into())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    info!(%address, "GPUDeck Hub listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            #[cfg(unix)]
            {
                let mut term =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .unwrap();
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
            }
            #[cfg(not(unix))]
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    state.pool.close().await;
    Ok(())
}
