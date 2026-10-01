use crate::{AppState, db::timestamp};
use chrono::{DateTime, Duration as ChronoDuration, FixedOffset, Utc};
use serde_json::json;
use sqlx::{Row, SqlitePool};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};
use uuid::Uuid;

pub(crate) fn beijing_time(time: DateTime<Utc>) -> String {
    time.with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap())
        .format("%Y-%m-%d %H:%M")
        .to_string()
}

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

pub(crate) async fn tick(state: &AppState, client: &reqwest::Client) -> anyhow::Result<()> {
    sqlx::query("UPDATE reservations SET status='active',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='scheduled' AND starts_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')").execute(&state.pool).await?;
    sqlx::query("UPDATE reservations SET status='completed',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status IN ('scheduled','active') AND ends_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')").execute(&state.pool).await?;
    // First observed use on any allocated GPU starts the reservation's usage
    // record. Ignore other users, stale samples and samples before its start.
    sqlx::query("UPDATE reservations AS r SET checked_in_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE r.status='active' AND r.checked_in_at IS NULL AND r.starts_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND r.ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND EXISTS(SELECT 1 FROM reservation_allocations a JOIN current_processes p ON p.gpu_id=a.gpu_id JOIN users u ON u.id=r.owner_id WHERE a.reservation_id=r.id AND p.username=u.linux_username AND p.sampled_at>=r.starts_at AND p.sampled_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes') AND p.sampled_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))").execute(&state.pool).await?;
    enqueue_policy_events(state).await?;
    roll_up_usage(state).await?;
    let Some(webhook) = &state.wecom_webhook else {
        return Ok(());
    };
    let rows=sqlx::query("SELECT id,content,mentioned_user_ids,attempts FROM notification_outbox WHERE sent_at IS NULL AND next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND attempts<5 ORDER BY created_at LIMIT 10").fetch_all(&state.pool).await?;
    for row in rows {
        let id: Uuid = row.get("id");
        let content: String = row.get("content");
        let mentioned: sqlx::types::Json<Vec<String>> = row.get("mentioned_user_ids");
        let outcome = match client
            .post(webhook)
            .json(&crate::notification::payload(&content, &mentioned.0))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                match response.json::<serde_json::Value>().await {
                    Ok(body) if body.get("errcode").and_then(|v| v.as_i64()) == Some(0) => Ok(()),
                    Ok(body) => Err(format!("WeCom response: {body}")),
                    Err(error) => Err(error.to_string()),
                }
            }
            Ok(response) => Err(format!("HTTP {}", response.status())),
            Err(error) => Err(error.to_string()),
        };
        match outcome {
            Ok(()) => {
                sqlx::query("UPDATE notification_outbox SET sent_at=?2 WHERE id=?1")
                    .bind(id)
                    .bind(timestamp(Utc::now()))
                    .execute(&state.pool)
                    .await?;
            }
            Err(error) => retry(&state.pool, id, error, row.get("attempts")).await?,
        }
    }
    Ok(())
}

async fn enqueue_policy_events(state: &AppState) -> anyhow::Result<()> {
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let queries = [
        (
            "reservation.reminder",
            "reminder",
            "SELECT r.id,u.display_name,r.project_name,r.starts_at,u.wecom_user_id FROM reservations r JOIN users u ON u.id=r.owner_id WHERE r.status='scheduled' AND r.starts_at BETWEEN strftime('%Y-%m-%dT%H:%M:%fZ','now','+14 minutes') AND strftime('%Y-%m-%dT%H:%M:%fZ','now','+16 minutes')",
        ),
        (
            "reservation.no_show",
            "no-show",
            "SELECT r.id,u.display_name,r.project_name,r.starts_at,u.wecom_user_id FROM reservations r JOIN users u ON u.id=r.owner_id WHERE r.status='active' AND r.checked_in_at IS NULL AND r.starts_at BETWEEN strftime('%Y-%m-%dT%H:%M:%fZ','now','-17 minutes') AND strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')",
        ),
        (
            "usage.overrun",
            "overrun",
            "SELECT DISTINCT r.id,u.display_name,r.project_name,r.starts_at,u.wecom_user_id FROM reservations r JOIN users u ON u.id=r.owner_id JOIN reservation_allocations a ON a.reservation_id=r.id JOIN current_processes p ON p.gpu_id=a.gpu_id AND p.username=u.linux_username WHERE r.ends_at BETWEEN strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours') AND strftime('%Y-%m-%dT%H:%M:%fZ','now') AND r.status='completed' AND p.sampled_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes')",
        ),
    ];
    let now = Utc::now();
    // Keep existing UTC dedupe keys. UTC+8 has the same natural-hour
    // boundaries; renaming keys would resend events during an upgrade.
    let hour = now.format("%Y%m%d%H").to_string();
    for (event, prefix, query) in queries {
        for row in sqlx::query(query).fetch_all(&mut *tx).await? {
            let id: Uuid = row.get("id");
            let person: String = row.get("display_name");
            let project: String = row.get("project_name");
            let start: chrono::DateTime<Utc> = row.get("starts_at");
            let (title, color, note) = match event {
                "reservation.reminder" => (
                    "预约即将开始",
                    "info",
                    "约 15 分钟后开始，请准备任务；无需手动签到。",
                ),
                "reservation.no_show" => (
                    "预约尚未检测到使用",
                    "warning",
                    "预约开始 15 分钟仍未检测到本人 GPU 进程。节点离线时无法确认使用情况；预约不会自动释放。",
                ),
                _ => (
                    "预约已到期但任务仍在运行",
                    "warning",
                    "请尽快结束任务或联系团队协调。系统不会自动续期或终止进程。",
                ),
            };
            let end: chrono::DateTime<Utc> =
                sqlx::query_scalar("SELECT ends_at FROM reservations WHERE id=?1")
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await?;
            let gpus: Vec<String> = sqlx::query_scalar("SELECT n.name || ' / GPU ' || g.display_index FROM reservation_allocations a JOIN gpus g ON g.id=a.gpu_id JOIN nodes n ON n.id=g.node_id WHERE a.reservation_id=?1 ORDER BY n.name,g.display_index").bind(id).fetch_all(&mut *tx).await?;
            let content = crate::notification::markdown(
                title,
                color,
                &[
                    ("用户", person),
                    ("项目", project),
                    ("GPU", gpus.join("；")),
                    (
                        "预约时间",
                        format!(
                            "北京时间 UTC+8：{} 至 {}",
                            beijing_time(start),
                            beijing_time(end)
                        ),
                    ),
                ],
                note,
                &state.public_url,
                now,
            );
            let key = if event == "usage.overrun" {
                format!("{prefix}-{id}-{hour}")
            } else {
                format!("{prefix}-{id}")
            };
            let mentioned: Option<String> = row.get("wecom_user_id");
            sqlx::query("INSERT INTO notification_outbox(id,event_type,dedupe_key,content,mentioned_user_ids) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(dedupe_key) DO NOTHING")
                .bind(Uuid::new_v4()).bind(event).bind(key).bind(content).bind(json!(mentioned.into_iter().collect::<Vec<_>>())).execute(&mut *tx).await?;
        }
    }
    let rows=sqlx::query("SELECT p.gpu_id,g.node_id,p.username,p.pid,n.name,g.display_index,u.wecom_user_id FROM current_processes p JOIN gpus g ON g.id=p.gpu_id JOIN nodes n ON n.id=g.node_id LEFT JOIN users u ON u.linux_username=p.username WHERE p.sampled_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes') AND NOT EXISTS(SELECT 1 FROM reservation_allocations a JOIN reservations r ON r.id=a.reservation_id JOIN users ru ON ru.id=r.owner_id WHERE a.gpu_id=p.gpu_id AND r.status='active' AND a.starts_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND a.ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ru.linux_username=p.username) ORDER BY p.pid").fetch_all(&mut *tx).await?;
    let mut users: BTreeMap<String, Vec<sqlx::sqlite::SqliteRow>> = BTreeMap::new();
    for row in rows {
        users.entry(row.get("username")).or_default().push(row);
    }
    for (user, processes) in users {
        let mentioned: Option<String> = processes[0].get("wecom_user_id");
        // A PID is node-local and may appear on multiple GPUs. Keep the GPU
        // association while counting a shared multi-GPU process only once.
        let mut cards: BTreeMap<(String, i32, Uuid), BTreeSet<i64>> = BTreeMap::new();
        let mut tasks = BTreeSet::new();
        for row in processes {
            let gpu: Uuid = row.get("gpu_id");
            let node: String = row.get("name");
            let index: i32 = row.get("display_index");
            let pid: i64 = row.get("pid");
            let node_id: Uuid = row.get("node_id");
            tasks.insert((node_id, pid));
            cards.entry((node, index, gpu)).or_default().insert(pid);
        }
        let gpu_summary = cards
            .keys()
            .map(|(node, index, _)| format!("{node} / GPU {index}"))
            .collect::<Vec<_>>()
            .join("；");
        let pid_summary = cards
            .iter()
            .map(|((node, index, _), pids)| {
                format!(
                    "{node} GPU {index}：{}",
                    pids.iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })
            .collect::<Vec<_>>()
            .join("；");
        sqlx::query("INSERT INTO notification_outbox(id,event_type,dedupe_key,content,mentioned_user_ids) VALUES(?1,'usage.unreserved',?2,?3,?4) ON CONFLICT(dedupe_key) DO NOTHING")
            .bind(Uuid::new_v4()).bind(format!("unreserved-user-{user}-{hour}"))
            .bind(crate::notification::markdown("检测到未预约使用", "warning", &[("用户", user.clone()), ("占用汇总", format!("{} 张 GPU / {} 个进程", cards.len(), tasks.len())), ("GPU", gpu_summary), ("进程 PID", pid_summary)], "请补充预约或联系团队协调。系统仅通知，不会终止进程。资源或进程过多时摘要会截断，请打开 GPUDeck 查看完整占用。", &state.public_url, now))
            .bind(json!(mentioned.into_iter().collect::<Vec<_>>())).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn roll_up_usage(state: &AppState) -> anyhow::Result<()> {
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query("INSERT INTO usage_hours(gpu_id,username,hour,active_seconds,memory_mb_seconds,coverage_seconds) SELECT gpu_id,username,strftime('%Y-%m-%dT%H:00:00.000Z',minute),sum(active_seconds),sum(memory_mb_seconds),sum(coverage_seconds) FROM usage_minutes WHERE minute<strftime('%Y-%m-%dT%H:00:00.000Z','now') GROUP BY gpu_id,username,strftime('%Y-%m-%dT%H:00:00.000Z',minute) ON CONFLICT(gpu_id,username,hour) DO UPDATE SET active_seconds=excluded.active_seconds,memory_mb_seconds=excluded.memory_mb_seconds,coverage_seconds=excluded.coverage_seconds").execute(&mut *tx).await?;
    sqlx::query(
        "DELETE FROM usage_minutes WHERE minute<strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "DELETE FROM usage_hours WHERE hour<strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 year')",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM sessions WHERE expires_at<strftime('%Y-%m-%dT%H:%M:%fZ','now') OR last_seen_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-12 hours')").execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

async fn retry(pool: &SqlitePool, id: Uuid, error: String, attempts: i32) -> anyhow::Result<()> {
    let delay = 2_i64.pow((attempts + 1).min(6) as u32);
    sqlx::query("UPDATE notification_outbox SET attempts=attempts+1,last_error=?2,next_attempt_at=?3 WHERE id=?1")
        .bind(id).bind(error).bind(timestamp(Utc::now()+ChronoDuration::seconds(delay))).execute(pool).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_times_use_beijing_time_across_date_and_year_boundaries() {
        for (utc, expected) in [
            ("2026-10-01T07:30:00Z", "2026-10-01 15:30"),
            ("2026-10-01T18:30:00Z", "2026-10-02 02:30"),
            ("2026-12-31T16:00:00Z", "2027-01-01 00:00"),
        ] {
            let time = utc.parse::<DateTime<Utc>>().unwrap();
            assert_eq!(beijing_time(time), expected);
            assert_eq!(time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true), utc);
        }
    }
}
