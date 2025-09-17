// tokens.js  —— 已优化的主题 tokens（dark + light）
// 说明：组件层使用了 token alias（字符串形式 "{color.primary}"）便于被 token 工具替换/解析
function getThemeTokens() {
  return {
    // DARK / LIGHT 两套主题
    dark: {
      meta: { mode: "dark", version: "1.0.0" },

      // 原色 / 基色（primitives）—— 保留原色供图表/高亮使用
      primitives: {
        brandPrimary: "#4f8cff",
        brandOk: "#3cc86b",
        brandWarn: "#ffb86c",
        brandBad: "#ff6b6b",
        // neutral scale（用以替代单一 neutral）
        neutral: {
          50: "#f6f7f8",
          100: "#e9ebee",
          200: "#cfd6dd",
          300: "#aab6c3",
          400: "#8091a0",
          500: "#64748b",
          700: "#3f4650",
          900: "#0f1113"
        }
      },

      // 语义色（组件/页面应该只消费这里的语义项）
      color: {
        // 背景层
        bg: "#0f1113",
        panel: "#2b2d31",
        panel2: "#1c1e22",

        // 文本层（并提供 on* 别名保证对比）
        fg: "#e6e7ea",
        muted: "#9aa3b2",
        // on* 保证在某背景上的可读颜色（建议由构建流程确认）
        "onPanel": "#e6e7ea",
        "onPrimary": "#ffffff",

        // 边框与分隔
        border: "#3a3b41",

        // 语义色（通常等于 primitives）
        primary: "{primitives.brandPrimary}",
        ok: "{primitives.brandOk}",
        warn: "{primitives.brandWarn}",
        bad: "{primitives.brandBad}"
      },

      // 可复用的组件级 token（插件优先拿 component.*）
      component: {
        button: {
          bg: "{color.primary}",
          text: "{color.onPrimary}",
          border: "transparent",
          hover: { bg: "#3b74e6" },
          active: { bg: "#356fe0" },
          focus: { ring: "rgba(79,140,255,0.28)" },
          disabled: { bg: "#3a3b41", text: "#9aa3b2" }
        },
        input: {
          bg: "{color.panel}",
          border: "{color.border}",
          text: "{color.fg}",
          placeholder: "{color.muted}",
          focus: { border: "{color.primary}", ring: "rgba(79,140,255,0.18)" }
        },
        link: {
          text: "{color.primary}",
          hover: { text: "#6b9eff" },
          visited: "#7aa0ff"
        },
        badge: {
          bg: "#222327",
          text: "{color.fg}"
        },
        tooltip: {
          bg: "#1c1f24",
          fg: "{color.fg}",
          border: "{color.border}",
          shadow: "0 8px 24px rgba(0,0,0,0.45)"
        },
        scrollbar: {
          track: "#1c1e22",
          thumb: "#3a3b41",
          thumbHover: "#4a4b51"
        }
      },

      // 阴影 / 提升（建议用 elevation 表示语义深度）
      elevation: {
        surface: "0 6px 20px rgba(0,0,0,0.35)",
        overlay: "0 8px 24px rgba(0,0,0,0.45)"
      },

      // 圆角 / 间距 / 字体 / 字号
      radius: { sm: "6px", md: "8px", lg: "10px", round: "999px" },
      space: { 1: "4px", 2: "8px", 3: "12px", 4: "16px", 5: "24px" },
      text: { xs: "12px", sm: "13px", md: "14px", lg: "16px" },
      font: {
        sans: "ui-sans-serif,-apple-system,Segoe UI,Roboto,Helvetica,Arial,PingFang SC,Microsoft Yahei,sans-serif",
        mono: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"
      },

      // 动效
      motion: {
        duration: { fast: "120ms", normal: "240ms", slow: "360ms" },
        easing: "cubic-bezier(.2,.8,.2,1)"
      },

      // 可访问性 / 对比建议（便于 QA 的自动检测）
      accessibility: {
        recommendation: "body text >= 4.5:1, large text >= 3:1",
        notes: {
          fgOnBg: "ensure fg vs bg >= 4.5:1",
          onPrimary: "onPrimary should be white or high-contrast"
        }
      }
    },

    // ---------- LIGHT THEME ----------
    light: {
      meta: { mode: "light", version: "1.0.0" },

      primitives: {
        brandPrimary: "#0d6efd",
        brandOk: "#198754",
        brandWarn: "#fd7e14",
        brandBad: "#dc3545",
        neutral: {
          50: "#ffffff",
          100: "#f8fafc",
          200: "#f1f5f9",
          300: "#e2e8f0",
          400: "#cbd5e1",
          500: "#94a3b8",
          700: "#64748b",
          900: "#212529"
        }
      },

      color: {
        bg: "#ffffff",
        panel: "#ffffff",
        panel2: "#f8f9fa",
        fg: "#212529",
        muted: "#6c757d",
        onPanel: "#212529",
        onPrimary: "#ffffff",
        border: "#e5e7eb",
        primary: "{primitives.brandPrimary}",
        ok: "{primitives.brandOk}",
        warn: "{primitives.brandWarn}",
        bad: "{primitives.brandBad}"
      },

      component: {
        button: {
          bg: "{color.primary}",
          text: "{color.onPrimary}",
          border: "transparent",
          hover: { bg: "#0b5ed7" },
          active: { bg: "#0a58ca" },
          focus: { ring: "rgba(13,110,253,0.18)" },
          disabled: { bg: "#e9ecef", text: "#adb5bd" }
        },
        input: {
          bg: "{color.panel2}",
          border: "{color.border}",
          text: "{color.fg}",
          placeholder: "{color.muted}",
          focus: { border: "{color.primary}", ring: "rgba(13,110,253,0.12)" }
        },
        link: {
          text: "{color.primary}",
          hover: { text: "#0b5ed7" },
          visited: "#0a58ca"
        },
        badge: {
          bg: "#f1f3f5",
          text: "{color.fg}"
        },
        tooltip: {
          bg: "#ffffff",
          fg: "#333333",
          border: "{color.border}",
          shadow: "0 8px 24px rgba(0,0,0,0.12)"
        },
        scrollbar: {
          track: "#f3f4f6",
          thumb: "#d1d5db",
          thumbHover: "#9ca3af"
        }
      },

      elevation: {
        surface: "0 6px 20px rgba(0,0,0,0.12)",
        overlay: "0 8px 24px rgba(0,0,0,0.12)"
      },

      radius: { sm: "6px", md: "8px", lg: "10px", round: "999px" },
      space: { 1: "4px", 2: "8px", 3: "12px", 4: "16px", 5: "24px" },
      text: { xs: "12px", sm: "13px", md: "14px", lg: "16px" },
      font: {
        sans: "ui-sans-serif,-apple-system,Segoe UI,Roboto,Helvetica,Arial,PingFang SC,Microsoft Yahei,sans-serif",
        mono: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"
      },

      motion: {
        duration: { fast: "120ms", normal: "240ms", slow: "360ms" },
        easing: "cubic-bezier(.2,.8,.2,1)"
      },

      accessibility: {
        recommendation: "body text >= 4.5:1, large text >= 3:1",
        notes: {
          fgOnBg: "ensure fg vs bg >= 4.5:1",
          onPrimary: "onPrimary should be white or high-contrast"
        }
      }
    }
  };
}

module.exports = { getThemeTokens };
