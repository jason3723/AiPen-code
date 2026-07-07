import { defineStore } from "pinia";
import { ref, computed } from "vue";

export interface CandidateItem {
  id: string;
  text: string;
  sourceType: "document" | "material" | "browser";
  sourceId: string;
  sourceTitle: string;
  sourceUrl?: string;
  selected: boolean;
  createdAt: number;
}

export const useCandidateStore = defineStore("candidate", () => {
  const items = ref<CandidateItem[]>([]);
  const panelVisible = ref(false);

  function add(item: Omit<CandidateItem, "id" | "selected" | "createdAt">) {
    // 去重：相同文本不重复添加
    if (items.value.some((i) => i.text === item.text && i.sourceType === item.sourceType && i.sourceId === item.sourceId)) {
      return;
    }
    const id = crypto.randomUUID();
    items.value.push({
      ...item,
      id,
      selected: true,
      createdAt: Date.now(),
    });
  }

  function remove(id: string) {
    items.value = items.value.filter((i) => i.id !== id);
  }

  function clearAll() {
    items.value = [];
  }

  function toggleItem(id: string) {
    const item = items.value.find((i) => i.id === id);
    if (item) item.selected = !item.selected;
  }

  function toggleAll() {
    const allSelected = items.value.every((i) => i.selected);
    items.value.forEach((i) => {
      i.selected = !allSelected;
    });
  }

  const allSelected = computed(() => items.value.length > 0 && items.value.every((i) => i.selected));

  /** 拼接选中候选内容为 AI 对话上下文文本 */
  const contextText = computed(() =>
    items.value
      .filter((i) => i.selected)
      .map((i, idx) => `${idx + 1}. ${i.text}`)
      .join("\n\n")
  );

  return { items, panelVisible, add, remove, clearAll, toggleItem, toggleAll, allSelected, contextText };
});
