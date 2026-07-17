// 技能执行历史：本地缓存（localStorage），不清浏览器数据就不会丢。
// 仅用于前端查看「哪个技能 / 什么时间 / 针对哪个文本 / 生成了什么」。

const HISTORY_KEY = "aipen_skill_history";
const MAX_ENTRIES = 30; // 最多保留条数
const SOURCE_TEXT_LIMIT = 2000; // 来源文本截断长度，避免撑爆 localStorage

export type SkillHistoryMode = "single" | "pipeline";
export type SkillHistorySourceType = "selected" | "full";

export interface SkillHistoryEntry {
  id: string;
  skillName: string; // 单技能名，或管道 "A → B → C"
  skillCategory?: string;
  mode: SkillHistoryMode;
  timestamp: number;
  sourceType: SkillHistorySourceType; // 选中文本 / 全文
  sourceText: string; // 针对哪个文本（截断保护）
  resultText: string; // 生成的具体内容（完整保留）
  pipelineSkillNames?: string[]; // 组合管道技能名列表
}

export type AddSkillHistoryInput = Omit<SkillHistoryEntry, "id" | "timestamp"> & {
  timestamp?: number;
};

export function loadSkillHistory(): SkillHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SkillHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export function addSkillHistory(input: AddSkillHistoryInput): void {
  try {
    const entry: SkillHistoryEntry = {
      id: crypto.randomUUID(),
      timestamp: input.timestamp ?? Date.now(),
      skillName: input.skillName,
      skillCategory: input.skillCategory,
      mode: input.mode,
      sourceType: input.sourceType,
      sourceText:
        input.sourceText.length > SOURCE_TEXT_LIMIT
          ? input.sourceText.slice(0, SOURCE_TEXT_LIMIT) + "…"
          : input.sourceText,
      resultText: input.resultText,
      pipelineSkillNames: input.pipelineSkillNames,
    };
    const list = loadSkillHistory();
    list.unshift(entry);
    const trimmed = list.slice(0, MAX_ENTRIES);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  } catch {
    // 配额异常或隐私模式下静默失败，不影响主流程
  }
}

export function removeSkillHistory(id: string): void {
  try {
    const list = loadSkillHistory().filter((e) => e.id !== id);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    // 静默失败
  }
}

export function clearSkillHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // 静默失败
  }
}
