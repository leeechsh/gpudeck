use crate::AppState;
use axum::http::StatusCode;
use serde_json::json;
use sqlx::Row;
use std::{sync::Arc, time::Duration};
use uuid::Uuid;

pub fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        let client = reqwest::Client::new();
        loop {
            if let Err(error) = tick(&state, &client).await {
                tracing::error!(%error,"notification worker failed");
            }
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });
}

async fn tick(state: &AppState, client: &reqwest::Client) -> anyhow::Result<()> {
    enqueue_policy_events(state).await?;
    roll_up_usage(state).await?;
    sqlx::query("UPDATE reservations SET status='active',updated_at=now() WHERE status='scheduled' AND starts_at<=now() AND ends_at>now()").execute(&state.pool).await?;
    sqlx::query("UPDATE reservations SET status='completed',updated_at=now() WHERE status IN ('scheduled','active') AND ends_at<=now()").execute(&state.pool).await?;
    let Some(webhook) = &state.wecom_webhook else {
        return Ok(());
    };
    let rows=sqlx::query("SELECT id,content,mentioned_user_ids,attempts FROM notification_outbox WHERE sent_at IS NULL AND next_attempt_at<=now() AND attempts<5 ORDER BY created_at LIMIT 10").fetch_all(&state.pool).await?;
    for row in rows {
        let id: Uuid = row.get("id");
        let content: String = row.get("content");
        let mentioned: Vec<String> = row.get("mentioned_user_ids");
        let result = client
            .post(webhook)
            .json(&json!({"msgtype":"text","text":{"content":content,"mentioned_list":mentioned}}))
            .send()
            .await;
        match result {
            Ok(response) if response.status() == StatusCode::OK => {
                let body: serde_json::Value = response.json().await.unwrap_or_default();
                if body.get("errcode").and_then(|v| v.as_i64()) == Some(0) {
                    sqlx::query("UPDATE notification_outbox SET sent_at=now() WHERE id=$1")
                        .bind(id)
                        .execute(&state.pool)
                        .await?;
                } else {
                    retry(
                        &state.pool,
                        id,
                        format!("WeCom response: {body}"),
                        row.get("attempts"),
                    )
                    .await?;
                }
            }
            Ok(response) => {
                retry(
                    &state.pool,
                    id,
                    format!("HTTP {}", response.status()),
                    row.get("attempts"),
                )
                .await?
            }
            Err(error) => retry(&state.pool, id, error.to_string(), row.get("attempts")).await?,
        }
    }
    Ok(())
}

async fn enqueue_policy_events(state: &AppState) -> anyhow::Result<()> {
    // A stable dedupe key turns the frequently running worker into an idempotent detector.
    sqlx::query(
        "INSERT INTO notification_outbox(id,event_type,dedupe_key,content,mentioned_user_ids)
         SELECT gen_random_uuid(),'reservation.reminder','reminder-'||r.id,
                '预约即将开始：'||r.project_name||'（'||to_char(r.starts_at AT TIME ZONE 'Asia/Shanghai','MM-DD HH24:MI')||'）\n'||$1,
                CASE WHEN u.wecom_user_id IS NULL THEN '{}'::text[] ELSE ARRAY[u.wecom_user_id] END
         FROM reservations r JOIN users u ON u.id=r.owner_id
         WHERE r.status='scheduled' AND r.starts_at BETWEEN now()+interval '14 minutes' AND now()+interval '16 minutes'
         ON CONFLICT(dedupe_key) DO NOTHING"
    ).bind(&state.public_url).execute(&state.pool).await?;
    sqlx::query(
        "INSERT INTO notification_outbox(id,event_type,dedupe_key,content,mentioned_user_ids)
         SELECT gen_random_uuid(),'reservation.no_show','no-show-'||r.id,
                '预约开始 15 分钟仍未签到：'||u.display_name||' / '||r.project_name||'。预约不会自动释放。\n'||$1,
                CASE WHEN u.wecom_user_id IS NULL THEN '{}'::text[] ELSE ARRAY[u.wecom_user_id] END
         FROM reservations r JOIN users u ON u.id=r.owner_id
         WHERE r.status='active' AND r.checked_in_at IS NULL AND r.starts_at BETWEEN now()-interval '17 minutes' AND now()-interval '15 minutes'
         ON CONFLICT(dedupe_key) DO NOTHING"
    ).bind(&state.public_url).execute(&state.pool).await?;
    sqlx::query(
        "INSERT INTO notification_outbox(id,event_type,dedupe_key,content,mentioned_user_ids)
         SELECT DISTINCT gen_random_uuid(),'usage.unreserved',
                'unreserved-'||p.gpu_id||'-'||p.username||'-'||to_char(date_trunc('hour',now()),'YYYYMMDDHH24'),
                '检测到未预约使用：'||p.username||' 正在 '||n.name||' / GPU '||g.display_index||' 上运行 PID '||p.pid||'。系统仅通知，不会终止进程。\n'||$1,
                CASE WHEN u.wecom_user_id IS NULL THEN '{}'::text[] ELSE ARRAY[u.wecom_user_id] END
         FROM current_processes p JOIN gpus g ON g.id=p.gpu_id JOIN nodes n ON n.id=g.node_id
         LEFT JOIN users u ON u.linux_username=p.username
         WHERE p.sampled_at>now()-interval '2 minutes' AND NOT EXISTS(
           SELECT 1 FROM reservation_allocations a JOIN reservations r ON r.id=a.reservation_id JOIN users ru ON ru.id=r.owner_id
           WHERE a.gpu_id=p.gpu_id AND r.status='active' AND now()<@a.slot AND ru.linux_username=p.username)
         ON CONFLICT(dedupe_key) DO NOTHING"
    ).bind(&state.public_url).execute(&state.pool).await?;
    sqlx::query(
        "INSERT INTO notification_outbox(id,event_type,dedupe_key,content,mentioned_user_ids)
         SELECT DISTINCT gen_random_uuid(),'usage.overrun','overrun-'||r.id||'-'||to_char(date_trunc('hour',now()),'YYYYMMDDHH24'),
                '预约已到期但任务仍在运行：'||u.display_name||' / '||r.project_name||'。系统不会续期或终止进程，请尽快协调。\n'||$1,
                CASE WHEN u.wecom_user_id IS NULL THEN '{}'::text[] ELSE ARRAY[u.wecom_user_id] END
         FROM reservations r JOIN users u ON u.id=r.owner_id JOIN reservation_allocations a ON a.reservation_id=r.id
         JOIN current_processes p ON p.gpu_id=a.gpu_id AND p.username=u.linux_username
         WHERE r.ends_at BETWEEN now()-interval '24 hours' AND now() AND r.status='completed' AND p.sampled_at>now()-interval '2 minutes'
         ON CONFLICT(dedupe_key) DO NOTHING"
    ).bind(&state.public_url).execute(&state.pool).await?;
    Ok(())
}

async fn roll_up_usage(state: &AppState) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO usage_hours(gpu_id,username,hour,active_seconds,memory_mb_seconds,coverage_seconds)
         SELECT gpu_id,username,date_trunc('hour',minute),sum(active_seconds),sum(memory_mb_seconds),sum(coverage_seconds)
         FROM usage_minutes WHERE minute<date_trunc('hour',now()) GROUP BY gpu_id,username,date_trunc('hour',minute)
         ON CONFLICT(gpu_id,username,hour) DO UPDATE SET active_seconds=excluded.active_seconds,memory_mb_seconds=excluded.memory_mb_seconds,coverage_seconds=excluded.coverage_seconds"
    ).execute(&state.pool).await?;
    sqlx::query("DELETE FROM usage_minutes WHERE minute<now()-interval '90 days'")
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM usage_hours WHERE hour<now()-interval '1 year'")
        .execute(&state.pool)
        .await?;
    sqlx::query(
        "DELETE FROM sessions WHERE expires_at<now() OR last_seen_at<now()-interval '12 hours'",
    )
    .execute(&state.pool)
    .await?;
    Ok(())
}

async fn retry(pool: &sqlx::PgPool, id: Uuid, error: String, attempts: i32) -> anyhow::Result<()> {
    let delay = 2_i64.pow((attempts + 1).min(6) as u32);
    sqlx::query("UPDATE notification_outbox SET attempts=attempts+1,last_error=$2,next_attempt_at=now()+($3 * interval '1 second') WHERE id=$1").bind(id).bind(error).bind(delay).execute(pool).await?;
    Ok(())
}
