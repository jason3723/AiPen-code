<script setup lang="ts">
import { watch } from "vue";
import { useCandidateStore, type CandidateItem } from "../stores/candidateStore";
import { useDocumentStore } from "../stores/document";

const candidateStore = useCandidateStore();
const docStore = useDocumentStore();

// 清空所有条目时，自动收起面板
watch(
  () => candidateStore.items.length,
  (len) => {
    if (len === 0 && candidateStore.panelVisible) {
      candidateStore.panelVisible = false;
    }
  }
);

const emit = defineEmits<{
  navigateToDocument: [docId: string];
  navigateToMaterial: [matId: string];
  openBrowser: [url: string];
}>();

function toggleDrawer() {
  candidateStore.panelVisible = !candidateStore.panelVisible;
}

function jumpToSource(item: CandidateItem) {
  candidateStore.panelVisible = false;
  if (item.sourceType === "document") {
    emit("navigateToDocument", item.sourceId);
  } else if (item.sourceType === "material") {
    emit("navigateToMaterial", item.sourceId);
  } else if (item.sourceType === "browser" && item.sourceUrl) {
    emit("openBrowser", item.sourceUrl);
  }
}

function copyItemText(item: CandidateItem) {
  navigator.clipboard.writeText(item.text);
}

function openCandidateChat() {
  if (candidateStore.items.length === 0) return;
  docStore.injectedChatText = candidateStore.contextText;
  docStore.sidebarTab = "chat";
  candidateStore.panelVisible = false;
}
</script>

<template>
  <div
    class="candidate-drawer-root"
    :class="{ 'is-open': candidateStore.panelVisible }"
  >
    <!-- 触发图标：始终显示，与面板无缝贴合 -->
    <button
      v-if="candidateStore.items.length > 0 || candidateStore.panelVisible"
      class="candidate-trigger bg-gray-300/20 dark:bg-white/8 dark:border dark:border-solid dark:border-white/10 dark:border-l-0 hover:bg-gray-300/35 dark:hover:bg-white/15"
      :title="candidateStore.panelVisible ? '关闭候选库' : '打开候选库'"
      @click.stop="toggleDrawer"
    >
      <svg
        v-if="candidateStore.panelVisible"
        class="w-4 h-4 text-gray-500 dark:text-gray-400"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
      </svg>
      <svg
        v-else
        class="w-4 h-4 text-gray-500 dark:text-gray-400"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
      </svg>
      <span
        class="absolute -top-1 -right-1 w-3.5 h-3.5 bg-blue-500 text-white text-[8px] rounded-full flex items-center justify-center font-medium"
      >
        {{ candidateStore.items.length }}
      </span>
    </button>

    <!-- 裁剪容器：面板滑出/滑入时被左边缘裁掉 -->
    <div class="candidate-drawer-clip">
      <Transition name="drawer-slide">
        <div
          v-if="candidateStore.panelVisible"
          class="candidate-panel bg-white dark:bg-[#1e2030] shadow-[2px_0_12px_rgba(0,0,0,0.08)] dark:shadow-[2px_0_12px_rgba(0,0,0,0.45)]"
          @click.stop
        >
          <!-- 头部 -->
          <div
            class="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700 shrink-0"
          >
            <span class="text-xs font-medium text-gray-700 dark:text-gray-300">
              候选库 ({{ candidateStore.items.length }})
            </span>
            <div class="flex items-center gap-2">
              <label class="flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400 cursor-pointer select-none">
                <input
                  type="checkbox"
                  :checked="candidateStore.allSelected"
                  @change="candidateStore.toggleAll()"
                  class="w-3 h-3 rounded accent-blue-500 dark:accent-blue-400"
                />
                全选
              </label>
              <button
                @click="openCandidateChat"
                :disabled="candidateStore.items.length === 0"
                class="text-[10px] px-2 py-0.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-white rounded transition-colors"
              >
                💬 对话
              </button>
            </div>
          </div>

          <!-- 条目列表 -->
          <div class="flex-1 overflow-y-auto">
            <div
              v-for="item in candidateStore.items"
              :key="item.id"
              class="px-3 py-2 border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
            >
              <label class="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  :checked="item.selected"
                  @change="candidateStore.toggleItem(item.id)"
                  class="w-3 h-3 rounded mt-0.5 accent-blue-500 dark:accent-blue-400"
                />
                <div class="flex-1 min-w-0">
                  <p class="text-[11px] text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap break-words">
                    {{ item.text }}
                  </p>
                  <div class="flex items-center justify-between mt-1">
                    <p class="text-[10px] text-gray-400 dark:text-gray-500 truncate max-w-[180px]">
                      <span
                        class="inline-block px-1 rounded text-[9px] mr-1"
                        :class="
                          item.sourceType === 'document'
                            ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300'
                            : item.sourceType === 'material'
                              ? 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-300'
                              : 'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-300'
                        "
                      >
                        {{ item.sourceType === "document" ? "文档" : item.sourceType === "material" ? "素材" : "网页" }}
                      </span>
                      来源：{{ item.sourceTitle }}
                    </p>
                    <div class="flex gap-1 flex-shrink-0">
                      <button
                        @click="copyItemText(item)"
                        title="复制"
                        class="text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors p-0.5"
                      >
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </button>
                      <button
                        @click="jumpToSource(item)"
                        title="跳转到出处"
                        class="text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors p-0.5"
                      >
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                          />
                        </svg>
                      </button>
                      <button
                        @click="candidateStore.remove(item.id)"
                        title="删除"
                        class="text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors p-0.5"
                      >
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              </label>
            </div>

            <!-- 空状态 -->
            <div v-if="candidateStore.items.length === 0" class="text-center text-[11px] text-gray-400 dark:text-gray-500 mt-8 py-8">
              候选库为空
              <br />
              <span class="text-[10px]">选中文本右键 → 添加到候选库</span>
            </div>
          </div>

          <!-- 底部：清空 -->
          <div
            v-if="candidateStore.items.length > 0"
            class="px-3 py-2 border-t border-gray-200 dark:border-gray-700 shrink-0"
          >
            <button
              @click="candidateStore.clearAll()"
              class="text-[10px] text-red-400 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300 transition-colors"
            >
              🗑 清空所有候选
            </button>
          </div>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.candidate-drawer-root {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  pointer-events: none;
  z-index: 100;
}

/* 裁剪容器：面板向内收起时被左边缘裁掉，不会浮在可见区域 */
.candidate-drawer-clip {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 280px;
  overflow: hidden;
  pointer-events: none;
}

/* 触发图标 */
.candidate-trigger {
  position: absolute;
  left: 0;
  top: 20px;
  transform: translateX(-57%);
  opacity: 0.45;
  transition: left 0.25s cubic-bezier(0.4, 0, 0.2, 1),
              transform 0.25s cubic-bezier(0.4, 0, 0.2, 1),
              opacity 0.2s ease;
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 48px;
  border-radius: 0 6px 6px 0;
  z-index: 101;
}
.candidate-trigger:hover {
  opacity: 0.95;
  transform: translateX(0);
}

/* 面板打开时：触发图标紧贴面板右边缘 */
.candidate-drawer-root.is-open .candidate-trigger {
  left: 280px;
  transform: translateX(0);
  opacity: 0.85;
}
.candidate-drawer-root.is-open .candidate-trigger:hover {
  opacity: 1;
  transform: translateX(0);
}

/* 面板 */
.candidate-panel {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 280px;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
}

/* 抽拉动画：面板在裁剪容器内滑动，超出 left:0 的部分被裁掉 */
.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}
.drawer-slide-enter-from,
.drawer-slide-leave-to {
  transform: translateX(-100%);
}
</style>
