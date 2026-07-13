<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useMaterialStore, type Bookmark } from "../stores/materialStore";
import { materialFontFamily, materialFontSize, MATERIAL_FONT_OPTIONS, MATERIAL_FONT_SIZE_OPTIONS } from "../stores/materialStore";
import { useConfirm } from "../composables/useConfirm";

const props = defineProps<{
  subTab: "materials" | "browser";
  activeMaterialId: string | null;
}>();

const store = useMaterialStore();

// 响应外部导航（如搜索面板点击素材结果）：高亮对应标签组
// 不调用 selectTagDocument（那会替换编辑器内容），只设置高亮 ID
watch(
  () => props.activeMaterialId,
  (newId) => {
    if (!newId) return;
    const group = store.tagDocumentGroups.find(g =>
      g.materials.some(m => m.id === newId)
    );
    if (group) {
      const key = group.tag?.id ?? "__uncategorized__";
      // 直接设 currentTagDocumentId 达到高亮效果，不触发内容替换
      store.currentTagDocumentId = key;
    }
  }
);

const emit = defineEmits<{
  selectMaterial: [materialId: string];
  selectTagDocument: [tagId: string | null];
  update: [action: string, ...args: any[]];
}>();

const { confirm } = useConfirm();

// ── 素材 Tab ──

/** 标签 + 素材数量（含未分类） */
const tagListItems = computed(() => {
  const items: Array<{
    tag: { id: string; name: string } | null;
    materialCount: number;
    isUncategorized: boolean;
  }> = [];

  // 已有标签
  for (const tag of store.tags) {
    const group = store.tagDocumentGroups.find(
      g => g.tag?.id === tag.id
    );
    items.push({
      tag,
      materialCount: group?.materials.length ?? 0,
      isUncategorized: false,
    });
  }

  // 未分类（有素材时才显示）
  const uncategorized = store.tagDocumentGroups.find(g => g.tag === null);
  if (uncategorized && uncategorized.materials.length > 0) {
    items.push({
      tag: null,
      materialCount: uncategorized.materials.length,
      isUncategorized: true,
    });
  }

  return items;
});

function handleTagItemClick(item: (typeof tagListItems.value)[number]) {
  const tagId = item.tag?.id ?? null;
  store.selectTagDocument(tagId);
  emit("selectTagDocument", tagId);
}

// ── 标签管理 ──

async function handleCreateTag() {
  // 生成唯一名称：新标签、新标签 (2)、新标签 (3) ...
  const existingNames = new Set(store.tags.map(t => t.name));
  let name = "新标签";
  let n = 2;
  while (existingNames.has(name)) {
    name = `新标签 (${n})`;
    n++;
  }
  try {
    await store.createTag(name);
  } catch (e) {
    console.error("创建标签失败:", e);
  }
}

// ── 标签原地重命名 ──
const editingTagId = ref<string | null>(null);
const editingTagName = ref("");

function startRenameTag(tag: { id: string; name: string }) {
  editingTagId.value = tag.id;
  editingTagName.value = tag.name;
}

function confirmRenameTag() {
  const tagId = editingTagId.value;
  const newName = editingTagName.value.trim();
  if (tagId && newName && newName !== store.tags.find(t => t.id === tagId)?.name) {
    store.renameTag(tagId, newName);
  }
  editingTagId.value = null;
  editingTagName.value = "";
}

function cancelRenameTag() {
  editingTagId.value = null;
  editingTagName.value = "";
}

async function handleDeleteTag(tagId: string) {
  const tag = store.tags.find(t => t.id === tagId);
  if (!tag) return;
  const ok = await confirm({
    title: "删除标签",
    message: `确定要删除「${tag.name}」吗？已绑定该标签的素材将保留。`,
    kind: "danger",
    okLabel: "删除",
    cancelLabel: "取消",
  });
  if (!ok) return;
  try {
    await store.deleteTag(tagId);
  } catch (e) {
    console.error("删除标签失败:", e);
  }
}

// ── 未分类标签管理 ──
const UNCATEGORIZED_DEFAULT = "未分类";
const UNCATEGORIZED_STORAGE_KEY = "aipen_uncategorized_label";

function loadUncategorizedLabel(): string {
  try {
    const stored = localStorage.getItem(UNCATEGORIZED_STORAGE_KEY);
    return stored || UNCATEGORIZED_DEFAULT;
  } catch {
    return UNCATEGORIZED_DEFAULT;
  }
}

function saveUncategorizedLabel(label: string) {
  try {
    localStorage.setItem(UNCATEGORIZED_STORAGE_KEY, label);
  } catch { /* noop */ }
}

const uncategorizedLabel = ref(loadUncategorizedLabel());
const editingUncategorized = ref(false);
const editingUncategorizedName = ref("");

function startRenameUncategorized() {
  editingUncategorized.value = true;
  editingUncategorizedName.value = uncategorizedLabel.value;
}

function confirmRenameUncategorized() {
  const newName = editingUncategorizedName.value.trim();
  if (newName && newName !== uncategorizedLabel.value) {
    uncategorizedLabel.value = newName;
    saveUncategorizedLabel(newName);
  }
  editingUncategorized.value = false;
  editingUncategorizedName.value = "";
}

function cancelRenameUncategorized() {
  editingUncategorized.value = false;
  editingUncategorizedName.value = "";
}

async function handleDeleteUncategorized() {
  const uncategorized = store.tagDocumentGroups.find(g => g.tag === null);
  if (!uncategorized || uncategorized.materials.length === 0) return;
  const count = uncategorized.materials.length;
  const ok = await confirm({
    title: `删除${uncategorizedLabel.value}`,
    message: `确定要删除「${uncategorizedLabel.value}」中的全部 ${count} 条素材吗？此操作不可撤销。`,
    kind: "danger",
    okLabel: "全部删除",
    cancelLabel: "取消",
  });
  if (!ok) return;
  try {
    // 批量删除所有未分类素材
    for (const mat of uncategorized.materials) {
      await store.deleteMaterial(mat.id);
    }
  } catch (e) {
    console.error("批量删除未分类素材失败:", e);
  }
}

// ── 浏览器 Tab ──

const newBookmarkUrl = ref("");
const newBookmarkTitle = ref("");

async function handleAddBookmark() {
  const url = newBookmarkUrl.value.trim();
  if (!url) return;
  await store.addBookmark(url, newBookmarkTitle.value.trim() || url);
  newBookmarkUrl.value = "";
  newBookmarkTitle.value = "";
}

async function handleDeleteBookmark(bm: Bookmark) {
  await store.deleteBookmark(bm.id);
}

function handleOpenBookmark(url: string) {
  const bm = store.bookmarks.find(b => b.url === url);
  if (bm && !bm.favicon) {
    store.fetchBookmarkFavicon(bm.id);
  }
  emit("update", "openBrowser", url);
}

// ── 素材字体/字号设置面板 ──
const showFontPanel = ref(false);
const fontBtnRef = ref<HTMLElement | null>(null);
const fontPanelStyle = ref<{ left: string; top: string }>({ left: "0px", top: "0px" });
function toggleFontPanel() {
  if (!showFontPanel.value) {
    const el = fontBtnRef.value;
    if (el) {
      const rect = el.getBoundingClientRect();
      fontPanelStyle.value = { left: rect.left + "px", top: rect.bottom + 6 + "px" };
    }
  }
  showFontPanel.value = !showFontPanel.value;
}
</script>

<template>
  <!-- 素材 Tab：按标签文档展示（与文档面板操作逻辑一致） -->
  <div v-if="subTab === 'materials'" class="flex flex-col h-full">
    <div class="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-800">
      <div class="flex items-center gap-1.5">
        <span class="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">素材</span>
        <!-- 字体/字号设置齿轮 -->
        <button
          ref="fontBtnRef"
          type="button"
          class="inline-flex items-center justify-center w-4 h-4 rounded text-gray-400 dark:text-gray-500 opacity-60 hover:opacity-100 hover:text-blue-400 hover:bg-blue-500/10 transition-all"
          title="素材字体与字号设置"
          @click.stop="toggleFontPanel"
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      </div>
      <button
        class="text-xs text-gray-400 dark:text-gray-500 hover:text-blue-400 transition-colors"
        title="新建标签"
        @click="handleCreateTag"
      >
        + 新建
      </button>
    </div>

    <!-- 素材字体/字号设置弹出面板 -->
    <Teleport to="body">
      <div
        v-if="showFontPanel"
        class="fixed inset-0 z-[10006]"
        @click.self="showFontPanel = false"
      >
        <div
          class="absolute w-56 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg shadow-xl p-3 space-y-3"
          :style="fontPanelStyle"
        >
          <div class="text-xs font-semibold text-gray-500 dark:text-gray-400">素材显示设置</div>
          <div class="space-y-1">
            <label class="block text-[11px] text-gray-400 dark:text-gray-500">字体</label>
            <select
              v-model="materialFontFamily"
              class="w-full text-xs rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 px-2 py-1 outline-none focus:border-blue-500"
            >
              <option v-for="opt in MATERIAL_FONT_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </div>
          <div class="space-y-1">
            <label class="block text-[11px] text-gray-400 dark:text-gray-500">字号</label>
            <select
              v-model="materialFontSize"
              class="w-full text-xs rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 px-2 py-1 outline-none focus:border-blue-500"
            >
              <option v-for="s in MATERIAL_FONT_SIZE_OPTIONS" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
        </div>
      </div>
    </Teleport>
    <div class="flex-1 overflow-y-auto">
      <div
        v-for="item in tagListItems"
        :key="item.tag?.id ?? '__uncategorized__'"
        class="group flex items-center gap-1 px-2 py-2 cursor-pointer transition-colors"
        :class="(store.currentTagDocumentId === (item.tag?.id ?? '__uncategorized__'))
          ? 'bg-blue-100 dark:bg-blue-900/30 border-l-2 border-blue-500 text-blue-700 dark:text-blue-300'
          : 'border-l-2 border-transparent text-gray-600 dark:text-gray-400 hover:bg-gray-100/50 dark:hover:bg-gray-800/50 hover:text-gray-800 dark:hover:text-gray-200'"
        @click="handleTagItemClick(item)"
      >
        <div class="flex-1 min-w-0">
          <!-- 未分类行内编辑 -->
          <input
            v-if="item.isUncategorized && editingUncategorized"
            v-model="editingUncategorizedName"
            type="text"
            class="w-full bg-gray-100 dark:bg-gray-800 border border-blue-500 rounded px-1.5 py-0.5 text-xs text-gray-800 dark:text-gray-200 outline-none"
            @keyup.enter="confirmRenameUncategorized()"
            @keyup.escape="cancelRenameUncategorized()"
            @blur="confirmRenameUncategorized()"
            @click.stop
          />
          <input
            v-else-if="item.tag && editingTagId === item.tag.id"
            v-model="editingTagName"
            type="text"
            class="w-full bg-gray-100 dark:bg-gray-800 border border-blue-500 rounded px-1.5 py-0.5 text-xs text-gray-800 dark:text-gray-200 outline-none"
            @keyup.enter="confirmRenameTag()"
            @keyup.escape="cancelRenameTag()"
            @blur="confirmRenameTag()"
            @click.stop
          />
          <p v-else class="text-xs truncate">{{ item.isUncategorized ? uncategorizedLabel : (item.tag?.name ?? uncategorizedLabel) }}</p>
          <p class="text-[10px] text-gray-500 dark:text-gray-600 truncate">{{ item.materialCount }} 条素材</p>
        </div>
        <!-- 操作按钮，悬停时显示 -->
        <div class="hidden group-hover:flex items-center gap-0.5 shrink-0">
          <button
            class="h-5 w-5 flex items-center justify-center text-xs text-gray-400 dark:text-gray-500 hover:text-yellow-600 dark:hover:text-yellow-400 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
            :title="item.isUncategorized ? `重命名「${uncategorizedLabel}」` : '重命名'"
            @click.stop="item.isUncategorized ? startRenameUncategorized() : startRenameTag(item.tag!)"
          >✎</button>
          <button
            class="h-5 w-5 flex items-center justify-center text-xs text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
            :title="item.isUncategorized ? `删除全部${uncategorizedLabel}素材` : '删除'"
            @click.stop="item.isUncategorized ? handleDeleteUncategorized() : handleDeleteTag(item.tag!.id)"
          >✕</button>
        </div>
      </div>
      <!-- 空状态 -->
      <div
        v-if="tagListItems.length === 0"
        class="text-center py-8 text-xs text-gray-500 dark:text-gray-600"
      >
        <p>暂无素材</p>
        <p class="mt-1">在编辑器中选中文字，右键「存入素材库」</p>
      </div>
    </div>
  </div>

  <!-- 浏览器 Tab -->
  <div v-if="subTab === 'browser'" class="flex flex-col h-full">
    <!-- 添加书签 -->
    <div class="px-2 py-2 border-b border-gray-200 dark:border-gray-800 space-y-1.5">
      <input
        v-model="newBookmarkUrl"
        type="text"
        placeholder="输入网址 URL..."
        class="w-full h-7 px-2 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded text-[11px] text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 focus:border-blue-500 focus:outline-none"
        @keyup.enter="handleAddBookmark"
      />
      <input
        v-model="newBookmarkTitle"
        type="text"
        placeholder="书签名称（可选）"
        class="w-full h-7 px-2 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded text-[11px] text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 focus:border-blue-500 focus:outline-none"
        @keyup.enter="handleAddBookmark"
      />
      <button
        class="w-full h-7 text-[11px] bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
        @click="handleAddBookmark"
      >添加书签</button>
    </div>

    <!-- 书签列表 -->
    <div class="flex-1 overflow-y-auto">
      <div
        v-if="store.bookmarks.length === 0"
        class="text-center py-8 text-xs text-gray-500 dark:text-gray-600"
      >
        <p>暂无书签</p>
        <p class="mt-1">输入网址添加常用参考页面</p>
      </div>
      <div
        v-for="bm in store.bookmarks"
        :key="bm.id"
        class="group flex items-center gap-2 px-2 py-2 cursor-pointer transition-colors text-gray-600 dark:text-gray-400 hover:bg-gray-100/50 dark:hover:bg-gray-800/50 hover:text-gray-800 dark:hover:text-gray-200"
        @click="handleOpenBookmark(bm.url)"
      >
        <span class="shrink-0 w-4 h-4 flex items-center justify-center">
          <img
            v-if="bm.favicon"
            :src="bm.favicon"
            class="w-3.5 h-3.5 rounded-sm"
            alt=""
            @load="console.log('[Favicon] img OK:', bm.url)"
            @error="store.clearBookmarkFavicon(bm.id)"
          />
          <span v-else class="text-[10px] leading-none">🔗</span>
        </span>
        <div class="flex-1 min-w-0">
          <p class="text-xs truncate">{{ bm.title || bm.url }}</p>
          <p class="text-[10px] text-gray-500 dark:text-gray-600 truncate">{{ bm.url }}</p>
        </div>
        <button
          class="h-5 w-5 flex items-center justify-center text-[10px] text-gray-500 dark:text-gray-600 hover:text-red-600 dark:hover:text-red-400 hover:bg-gray-200 dark:hover:bg-gray-700 rounded opacity-0 group-hover:opacity-100 transition-all shrink-0"
          title="删除书签"
          @click.stop="handleDeleteBookmark(bm)"
        >✕</button>
      </div>
    </div>
  </div>
</template>
