<script setup lang="ts">
import { ref, computed } from "vue";
import { useMaterialStore } from "../stores/materialStore";

const props = defineProps<{
  tagId: string | null;
}>();

const emit = defineEmits<{
  close: [];
  saved: [materialId: string];
}>();

const store = useMaterialStore();

const content = ref("");
const sourceUrl = ref("");
const sourceTitle = ref("");
const saving = ref(false);
const savedId = ref<string | null>(null);

const tagName = computed(() => {
  const t = store.tags.find((t) => t.id === props.tagId);
  return t?.name ?? "";
});

async function handleSave() {
  if (!content.value.trim() || !props.tagId) return;
  saving.value = true;
  try {
    const mat = await store.saveMaterial(
      content.value,
      sourceUrl.value.trim() ? sourceUrl.value.trim() : undefined,
      sourceTitle.value.trim() ? sourceTitle.value.trim() : undefined
    );
    await store.setMaterialTags(mat.id, [props.tagId]);
    // 保存后主动用刷新后的 materials 重建当前标签视图，
    // 让新素材无需手动刷新即出现在编辑器卡片 / 列表中
    await store.selectTagDocument(props.tagId);
    emit("saved", mat.id);
  } catch (e) {
    console.error("手动录入失败:", e);
  } finally {
    saving.value = false;
    savedId.value = props.tagId;
    setTimeout(() => emit("close"), 1000);
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="tagId"
      class="fixed inset-0 z-[10005] flex items-center justify-center"
      @click.self="emit('close')"
    >
      <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        class="relative w-full max-w-lg max-h-[80vh] bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl shadow-2xl flex flex-col"
      >
        <!-- 表单态 -->
        <template v-if="!savedId">
          <!-- Header -->
          <div
            class="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800 shrink-0"
          >
            <h2
              class="text-sm font-semibold m-0 text-gray-800 dark:text-gray-200"
            >
              录入到「{{ tagName }}」
            </h2>
            <button
              class="h-7 w-7 flex items-center justify-center rounded text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              @click="emit('close')"
            >
              ✕
            </button>
          </div>

          <!-- Content -->
          <div class="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            <div>
              <label class="block text-[11px] text-gray-400 dark:text-gray-500 mb-1">
                正文内容 <span class="text-red-500">*</span>
              </label>
              <textarea
                v-model="content"
                rows="6"
                placeholder="在此输入要存入该标签的素材正文..."
                class="w-full text-xs rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 px-2 py-1.5 outline-none focus:border-blue-500 resize-y"
              ></textarea>
            </div>
            <div class="flex gap-2">
              <div class="flex-1">
                <label class="block text-[11px] text-gray-400 dark:text-gray-500 mb-1">
                  来源标题（可选）
                </label>
                <input
                  v-model="sourceTitle"
                  type="text"
                  placeholder="如：网页标题"
                  class="w-full h-8 px-2 text-xs rounded border border-gray-300 dark:border-gray扯-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div class="flex-1">
                <label class="block text-[11px] text-gray-400 dark:text-gray-500 mb-1">
                  来源 URL（可选）
                </label>
                <input
                  v-model="sourceUrl"
                  type="text"
                  placeholder="https://..."
                  class="w-full h-8 px-3 text-xs rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:outout-none"
                />
              </div>
            </div>
            <p class="text-[11px] text-gray-500 dark:text-gray-600">
              标题将根据正文自动生成（取前 30 字）。保存后该素材会出现在「{{ tagName }}」标签文档中。
            </p>
          </div>

          <!-- Footer -->
          <div
            class="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-800 shrink-0"
          >
            <span class="text-[11px] text-gray-500 dark:text-gray-600">手动录入素材</span>
            <div class="flex items-center gap-2">
              <button
                class="h-8 px-4 text-xs text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
                @click="emit('close')"
              >
                取消
              </button>
              <button
                class="h-8 px-5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium disabled:opacity-50"
                :disabled="!content.trim() || saving"
                @click="handleSave"
              >
                {{ saving ? '保存中...' : '确认录入' }}
              </button>
            </div>
          </div>
        </template>

        <!-- 成功态 -->
        <div
          v-else
          class="flex-1 flex items-center justify-center p-6"
        >
          <div class="text-center">
            <div class="text-4xl text-emerald-500 mb-3">✓</div>
            <p class="text-sm text-gray-700 dark:text-gray-300">
              录入成功！素材已存入「{{ tagName }}」。
            </p>
            <p class="text-[11px] text-gray-500 dark:text-gray-600 mt-2">
              窗口将在 3 秒后自动关闭。
            </p>
            <button
              class="mt-4 h-8 px-5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium"
              @click="emit('close')"
            >
              立即关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
