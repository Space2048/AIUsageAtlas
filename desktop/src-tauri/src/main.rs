// AIUsageAtlas 悬浮球 — Rust 侧只做窗口/托盘/生命周期，不碰数据。
// 所有业务动作（同步、打开仪表盘、面板显隐）都广播给前端 JS 处理，
// 服务器地址等配置也只存在前端 localStorage 里，Rust 保持无状态。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

fn main() {
    tauri::Builder::default()
        // 单实例必须最先注册：二次启动时把已有悬浮球带回前台
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(ball) = app.get_webview_window("ball") {
                let _ = ball.show();
                let _ = ball.unminimize();
                let _ = ball.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dashboard = MenuItem::with_id(app, "dashboard", "打开仪表盘", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "立即同步", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&dashboard, &refresh, &quit])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(
                    app.default_window_icon()
                        .expect("缺少应用图标：请先运行 `npx tauri icon` 生成 icons/")
                        .clone(),
                )
                .tooltip("AIUsageAtlas")
                .menu(&menu)
                // 左键点击不弹菜单，走 toggle-panel 事件；右键才弹菜单
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "dashboard" => {
                        let _ = app.emit("tray-action", "dashboard");
                    }
                    "refresh" => {
                        let _ = app.emit("tray-action", "refresh");
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let _ = tray.app_handle().emit("tray-action", "toggle-panel");
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
