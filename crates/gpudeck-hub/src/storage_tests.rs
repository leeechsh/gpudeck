use crate::{AppState, api, auth, db, worker};
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use chrono::{Duration, Utc};
use serde_json::{Value, json};
use sqlx::Row;
use std::sync::Arc;
use tower::ServiceExt;
use uuid::Uuid;

struct Fixture {
    state: Arc<AppState>,
    app: Router,
    admin: (String, String),
    user: (String, String),
    gpu: Uuid,
    node: Uuid,
    path: std::path::PathBuf,
}

async fn call(
    app: &Router,
    credentials: Option<&(String, String)>,
    method: &str,
    path: &str,
    body: Value,
) -> (StatusCode, Value, String) {
    let mut request = Request::builder()
        .method(method)
        .uri(format!("/api/v1{path}"))
        .header("content-type", "application/json");
    if let Some((cookie, csrf)) = credentials {
        request = request
            .header("cookie", cookie)
            .header("x-csrf-token", csrf);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get("set-cookie")
        .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string())
        .unwrap_or_default();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let value =
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
    (status, value, cookie)
}

impl Fixture {
    async fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("gpudeck-sqlite-test-{}.sqlite", Uuid::new_v4()));
        let pool = db::open(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        let state = Arc::new(AppState {
            pool,
            public_url: "https://test.example".into(),
            wecom_webhook: None,
            secure_cookie: false,
        });
        let hash = auth::hash_password("testpass").unwrap();
        for (name, role) in [("admin", "admin"), ("alice", "user")] {
            sqlx::query("INSERT INTO users(id,username,display_name,linux_username,password_hash,role) VALUES(?1,?2,?2,?2,?3,?4)").bind(Uuid::new_v4()).bind(name).bind(&hash).bind(role).execute(&state.pool).await.unwrap();
        }
        let app = Router::new()
            .nest("/api/v1", api::router())
            .with_state(state.clone());
        let login = |name| {
            call(
                &app,
                None,
                "POST",
                "/auth/login",
                json!({"username":name,"password":"testpass"}),
            )
        };
        let (status, body, cookie) = login("admin").await;
        assert_eq!(status, StatusCode::OK);
        let admin = (cookie, body["csrfToken"].as_str().unwrap().into());
        let (status, body, cookie) = login("alice").await;
        assert_eq!(status, StatusCode::OK);
        let user = (cookie, body["csrfToken"].as_str().unwrap().into());
        let (status, node, _) = call(
            &app,
            Some(&admin),
            "POST",
            "/admin/nodes",
            json!({"name":"TestNode","hostname":"test"}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let node_id = Uuid::parse_str(node["id"].as_str().unwrap()).unwrap();
        let gpu = Uuid::new_v4();
        sqlx::query("INSERT INTO gpus(id,node_id,gpu_uuid,display_index,name,memory_total_mb,last_seen_at) VALUES(?1,?2,'testgpu',0,'L40S',46080,?3)").bind(gpu).bind(node_id).bind(db::timestamp(Utc::now())).execute(&state.pool).await.unwrap();
        Self {
            state,
            app,
            admin,
            user,
            gpu,
            node: node_id,
            path,
        }
    }
    fn booking(&self, start: chrono::DateTime<Utc>, end: chrono::DateTime<Utc>) -> Value {
        json!({"gpuIds":[self.gpu],"startsAt":db::timestamp(start),"endsAt":db::timestamp(end),"projectName":"SQLite test","purpose":"Test"})
    }
    async fn close(self) {
        self.state.pool.close().await;
        std::fs::remove_file(self.path).unwrap();
    }
}

#[tokio::test]
async fn sqlite_api_concurrency_boundaries_and_persistence() {
    let f = Fixture::new().await;
    for path in [
        "/resources",
        "/statistics",
        "/reservations",
        "/admin/nodes",
        "/admin/users",
        "/admin/settings",
    ] {
        assert_eq!(
            call(&f.app, Some(&f.admin), "GET", path, Value::Null)
                .await
                .0,
            StatusCode::OK,
            "{path}"
        );
    }
    let start = Utc::now() + Duration::hours(1);
    let end = start + Duration::hours(1);
    let booking = f.booking(start, end);
    let (a, b) = tokio::join!(
        call(
            &f.app,
            Some(&f.admin),
            "POST",
            "/reservations",
            booking.clone()
        ),
        call(&f.app, Some(&f.user), "POST", "/reservations", booking)
    );
    let mut codes = vec![a.0.as_u16(), b.0.as_u16()];
    codes.sort();
    assert_eq!(codes, vec![201, 409]);
    assert_eq!(
        call(
            &f.app,
            Some(&f.user),
            "POST",
            "/reservations",
            f.booking(end, end + Duration::hours(1))
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let row = sqlx::query("SELECT reservation_id FROM reservation_allocations LIMIT 1")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    let id: Uuid = row.get("reservation_id");
    let bad=sqlx::query("INSERT INTO reservation_allocations(id,reservation_id,gpu_id,starts_at,ends_at) VALUES(?1,?2,?3,?4,?5)").bind(Uuid::new_v4()).bind(id).bind(f.gpu).bind(db::timestamp(start)).bind(db::timestamp(end)).execute(&f.state.pool).await;
    assert!(
        bad.unwrap_err()
            .to_string()
            .contains("reservation_allocations_overlap")
    );
    let (status, _, _) = call(
        &f.app,
        Some(&f.admin),
        "POST",
        &format!("/reservations/{id}/cancel"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let list = call(&f.app, Some(&f.user), "GET", "/reservations", Value::Null).await;
    assert_eq!(list.1.as_array().unwrap().len(), 2);
    let reopened = db::open(&format!("sqlite://{}", f.path.display()))
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM reservations")
        .fetch_one(&reopened)
        .await
        .unwrap();
    assert_eq!(count, 2);
    reopened.close().await;
    f.close().await;
}

#[tokio::test]
async fn sqlite_same_owner_peak_and_reservation_actions() {
    let f = Fixture::new().await;
    assert_eq!(
        call(
            &f.app,
            Some(&f.admin),
            "PUT",
            "/admin/settings",
            json!({"concurrentGpuLimit":1})
        )
        .await
        .0,
        StatusCode::OK
    );
    let second = Uuid::new_v4();
    sqlx::query("INSERT INTO gpus(id,node_id,gpu_uuid,display_index,name,memory_total_mb,last_seen_at) VALUES(?1,?2,'gpu2',1,'L40S',46080,?3)").bind(second).bind(f.node).bind(db::timestamp(Utc::now())).execute(&f.state.pool).await.unwrap();
    let start = Utc::now() - Duration::minutes(1);
    let end = start + Duration::hours(1);
    let first = f.booking(start, end);
    let mut other = first.clone();
    other["gpuIds"] = json!([second]);
    let (a, b) = tokio::join!(
        call(&f.app, Some(&f.user), "POST", "/reservations", first),
        call(&f.app, Some(&f.user), "POST", "/reservations", other)
    );
    let mut codes = vec![a.0.as_u16(), b.0.as_u16()];
    codes.sort();
    assert_eq!(codes, vec![201, 409]);
    let created = if a.0 == StatusCode::CREATED { a.1 } else { b.1 };
    let id = created["id"].as_str().unwrap();
    assert_eq!(
        call(
            &f.app,
            Some(&f.user),
            "POST",
            &format!("/reservations/{id}/check-in"),
            Value::Null
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(
            &f.app,
            Some(&f.user),
            "POST",
            &format!("/reservations/{id}/end"),
            Value::Null
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let allocations: i64 = sqlx::query_scalar("SELECT count(*) FROM reservation_allocations")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(allocations, 0);
    f.close().await;
}

#[tokio::test]
async fn sqlite_agent_snapshot_replay_and_user_sync() {
    let f = Fixture::new().await;
    sqlx::query("UPDATE nodes SET token_hash=?1 WHERE id=?2")
        .bind(auth::sha256("agent-test"))
        .bind(f.node)
        .execute(&f.state.pool)
        .await
        .unwrap();
    let snapshot = json!({"nodeId":f.node,"sequence":1,"sampledAt":Utc::now(),"hostname":"test",
        "gpus":[{"uuid":"testgpu","index":0,"name":"L40S","memoryTotalMb":46080,"memoryUsedMb":1024,"utilizationPercent":10.0,"temperatureCelsius":30.0}],
        "processes":[{"gpuUuid":"testgpu","pid":123,"username":"linuxuser","command":"python train.py","memoryUsedMb":1024}],
        "systemUsers":[{"username":"linuxuser","uid":1001,"shell":"/bin/bash"}]});
    for expected in [StatusCode::NO_CONTENT, StatusCode::CONFLICT] {
        let response = f
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/agent/snapshot")
                    .header("content-type", "application/json")
                    .header("authorization", "Bearer agent-test")
                    .body(Body::from(snapshot.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
    let (status, body, _) = call(&f.app, Some(&f.user), "GET", "/resources", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["nodes"][0]["gpus"][0]["processes"][0]["pid"], 123);
    let (status, _, _) = call(
        &f.app,
        Some(&f.admin),
        "POST",
        "/admin/users/sync",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body, _) = call(&f.app, Some(&f.user), "GET", "/statistics", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["users"][0]["coverageSeconds"], 5);
    worker::tick(&f.state, &reqwest::Client::new())
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM notification_outbox WHERE event_type='usage.unreserved'",
    )
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
    f.close().await;
}

#[tokio::test]
async fn sqlite_settings_password_and_worker() {
    let f = Fixture::new().await;
    assert_eq!(
        call(
            &f.app,
            Some(&f.user),
            "PUT",
            "/admin/settings",
            json!({"concurrentGpuLimit":4})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &f.app,
            Some(&f.admin),
            "PUT",
            "/admin/settings",
            json!({"concurrentGpuLimit":4})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(call(&f.app,Some(&f.admin),"POST","/admin/users",json!({"username":"new","displayName":"New","linuxUsername":"new","password":"12345678"})).await.0,StatusCode::CREATED);
    let limit: i32 =
        sqlx::query_scalar("SELECT concurrent_gpu_limit FROM users WHERE username='new'")
            .fetch_one(&f.state.pool)
            .await
            .unwrap();
    assert_eq!(limit, 4);
    assert_eq!(
        call(
            &f.app,
            Some(&f.user),
            "POST",
            "/auth/change-password",
            json!({"currentPassword":"testpass","newPassword":"12345678"})
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    sqlx::query("INSERT INTO usage_minutes(gpu_id,username,minute,active_seconds,memory_mb_seconds,coverage_seconds) VALUES(?1,'alice',?2,30,300,30)").bind(f.gpu).bind(db::timestamp(Utc::now()-Duration::hours(2))).execute(&f.state.pool).await.unwrap();
    let upcoming = Utc::now() + Duration::minutes(15);
    assert_eq!(
        call(
            &f.app,
            Some(&f.user),
            "POST",
            "/reservations",
            f.booking(upcoming, upcoming + Duration::hours(1))
        )
        .await
        .0,
        StatusCode::CREATED
    );
    worker::tick(&f.state, &reqwest::Client::new())
        .await
        .unwrap();
    worker::tick(&f.state, &reqwest::Client::new())
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM notification_outbox WHERE event_type='reservation.reminder'",
    )
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
    let seconds: i64 = sqlx::query_scalar("SELECT active_seconds FROM usage_hours")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(seconds, 30);
    f.close().await;
}
