use axum::{
    body::Body,
    http::{Method, StatusCode, Uri, header},
    response::Response,
};

include!(concat!(env!("OUT_DIR"), "/web_assets.rs"));

pub async fn serve(method: Method, uri: Uri) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header(header::ALLOW, "GET, HEAD")
            .body(Body::empty())
            .unwrap();
    }
    let path = uri.path();
    if path == "/api" || path.starts_with("/api/") {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap();
    }
    let (data, actual) = match asset(path) {
        Some(data) => (data, path),
        None if path.starts_with("/assets/")
            || path.rsplit('/').next().unwrap_or("").contains('.') =>
        {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::empty())
                .unwrap();
        }
        None => (asset("/index.html").unwrap(), "/index.html"),
    };
    let mime = match actual.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    };
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, data.len())
        .header(
            header::CACHE_CONTROL,
            if actual.starts_with("/assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            },
        )
        .header("x-content-type-options", "nosniff")
        .body(if method == Method::HEAD {
            Body::empty()
        } else {
            Body::from(data)
        })
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn embedded_routes_and_boundaries() {
        let html = std::str::from_utf8(asset("/index.html").unwrap()).unwrap();
        let script = html
            .split("src=\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap();
        let response = serve(Method::GET, script.parse().unwrap()).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/javascript; charset=utf-8"
        );
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        for path in ["/", "/calendar", "/index.html"] {
            let response = serve(Method::GET, path.parse().unwrap()).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()[header::CONTENT_TYPE],
                "text/html; charset=utf-8"
            );
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
        }
        for path in [
            "/api",
            "/api/v1/missing",
            "/assets/missing.js",
            "/missing.png",
        ] {
            assert_eq!(
                serve(Method::GET, path.parse().unwrap()).await.status(),
                StatusCode::NOT_FOUND
            );
        }
        assert_eq!(
            serve(Method::POST, "/".parse().unwrap()).await.status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        let response = serve(Method::HEAD, "/".parse().unwrap()).await;
        assert!(
            axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
                .is_empty()
        );
    }
}
