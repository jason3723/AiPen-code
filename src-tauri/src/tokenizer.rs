use jieba_rs::Jieba;
use std::sync::OnceLock;

/// 全局单例 Jieba 实例（线程安全，懒加载）
fn jieba() -> &'static Jieba {
    static INSTANCE: OnceLock<Jieba> = OnceLock::new();
    INSTANCE.get_or_init(|| Jieba::new())
}

/// 将文本分词后用空格连接，供 FTS5 索引
/// "用户登录功能" → "用户 登录 功能"
pub fn segment(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    jieba().cut(text, true).join(" ")
}

/// ProseMirror JSON 内容 → 纯文本 → jieba 分词
/// 用于 FTS 索引写入和搜索
pub fn segment_prosemirror_json(json_str: &str) -> String {
    let plain = extract_plain_text(json_str);
    segment(&plain)
}

/// ProseMirror JSON → 纯文本（递归提取所有 text 节点）
pub fn extract_plain_text(json: &str) -> String {
    let doc: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => {
            // 不是 JSON，可能已经是纯文本（旧数据）
            return json.to_string();
        }
    };
    let mut texts: Vec<String> = Vec::new();
    fn walk(node: &serde_json::Value, texts: &mut Vec<String>) {
        if let Some(t) = node.get("text").and_then(|v| v.as_str()) {
            texts.push(t.to_string());
        }
        if let Some(children) = node.get("content").and_then(|v| v.as_array()) {
            for child in children {
                walk(child, texts);
            }
        }
    }
    walk(&doc, &mut texts);
    texts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_segment_chinese() {
        let result = segment("用户登录功能需要支持手机号验证码");
        assert!(result.contains("用户"));
        assert!(result.contains("登录"));
        assert!(result.contains("功能"));
    }

    #[test]
    fn test_segment_dangjian() {
        let result = segment("党建");
        eprintln!("[test] segment('党建') = {:?}", result);
        // 党建是一个常见词，jieba 应该识别为单个词
        assert_eq!(result, "党建");
    }

    #[test]
    fn test_segment_dangjian_report() {
        let result = segment("党建工作报告");
        eprintln!("[test] segment('党建工作报告') = {:?}", result);
        assert!(result.contains("党建"));
        assert!(result.contains("工作"));
        assert!(result.contains("报告"));
    }

    #[test]
    fn test_extract_plain_text() {
        let json = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hello 世界"}]}]}"#;
        let text = extract_plain_text(json);
        assert_eq!(text, "Hello 世界");
    }

    #[test]
    fn test_extract_nested_content() {
        let json = r#"{"type":"doc","content":[{"type":"heading","content":[{"type":"text","text":"标题"}],"attrs":{"level":1}},{"type":"paragraph","content":[{"type":"text","text":"正文内容"}]}]}"#;
        let text = extract_plain_text(json);
        assert_eq!(text, "标题 正文内容");
    }

    #[test]
    fn test_extract_plain_text_falls_back() {
        let plain = "纯文本内容";
        let text = extract_plain_text(plain);
        assert_eq!(text, "纯文本内容");
    }

    // ── FTS5 中文集成测试 ──
    // 验证 FTS5 unicode61 tokenizer 对 jieba 分词结果的处理

    #[tokio::test]
    async fn test_fts5_chinese_search_basic() {
        use sqlx::sqlite::SqlitePoolOptions;

        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("创建内存 DB 失败");

        // 创建 FTS5 表（与 init_db 一致）
        sqlx::query(
            "CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
                doc_id UNINDEXED,
                title,
                content,
                tokenize='unicode61'
            )"
        ).execute(&pool).await.expect("创建 FTS 表失败");

        // 模拟真实数据：文档标题 + jieba 分词后的内容
        let title = "党建工作报告";
        let segmented = segment("党建工作是党的建设的重要组成部分，企业党建工作报告需要全面总结年度党建工作成效。");
        eprintln!("[FTS5 TEST] jieba segmented: {:?}", segmented);

        sqlx::query("INSERT INTO doc_fts(doc_id, title, content) VALUES(?1, ?2, ?3)")
            .bind("doc_001").bind(title).bind(&segmented)
            .execute(&pool).await.expect("插入失败");

        // 测试1：用 jieba 分词后的查询"党建" 搜索
        let query1 = segment("党建");
        eprintln!("[FTS5 TEST] query1 (segmented '党建'): {:?}", query1);
        let count1: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM doc_fts WHERE doc_fts MATCH ?1"
        )
        .bind(&query1)
        .fetch_one(&pool).await.expect("查询失败");
        eprintln!("[FTS5 TEST] MATCH '{}' → {} 条", query1, count1);
        assert!(count1 > 0, "FTS5 MATCH with jieba-segmented '党建' failed");

        // 测试2：直接用"党建"原文搜索（不经过 jieba）
        let query2 = "党建";
        let count2: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM doc_fts WHERE doc_fts MATCH ?1"
        )
        .bind(query2)
        .fetch_one(&pool).await.expect("查询失败");
        eprintln!("[FTS5 TEST] MATCH '{}' (raw) → {} 条", query2, count2);
        // 不强制 assert，只是记录行为

        // 测试3：搜索"党的建设"
        let query3 = segment("党的建设");
        eprintln!("[FTS5 TEST] query3 (segmented '党的建设'): {:?}", query3);
        let count3: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM doc_fts WHERE doc_fts MATCH ?1"
        )
        .bind(&query3)
        .fetch_one(&pool).await.expect("查询失败");
        eprintln!("[FTS5 TEST] MATCH '{}' → {} 条", query3, count3);
        assert!(count3 > 0, "FTS5 MATCH with jieba-segmented '党的建设' failed");

        // 测试4：用 snippet 函数查看高亮结果
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT title, snippet(doc_fts, 2, '<mark>', '</mark>', '...', 40) AS snippet
             FROM doc_fts WHERE doc_fts MATCH ?1"
        )
        .bind(&query1)
        .fetch_all(&pool).await.expect("snippet 查询失败");
        eprintln!("[FTS5 TEST] snippet results for '{}': {} rows", query1, rows.len());
        for (t, s) in &rows {
            eprintln!("[FTS5 TEST]   title: {}, snippet: {}", t, s);
        }
    }

    #[tokio::test]
    async fn test_fts5_multiple_docs() {
        use sqlx::sqlite::SqlitePoolOptions;

        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("创建内存 DB 失败");

        sqlx::query(
            "CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
                doc_id UNINDEXED, title, content, tokenize='unicode61'
            )"
        ).execute(&pool).await.expect("创建 FTS 表失败");

        let docs = vec![
            ("doc_001", "党建工作报告", "党建 工作 是 企业 发展 的 根本 保证"),
            ("doc_002", "安全生产总结", "安全生产 是 企业 的 生命线"),
            ("doc_003", "年度账务报告", "本 年度 公司 财务 状况 良好"),
        ];

        for (id, title, content) in &docs {
            sqlx::query("INSERT INTO doc_fts(doc_id, title, content) VALUES(?1, ?2, ?3)")
                .bind(id).bind(title).bind(content)
                .execute(&pool).await.expect("插入失败");
        }

        let query = "党建";
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_fts WHERE doc_fts MATCH ?1")
            .bind(query).fetch_one(&pool).await.expect("查询失败");
        eprintln!("[FTS5 MULTI] MATCH '{}' → {} 条", query, count);
        assert!(count >= 1);

        let query2 = "安全生产";
        let count2: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_fts WHERE doc_fts MATCH ?1")
            .bind(query2).fetch_one(&pool).await.expect("查询失败");
        assert!(count2 >= 1);

        let query3 = "天气预报";
        let count3: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_fts WHERE doc_fts MATCH ?1")
            .bind(query3).fetch_one(&pool).await.expect("查询失败");
        assert_eq!(count3, 0);

        // delete-all 测试
        let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_fts").fetch_one(&pool).await.unwrap();
        eprintln!("[FTS5 REBUILD] 清空前: {} 条", before);
        assert_eq!(before, 3);

        let _ = sqlx::query("DELETE FROM doc_fts WHERE rowid >= 0").execute(&pool).await;
        sqlx::query("INSERT INTO doc_fts(doc_id, title, content) VALUES(?1, ?2, ?3)")
            .bind("new_001").bind("测试标题").bind("党的建设 是 根本")
            .execute(&pool).await.expect("重新插入失败");
        let after_reinsert: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM doc_fts WHERE doc_fts MATCH ?1")
            .bind("党的建设").fetch_one(&pool).await.unwrap();
        eprintln!("[FTS5 REBUILD] rebuild 后搜索 → {} 条", after_reinsert);
        assert_eq!(after_reinsert, 1);
    }

    // ── 模拟真实 search_materials_fts 查询 ──
    #[tokio::test]
    async fn test_fts5_real_material_query() {
        use sqlx::sqlite::SqlitePoolOptions;

        let pool = SqlitePoolOptions::new().connect("sqlite::memory:").await.unwrap();

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS materials (
                id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL DEFAULT '',
                source_url TEXT, source_title TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"
        ).execute(&pool).await.unwrap();

        sqlx::query(
            "CREATE VIRTUAL TABLE IF NOT EXISTS material_fts USING fts5(
                material_id UNINDEXED, title, content,
                source_title, source_url UNINDEXED,
                tokenize='unicode61'
            )"
        ).execute(&pool).await.unwrap();

        sqlx::query("INSERT INTO materials (id, title, content, source_title, source_url) VALUES (?1,?2,?3,?4,?5)")
            .bind("mat_001").bind("党建报告").bind(segment("党建工作报告内容")).bind("百度").bind("https://baidu.com")
            .execute(&pool).await.unwrap();

        sqlx::query("INSERT INTO material_fts(material_id, title, content, source_title, source_url) VALUES(?1,?2,?3,?4,?5)")
            .bind("mat_001").bind("党建报告").bind(&segment("党建工作报告内容")).bind("百度").bind("https://baidu.com")
            .execute(&pool).await.unwrap();

        // 测试1: 逗号连接 + WHERE（当前代码）
        let r1 = sqlx::query_as::<_, (String, String, String, Option<String>, Option<String>, String)>(
            "SELECT m.id AS material_id, m.title,
                    snippet(material_fts, 2, '<mark>', '</mark>', '...', 40) AS snippet,
                    m.source_title, m.source_url, m.updated_at
             FROM materials m, material_fts
             WHERE material_fts MATCH ?1 AND material_fts.material_id = m.id
             ORDER BY rank LIMIT 50"
        ).bind("党建").fetch_all(&pool).await;
        eprintln!("[FTS5 QUERY] 逗号连接: {:?}", r1.as_ref().map(|r| r.len()));

        // 测试2: 显式 JOIN（原始代码）
        let r2 = sqlx::query_as::<_, (String, String, String, Option<String>, Option<String>, String)>(
            "SELECT m.id AS material_id, m.title,
                    snippet(material_fts, 2, '<mark>', '</mark>', '...', 40) AS snippet,
                    m.source_title, m.source_url, m.updated_at
             FROM material_fts
             JOIN materials m ON m.id = material_fts.material_id
             WHERE material_fts MATCH ?1
             ORDER BY rank LIMIT 50"
        ).bind("党建").fetch_all(&pool).await;
        eprintln!("[FTS5 QUERY] 显式JOIN: {:?}", r2.as_ref().map(|r| r.len()));

        // 测试3: 只用 FTS（不 JOIN）
        let r3 = sqlx::query("SELECT material_id FROM material_fts WHERE material_fts MATCH ?1")
            .bind("党建").fetch_all(&pool).await;
        eprintln!("[FTS5 QUERY] 仅FTS: {:?}", r3.as_ref().map(|r| r.len()));
    }
}
