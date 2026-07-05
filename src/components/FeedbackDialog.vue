<script setup lang="ts">
import { ref } from "vue";

const props = defineProps<{
  show: boolean;
  appVersion: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

const name = ref("");
const content = ref("");
const submitting = ref(false);
const result = ref<{ ok: boolean; msg: string } | null>(null);

const GH_TOKEN = "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";
const GH_API = "https://api.github.com/repos/jason3723/AiPen/issues";

async function submit() {
  if (!content.value.trim()) return;
  submitting.value = true;
  result.value = null;

  const title = `[反馈] ${name.value.trim() || "匿名用户"} — v${props.appVersion}`;
  const body = content.value.trim();

  try {
    const res = await fetch(GH_API, {
      method: "POST",
      headers: {
        Authorization: `token ${GH_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "AiPen",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, body, labels: ["反馈"] }),
    });

    if (res.ok) {
      result.value = { ok: true, msg: "反馈已提交，感谢！" };
      name.value = "";
      content.value = "";
      setTimeout(() => close(), 3000);
    } else {
      result.value = { ok: false, msg: "提交失败，请稍后重试" };
    }
  } catch {
    result.value = { ok: false, msg: "网络错误，请检查连接后重试" };
  } finally {
    submitting.value = false;
  }
}

function close() {
  result.value = null;
  emit("close");
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="show"
      class="fixed inset-0 z-[10001] flex items-center justify-center"
      @click.self="close"
    >
      <div class="absolute inset-0 bg-black/40 backdrop-blur-md" />
      <div
        class="relative w-full max-w-md rounded-xl shadow-2xl flex flex-col bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-200 border border-gray-200 dark:border-gray-800"
      >
        <!-- 标题栏 -->
        <div
          class="flex items-center justify-between px-5 py-3.5 border-b border-gray-200 dark:border-gray-800 shrink-0 rounded-t-xl"
        >
          <h2 class="text-base font-semibold">💬 意见反馈</h2>
          <button
            class="h-7 w-7 flex items-center justify-center rounded text-lg leading-none text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            @click="close"
          >
            ✕
          </button>
        </div>

        <!-- 表单内容 -->
        <div class="px-5 py-4 space-y-4">
          <div>
            <input
              v-model="name"
              type="text"
              placeholder="称呼（选填）"
              maxlength="30"
              class="w-full px-3 py-2 rounded-lg border text-sm outline-none transition-colors bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:border-blue-400 dark:focus:border-blue-500"
            />
          </div>

          <div>
            <textarea
              v-model="content"
              placeholder="请描述你的问题、建议或使用体验…"
              rows="5"
              maxlength="2000"
              class="w-full px-3 py-2 rounded-lg border text-sm outline-none resize-none transition-colors bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:border-blue-400 dark:focus:border-blue-500"
            ></textarea>
            <div
              class="text-right text-xs mt-1 text-gray-400 dark:text-gray-600"
            >
              {{ content.length }}/2000
            </div>
          </div>

          <!-- 结果提示 -->
          <div
            v-if="result"
            :class="result.ok
              ? 'text-sm text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/20 rounded-lg px-3 py-2'
              : 'text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-lg px-3 py-2'"
          >
            {{ result.msg }}
          </div>

          <!-- 提交按钮 -->
          <button
            :disabled="!content.trim() || submitting"
            class="w-full py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-blue-600 hover:bg-blue-500 text-white"
            @click="submit"
          >
            {{ submitting ? "发送中…" : "提交反馈" }}
          </button>
        </div>

        <!-- 底部说明 -->
        <div
          class="px-5 py-3 border-t border-gray-200 dark:border-gray-800 shrink-0 rounded-b-xl text-center text-xs text-gray-400 dark:text-gray-600"
        >
          反馈将通过安全通道提交，不会收集个人信息
        </div>
      </div>
    </div>
  </Teleport>
</template>
