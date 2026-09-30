use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuTelemetry {
    pub uuid: String,
    pub index: i32,
    pub name: String,
    pub memory_total_mb: i64,
    pub memory_used_mb: i64,
    pub utilization_percent: f64,
    pub temperature_celsius: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuProcessTelemetry {
    pub gpu_uuid: String,
    pub pid: i64,
    pub username: String,
    pub command: String,
    pub memory_used_mb: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemUserTelemetry {
    pub username: String,
    pub uid: i64,
    pub shell: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSnapshot {
    pub node_id: Uuid,
    pub sequence: i64,
    pub sampled_at: DateTime<Utc>,
    pub hostname: String,
    pub cpu_percent: Option<f64>,
    pub memory_used_bytes: Option<i64>,
    pub memory_total_bytes: Option<i64>,
    pub gpus: Vec<GpuTelemetry>,
    pub processes: Vec<GpuProcessTelemetry>,
    #[serde(default)]
    pub system_users: Vec<SystemUserTelemetry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReservationView {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub owner_name: String,
    pub gpu_ids: Vec<Uuid>,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub project_name: String,
    pub purpose: String,
    pub status: String,
    pub checked_in_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateReservation {
    pub gpu_ids: Vec<Uuid>,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub project_name: String,
    pub purpose: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_payload_uses_camel_case() {
        let payload = AgentSnapshot {
            node_id: Uuid::nil(),
            sequence: 1,
            sampled_at: Utc::now(),
            hostname: "gpu-1".into(),
            cpu_percent: None,
            memory_used_bytes: None,
            memory_total_bytes: None,
            gpus: vec![],
            processes: vec![],
            system_users: vec![],
        };
        let json = serde_json::to_value(payload).unwrap();
        assert!(json.get("nodeId").is_some());
        assert!(json.get("sampledAt").is_some());
    }
}
