import { defineStore } from "pinia";
import { ref, computed, watch, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { textToDocJson } from "../utils/textToDocJson";
import { markdownToDocJson } from "../utils/markdownToDocJson";
import { useExportSettingsStore } from "./exportSettings";
import type { Comment } from "../types/comment";
import pkg from "../../package.json";

// ── 教程文档常量 ──
export const TUTORIAL_TITLE = "📖 AiPen 使用手册";
const LS_VERSION_KEY = "aipen_last_version";


// ─── 类型定义 ────────────────────────────────────────────────

export interface Document {
  id: string;
  title: string;
  project_id: string;
  folder_name?: string;
  export_settings: string;
  created_at: string;
  updated_at: string;
}

export interface Folder {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
}

export interface Version {
  id: string;
  doc_id: string;
  version_num: number;
  commit_msg: string;
  content: string;
  parent_id: string | null;
  created_at: string;
}

export interface InlineChange {
  tag: "equal" | "insert" | "delete";
  content: string;
}

export interface DiffHunk {
  tag: "equal" | "insert" | "delete";
  content: string;
  inline_changes?: InlineChange[];
}

export interface DiffResult {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export interface OverallAssessment {
  verdict: string;
  summary: string;
  score_old: string;
  score_new: string;
  delta: string;
}

export interface IdeologicalAnalysis {
  elevation: string;
  positioning: string;
  depth: string;
  risk: string;
}

export interface LogicAnalysis {
  strengths: string[];
  weaknesses: string[];
}

export interface InsightAnalysis {
  added_value: string[];
  hollow_parts: string[];
}

export interface ExpressionAnalysis {
  highlights: string[];
  issues: string[];
}

export interface ModificationBreakdown {
  type: string;
  example: string;
  reason: string;
}

export interface RevisionSuggestion {
  target: string;
  advice: string;
  rationale: string;
  priority: string;
  category: string;
}

export interface DimensionScore {
  name: string;
  score: number;
  comment: string;
}

export interface DocumentScore {
  total_score: number;
  encouragement: string;
  dimensions: DimensionScore[];
  top_suggestion: string;
}

export interface AIAnalysis {
  overall_assessment: OverallAssessment;
  ideological_analysis: IdeologicalAnalysis;
  logic_analysis: LogicAnalysis;
  insight_analysis: InsightAnalysis;
  expression_analysis: ExpressionAnalysis;
  modification_breakdown: ModificationBreakdown[];
  comparison: string[];
  revision_suggestions: RevisionSuggestion[];
}

export interface AIConfig {
  api_key: string;
  api_url: string;
  model: string;
  thinking_enabled: boolean;
  reasoning_effort: string;  // "high" | "max"
}

// ─── 工具函数 ────────────────────────────────────────────────

/** 解析结果：ProseMirror doc 节点（可能含 comments 顶层字段）+ 抽出的批注数组 */
export interface ParseResult {
  doc: any;
  comments: Comment[];
}

/** 孤儿扫描结果：orphanIds + ghostIds */
export interface SweepResult {
  orphanIds: string[];
  ghostIds: string[];
}

/**
 * 从 DB 加载 ProseMirror JSON 内容（兼容旧 markdown 格式自动转换）。
 *
 * 批注存在 doc 节点顶层 `comments` 字段中（持久化格式）。
 * 本函数把 doc 与 comments 一同解析，comments 数组同时返回供 store 顶层使用。
 *
 * 兼容：
 *   - 旧 markdown 格式 → 转 doc（无批注）
 *   - 老版本 doc JSON 无 comments 字段 → comments = []
 *   - comments 字段为非数组 → 视为空（容错）
 */
function parseContent(raw: string | null | undefined): ParseResult {
  const empty: ParseResult = { doc: { type: "doc", content: [] }, comments: [] };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.type === 'doc') {
      const rawComments = parsed.comments;
      const comments: Comment[] = Array.isArray(rawComments) ? rawComments : [];
      // 抽出 comments 字段，避免 doc 节点误把它当 ProseMirror 属性
      const { comments: _ignored, ...rest } = parsed;
      return { doc: rest, comments };
    }
  } catch {
    // JSON 解析失败，说明是旧 markdown 格式
  }
  // 非 ProseMirror JSON → 按 markdown 规则转换为 doc（无批注）
  console.warn("[parseContent] 非 ProseMirror JSON 格式，自动转换为 doc:", raw.slice(0, 80));
  return { doc: textToDocJson(raw), comments: [] };
}

/**
 * 序列化内容用于存储：ProseMirror JSON 对象 + 批注数组 → JSON 字符串
 *
 * 批注作为 doc 顶层字段写入（docSchemaVersion 用于未来扩展兼容）。
 * 传 null/undefined 视为空 doc。
 */
function serializeContent(content: any, comments: Comment[] = []): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content; // 向后兼容（不应出现）
  return JSON.stringify({
    ...content,
    comments: comments ?? [],
    docSchemaVersion: 1,
  });
}

/** 简易 UUID v4 生成（替代 crypto.randomUUID 以兼容旧环境） */
function genUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // 降级：手搓一个 v4 形态
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function formatTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// ─── Store ───────────────────────────────────────────────────

export const useDocumentStore = defineStore("document", () => {
  // ── 文档列表状态 ──
  const documents = ref<Document[]>([]);
  const currentDocId = ref("");
  const currentTitle = ref("新文档");
  /** 当前文档内容（ProseMirror JSON 文档模型——编辑器原生格式） */
  const currentContent = ref<any>({ type: "doc", content: [] });
  const draftLoaded = ref(false); // 标记草稿是否已从数据库恢复

  // ── 批注状态 ──
  // 单一真相源是 currentContent 顶层 comments 字段（与正文同生共死）；
  // 此 ref 仅作为「派生视图」，方便组件读取/操作。W1 仅做骨架，W2 再加 UI。
  const comments = ref<Comment[]>([]);
  const hoveredCommentId = ref<string>(""); // hover 浮层用，W3 实现
  const editingCommentId = ref<string>(""); // 文末列表内联编辑，W2 实现

  /** 是否为教程文档 */
  const isTutorialDoc = computed(() => currentTitle.value === TUTORIAL_TITLE);

  /** 教程 ProseMirror JSON 缓存（懒加载，仅首次启动时转换一次） */
  let _tutorialJson: any = null;
  /** 教程原文缓存（统一从 Rust 拉取，dev / prod 走不同路径） */
  let _tutorialMd: string = "";
  /**
   * 拉取教程原文 Markdown。
   * 唯一来源：Rust command `get_tutorial_markdown`。
   *   - dev 模式：Rust command 走源码相对路径 `src-tauri/resources/tutorial.md`
   *   - install 后：Rust command 走 Tauri Resource 目录
   * 改教程只需要改 `src-tauri/resources/tutorial.md` 一处。
   */
  async function fetchTutorialMarkdown(): Promise<string> {
    if (_tutorialMd) return _tutorialMd;
    try {
      const md = await invoke<string>("get_tutorial_markdown");
      if (md && md.trim()) {
        _tutorialMd = md;
        console.log("[tutorial] 教程原文已加载，长度", _tutorialMd.length);
        return _tutorialMd;
      }
    } catch (e) {
      console.warn("[tutorial] 拉取教程失败:", e);
    }
    console.error("[tutorial] 教程原文为空，教程将无法创建");
    return "";
  }

  function getTutorialDocJson(): any {
    if (!_tutorialJson) {
      // 防御：确保 markdown 原文非空
      if (!_tutorialMd || !_tutorialMd.trim()) {
        console.error("[tutorial] 教程原文为空，放弃转换");
        _tutorialJson = { type: 'doc', content: [] };
        return _tutorialJson;
      }
      try {
        _tutorialJson = markdownToDocJson(_tutorialMd);
        // 如果解析出空文档，用 textToDocJson 兜底
        if (!_tutorialJson || !_tutorialJson.content || _tutorialJson.content.length === 0) {
          console.warn("[tutorial] TipTap 解析结果为空，使用 textToDocJson 兜底");
          _tutorialJson = textToDocJson(_tutorialMd);
        }
      } catch (e) {
        console.error("[tutorial] markdownToDocJson 解析失败:", e);
        // TipTap 解析失败时，降级使用轻量 Markdown 解析
        _tutorialJson = textToDocJson(_tutorialMd);
      }
    }
    return _tutorialJson;
  }

  /** 判断草稿内容是否健康（非空文档） */
  function isDraftContentHealthy(draft: string | null): boolean {
    if (!draft) return false;
    try {
      const parsed = JSON.parse(draft);
      return parsed && parsed.content && parsed.content.length > 0;
    } catch {
      return false;
    }
  }

  // ── 文件夹状态 ──
  const folders = ref<Folder[]>([]);
  const currentFolderFilter = ref<string>("all"); // "all" | folder_id

  // ── 批注助手 ──
  /**
   * 统一处理 parseContent 结果：把 doc 设到 currentContent，comments 同步到 ref。
   * 所有读 doc 入口（switchDocument / loadVersionContent / rollbackToVersion /
   * exitHistoryView）都应通过本函数设置，避免遗漏 comments 同步。
   */
  function applyParsed(result: ParseResult) {
    currentContent.value = result.doc;
    comments.value = result.comments;
  }

  // ── 计算：筛选后的文档列表 ──
  const filteredDocuments = computed(() => {
    if (currentFolderFilter.value === "all") return documents.value;
    return documents.value.filter(d => d.project_id === currentFolderFilter.value);
  });

  // ── 版本状态 ──
  const versions = ref<Version[]>([]);
  const selectedOldVersionId = ref("");
  const selectedNewVersionId = ref("");
  const viewingVersionId = ref(""); // 正在查看的历史版本 ID

  // ── Diff 状态 ──
  const diffResult = ref<DiffResult | null>(null);

  // ── AI 分析状态 ──
  const analysisResult = ref<AIAnalysis | null>(null);

  // ── 文档评分状态 ──
  const documentScores = ref<Record<string, DocumentScore>>({});
  const scoreLoading = ref(false);
  /** 当前评分上下文 key：draft → doc_{docId}_draft，版本 → {versionId} */
  const scoreContextKey = computed(() => {
    if (!currentDocId.value) return '';
    if (viewingVersionId.value) return viewingVersionId.value;
    return `doc_${currentDocId.value}_draft`;
  });
  const documentScore = computed(() => {
    const key = scoreContextKey.value;
    return key ? (documentScores.value[key] ?? null) : null;
  });

  // ── API 配置 ──
  const apiConfig = ref<AIConfig>({
    api_key: "",
    api_url: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    thinking_enabled: false,
    reasoning_effort: "high",
  });

  // ── UI 状态 ──
  const loading = ref({
    init: false,
    commit: false,
    versions: false,
    diff: false,
    analysis: false,
  });

  const error = ref("");
  const sidebarTab = ref<"docs" | "versions" | "diff" | "analysis" | "chat" | "skills" | "compose" | "knowledge" | "settings">("versions");
  const dataVersion = ref(0); // 数据导入后 +1，触发知识库/技能列表刷新

  // ── AI 对话 & 技能：跨组件通信 ──
  const injectedChatText = ref(""); // 从编辑器右键添加到 AI 对话的文本

  // ── 计算属性 ──
  const hasSelectedVersions = computed(
    () => selectedOldVersionId.value !== "" && selectedNewVersionId.value !== ""
  );

  const canDiff = computed(
    () =>
      selectedOldVersionId.value !== "" &&
      selectedNewVersionId.value !== "" &&
      selectedOldVersionId.value !== selectedNewVersionId.value
  );

  /** 正在查看的历史版本标签 */
  const viewingVersionLabel = computed(() => {
    if (!viewingVersionId.value) return "";
    const v = versions.value.find((v) => v.id === viewingVersionId.value);
    if (!v) return "";
    return v.commit_msg ? `v${v.version_num}: ${v.commit_msg}` : `v${v.version_num}`;
  });

  /** 当前是否在查看历史版本（而非最新草稿） */
  const isViewingHistory = computed(() => viewingVersionId.value !== "");

  // ── 自动保存草稿（防抖 1 秒） ──
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let _suppressDraftSave = false; // 阻止程序化 content 变更触发自动保存

  /** 自动保存状态：idle(无变更) | pending(等待防抖) | saving(写入中) | saved(已保存) | error(失败) */
  const draftSaveStatus = ref<"idle" | "pending" | "saving" | "saved" | "error">("idle");
  /** 最后一次保存成功的时间文本，格式如 "23:10" */
  const lastSaveTime = ref("");

  /** 封装 suppressDraftSave 模式，防止新增函数遗漏标志设置 */
  async function withSuppressDraftSave<T>(fn: () => Promise<T>): Promise<T> {
    _suppressDraftSave = true;
    try {
      return await fn();
    } finally {
      await nextTick();
      _suppressDraftSave = false;
    }
  }

  watch(currentContent, (newVal) => {
    if (!currentDocId.value || !draftLoaded.value) {
      draftSaveStatus.value = "idle";
      return;
    }

    // 程序化加载内容（查看历史、恢复草稿等）时不触发自动保存
    if (_suppressDraftSave) {
      draftSaveStatus.value = "idle";
      return;
    }

    // 查看历史版本时编辑器只读，不应收到用户编辑事件；保险起见不保存
    if (viewingVersionId.value) return;

    // 内容变更 → 进入等待防抖状态
    draftSaveStatus.value = "pending";

    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(async () => {
      draftSaveStatus.value = "saving";
      try {
        await invoke("save_draft", {
          docId: currentDocId.value,
          content: serializeContent(newVal, comments.value),
        });
        draftSaveStatus.value = "saved";
        const now = new Date();
        lastSaveTime.value =
          String(now.getHours()).padStart(2, "0") + ":" +
          String(now.getMinutes()).padStart(2, "0") + ":" +
          String(now.getSeconds()).padStart(2, "0");
      } catch {
        draftSaveStatus.value = "error";
        // 3 秒后从 error 恢复到 idle，避免错误状态顽固不消
        setTimeout(() => {
          if (draftSaveStatus.value === "error") draftSaveStatus.value = "idle";
        }, 3000);
      }
    }, 1000);
  });

  // ── 操作 ──

  /**
   * 安装/升级后确保教程文档存在且内容完整。
   *
   * 行为约定：
   *  1. **版本变更**（升级后第一次启动）：删除旧版教程 → 重建新版教程（无视用户是否曾删除）
   *  2. **版本未变**：
   *     - 教程存在且内容非空 → 跳过
   *     - 教程存在但内容为空 → 删除重建（保底）
   *     - 教程不存在（用户主动删除）→ **不再补建**，尊重用户选择
   */
  async function createTutorialDocument() {
    try {
      const lastVersion = localStorage.getItem(LS_VERSION_KEY);
      const isVersionChanged = lastVersion !== pkg.version;
      let needRecreate = isVersionChanged;

      // 1) 列出当前文档
      const docs = await invoke<Document[]>("list_documents");
      const existing = docs.find((d: Document) => d.title === TUTORIAL_TITLE);

      if (existing) {
        // 教程已存在
        if (!isVersionChanged) {
          // 同版本 → 检查内容
          try {
            const draft = await invoke<string | null>("get_draft", { docId: existing.id });
            // 注意：不能只判断 draft 字符串非空。4.2.0 创建失败时会存下
            // `{"type":"doc","content":[]}` 这样的“空文档”——它是非空字符串，
            // 但内容为空。必须解析出真实 content 长度才能判定内容健康。
            if (isDraftContentHealthy(draft)) {
              console.log("[tutorial] 教程存在且内容正常，跳过重建");
              return;
            }
          } catch { /* get_draft 失败，按"空内容"处理 */ }
          // 内容为空 → 重建
          console.warn("[tutorial] 教程存在但内容为空（空文档 JSON 或解析失败），删除重建");
          needRecreate = true;
        }
        // 走到这里 = 需要重建（版本变更 或 内容空）
        await invoke("delete_document", { docId: existing.id });
        documents.value = documents.value.filter(d => d.id !== existing.id);
        // 同步重置缓存
        _tutorialJson = null;
      } else if (!isVersionChanged) {
        // 教程不存在 + 版本未变 → 用户主动删除过 → 不再补建
        console.log("[tutorial] 教程已被用户删除（非升级场景），尊重选择不再补建");
        return;
      }

      if (!needRecreate) return;

      // 2) 拉取教程原文（双源：前端 ?raw → Rust command）
      const md = await fetchTutorialMarkdown();
      if (!md || !md.trim()) {
        console.error("[tutorial] 教程原文为空，放弃创建（install 资源可能丢失）");
        return;
      }

      // 3) 解析 + 写入
      const tutorialJson = getTutorialDocJson();
      if (!tutorialJson || !tutorialJson.content || tutorialJson.content.length === 0) {
        console.error("[tutorial] 教程内容解析为空，放弃创建");
        return;
      }

      const doc = await invoke<Document>("create_document", {
        title: TUTORIAL_TITLE,
      });
      documents.value.unshift(doc);

      await invoke("save_draft", {
        docId: doc.id,
        content: JSON.stringify(tutorialJson),
      });

      // 验证持久化
      const savedDraft = await invoke<string | null>("get_draft", { docId: doc.id });
      if (!savedDraft) {
        console.error("[tutorial] save_draft 验证失败——尝试 textToDocJson 兜底重建");
        const fallbackJson = textToDocJson(md);
        if (fallbackJson && fallbackJson.content && fallbackJson.content.length > 0) {
          await invoke("save_draft", {
            docId: doc.id,
            content: JSON.stringify(fallbackJson),
          });
          const recheck = await invoke<string | null>("get_draft", { docId: doc.id });
          if (recheck) {
            console.log(`[tutorial] 兜底保存成功，${fallbackJson.content.length} 个块级节点`);
          } else {
            console.error("[tutorial] 兜底 save_draft 仍然验证失败");
          }
        }
      }

      console.log(`[tutorial] 教程文档已创建，${tutorialJson.content.length} 个块级节点`);
      // 4) 更新 localStorage 版本号（必须在所有路径都执行一次）
      localStorage.setItem(LS_VERSION_KEY, pkg.version);
    } catch (err) {
      console.error("[tutorial] 创建教程文档失败:", err);
    }
  }

  /** 初始化：列出已有文档或创建新文档 */
  async function initDocument() {
    loading.value.init = true;
    error.value = "";
    try {
      await loadApiConfig();
      await loadFolders();
      const docs = await invoke<Document[]>("list_documents");

      if (docs.length > 0) {
        documents.value = docs;
        // 新版本首次启动时静默插入教程文档
        await createTutorialDocument();
        // 始终加载用户原本的最新文档（使用 documents.value 而非 docs，
        // 因为 createTutorialDocument 可能已修改了列表）
        await switchDocument(documents.value[0].id);
      } else {
        // 首次启动：先创建教程文档并加载渲染，再创建空白文档
        await createTutorialDocument();
        // 确保教程文档内容已加载到编辑器
        if (documents.value.length > 0) {
          await switchDocument(documents.value[0].id);
        }
        await createNewDocument();
      }
    } catch (err) {
      error.value = String(err);
    } finally {
      loading.value.init = false;
    }
  }

  /** 仅刷新文档列表，不切换文档 */
  async function reloadDocuments() {
    try {
      await loadFolders();
      const docs = await invoke<Document[]>("list_documents");
      documents.value = docs;
    } catch (err) {
      console.error("刷新文档列表失败:", err);
    }
  }

  // ── 文件夹操作 ──

  /** 加载文件夹列表 */
  async function loadFolders() {
    try {
      folders.value = await invoke<Folder[]>("list_folders");
    } catch (err) {
      console.error("加载文件夹列表失败:", err);
    }
  }

  /** 创建文件夹 */
  async function createFolder(name: string): Promise<Folder> {
    const folder = await invoke<Folder>("create_folder", { name });
    folders.value.push(folder);
    folders.value.sort((a, b) => a.sort_order - b.sort_order);
    return folder;
  }

  /** 重命名文件夹 */
  async function renameFolder(folderId: string, newName: string) {
    await invoke("rename_folder", { folderId, newName });
    const f = folders.value.find(f => f.id === folderId);
    if (f) f.name = newName;
  }

  /** 删除文件夹 */
  async function deleteFolder(folderId: string) {
    await invoke("delete_folder", { folderId });
    folders.value = folders.value.filter(f => f.id !== folderId);
    // 如果当前正在筛选该文件夹，切回"全部"
    if (currentFolderFilter.value === folderId) {
      currentFolderFilter.value = "all";
    }
    // 刷新文档列表（文档 project_id 已在后端重置）
    await reloadDocuments();
  }

  /** 移动文档到文件夹 */
  async function moveDocument(docId: string, folderId: string) {
    await invoke("move_document", { docId, folderId });
    await reloadDocuments();
    await loadFolders();
  }

  /** 将文档移出文件夹（未分类） */
  async function removeDocumentFromFolder(docId: string) {
    await invoke("remove_document_from_folder", { docId });
    await reloadDocuments();
    await loadFolders();
  }

  /** 切换文件夹筛选 */
  function setFolderFilter(folderId: string) {
    currentFolderFilter.value = folderId;
  }

  /** 创建新文档 */
  async function createNewDocument(title?: string) {
    loading.value.init = true;
    error.value = "";
    try {
      const doc = await invoke<Document>("create_document", {
        title: title || "新文档",
      });
      documents.value.unshift(doc);
      await switchDocument(doc.id);
    } catch (err) {
      error.value = String(err);
    } finally {
      loading.value.init = false;
    }
  }

  /** 切换到指定文档 */
  async function switchDocument(docId: string) {
    error.value = "";
    draftLoaded.value = false;
    viewingVersionId.value = ""; // 切换文档时退出历史版本查看
    // 清理上一个文档的自动保存定时器，防止向旧 docId 写入
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
    try {
      const doc = await invoke<Document>("get_document", { docId });
      currentDocId.value = doc.id;
      currentTitle.value = doc.title;

      // 加载该文档的排版设置（per-document）
      const exportSettingsStore = useExportSettingsStore();
      await exportSettingsStore.loadForDocument(docId);

      // 先尝试恢复草稿内容
      const draft = await invoke<string | null>("get_draft", { docId });
      if (draft) {
        applyParsed(parseContent(draft));
      } else {
        // 没有草稿，获取最新版本内容
        const list = await invoke<Version[]>("get_versions", { docId });
        applyParsed(parseContent(list.length > 0 ? list[list.length - 1].content : null));
      }

      await loadVersions();
      loadDocumentScore(); // 异步加载评分，不阻塞
      sidebarTab.value = "versions";
      draftLoaded.value = true;
    } catch (err) {
      error.value = String(err);
    }
  }

  /** 重命名文档（docId 可选，默认当前文档） */
  async function renameDocument(newTitle: string, docId?: string) {
    const targetId = docId || currentDocId.value;
    if (!targetId || !newTitle.trim()) return;
    try {
      await invoke("update_document_title", {
        docId: targetId,
        title: newTitle.trim(),
      });
      // 如果是当前文档，更新标题显示
      if (targetId === currentDocId.value) {
        currentTitle.value = newTitle.trim();
      }
      // 更新列表中的标题
      const doc = documents.value.find((d) => d.id === targetId);
      if (doc) doc.title = newTitle.trim();
    } catch (err) {
      error.value = String(err);
    }
  }

  /** 删除文档 */
  async function deleteDocument(docId: string) {
    if (!docId) return;
    try {
      await invoke("delete_document", { docId });
      // 从列表中移除
      documents.value = documents.value.filter((d) => d.id !== docId);
      // 如果删除的是当前文档，切换到其他文档
      if (currentDocId.value === docId) {
        if (documents.value.length > 0) {
          await switchDocument(documents.value[0].id);
        } else {
          await createNewDocument();
        }
      }
    } catch (err) {
      error.value = String(err);
    }
  }

  /** 提交新版本（commit_msg 可选，默认时间命名） */
  async function commitVersion(commitMsg?: string) {
    if (!currentDocId.value) return;
    loading.value.commit = true;
    error.value = "";
    try {
      const msg = commitMsg?.trim() || formatTimestamp();
      await invoke<Version>("commit_version", {
        docId: currentDocId.value,
        content: serializeContent(currentContent.value, comments.value),
        commitMsg: msg,
      });
      // 提交后清除草稿（内容已保存为版本）
      await invoke("save_draft", {
        docId: currentDocId.value,
        content: "",
      }).catch(() => {});
      await loadVersions();
    } catch (err) {
      error.value = String(err);
    } finally {
      loading.value.commit = false;
    }
  }

  /** 加载版本列表 */
  async function loadVersions() {
    if (!currentDocId.value) return;
    try {
      versions.value = await invoke<Version[]>("get_versions", {
        docId: currentDocId.value,
      });
    } catch (err) {
      error.value = String(err);
    } finally {
      loading.value.versions = false;
    }
  }

  async function loadVersionContent(versionId: string) {
    await withSuppressDraftSave(async () => {
      const version = await invoke<Version>("get_version", { versionId });
      // 防止快速切换文档导致版本内容错配到非所属文档
      if (version.doc_id !== currentDocId.value) return;
      applyParsed(parseContent(version.content));
      viewingVersionId.value = versionId;
      loadDocumentScore();
    }).catch((err) => { error.value = String(err); });
  }

  /** 重命名版本 */
  async function renameVersion(versionId: string, newMsg: string) {
    error.value = "";
    try {
      await invoke("rename_version", { versionId, commitMsg: newMsg });
      await loadVersions();
      // 更新 viewingVersionLabel（如果正在查看该版本）
    } catch (err) {
      error.value = String(err);
    }
  }

  /** 删除版本 */
  async function deleteVersion(versionId: string) {
    error.value = "";
    try {
      await invoke("delete_version", { versionId });
      if (selectedOldVersionId.value === versionId) selectedOldVersionId.value = "";
      if (selectedNewVersionId.value === versionId) selectedNewVersionId.value = "";
      if (viewingVersionId.value === versionId) viewingVersionId.value = "";
      await loadVersions();
    } catch (err) {
      error.value = String(err);
    }
  }

  /** 退出历史版本查看，恢复最新草稿到编辑器 */
  async function exitHistoryView() {
    await withSuppressDraftSave(async () => {
      const draft = await invoke<string | null>("get_draft", {
        docId: currentDocId.value,
      });
      if (draft) {
        applyParsed(parseContent(draft));
      } else {
        // 没有草稿时回退到最新版本内容
        const vs = await invoke<Version[]>("get_versions", {
          docId: currentDocId.value,
        });
        if (vs.length > 0) {
          applyParsed(parseContent(vs[vs.length - 1].content));
        } else {
          currentContent.value = { type: "doc", content: [] };
          comments.value = [];
        }
      }
      viewingVersionId.value = "";
      loadDocumentScore();
    }).catch((err) => { error.value = String(err); });
  }

  /** 回滚：将指定历史版本内容恢复为当前草稿 */
  async function rollbackToVersion(versionId: string) {
    error.value = "";
    await withSuppressDraftSave(async () => {
      const version = await invoke<Version>("get_version", { versionId });
      const parsed = parseContent(version.content);
      applyParsed(parsed);
      viewingVersionId.value = "";
      // 立即保存为草稿（保证后续编辑基于此版本）
      await invoke("save_draft", {
        docId: currentDocId.value,
        content: serializeContent(parsed.doc, parsed.comments),
      });
    }).catch((err) => { error.value = String(err); });
  }

  // ── 批注操作（W1 骨架，W2 接 mark + UI） ────────────────────

  /** 下一个 order 号（基于现有最大 order + 1；删除不回收） */
  const nextCommentOrder = computed(() => {
    if (comments.value.length === 0) return 1;
    return Math.max(...comments.value.map((c) => c.order)) + 1;
  });

  /**
   * 新建一条批注（W1 仅写 comments 数组；W2 再把 mark 加到 ProseMirror 选区）。
   * 重复插入同一条（按 text + 极近时间容错）暂不处理，留给 W2 合并。
   */
  function addComment(text: string): Comment {
    const now = new Date().toISOString();
    const c: Comment = {
      id: genUuid(),
      order: nextCommentOrder.value,
      text,
      createdAt: now,
      updatedAt: now,
      author: "我",
      orphan: false,
    };
    comments.value = [...comments.value, c];
    return c;
  }

  /** 更新批注文本（仅限前 500 字） */
  function updateCommentText(id: string, text: string) {
    const trimmed = text.slice(0, 500);
    const now = new Date().toISOString();
    comments.value = comments.value.map((c) =>
      c.id === id ? { ...c, text: trimmed, updatedAt: now } : c,
    );
  }

  /** 删除一条批注（W1 仅从数组移除；W2 再移除对应 mark） */
  function deleteComment(id: string) {
    comments.value = comments.value.filter((c) => c.id !== id);
  }

  /**
   * 扫描 doc 中实际存在的 comment mark id 集合。
   * W2 改用 ProseMirror doc.descendants；W1 先用基于 JSON 的遍历（兼容）。
   */
  function collectLiveCommentIds(): Set<string> {
    const ids = new Set<string>();
    const walk = (node: any) => {
      if (!node) return;
      if (Array.isArray(node.marks)) {
        for (const m of node.marks) {
          if (m && m.type === "comment" && m.attrs?.commentId) {
            ids.add(m.attrs.commentId);
          }
        }
      }
      if (Array.isArray(node.content)) node.content.forEach(walk);
    };
    walk(currentContent.value);
    return ids;
  }

  /**
   * 孤儿扫描：把 mark 范围已消失的 comment 标 orphan，并把 mark 引用了
   * 不在 comments 中的"幽灵 mark"上报（由 RichEditor 清理）。
   * 应在 doc 变化后由调用方触发（nextTick）。
   */
  function sweepOrphans(): SweepResult {
    const live = collectLiveCommentIds();
    const orphanIds: string[] = [];
    let commentsChanged = false;
    comments.value = comments.value.map((c) => {
      if (!c.orphan && !live.has(c.id)) {
        orphanIds.push(c.id);
        commentsChanged = true;
        return { ...c, orphan: true };
      }
      return c;
    });
    // 幽灵 mark：doc 引用了、comments 没有（删除批注后未及时清 mark 的情况）
    const commentIdSet = new Set(comments.value.map((c) => c.id));
    const ghostIds: string[] = [];
    for (const id of live) {
      if (!commentIdSet.has(id)) ghostIds.push(id);
    }
    void commentsChanged; // 由 Vue 自动追踪
    return { orphanIds, ghostIds };
  }

  /** 获取 Diff 对比结果 */
  async function compareVersions() {
    if (!canDiff.value) {
      error.value = "请选择两个不同的版本进行对比";
      return;
    }
    loading.value.diff = true;
    error.value = "";
    diffResult.value = null;
    try {
      diffResult.value = await invoke<DiffResult>("get_diff", {
        oldVersionId: selectedOldVersionId.value,
        newVersionId: selectedNewVersionId.value,
      });
    } catch (err) {
      error.value = String(err);
    } finally {
      loading.value.diff = false;
    }
  }

  /** AI 分析版本修订 */
  async function analyzeRevision() {
    if (!canDiff.value) {
      error.value = "请先选择两个版本进行对比";
      return;
    }
    loading.value.analysis = true;
    error.value = "";
    analysisResult.value = null;
    try {
      analysisResult.value = await invoke<AIAnalysis>("analyze_revision", {
        oldVersionId: selectedOldVersionId.value,
        newVersionId: selectedNewVersionId.value,
        temperature: 0.3,
      });
    } catch (err) {
      error.value = String(err);
    } finally {
      loading.value.analysis = false;
    }
  }

  /** 加载已有分析结果 */
  async function loadExistingAnalysis(versionId: string) {
    try {
      const result = await invoke<AIAnalysis | null>("get_analysis", {
        versionId,
      });
      if (result) {
        analysisResult.value = result;
      }
    } catch {
      // 没有缓存结果，忽略
    }
  }

  /** 加载 API 配置 */
  async function loadApiConfig() {
    try {
      const cfg = await invoke<AIConfig>("get_api_config");
      apiConfig.value = cfg;
    } catch {
      // 使用默认值
    }
  }

  /** 保存 API 配置 */
  async function saveApiConfig(config: AIConfig) {
    error.value = "";
    try {
      await invoke("set_api_config", {
        apiKey: config.api_key,
        apiUrl: config.api_url,
        model: config.model,
        thinkingEnabled: config.thinking_enabled,
        reasoningEffort: config.reasoning_effort,
      });
      apiConfig.value = config;
    } catch (err) {
      error.value = String(err);
    }
  }

  /** 测试 API 连接 */
  async function testApiConnection(): Promise<string> {
    return await invoke<string>("test_api_connection");
  }

  /** 单文档/版本 AI 评分 */
  async function scoreDocument() {
    const content = currentContent.value;
    if (!content || (typeof content === 'object' && (!content.content || content.content.length === 0))) {
      error.value = "文档内容为空，无法评分";
      return;
    }
    const key = scoreContextKey.value;
    if (!key) return;
    scoreLoading.value = true;
    error.value = "";
    try {
      const result = await invoke<DocumentScore>("score_document", {
        contextKey: key,
        content: serializeContent(currentContent.value, comments.value),
        title: currentTitle.value,
      });
      documentScores.value[key] = result;
    } catch (err) {
      error.value = String(err);
    } finally {
      scoreLoading.value = false;
    }
  }

  /** 加载当前文档/版本的已保存评分 */
  async function loadDocumentScore() {
    const key = scoreContextKey.value;
    if (!key) return;
    // 避免重复加载
    if (documentScores.value[key]) return;
    try {
      const cached = await invoke<DocumentScore | null>("get_document_score", {
        contextKey: key,
      });
      if (cached) {
        documentScores.value[key] = cached;
      }
    } catch {
      // 静默忽略
    }
  }

  // 重置状态
  function reset() {
    documents.value = [];
    currentDocId.value = "";
    currentTitle.value = "新文档";
    currentContent.value = { type: "doc", content: [] };
    comments.value = [];
    hoveredCommentId.value = "";
    editingCommentId.value = "";
    versions.value = [];
    selectedOldVersionId.value = "";
    selectedNewVersionId.value = "";
    viewingVersionId.value = "";
    diffResult.value = null;
    analysisResult.value = null;
    error.value = "";
    draftLoaded.value = false;
  }

  return {
    // 状态
    documents,
    currentDocId,
    currentTitle,
    currentContent,
    folders,
    currentFolderFilter,
    filteredDocuments,
    versions,
    selectedOldVersionId,
    selectedNewVersionId,
    viewingVersionId,
    diffResult,
    analysisResult,
    documentScore,
    scoreLoading,
    apiConfig,
    loading,
    error,
    sidebarTab,
    dataVersion,
    draftLoaded,
    draftSaveStatus,
    lastSaveTime,
    injectedChatText,
    // 批注（W1 骨架）
    comments,
    hoveredCommentId,
    editingCommentId,
    nextCommentOrder,
    // 计算
    hasSelectedVersions,
    canDiff,
    viewingVersionLabel,
    isViewingHistory,
    isTutorialDoc,
    // 操作
    initDocument,
    reloadDocuments,
    loadFolders,
    createFolder,
    renameFolder,
    deleteFolder,
    moveDocument,
    removeDocumentFromFolder,
    setFolderFilter,
    createNewDocument,
    switchDocument,
    renameDocument,
    deleteDocument,
    commitVersion,
    loadVersions,
    loadVersionContent,
    renameVersion,
    deleteVersion,
    exitHistoryView,
    rollbackToVersion,
    compareVersions,
    analyzeRevision,
    scoreDocument,
    loadDocumentScore,
    loadExistingAnalysis,
    loadApiConfig,
    saveApiConfig,
    testApiConnection,
    // 批注操作（W1 骨架）
    addComment,
    updateCommentText,
    deleteComment,
    sweepOrphans,
    collectLiveCommentIds,
    reset,
  };
});
