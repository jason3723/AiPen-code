import { ref, watch, onScopeDispose } from "vue";

export type ThemeMode = "dark" | "light";
/** 显式选择模式:user(用户手动) | system(跟随系统) */
export type ThemeSource = "user" | "system";

const STORAGE_KEY = "aipen-theme";
const SOURCE_KEY = "aipen-theme-source";
const DARK_CLASS = "dark";

/** 读取系统主题偏好 */
function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** 解析初始主题:优先级 用户显式 > 系统偏好 > 浅色 */
function resolveInitial(): { mode: ThemeMode; source: ThemeSource } {
  try {
    const storedMode = localStorage.getItem(STORAGE_KEY);
    const storedSource = localStorage.getItem(SOURCE_KEY) as ThemeSource | null;

    // 用户曾显式选择过:尊重用户
    if (storedSource === "user" && (storedMode === "dark" || storedMode === "light")) {
      return { mode: storedMode, source: "user" };
    }
    // 跟随系统模式
    if (storedSource === "system") {
      return { mode: systemPrefersDark() ? "dark" : "light", source: "system" };
    }
  } catch {
    // localStorage 不可用
  }
  // 首次启动:跟随系统
  return { mode: systemPrefersDark() ? "dark" : "light", source: "system" };
}

const initial = resolveInitial();
const isDark = ref(initial.mode === "dark");
const source = ref<ThemeSource>(initial.source);

/** 持久化(显式选择时才写 mode,source 总是写) */
function persist() {
  try {
    localStorage.setItem(SOURCE_KEY, source.value);
    if (source.value === "user") {
      localStorage.setItem(STORAGE_KEY, isDark.value ? "dark" : "light");
    } else {
      // 跟随系统时清掉显式选择,避免污染
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // 忽略
  }
}

/** 同步 <html> 上的 .dark class */
function applyThemeClass() {
  if (isDark.value) {
    document.documentElement.classList.add(DARK_CLASS);
  } else {
    document.documentElement.classList.remove(DARK_CLASS);
  }
}

// 初始化时立即应用
applyThemeClass();

watch([isDark, source], () => {
  applyThemeClass();
  persist();
});

/** 监听系统主题变化:仅在 source === 'system' 时跟随 */
function onSystemChange(refIsDark: ReturnType<typeof ref<boolean>>, refSource: ReturnType<typeof ref<ThemeSource>>) {
  return (e: MediaQueryListEvent) => {
    if (refSource.value === "system") {
      refIsDark.value = e.matches;
    }
  };
}

/** 切换主题:用户手动切换总是 source='user' */
function toggleTheme() {
  isDark.value = !isDark.value;
  source.value = "user";
}

/** 设置为指定主题:显式选择 */
function setTheme(mode: ThemeMode) {
  isDark.value = mode === "dark";
  source.value = "user";
}

/** 切换为跟随系统 */
function followSystem() {
  isDark.value = systemPrefersDark();
  source.value = "system";
}

export function useTheme() {
  // 在 composable 内部注册 MQL 监听，onScopeDispose 可正常生效
  const mql =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;

  if (mql) {
    const handler = onSystemChange(isDark, source);
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", handler);
      onScopeDispose(() => mql.removeEventListener("change", handler));
    } else if (typeof (mql as any).addListener === "function") {
      (mql as any).addListener(handler);
      onScopeDispose(() => (mql as any).removeListener(handler));
    }
  }

  return {
    isDark,
    source,
    toggleTheme,
    setTheme,
    followSystem,
  };
}
