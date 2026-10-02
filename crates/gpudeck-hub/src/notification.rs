use chrono::{DateTime, Utc};
use serde_json::{Value, json};

// WeCom markdown is limited to 4096 UTF-8 bytes, not characters.
fn limited(text: &str, bytes: usize) -> String {
    if text.len() <= bytes {
        return text.to_owned();
    }
    let mut end = bytes.saturating_sub(3).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

fn field(text: &str) -> String {
    // User-controlled fields cannot add formatting, links or @ mentions.
    let mut clean = String::new();
    for c in text.chars() {
        clean.push(match c {
            '&' => '＆',
            '<' => '〈',
            '>' => '〉',
            '*' => '＊',
            '`' => '｀',
            '[' => '［',
            ']' => '］',
            '(' => '（',
            ')' => '）',
            '\\' => '＼',
            '#' => '＃',
            c if c.is_control() => ' ',
            c => c,
        });
    }
    limited(&clean, 384)
}

pub(crate) fn markdown(
    title: &str,
    color: &str,
    fields: &[(&str, String)],
    note: &str,
    public_url: &str,
    now: DateTime<Utc>,
) -> String {
    let mut content = format!("<font color=\"{color}\">{title}</font>\n");
    for (label, value) in fields.iter().take(5) {
        content.push_str(&format!("\n> **{label}**：{}", field(value)));
    }
    if !note.is_empty() {
        content.push_str(&format!("\n\n{}", field(note)));
    }
    content.push_str(&format!(
        "\n\n<font color=\"comment\">时间：{}</font>",
        crate::worker::beijing_time(now)
    ));
    if let Ok(url) = reqwest::Url::parse(public_url) {
        let target = url.as_str().replace('(', "%28").replace(')', "%29");
        if matches!(url.scheme(), "http" | "https") && target.len() <= 512 {
            content.push_str(&format!("\n[打开 GPUDeck]({target})"));
        }
    }
    content
}

pub(crate) fn payload(content: &str, mentioned: &[String]) -> Value {
    // Keep old queued markdown recognizable while new messages use one title.
    if content.starts_with("<font color=\"") || content.starts_with("### GPUDeck · ") {
        // Reserve room for mentions, and enforce the documented byte limit.
        let mentions = mentioned
            .iter()
            .filter(|id| {
                !id.is_empty()
                    && id.len() <= 128
                    && id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_-.@".contains(&c))
            })
            .take(5)
            .map(|id| format!("<@{id}>"))
            .collect::<Vec<_>>()
            .join(" ");
        let suffix = if mentions.is_empty() {
            String::new()
        } else {
            format!("\n\n提醒：{mentions}")
        };
        json!({"msgtype":"markdown","markdown":{"content":format!("{}{}", limited(content, 4096-suffix.len()), suffix)}})
    } else {
        // Pending notifications created before the upgrade retain plain text.
        json!({"msgtype":"text","text":{"content":limited(content,2048),"mentioned_list":mentioned}})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_has_beijing_time_link_and_safe_fields() {
        let content = markdown(
            "预约已创建",
            "info",
            &[("项目", "<@all>\n**x** [evil](url) &lt;@all&gt;".into())],
            "无需签到",
            "https://test.example",
            "2026-10-01T18:30:00Z".parse().unwrap(),
        );
        assert!(content.contains("2026-10-02 02:30"));
        assert!(content.starts_with("<font color=\"info\">预约已创建</font>"));
        assert_eq!(content.matches("预约已创建").count(), 1);
        assert!(!content.contains("### GPUDeck"));
        assert!(content.contains("时间：2026-10-02 02:30"));
        assert!(!content.contains("通知时间（UTC+8）"));
        assert!(content.contains("[打开 GPUDeck](https://test.example/)"));
        assert!(!content.contains("<@all>"));
        assert!(!content.contains("**x**"));
        assert!(!content.contains("&lt;@all&gt;"));
        let message = payload(&content, &["alice".into(), "evil>\n<@all".into()]);
        assert_eq!(message["msgtype"], "markdown");
        assert!(
            message["markdown"]["content"]
                .as_str()
                .unwrap()
                .ends_with("提醒：<@alice>")
        );
        assert!(message["markdown"].get("mentioned_list").is_none());
    }

    #[test]
    fn payload_respects_utf8_byte_limits_and_legacy_queue() {
        let large = format!("### GPUDeck · {}", "中文🚀".repeat(1500));
        let message = payload(&large, &["alice".into()]);
        let content = message["markdown"]["content"].as_str().unwrap();
        assert!(content.len() <= 4096);
        assert!(content.ends_with("<@alice>"));
        let legacy = payload(&"中文".repeat(1500), &["alice".into()]);
        assert_eq!(legacy["msgtype"], "text");
        assert!(legacy["text"]["content"].as_str().unwrap().len() <= 2048);
        assert_eq!(legacy["text"]["mentioned_list"], json!(["alice"]));
    }

    #[test]
    fn long_fields_preserve_complete_markup_footer_and_mentions() {
        let fields = vec![("用户", "中文🚀".repeat(1500)); 5];
        let url = format!("https://test.example/{}", "a".repeat(480));
        let content = markdown(
            "预约已到期但任务仍在运行",
            "warning",
            &fields,
            &"处理建议".repeat(200),
            &url,
            Utc::now(),
        );
        let mentions = vec!["a".repeat(128); 5];
        let message = payload(&content, &mentions);
        let result = message["markdown"]["content"].as_str().unwrap();
        assert!(result.len() <= 4096);
        assert!(result.contains(&format!("[打开 GPUDeck]({url})")));
        assert!(result.contains("<font color=\"comment\">时间："));
        assert!(result.contains("</font>"));
        let invalid = markdown(
            "预约已创建",
            "info",
            &[],
            "",
            "javascript:alert(1)",
            Utc::now(),
        );
        assert!(!invalid.contains("[打开 GPUDeck]"));
    }
}
