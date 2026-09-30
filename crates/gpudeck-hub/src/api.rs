use crate::{
    AppState,
    auth::{self, ApiError, AuthUser},
};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Duration, Timelike, Utc};
use gpudeck_domain::{AgentSnapshot, CreateReservation, ReservationView};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use uuid::Uuid;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/me", get(me))
        .route("/auth/change-password", post(change_password))
        .route("/resources", get(resources))
        .route(
            "/reservations",
            get(list_reservations).post(create_reservation),
        )
        .route("/reservations/{id}/cancel", post(cancel_reservation))
        .route("/reservations/{id}/check-in", post(check_in))
        .route("/reservations/{id}/end", post(end_early))
        .route("/statistics", get(statistics))
        .route("/agent/snapshot", post(agent_snapshot))
        .route("/admin/nodes", get(list_nodes).post(create_node))
        .route("/admin/users", get(list_users).post(create_user))
        .route("/admin/users/sync", post(sync_system_users))
}

#[derive(Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
}

async fn login(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<LoginRequest>,
) -> Result<Response, ApiError> {
    let key = format!(
        "{}:{}",
        input.username.trim().to_lowercase(),
        client_ip(&headers)
    );
    if let Some(row) = sqlx::query("SELECT failures,locked_until FROM login_attempts WHERE key=$1")
        .bind(&key)
        .fetch_optional(&state.pool)
        .await?
    {
        let locked_until: Option<DateTime<Utc>> = row.get("locked_until");
        if locked_until.is_some_and(|until| until > Utc::now()) {
            return Err(ApiError(
                StatusCode::TOO_MANY_REQUESTS,
                "登录尝试过多，请稍后重试".into(),
            ));
        }
    }
    let row = sqlx::query("SELECT id,password_hash FROM users WHERE username=$1 AND enabled=true")
        .bind(input.username.trim())
        .fetch_optional(&state.pool)
        .await?;
    let valid = row
        .as_ref()
        .is_some_and(|row| auth::verify_password(&input.password, row.get("password_hash")));
    if !valid {
        sqlx::query("INSERT INTO login_attempts(key,failures,window_started_at,locked_until) VALUES($1,1,now(),NULL)
                     ON CONFLICT(key) DO UPDATE SET failures=CASE WHEN login_attempts.window_started_at<now()-interval '15 minutes' THEN 1 ELSE login_attempts.failures+1 END,
                     window_started_at=CASE WHEN login_attempts.window_started_at<now()-interval '15 minutes' THEN now() ELSE login_attempts.window_started_at END,
                     locked_until=CASE WHEN login_attempts.failures+1>=5 THEN now()+interval '15 minutes' ELSE NULL END")
            .bind(&key).execute(&state.pool).await?;
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "用户名或密码错误".into(),
        ));
    }
    sqlx::query("DELETE FROM login_attempts WHERE key=$1")
        .bind(&key)
        .execute(&state.pool)
        .await?;
    let user_id: Uuid = row.unwrap().get("id");
    let (token, csrf) = auth::create_session(&state.pool, user_id).await?;
    let mut response = Json(json!({"csrfToken": csrf})).into_response();
    let secure = if state.secure_cookie { "; Secure" } else { "" };
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "gpudeck_session={token}; Path=/; HttpOnly{secure}; SameSite=Lax; Max-Age=604800"
        ))
        .unwrap(),
    );
    Ok(response)
}

async fn logout(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    user.require_csrf(&headers)?;
    if let Some(token) = session_token(&headers) {
        sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
            .bind(auth::sha256(token))
            .execute(&state.pool)
            .await?;
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    let secure = if state.secure_cookie { "; Secure" } else { "" };
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "gpudeck_session=; Path=/; HttpOnly{secure}; SameSite=Lax; Max-Age=0"
        ))
        .unwrap(),
    );
    Ok(response)
}

async fn me(user: AuthUser) -> Json<Value> {
    Json(json!(user))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePassword {
    current_password: String,
    new_password: String,
}

async fn change_password(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    headers: HeaderMap,
    Json(input): Json<ChangePassword>,
) -> Result<StatusCode, ApiError> {
    user.require_csrf(&headers)?;
    if input.new_password.len() < 12 {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "新密码至少12字符".into(),
        ));
    }
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1")
        .bind(user.id)
        .fetch_one(&state.pool)
        .await?;
    if !auth::verify_password(&input.current_password, &hash) {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "当前密码错误".into()));
    }
    let new_hash = auth::hash_password(&input.new_password)
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "密码处理失败".into()))?;
    sqlx::query("UPDATE users SET password_hash=$2,must_change_password=false WHERE id=$1")
        .bind(user.id)
        .bind(new_hash)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn resources(
    State(state): State<Arc<AppState>>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT n.id node_id,n.name node_name,n.hostname,n.last_seen_at,g.id gpu_id,g.gpu_uuid,g.display_index,g.name gpu_name,g.memory_total_mb,g.maintenance,g.missing,
                s.sampled_at,s.memory_used_mb,s.utilization_percent,s.temperature_celsius
         FROM nodes n LEFT JOIN gpus g ON g.node_id=n.id LEFT JOIN current_gpu_state s ON s.gpu_id=g.id WHERE n.enabled=true ORDER BY n.name,g.display_index"
    ).fetch_all(&state.pool).await?;
    let process_rows = sqlx::query("SELECT gpu_id,pid,username,command,memory_used_mb,sampled_at FROM current_processes ORDER BY gpu_id,pid").fetch_all(&state.pool).await?;
    let mut processes: HashMap<Uuid, Vec<Value>> = HashMap::new();
    for row in process_rows {
        processes.entry(row.get("gpu_id")).or_default().push(json!({"pid":row.get::<i64,_>("pid"),"username":row.get::<String,_>("username"),"command":row.get::<String,_>("command"),"memoryUsedMb":row.get::<i64,_>("memory_used_mb")}));
    }
    let mut nodes: Vec<Value> = Vec::new();
    let mut current_node_id: Option<Uuid> = None;
    for row in rows {
        let node_id: Uuid = row.get("node_id");
        if current_node_id != Some(node_id) {
            current_node_id = Some(node_id);
            nodes.push(json!({"id":node_id,"name":row.get::<String,_>("node_name"),"hostname":row.get::<String,_>("hostname"),"lastSeenAt":row.get::<Option<DateTime<Utc>>,_>("last_seen_at"),"gpus":[]}));
        }
        if let Some(gpu_id) = row.get::<Option<Uuid>, _>("gpu_id") {
            nodes.last_mut().unwrap()["gpus"].as_array_mut().unwrap().push(json!({
                "id":gpu_id,"uuid":row.get::<String,_>("gpu_uuid"),"index":row.get::<i32,_>("display_index"),"name":row.get::<String,_>("gpu_name"),
                "memoryTotalMb":row.get::<i64,_>("memory_total_mb"),"memoryUsedMb":row.get::<Option<i64>,_>("memory_used_mb"),
                "utilizationPercent":row.get::<Option<f64>,_>("utilization_percent"),"temperatureCelsius":row.get::<Option<f64>,_>("temperature_celsius"),
                "maintenance":row.get::<bool,_>("maintenance"),"missing":row.get::<bool,_>("missing"),"processes":processes.remove(&gpu_id).unwrap_or_default()
            }));
        }
    }
    Ok(Json(json!({"nodes":nodes,"serverTime":Utc::now()})))
}

async fn list_reservations(
    State(state): State<Arc<AppState>>,
    _user: AuthUser,
) -> Result<Json<Vec<ReservationView>>, ApiError> {
    let rows = sqlx::query(
        "SELECT r.id,r.owner_id,u.display_name,r.starts_at,r.ends_at,r.project_name,r.purpose,r.status,r.checked_in_at,a.gpu_id
         FROM reservations r JOIN users u ON u.id=r.owner_id LEFT JOIN reservation_allocations a ON a.reservation_id=r.id
         WHERE r.ends_at>now()-interval '30 days' ORDER BY r.starts_at,a.gpu_id"
    ).fetch_all(&state.pool).await?;
    let mut result: Vec<ReservationView> = Vec::new();
    for row in rows {
        let id: Uuid = row.get("id");
        if let Some(existing) = result.iter_mut().find(|item| item.id == id) {
            if let Some(gpu_id) = row.get::<Option<Uuid>, _>("gpu_id") {
                existing.gpu_ids.push(gpu_id);
            }
            continue;
        }
        result.push(ReservationView {
            id,
            owner_id: row.get("owner_id"),
            owner_name: row.get("display_name"),
            gpu_ids: row.get::<Option<Uuid>, _>("gpu_id").into_iter().collect(),
            starts_at: row.get("starts_at"),
            ends_at: row.get("ends_at"),
            project_name: row.get("project_name"),
            purpose: row.get("purpose"),
            status: row.get("status"),
            checked_in_at: row.get("checked_in_at"),
        });
    }
    Ok(Json(result))
}

async fn create_reservation(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    headers: HeaderMap,
    Json(input): Json<CreateReservation>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    user.require_csrf(&headers)?;
    validate_reservation(&input, user.concurrent_gpu_limit)?;
    let mut transaction = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(user.id.to_string())
        .execute(&mut *transaction)
        .await?;
    let overlaps = sqlx::query(
        "SELECT lower(a.slot) AS starts_at,upper(a.slot) AS ends_at FROM reservation_allocations a JOIN reservations r ON r.id=a.reservation_id
         WHERE r.owner_id=$1 AND a.slot && tstzrange($2,$3,'[)')"
    ).bind(user.id).bind(input.starts_at).bind(input.ends_at).fetch_all(&mut *transaction).await?;
    let intervals: Vec<_> = overlaps
        .iter()
        .map(|row| (row.get("starts_at"), row.get("ends_at")))
        .collect();
    let peak =
        peak_allocations(&intervals, input.starts_at, input.ends_at) + input.gpu_ids.len() as i64;
    let resources = sqlx::query(
        "SELECT g.id,g.display_index,g.maintenance,g.missing,n.name AS node_name,n.enabled FROM gpus g JOIN nodes n ON n.id=g.node_id WHERE g.id=ANY($1) ORDER BY g.id FOR UPDATE OF g",
    )
    .bind(&input.gpu_ids)
    .fetch_all(&mut *transaction)
    .await?;
    if resources.len() != input.gpu_ids.len()
        || resources.iter().any(|row| {
            row.get::<bool, _>("maintenance")
                || row.get::<bool, _>("missing")
                || !row.get::<bool, _>("enabled")
        })
    {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "包含不可预约的 GPU".into(),
        ));
    }
    let conflicts = sqlx::query(
        "SELECT g.display_index,n.name AS node_name,u.display_name,r.project_name,lower(a.slot) AS starts_at,upper(a.slot) AS ends_at FROM reservation_allocations a JOIN reservations r ON r.id=a.reservation_id JOIN gpus g ON g.id=a.gpu_id JOIN nodes n ON n.id=g.node_id JOIN users u ON u.id=r.owner_id WHERE a.gpu_id=ANY($1) AND a.slot && tstzrange($2,$3,'[)') ORDER BY g.id,lower(a.slot)"
    ).bind(&input.gpu_ids).bind(input.starts_at).bind(input.ends_at).fetch_all(&mut *transaction).await?;
    if !conflicts.is_empty() {
        let details = conflicts
            .iter()
            .map(|row| {
                format!(
                    "{} · GPU {} 与 {} 的“{}”冲突：{} — {}",
                    row.get::<String, _>("node_name"),
                    row.get::<i32, _>("display_index"),
                    row.get::<String, _>("display_name"),
                    row.get::<String, _>("project_name"),
                    row.get::<DateTime<Utc>, _>("starts_at"),
                    row.get::<DateTime<Utc>, _>("ends_at")
                )
            })
            .collect::<Vec<_>>();
        return Err(ApiError(StatusCode::CONFLICT, details.join("\n")));
    }
    if peak > user.concurrent_gpu_limit as i64 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            format!(
                "并发预约将达到 {peak} 张 GPU，超过你的 {} 张上限",
                user.concurrent_gpu_limit
            ),
        ));
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO reservations(id,owner_id,starts_at,ends_at,project_name,purpose,status) VALUES($1,$2,$3,$4,$5,$6,'scheduled')")
        .bind(id).bind(user.id).bind(input.starts_at).bind(input.ends_at).bind(input.project_name.trim()).bind(input.purpose.trim()).execute(&mut *transaction).await?;
    for gpu_id in &input.gpu_ids {
        let result = sqlx::query("INSERT INTO reservation_allocations(id,reservation_id,gpu_id,slot) VALUES($1,$2,$3,tstzrange($4,$5,'[)'))")
            .bind(Uuid::new_v4()).bind(id).bind(gpu_id).bind(input.starts_at).bind(input.ends_at).execute(&mut *transaction).await;
        if let Err(error) = result {
            if error.as_database_error().is_some_and(|db| {
                db.constraint()
                    .is_some_and(|name| name.contains("reservation_allocations"))
            }) {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "所选 GPU 的预约状态已变化，请刷新后重新选择时段".into(),
                ));
            }
            return Err(error.into());
        }
    }
    enqueue(
        &mut transaction,
        "reservation.created",
        &format!("reservation-created-{id}"),
        &format!(
            "{} 创建预约：{}（{} 至 {}）\n{}",
            user.display_name, input.project_name, input.starts_at, input.ends_at, state.public_url
        ),
        user.wecom_user_id.clone(),
    )
    .await?;
    audit(
        &mut transaction,
        Some(user.id),
        "reservation.create",
        "reservation",
        &id.to_string(),
        json!({"gpuIds":input.gpu_ids}),
    )
    .await?;
    transaction.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({"id":id}))))
}

async fn cancel_reservation(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    user.require_csrf(&headers)?;
    mutate_reservation(&state, &user, id, "cancelled", "reservation.cancel").await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn check_in(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    user.require_csrf(&headers)?;
    let affected = sqlx::query("UPDATE reservations SET checked_in_at=now(),status='active',updated_at=now() WHERE id=$1 AND owner_id=$2 AND status IN ('scheduled','active')")
        .bind(id).bind(user.id).execute(&state.pool).await?.rows_affected();
    if affected == 0 {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "预约不存在或不可签到".into(),
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn end_early(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    user.require_csrf(&headers)?;
    let mut transaction = state.pool.begin().await?;
    let affected = sqlx::query("UPDATE reservations SET ended_early_at=now(),ends_at=LEAST(ends_at,now()),status='completed',updated_at=now() WHERE id=$1 AND owner_id=$2 AND status IN ('scheduled','active')")
        .bind(id).bind(user.id).execute(&mut *transaction).await?.rows_affected();
    if affected == 0 {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "预约不存在或不可结束".into(),
        ));
    }
    sqlx::query("DELETE FROM reservation_allocations WHERE reservation_id=$1")
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn mutate_reservation(
    state: &AppState,
    user: &AuthUser,
    id: Uuid,
    status: &str,
    action: &str,
) -> Result<(), ApiError> {
    let mut transaction = state.pool.begin().await?;
    let affected = if user.role == "admin" {
        sqlx::query("UPDATE reservations SET status=$2,updated_at=now() WHERE id=$1 AND status IN ('scheduled','active')").bind(id).bind(status).execute(&mut *transaction).await?.rows_affected()
    } else {
        sqlx::query("UPDATE reservations SET status=$3,updated_at=now() WHERE id=$1 AND owner_id=$2 AND status IN ('scheduled','active')").bind(id).bind(user.id).bind(status).execute(&mut *transaction).await?.rows_affected()
    };
    if affected == 0 {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "预约不存在或不可修改".into(),
        ));
    }
    sqlx::query("DELETE FROM reservation_allocations WHERE reservation_id=$1")
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    audit(
        &mut transaction,
        Some(user.id),
        action,
        "reservation",
        &id.to_string(),
        json!({}),
    )
    .await?;
    transaction.commit().await?;
    Ok(())
}

async fn statistics(
    State(state): State<Arc<AppState>>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let rows = sqlx::query("SELECT username,round((sum(active_seconds)::double precision/3600)::numeric,2)::double precision gpu_hours,sum(memory_mb_seconds) memory_mb_seconds,sum(coverage_seconds) coverage_seconds FROM usage_minutes WHERE minute>now()-interval '90 days' GROUP BY username ORDER BY gpu_hours DESC")
        .fetch_all(&state.pool).await?;
    Ok(Json(
        json!({"users":rows.into_iter().map(|row|json!({"username":row.get::<String,_>("username"),"gpuHours":row.get::<f64,_>("gpu_hours"),"coverageSeconds":row.get::<i64,_>("coverage_seconds")})).collect::<Vec<_>>() }),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateNode {
    name: String,
    hostname: String,
}

fn validate_node_registration(name: &str, hostname: &str) -> Result<(), ApiError> {
    if name.trim().is_empty() || hostname.trim().is_empty() {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "节点名称和主机名不能为空".into(),
        ));
    }
    if name.trim().len() > 120 || hostname.trim().len() > 255 {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "节点名称或主机名过长".into(),
        ));
    }
    Ok(())
}

async fn list_nodes(
    State(state): State<Arc<AppState>>,
    admin: AuthUser,
) -> Result<Json<Value>, ApiError> {
    admin.require_admin()?;
    let rows = sqlx::query("SELECT id,name,hostname,enabled,last_seen_at,created_at FROM nodes ORDER BY created_at DESC")
        .fetch_all(&state.pool).await?;
    Ok(Json(json!({"nodes": rows.into_iter().map(|row| json!({
        "id": row.get::<Uuid,_>("id"), "name": row.get::<String,_>("name"),
        "hostname": row.get::<String,_>("hostname"), "enabled": row.get::<bool,_>("enabled"),
        "lastSeenAt": row.get::<Option<DateTime<Utc>>,_>("last_seen_at"),
        "createdAt": row.get::<DateTime<Utc>,_>("created_at")
    })).collect::<Vec<_>>() })))
}

async fn create_node(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    headers: HeaderMap,
    Json(input): Json<CreateNode>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    user.require_admin()?;
    user.require_csrf(&headers)?;
    validate_node_registration(&input.name, &input.hostname)?;
    let name = input.name.trim();
    if sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM nodes WHERE lower(name)=lower($1))",
    )
    .bind(name)
    .fetch_one(&state.pool)
    .await?
    {
        return Err(ApiError(StatusCode::CONFLICT, "节点名称已存在".into()));
    }
    let id = Uuid::new_v4();
    let token = auth::random_token(32);
    sqlx::query("INSERT INTO nodes(id,name,hostname,token_hash) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(name)
        .bind(input.hostname.trim())
        .bind(auth::sha256(&token))
        .execute(&state.pool)
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"id":id,"token":token,"hubUrl":state.public_url})),
    ))
}

async fn agent_snapshot(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(snapshot): Json<AgentSnapshot>,
) -> Result<StatusCode, ApiError> {
    let token = bearer(&headers)
        .ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "缺少 Agent token".into()))?;
    if (Utc::now() - snapshot.sampled_at).num_minutes().abs() > 5 {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "采样时间偏差过大".into(),
        ));
    }
    let mut transaction = state.pool.begin().await?;
    let row = sqlx::query(
        "SELECT id,last_sequence FROM nodes WHERE token_hash=$1 AND enabled=true FOR UPDATE",
    )
    .bind(auth::sha256(token))
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or_else(|| ApiError(StatusCode::UNAUTHORIZED, "Agent token 无效".into()))?;
    let node_id: Uuid = row.get("id");
    let last: i64 = row.get("last_sequence");
    if node_id != snapshot.node_id || snapshot.sequence <= last {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Agent 快照乱序或重放".into(),
        ));
    }
    sqlx::query("UPDATE nodes SET hostname=$2,last_sequence=$3,last_seen_at=now(),last_sample_at=$4 WHERE id=$1").bind(node_id).bind(&snapshot.hostname).bind(snapshot.sequence).bind(snapshot.sampled_at).execute(&mut *transaction).await?;
    sqlx::query("UPDATE gpus SET missing=true WHERE node_id=$1")
        .bind(node_id)
        .execute(&mut *transaction)
        .await?;
    let mut gpu_ids = HashMap::new();
    for gpu in &snapshot.gpus {
        let id:Uuid=sqlx::query_scalar("INSERT INTO gpus(id,node_id,gpu_uuid,display_index,name,memory_total_mb,last_seen_at,missing) VALUES($1,$2,$3,$4,$5,$6,$7,false) ON CONFLICT(gpu_uuid) DO UPDATE SET node_id=excluded.node_id,display_index=excluded.display_index,name=excluded.name,memory_total_mb=excluded.memory_total_mb,last_seen_at=excluded.last_seen_at,missing=false RETURNING id")
            .bind(Uuid::new_v4()).bind(node_id).bind(&gpu.uuid).bind(gpu.index).bind(&gpu.name).bind(gpu.memory_total_mb).bind(snapshot.sampled_at).fetch_one(&mut *transaction).await?;
        gpu_ids.insert(gpu.uuid.clone(), id);
        sqlx::query("INSERT INTO current_gpu_state(gpu_id,sampled_at,memory_used_mb,utilization_percent,temperature_celsius) VALUES($1,$2,$3,$4,$5) ON CONFLICT(gpu_id) DO UPDATE SET sampled_at=excluded.sampled_at,memory_used_mb=excluded.memory_used_mb,utilization_percent=excluded.utilization_percent,temperature_celsius=excluded.temperature_celsius")
            .bind(id).bind(snapshot.sampled_at).bind(gpu.memory_used_mb).bind(gpu.utilization_percent).bind(gpu.temperature_celsius).execute(&mut *transaction).await?;
    }
    sqlx::query(
        "DELETE FROM current_processes WHERE gpu_id IN (SELECT id FROM gpus WHERE node_id=$1)",
    )
    .bind(node_id)
    .execute(&mut *transaction)
    .await?;
    let minute = snapshot
        .sampled_at
        .with_second(0)
        .unwrap()
        .with_nanosecond(0)
        .unwrap();
    let mut seen = HashSet::new();
    for process in &snapshot.processes {
        let Some(gpu_id) = gpu_ids.get(&process.gpu_uuid) else {
            continue;
        };
        sqlx::query("INSERT INTO current_processes(gpu_id,pid,username,command,memory_used_mb,sampled_at) VALUES($1,$2,$3,$4,$5,$6)").bind(gpu_id).bind(process.pid).bind(&process.username).bind(&process.command).bind(process.memory_used_mb).bind(snapshot.sampled_at).execute(&mut *transaction).await?;
        if seen.insert((*gpu_id, process.username.clone())) {
            sqlx::query("INSERT INTO usage_minutes(gpu_id,username,minute,active_seconds,memory_mb_seconds,coverage_seconds) VALUES($1,$2,$3,5,$4,5) ON CONFLICT(gpu_id,username,minute) DO UPDATE SET active_seconds=LEAST(60,usage_minutes.active_seconds+5),memory_mb_seconds=usage_minutes.memory_mb_seconds+excluded.memory_mb_seconds,coverage_seconds=LEAST(60,usage_minutes.coverage_seconds+5)")
                .bind(gpu_id).bind(&process.username).bind(minute).bind(process.memory_used_mb*5).execute(&mut *transaction).await?;
        }
    }
    for system_user in &snapshot.system_users {
        sqlx::query("INSERT INTO node_system_users(node_id,username,uid,shell,last_seen_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(node_id,username) DO UPDATE SET uid=excluded.uid,shell=excluded.shell,last_seen_at=excluded.last_seen_at")
            .bind(node_id).bind(&system_user.username).bind(system_user.uid).bind(&system_user.shell).bind(snapshot.sampled_at).execute(&mut *transaction).await?;
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM users WHERE username=$1 OR linux_username=$1)",
        )
        .bind(&system_user.username)
        .fetch_one(&mut *transaction)
        .await?;
        if !exists {
            let hash = auth::hash_password(&format!("{}@123456", system_user.username))
                .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "密码处理失败".into()))?;
            sqlx::query("INSERT INTO users(id,username,display_name,linux_username,password_hash,role,must_change_password) VALUES($1,$2,$2,$2,$3,'user',true) ON CONFLICT DO NOTHING")
                .bind(Uuid::new_v4()).bind(&system_user.username).bind(hash).execute(&mut *transaction).await?;
        }
    }
    transaction.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateUser {
    username: String,
    display_name: String,
    linux_username: String,
    wecom_user_id: Option<String>,
    password: String,
    role: Option<String>,
}

async fn create_user(
    State(state): State<Arc<AppState>>,
    admin: AuthUser,
    headers: HeaderMap,
    Json(input): Json<CreateUser>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    admin.require_admin()?;
    admin.require_csrf(&headers)?;
    if input.password.len() < 12 {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "密码至少12字符".into(),
        ));
    }
    let role = input.role.unwrap_or_else(|| "user".into());
    if role != "user" && role != "admin" {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "角色无效".into(),
        ));
    }
    let id = Uuid::new_v4();
    let password_hash = auth::hash_password(&input.password)
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "密码处理失败".into()))?;
    sqlx::query("INSERT INTO users(id,username,display_name,linux_username,wecom_user_id,password_hash,role) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(id).bind(input.username.trim()).bind(input.display_name.trim()).bind(input.linux_username.trim()).bind(input.wecom_user_id).bind(password_hash).bind(role).execute(&state.pool).await?;
    Ok((StatusCode::CREATED, Json(json!({"id":id}))))
}

async fn list_users(
    State(state): State<Arc<AppState>>,
    admin: AuthUser,
) -> Result<Json<Value>, ApiError> {
    admin.require_admin()?;
    let rows=sqlx::query("SELECT id,username,display_name,linux_username,wecom_user_id,role,concurrent_gpu_limit,enabled,must_change_password FROM users ORDER BY display_name").fetch_all(&state.pool).await?;
    Ok(Json(
        json!({"users":rows.into_iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"username":r.get::<String,_>("username"),"displayName":r.get::<String,_>("display_name"),"linuxUsername":r.get::<String,_>("linux_username"),"wecomUserId":r.get::<Option<String>,_>("wecom_user_id"),"role":r.get::<String,_>("role"),"concurrentGpuLimit":r.get::<i32,_>("concurrent_gpu_limit"),"enabled":r.get::<bool,_>("enabled"),"mustChangePassword":r.get::<bool,_>("must_change_password")})).collect::<Vec<_>>() }),
    ))
}

async fn sync_system_users(
    State(state): State<Arc<AppState>>,
    admin: AuthUser,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    admin.require_admin()?;
    admin.require_csrf(&headers)?;
    let names: Vec<String> = sqlx::query_scalar("SELECT DISTINCT username FROM node_system_users WHERE last_seen_at>now()-interval '10 minutes' ORDER BY username").fetch_all(&state.pool).await?;
    let mut created = Vec::new();
    for name in names {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM users WHERE username=$1 OR linux_username=$1)",
        )
        .bind(&name)
        .fetch_one(&state.pool)
        .await?;
        if exists {
            continue;
        }
        let hash = auth::hash_password(&format!("{name}@123456"))
            .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "密码处理失败".into()))?;
        sqlx::query("INSERT INTO users(id,username,display_name,linux_username,password_hash,role,must_change_password) VALUES($1,$2,$2,$2,$3,'user',true)").bind(Uuid::new_v4()).bind(&name).bind(hash).execute(&state.pool).await?;
        created.push(name);
    }
    let created_count = created.len();
    Ok(Json(
        json!({"created":created,"createdCount":created_count}),
    ))
}

fn peak_allocations(
    intervals: &[(DateTime<Utc>, DateTime<Utc>)],
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> i64 {
    let mut events = Vec::new();
    for &(a, b) in intervals {
        let left = a.max(start);
        let right = b.min(end);
        if left < right {
            events.push((left, 1_i64));
            events.push((right, -1_i64));
        }
    }
    // End events sort before start events: adjacent reservations do not overlap.
    events.sort_unstable();
    let mut current = 0;
    let mut peak = 0;
    for (_, delta) in events {
        current += delta;
        peak = peak.max(current);
    }
    peak
}

fn validate_reservation(input: &CreateReservation, limit: i32) -> Result<(), ApiError> {
    if input.gpu_ids.is_empty() || input.gpu_ids.len() > limit as usize {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("请选择1至{limit}张 GPU"),
        ));
    }
    if input.gpu_ids.iter().collect::<HashSet<_>>().len() != input.gpu_ids.len() {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "GPU 不可重复".into(),
        ));
    }
    let now = Utc::now();
    if input.starts_at < now - Duration::minutes(5) || input.starts_at > now + Duration::days(14) {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "开始时间必须在未来14天内".into(),
        ));
    }
    if input.ends_at <= input.starts_at || input.ends_at - input.starts_at > Duration::hours(48) {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "预约时长必须大于0且不超过48小时".into(),
        ));
    }
    if input.project_name.trim().is_empty()
        || input.project_name.len() > 120
        || input.purpose.trim().is_empty()
        || input.purpose.len() > 500
    {
        return Err(ApiError(
            StatusCode::UNPROCESSABLE_ENTITY,
            "项目名或用途无效".into(),
        ));
    }
    Ok(())
}
async fn enqueue(
    tx: &mut Transaction<'_, Postgres>,
    event_type: &str,
    dedupe_key: &str,
    content: &str,
    mentioned: Option<String>,
) -> Result<(), ApiError> {
    sqlx::query("INSERT INTO notification_outbox(id,event_type,dedupe_key,content,mentioned_user_ids) VALUES($1,$2,$3,$4,$5) ON CONFLICT(dedupe_key) DO NOTHING").bind(Uuid::new_v4()).bind(event_type).bind(dedupe_key).bind(content).bind(mentioned.into_iter().collect::<Vec<_>>()).execute(&mut **tx).await?;
    Ok(())
}
async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    actor: Option<Uuid>,
    action: &str,
    object_type: &str,
    object_id: &str,
    detail: Value,
) -> Result<(), ApiError> {
    sqlx::query("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,detail) VALUES($1,$2,$3,$4,$5,$6)").bind(Uuid::new_v4()).bind(actor).bind(action).bind(object_type).bind(object_id).bind(detail).execute(&mut **tx).await?;
    Ok(())
}
fn client_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .unwrap_or("unknown")
        .trim()
        .to_string()
}
fn session_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .map(str::trim)
        .find_map(|v| v.strip_prefix("gpudeck_session="))
}
fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_peak_not_union_and_allows_touching_boundaries() {
        let start = Utc::now();
        let middle = start + Duration::hours(1);
        let end = middle + Duration::hours(1);
        assert_eq!(
            peak_allocations(&[(start, middle), (middle, end)], start, end),
            1
        );
        assert_eq!(
            peak_allocations(&[(start, end), (middle, end)], start, end),
            2
        );
        assert_eq!(
            peak_allocations(&[(end, end + Duration::hours(1))], start, end),
            0
        );
    }

    fn reservation(duration: Duration) -> CreateReservation {
        let starts_at = Utc::now() + Duration::hours(1);
        CreateReservation {
            gpu_ids: vec![Uuid::new_v4()],
            starts_at,
            ends_at: starts_at + duration,
            project_name: "model training".into(),
            purpose: "baseline experiment".into(),
        }
    }

    #[test]
    fn accepts_reservation_within_policy() {
        assert!(validate_reservation(&reservation(Duration::hours(48)), 2).is_ok());
    }

    #[test]
    fn rejects_policy_boundaries() {
        assert!(validate_reservation(&reservation(Duration::hours(49)), 2).is_err());
        let mut duplicate = reservation(Duration::hours(1));
        duplicate.gpu_ids.push(duplicate.gpu_ids[0]);
        assert!(validate_reservation(&duplicate, 2).is_err());
        let mut empty_purpose = reservation(Duration::hours(1));
        empty_purpose.purpose = "   ".into();
        assert!(validate_reservation(&empty_purpose, 2).is_err());
    }

    #[test]
    fn validates_node_registration_fields() {
        assert!(validate_node_registration("WHUServer-H200", "WHUServer-H200").is_ok());
        assert!(validate_node_registration("  ", "WHUServer-H200").is_err());
        assert!(validate_node_registration("WHUServer-H200", " ").is_err());
        assert!(validate_node_registration(&"n".repeat(121), "host").is_err());
    }
}
