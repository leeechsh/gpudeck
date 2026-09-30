use anyhow::{Context, bail};
use chrono::Utc;
use gpudeck_domain::{AgentSnapshot, GpuProcessTelemetry, GpuTelemetry, SystemUserTelemetry};
use reqwest::StatusCode;
use std::{collections::HashMap, env, fs, process::Command, time::Duration};
use tracing::{error, info};
use uuid::Uuid;

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "gpudeck_agent=info".into()),
        )
        .init();
    let hub_url = env::var("GPUDECK_HUB_URL")
        .context("GPUDECK_HUB_URL is required")?
        .trim_end_matches('/')
        .to_string();
    let token = env::var("GPUDECK_AGENT_TOKEN").context("GPUDECK_AGENT_TOKEN is required")?;
    let node_id =
        Uuid::parse_str(&env::var("GPUDECK_NODE_ID").context("GPUDECK_NODE_ID is required")?)?;
    let interval = env::var("GPUDECK_SAMPLE_SECONDS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(5)
        .max(2);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;
    info!(%node_id,%hub_url,interval,"GPUDeck Agent started");
    let mut sequence = Utc::now().timestamp_millis();
    loop {
        sequence = sequence.max(Utc::now().timestamp_millis()) + 1;
        match collect(node_id, sequence).and_then(|snapshot| Ok(snapshot)) {
            Ok(snapshot) => {
                match client
                    .post(format!("{hub_url}/api/v1/agent/snapshot"))
                    .bearer_auth(&token)
                    .json(&snapshot)
                    .send()
                    .await
                {
                    Ok(response) if response.status() == StatusCode::NO_CONTENT => {}
                    Ok(response) => {
                        error!(status=%response.status(),body=%response.text().await.unwrap_or_default(),"Hub rejected snapshot")
                    }
                    Err(error) => error!(%error,"snapshot upload failed"),
                }
            }
            Err(error) => error!(%error,"snapshot collection failed"),
        }
        tokio::time::sleep(Duration::from_secs(interval)).await;
    }
}

fn collect(node_id: Uuid, sequence: i64) -> anyhow::Result<AgentSnapshot> {
    let hostname = fs::read_to_string("/etc/hostname")
        .unwrap_or_else(|_| "unknown".into())
        .trim()
        .to_string();
    let gpu_output = run(
        "nvidia-smi",
        &[
            "--query-gpu=index,name,uuid,memory.total,memory.used,utilization.gpu,temperature.gpu",
            "--format=csv,noheader,nounits",
        ],
    )?;
    let mut gpus = Vec::new();
    for line in gpu_output.lines().filter(|line| !line.trim().is_empty()) {
        let fields = split_csv(line);
        if fields.len() != 7 {
            bail!("unexpected nvidia-smi GPU row: {line}");
        }
        gpus.push(GpuTelemetry {
            index: parse(&fields[0])?,
            name: fields[1].clone(),
            uuid: fields[2].clone(),
            memory_total_mb: parse(&fields[3])?,
            memory_used_mb: parse(&fields[4])?,
            utilization_percent: parse(&fields[5])?,
            temperature_celsius: fields[6].parse().ok(),
        });
    }
    let process_output = run(
        "nvidia-smi",
        &[
            "--query-compute-apps=gpu_uuid,pid,used_gpu_memory",
            "--format=csv,noheader,nounits",
        ],
    )
    .unwrap_or_default();
    let mut uid_names = HashMap::new();
    let mut processes = Vec::new();
    for line in process_output
        .lines()
        .filter(|line| !line.trim().is_empty())
    {
        let fields = split_csv(line);
        if fields.len() != 3 {
            continue;
        }
        let Ok(pid) = fields[1].parse::<i64>() else {
            continue;
        };
        let uid = process_uid(pid).unwrap_or_default();
        let username = uid_names
            .entry(uid)
            .or_insert_with(|| uid_name(uid))
            .clone();
        processes.push(GpuProcessTelemetry {
            gpu_uuid: fields[0].clone(),
            pid,
            username,
            command: process_command(pid).unwrap_or_else(|| "<unavailable>".into()),
            memory_used_mb: fields[2].parse().unwrap_or_default(),
        });
    }
    let (memory_used_bytes, memory_total_bytes) = memory_usage();
    Ok(AgentSnapshot {
        node_id,
        sequence,
        sampled_at: Utc::now(),
        hostname,
        cpu_percent: None,
        memory_used_bytes,
        memory_total_bytes,
        gpus,
        processes,
        system_users: system_users(),
    })
}

fn system_users() -> Vec<SystemUserTelemetry> {
    fs::read_to_string("/etc/passwd")
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split(':').collect();
            if fields.len() < 7 {
                return None;
            }
            let uid = fields[2].parse::<i64>().ok()?;
            let shell = fields[6].trim();
            if uid < 1000
                || uid == 65534
                || shell.ends_with("/nologin")
                || shell.ends_with("/false")
            {
                return None;
            }
            Some(SystemUserTelemetry {
                username: fields[0].to_string(),
                uid,
                shell: shell.to_string(),
            })
        })
        .collect()
}

fn run(program: &str, args: &[&str]) -> anyhow::Result<String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .with_context(|| format!("failed to run {program}"))?;
    if !output.status.success() {
        bail!(
            "{program} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
fn split_csv(line: &str) -> Vec<String> {
    line.split(',')
        .map(|value| value.trim().trim_matches('"').to_string())
        .collect()
}
fn parse<T: std::str::FromStr>(value: &str) -> anyhow::Result<T>
where
    T::Err: std::error::Error + Send + Sync + 'static,
{
    Ok(value.parse()?)
}
fn process_uid(pid: i64) -> Option<u32> {
    let status = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    status
        .lines()
        .find(|line| line.starts_with("Uid:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}
fn uid_name(uid: u32) -> String {
    run("getent", &["passwd", &uid.to_string()])
        .ok()
        .and_then(|value| value.split(':').next().map(str::to_string))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| uid.to_string())
}
fn process_command(pid: i64) -> Option<String> {
    let bytes = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let command = String::from_utf8_lossy(&bytes)
        .replace('\0', " ")
        .trim()
        .to_string();
    if command.is_empty() {
        fs::read_to_string(format!("/proc/{pid}/comm"))
            .ok()
            .map(|v| v.trim().to_string())
    } else {
        Some(command)
    }
}
fn memory_usage() -> (Option<i64>, Option<i64>) {
    let Ok(meminfo) = fs::read_to_string("/proc/meminfo") else {
        return (None, None);
    };
    let mut total = None;
    let mut available = None;
    for line in meminfo.lines() {
        let mut fields = line.split_whitespace();
        match fields.next() {
            Some("MemTotal:") => {
                total = fields
                    .next()
                    .and_then(|v| v.parse::<i64>().ok())
                    .map(|v| v * 1024)
            }
            Some("MemAvailable:") => {
                available = fields
                    .next()
                    .and_then(|v| v.parse::<i64>().ok())
                    .map(|v| v * 1024)
            }
            _ => {}
        }
    }
    match (total, available) {
        (Some(t), Some(a)) => (Some(t - a), Some(t)),
        _ => (None, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_nvidia_csv() {
        let fields = split_csv("0, NVIDIA L40S, GPU-abc, 46068, 1200, 81, 64");
        assert_eq!(fields[2], "GPU-abc");
        assert_eq!(fields.len(), 7);
    }
    #[test]
    fn rejects_bad_number() {
        assert!(parse::<i32>("N/A").is_err());
    }
    #[test]
    fn filters_login_users() {
        let users = system_users();
        assert!(
            users
                .iter()
                .all(|user| user.uid >= 1000 && !user.shell.ends_with("/nologin"))
        );
    }
}
