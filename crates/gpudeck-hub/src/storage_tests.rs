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
async fn sqlite_automatically_detects_reservation_usage() {
    let f = Fixture::new().await;
    let now = Utc::now();
    let start =
        chrono::DateTime::from_timestamp(now.timestamp().div_euclid(1800) * 1800, 0).unwrap();
    let (status, booking, _) = call(
        &f.app,
        Some(&f.user),
        "POST",
        "/reservations",
        f.booking(start, now + Duration::hours(1)),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = Uuid::parse_str(booking["id"].as_str().unwrap()).unwrap();
    let client = reqwest::Client::new();
    for (username, sampled_at, expected) in [
        ("someone_else", now, false),
        ("alice", now - Duration::minutes(3), false),
        ("alice", start - Duration::seconds(1), false),
        ("alice", now + Duration::hours(1), false),
        ("alice", now, true),
    ] {
        sqlx::query("INSERT INTO current_processes(gpu_id,pid,username,command,memory_used_mb,sampled_at) VALUES(?1,42,?2,'python',100,?3) ON CONFLICT(gpu_id,pid) DO UPDATE SET username=excluded.username,sampled_at=excluded.sampled_at")
            .bind(f.gpu).bind(username).bind(db::timestamp(sampled_at)).execute(&f.state.pool).await.unwrap();
        worker::tick(&f.state, &client).await.unwrap();
        let checked: Option<String> =
            sqlx::query_scalar("SELECT checked_in_at FROM reservations WHERE id=?1")
                .bind(id)
                .fetch_one(&f.state.pool)
                .await
                .unwrap();
        assert_eq!(checked.is_some(), expected, "{username} {sampled_at}");
    }
    let first: String = sqlx::query_scalar("SELECT checked_in_at FROM reservations WHERE id=?1")
        .bind(id)
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM current_processes")
        .execute(&f.state.pool)
        .await
        .unwrap();
    worker::tick(&f.state, &client).await.unwrap();
    let later: String = sqlx::query_scalar("SELECT checked_in_at FROM reservations WHERE id=?1")
        .bind(id)
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(first, later);
    // Even after the process exits, an observed reservation must not emit
    // a no-show notification at the 15-minute reminder boundary.
    sqlx::query("UPDATE reservations SET starts_at=?2 WHERE id=?1")
        .bind(id)
        .bind(db::timestamp(Utc::now() - Duration::minutes(16)))
        .execute(&f.state.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM notification_outbox WHERE event_type='reservation.no_show'")
        .execute(&f.state.pool)
        .await
        .unwrap();
    worker::tick(&f.state, &client).await.unwrap();
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM notification_outbox WHERE event_type='reservation.no_show'",
    )
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
    // Without an observed process the reminder is emitted once, not every tick.
    sqlx::query("UPDATE reservations SET checked_in_at=NULL WHERE id=?1")
        .bind(id)
        .execute(&f.state.pool)
        .await
        .unwrap();
    worker::tick(&f.state, &client).await.unwrap();
    worker::tick(&f.state, &client).await.unwrap();
    let content: Vec<String> = sqlx::query_scalar(
        "SELECT content FROM notification_outbox WHERE event_type='reservation.no_show'",
    )
    .fetch_all(&f.state.pool)
    .await
    .unwrap();
    assert_eq!(content.len(), 1);
    assert!(content[0].contains("仍未检测到本人 GPU 进程"));
    assert!(!content[0].contains("签到"));
    f.close().await;
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
    // Use the current window; subtracting a minute crosses into the previous
    // window when CI happens to run at :00/:30 and is correctly rejected.
    let now = Utc::now();
    let start =
        chrono::DateTime::from_timestamp(now.timestamp().div_euclid(1800) * 1800, 0).unwrap();
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
        StatusCode::NOT_FOUND
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
async fn sqlite_auto_release_waits_for_all_nodes_and_posts_notice() {
    let f = Fixture::new().await;
    let now = Utc::now();
    let node = Uuid::new_v4();
    let gpu = Uuid::new_v4();
    sqlx::query("INSERT INTO nodes(id,name,hostname,token_hash) VALUES(?1,'SecondNode','second','second-test')").bind(node).execute(&f.state.pool).await.unwrap();
    sqlx::query("INSERT INTO gpus(id,node_id,gpu_uuid,display_index,name,memory_total_mb,last_seen_at) VALUES(?1,?2,'second-gpu',0,'Test',100,?3)").bind(gpu).bind(node).bind(db::timestamp(now)).execute(&f.state.pool).await.unwrap();
    let mut request = f.booking(now + Duration::hours(1), now + Duration::hours(2));
    request["gpuIds"] = json!([f.gpu, gpu]);
    let (status, booking, _) = call(&f.app, Some(&f.user), "POST", "/reservations", request).await;
    assert_eq!(status, StatusCode::CREATED);
    let id = Uuid::parse_str(booking["id"].as_str().unwrap()).unwrap();
    let start = db::timestamp(now - Duration::minutes(31));
    sqlx::query("UPDATE reservations SET starts_at=?2 WHERE id=?1")
        .bind(id)
        .bind(&start)
        .execute(&f.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE reservation_allocations SET starts_at=?2 WHERE reservation_id=?1")
        .bind(id)
        .bind(&start)
        .execute(&f.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE nodes SET last_seen_at=?2,last_sample_at=?2 WHERE id=?1")
        .bind(f.node)
        .bind(db::timestamp(now))
        .execute(&f.state.pool)
        .await
        .unwrap();
    worker::tick(&f.state, &reqwest::Client::new())
        .await
        .unwrap();
    let status: String = sqlx::query_scalar("SELECT status FROM reservations WHERE id=?1")
        .bind(id)
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(status, "active");
    // Once both nodes resume fresh sampling, release the entire reservation.
    sqlx::query("UPDATE nodes SET last_seen_at=?2,last_sample_at=?2 WHERE id=?1")
        .bind(node)
        .bind(db::timestamp(now))
        .execute(&f.state.pool)
        .await
        .unwrap();
    let (sender, mut received) = tokio::sync::mpsc::channel::<Value>(4);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route(
        "/webhook",
        axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
            let sender = sender.clone();
            async move {
                sender.send(body).await.unwrap();
                axum::Json(json!({"errcode":0}))
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let state = AppState {
        pool: f.state.pool.clone(),
        public_url: f.state.public_url.clone(),
        secure_cookie: false,
        wecom_webhook: Some(format!("http://{address}/webhook")),
    };
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    worker::tick(&state, &client).await.unwrap();
    let mut notices = Vec::new();
    while let Ok(message) = received.try_recv() {
        notices.push(message);
    }
    let released: Vec<_> = notices
        .iter()
        .filter(|message| {
            message["markdown"]["content"]
                .as_str()
                .unwrap()
                .contains("预约已自动释放")
        })
        .collect();
    assert_eq!(released.len(), 1);
    let content = released[0]["markdown"]["content"].as_str().unwrap();
    assert!(content.contains("SecondNode / GPU 0"));
    assert!(content.contains("TestNode / GPU 0"));
    assert!(!content.contains("北京时间"));
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM reservation_allocations WHERE reservation_id=?1")
            .bind(id)
            .fetch_one(&f.state.pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    worker::tick(&state, &client).await.unwrap();
    assert!(received.try_recv().is_err());
    server.abort();
    server.await.unwrap_err();
    f.close().await;
}

#[tokio::test]
async fn sqlite_releases_unused_bookings_after_thirty_minutes() {
    for (minutes, fresh, previously_used, process_user, cancelled) in [
        (29, true, false, None, false),
        (30, true, false, None, true),
        (31, true, true, None, false),
        (31, false, false, None, false),
        (31, true, false, Some("alice"), false),
        (31, true, false, Some("bob"), true),
    ] {
        let f = Fixture::new().await;
        let now = Utc::now();
        let (status, booking, _) = call(
            &f.app,
            Some(&f.user),
            "POST",
            "/reservations",
            f.booking(now + Duration::hours(1), now + Duration::hours(2)),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let id = Uuid::parse_str(booking["id"].as_str().unwrap()).unwrap();
        let start = db::timestamp(now - Duration::minutes(minutes));
        sqlx::query("UPDATE reservations SET starts_at=?2,checked_in_at=?3 WHERE id=?1")
            .bind(id)
            .bind(&start)
            .bind(previously_used.then(|| db::timestamp(now)))
            .execute(&f.state.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE reservation_allocations SET starts_at=?2 WHERE reservation_id=?1")
            .bind(id)
            .bind(&start)
            .execute(&f.state.pool)
            .await
            .unwrap();
        let sample = db::timestamp(if fresh {
            now
        } else {
            now - Duration::minutes(3)
        });
        sqlx::query("UPDATE nodes SET last_seen_at=?2,last_sample_at=?2 WHERE id=?1")
            .bind(f.node)
            .bind(sample)
            .execute(&f.state.pool)
            .await
            .unwrap();
        if let Some(username) = process_user {
            sqlx::query("INSERT INTO current_processes(gpu_id,pid,username,command,memory_used_mb,sampled_at) VALUES(?1,42,?2,'python',100,?3)")
                .bind(f.gpu).bind(username).bind(db::timestamp(now)).execute(&f.state.pool).await.unwrap();
        }
        let client = reqwest::Client::new();
        worker::tick(&f.state, &client).await.unwrap();
        worker::tick(&f.state, &client).await.unwrap();
        let status: String = sqlx::query_scalar("SELECT status FROM reservations WHERE id=?1")
            .bind(id)
            .fetch_one(&f.state.pool)
            .await
            .unwrap();
        assert_eq!(
            status,
            if cancelled { "cancelled" } else { "active" },
            "{minutes} / fresh={fresh} / used={previously_used} / {process_user:?}"
        );
        let allocations: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM reservation_allocations WHERE reservation_id=?1",
        )
        .bind(id)
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
        assert_eq!(allocations, if cancelled { 0 } else { 1 });
        let notifications: Vec<String> = sqlx::query_scalar(
            "SELECT content FROM notification_outbox WHERE event_type='reservation.auto_released'",
        )
        .fetch_all(&f.state.pool)
        .await
        .unwrap();
        assert_eq!(notifications.len(), usize::from(cancelled));
        if cancelled {
            assert!(notifications[0].contains("预约已自动释放"));
            assert!(notifications[0].contains("TestNode / GPU 0"));
            assert!(!notifications[0].contains("北京时间"));
            let audit: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM audit_events WHERE action='reservation.auto_release'",
            )
            .fetch_one(&f.state.pool)
            .await
            .unwrap();
            assert_eq!(audit, 1);
            // Previously allocated future time and quota are really available.
            assert_eq!(
                call(
                    &f.app,
                    Some(&f.user),
                    "POST",
                    "/reservations",
                    f.booking(now + Duration::hours(1), now + Duration::hours(2))
                )
                .await
                .0,
                StatusCode::CREATED
            );
        }
        f.close().await;
    }
}

#[tokio::test]
async fn sqlite_unreserved_alerts_aggregate_per_user_across_nodes_and_gpus() {
    let f = Fixture::new().await;
    let now = Utc::now();
    let other_node = Uuid::new_v4();
    sqlx::query("INSERT INTO nodes(id,name,hostname,token_hash) VALUES(?1,'H200','h200','test')")
        .bind(other_node)
        .execute(&f.state.pool)
        .await
        .unwrap();
    let second = Uuid::new_v4();
    let third = Uuid::new_v4();
    for (gpu, node, index) in [(second, f.node, 1), (third, other_node, 0)] {
        sqlx::query("INSERT INTO gpus(id,node_id,gpu_uuid,display_index,name,memory_total_mb,last_seen_at) VALUES(?1,?2,?3,?4,'Test',100,?5)")
            .bind(gpu).bind(node).bind(gpu.to_string()).bind(index).bind(db::timestamp(now)).execute(&f.state.pool).await.unwrap();
    }
    for (gpu, pid, user, sampled) in [
        (f.gpu, 42, "alice", now),
        (f.gpu, 43, "alice", now),
        (second, 42, "alice", now), // Same PID on two GPUs is one task.
        (third, 42, "alice", now),  // Same PID on another node is a new task.
        (f.gpu, 99, "bob", now),
        (third, 100, "stale", now - Duration::minutes(3)),
    ] {
        sqlx::query("INSERT INTO current_processes(gpu_id,pid,username,command,memory_used_mb,sampled_at) VALUES(?1,?2,?3,'python',100,?4)")
            .bind(gpu).bind(pid).bind(user).bind(db::timestamp(sampled)).execute(&f.state.pool).await.unwrap();
    }
    worker::tick(&f.state, &reqwest::Client::new())
        .await
        .unwrap();
    worker::tick(&f.state, &reqwest::Client::new())
        .await
        .unwrap();
    let messages = sqlx::query(
        "SELECT dedupe_key,content FROM notification_outbox WHERE event_type='usage.unreserved'",
    )
    .fetch_all(&f.state.pool)
    .await
    .unwrap();
    assert_eq!(messages.len(), 2);
    let alice = messages
        .iter()
        .find(|row| {
            row.get::<String, _>("dedupe_key")
                .starts_with("unreserved-user-alice-")
        })
        .unwrap();
    let text: String = alice.get("content");
    assert!(text.contains("3 张 GPU / 3 个进程"));
    for resource in [
        "TestNode / GPU 0",
        "TestNode / GPU 1",
        "H200 / GPU 0",
        "42, 43",
    ] {
        assert!(text.contains(resource), "{text}");
    }
    assert!(!text.contains("99"));
    assert!(!text.contains("stale"));
    // Check the real sender posts only one message per user, not per GPU.
    let (sender, mut received) = tokio::sync::mpsc::channel::<Value>(4);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route(
        "/webhook",
        axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
            let sender = sender.clone();
            async move {
                sender.send(body).await.unwrap();
                axum::Json(json!({"errcode":0}))
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let state = AppState {
        pool: f.state.pool.clone(),
        public_url: f.state.public_url.clone(),
        secure_cookie: false,
        wecom_webhook: Some(format!("http://{address}/webhook")),
    };
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    worker::tick(&state, &client).await.unwrap();
    let first = received.try_recv().unwrap();
    let second_message = received.try_recv().unwrap();
    assert!(received.try_recv().is_err());
    let delivered = [&first, &second_message];
    assert_eq!(
        delivered
            .iter()
            .filter(|message| message["markdown"]["content"]
                .as_str()
                .unwrap()
                .contains("3 张 GPU / 3 个进程"))
            .count(),
        1
    );
    // Adding another GPU for an already-notified user in the same hour must
    // not create another message.
    sqlx::query("INSERT INTO current_processes(gpu_id,pid,username,command,memory_used_mb,sampled_at) VALUES(?1,101,'bob','python',100,?2)")
        .bind(third).bind(db::timestamp(Utc::now())).execute(&f.state.pool).await.unwrap();
    worker::tick(&state, &client).await.unwrap();
    assert!(received.try_recv().is_err());
    server.abort();
    server.await.unwrap_err();
    // Existing hourly notifications must not duplicate after restarting ticks.
    assert_eq!(
        messages
            .iter()
            .filter(|row| row
                .get::<String, _>("dedupe_key")
                .starts_with("unreserved-user-bob-"))
            .count(),
        1
    );
    f.close().await;
}

#[tokio::test]
async fn sqlite_usage_alerts_use_markdown_resource_details() {
    let f = Fixture::new().await;
    let now = Utc::now();
    let (status, booking, _) = call(
        &f.app,
        Some(&f.user),
        "POST",
        "/reservations",
        f.booking(now + Duration::hours(1), now + Duration::hours(2)),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = Uuid::parse_str(booking["id"].as_str().unwrap()).unwrap();
    sqlx::query("UPDATE reservations SET starts_at=?2,ends_at=?3 WHERE id=?1")
        .bind(id)
        .bind(db::timestamp(now - Duration::hours(1)))
        .bind(db::timestamp(now - Duration::minutes(1)))
        .execute(&f.state.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE reservation_allocations SET starts_at=?2,ends_at=?3 WHERE reservation_id=?1",
    )
    .bind(id)
    .bind(db::timestamp(now - Duration::hours(1)))
    .bind(db::timestamp(now - Duration::minutes(1)))
    .execute(&f.state.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO current_processes(gpu_id,pid,username,command,memory_used_mb,sampled_at) VALUES(?1,42,'alice','python',100,?2)").bind(f.gpu).bind(db::timestamp(now)).execute(&f.state.pool).await.unwrap();
    worker::tick(&f.state, &reqwest::Client::new())
        .await
        .unwrap();
    worker::tick(&f.state, &reqwest::Client::new())
        .await
        .unwrap();
    for event in ["usage.overrun", "usage.unreserved"] {
        let messages: Vec<String> =
            sqlx::query_scalar("SELECT content FROM notification_outbox WHERE event_type=?1")
                .bind(event)
                .fetch_all(&f.state.pool)
                .await
                .unwrap();
        assert_eq!(messages.len(), 1);
        assert!(messages[0].starts_with("### GPUDeck · "));
        assert!(messages[0].contains("<font color=\"warning\">"));
        assert!(messages[0].contains("TestNode / GPU 0"));
        assert!(messages[0].contains("[打开 GPUDeck]"));
    }
    f.close().await;
}

#[tokio::test]
async fn sqlite_wecom_posts_markdown_and_keeps_legacy_text() {
    let f = Fixture::new().await;
    let (sender, mut received) = tokio::sync::mpsc::channel::<Value>(4);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route(
        "/webhook",
        axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
            let sender = sender.clone();
            async move {
                sender.send(body).await.unwrap();
                axum::Json(json!({"errcode":0,"errmsg":"ok"}))
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    sqlx::query("UPDATE users SET wecom_user_id='alice_wecom' WHERE username='alice'")
        .execute(&f.state.pool)
        .await
        .unwrap();
    let (status, _, _) = call(
        &f.app,
        Some(&f.user),
        "POST",
        "/reservations",
        f.booking(
            Utc::now() + Duration::hours(1),
            Utc::now() + Duration::hours(2),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    sqlx::query("INSERT INTO notification_outbox(id,event_type,dedupe_key,content,mentioned_user_ids) VALUES(?1,'legacy','legacy','旧版待发送通知',?2)")
        .bind(Uuid::new_v4()).bind(json!(["alice_wecom"])).execute(&f.state.pool).await.unwrap();
    let state = AppState {
        pool: f.state.pool.clone(),
        public_url: f.state.public_url.clone(),
        secure_cookie: false,
        wecom_webhook: Some(format!("http://{address}/webhook")),
    };
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    worker::tick(&state, &client).await.unwrap();
    let first = received.try_recv().unwrap();
    let second = received.try_recv().unwrap();
    let markdown = if first["msgtype"] == "markdown" {
        &first
    } else {
        &second
    };
    let legacy = if first["msgtype"] == "text" {
        &first
    } else {
        &second
    };
    assert_eq!(markdown["msgtype"], "markdown");
    let content = markdown["markdown"]["content"].as_str().unwrap();
    assert!(content.contains("预约已创建"));
    assert!(content.contains("TestNode / GPU 0"));
    assert!(content.contains("<@alice_wecom>"));
    assert!(content.contains("[打开 GPUDeck]"));
    assert!(content.len() <= 4096);
    assert_eq!(legacy["text"]["content"], "旧版待发送通知");
    assert_eq!(legacy["text"]["mentioned_list"], json!(["alice_wecom"]));
    worker::tick(&state, &client).await.unwrap();
    assert!(received.try_recv().is_err());
    let sent: i64 =
        sqlx::query_scalar("SELECT count(*) FROM notification_outbox WHERE sent_at IS NOT NULL")
            .fetch_one(&f.state.pool)
            .await
            .unwrap();
    assert_eq!(sent, 2);
    server.abort();
    server.await.unwrap_err();
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
    let reminder: String = sqlx::query_scalar(
        "SELECT content FROM notification_outbox WHERE event_type='reservation.reminder'",
    )
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    assert!(reminder.starts_with("### GPUDeck · 预约即将开始"));
    assert!(reminder.contains("TestNode / GPU 0"));
    assert!(reminder.contains(&format!("{}", worker::beijing_time(upcoming))));
    assert!(reminder.contains("通知时间（UTC+8）"));
    assert!(!reminder.contains("北京时间"));
    assert!(!reminder.contains("无需手动签到"));
    let created: String = sqlx::query_scalar("SELECT content FROM notification_outbox WHERE event_type='reservation.created' ORDER BY created_at DESC LIMIT 1")
        .fetch_one(&f.state.pool).await.unwrap();
    assert!(created.starts_with("### GPUDeck · 预约已创建"));
    assert!(created.contains("TestNode / GPU 0"));
    assert!(created.contains(&format!(
        "{} 至 {}",
        worker::beijing_time(upcoming),
        worker::beijing_time(upcoming + Duration::hours(1))
    )));
    assert!(!created.contains("北京时间"));
    assert!(!created.contains("无需手动签到"));
    let seconds: i64 = sqlx::query_scalar("SELECT active_seconds FROM usage_hours")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(seconds, 30);
    f.close().await;
}
