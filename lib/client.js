// dsh-team-member-model Client half：DSH 设置里的「模型路由」页。
//
// 交互口径（2026-10-16 按用户反馈重做：原来「密密麻麻、不好用」）：
//   1. 渐进披露：列表只显示可扫读的**摘要行**，点开才出现表单。
//      规则行默认只有「→ 目标成员 · 通道 · 标签」这类一句话摘要；成员行只有 id 与标签。
//   2. 表单用**可见 label**，不靠 placeholder 猜字段含义（原来的规则行 12 个输入框平铺，
//      全靠 placeholder 认字段，这是「不好用」的主因）。
//   3. 分组：命中条件 / 路由目标 分开；排序策略、fork、回退、分类器、目录通配收进
//      「高级设置」折叠区；决策记录单独折叠。
//   4. 底部粘性操作栏：保存按钮、未保存提示、Host 半侧状态始终可见。
//   5. 图标是自绘 SVG（统一 1.5 描边 / 14px / currentColor），不用 Unicode 字符充当图标。
//
// 渲染机制与 dsh-skills-hub 一致：
//   window.__ModuleLoader__.load({ id, factory }) 产出 module.exports（含 apply/inject）。
// 数据走官方连接通道的 7 个 RPC 端点（channel /dsh-team-member-model + team-member-model/*），不再自己拼 /api fetch：
// 页面 origin 可能只是本机或远端反代，写操作必须落在当前会话真正连接的那台 Host 上。
//
// 零构建依赖：直接手写 CJS factory，React 通过 loader 注入的 require 解析。
// 作者：hwj

window.__ModuleLoader__.load({
  id: "dsh-team-member-model",
  factory: (require) => {
    var module = { exports: {} };
    Object.defineProperty(module.exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var reactDom = null;
    try {
      reactDom = require("react-dom");
    } catch (_) {
      reactDom = null;
    }
    var h = react.createElement;

    // 构建标记：显示在底部状态栏。改客户端就把它一起改掉——
    // 「我刷新了但行为没变」的争论到此为止：看这一行就知道浏览器跑的是哪一版。
    var BUILD = "2026-11-05 16:40";

    var WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

    // 样式：零构建手写，只走 DSH 主题 token（light/dark 自适应）。
    // 排版口径：固定字号阶梯（18/13/12/11）、卡片不套卡片、
    // 强调色只用于主操作/当前态/状态点，其余靠层次与留白。
    var CSS = [
      ".tmm-section{box-sizing:border-box;display:flex;flex-direction:column;gap:18px;width:100%;max-width:880px;min-width:0;margin:0 auto;padding:4px 0 72px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}",
      ".tmm-section *,.tmm-section *::before,.tmm-section *::after{box-sizing:border-box}",
      ".tmm-section ::selection{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}",
      ".tmm-section :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:6px}",

      // ── 头部 ────────────────────────────────────────────────
      ".tmm-hero{display:flex;flex-direction:column;gap:10px}",
      ".tmm-title{margin:0;font-size:18px;font-weight:600;line-height:26px;letter-spacing:-.2px}",
      ".tmm-sub{margin:0;max-width:68ch;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.6}",
      ".tmm-sub code{padding:1px 5px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}",
      ".tmm-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".tmm-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".tmm-chip.is-live{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}",
      ".tmm-chip.is-off{color:var(--dsw-alias-label-tertiary)}",
      ".tmm-dot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}",

      // ── 提示条（只在需要时出现；不用左侧色条）──────────────
      ".tmm-note{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.6}",
      ".tmm-note.is-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}",
      ".tmm-note .tmm-icon{margin-top:2px}",

      // ── 面板 ────────────────────────────────────────────────
      ".tmm-panel{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}",
      ".tmm-panel-head{display:flex;align-items:center;gap:8px;min-height:44px;padding:0 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}",
      ".tmm-panel-title{margin:0;font-size:13px;font-weight:600;letter-spacing:.1px}",
      ".tmm-panel-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".tmm-spacer{margin-left:auto}",
      ".tmm-list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}",
      ".tmm-list:empty{display:none}",

      // ── 列表行 ──────────────────────────────────────────────
      ".tmm-item{display:flex;align-items:center;gap:8px;min-height:40px;padding:0 8px 0 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".tmm-item:last-child{border-bottom:0}",
      ".tmm-item:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".tmm-item.is-active{background:var(--dsw-alias-interactive-bg-hover)}",
      ".tmm-item.is-dim{opacity:.5}",
      ".tmm-main{display:flex;align-items:center;gap:10px;flex:1;min-width:0;padding:9px 0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}",
      ".tmm-ord{flex:none;width:16px;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums;text-align:right}",
      ".tmm-key{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}",
      ".tmm-sum{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12.5px}",
      ".tmm-tags{display:flex;align-items:center;gap:5px;flex:none}",
      ".tmm-tag{padding:1px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap}",
      ".tmm-tag.is-default{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}",
      ".tmm-actions{display:flex;align-items:center;gap:2px;flex:none;opacity:0;transition:opacity 160ms ease}",
      ".tmm-item:hover .tmm-actions,.tmm-item:focus-within .tmm-actions{opacity:1}",
      // 编辑器内的操作按钮必须常显：渠道绑定行不是 .tmm-item 的子节点，
      // 2026-10-20 用户实报「成员渠道没办法删除」——按钮在，但被 opacity:0 藏成了空白。
      ".tmm-editor .tmm-actions{opacity:1}",
      ".tmm-binding:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".tmm-binding-head .tmm-icon{width:22px;height:22px}",
      "@media (hover:none){.tmm-actions{opacity:1}}",

      // ── 按钮 / 输入 ─────────────────────────────────────────
      ".tmm-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;padding:0 12px;border:1px solid var(--dsw-alias-button-primary-fill);border-radius:8px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:12.5px;font-weight:550;cursor:pointer;white-space:nowrap;transition:opacity 160ms ease}",
      ".tmm-btn:hover:not(:disabled){opacity:.88}",
      ".tmm-btn:active:not(:disabled){opacity:.78}",
      ".tmm-btn:disabled{opacity:.4;cursor:not-allowed}",
      ".tmm-btn.is-quiet{border-color:var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}",
      ".tmm-btn.is-quiet:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);opacity:1}",
      ".tmm-btn.is-icon{min-height:26px;width:26px;padding:0;border-color:transparent;background:transparent;color:var(--dsw-alias-label-tertiary)}",
      ".tmm-btn.is-icon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);opacity:1}",
      ".tmm-btn.is-icon.is-danger{color:var(--dsw-alias-state-error-primary)}",
      ".tmm-btn.is-icon.is-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}",
      ".tmm-btn.is-icon.is-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary)}",
      ".tmm-icon{flex:none;display:block}",
      ".tmm-chev{transition:transform 160ms ease}",
      ".tmm-open>.tmm-chev,.tmm-open .tmm-chev{transform:rotate(90deg)}",
      ".tmm-input,.tmm-select{box-sizing:border-box;min-height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;transition:border-color 160ms ease}",
      ".tmm-input::placeholder{color:var(--dsw-alias-label-caption)}",
      ".tmm-input:hover:not(:disabled),.tmm-select:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}",
      ".tmm-input:disabled,.tmm-select:disabled{opacity:.5;cursor:not-allowed}",
      ".tmm-input.is-w{width:220px}.tmm-input.is-ws{width:130px}.tmm-input.is-wxs{width:80px}",
      ".tmm-select{padding-right:22px}",
      ".tmm-check{flex:none;width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}",

      // ── 展开后的表单 ────────────────────────────────────────
      ".tmm-editor{padding:12px 14px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}",
      ".tmm-editor:last-child{border-bottom:0}",
      ".tmm-fs{display:flex;flex-direction:column;gap:8px}",
      ".tmm-fs+.tmm-fs{margin-top:14px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1)}",
      ".tmm-fs-title{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11.5px;font-weight:550;letter-spacing:.3px}",
      ".tmm-grid{display:flex;align-items:flex-end;gap:10px 12px;flex-wrap:wrap}",
      ".tmm-field{display:flex;flex-direction:column;gap:4px;min-width:0}",
      ".tmm-field>span{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:14px}",
      ".tmm-field.is-inline{flex-direction:row;align-items:center;gap:7px;padding-bottom:6px}",
      ".tmm-field.is-inline>span{font-size:12.5px;color:var(--dsw-alias-label-primary)}",
      ".tmm-days{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-bottom:5px}",
      ".tmm-day{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".tmm-rule-of{display:flex;align-items:center;gap:8px}",
      ".tmm-empty{display:flex;flex-direction:column;gap:4px;padding:16px 14px;color:var(--dsw-alias-label-tertiary);font-size:12.5px}",
      ".tmm-empty strong{color:var(--dsw-alias-label-secondary);font-weight:550}",
      ".tmm-skel{height:12px;margin:14px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);animation:tmm-pulse 1.2s ease-in-out infinite}",
      "@keyframes tmm-pulse{0%,100%{opacity:1}50%{opacity:.55}}",

      // ── 用量图表（横条 + 小时柱，纯 CSS，无图表库）────────────
      ".tmm-usage{display:flex;flex-direction:column;gap:10px;padding:12px 0}",
      ".tmm-usage-sum{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding:0 14px}",
      ".tmm-usage-total{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}",
      ".tmm-chart-title{padding:0 14px 6px;color:var(--dsw-alias-label-tertiary);font-size:11.5px}",
      ".tmm-ubar{display:flex;align-items:center;gap:8px;padding:3px 14px;font-size:12px}",
      ".tmm-ubar-name{flex:none;width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px}",
      ".tmm-ubar-track{flex:1;min-width:40px;height:8px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}",
      ".tmm-ubar-fill{display:block;height:100%;border-radius:4px;background:var(--dsw-alias-state-business-primary)}",
      ".tmm-ubar-num{flex:none;width:58px;text-align:right;font-variant-numeric:tabular-nums}",
      ".tmm-ubar-meta{flex:none;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px}",
      ".tmm-ubar.is-member{cursor:default;border-radius:5px}",
      ".tmm-ubar.is-member.is-open{background:var(--dsw-alias-bg-layer-2)}",
      ".tmm-ubar.is-member .tmm-ubar-name{cursor:pointer;display:flex;align-items:center;gap:3px}",
      ".tmm-ubar.is-child{padding-left:30px;font-size:11.5px;opacity:.9}",
      ".tmm-ubar.is-child .tmm-ubar-name{width:180px;color:var(--dsw-alias-label-secondary)}",
      ".tmm-ubar.is-child .tmm-ubar-track{height:6px}",
      ".tmm-ubar.is-child .tmm-ubar-fill{background:var(--dsw-alias-label-tertiary)}",
      ".tmm-hours{display:flex;align-items:flex-end;gap:2px;height:54px;padding:0 14px}",
      ".tmm-hour{flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%;min-width:0}",
      ".tmm-hour-fill{display:block;border-radius:2px 2px 0 0;background:var(--dsw-alias-state-business-primary);min-height:1px}",
      ".tmm-hour-labels{display:flex;justify-content:space-between;padding:4px 14px 0;color:var(--dsw-alias-label-tertiary);font-size:11px}",
      "@media (max-width:600px){.tmm-ubar-name{width:120px}.tmm-ubar-meta{display:none}}",
      // ── 成员 → 渠道绑定（两级缩进）──────────────────────────
      ".tmm-bindings{list-style:none;margin:6px 0 8px;padding:0 0 0 10px;display:flex;flex-direction:column;gap:6px;border-left:2px solid var(--dsw-alias-border-l2)}",
      ".tmm-binding{display:flex;flex-direction:column;gap:4px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2)}",
      ".tmm-binding.is-dim{opacity:.55}",
      ".tmm-binding-head{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}",
      // ── 规则分组卡片 + 关键词胶囊 ──────────────────────────
      ".tmm-group{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);margin:10px 14px;overflow:hidden}",
      ".tmm-group-head{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".tmm-kwrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:10px 12px}",
      ".tmm-kw{display:inline-flex;align-items:center;gap:3px;padding:2px 4px 2px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:18px;white-space:nowrap}",
      ".tmm-kw-main{border:0;background:none;color:inherit;font:inherit;font-size:12px;padding:1px 2px;cursor:pointer;border-radius:4px}",
      ".tmm-kw-main:hover{color:var(--dsw-alias-state-business-primary)}",
      ".tmm-kw.is-open{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-2)}",
      ".tmm-kw-x{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}",
      ".tmm-kw-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}",
      ".tmm-kw-x .tmm-icon{width:10px;height:10px}",
      ".tmm-kw-in{min-height:26px;width:150px;font-size:12px;border-radius:999px;padding:0 10px}",
      ".tmm-group .tmm-item{background:var(--dsw-alias-bg-layer-1)}",
      ".tmm-group .tmm-editor{background:var(--dsw-alias-bg-layer-1)}",
      ".tmm-group .tmm-item:last-child{border-bottom:0}",
      // ── 折叠区（原生 details，键盘可用） ────────────────────
      ".tmm-fold{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}",
      ".tmm-fold>summary{display:flex;align-items:center;gap:8px;min-height:44px;padding:0 14px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;list-style:none;font-size:13px;font-weight:600}",
      ".tmm-fold>summary::-webkit-details-marker{display:none}",
      ".tmm-fold>summary:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".tmm-fold[open]>summary{border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".tmm-fold-body{padding:14px;display:flex;flex-direction:column;gap:14px}",

      // ── 决策记录 ────────────────────────────────────────────
      ".tmm-trace{display:flex;align-items:baseline;gap:10px;padding:7px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px}",
      ".tmm-trace:last-child{border-bottom:0}",
      ".tmm-trace time{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px}",
      ".tmm-trace .tmm-what{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".tmm-trace .tmm-why{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11.5px;max-width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".tmm-is-ok{color:var(--dsw-alias-state-success-primary)}",
      ".tmm-is-switch{color:var(--dsw-alias-state-warn-primary)}",
      ".tmm-is-bad{color:var(--dsw-alias-state-error-primary)}",
      ".tmm-is-idle{color:var(--dsw-alias-label-tertiary)}",
      ".tmm-scroll{max-height:320px;overflow:auto;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}",
      ".tmm-scroll::-webkit-scrollbar{width:10px;height:10px}",
      ".tmm-scroll::-webkit-scrollbar-thumb{border:3px solid transparent;border-radius:8px;background:var(--dsw-alias-scrollbar-bg-l2);background-clip:content-box}",
      ".tmm-scroll::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2);background-clip:content-box}",

      // ── 粘性保存栏 ──────────────────────────────────────────
      ".tmm-bar{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-overlay);box-shadow:0 6px 16px rgb(0 0 0 / 8%)}",
      ".tmm-bar .tmm-state{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11.5px;font-variant-numeric:tabular-nums}",
      ".tmm-ok{color:var(--dsw-alias-state-success-primary);font-size:12.5px}",
      ".tmm-warn{color:var(--dsw-alias-state-warn-primary);font-size:12.5px}",
      ".tmm-err{color:var(--dsw-alias-state-error-primary);font-size:12.5px}",
      "@media (max-width:600px){.tmm-key{max-width:44%}.tmm-tags{display:none}.tmm-input.is-w{width:100%}}",

      // ── 团队菜单（Header Action & 弹窗）─────────────────────
      ".tmm-team-trigger{display:inline-flex;align-items:center;gap:5px;min-height:28px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;transition:all 150ms ease}",
      ".tmm-team-trigger:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".tmm-team-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
      ".tmm-team-trigger:disabled{opacity:.45;cursor:not-allowed}",
      ".tmm-team-popup{position:fixed;z-index:1100;box-sizing:border-box;width:min(450px,calc(100vw - 16px));max-height:min(580px,calc(100vh - 16px));overflow-y:auto;overscroll-behavior:contain;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 32px rgba(0,0,0,.28);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:1.5}",
      ".tmm-team-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".tmm-team-head h2{margin:0;font-size:14.5px;font-weight:600;display:flex;align-items:center;gap:6px}",
      ".tmm-team-close{width:26px;height:26px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:16px;line-height:1;display:flex;align-items:center;justify-content:center}",
      ".tmm-team-close:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".tmm-team-close:disabled{opacity:.4;cursor:not-allowed}",
      ".tmm-team-region{padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);margin-bottom:10px}",
      ".tmm-team-region-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:4px}",
      ".tmm-team-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin:4px 0}",
      ".tmm-team-warn{font-size:11.5px;color:var(--dsw-alias-state-warn-primary);margin:4px 0}",
      ".tmm-team-err{font-size:11.5px;color:var(--dsw-alias-state-error-primary);margin:4px 0}",
      ".tmm-team-ok{font-size:11.5px;color:var(--dsw-alias-state-success-primary, #10b981);margin:4px 0}",
      ".tmm-team-grid{display:flex;flex-direction:column;gap:6px}",
      ".tmm-team-row{display:flex;align-items:flex-end;gap:8px;margin-top:6px;flex-wrap:wrap}",
      ".tmm-shared-picker{container-type:inline-size}",
      ".tmm-shared-provider{width:100%;margin-top:0}",
      ".tmm-shared-provider .tmm-team-field{flex:1 1 auto;min-width:0}",
      ".tmm-shared-models{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:8px}",
      ".tmm-shared-models .tmm-team-field{min-width:0;width:100%}",
      ".tmm-shared-picker .tmm-team-select{min-width:0;text-overflow:ellipsis}",
      "@container (max-width:360px){.tmm-shared-models{grid-template-columns:minmax(0,1fr)}}",
      ".tmm-team-field{display:flex;flex-direction:column;gap:3px;flex:1 1 150px;min-width:130px}",
      ".tmm-team-provider{flex:0 0 190px}",
      ".tmm-team-model{flex:1 1 170px}",
      ".tmm-team-effort{flex:0 0 160px}",
      ".tmm-team-field label{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      ".tmm-team-select{box-sizing:border-box;width:100%;height:30px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}",
      ".tmm-team-select:focus-visible{border-color:var(--dsw-alias-brand-primary)}",
      ".tmm-team-select:disabled{opacity:.45;cursor:not-allowed}",
      ".tmm-team-btns{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}",
      ".tmm-team-effort{flex:0 0 150px;min-width:130px}",
      ".tmm-team-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:28px;padding:0 12px;border-radius:6px;font:inherit;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;transition:opacity 140ms ease}",
      ".tmm-team-btn.is-primary{border:1px solid transparent;background:var(--dsw-alias-brand-primary);color:#fff}",
      ".tmm-team-btn.is-quiet{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}",
      ".tmm-team-btn:hover:not(:disabled){opacity:.85}",
      ".tmm-team-btn:disabled{opacity:.4;cursor:not-allowed}",
      ".tmm-team-link{border:0;background:none;padding:0;color:var(--dsw-alias-brand-primary);cursor:pointer;font:inherit;font-size:11.5px;text-decoration:underline}",
      ".tmm-team-link:hover:not(:disabled){opacity:.8}",
      ".tmm-team-link:disabled{opacity:.4;cursor:not-allowed;text-decoration:none}",
      ".tmm-team-member{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);margin-bottom:8px}",
      ".tmm-team-member-head{display:flex;align-items:center;gap:6px;margin-bottom:4px}",
      ".tmm-team-member-name{font-weight:600;font-size:12.5px}",
      ".tmm-team-tag{display:inline-flex;align-items:center;padding:1px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);line-height:16px}",
      ".tmm-team-tag.is-running{border-color:var(--dsw-alias-state-success-primary, #10b981);color:var(--dsw-alias-state-success-primary, #10b981)}",
      ".tmm-team-tag.is-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}",
      ".tmm-team-route-info{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin:4px 0}",
      ".tmm-team-route-val{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px}",
    ].join("\n");

    // 样式注入：ModuleLoader 的 factory 不会自动带上样式，必须自己建 <style> 标签
    // （官方客户端插件与 dsh-skills-hub 都是这个做法）。用 data-plugin-css 去重，
    // 热重载或重复挂载时不会叠出多份。0.2.1 首版漏了这一步，页面全是浏览器默认样式。
    (function injectCss() {
      if (typeof document === "undefined" || document.head === null) return;
      var tagId = "dsh-team-member-model/settings.css";
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-team-member-model";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    })();

    // ---------------------------------------------------------------------
    // 图形：自绘 SVG（统一 1.5 描边 / 14px / currentColor）
    // ---------------------------------------------------------------------

    var PATHS = {
      chev: "M6 3.5l4.5 4.5L6 12.5",
      up: "M7.5 12V3.8M4 7.3l3.5-3.5L11 7.3",
      down: "M7.5 3v8.2M4 7.7l3.5 3.5L11 7.7",
      close: "M4 4l6 6M10 4l-6 6",
      plus: "M7.5 3.5v8M3.5 7.5h8",
      info: "M7.5 10.5V7M7.5 4.9h.01",
      gear: "M7.5 5.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm4.8 2a4.9 4.9 0 0 0-.1-.7l1.1-.9-.8-1.4-1.3.4a4.8 4.8 0 0 0-1.1-.7l-.2-1.4H8.4l-.2 1.4c-.4.2-.8.4-1.1.7l-1.3-.4-.8 1.4 1.1.9a4.9 4.9 0 0 0-.1.7c0 .2 0 .5.1.7l-1.1.9.8 1.4 1.3-.4c.3.3.7.5 1.1.7l.2 1.4h1.6l.2-1.4c.4-.2.8-.4 1.1-.7l1.3.4.8-1.4-1.1-.9c.1-.2.1-.5.1-.7z",
    };

    /**
     * 画一个图标。用自绘 SVG 而不是 Unicode 字符：字符图标在不同字体下形状与基线都会漂。
     *
     * @param {string} name - PATHS 里的键。
     * @param {string} [className] - 追加的类名。
     * @returns {object} React 元素。
     */
    function icon(name, className) {
      return h(
        "svg",
        {
          className: "tmm-icon" + (className === undefined ? "" : " " + className),
          viewBox: "0 0 15 15",
          width: 14,
          height: 14,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
        },
        h("path", { d: PATHS[name] }),
      );
    }

    // ---------------------------------------------------------------------
    // 纯函数（导出给回归测试；Host 半侧的权威版本在 lib/rules.js）
    // ---------------------------------------------------------------------

    function keyOf(provider, model) {
      return provider + "/" + model;
    }

    /**
     * 绑定的键：`provider/model[:effort]`（渠道级身份，rest/sink/用量归属用）。
     */
    function bindingKeyOf(binding) {
      var base = keyOf(binding.provider, binding.model);
      return binding.reasoningEffort ? base + ":" + binding.reasoningEffort : base;
    }

    /**
     * 成员身份键（v4）：成员的**固定名字**。
     *
     * 与 keyOf/bindingKeyOf 分开：推理档缓存、目录下拉按模型记；规则、一键换、摘除
     * 全部按**成员名**记；rest/sink 按**绑定键**记（渠道级）。
     */
    function memberKeyOf(member) {
      if (member && typeof member.name === "string") return member.name;
      // 兜底：老形状（v3 扁平路由）也能显示。
      return member ? bindingKeyOf(member) : "";
    }

    /**
     * 合并建议：同一个模型（含档位）出现在多个「单绑定成员」里时，建议合成一个成员。
     *
     * 只在**每个成员恰好一个绑定**且模型/档位完全相同时才建议——多绑定成员参与合并会有歧义，
     * 交给用户自己决定，不替他做主。
     *
     * @param {Array<object>} members - v4 成员表。
     * @returns {Array<{ names: string[], name: string, bindings: Array<object> }>} 建议列表。
     */
    function mergeSuggestions(members) {
      var groups = {};
      (members || []).forEach(function (member) {
        if (!member || !Array.isArray(member.bindings) || member.bindings.length !== 1) return;
        var binding = member.bindings[0];
        if (!binding || !binding.provider || !binding.model) return;
        // 分组只看**模型+档位**：同模型跨渠道才是要合并的对象（provider 不同正是合并的理由）。
        var key = binding.model + (binding.reasoningEffort ? ":" + binding.reasoningEffort : "");
        if (groups[key] === undefined) groups[key] = [];
        groups[key].push(member);
      });
      var suggestions = [];
      Object.keys(groups).forEach(function (key) {
        var list = groups[key];
        if (list.length < 2) return;
        var bindings = list.map(function (member) { return member.bindings[0]; });
        var name = key;
        // 名字不能和已有成员撞车（撞了就换个后缀，避免保存时被 Host 拒）。
        var taken = {};
        (members || []).forEach(function (member) { taken[memberKeyOf(member)] = true; });
        var suffix = 2;
        var candidate = name;
        while (taken[candidate] === true) { candidate = name + "-" + suffix; suffix += 1; }
        suggestions.push({ names: list.map(memberKeyOf), name: candidate, bindings: bindings });
      });
      return suggestions;
    }

    /**
     * 执行合并：把若干成员合成一个，并把引用它们的地方改到新名字。
     *
     * @param {Array<object>} members - 成员表。
     * @param {Array<object>} rules - 规则表。
     * @param {string} pick - 一键换目标。
     * @param {Array<string>} off - 摘除名单。
     * @param {{names: string[], name: string, bindings: Array<object>}} suggestion - 一条合并建议。
     * @returns {{members: Array, rules: Array, pick: string|null, off: Array<string>}} 新草稿片段。
     */
    function applyMerge(members, rules, pick, off, suggestion) {
      var merged = { name: suggestion.name, bindings: suggestion.bindings.slice() };
      // 权重取被合并成员里的最大值：合并后流量只增不减，不该因为合并而降权。
      var weights = [];
      (members || []).forEach(function (member) {
        if (suggestion.names.indexOf(memberKeyOf(member)) === -1) return;
        if (typeof member.weight === "number" && member.weight > 0) weights.push(member.weight);
      });
      if (weights.length > 0) merged.weight = Math.max.apply(null, weights);
      var nextMembers = (members || []).filter(function (member) { return suggestion.names.indexOf(memberKeyOf(member)) === -1; });
      nextMembers.push(merged);
      var rename = function (ref) { return suggestion.names.indexOf(ref) === -1 ? ref : suggestion.name; };
      return {
        members: nextMembers,
        rules: (rules || []).map(function (rule) { return Object.assign({}, rule, { use: rename(rule.use) }); }),
        pick: pick === null || pick === undefined ? pick : rename(pick),
        off: (off || []).map(rename).filter(function (ref, index, list) { return list.indexOf(ref) === index; }),
      };
    }

    /**
     * 规则 → 一句中文摘要。与 lib/rules.js 的 describeRule 同义，
     * 由 test/client.mjs 对若干样例做一致性比对，防止两边漂移。
     */
    function describeRule(rule) {
      var parts = [];
      if (rule.pause === true) {
        // 与 lib/rules.js 的 describeRule 逐字同义（test/client.mjs 有一致性比对）。
        var paused = ["停用 " + rule.use];
        if (rule.channel !== undefined) paused.push("通道 " + rule.channel);
        if (rule.continuable === true) paused.push("仅团队成员/后台");
        if (rule.continuable === false) paused.push("仅一次性子代理");
        if (rule.folders !== undefined) paused.push("目录 " + rule.folders.join(" , "));
        if (rule.exceptFolders !== undefined) paused.push("目录不含 " + rule.exceptFolders.join(" , "));
        if (rule.time !== undefined) paused.push(timeText(rule.time));
        return paused.length === 1 ? paused[0] + "（无条件）" : paused.join(" · ");
      }
      parts.push("→ " + rule.use);
      if (rule.channel !== undefined) parts.push("通道 " + rule.channel);
      if (rule.continuable === true) parts.push("仅团队成员/后台");
      if (rule.continuable === false) parts.push("仅一次性子代理");
      if (rule.label !== undefined) parts.push("标签 " + rule.label);
      if (rule.member !== undefined) parts.push("成员名 " + rule.member);
      if (rule.intent !== undefined) parts.push("意图 " + rule.intent);
      if (rule.folders !== undefined) parts.push("目录 " + rule.folders.join(" , "));
      if (rule.exceptFolders !== undefined) parts.push("目录不含 " + rule.exceptFolders.join(" , "));
      if (rule.tokens !== undefined) parts.push("父会话 ≥" + rule.tokens + " tokens");
      if (rule.effort !== undefined) parts.push("推理档 " + rule.effort);
      if (rule.images !== undefined) parts.push(rule.images ? "带图" : "不带图");
      if (rule.time !== undefined) parts.push(timeText(rule.time));
      return parts.join(" · ");
    }

    function timeText(time) {
      var days = time.days === undefined ? "" : " " + time.days.join("/");
      return "时段 " + time.from + "–" + time.to + days;
    }

    /**
     * 判断 Host 半侧是哪一版。
     *
     * 为什么必须判：客户端半侧每次刷新都从磁盘取（是新的），Host 半侧只在**进程启动**时加载模块
     * （是旧的）。这个混合状态下页面长得是新的、接口却是 0.2.1 的，用户只会看到一句
     * 「unknown action」——2026-10-16 用户就是这样踩到的。分开报清楚，才不会让人去翻日志。
     *
     * @param {object} payload - GET /state 的响应体。
     * @returns {'v3' | 'legacy'} 0.2.1 的 /state 只回 {ok, routes, catalog}，没有 policy 字段。
     */
    function hostSupport(payload) {
      return payload.policy === undefined && Array.isArray(payload.routes) ? "legacy" : "v3";
    }

    /**
     * 后端返回体 → 页面草稿。
     *
     * fallbackCatalog：PUT 的响应只带 policy 不带 catalog（Host 端刻意不再拉一遍目录），
     * 保存成功后必须沿用本次已加载的目录——0.2.1 首版直接用响应体算状态，
     * `payload.catalog || []` 把目录覆盖成空数组，保存一次候选模型就全没了。
     */
    function applyPayload(payload, fallbackCatalog) {
      var policy = payload.policy || {};
      var catalog = payload.catalog !== undefined ? payload.catalog : (fallbackCatalog || []);
      var draft = {
        members: (policy.members || []).slice(),
        rules: (policy.rules || []).slice(),
        match: (policy.match || []).slice(),
        pick: policy.pick === undefined ? null : policy.pick,
        off: (policy.off || []).slice(),
        routing: policy.routing || "order",
        allowFork: policy.allowFork === true,
        failover: {
          enabled: !(policy.failover && policy.failover.enabled === false),
          patience: policy.failover && typeof policy.failover.patience === "number" ? policy.failover.patience : 2,
        },
        classifier: {
          enabled: !!(policy.classifier && policy.classifier.enabled === true),
          provider: (policy.classifier && policy.classifier.provider) || "",
          model: (policy.classifier && policy.classifier.model) || "",
        },
      };
      // Host 半侧版本识别：v4 = 成员带 bindings。旧 Host 只认 v3 扁平成员，
      // 用 v4 编辑器保存会被拒（或更糟：按错形状写进去），所以只读并提示重启。
      var hostVersion = "v4";
      if ((draft.members || []).length > 0 && draft.members[0].bindings === undefined) hostVersion = "v3";
      return {
        loading: false,
        host: hostSupport(payload),
        hostVersion: hostVersion,
        kwDraft: {},
        catalog: catalog,
        members: draft.members,
        rules: draft.rules,
        match: draft.match,
        pick: draft.pick,
        off: draft.off,
        routing: draft.routing,
        allowFork: draft.allowFork,
        failover: draft.failover,
        classifier: draft.classifier,
        trace: payload.trace || [],
        rests: payload.rests || [],
        sink: payload.sink || [],
        status: payload.status,
        // 0.2.1 兼容：老响应形状（只有 routes）也能读。
        routes: (payload.routes || []).slice(),
        saved: JSON.stringify(policyFromDraft(draft)),
      };
    }

    /**
     * 草稿 → PUT /policy 的请求体。
     *
     * 口径：**空值一律不送这个字段**，而不是送空数组/空串。
     * 2026-10-16 用户实报「保存报错：策略：match 若给出必须是非空数组」——就是这里送了
     * `match: []`，而 Host 把「给了就要非空」当校验。清空一格是正常操作，
     * 两边都必须当成「没给这个条件」。
     */
    function policyFromDraft(draft) {
      var body = {
        members: (draft.members || []).map(function (member) {
          var out = {
            name: memberKeyOf(member),
            bindings: (member.bindings || []).map(function (binding) {
              var item = { provider: binding.provider, model: binding.model };
              if (binding.reasoningEffort) item.reasoningEffort = binding.reasoningEffort;
              if (binding.off === true) item.off = true;
              if (binding.time && binding.time.from && binding.time.to) item.time = binding.time;
              return item;
            }),
          };
          if (member.weight !== undefined && member.weight !== "" && Number(member.weight) > 0) out.weight = Number(member.weight);
          return out;
        }),
        rules: (draft.rules || []).map(ruleToPayload),
        off: draft.off || [],
        routing: draft.routing || "order",
        allowFork: draft.allowFork === true,
        failover: {
          enabled: !(draft.failover && draft.failover.enabled === false),
          patience: Number(draft.failover && draft.failover.patience) || 2,
        },
      };
      // pick 用 null 表示「不指定」，是契约里的显式值，照送。
      body.pick = draft.pick || null;
      var match = (draft.match || []).filter(function (item) { return item !== ""; });
      if (match.length > 0) body.match = match;
      // 分类器：关着的时候 provider/model 是空的，空串不送（否则 Host 会拒整份配置）。
      var classifier = { enabled: !!(draft.classifier && draft.classifier.enabled) };
      if (draft.classifier && draft.classifier.provider) classifier.provider = draft.classifier.provider;
      if (draft.classifier && draft.classifier.model) classifier.model = draft.classifier.model;
      body.classifier = classifier;
      return body;
    }

    /**
     * 目录下拉的选项（provider 或 model 通用）。
     *
     * 「当前值保护」是关键：provider/model 可能是目录里没有的值（适配器没公布、或手填过），
     * 直接渲染 select 会把当前值悄悄清空——和推理档下拉同一个坑，这里一并防住。
     *
     * @param {Array<{value: string, label: string}>} list - 目录项。
     * @param {string} current - 当前值。
     * @param {string} emptyLabel - 空选项的文案。
     * @returns {Array<{value: string, label: string}>}
     */
    function catalogOptions(list, current, emptyLabel) {
      var options = [{ value: "", label: emptyLabel }];
      var seen = {};
      (list || []).forEach(function (item) {
        seen[item.value] = true;
        options.push(item);
      });
      if (current && !seen[current]) options.push({ value: current, label: current + "（当前值，目录未列出）" });
      return options;
    }

    /**
     * 保存请求体 → 「目录通配」输入框的回填文本。
     *
     * 单独提成纯函数是因为 2026-10-16 真机炸过一次：`policyFromDraft` 改成「空值不送字段」后，
     * save() 的成功回调里仍是 `body.match.join(", ")` —— match 为空时字段整个不存在，
     * undefined.join 当场抛「Cannot read properties of undefined (reading 'join')」。
     * 保存其实已经成功，炸的是保存后的回填。这里对空值显式兜底，并用测试钉死。
     *
     * @param {object} body - policyFromDraft 的返回值。
     * @returns {string} 逗号分隔的展示文本。
     */
    function matchTextOf(body) {
      return (((body && body.match) || []).join(", "));
    }

    /**
     * token 数的可读格式（图表里不写满屏数字）：999 / 12.3K / 1.23M。
     */
    function formatTokens(value) {
      var n = typeof value === "number" && isFinite(value) ? value : 0;
      if (n < 1000) return String(n);
      if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + "K";
      return (n / 1e6).toFixed(2) + "M";
    }

    /**
     * 条形宽度百分比。极小但非零的值给 1%——否则「有量但看不见」会被误读成 0。
     */
    function barPercent(value, max) {
      if (!(max > 0)) return 0;
      var pct = (value / max) * 100;
      if (value > 0 && pct < 1) return 1;
      return Math.min(100, pct);
    }

    /** 用量行排序（不改原数组）；键相同时按成员名稳定排序。 */
    function sortUsageRows(rows, key) {
      return (rows || []).slice().sort(function (a, b) {
        return (b[key] || 0) - (a[key] || 0) || (a.member < b.member ? -1 : 1);
      });
    }

    /**
     * 分类器的状态提示（不拦保存，只把后果说清楚）。
     *
     * @param {object} classifier - 草稿里的分类器。
     * @param {Array<object>} rules - 当前规则表。
     * @returns {{level: 'warn'|'info', text: string} | null} null = 无需提示。
     */
    function classifierNotice(classifier, rules) {
      var enabled = !!(classifier && classifier.enabled);
      var complete = !!(classifier && classifier.provider && classifier.model);
      var intentRules = (rules || []).filter(function (rule) { return rule.intent !== undefined && rule.intent !== ""; }).length;
      if (enabled && !complete) {
        return { level: "warn", text: "已开启但 provider / model 没填全：规则里的「意图」条件不会命中（配置本身会正常保存）。" };
      }
      if (!enabled && intentRules > 0) {
        return { level: "warn", text: "有 " + intentRules + " 条规则带「意图」条件，但分类器没开：这些条件永远不会命中。" };
      }
      if (enabled && complete) {
        return { level: "info", text: "已开启：每次创建子 agent 多一次分类调用（按任务文本缓存结果）。" };
      }
      return null;
    }

    /** 驱动来源的中文名（图 1/图 3 的小字用）。 */
    function usageSourceText(reason) {
      var names = {
        rule: "规则", weight: "权重轮转", rotate: "轮转", order: "顺序", affinity: "亲和",
        explicit: "显式指定", pick: "手动指定", unmanaged: "未纳管", unknown: "未知",
      };
      return names[reason] || String(reason);
    }

    /** 图表里的短成员名（省掉中间，保留 provider 与档位）。 */
    function shortMember(member) {
      var text = String(member || "");
      return text.length > 34 ? text.slice(0, 16) + "…" + text.slice(-15) : text;
    }

    /**
     * 这条规则是不是「纯关键词规则」（只有 use + 单个整词通配 label）。
     *
     * 分组视图只把这类规则渲染成胶囊；带任何其它条件（通道/目录/时段/图片…）的
     * 一律走完整编辑器，避免胶囊表达不了的字段被悄悄丢掉。
     */
    function isLabelRule(rule) {
      if (rule === undefined || rule === null || rule.use === undefined) return false;
      if (typeof rule.label !== "string" || !/^\*[^*]+\*$/.test(rule.label)) return false;
      var extras = ["channel", "continuable", "member", "folders", "exceptFolders", "tokens",
        "effort", "images", "intent", "time", "pause", "from", "to", "days"];
      for (var i = 0; i < extras.length; i += 1) {
        if (rule[extras[i]] !== undefined) return false;
      }
      return true;
    }

    /**
     * 规则按目标成员分组（保持首次出现的顺序 = 命中优先级的近似展示）。
     *
     * @param {Array<object>} rules - 已保存的规则数组。
     * @returns {Array<{use: string, labelRules: Array<{index: number, word: string}>, specialRules: Array<{index: number, rule: object}>}>}
     */
    function groupRules(rules) {
      var order = [];
      var byUse = {};
      (rules || []).forEach(function (rule, index) {
        var key = rule.use === undefined ? "" : rule.use;
        var group = byUse[key];
        if (group === undefined) {
          group = { use: key, labelRules: [], specialRules: [] };
          byUse[key] = group;
          order.push(group);
        }
        if (isLabelRule(rule)) group.labelRules.push({ index: index, word: rule.label.slice(1, -1) });
        else group.specialRules.push({ index: index, rule: rule });
      });
      return order;
    }

    /**
     * 给某个成员加关键词时，新规则应该插到哪个下标。
     *
     * 顺序就是命中优先级，所以必须插在「兜底类规则」（continuable / pause）之前；
     * 同成员的关键词规则挨在一起，插在它们的末尾。没有同组成员时插到第一个兜底规则前。
     */
    function keywordInsertIndex(rules, use) {
      var lastLabel = -1;
      var firstCatch = rules.length;
      for (var i = 0; i < rules.length; i += 1) {
        var rule = rules[i];
        var isCatch = rule.continuable !== undefined || rule.pause === true;
        if (isCatch && i < firstCatch) firstCatch = i;
        if (rule.use === use && isLabelRule(rule)) lastLabel = i;
      }
      if (lastLabel !== -1) return lastLabel + 1;
      if (firstCatch < rules.length) return firstCatch;
      return rules.length;
    }

    /**
     * 保存前的本地校验：能在页面上说清的问题，不要等 Host 回一句 bitmask 式的报错。
     *
     * @param {object} draft - 当前草稿。
     * @returns {string} 错误文案；空串表示可以提交。
     */
    function validateDraft(draft) {
      var rules = draft.rules || [];
      for (var i = 0; i < rules.length; i += 1) {
        var use = typeof rules[i].use === "string" ? rules[i].use.trim() : "";
        if (use === "") return "第 " + (i + 1) + " 条规则没有选「命中后用哪个成员」。";
        if (rules[i].pause === true && use.indexOf("/") === -1) {
          return "第 " + (i + 1) + " 条规则勾了「仅摘除该成员」，请选一个具体的成员（provider/model）。";
        }
      }
      // v4 成员：名字必填且唯一、每个成员至少一个绑定、每个绑定 provider/model 必填。
      var seenNames = {};
      for (var index = 0; index < (draft.members || []).length; index += 1) {
        var member = draft.members[index];
        var name = memberKeyOf(member);
        if (!name) return "第 " + (index + 1) + " 个成员没有名字：成员名是规则的引用目标，必须填。";
        if (/[\s,]/.test(name)) return "成员名「" + name + "」不能包含空格或逗号。";
        if (seenNames[name] === true) return "成员名「" + name + "」重复了，成员名必须唯一。";
        seenNames[name] = true;
        if (!Array.isArray(member.bindings) || member.bindings.length === 0) {
          return "成员「" + name + "」至少要有一个渠道×模型绑定。";
        }
        for (var b = 0; b < member.bindings.length; b += 1) {
          if (!member.bindings[b].provider || !member.bindings[b].model) {
            return "成员「" + name + "」第 " + (b + 1) + " 个绑定缺少 provider 或 model。";
          }
        }
      }
      // 规则的 use 必须指向存在的成员（Host 会静默跳过找不到的规则，这里先说清）。
      for (var r = 0; r < (draft.rules || []).length; r += 1) {
        var use = (draft.rules[r] || {}).use;
        if (!use) return "第 " + (r + 1) + " 条规则没有指定成员。";
        if (seenNames[use] !== true) {
          return "第 " + (r + 1) + " 条规则指向的成员「" + use + "」不在成员表里。";
        }
      }
      // 分类器填不全**不拦保存**：Host 接受这种配置（只是意图条件不命中），
      // 客户端却因此拒绝整份策略提交 —— 2026-10-19 用户实报「分类器无法保存、刷新全丢」，
      // 根因就是这条：整次 PUT 一个字节都没发出去，别处的改动跟着一起没了。
      // 现在改成保存照发 + 在字段旁边常驻提示（见 classifierWarning）。
      return "";
    }

    /** 规则草稿 → 请求体：空串一律不送（Host 端把空串当非法输入拒绝）。 */
    function ruleToPayload(rule) {
      var out = {};
      var use = typeof rule.use === "string" ? rule.use.trim() : "";
      if (rule.pause === true) out.pause = true;
      if (use !== "") out.use = use;
      var channel = typeof rule.channel === "string" ? rule.channel.trim() : "";
      if (channel !== "") out.channel = channel;
      if (rule.continuable === true || rule.continuable === false) out.continuable = rule.continuable;
      // 纯空白要当作「没填」：否则 Host 会以「必须是非空字符串」整份拒绝保存，
      // 用户在页面上只会看到一句对不上输入框的报错。
      ["label", "member", "intent"].forEach(function (field) {
        var text = typeof rule[field] === "string" ? rule[field].trim() : "";
        if (text !== "") out[field] = text;
      });
      ["folders", "exceptFolders"].forEach(function (field) {
        var list = textList(rule[field]);
        if (list.length > 0) out[field] = list;
      });
      if (rule.tokens !== undefined && rule.tokens !== "" && Number(rule.tokens) >= 0) out.tokens = Number(rule.tokens);
      var effort = typeof rule.effort === "string" ? rule.effort.trim() : "";
      if (effort !== "") out.effort = effort;
      if (rule.images === true || rule.images === false) out.images = rule.images;
      if (rule.from && rule.to) {
        var time = { from: rule.from, to: rule.to };
        if (rule.days && rule.days.length > 0) time.days = rule.days.slice();
        out.time = time;
      }
      return out;
    }

    /**
     * 推理档下拉的选项。
     *
     * @param {object|undefined} bank - Host 返回的 {efforts, defaultEffort, supported, error}。
     * @param {string} current - 当前值（可能是目录没公布的手工值，必须保留成一个选项，否则一打开就被清空）。
     * @returns {Array<{value: string, label: string}>} 第一项永远是「用模型默认」。
     */
    function effortOptions(bank, current) {
      var efforts = (bank && bank.efforts) || [];
      var fallback = "用模型默认";
      if (efforts.length > 0) fallback += "（" + (bank.defaultEffort ? bank.defaultEffort : "未公布默认") + "）";
      var options = [{ value: "", label: fallback }];
      var seen = {};
      efforts.forEach(function (effort) {
        seen[effort.id] = true;
        var label = effort.id + (bank.defaultEffort === effort.id ? "（默认）" : "");
        if (effort.name && effort.name !== effort.id) label += " · " + effort.name;
        options.push({ value: effort.id, label: label });
      });
      if (current && !seen[current]) options.push({ value: current, label: current + "（当前值，模型未公布）" });
      return options;
    }

    /** 推理档字段下方那句说明：把「为什么是这几项」讲清楚，而不是让用户猜。 */
    function effortHint(bank) {
      if (bank === undefined || bank.status === "loading") return "正在读取该模型可配的推理档…";
      if (bank.status === "error") return "读取推理档失败：" + bank.error + "（可以手工填）";
      if (bank.supported === false) return "LLM 服务不可用，读取不到推理档（可以手工填）";
      if ((bank.efforts || []).length === 0) {
        return bank.error === undefined
          ? "该模型没有公布推理档（留空即用模型默认；适配器也可能接受未公布的档位，可手工填）"
          : "读不到该模型的推理档：" + bank.error + "（可以手工填）";
      }
      return "该模型公布的推理档：" + bank.efforts.map(function (effort) {
        return effort.id + (bank.defaultEffort === effort.id ? "（默认）" : "");
      }).join(" / ");
    }

    /** 逗号 / 分号 / 换行分隔的输入 → 去空数组。 */
    function textList(value) {
      if (Array.isArray(value)) return value;
      if (typeof value !== "string") return [];
      return value
        .split(/[,;\n]/)
        .map(function (item) { return item.trim(); })
        .filter(function (item) { return item !== ""; });
    }

    // ---------------------------------------------------------------------
    // 远程通道：官方 @deepseek-ai/dsh-client-connection 的 connection.rpc
    // ---------------------------------------------------------------------
    // 为什么不再自己 fetch /api/...：设置页 shell 可能由本机或远端反代提供，而「这次写该落到
    // 哪台 Host」只有当前 DSH 会话的连接通道知道。页面自己拼 /api 会写到错误的 origin——
    // 本地看着成功，真正跑着的远端一点没变。
    //
    // 唯一 envelope（与 Host 半侧一致，已冻结）：
    //   { ok:true, value:{ status, body } }   业务结果，body 就是原 HTTP JSON
    //   { ok:false, error:{ code, message } } 传输/认证失败（官方 throw 同属这一类）
    // 独立官方 RPC channel：/api 是 api-gateway 的单槽 interceptor，第三方业务用
    // connection.rpc.handle('/<业务名>') 自挂路由；Host 半侧同值（team-member-model 0.7.8+）。
    var RPC_CHANNEL = "/dsh-team-member-model";
    // RPC namespace 必须与 Host 的 HTTP prefix `/api/dsh-team-member-model` 分开：
    // 官方 webServer 最长 prefix 优先，若 endpoint 也叫 dsh-team-member-model/*，
    // POST 会先落到 Host 自己的 HTTP prefix 上被判 405（0.7.6 线上故障）。
    var RPC_PREFIX = "team-member-model/";
    // 冻结的 7 个端点。true = 写操作：失败时结果「未确认」，绝不能当成「没发生」。
    var RPC_OPS = {
      state: false, efforts: false, usage: false, teams: false,
      savePolicy: true, saveTeam: true, resetUsage: true,
    };

    // 只记插件 ctx：connection 会随重连/换远端换掉，每次请求现读（绝不缓存第一个连接对象）。
    var pluginCtx = null;

    function noConnection(cause) {
      var err = new Error("当前 DSH 没有可用的官方连接通道（connection.rpc），模型设置无法读写：请升级 DSH 并重新打开页面");
      err.code = "NO_CONNECTION";
      if (cause) err.cause = cause;
      return err;
    }

    /** 当前 connection.rpc；没有就明确报错。任何情况下都不退回本页 fetch。 */
    function currentRpc() {
      if (pluginCtx === null) throw noConnection();
      var connection;
      try {
        connection = pluginCtx.connection;
      } catch (cause) {
        throw noConnection(cause); // 依赖没注入：说明是 SDK 版本/组合包问题
      }
      var rpc = connection && connection.rpc;
      if (!rpc || typeof rpc.call !== "function") throw noConnection();
      return rpc;
    }

    /** 404 最常见的成因是 Host 半侧没加载（客户端半侧仍会渲染，页面出现 ≠ 功能可用）。 */
    function withHint(text) {
      return text.indexOf("HTTP 404") !== -1 ? text + "（接口不存在：Host 半侧可能未加载）" : text;
    }

    /** 传输层失败统一 NETWORK_ERROR；写操作外加 unknown（结果未确认），读操作不标。 */
    function transportFailure(cause, write) {
      var text = withHint(String((cause && cause.message) || cause || "连接通道不可用"));
      var err = new Error(text);
      err.code = "NETWORK_ERROR";
      if (write === true) err.unknown = true;
      return err;
    }

    /**
     * 官方 outer error 分三类，不能一锅端成「网络失联」：
     *   1. 明确拒绝（401/403 或 unauthorized/forbidden）：认证没过，写确定没发生
     *      → 已知失败，unknown=false，code 用官方那个。
     *   2. 主动取消（aborted）：调用方 signal 已取消，Host 根本没执行
     *      → 标 cancelled，也是已知未执行，绝不能算「可能已写入」。
     *   3. 其余（断连/网关内部错/无法确认是否落地）：写操作标 unknown=true，
     *      但官方 code 原样保留（rpcCode），免得把可诊断的信息藏起来。
     */
    function outerFailure(rpcError, write) {
      var failure = rpcError || {};
      var details = failure.details || {};
      var status = typeof details.status === "number" ? details.status : undefined;
      var denied = status === 401 || status === 403 || failure.code === "unauthorized" || failure.code === "forbidden";
      var aborted = failure.code === "aborted";
      var err = new Error(withHint(failure.message || (denied ? "连接认证失败" : aborted ? "请求已取消" : "连接通道不可用")));
      err.rpcCode = failure.code;
      err.details = failure.details;
      if (status !== undefined) err.status = status;
      if (denied) {
        err.code = failure.code || (status === 401 ? "unauthorized" : "forbidden");
        err.unknown = false; // 认证没过：写入确定没发生
        return err;
      }
      if (aborted) {
        err.code = "aborted";
        err.cancelled = true;
        err.unknown = false; // 取消发生在执行之前：不是「可能写了一半」
        return err;
      }
      err.code = "NETWORK_ERROR";
      if (write === true) err.unknown = true;
      return err;
    }

    /**
     * 7 个端点的唯一远程入口，返回原 HTTP JSON（value.body）。
     *
     * 边界写死在这里，调用方不用各自记得：
     *   1. 未知端点 / 没有 connection：当场抛，一个请求都不发（更不会退回页面 fetch）。
     *   2. 业务失败（401/403/409…）：抛带 status 与 Host code 的 Error，绝不自动重试。
     *   3. 传输层失败：NETWORK_ERROR；写操作带 unknown=true，UI 只能说「未确认」。
     *      但认证被否（外层的 401/403）是已知失败：unknown=false。
     */
    async function request(endpoint, payload, signal) {
      var write = RPC_OPS[endpoint];
      if (write === undefined) {
        var bad = new Error("未知的模型设置端点：" + endpoint + "（未发出任何请求）");
        bad.code = "UNKNOWN_ENDPOINT";
        throw bad;
      }
      var caller = currentRpc(); // 现读：连接切到另一台 Host 后必须打到新连接
      var result;
      try {
        result = await caller.call(RPC_CHANNEL, RPC_PREFIX + endpoint, payload || {}, signal);
      } catch (cause) {
        throw transportFailure(cause, write);
      }
      if (!result || result.ok !== true) {
        throw outerFailure(result && result.error, write);
      }
      var value = result.value || {};
      if (typeof value.status !== "number") throw transportFailure("连接通道返回了无法识别的结果", write);
      var body = value.body && typeof value.body === "object" ? value.body : {};
      if (value.status >= 400 || body.ok === false) {
        var error = new Error(body.error || ("HTTP " + value.status));
        if (body.code) error.code = body.code;
        error.status = value.status;
        throw error;
      }
      return body;
    }

    function move(list, index, delta) {
      var next = list.slice();
      var target = index + delta;
      if (target < 0 || target >= next.length) return next;
      var held = next[index];
      next[index] = next[target];
      next[target] = held;
      return next;
    }

    // ---------------------------------------------------------------------
    // 组件
    // ---------------------------------------------------------------------

    function Section() {
      var state = react.useState({
        loading: true, saving: false, error: "", message: "",
        catalog: [], members: [], rules: [], match: [], pick: null, off: [],
        routing: "order", allowFork: false,
        failover: { enabled: true, patience: 2 },
        classifier: { enabled: false, provider: "", model: "" },
        trace: [], rests: [], sink: [], status: undefined, saved: "",
        efforts: {}, host: "v3", kwDraft: {}, usage: undefined, usageSort: "totalTokens", usageOpen: {}, openMember: -1, openRule: -1, addingMember: false,
        manualProvider: "", manualModel: "", matchText: "", hostError: "",
      });
      var snap = state[0];
      var setSnap = state[1];

      function patch(next) {
        setSnap(function (prev) {
          var merged = {};
          for (var k in prev) merged[k] = prev[k];
          for (var j in next) merged[j] = next[j];
          return merged;
        });
      }

      react.useEffect(function () {
        var alive = true;
        request("state", {}).then(function (payload) {
          if (!alive) return;
          var next = applyPayload(payload);
          next.matchText = ((payload.policy && payload.policy.match) || []).join(", ");
          next.message = "";
          next.error = "";
          patch(next);
        }).catch(function (e) {
          if (alive) patch({ loading: false, hostError: String(e && e.message ? e.message : e) });
        });
        // 用量单独取：取不到也不影响页面（Host 半侧可能是旧版本，没有 /usage）。
        request("usage", {}).then(function (payload) {
          if (alive) patch({ usage: payload });
        }).catch(function () {
          if (alive) patch({ usage: null });
        });
        return function () { alive = false; };
      }, []);

      function loadUsage() {
        return request("usage", {}).then(function (payload) {
          patch({ usage: payload, message: "用量已刷新" });
        }).catch(function (e) {
          patch({ error: String(e && e.message ? e.message : e) });
        });
      }

      function resetUsage() {
        request("resetUsage", {}).then(function (payload) {
          patch({ usage: payload, message: "用量已清零" });
        }).catch(function (e) {
          patch({ error: String(e && e.message ? e.message : e) });
        });
      }

      function currentDraft() {
        return {
          members: snap.members, rules: snap.rules,
          match: textList(snap.matchText), pick: snap.pick, off: snap.off,
          routing: snap.routing, allowFork: snap.allowFork,
          failover: snap.failover, classifier: snap.classifier,
        };
      }

      var dirty = JSON.stringify(policyFromDraft(currentDraft())) !== snap.saved;

      function save() {
        var problem = validateDraft(currentDraft());
        if (problem !== "") {
          patch({ error: problem, message: "", saving: false });
          return;
        }
        var body = policyFromDraft(currentDraft());
        patch({ saving: true, error: "", message: "" });
        request("savePolicy", { policy: body })
          .then(function (payload) {
            // PUT 响应不带 catalog：沿用本次已加载的目录，别把候选列表清空。
            var next = applyPayload(payload, snap.catalog);
            next.matchText = matchTextOf(body);
            next.openMember = -1;
            next.openRule = -1;
            next.addingMember = false;
            next.saving = false;
            next.message = "已保存：" + body.members.length + " 个成员、" + body.rules.length + " 条规则"
              + (body.pick ? "、手动指定 " + body.pick : "");
            patch(next);
          })
          .catch(function (e) {
            patch({ saving: false, error: String(e && e.message ? e.message : e) });
          });
      }

      function refreshTrace() {
        request("state", {}).then(function (payload) {
          patch({
            trace: payload.trace || [], rests: payload.rests || [], sink: payload.sink || [],
            status: payload.status, message: "决策记录已刷新",
          });
        }).catch(function (e) {
          patch({ error: String(e && e.message ? e.message : e) });
        });
      }

      // ---- 推理档（按需拉取，页面级缓存） ----
      /**
       * 打开成员编辑器时拉一次该成员的推理档。
       *
       * 为什么懒加载而不是随 /state 一起返回：档位要逐个模型过 adapter（`resolveModelInfo`），
       * 整页加载时一次问几十个模型会把设置页拖慢；而用户真正会看的只有点开的那一个。
       */
      function loadEfforts(provider, model) {
        var key = keyOf(provider, model);
        var bank = snap.efforts[key];
        if (bank !== undefined && bank.status === "ok") return;
        if (snap.host === "legacy") {
          var legacy = {};
          for (var m in snap.efforts) legacy[m] = snap.efforts[m];
          legacy[key] = { status: "error", efforts: [], error: "Host 半侧还是旧版本（0.2.1），没有 /efforts 接口——重启 DSH 后就有了" };
          patch({ efforts: legacy });
          return;
        }
        var efforts = {};
        for (var k in snap.efforts) efforts[k] = snap.efforts[k];
        efforts[key] = { status: "loading", efforts: [] };
        patch({ efforts: efforts });
        request("efforts", { provider: provider, model: model })
          .then(function (payload) {
            var next = {};
            for (var j in snap.efforts) next[j] = snap.efforts[j];
            next[key] = {
              status: "ok", efforts: payload.efforts || [], defaultEffort: payload.defaultEffort,
              supported: payload.supported !== false, error: payload.error,
            };
            patch({ efforts: next });
          })
          .catch(function (e) {
            var next = {};
            for (var j in snap.efforts) next[j] = snap.efforts[j];
            next[key] = { status: "error", efforts: [], error: String(e && e.message ? e.message : e) };
            patch({ efforts: next });
          });
      }

      // ---- 成员（v4：一个成员 = 名字 + 若干渠道绑定）----
      function addMember() {
        // 新成员从「空名字 + 一个空绑定」开始，由用户填名字与渠道；名字重复/为空在保存前校验。
        var members = snap.members.concat([{ name: "", bindings: [{ provider: "", model: "" }] }]);
        patch({ members: members, openMember: members.length - 1, error: "", message: "" });
      }

      function patchMember(index, next) {
        var members = snap.members.slice();
        members[index] = Object.assign({}, members[index], next);
        patch({ members: members, message: "" });
      }

      function addBinding(index) {
        var member = snap.members[index];
        var bindings = (member.bindings || []).concat([{ provider: "", model: "" }]);
        patchMember(index, { bindings: bindings });
      }

      function patchBinding(index, bindingIndex, next) {
        var member = snap.members[index];
        var bindings = (member.bindings || []).slice();
        bindings[bindingIndex] = Object.assign({}, bindings[bindingIndex], next);
        patchMember(index, { bindings: bindings });
      }

      function removeBinding(index, bindingIndex) {
        var member = snap.members[index];
        var bindings = (member.bindings || []).slice();
        bindings.splice(bindingIndex, 1);
        patchMember(index, { bindings: bindings });
      }

      function moveBinding(index, bindingIndex, delta) {
        var member = snap.members[index];
        var bindings = (member.bindings || []).slice();
        var to = bindingIndex + delta;
        if (to < 0 || to >= bindings.length) return;
        var item = bindings.splice(bindingIndex, 1)[0];
        bindings.splice(to, 0, item);
        patchMember(index, { bindings: bindings });
      }

      function patchMember(index, next) {
        var members = snap.members.slice();
        members[index] = Object.assign({}, members[index], next);
        patch({ members: members, message: "" });
      }

      function removeMember(index) {
        var members = snap.members.slice();
        var gone = members.splice(index, 1)[0];
        var key = memberKeyOf(gone);
        patch({
          members: members,
          off: snap.off.filter(function (item) { return item !== key; }),
          pick: snap.pick === key ? null : snap.pick,
          openMember: -1,
          message: "",
        });
      }

      function toggleOff(key) {
        var off = snap.off.slice();
        var at = off.indexOf(key);
        if (at === -1) off.push(key);
        else off.splice(at, 1);
        patch({ off: off, message: "" });
      }

      function memberTags(member, index) {
        var tags = [];
        if (index === 0) tags.push(h("span", { key: "d", className: "tmm-tag is-default" }, "默认"));
        var bindings = member.bindings || [];
        if (bindings.length > 1) tags.push(h("span", { key: "b", className: "tmm-tag" }, bindings.length + " 个渠道"));
        else if (bindings.length === 1) tags.push(h("span", { key: "b1", className: "tmm-tag" }, bindingKeyOf(bindings[0])));
        if (member.weight !== undefined && member.weight !== "") tags.push(h("span", { key: "w", className: "tmm-tag" }, "权重 " + member.weight));
        if (snap.off.indexOf(memberKeyOf(member)) !== -1) tags.push(h("span", { key: "o", className: "tmm-tag" }, "已摘除"));
        return h("span", { className: "tmm-tags" }, tags);
      }

      // ---- 合并建议（同模型多渠道 → 合成一个成员）----
      function applySuggestion(suggestion) {
        var next = applyMerge(snap.members, snap.rules, snap.pick, snap.off, suggestion);
        patch({
          members: next.members, rules: next.rules, pick: next.pick, off: next.off,
          openMember: -1, message: "已合并为成员「" + suggestion.name + "」，原规则引用已一并改到新名字",
        });
      }

      // ---- 规则 ----
      function addRule() {
        var use = snap.members.length > 0 ? memberKeyOf(snap.members[0]) : "";
        var rules = snap.rules.concat([{ use: use }]);
        patch({ rules: rules, openRule: rules.length - 1, message: "" });
      }

      function patchRule(index, next) {
        var rules = snap.rules.slice();
        rules[index] = Object.assign({}, rules[index], next);
        patch({ rules: rules, message: "" });
      }

      function removeRule(index) {
        var rules = snap.rules.slice();
        rules.splice(index, 1);
        patch({ rules: rules, openRule: -1, message: "" });
      }

      function toggleDay(index, day) {
        var rule = snap.rules[index];
        var days = (rule.days || []).slice();
        var at = days.indexOf(day);
        if (at === -1) days.push(day);
        else days.splice(at, 1);
        patchRule(index, { days: days });
      }

      // ---- 渲染小件 ----
      var memberKeys = snap.members.map(memberKeyOf);

      /**
       * 合并绑定级时段：三个字段都空就等于「没有时段」（不送 time），
       * 而不是送 `{from:"",to:""}` 让 Host 校验失败。
       */
      function withTime(current, patchOf) {
        var merged = Object.assign({}, current || {}, patchOf);
        var from = String(merged.from || "").trim();
        var to = String(merged.to || "").trim();
        var days = (merged.days || []).filter(function (item) { return item !== ""; });
        if (from === "" && to === "" && days.length === 0) return undefined;
        var out = { from: from || "00:00", to: to || "24:00" };
        if (days.length > 0) out.days = days;
        return out;
      }

      function select(value, onChange, list, className) {
        return h("select", { className: "tmm-select " + (className || ""), value: value, onChange: onChange },
          list.map(function (option) { return h("option", { key: option.value, value: option.value }, option.label); }));
      }

      function field(label, control, className) {
        return h("label", { className: "tmm-field " + (className || "") }, h("span", null, label), control);
      }

      function iconButton(name, title, onClick, extraClass, disabled) {
        return h("button", {
          type: "button", className: "tmm-btn is-icon " + (extraClass || ""), title: title, "aria-label": title,
          onClick: onClick, disabled: disabled === true,
        }, icon(name, name === "chev" ? "tmm-chev" : undefined));
      }

      function chip(text, kind) {
        return h("span", { className: "tmm-chip" + (kind ? " " + kind : "") },
          kind === "is-live" || kind === "is-off" ? h("span", { className: "tmm-dot" }) : null, text);
      }

      // ---- 头部 ----
      var routingOn = snap.members.length > 0;
      // 绑定总数（v4）：成员是逻辑名，绑定才是实际可跑的渠道×模型。
      var bindingsTotal = snap.members.reduce(function (sum, member) { return sum + ((member.bindings || []).length); }, 0);
      var children = [];
      children.push(h("header", { key: "hero", className: "tmm-hero" },
        h("h2", { className: "tmm-title" }, "模型路由"),
        h("p", { className: "tmm-sub" },
          "给子 agent 选模型：",
          h("code", null, "subagent"), "、", h("code", null, "subagent_fork"), "、团队成员、workflow 每次 ",
          h("code", null, "agent()"), "。创建时按规则命中决定，运行期失败按候选顺序回退；Lead 自己的模型永不参与路由。"),
        h("div", { className: "tmm-chips" },
          chip(routingOn ? "路由已启用" : "路由未启用（子 agent 继承 Lead）", routingOn ? "is-live" : "is-off"),
          chip("成员 " + snap.members.length + (bindingsTotal > 0 ? " / 绑定 " + bindingsTotal : "")),
          chip("规则 " + snap.rules.length),
          chip("排序 " + snap.routing),
          chip("回退 " + (snap.failover.enabled ? snap.failover.patience + " 次" : "关")),
          chip("fork " + (snap.allowFork ? "纳管" : "不纳管")))));

      if (!snap.loading && snap.members.length > 0 && snap.rules.length === 0 && !snap.pick) {
        children.push(h("div", { key: "note", className: "tmm-note is-warn" }, icon("info"),
          h("span", null,
            "成员表非空即表示路由器已接管：所有子 agent 默认跑第一个成员（",
            h("code", null, memberKeyOf(snap.members[0])),
            "）。想让子 agent 回到「继承 Lead 的模型」，把成员表清空即可；想统一跑某一条，用「高级设置 → 手动指定」。")));
      }

      if (!snap.loading && snap.host === "legacy") {
        children.push(h("div", { key: "legacy", className: "tmm-note is-warn" }, icon("info"),
          h("span", null,
            h("strong", null, "Host 半侧还是旧版本（0.2.1）"),
            "：界面已是新版，但接口还是旧的——它只认 ", h("code", null, "/routes"), "，没有 ",
            h("code", null, "/policy"), " 与 ", h("code", null, "/efforts"),
            "。所以「保存」会报 ", h("code", null, "unknown action"), "、「推理档」读不出来。",
            h("br", null),
            "修法：重启 DSH。Host 半侧只在进程启动时加载模块，刷新页面不会重载它。")))
      }

      if (!snap.loading && snap.hostVersion === "v3") {
        children.push(h("div", { key: "hostv3", className: "tmm-note is-warn" }, icon("info"),
          h("span", null,
            h("strong", null, "Host 半侧还是 v3（旧成员模型）"),
            "：它把「渠道×模型」直接当成员，不认成员的渠道绑定。界面已是 v4，直接保存会被拒——",
            h("br", null),
            "修法：重启 DSH 后刷新页面（Host 只在进程启动时加载模块）。")))
      }

      if (snap.loading) {
        children.push(h("div", { key: "loading", className: "tmm-panel" },
          h("div", { className: "tmm-skel", style: { width: "180px" } }),
          h("div", { className: "tmm-skel", style: { width: "320px" } }),
          h("div", { className: "tmm-skel", style: { width: "240px" } })));
      }

      // ---- 成员表（v4：成员 = 固定名字 + 若干「渠道×模型」绑定）----
      var catalogGroups = snap.catalog.filter(function (p) { return (p.models || []).length > 0; });
      var memberItems = [];
      snap.members.forEach(function (member, index) {
        var name = memberKeyOf(member);
        var isOff = snap.off.indexOf(name) !== -1;
        var isOpen = snap.openMember === index;
        memberItems.push(h("li", {
          key: "m-" + index,
          className: "tmm-item" + (isOpen ? " is-active" : "") + (isOff ? " is-dim" : ""),
        },
          h("button", {
            type: "button", className: "tmm-main" + (isOpen ? " tmm-open" : ""),
            "aria-expanded": isOpen, title: isOpen ? "收起" : "展开编辑",
            onClick: function () { patch({ openMember: isOpen ? -1 : index }); },
          },
            icon("chev"),
            h("span", { className: "tmm-ord" }, String(index + 1)),
            h("span", { className: "tmm-key" }, name === "" ? "（未命名成员）" : name),
            memberTags(member, index)),
          h("span", { className: "tmm-actions" },
            iconButton("up", "上移", function () { patch({ members: move(snap.members, index, -1), openMember: -1, message: "" }); }, undefined, index === 0),
            iconButton("down", "下移", function () { patch({ members: move(snap.members, index, 1), openMember: -1, message: "" }); }, undefined, index === snap.members.length - 1),
            iconButton("close", "移除该成员", function () { removeMember(index); }, "is-danger"))));

        if (!isOpen) return;
        var bindings = member.bindings || [];
        var bindingItems = bindings.map(function (binding, bindingIndex) {
          var bank = snap.efforts[keyOf(binding.provider, binding.model)];
          var hasListedEfforts = bank !== undefined && bank.status === "ok" && (bank.efforts || []).length > 0;
          var group = catalogGroups.filter(function (p) { return p.id === binding.provider; })[0] || { models: [] };
          var time = binding.time || {};
          return h("li", { key: "b-" + bindingIndex, className: "tmm-binding" + (binding.off === true ? " is-dim" : "") },
            h("div", { className: "tmm-binding-head" },
              h("span", { className: "tmm-ord" }, String(bindingIndex + 1)),
              h("span", { className: "tmm-key" }, binding.provider || "（未选 provider）"),
              h("span", { className: "tmm-spacer" }),
              h("span", { className: "tmm-actions" },
                iconButton("up", "上移（优先走这个渠道）", function () { moveBinding(index, bindingIndex, -1); }, undefined, bindingIndex === 0),
                iconButton("down", "下移", function () { moveBinding(index, bindingIndex, 1); }, undefined, bindingIndex === bindings.length - 1),
                iconButton("close", "移除该绑定", function () { removeBinding(index, bindingIndex); }, "is-danger"))),
            h("div", { className: "tmm-grid" },
              field("provider", select(binding.provider || "", function (e) {
                patchBinding(index, bindingIndex, { provider: e.target.value, model: "" });
                loadEfforts(e.target.value, "");
              }, [{ value: "", label: "选择…" }].concat(catalogGroups.map(function (p) { return { value: p.id, label: p.id }; })), "is-w")),
              field("model", select(binding.model || "", function (e) {
                patchBinding(index, bindingIndex, { model: e.target.value });
                loadEfforts(binding.provider, e.target.value);
              }, [{ value: "", label: "选择…" }].concat(group.models.map(function (m) {
                return { value: m.id, label: m.name && m.name !== m.id ? m.id + " · " + m.name : m.id };
              })), "is-w")),
              field("目录里没公布的 model", h("input", {
                className: "tmm-input is-w", placeholder: "手工填：如 deepseek-v4.1", value: binding.model || "",
                onChange: function (e) { patchBinding(index, bindingIndex, { model: e.target.value }); },
              }))),
            h("div", { className: "tmm-grid" },
              field("推理档", h("div", { className: "tmm-rule-of" },
                h("select", {
                  className: "tmm-select is-ws", value: binding.reasoningEffort || "",
                  disabled: bank !== undefined && bank.status === "loading",
                  onChange: function (e) { patchBinding(index, bindingIndex, { reasoningEffort: e.target.value }); },
                }, effortOptions(bank, binding.reasoningEffort).map(function (option) {
                  return h("option", { key: option.value, value: option.value }, option.label);
                })),
                hasListedEfforts ? null : h("input", {
                  className: "tmm-input is-wxs", placeholder: "手工填", value: binding.reasoningEffort || "",
                  onChange: function (e) { patchBinding(index, bindingIndex, { reasoningEffort: e.target.value }); },
                }))),
              // 渠道级时段：这是「这个渠道在这个时段别用」的渠道属性，不是任务条件——属于绑定，不属于规则。
              field("该渠道停用时段", h("div", { className: "tmm-rule-of" },
                h("input", {
                  className: "tmm-input is-wxs", placeholder: "09:00", value: time.from || "",
                  onChange: function (e) { patchBinding(index, bindingIndex, { time: withTime(binding.time, { from: e.target.value }) }); },
                }),
                h("span", { style: { color: "var(--dsw-alias-label-tertiary)" } }, "–"),
                h("input", {
                  className: "tmm-input is-wxs", placeholder: "12:00", value: time.to || "",
                  onChange: function (e) { patchBinding(index, bindingIndex, { time: withTime(binding.time, { to: e.target.value }) }); },
                }),
                h("input", {
                  className: "tmm-input is-ws", placeholder: "mon,tue（空=每天）", value: (time.days || []).join(","),
                  onChange: function (e) { patchBinding(index, bindingIndex, { time: withTime(binding.time, { days: textList(e.target.value) }) }); },
                }))),
              h("label", { className: "tmm-field is-inline", title: "仅停用这个渠道；同成员的其它渠道照常可用" },
                h("input", {
                  className: "tmm-check", type: "checkbox", checked: binding.off === true,
                  onChange: function (e) { patchBinding(index, bindingIndex, { off: e.target.checked }); },
                }),
                h("span", null, "停用该渠道"))));
        });
        memberItems.push(h("li", { key: "me-" + index, className: "tmm-editor" },
          h("div", { className: "tmm-fs" },
            h("h4", { className: "tmm-fs-title" }, "成员（规则按这个名字引用）"),
            h("div", { className: "tmm-grid" },
              field("成员名", h("input", {
                className: "tmm-input is-w", placeholder: "如 glm-max / cheap-flash", value: name,
                onChange: function (e) { patchMember(index, { name: e.target.value }); },
              })),
              field("权重（weight 策略用）", h("input", {
                className: "tmm-input is-wxs", inputMode: "numeric", placeholder: "1", value: member.weight === undefined ? "" : member.weight,
                onChange: function (e) { patchMember(index, { weight: e.target.value }); },
              })),
              h("label", { className: "tmm-field is-inline" },
                h("input", { className: "tmm-check", type: "checkbox", checked: isOff, onChange: function () { toggleOff(name); } }),
                h("span", null, isOff ? "已摘除（不参与选中）" : "临时摘除（保留位置）")))),
          h("div", { className: "tmm-fs" },
            h("h4", { className: "tmm-fs-title" }, "渠道绑定（按顺序回退：先同模型换渠道，再换成员）"),
            h("ul", { className: "tmm-bindings" }, bindingItems),
            h("button", { type: "button", className: "tmm-btn is-quiet", onClick: function () { addBinding(index); } }, icon("plus"), "添加渠道绑定"))));
      });

      var memberBody = [];
      if (memberItems.length > 0) memberBody.push(h("ul", { key: "list", className: "tmm-list" }, memberItems));
      else memberBody.push(h("div", { key: "empty", className: "tmm-empty" },
        h("strong", null, "还没有成员——路由器处于关闭状态。"),
        h("span", null, "此时子 agent 完全按官方行为继承 Lead 的模型。加入成员后，所有子 agent 默认跑第一个成员。")));

      // 合并建议：同一模型出现在多个单绑定成员里 → 一键合成一个成员（规则引用一并改写）。
      var mergeNotes = [];
      mergeSuggestions(snap.members).forEach(function (suggestion) {
        mergeNotes.push(h("button", {
          key: "mg-" + suggestion.name, type: "button", className: "tmm-btn is-quiet",
          title: "把 " + suggestion.names.join(" / ") + " 合并成一个成员，规则引用自动改到新名字",
          onClick: function () { applySuggestion(suggestion); },
        }, "合并 " + suggestion.names.join(" + ") + " → " + suggestion.name));
      });
      if (mergeNotes.length > 0) {
        memberBody.push(h("div", { key: "merge", className: "tmm-note is-info" }, icon("info"),
          h("span", null, "发现 ", mergeNotes.length, " 组「同模型多渠道」的成员，可合并成一个（合并后同模型跨渠道自动互相兜底）："),
          h("div", { className: "tmm-rule-of" }, mergeNotes)));
      }

      children.push(h("section", { key: "members", className: "tmm-panel" },
        h("div", { className: "tmm-panel-head" },
          h("h3", { className: "tmm-panel-title" }, "成员"),
          h("span", { className: "tmm-panel-hint" }, "成员 = 固定名字 + 若干渠道绑定；规则按名字引用，同模型多渠道互相兜底"),
          h("span", { className: "tmm-spacer" }),
          h("button", { type: "button", className: "tmm-btn is-quiet", onClick: addMember }, icon("plus"), "添加成员")),
        memberBody));

      // ---- 规则表：按目标成员分组（关键词用胶囊，条件规则保留完整编辑器）----
      function renderRuleEditor(index, rule) {
        var useOptions = memberKeys.length > 0 ? memberKeys : [rule.use].filter(Boolean);
        // 2026-10-19：这里原本从旧 forEach 里整段抽出来时残留了开头的 `ruleItems.push(`，
        // 于是既 ReferenceError（ruleItems 已不存在）又没有 return —— 点「新增条件规则」直接白屏。
        return h("li", { key: "re-" + index, className: "tmm-editor" },
          h("div", { className: "tmm-fs" },
            h("h4", { className: "tmm-fs-title" }, "命中条件（留空 = 该条件不参与匹配）"),
            h("div", { className: "tmm-grid" },
              field("通道", select(rule.channel || "", function (e) { patchRule(index, { channel: e.target.value || undefined }); },
                [{ value: "", label: "任意" }, { value: "spawn", label: "spawn" }, { value: "fork", label: "fork" }])),
              field("创建方式", select(rule.continuable === undefined ? "" : String(rule.continuable),
                function (e) { var v = e.target.value; patchRule(index, { continuable: v === "" ? undefined : v === "true" }); },
                [{ value: "", label: "任意" }, { value: "true", label: "团队成员/后台" }, { value: "false", label: "一次性子代理" }])),
              field("标签通配", h("input", { className: "tmm-input is-w", placeholder: "*review*", value: rule.label || "", onChange: function (e) { patchRule(index, { label: e.target.value }); } })),
              field("成员名通配", h("input", { className: "tmm-input is-ws", placeholder: "*doc*", value: rule.member || "", onChange: function (e) { patchRule(index, { member: e.target.value }); } })),
              field("目录（逗号分隔）", h("input", { className: "tmm-input is-w", placeholder: "~/proj , D:\\work", value: (rule.folders || []).join(", "), onChange: function (e) { patchRule(index, { folders: textList(e.target.value) }); } })),
              field("目录不含", h("input", { className: "tmm-input is-ws", placeholder: "~/legacy", value: (rule.exceptFolders || []).join(", "), onChange: function (e) { patchRule(index, { exceptFolders: textList(e.target.value) }); } })),
              field("父会话 tokens ≥", h("input", { className: "tmm-input is-wxs", inputMode: "numeric", placeholder: "60000", value: rule.tokens === undefined ? "" : rule.tokens, onChange: function (e) { patchRule(index, { tokens: e.target.value }); } })),
              field("推理档", h("input", { className: "tmm-input is-wxs", placeholder: "high / on", value: rule.effort || "", onChange: function (e) { patchRule(index, { effort: e.target.value }); } })),
              field("图片", select(rule.images === undefined ? "" : String(rule.images),
                function (e) { patchRule(index, { images: e.target.value === "" ? undefined : e.target.value === "true" }); },
                [{ value: "", label: "任意" }, { value: "true", label: "带图" }, { value: "false", label: "不带图" }])),
              field("意图（需开分类器）", h("input", { className: "tmm-input is-ws", placeholder: "写作或修改测试", value: rule.intent || "", onChange: function (e) { patchRule(index, { intent: e.target.value }); } })))),
          h("div", { className: "tmm-grid" },
            field("时段", h("div", { className: "tmm-rule-of" },
              h("input", { className: "tmm-input is-wxs", placeholder: "22:00", value: rule.from || "", onChange: function (e) { patchRule(index, { from: e.target.value }); } }),
              h("span", { style: { color: "var(--dsw-alias-label-tertiary)" } }, "–"),
              h("input", { className: "tmm-input is-wxs", placeholder: "08:00", value: rule.to || "", onChange: function (e) { patchRule(index, { to: e.target.value }); } }))),
            field("星期（跨午夜算窗口开始那天）", h("div", { className: "tmm-days" }, WEEKDAYS.map(function (day) {
              return h("label", { key: day, className: "tmm-day" },
                h("input", { className: "tmm-check", type: "checkbox", checked: (rule.days || []).indexOf(day) !== -1, onChange: function () { toggleDay(index, day); } }),
                day);
            })))),
          h("div", { className: "tmm-fs" },
            h("h4", { className: "tmm-fs-title" }, "路由目标"),
            h("div", { className: "tmm-grid" },
              field("命中后用哪个成员", h("div", { className: "tmm-rule-of" },
                select(useOptions.indexOf(rule.use) === -1 ? "" : rule.use, function (e) { patchRule(index, { use: e.target.value }); },
                  [{ value: "", label: "选择成员…" }].concat(useOptions.map(function (key) { return { value: key, label: key }; })), "is-w"),
                h("input", { className: "tmm-input is-w", placeholder: "或手工成员名", value: rule.use || "", onChange: function (e) { patchRule(index, { use: e.target.value }); } }))),
              h("label", { className: "tmm-field is-inline", title: "停用规则：条件成立时把上面这个成员摘出候选，而不是改发给别人" },
                h("input", { className: "tmm-check", type: "checkbox", checked: rule.pause === true, onChange: function (e) { patchRule(index, { pause: e.target.checked }); } }),
                h("span", null, "仅摘除该成员（pause）")))));
      }

      function addKeyword(use) {
        var raw = (snap.kwDraft[use] || "").trim();
        var word = raw.replace(/^\*+|\*+$/g, "");
        if (word === "") { patch({ error: "先输入关键词", message: "" }); return; }
        if (word.indexOf("*") !== -1) {
          patch({ error: "分组视图里关键词不能带 *（要用通配请走「新增规则」建条件规则）", message: "" });
          return;
        }
        var rules = snap.rules.slice();
        rules.splice(keywordInsertIndex(rules, use), 0, { use: use, label: "*" + word + "*" });
        var kw = Object.assign({}, snap.kwDraft);
        kw[use] = "";
        patch({ rules: rules, kwDraft: kw, error: "", message: "" });
      }

      var groups = groupRules(snap.rules);
      var ruleCards = groups.map(function (group) {
        var chips = group.labelRules.map(function (entry) {
          var isOpen = snap.openRule === entry.index;
          return h("span", { key: "k" + entry.index, className: "tmm-kw" + (isOpen ? " is-open" : "") },
            h("button", {
              type: "button", className: "tmm-kw-main", "aria-expanded": isOpen,
              title: "命中 *" + entry.word + "* 即用 " + group.use + "（点开可加通道/目录/时段等条件）",
              onClick: function () { patch({ openRule: isOpen ? -1 : entry.index }); },
            }, entry.word),
            h("button", {
              type: "button", className: "tmm-kw-x", title: "删除关键词 " + entry.word,
              "aria-label": "删除关键词 " + entry.word,
              onClick: function () { removeRule(entry.index); },
            }, icon("close")));
        });
        // 关键词规则也要能展开完整编辑器（用户反馈：分组后详细配置项找不到了）。
        var openLabelEditors = [];
        group.labelRules.forEach(function (entry) {
          if (snap.openRule === entry.index && snap.rules[entry.index] !== undefined) {
            openLabelEditors.push(renderRuleEditor(entry.index, snap.rules[entry.index]));
          }
        });
        var specialFlat = [];
        group.specialRules.forEach(function (entry) {
          var rule = entry.rule;
          var isOpen = snap.openRule === entry.index;
          specialFlat.push(h("li", { key: "s" + entry.index, className: "tmm-item" + (isOpen ? " is-active" : "") },
            h("button", {
              type: "button", className: "tmm-main" + (isOpen ? " tmm-open" : ""),
              "aria-expanded": isOpen, title: isOpen ? "收起" : "展开编辑",
              onClick: function () { patch({ openRule: isOpen ? -1 : entry.index }); },
            },
              icon("chev"),
              h("span", { className: "tmm-sum" }, describeRule(rule))),
            h("span", { className: "tmm-actions" },
              iconButton("close", "删除该规则", function () { removeRule(entry.index); }, "is-danger"))));
          if (isOpen) specialFlat.push(renderRuleEditor(entry.index, rule));
        });
        return h("div", { key: "g-" + group.use, className: "tmm-group" },
          h("div", { className: "tmm-group-head" },
            h("span", { className: "tmm-key", style: { flex: "1", minWidth: "0" } }, group.use),
            h("span", { className: "tmm-pill" }, group.labelRules.length + " 词"),
            group.specialRules.length > 0 ? h("span", { className: "tmm-pill" }, group.specialRules.length + " 条件") : null),
          h("div", { className: "tmm-kwrow" },
            chips,
            h("input", {
              className: "tmm-input tmm-kw-in", placeholder: "加关键词，回车确认",
              value: snap.kwDraft[group.use] || "",
              onChange: function (e) {
                var kw = Object.assign({}, snap.kwDraft);
                kw[group.use] = e.target.value;
                patch({ kwDraft: kw });
              },
              onKeyDown: function (e) {
                if (e.key === "Enter") { e.preventDefault(); addKeyword(group.use); }
              },
            }),
            h("button", {
              type: "button", className: "tmm-btn is-quiet", style: { minHeight: "26px", padding: "0 8px" },
              title: "加关键词", onClick: function () { addKeyword(group.use); },
            }, icon("plus"))),
          openLabelEditors.length > 0 ? h("ul", { className: "tmm-list" }, openLabelEditors) : null,
          specialFlat.length > 0 ? h("ul", { className: "tmm-list" }, specialFlat) : null);
      });

      var ruleBody = [];
      if (ruleCards.length > 0) ruleBody.push(h("div", { key: "groups" }, ruleCards));
      else ruleBody.push(h("div", { key: "empty", className: "tmm-empty" },
        h("strong", null, "还没有规则——一律用成员表的第一个。"),
        h("span", null, "按目标成员分组；组内任一关键词命中即用该成员，组间按出现顺序命中。")));

      children.push(h("section", { key: "rules", className: "tmm-panel" },
        h("div", { className: "tmm-panel-head" },
          h("h3", { className: "tmm-panel-title" }, "规则"),
          h("span", { className: "tmm-panel-hint" }, "组间按序命中；点关键词可加通道/目录/时段等条件"),
          h("span", { className: "tmm-spacer" }),
          h("button", { type: "button", className: "tmm-btn is-quiet", onClick: addRule }, icon("plus"), "新增条件规则")),
        ruleBody));

      // ---- 用量（三张图：按成员 / 按小时 / 按规则命中）----
      var usageUi = [];
      if (snap.usage === null) {
        usageUi.push(h("div", { key: "none", className: "tmm-empty" },
          h("strong", null, "读不到用量接口。"),
          h("span", null, "Host 半侧可能是旧版本（没有 /usage）——刷新页面或重启 DSH 后再看。")));
      } else if (snap.usage === undefined) {
        usageUi.push(h("div", { key: "loading", className: "tmm-empty" }, h("span", null, "正在读用量…")));
      } else {
        var usage = snap.usage;
        var totals = usage.totals || {};
        var rows = sortUsageRows(usage.members || [], snap.usageSort);
        var maxRow = rows.reduce(function (acc, row) { return Math.max(acc, row[snap.usageSort] || 0); }, 0);

        usageUi.push(h("div", { key: "sum", className: "tmm-usage-sum" },
          h("span", { className: "tmm-usage-total" }, formatTokens(totals.totalTokens || 0) + " tokens"),
          h("span", { className: "tmm-panel-hint" },
            (totals.runs || 0) + " 次创建 · " + (totals.calls || 0) + " 次模型调用 · 入 " + formatTokens(totals.inputTokens || 0)
            + " / 出 " + formatTokens(totals.outputTokens || 0) + " / 缓存读 " + formatTokens(totals.cacheReadTokens || 0)
            + (usage.startedAt ? " · 自 " + String(usage.startedAt).slice(5, 16).replace("T", " ") : ""))));

        if (rows.length === 0) {
          usageUi.push(h("div", { key: "empty", className: "tmm-empty" },
            h("strong", null, "还没有子 agent 的用量。"),
            h("span", null, "创建子代理、等它跑完一轮模型调用后，这里会出现数字（只统计子 agent，Lead 自己的消耗不算）。")));
        } else {
          // 用量三层：先看成员总量，点开再看**每个渠道**的明细（用户要求「按成员聚合但细分到渠道」）。
          var usageRows = [];
          rows.forEach(function (row) {
            var bindings = row.bindings || [];
            var isOpen = snap.usageOpen[row.member] === true;
            var sub = bindings.length > 1 || (bindings[0] !== undefined && bindings[0].binding !== row.member);
            usageRows.push(h("div", {
              key: "u-" + row.member,
              className: "tmm-ubar is-member" + (isOpen ? " is-open" : ""),
              title: sub ? "点开看各渠道明细" : row.member,
              onClick: sub ? function () {
                var next = Object.assign({}, snap.usageOpen);
                next[row.member] = !isOpen;
                patch({ usageOpen: next });
              } : undefined,
            },
              h("span", { className: "tmm-ubar-name" },
                sub ? icon("chev") : null,
                " " + shortMember(row.member)),
              h("span", { className: "tmm-ubar-track" },
                h("span", { className: "tmm-ubar-fill", style: { width: barPercent(row[snap.usageSort], maxRow) + "%" } })),
              h("span", { className: "tmm-ubar-num" }, formatTokens(row[snap.usageSort] || 0)),
              h("span", { className: "tmm-ubar-meta" },
                row.calls + " 次 · 出 " + formatTokens(row.outputTokens)
                + (bindings.length > 1 ? " · " + bindings.length + " 渠道" : ""))));
            if (!isOpen || !sub) return;
            var maxBinding = bindings.reduce(function (acc, item) { return Math.max(acc, item[snap.usageSort] || 0); }, 0);
            bindings.forEach(function (item) {
              usageRows.push(h("div", { key: "u-" + row.member + "-" + item.binding, className: "tmm-ubar is-child", title: item.binding },
                h("span", { className: "tmm-ubar-name" }, item.binding),
                h("span", { className: "tmm-ubar-track" },
                  h("span", { className: "tmm-ubar-fill", style: { width: barPercent(item[snap.usageSort], maxBinding) + "%" } })),
                h("span", { className: "tmm-ubar-num" }, formatTokens(item[snap.usageSort] || 0)),
                h("span", { className: "tmm-ubar-meta" },
                  item.calls + " 次 · 入 " + formatTokens(item.inputTokens) + " / 出 " + formatTokens(item.outputTokens)
                  + (item.cacheReadTokens > 0 ? " / 缓存读 " + formatTokens(item.cacheReadTokens) : ""))));
            });
          });
          usageUi.push(h("div", { key: "bars" }, usageRows));
        }

        // 图 2：最近 24 小时（缺的桶画成 0，保证横轴连续）
        var hours = usage.hours || [];
        var maxHour = hours.reduce(function (acc, bucket) { return Math.max(acc, bucket.totalTokens || 0); }, 0);
        usageUi.push(h("div", { key: "hours" },
          h("div", { className: "tmm-chart-title" }, "最近 24 小时（每小时 token）"),
          h("div", { className: "tmm-hours" }, hours.map(function (bucket, index) {
            return h("div", { key: "h" + index, className: "tmm-hour", title: bucket.hour.slice(11) + ":00 · " + formatTokens(bucket.totalTokens) + " tokens · " + bucket.calls + " 次调用" },
              h("span", { className: "tmm-hour-fill", style: { height: barPercent(bucket.totalTokens, maxHour) + "%" } }));
          })),
          h("div", { className: "tmm-hour-labels" },
            h("span", null, (hours[0] || { hour: "" }).hour.slice(11) + ":00"),
            h("span", null, "现在"))));

        // 图 3：规则命中分布（哪些关键词真的在起作用）
        var ruleRows = (usage.rules || []).slice(0, 10);
        var maxRule = ruleRows.reduce(function (acc, row) { return Math.max(acc, row.hits || 0); }, 0);
        var sourceText = (usage.sources || []).map(function (row) { return usageSourceText(row.reason) + " " + row.count; }).join(" · ");
        usageUi.push(h("div", { key: "rules" },
          h("div", { className: "tmm-chart-title" }, "规则命中分布" + (sourceText === "" ? "" : "（来源：" + sourceText + "）")),
          ruleRows.length === 0
            ? h("div", { className: "tmm-empty" }, h("span", null, "还没有规则命中记录。"))
            : h("div", null, ruleRows.map(function (row) {
                return h("div", { key: "r-" + row.rule, className: "tmm-ubar" },
                  h("span", { className: "tmm-ubar-name" }, row.rule),
                  h("span", { className: "tmm-ubar-track" },
                    h("span", { className: "tmm-ubar-fill", style: { width: barPercent(row.hits, maxRule) + "%" } })),
                  h("span", { className: "tmm-ubar-num" }, String(row.hits)));
              })),
          (usage.rules || []).length > ruleRows.length
            ? h("div", { className: "tmm-panel-hint", style: { padding: "0 14px 8px" } }, "另有 " + ((usage.rules || []).length - ruleRows.length) + " 条规则暂无命中")
            : null));
      }

      children.push(h("section", { key: "usage", className: "tmm-panel" },
        h("div", { className: "tmm-panel-head" },
          h("h3", { className: "tmm-panel-title" }, "用量"),
          h("span", { className: "tmm-panel-hint" }, "只统计子 agent"),
          h("span", { className: "tmm-spacer" }),
          select(snap.usageSort, function (e) { patch({ usageSort: e.target.value }); },
            [{ value: "totalTokens", label: "按总 token" }, { value: "calls", label: "按调用次数" }, { value: "outputTokens", label: "按输出 token" }]),
          h("button", { type: "button", className: "tmm-btn is-quiet", onClick: loadUsage }, "刷新"),
          h("button", { type: "button", className: "tmm-btn is-quiet", title: "清零统计（策略不受影响）", onClick: resetUsage }, "清零")),
        h("div", { className: "tmm-usage" }, usageUi)));

      // ---- 高级设置 ----
      var pickOptions = [{ value: "", label: "不指定（按规则与成员顺序）" }].concat(
        snap.members.map(function (m) { return { value: memberKeyOf(m), label: memberKeyOf(m) }; }));

      children.push(h("details", { key: "advanced", className: "tmm-fold" },
        h("summary", null, icon("chev", "tmm-chev"), "高级设置",
          h("span", { className: "tmm-panel-hint", style: { marginLeft: "auto", fontWeight: "400" } }, "手动指定 · 排序 · fork · 回退 · 分类器 · 目录通配")),
        h("div", { className: "tmm-fold-body" },
          h("div", { className: "tmm-grid" },
            field("手动指定成员（跳过全部规则）", select(snap.pick || "", function (e) { patch({ pick: e.target.value || null, message: "" }); }, pickOptions, "is-w")),
            field("候选排序", select(snap.routing, function (e) { patch({ routing: e.target.value, message: "" }); },
              [{ value: "order", label: "order（按成员顺序）" }, { value: "rotate", label: "rotate（轮流）" }, { value: "weight", label: "weight（按权重）" }]))),
          h("label", { className: "tmm-field is-inline" },
            h("input", { className: "tmm-check", type: "checkbox", checked: snap.allowFork, onChange: function (e) { patch({ allowFork: e.target.checked, message: "" }); } }),
            h("span", null, "纳管 fork 子 agent")),
          h("p", { className: "tmm-panel-hint", style: { whiteSpace: "normal" } },
            "fork 默认不纳管：改了路由，被 fork 的父会话前缀就不能复用 KV cache。magpie 的 smart / usage / pace 依赖配额窗口数据，DSH 不提供，故排序只有三种。"),
          h("div", { className: "tmm-grid" },
            h("label", { className: "tmm-field is-inline" },
              h("input", { className: "tmm-check", type: "checkbox", checked: snap.failover.enabled, onChange: function (e) { patch({ failover: Object.assign({}, snap.failover, { enabled: e.target.checked }), message: "" }); } }),
              h("span", null, "运行期失败换候选")),
            field("最多切换次数", h("input", { className: "tmm-input is-wxs", inputMode: "numeric", value: snap.failover.patience, onChange: function (e) { patch({ failover: Object.assign({}, snap.failover, { patience: e.target.value }), message: "" }); } }))),
          h("p", { className: "tmm-panel-hint", style: { whiteSpace: "normal" } },
            "只对可重试失败生效（408 / 429 / 5xx、超时、过载、网络）；400 / 401 / 403 / 404 / 413 这类请求本身的拒绝一律不回退。"),
          h("div", { className: "tmm-grid" },
            h("label", { className: "tmm-field is-inline" },
              h("input", { className: "tmm-check", type: "checkbox", checked: snap.classifier.enabled, onChange: function (e) { patch({ classifier: Object.assign({}, snap.classifier, { enabled: e.target.checked }), message: "" }); } }),
              h("span", null, "意图分类器")),
            field("分类用 provider", h("div", { className: "tmm-rule-of" },
              h("select", {
                className: "tmm-select is-ws", value: snap.classifier.provider,
                onChange: function (e) {
                  // 换 provider 后原 model 大概率不属于它，清掉重选，避免存进一个对不上的组合。
                  patch({ classifier: Object.assign({}, snap.classifier, { provider: e.target.value, model: "" }), message: "" });
                },
              }, catalogOptions(catalogGroups.map(function (p) { return { value: p.id, label: p.id }; }), snap.classifier.provider, "选择 provider…").map(function (option) {
                return h("option", { key: option.value, value: option.value }, option.label);
              })),
              // 目录为空（LLM 服务没公布 provider）时才给手填入口，与推理档同一套口径。
              catalogGroups.length > 0 ? null : h("input", { className: "tmm-input is-ws", placeholder: "手工填 provider", value: snap.classifier.provider, onChange: function (e) { patch({ classifier: Object.assign({}, snap.classifier, { provider: e.target.value }), message: "" }); } }))),
            field("分类用 model", h("div", { className: "tmm-rule-of" },
              h("select", {
                className: "tmm-select is-ws", value: snap.classifier.model,
                onChange: function (e) { patch({ classifier: Object.assign({}, snap.classifier, { model: e.target.value }), message: "" }); },
              }, catalogOptions((catalogGroups.filter(function (p) { return p.id === snap.classifier.provider; })[0] || { models: [] }).models.map(function (m) {
                return { value: m.id, label: m.name && m.name !== m.id ? m.id + " · " + m.name : m.id };
              }), snap.classifier.model, "选择 model…").map(function (option) {
                return h("option", { key: option.value, value: option.value }, option.label);
              })),
              catalogGroups.some(function (p) { return p.id === snap.classifier.provider && (p.models || []).length > 0; }) ? null : h("input", { className: "tmm-input is-ws", placeholder: "手工填 model", value: snap.classifier.model, onChange: function (e) { patch({ classifier: Object.assign({}, snap.classifier, { model: e.target.value }), message: "" }); } })))),
          (function () {
            var notice = classifierNotice(snap.classifier, snap.rules);
            if (notice === null) return null;
            return h("p", { className: notice.level === "warn" ? "tmm-warn" : "tmm-panel-hint", style: { whiteSpace: "normal" } }, notice.text);
          })(),
          field("目录通配自动入候选", h("input", {
            className: "tmm-input is-w", placeholder: "opencode-go/* , zai-coding-cn/glm-*",
            value: snap.matchText, onChange: function (e) { patch({ matchText: e.target.value, message: "" }); },
          })))));

      // ---- 决策记录 ----
      var traceRows = snap.trace.slice(0, 20).map(function (row, index) {
        var cls = row.outcome === "injected" ? "tmm-is-ok" : row.outcome === "switched" ? "tmm-is-switch"
          : row.outcome === "gave-up" ? "tmm-is-bad" : "tmm-is-idle";
        var what = row.outcome === "injected"
          ? "注入 " + row.route + "（" + row.reason + (row.ruleIndex === null || row.ruleIndex === undefined ? "" : " 第" + (row.ruleIndex + 1) + "条") + "）"
          : row.outcome === "skipped"
            ? "放行 · " + (row.why || row.reason)
            : row.outcome === "switched"
              ? "回退 " + row.from + " → " + row.to + "（第 " + row.attempt + " 次）"
              : "放弃回退 · " + row.reason;
        var why = row.kind === "failover"
          ? (row.status === undefined ? "" : "HTTP " + row.status) + (row.code ? " " + row.code : "")
          : (row.channel || "") + (row.continuable ? " · 团队成员" : "");
        // 意图是分类器的判定结果，调参全靠它——必须显示出来。
        var tail = [why, row.intent ? "意图 " + row.intent : "", row.label].filter(Boolean).join(" · ");
        return h("div", { key: "t-" + index, className: "tmm-trace" },
          h("time", null, String(row.at || "").slice(11, 19)),
          h("span", { className: "tmm-what " + cls, title: what }, what),
          h("span", { className: "tmm-why", title: tail }, tail));
      });

      children.push(h("details", { key: "trace", className: "tmm-fold" },
        h("summary", null, icon("chev", "tmm-chev"), "决策记录",
          h("span", { className: "tmm-panel-hint", style: { marginLeft: "auto", fontWeight: "400" } },
            "最近 " + Math.min(20, snap.trace.length) + " 条 / 共 " + snap.trace.length + " · rest " + snap.rests.length + " · sink " + snap.sink.length)),
        traceRows.length > 0
          ? h("div", { className: "tmm-scroll" }, traceRows)
          : h("div", { className: "tmm-empty" },
              h("strong", null, "还没有路由决策。"),
              h("span", null, "创建子 agent 后，这里会记录每次命中 / 放行 / 回退的原因。")),
        h("div", { style: { padding: "10px 14px", borderTop: "1px solid var(--dsw-alias-border-l1)" } },
          h("button", { type: "button", className: "tmm-btn is-quiet", onClick: refreshTrace }, "刷新"))));

      // ---- 粘性操作栏 ----
      var hostState = snap.host === "legacy" ? "Host 半侧是 0.2.1（需重启 DSH）"
        : snap.status === undefined ? "未读到 status.json"
        : snap.status.mode === "ok"
          ? "Host 已加载 · 监听 " + (((snap.status.listeners || []).join("+")) || "无")
          : "Host 启动失败：" + snap.status.error;

      children.push(h("div", { key: "bar", className: "tmm-bar" },
        h("button", {
          type: "button", className: "tmm-btn",
          disabled: snap.saving || !dirty || snap.host === "legacy",
          title: snap.host === "legacy" ? "Host 半侧是旧版本，写 v3 策略会失败；也不降级写 /routes（那会把规则等字段抹掉）。请先重启 DSH" : undefined,
          onClick: save,
        }, snap.saving ? "保存中…" : (dirty ? "保存更改" : "已保存")),
        dirty ? h("span", { className: "tmm-warn" }, "有未保存的更改") : null,
        snap.message ? h("span", { className: "tmm-ok" }, snap.message) : null,
        snap.error ? h("span", { className: "tmm-err" }, snap.error) : null,
        h("span", { className: "tmm-state" }, hostState + " · UI 构建 " + BUILD)));

      if (snap.hostError) {
        children.push(h("div", { key: "hosterr", className: "tmm-note is-warn" }, icon("info"),
          h("span", null, "读策略失败：", h("code", null, snap.hostError),
            "。页面出现 ≠ 功能可用——客户端半侧与 Host 半侧独立加载，Host 没起来时设置接口会 404。")));
      }

      return h("section", { className: "tmm-section" }, children);
    }

    // ---------------------------------------------------------------------
    // 团队模型设置 (Header Action 弹出菜单与逐成员管理)
    // ---------------------------------------------------------------------

    function formatSummary(selection) {
      if (!selection) return "继承原设置";
      if (selection.reasoningEffort) {
        return selection.provider + "/" + selection.model + " · " + selection.reasoningEffort;
      }
      return selection.provider + "/" + selection.model;
    }

    function sameSelection(a, b) {
      if (!a && !b) return true;
      if (!a || !b) return false;
      var effA = a.reasoningEffort || "";
      var effB = b.reasoningEffort || "";
      return a.provider === b.provider && a.model === b.model && effA === effB;
    }

    function isModelInCatalog(catalog, provider, model) {
      if (!catalog) return false;
      var list = Array.isArray(catalog.groups) ? catalog.groups : (Array.isArray(catalog) ? catalog : []);
      var grp = list.find(function (g) { return g.id === provider; });
      if (!grp || !Array.isArray(grp.models)) return false;
      return grp.models.some(function (m) { return (m.id || m) === model; });
    }

    function getModelDetails(catalog, provider, model) {
      var list = Array.isArray(catalog?.groups) ? catalog.groups : (Array.isArray(catalog) ? catalog : []);
      var grp = list.find(function (g) { return g.id === provider; });
      if (!grp || !Array.isArray(grp.models)) return null;
      return grp.models.find(function (m) { return (m.id || m) === model; }) || null;
    }

    function checkDraftValidity(draft, catalog, efforts) {
      if (!draft || !draft.provider || !draft.model) return false;
      var mObj = getModelDetails(catalog, draft.provider, draft.model);
      if (!mObj) return false;
      var reqEffort = draft.reasoningEffort || "";
      if (!reqEffort) return true;
      // 档位只有 GET /efforts 知道（目录里没有 metadata）：没读到就不许把未知值写下去。
      var bank = (efforts || {})[keyOf(draft.provider, draft.model)];
      if (!bank || bank.status !== "ok") return false;
      return (bank.efforts || []).some(function (e) { return (e.id || e) === reqEffort; });
    }

    /**
     * 共享选择 → Host PUT 的 `selection`。
     *
     * 「用模型默认」必须**省略字段**：Host 的 `normalizeBinding` 把空字符串当非法值整份拒绝，
     * 而 `reasoningEffort: ""` 还会被原样写进团队设置。
     */
    function selectionOf(selection) {
      var out = { provider: selection.provider, model: selection.model };
      if (selection.reasoningEffort) out.reasoningEffort = selection.reasoningEffort;
      return out;
    }

    /** 档位没就绪时下拉里那句占位说明：把「为什么不能选」直接写在控件上。 */
    function effortPlaceholder(bank) {
      if (bank === undefined || bank.status === "loading") return "正在读取档位…";
      if (bank.status === "error") return "读取失败（不会发送未确认档位）";
      if (bank.supported === false) return "LLM 服务不可用";
      return bank.error ? "读取失败：" + bank.error : "该模型未公布档位";
    }

    /**
     * 思考档位下拉：**常驻占位**（截图第二行右侧），只有模型真公布了非空档位才启用。
     *
     * 0.7.2 是「没公布就隐藏」，用户看不到控件也说不清为什么；现在一律显示，禁用并写清原因。
     *
     * @param {object|undefined} bank - GET /efforts 的 {status, efforts, defaultEffort}。
     * @param {string} current - 当前档位（模型未公布时也照原样显示，不静默清空）。
     * @param {boolean} disabled - 外部门控（写入中/按钮忙）。
     * @param {function(string): void} onChange - 选中回调（空串 = 用模型默认）。
     * @returns {object} 元素。
     */
    function effortField(bank, current, disabled, onChange) {
      // bank === null：连模型都还没选，占位写「先选模型」，别谎称正在读取。
      var noModel = bank === null;
      var ready = !noModel && bank !== undefined && bank.status === "ok" && (bank.efforts || []).length > 0;
      var options = ready
        ? effortOptions(bank, current)
        : [{
          value: current || "",
          label: noModel ? "先选模型" : (current ? current + "（模型未公布）" : effortPlaceholder(bank)),
        }];
      return h("div", { className: "tmm-team-field tmm-team-effort" },
        h("label", null, "思考档位"),
        h("select", {
          className: "tmm-team-select",
          "aria-label": "思考档位",
          disabled: disabled || !ready,
          title: ready ? undefined : (noModel ? "先选服务提供方与模型" : effortPlaceholder(bank)),
          value: current || "",
          onChange: function (e) { onChange(e.target.value); },
        }, options.map(function (option) {
          return h("option", { key: option.value, value: option.value }, option.label);
        }))
      );
    }

    /**
     * 成员是否可应用这次的模型选择。
     *
     * `activeNames` 有三种语义，**不能合并**：
     * - `undefined`：官方 `agentTeam` 投影还没有结论（unknown）→ 以 Host 视图的 `phase` 为准；
     * - 数组（含 `[]`）：官方明确给出了活动名单 → 严格按它过滤，空数组就是「当前没有活动队员」，零写入；
     * - Lead 自己永远不是批量目标（Host 视图通常已滤掉 role=lead，这里再挡一次）。
     *
     * @param {object} member - Host 视图成员。
     * @param {string[]|undefined} activeNames - 官方投影里的活动队员名；undefined 表示未知。
     * @returns {boolean} 是否可应用。
     */
    function isEligibleMember(member, activeNames) {
      if (!member || member.phase !== "active") return false;
      if (member.role === "lead" || member.name === "lead") return false;
      if (activeNames === undefined) return true;
      return Array.isArray(activeNames) && activeNames.indexOf(member.name) !== -1;
    }

    function deriveBackfill(opts) {
      var members = opts.members || [];
      var activeNames = opts.activeNames;
      var defaultModel = opts.defaultModel || null;
      var catalog = opts.catalog;

      // 1. 过滤出合格可执行成员
      var eligible = members.filter(function (m) {
        return isEligibleMember(m, activeNames);
      });

      if (eligible.length > 0) {
        var first = eligible[0].nextModel || eligible[0].currentModel;
        if (!first) {
          return { selection: null, mixed: false, defaultOnly: false };
        }
        var allSame = eligible.every(function (m) {
          var sel = m.nextModel || m.currentModel;
          return sameSelection(first, sel);
        });
        if (allSame) {
          if (isModelInCatalog(catalog, first.provider, first.model)) {
            return {
              selection: { provider: first.provider, model: first.model, reasoningEffort: first.reasoningEffort || "" },
              mixed: false,
              defaultOnly: false,
            };
          }
          return { selection: null, mixed: false, defaultOnly: false };
        }
        return { selection: null, mixed: true, defaultOnly: false };
      }

      // 2. 无可执行成员但有有效默认模型
      if (defaultModel && isModelInCatalog(catalog, defaultModel.provider, defaultModel.model)) {
        return {
          selection: { provider: defaultModel.provider, model: defaultModel.model, reasoningEffort: defaultModel.reasoningEffort || "" },
          mixed: false,
          defaultOnly: true,
        };
      }

      // 3. 完全无数据
      return { selection: null, mixed: false, defaultOnly: false };
    }

    function createWriteGate() {
      var busy = false;
      return {
        isBusy: function () {
          return busy;
        },
        run: async function (fn) {
          if (busy) {
            throw new Error("BUSY: Another operation is in progress");
          }
          busy = true;
          try {
            return await fn();
          } finally {
            busy = false;
          }
        },
      };
    }

    function TeamController(opts) {
      this.sessionId = opts.sessionId;
      // 生产默认走 connection.rpc；单测可注入假 request(endpoint, payload, signal)。
      // 注意这里不能持有 fetch：页面 origin 未必是真正连着的 Host。
      this.request = opts.request || request;
      this.lastView = null;
    }

    TeamController.prototype.fetchView = async function () {
      var body = await this.request("teams", { sessionId: this.sessionId });
      this.lastView = body.view;
      return body.view;
    };

    TeamController.prototype.fetchEfforts = async function (provider, model) {
      var body = await this.request("efforts", { provider: provider, model: model });
      return {
        status: "ok",
        efforts: Array.isArray(body.efforts) ? body.efforts : [],
        defaultEffort: body.defaultEffort,
        supported: body.supported !== false,
        error: body.error,
      };
    };

    TeamController.prototype.saveDefault = async function (selection) {
      return this._put({
        target: null,
        selection: selection,
      });
    };

    TeamController.prototype.restoreInheritance = async function () {
      return this._put({
        target: null,
        selection: null,
      });
    };

    TeamController.prototype.saveMember = async function (memberId, selection) {
      return this._put({
        target: memberId, // immutable member.id
        selection: selection,
      });
    };

    TeamController.prototype._put = async function (params) {
      var rev = this.lastView ? this.lastView.revision : 1;
      // CAS：revision 照旧随写带上；stale 时 Host 返回 409 + code，request 原样抛出，不暗地重取重发。
      var body = await this.request("saveTeam", {
        sessionId: this.sessionId,
        target: params.target,
        selection: params.selection,
        revision: rev,
      });
      this.lastView = body.view;
      return body.view;
    };

    async function applyBulkMembers(opts) {
      var members = opts.members || [];
      var activeNames = opts.activeNames;
      var selection = opts.selection;
      var curRev = opts.initialRevision || 1;
      var saveMember = opts.saveMember;
      var results = {};

      for (var i = 0; i < members.length; i++) {
        var m = members[i];
        if (!isEligibleMember(m, activeNames)) {
          results[m.id] = { status: "skipped", reason: "phase" };
          continue;
        }

        try {
          var reply = await saveMember(m.id, selection, curRev);
          results[m.id] = { status: "saved" };
          if (reply && typeof reply.revision === "number") {
            curRev = reply.revision;
          }
        } catch (err) {
          if (err && err.code === "NETWORK_ERROR") {
            results[m.id] = { status: "unknown", error: err.message };
          } else if (err && err.code === "stale-revision") {
            results[m.id] = { status: "failed", error: "版本已过时" };
          } else {
            results[m.id] = { status: "failed", error: err ? err.message : String(err) };
          }
        }
      }

      return results;
    }

    // 1. 父门控组件：仅调用外部传入的 useSession / useSessions 钩子，遵守 Rules of Hooks
    function TeamAction(props) {
      var identity = props.useSession ? props.useSession(function (s) { return s && s.subagent; }) : undefined;
      var projections = props.useSessions ? props.useSessions(function (st) { return st && st.projectionsBySession; }) : undefined;
      var leadSessionId = null;
      if (identity === null) {
        leadSessionId = props.sessionId;
      } else if (identity && projections) {
        var parents = Object.create(null);
        Object.keys(projections).forEach(function (id) {
          var values = projections[id] && projections[id].values;
          var catalog = values && values.subagentCatalog;
          if (!Array.isArray(catalog)) return;
          catalog.forEach(function (entry) {
            if (!entry || typeof entry.id !== "string") return;
            if (parents[entry.id] && parents[entry.id] !== id) parents[entry.id] = false;
            else if (parents[entry.id] !== false) parents[entry.id] = id;
          });
        });
        var current = props.sessionId, seen = new Set();
        while (current && !seen.has(current)) {
          seen.add(current);
          var projection = projections[current] && projections[current].values;
          if (!projection || projection.subagent === undefined) break;
          if (projection.subagent === null) { leadSessionId = current; break; }
          current = parents[current];
        }
      }
      if (!leadSessionId) return null;
      var isEligible = true;
      var activeNames = undefined;

      return h(TeamTrigger, {
        leadSessionId: leadSessionId,
        currentSessionId: props.sessionId,
        activeNames: activeNames,
        isEligible: isEligible,
      });
    }

    // 2. 子渲染组件：无条件调用 useState / useRef
    function TeamTrigger(props) {
      var openState = react.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var triggerRef = react.useRef(null);

      return h(react.Fragment, null,
        h("button", {
          ref: triggerRef,
          type: "button",
          className: "tmm-team-trigger",
          "aria-label": "团队模型设置",
          "aria-expanded": open,
          onClick: function () { setOpen(!open); },
        },
          icon("gear", "tmm-icon"),
          h("span", null, "团队模型设置")
        ),
        open ? h(TeamPopup, {
          sessionId: props.leadSessionId,
          currentSessionId: props.currentSessionId,
          activeNames: props.activeNames,
          anchorRef: triggerRef,
          onClose: function () { setOpen(false); },
        }) : null
      );
    }

    // 3. 弹窗组件：状态机与操作互斥
    function TeamPopup(props) {
      var sessionId = props.sessionId;
      var activeNames = props.activeNames;
      var anchorRef = props.anchorRef;
      var onClose = props.onClose;

      var controllerRef = react.useRef(null);
      if (!controllerRef.current) {
        controllerRef.current = new TeamController({ sessionId: sessionId });
      }
      var controller = controllerRef.current;
      var gateRef = react.useRef(null);
      if (!gateRef.current) {
        gateRef.current = createWriteGate();
      }
      var gate = gateRef.current;
      // 卸载/换会话后晚到的 /efforts 响应一律丢弃，不许回写到新会话的档位表。
      var effortsGen = react.useRef(0);
      // 同 key 只问一次：草稿与成员行可能在同一次 effect 批次里各要一遍，靠 ref 立刻去重。
      var effortsAsked = react.useRef({});

      var stateArr = react.useState({
        loading: true,
        saving: false,
        error: null,
        view: null,
        catalog: [],
        efforts: {},
        draft: { provider: "", model: "", reasoningEffort: "" },
        pristine: true,
        mixed: false,
        bulkResults: null,
      });
      var state = stateArr[0];
      var setState = stateArr[1];

      function patchState(next) {
        setState(function (prev) {
          var merged = {};
          for (var k in prev) merged[k] = prev[k];
          for (var j in next) merged[j] = next[j];
          return merged;
        });
      }

      /** 只改一个 `provider/model` 的档位条目：并发 A/B 各自写自己的 key，谁也回滚不了谁。 */
      function patchEfforts(key, value) {
        setState(function (prev) {
          var merged = {};
          for (var k in prev) merged[k] = prev[k];
          var bank = {};
          for (var j in prev.efforts) bank[j] = prev.efforts[j];
          bank[key] = value;
          merged.efforts = bank;
          return merged;
        });
      }

      /** 按需读一个模型公布的档位（同 key 已有结果就不再问）。 */
      function ensureEfforts(provider, model) {
        if (!provider || !model) return;
        var key = keyOf(provider, model);
        if (effortsAsked.current[key] === true) return;
        effortsAsked.current[key] = true;
        var known = state.efforts[key];
        if (known !== undefined && known.status === "ok") return;
        var gen = effortsGen.current;
        patchEfforts(key, { status: "loading", efforts: [] });
        controller.fetchEfforts(provider, model).then(function (bank) {
          if (gen !== effortsGen.current) return;
          patchEfforts(key, bank);
        }).catch(function (err) {
          if (gen !== effortsGen.current) return;
          delete effortsAsked.current[key]; // 失败允许下次重试，但成功后不再问
          patchEfforts(key, { status: "error", efforts: [], error: String(err && err.message ? err.message : err) });
        });
      }

      var panelRef = react.useRef(null);

      react.useEffect(function () {
        function handleKey(e) {
          if (e.key === "Escape") {
            if (!gate.isBusy() && !state.saving) onClose();
          }
        }
        function handleClickOutside(e) {
          if (anchorRef && anchorRef.current && typeof anchorRef.current.contains === "function" && anchorRef.current.contains(e.target)) return;
          if (panelRef.current && !panelRef.current.contains(e.target)) {
            if (!gate.isBusy() && !state.saving) onClose();
          }
        }
        if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
          document.addEventListener("keydown", handleKey);
          document.addEventListener("pointerdown", handleClickOutside, true);
          return function () {
            if (typeof document.removeEventListener === "function") {
              document.removeEventListener("keydown", handleKey);
              document.removeEventListener("pointerdown", handleClickOutside, true);
            }
          };
        }
      }, [state.saving]);

      react.useEffect(function () {
        var alive = true;
        Promise.all([
          controller.fetchView(),
          // 目录也走同一条连接通道：Host 半侧没加载时退回空目录，不拖垮整个弹窗。
          request("state", {}).catch(function () { return { catalog: [] }; }),
        ]).then(function (res) {
          if (!alive) return;
          var view = res[0];
          var catalog = (res[1] && res[1].catalog) || [];
          var bf = deriveBackfill({
            members: view.members,
            activeNames: activeNames,
            defaultModel: view.defaultModel,
            catalog: catalog,
          });
          patchState({
            loading: false,
            view: view,
            catalog: catalog,
            draft: bf.selection || { provider: "", model: "", reasoningEffort: "" },
            mixed: bf.mixed,
            pristine: true,
            error: null,
          });
        }).catch(function (err) {
          if (alive) patchState({ loading: false, error: err.message });
        });

        return function () { alive = false; effortsGen.current += 1; };
      }, [sessionId]);

      // 草稿换了模型就重读档位；换 provider/model 时调用方已把旧档位清空，不会带着旧值去问。
      react.useEffect(function () {
        ensureEfforts(state.draft.provider, state.draft.model);
      }, [state.draft.provider, state.draft.model]);

      async function handleApplyBulk() {
        if (gate.isBusy() || !state.view) return;
        var valid = checkDraftValidity(state.draft, state.catalog, state.efforts);
        if (!valid) return;

        await gate.run(async function () {
          patchState({ saving: true, bulkResults: null, error: null });
          try {
            var results = await applyBulkMembers({
              members: state.view.members,
              activeNames: activeNames,
              selection: selectionOf(state.draft),
              initialRevision: state.view.revision,
              saveMember: async function (mId, sel) {
                var view = await controller.saveMember(mId, sel);
                // Host 的 PUT 已经返回新视图：立刻回读，否则列表还显示旧路由，用户会以为没生效。
                if (view) patchState({ view: view });
                return view;
              },
            });
            // bulkResults 与最后一次回读一起提交，避免中间态把 saving 提前放掉。
            patchState({ bulkResults: results, saving: false });
          } catch (err) {
            patchState({ error: err.message, saving: false });
          }
        });
      }

      async function handleApplyDefault() {
        if (gate.isBusy() || !state.view) return;
        var valid = checkDraftValidity(state.draft, state.catalog, state.efforts);
        if (!valid) return;

        await gate.run(async function () {
          patchState({ saving: true, error: null });
          try {
            var newView = await controller.saveDefault(selectionOf(state.draft));
            patchState({ view: newView, saving: false });
          } catch (err) {
            patchState({ error: err.message, saving: false });
          }
        });
      }

      async function handleRestoreInheritance() {
        if (gate.isBusy() || !state.view) return;
        await gate.run(async function () {
          patchState({ saving: true, error: null });
          try {
            var newView = await controller.restoreInheritance();
            patchState({ view: newView, saving: false });
          } catch (err) {
            patchState({ error: err.message, saving: false });
          }
        });
      }

      async function handleMemberChange(memberId, newSelection) {
        if (gate.isBusy() || !state.view) return;
        await gate.run(async function () {
          patchState({ saving: true, error: null });
          try {
            var newView = await controller.saveMember(memberId, selectionOf(newSelection));
            patchState({ view: newView, saving: false });
          } catch (err) {
            patchState({ error: err.message, saving: false });
          }
        });
      }

      var isBusy = gate.isBusy() || state.saving;
      var draftValid = checkDraftValidity(state.draft, state.catalog, state.efforts);
      var rosterUnknown = !Array.isArray(activeNames);
      var rosterEmpty = Array.isArray(activeNames) && activeNames.length === 0;

      var popup = h("div", {
        ref: panelRef,
        className: "tmm-team-popup",
        "data-window-drag-exclude": "",
        role: "dialog",
        "aria-label": "团队模型设置面板",
        style: { top: "48px", right: "16px" },
      },
        h("div", { className: "tmm-team-head" },
          h("h2", null, "团队模型设置"),
          h("button", {
            type: "button",
            className: "tmm-team-close",
            "aria-label": "关闭",
            disabled: isBusy,
            onClick: onClose,
          }, "×")
        ),

        state.loading ? h("div", { className: "tmm-team-hint" }, "正在加载团队模型状态…") : null,
        state.error ? h("div", { className: "tmm-team-err" }, "错误：" + state.error) : null,

        state.view ? h(react.Fragment, null,
          h("section", { className: "tmm-team-region", role: "region", "aria-label": "统一模型设置" },
            h("div", { className: "tmm-team-region-title" }, "统一模型设置"),
            state.mixed && state.pristine
              ? h("div", { className: "tmm-team-warn" }, "成员设置不一致，请选择要统一的模型")
              : null,
            h(SharedPicker, {
              catalog: state.catalog,
              draft: state.draft,
              efforts: state.efforts,
              disabled: isBusy,
              onChange: function (next) {
                patchState({ draft: next, pristine: false, mixed: false });
              },
            }),
            state.view.members.length === 0
              ? null
              : (rosterUnknown
                ? h("div", { className: "tmm-team-hint" }, "活动名单由 Host 实时核验")
                : (rosterEmpty
                  ? h("div", { className: "tmm-team-hint" }, "官方名单里当前没有活动队员，应用不会写入任何人")
                  : null)),
            h("div", { className: "tmm-team-btns" },
              h("button", {
                type: "button",
                className: "tmm-team-btn is-primary",
                disabled: isBusy || !draftValid,
                onClick: handleApplyBulk,
              }, "应用到当前队员"),
              h("button", {
                type: "button",
                className: "tmm-team-btn is-quiet",
                disabled: isBusy || !draftValid,
                onClick: handleApplyDefault,
              }, "设为新队员默认")
            ),
            state.bulkResults ? h(BulkResultsSummary, { results: state.bulkResults, rosterEmpty: rosterEmpty }) : null
          ),

          h("section", { className: "tmm-team-region", role: "region", "aria-label": "之后新增成员默认" },
            h("div", { className: "tmm-team-region-title" }, "之后新增成员默认"),
            h("div", { className: "tmm-team-row" },
              h("span", null, "已保存的新成员默认：", h("strong", { "data-committed-default": "true" }, formatSummary(state.view.defaultModel))),
              state.view.defaultModel ? h("button", {
                type: "button",
                className: "tmm-team-link",
                disabled: isBusy,
                onClick: handleRestoreInheritance,
              }, "恢复继承") : null
            )
          ),

          h("section", { className: "tmm-team-region", role: "region", "aria-label": "团队成员列表" },
            h("div", { className: "tmm-team-region-title" }, "团队成员模型设置（下一轮生效）"),
            state.view.members.length === 0
              ? h("div", { className: "tmm-team-hint" }, "暂无团队成员")
              : state.view.members.map(function (m) {
                  var isTeammateActive = isEligibleMember(m, activeNames);
                  return h("article", { key: m.id, className: "tmm-team-member", "aria-label": m.name },
                    h("div", { className: "tmm-team-member-head" },
                      h("span", { className: "tmm-team-member-name" }, m.name),
                      h("span", { className: "tmm-team-tag " + (m.status === "running" ? "is-running" : (m.phase === "failed" ? "is-warn" : "")) },
                        m.phase === "active" ? (m.status === "running" ? "运行中" : "未运行") : (m.phase === "failed" ? "失败" : (m.phase === "unavailable" ? "未激活（只读）" : "准备中"))
                      )
                    ),
                    h("div", { className: "tmm-team-route-info" },
                      "最近已使用：", h("span", { className: "tmm-team-route-val" }, formatSummary(m.currentModel)),
                      " · 下轮选择：", h("span", { className: "tmm-team-route-val" }, formatSummary(m.nextModel))
                    ),
                    isTeammateActive ? h(MemberInlineEditor, {
                      catalog: state.catalog,
                      current: m.nextModel || m.currentModel,
                      efforts: state.efforts,
                      onNeedEfforts: ensureEfforts,
                      disabled: isBusy,
                      onSave: function (newSel) {
                        handleMemberChange(m.id, newSel);
                      },
                    }) : h("div", { className: "tmm-team-hint" }, m.phase !== "active" ? "不可编辑" : "未在活动名单内")
                  );
                })
          )
        ) : null
      );

      if (reactDom && typeof reactDom.createPortal === "function" && typeof document !== "undefined" && document.body) {
        return reactDom.createPortal(popup, document.body);
      }
      return popup;
    }

    function SharedPicker(props) {
      var catalog = props.catalog || [];
      var draft = props.draft || { provider: "", model: "", reasoningEffort: "" };
      var disabled = props.disabled;
      var onChange = props.onChange;

      var groups = Array.isArray(catalog.groups) ? catalog.groups : (Array.isArray(catalog) ? catalog : []);

      var selectedGroup = groups.find(function (g) { return g.id === draft.provider; });
      var models = selectedGroup && Array.isArray(selectedGroup.models) ? selectedGroup.models : [];
      var bank = draft.provider && draft.model ? (props.efforts || {})[keyOf(draft.provider, draft.model)] : null;

      // 统一选择器：提供方占满第一行，模型和档位共享第二行。
      return h("div", { className: "tmm-team-grid tmm-shared-picker" },
        h("div", { className: "tmm-team-row tmm-shared-provider" },
          h("div", { className: "tmm-team-field tmm-team-provider" },
            h("label", null, "服务提供方"),
            h("select", {
              className: "tmm-team-select",
              "aria-label": "服务提供方",
              disabled: disabled,
              value: draft.provider,
              onChange: function (e) {
                onChange({ provider: e.target.value, model: "", reasoningEffort: "" });
              },
            },
              h("option", { value: "" }, "-- 选择提供方 --"),
              groups.map(function (g) {
                return h("option", { key: g.id, value: g.id }, g.name || g.id);
              })
            )
          )
        ),
        h("div", { className: "tmm-team-row tmm-shared-models" },
          h("div", { className: "tmm-team-field tmm-team-model" },
            h("label", null, "模型"),
            h("select", {
              className: "tmm-team-select",
              "aria-label": "模型",
              disabled: disabled || !draft.provider,
              value: draft.model,
              onChange: function (e) {
                onChange({ provider: draft.provider, model: e.target.value, reasoningEffort: "" });
              },
            },
              h("option", { value: "" }, "-- 选择模型 --"),
              models.map(function (m) {
                var id = m.id || m;
                var name = m.name || id;
                return h("option", { key: id, value: id }, name);
              })
            )
          ),
          effortField(bank, draft.reasoningEffort, disabled, function (value) {
            onChange({ provider: draft.provider, model: draft.model, reasoningEffort: value });
          })
        )
      );
    }

    function MemberInlineEditor(props) {
      var catalog = props.catalog || [];
      var current = props.current || null;
      var disabled = props.disabled;
      var onSave = props.onSave;

      var curProvider = current ? current.provider : "";
      var curModel = current ? current.model : "";
      var curEffort = current ? (current.reasoningEffort || "") : "";

      // 成员行复用弹窗那一份按 provider+model 缓存的档位表：同一模型不问两次，也不另建一份选择器。
      react.useEffect(function () {
        if (props.onNeedEfforts) props.onNeedEfforts(curProvider, curModel);
      }, [curProvider, curModel]);

      var groups = Array.isArray(catalog.groups) ? catalog.groups : (Array.isArray(catalog) ? catalog : []);
      var bank = curProvider && curModel ? (props.efforts || {})[keyOf(curProvider, curModel)] : null;

      return h("div", { className: "tmm-team-row", style: { marginTop: "6px" } },
        h("div", { className: "tmm-team-field" },
          h("label", null, "模型选择"),
          h("select", {
            className: "tmm-team-select",
            "aria-label": "模型",
            disabled: disabled,
            value: curProvider && curModel ? JSON.stringify([curProvider, curModel]) : "",
            onChange: function (e) {
              if (!e.target.value) return;
              var parsed = JSON.parse(e.target.value);
              onSave({ provider: parsed[0], model: parsed[1], reasoningEffort: "" });
            },
          },
            h("option", { value: "" }, "-- 选择模型 --"),
            groups.map(function (g) {
              var grpModels = g.models || [];
              return h("optgroup", { key: g.id, label: g.name || g.id },
                grpModels.map(function (m) {
                  var mId = m.id || m;
                  return h("option", { key: mId, value: JSON.stringify([g.id, mId]) }, m.name || mId);
                })
              );
            })
          )
        ),
        effortField(bank, curEffort, disabled, function (value) {
          onSave({ provider: curProvider, model: curModel, reasoningEffort: value });
        })
      );
    }

    function BulkResultsSummary(props) {
      var results = props.results || {};
      var keys = Object.keys(results);
      var saved = 0;
      var failed = 0;
      var unknown = 0;
      var skipped = 0;

      keys.forEach(function (k) {
        var st = results[k].status;
        if (st === "saved") saved++;
        else if (st === "failed") failed++;
        else if (st === "unknown") unknown++;
        else if (st === "skipped") skipped++;
      });

      // 一个都没写出去时必须说清原因，不能让用户对着“没反应”的按钮猜。
      if (saved + failed + unknown === 0) {
        return h("div", { className: "tmm-team-msg", style: { marginTop: "8px" } },
          h("span", { className: "tmm-team-warn" },
            props.rosterEmpty
              ? "当前没有活动队员，未写入任何设置"
              : "没有可应用的队员" + (skipped > 0 ? "（" + skipped + " 名不在活动名单或尚未就绪）" : "")));
      }

      return h("div", { className: "tmm-team-msg", style: { marginTop: "8px" } },
        h("span", { className: "tmm-team-ok" }, "已保存 " + saved + " 名"),
        failed > 0 ? h("span", { className: "tmm-team-err", style: { marginLeft: "6px" } }, "失败 " + failed + " 名") : null,
        unknown > 0 ? h("span", { className: "tmm-team-warn", style: { marginLeft: "6px" } }, "未确认 " + unknown + " 名") : null,
        skipped > 0 ? h("span", { className: "tmm-team-hint", style: { marginLeft: "6px" } }, "跳过 " + skipped + " 名") : null
      );
    }

    function apply(ctx) {
      // 只记住 ctx：connection 句柄可能随重连/换远端更换，调用时再读（见 currentRpc）。
      pluginCtx = ctx || null;
      var probe = null;
      try {
        probe = pluginCtx ? pluginCtx.connection : null;
      } catch (e) {
        probe = null;
      }
      if (!probe || !probe.rpc || typeof probe.rpc.call !== "function") {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[dsh-team-member-model] 缺少官方 connection.rpc：模型设置无法读写（不会退回本页 fetch）");
        }
      }
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          { name: "settings.section", id: "team-member-model", order: 19, label: "模型路由" },
          Section
        );
      });
      ctx.slots.inject("conversation.session.header.actions", function () {
        return ctx.slots.register(
          { name: "conversation.session.header.actions", id: "team-model-settings", order: -19 },
          TeamAction
        );
      });
    }
    module.exports.apply = apply;
    // connection：官方连接通道（远程会话/反代下，写操作必须落到真正连接的那台 Host）。
    module.exports.inject = ["slots", "connection"];
    // 下划线前缀 = 内部函数，仅为回归测试导出，不属于插件契约。
    module.exports._request = request;
    module.exports._RPC_OPS = RPC_OPS;
    module.exports._applyPayload = applyPayload;
    module.exports._policyFromDraft = policyFromDraft;
    module.exports._ruleToPayload = ruleToPayload;
    module.exports._describeRule = describeRule;
    module.exports._textList = textList;
    module.exports._effortOptions = effortOptions;
    module.exports._effortHint = effortHint;
    module.exports._hostSupport = hostSupport;
    module.exports._validateDraft = validateDraft;
    module.exports._classifierNotice = classifierNotice;
    module.exports._mergeSuggestions = mergeSuggestions;
    module.exports._applyMerge = applyMerge;
    module.exports._bindingKeyOf = bindingKeyOf;
    module.exports._styles = function () { return CSS; };
    module.exports._matchTextOf = matchTextOf;
    module.exports._catalogOptions = catalogOptions;
    module.exports._memberKeyOf = memberKeyOf;
    module.exports._groupRules = groupRules;
    module.exports._keywordInsertIndex = keywordInsertIndex;
    module.exports._isLabelRule = isLabelRule;
    module.exports._formatTokens = formatTokens;
    module.exports._barPercent = barPercent;
    module.exports._sortUsageRows = sortUsageRows;
    module.exports._formatSummary = formatSummary;
    module.exports._sameSelection = sameSelection;
    module.exports._checkDraftValidity = checkDraftValidity;
    module.exports._deriveBackfill = deriveBackfill;
    module.exports._createWriteGate = createWriteGate;
    module.exports._TeamController = TeamController;
    module.exports._applyBulkMembers = applyBulkMembers;
    module.exports._TeamAction = TeamAction;
    module.exports._TeamTrigger = TeamTrigger;
    module.exports._TeamPopup = TeamPopup;
    return module.exports;
  }
});
