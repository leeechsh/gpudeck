use std::{env, fs, path::Path};

fn collect(dir: &Path, root: &Path, output: &mut String) {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            collect(&path, root, output);
        } else {
            let url = format!(
                "/{}",
                path.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            );
            output.push_str(&format!(
                "{url:?} => Some(include_bytes!({:?})),\n",
                path.to_str().unwrap()
            ));
        }
    }
}

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../dist")
        .canonicalize()
        .expect("Build Web first: npm ci && npm run build");
    assert!(
        root.join("index.html").is_file(),
        "Run npm run build before building Hub"
    );
    println!("cargo:rerun-if-changed={}", root.display());
    let mut code = String::from("fn asset(path: &str) -> Option<&'static [u8]> { match path {\n");
    collect(&root, &root, &mut code);
    code.push_str("_ => None, }}\n");
    fs::write(
        Path::new(&env::var("OUT_DIR").unwrap()).join("web_assets.rs"),
        code,
    )
    .unwrap();
}
