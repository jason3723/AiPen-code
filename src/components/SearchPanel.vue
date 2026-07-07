<script setup lang="ts">
import { ref, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";

export interface SearchResultItem {
  id: string;
  title: string;
  snippet: string;
  source_type: "document" | "material";
  folder_id?: string;
  source_title?: string;
  source_url?: string;
  updated_at: string;
}

const emit = defineEmits<{
  navigateToDocument: [docId: string, query: string];
  navigateToMaterial: [matId: string, query: string];
}>();

// ── 状态 ──
const query = ref("");
const loading = ref(false);
const results = ref<SearchResultItem[]>([]);
const history = ref<string[]>([]);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedSearch() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => doSearch(), 300);
}

// ── 搜索 ──
async function doSearch() {
  const q = query.value.trim();
  if (!q) {
    results.value = [];
    return;
  }
  if (q.length < 2) return; // 至少 2 个字符

  loading.value = true;
  try {
    const [docResults, matResults] = await Promise.all([
      invoke<SearchResultItem[]>("search_documents", { query: q }),
      invoke<SearchResultItem[]>("search_materials", { query: q }),
    ]);
    results.value = [
      ...docResults.map((r) => ({ ...r, source_type: "document" as const })),
      ...matResults.map((r) => ({ ...r, source_type: "material" as const })),
    ];
    addHistory(q);
  } catch (e) {
    console.error("[SearchPanel] 搜索失败:", e);
    results.value = [];
  } finally {
    loading.value = false;
  }
}

// ── 点击结果 → 导航 ──
function clickResult(result: SearchResultItem) {
  if (result.source_type === "document") {
    emit("navigateToDocument", result.id, query.value);
  } else {
    emit("navigateToMaterial", result.id, query.value);
  }
}

// ── 搜索历史（localStorage） ──
const HISTORY_KEY = "aipen_search_history";
const MAX_HISTORY = 20;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function addHistory(q: string) {
  const h = loadHistory().filter((item) => item !== q);
  h.unshift(q);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, MAX_HISTORY)));
  history.value = h.slice(0, MAX_HISTORY);
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
  history.value = [];
}

function searchFromHistory(h: string) {
  query.value = h;
  doSearch();
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  } catch {
    return dateStr.slice(0, 10);
  }
}

/** 高亮标题中匹配的关键词 */
function highlightTitle(title: string, q: string): string {
  if (!q || !title) return title || "未命名";
  // 转义 HTML 特殊字符
  const escaped = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // 对 query 做正则转义后全局替换
  const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped.replace(new RegExp(escapedQ, "gi"), '<mark>$&</mark>');
}

// ── 初始化 ──
onMounted(() => {
  history.value = loadHistory();
});
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <!-- 搜索输入框 -->
    <div class="p-2 border-b border-gray-200 dark:border-gray-700">
      <div class="relative">
        <svg
          class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 dark:text-gray-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          ref="searchInputRef"
          v-model="query"
          @input="debouncedSearch"
          @keydown.enter="doSearch"
          @keydown.ctrl.enter="doSearch"
          autofocus
          placeholder="搜索文档、素材..."
          class="w-full pl-8 pr-3 py-1.5 text-xs rounded-md border border-gray-200 dark:border-gray-600
                 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200
                 placeholder-gray-400 dark:placeholder-gray-500
                 focus:outline-none focus:ring-1 focus:ring-blue-400 dark:focus:ring-blue-500 focus:border-blue-400"
        />
        <!-- 加载指示器 -->
        <svg
          v-if="loading"
          class="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin text-blue-400"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    </div>

    <!-- 搜索历史 -->
    <div v-if="!query && history.length > 0" class="px-2 py-1.5">
      <div class="flex justify-between items-center mb-1 px-1">
        <span class="text-[10px] text-gray-400 dark:text-gray-500">最近搜索</span>
        <button
          @click="clearHistory"
          class="text-[10px] text-gray-400 dark:text-gray-500 hover:text-red-400 transition-colors"
        >
          清空
        </button>
      </div>
      <div
        v-for="h in history"
        :key="h"
        @click="searchFromHistory(h)"
        class="text-[11px] px-2 py-1 cursor-pointer rounded text-gray-600 dark:text-gray-300
               hover:bg-gray-100 dark:hover:bg-gray-700/50 truncate transition-colors"
      >
        {{ h }}
      </div>
    </div>

    <!-- 搜索结果列表 -->
    <div class="flex-1 overflow-y-auto px-2 py-1">
      <!-- 提示：输入至少 2 字符 -->
      <div v-if="query && query.trim().length < 2" class="text-center text-[11px] text-gray-400 dark:text-gray-500 mt-6">
        请输入至少 2 个字符
      </div>

      <!-- 搜索结果 -->
      <template v-if="results.length > 0">
        <div
          v-for="r in results"
          :key="r.source_type + '-' + r.id"
          @click="clickResult(r)"
          class="cursor-pointer rounded-md p-2 mb-1 transition-colors
                 hover:bg-gray-50 dark:hover:bg-gray-800/60 border border-transparent
                 hover:border-gray-200 dark:hover:border-gray-700"
        >
          <div class="flex items-center gap-1.5">
            <span
              class="text-[9px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0"
              :class="
                r.source_type === 'document'
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                  : 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
              "
            >
              {{ r.source_type === "document" ? "文档" : "素材" }}
            </span>
            <span class="text-[11px] font-medium text-gray-800 dark:text-gray-200 truncate block"
              v-html="highlightTitle(r.title, query)" />
          </div>
          <!-- snippet 含 <mark> 标签，v-html 渲染高亮 -->
          <div
            v-if="r.snippet"
            class="text-[11px] text-gray-500 dark:text-gray-400 mt-1 line-clamp-2 leading-relaxed"
            v-html="r.snippet"
          />
          <div class="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">
            {{ formatDate(r.updated_at) }}
          </div>
        </div>
      </template>

      <!-- 空结果 -->
      <div
        v-if="query && query.trim().length >= 2 && !loading && results.length === 0"
        class="text-center text-[11px] text-gray-400 dark:text-gray-500 mt-8"
      >
        无匹配结果
      </div>
    </div>
  </div>
</template>

<style scoped>
/* snippet 中 <mark> 标签的全局样式由 global.css 统一定义 */
/* 此处确保 lcp (line-clamp) 正常截断 */
.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
